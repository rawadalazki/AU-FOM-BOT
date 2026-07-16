const { Pool } = require('pg');
const crypto = require('crypto');
const logger = require('./logger');
const translateApi = require('google-translate-api-x');

class TranslationService {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    this.memoryCache = new Map();
    this.dbInitialized = false;

    this.initDb();
  }

  async initDb() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS translations_cache (
          id SERIAL PRIMARY KEY,
          hash_key VARCHAR(64) UNIQUE NOT NULL,
          text_original TEXT NOT NULL,
          target_lang VARCHAR(10) NOT NULL,
          text_translated TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      this.dbInitialized = true;
      logger.info('[Translation] Translations cache table initialized.');
    } catch (err) {
      logger.error({ err }, '[Translation] Failed to initialize translations table.');
    }
  }

  _generateHash(text, targetLang) {
    return crypto.createHash('sha256').update(`${text}_${targetLang}`).digest('hex');
  }

  sanitizeTranslatedText(text) {
    if (!text || typeof text !== 'string') return text;
    
    // Decode basic HTML entities
    const entities = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&nbsp;': ' '
    };
    let cleaned = text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, match => entities[match]);

    // Strip ALL tags EXCEPT Telegram supported tags
    const allowedTags = 'b|strong|i|em|u|ins|s|strike|del|a|tg\\-emoji|code|pre|blockquote';
    const tagRegex = new RegExp(`<\\/?(?!(${allowedTags})\\b)[^>]*>`, 'gi');
    cleaned = cleaned.replace(tagRegex, '');

    return cleaned;
  }

  async translate(text, targetLang) {
    if (!text || typeof text !== 'string') return text;
    
    if (targetLang !== 'en' && targetLang !== 'ar') {
      return text; // Support ar <-> en only
    }

    const sourceLang = targetLang === 'en' ? 'ar' : 'en';
    const hashKey = this._generateHash(text, targetLang);

    // 1. In-memory cache lookup
    if (this.memoryCache.has(hashKey)) {
      console.log('[Translation] Memory Cache Hit');
      return this.memoryCache.get(hashKey);
    }

    // 2. DB cache lookup
    if (this.dbInitialized) {
      try {
        const { rows } = await this.pool.query(
          'SELECT text_translated FROM translations_cache WHERE hash_key = $1',
          [hashKey]
        );
        
        if (rows.length > 0) {
          const savedTranslation = rows[0].text_translated;
          console.log('[Translation] DB Cache Hit');
          this.memoryCache.set(hashKey, savedTranslation);
          return savedTranslation;
        }
      } catch (dbErr) {
        logger.error({ err: dbErr }, '[Translation] Database lookup error');
      }
    }

    // Protect HTML/Markdown logic
    const placeholderMap = new Map();
    let processedText = text;

    const addPlaceholder = (match) => {
      const token = `{{{${crypto.randomBytes(8).toString('hex')}}}}`;
      placeholderMap.set(token, match);
      return token;
    };

    processedText = processedText.replace(/<[^>]+>/g, addPlaceholder);
    processedText = processedText.replace(/https?:\/\/[^\s]+/g, addPlaceholder);
    processedText = processedText.replace(/@[a-zA-Z0-9_]+/g, addPlaceholder);
    processedText = processedText.replace(/\/[a-zA-Z0-9_]+/g, addPlaceholder);
    processedText = processedText.replace(/```[\s\S]*?```/g, addPlaceholder);
    processedText = processedText.replace(/`[^`]+`/g, addPlaceholder);
    processedText = processedText.replace(/(\*\*|__|~~|\|\|)[^\n]+?\1/g, addPlaceholder);
    processedText = processedText.replace(/(\*|_)[^\n]+?\1/g, addPlaceholder);
    processedText = processedText.replace(/\{"cmd":"[^"]+"\}/g, addPlaceholder);

    // 3. Google Translate API Call
    console.log(`[Translation] Request: ${sourceLang} -> ${targetLang} | ${text}`);
    console.log('[Translation] Google Translate API Call');
    try {
      const response = await translateApi(processedText, {
        from: sourceLang,
        to: targetLang
      });

      let translatedText = response.text;

      if (translatedText) {
        console.log(`[Translation] Response: ${translatedText}`);
        // Restore placeholders and verify integrity
        let isValid = true;
        for (const [token, original] of placeholderMap.entries()) {
          if (!translatedText.includes(token)) {
            console.error(`[Translation] Token missing or corrupted: ${token}`);
            isValid = false;
            break;
          }
          translatedText = translatedText.replace(token, original);
        }

        if (!isValid) {
          console.warn('[Translation] Fallback to original text due to corrupted placeholders');
          return text;
        }
        
        translatedText = this.sanitizeTranslatedText(translatedText);

        // 4. Save to cache
        this.memoryCache.set(hashKey, translatedText);

        if (this.dbInitialized) {
          try {
            await this.pool.query(`
              INSERT INTO translations_cache (hash_key, text_original, target_lang, text_translated)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (hash_key) DO UPDATE SET text_translated = EXCLUDED.text_translated, created_at = NOW()
            `, [hashKey, text, targetLang, translatedText]);
          } catch (dbSaveErr) {
            logger.error({ err: dbSaveErr }, '[Translation] Database save error');
          }
        }

        return translatedText;
      }
      
      return text;
    } catch (error) {
      if (logger && logger.error) {
        logger.error({ err: error.message }, '[Translation] Google Translate API failed');
      } else {
        console.error('[Translation] Google Translate API failed:', error.message);
      }
      return text;
    }
  }

  async ensureTranslated(item, table, idField, fieldsMap) {
    if (!item) return;
    const dbHelper = require('./database');
    let updated = false;

    for (const arField of Object.keys(fieldsMap)) {
      const enField = fieldsMap[arField];
      if (item[arField] && typeof item[arField] === 'string' && item[arField].trim() !== '') {
        if (!item[enField] || item[enField].trim() === '') {
          item[enField] = await this.translate(item[arField], 'en');
          await dbHelper.updateTranslationField(table, item[idField], enField, item[enField]);
          updated = true;
        }
      }
    }
    
    // Special case for inline buttons
    if (table === 'menus' && item.inline_buttons) {
      try {
        let btns = JSON.parse(item.inline_buttons);
        let btnUpdated = false;
        for (let b of btns) {
          if (b.text_ar && typeof b.text_ar === 'string' && b.text_ar.trim() !== '') {
            if (!b.text_en || typeof b.text_en !== 'string' || b.text_en.trim() === '') {
              b.text_en = await this.translate(b.text_ar, 'en');
              btnUpdated = true;
            }
          }
        }
        if (btnUpdated) {
          item.inline_buttons = JSON.stringify(btns);
          await dbHelper.updateTranslationField(table, item[idField], 'inline_buttons', item.inline_buttons);
          updated = true;
        }
      } catch(e) {
        logger.error({ err: e }, '[Translation] Error parsing inline_buttons for translation');
      }
    }
    return updated;
  }
}

module.exports = new TranslationService();

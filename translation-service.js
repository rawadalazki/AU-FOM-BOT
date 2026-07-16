const { Pool } = require('pg');
const crypto = require('crypto');
const logger = require('./logger');

class TranslationService {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    
    this.libreUrl = process.env.LIBRETRANSLATE_URL || 'https://translate.terraprint.co/translate'; // default public or local instance
    this.apiKey = process.env.LIBRETRANSLATE_API_KEY || ''; 
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

    // Protect HTML/Markdown logic (similar to previous implementation)
    const placeholders = [];
    let processedText = text;

    const addPlaceholder = (match) => {
      const id = placeholders.length;
      placeholders.push(match);
      return `<span translate="no" class="notranslate" id="p_${id}"></span>`;
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

    // 3. LibreTranslate API Call
    console.log(`[Translation] Request: ${sourceLang} -> ${targetLang} | ${text}`);
    console.log('[Translation] LibreTranslate API Call');
    try {
      const requestBody = {
        q: processedText,
        source: sourceLang,
        target: targetLang,
        format: 'html'
      };
      
      if (this.apiKey) {
        requestBody.api_key = this.apiKey;
      }

      // Add AbortController for timeout (e.g. 10 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(this.libreUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`LibreTranslate API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      let translatedText = data.translatedText;

      if (translatedText) {
        console.log(`[Translation] Response: ${translatedText}`);
        // Restore placeholders
        translatedText = translatedText.replace(/<\s*span\s+translate\s*=\s*"no"\s+class\s*=\s*"notranslate"\s+id\s*=\s*"p_(\d+)"\s*>\s*<\s*\/\s*span\s*>/ig, (match, id) => {
          return placeholders[parseInt(id)];
        });
        
        translatedText = translatedText.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

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
        logger.error({ err: error.message }, '[Translation] LibreTranslate API failed or timed out');
      } else {
        console.error('[Translation] LibreTranslate API failed or timed out:', error.message);
      }
      // On failure or timeout, return original text without throwing
      return text;
    }
  }
}

module.exports = new TranslationService();

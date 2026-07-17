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
    const tokenRegexes = [
      /<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>/gi,
      /<[^>]+>/gi,
      /https?:\/\/[^\s]+/gi,
      /@[a-zA-Z0-9_]+/gi,
      /\/[a-zA-Z0-9_]+/gi,
      /```[\s\S]*?```/gi,
      /`[^`]+`/gi,
      /(\*\*|__|~~|\|\|)[^\n]+?\1/gi,
      /(\*|_)[^\n]+?\1/gi,
      /\{"cmd":"[^"]+"\}/gi
    ];

    let parts = [text];
    
    for (const regex of tokenRegexes) {
      const nextParts = [];
      for (const part of parts) {
        if (typeof part === 'string') {
          let lastIndex = 0;
          part.replace(regex, (match, ...args) => {
            const offset = args[args.length - 2];
            if (offset > lastIndex) {
              nextParts.push(part.substring(lastIndex, offset));
            }
            const id = placeholderMap.size;
            const tokenStr = `{{{${id}}}}`;
            placeholderMap.set(tokenStr, match);
            nextParts.push({ token: tokenStr, original: match });
            lastIndex = offset + match.length;
            return match;
          });
          if (lastIndex < part.length) {
            nextParts.push(part.substring(lastIndex));
          }
        } else {
          nextParts.push(part);
        }
      }
      parts = nextParts;
    }

    let processedText = parts.map(p => typeof p === 'string' ? p : p.token).join('');

    // 3. Google Translate API Call
    console.log(`\n[Translation Debug] Source Lang: ${sourceLang} | Target Lang: ${targetLang}`);
    console.log(`[Translation Debug] 1. Original Text:\n${text}`);
    console.log(`[Translation Debug] 2. Text with Placeholders sent to Google:\n${processedText}`);
    console.log(`[Translation Debug] Token Map:`, Object.fromEntries(placeholderMap));
    
    try {
      const response = await translateApi(processedText, {
        from: sourceLang,
        to: targetLang
      });

      let translatedText = response.text;

      if (translatedText) {
        console.log(`[Translation Debug] 3. Raw translated response from Google:\n${translatedText}`);
        
        // Restore placeholders and verify integrity
        let isValid = true;
        const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        for (const [token, original] of placeholderMap.entries()) {
          if (!translatedText.includes(token)) {
            console.error(`[Translation Debug] ❌ Token missing or corrupted after translation: ${token}`);
            console.error(`[Translation Debug] Expected Token: ${token}, Original content: ${original}`);
            isValid = false;
            // Don't break, keep trying others to see full extent of corruption
          }
          translatedText = translatedText.replace(new RegExp(escapeRegExp(token), 'g'), original);
        }

        if (!isValid) {
          console.warn('[Translation Debug] ⚠️ Fallback to original text due to corrupted placeholders');
          return text;
        }
        
        console.log(`[Translation Debug] 4. Final Restored Text:\n${translatedText}\n`);

        
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

  /**
   * Process Premium Telegram Emojis using Entity-based translation.
   * Never translates the emoji itself. Replaces `<tg-emoji>` with safe tokens,
   * translates the textual content, and restores entities based on UTF-16 offsets.
   */
  async processPremiumEntities(text, targetLang = null) {
    if (!text) return { text: '', entities: [] };

    const emojiRegex = /<tg-emoji\s+emoji-id="([^"]+)">([\s\S]*?)<\/tg-emoji>/gi;
    let match;
    const emojiMap = new Map();
    let tokenizedText = text;

    // 1. Extraction & Tokenization
    while ((match = emojiRegex.exec(text)) !== null) {
      const fullTag = match[0];
      const custom_emoji_id = match[1];
      const emojiUnicode = match[2];
      const tokenId = emojiMap.size;
      const token = `{{{${tokenId}}}}`;
      
      emojiMap.set(token, { emojiUnicode, custom_emoji_id });
      tokenizedText = tokenizedText.replace(fullTag, token);
    }

    // 2. Translation
    let finalPlainText = tokenizedText;
    if (targetLang) {
      try {
        finalPlainText = await this.translate(tokenizedText, targetLang);
      } catch (e) {
        logger.error({ err: e }, '[Translation] Process Premium Entities translate failed');
        finalPlainText = tokenizedText;
      }
    }

    // 3. Restoration & Offset Calculation
    const entities = [];
    let isValid = true;
    
    // We must find each token, replace it with the unicode emoji, and track the offset.
    // To handle multiple occurrences or out-of-order translation, we process token by token.
    // Using a regex to find all {{{N}}} and replace them sequentially.
    const tokenRegex = /\{\{\{(\d+)\}\}\}/g;
    let matchToken;
    let offsetAdjustment = 0;
    
    let restoredText = finalPlainText;

    while ((matchToken = tokenRegex.exec(finalPlainText)) !== null) {
      const token = matchToken[0];
      const emojiData = emojiMap.get(token);
      
      if (!emojiData) {
         // Corrupted token that doesn't exist in our map
         isValid = false;
         continue;
      }

      // Calculate current offset in the restored text
      // We must find the index of the token in the *current* restored text
      const tokenIndex = restoredText.indexOf(token);
      if (tokenIndex === -1) {
         isValid = false;
         continue;
      }

      // Record entity using UTF-16 string indices
      entities.push({
        type: 'custom_emoji',
        offset: tokenIndex,
        length: emojiData.emojiUnicode.length,
        custom_emoji_id: emojiData.custom_emoji_id
      });

      // Replace exactly one instance of the token with the unicode emoji
      restoredText = restoredText.substring(0, tokenIndex) + 
                     emojiData.emojiUnicode + 
                     restoredText.substring(tokenIndex + token.length);
    }
    
    // Verify all tokens were restored
    if (entities.length !== emojiMap.size) {
       console.warn('[Translation] Entity mismatch after restoration. Expected:', emojiMap.size, 'Got:', entities.length);
       isValid = false;
    }

    // 4. Entity Offset Validation
    if (isValid && entities.length > 0) {
      entities.sort((a, b) => a.offset - b.offset);
      
      for (let i = 0; i < entities.length; i++) {
        const ent = entities[i];
        if (ent.offset < 0 || ent.length <= 0) isValid = false;
        if (i > 0) {
           const prev = entities[i - 1];
           if (prev.offset + prev.length > ent.offset) {
             console.error('[Translation] Entity overlap detected');
             isValid = false;
           }
        }
      }
    }

    // 5. Fallback Strategy
    if (!isValid) {
      console.error('[Translation] Entity restoration failed, falling back to plain text without premium emojis.');
      // Remove any leftover tokens
      let fallbackText = finalPlainText.replace(/\{\{\{\d+\}\}\}/g, '');
      return { text: fallbackText, entities: [] };
    }

    return { text: restoredText, entities };
  }

}

module.exports = new TranslationService();

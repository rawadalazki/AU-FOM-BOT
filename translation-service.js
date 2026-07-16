const { TranslationServiceClient } = require('@google-cloud/translate');
const logger = require('./logger');

class TranslationService {
  constructor() {
    // Initialize the client. It will automatically use GOOGLE_APPLICATION_CREDENTIALS
    this.client = new TranslationServiceClient();
    this.projectId = process.env.GOOGLE_PROJECT_ID;
    this.location = process.env.GOOGLE_LOCATION || 'global';
    this.cache = new Map();
    this.enabled = false;
    this.testConnection();
  }

  async testConnection() {
    try {
      if (!this.projectId) {
        console.log('[Translation] Google credentials not configured.');
        this.enabled = false;
        return;
      }
      const request = {
        parent: `projects/${this.projectId}/locations/${this.location}`,
        contents: ['test'],
        mimeType: 'text/plain',
        sourceLanguageCode: 'en',
        targetLanguageCode: 'es',
      };
      await this.client.translateText(request);
      console.log('[Translation] Google Cloud Translation connected.');
      this.enabled = true;
    } catch (error) {
      console.log('[Translation] Google credentials not configured.');
      this.enabled = false;
    }
  }

  async translate(text, targetLang) {
    if (!this.enabled) return text;
    if (!text || typeof text !== 'string') return text;
    
    // Return original text if target language is Arabic
    if (targetLang === 'ar') {
      return text;
    }
    
    // Only support translation to English
    if (targetLang !== 'en') {
      return text;
    }

    const cacheKey = `${text}_${targetLang}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const placeholders = [];
    let processedText = text;

    const addPlaceholder = (match) => {
      const id = placeholders.length;
      placeholders.push(match);
      return `<span translate="no" class="notranslate" id="p_${id}"></span>`;
    };

    // Prevent translation of specific elements
    // 1. HTML tags
    processedText = processedText.replace(/<[^>]+>/g, addPlaceholder);
    // 2. URLs
    processedText = processedText.replace(/https?:\/\/[^\s]+/g, addPlaceholder);
    // 3. @usernames
    processedText = processedText.replace(/@[a-zA-Z0-9_]+/g, addPlaceholder);
    // 4. /commands
    processedText = processedText.replace(/\/[a-zA-Z0-9_]+/g, addPlaceholder);
    // 5. Markdown formatting
    processedText = processedText.replace(/```[\s\S]*?```/g, addPlaceholder); // Code blocks
    processedText = processedText.replace(/`[^`]+`/g, addPlaceholder); // Inline code
    processedText = processedText.replace(/(\*\*|__|~~|\|\|)[^\n]+?\1/g, addPlaceholder); // Bold/Underline/Strikethrough/Spoiler
    processedText = processedText.replace(/(\*|_)[^\n]+?\1/g, addPlaceholder); // Italic
    // 6. callback_data (Usually alphanumeric with colons or underscores, but we covered / and _ in markdown. 
    // We will specifically protect anything that looks like a callback_data pattern if needed, 
    // but typically callback data is not sent as raw text. If it is, protecting JSON or typical formats:
    processedText = processedText.replace(/\{"cmd":"[^"]+"\}/g, addPlaceholder); // Example JSON callback_data

    try {
      const request = {
        parent: `projects/${this.projectId}/locations/${this.location}`,
        contents: [processedText],
        mimeType: 'text/html',
        sourceLanguageCode: 'ar',
        targetLanguageCode: targetLang,
      };

      const [response] = await this.client.translateText(request);
      let translatedText = response.translations[0].translatedText;

      // Restore placeholders
      translatedText = translatedText.replace(/<\s*span\s+translate\s*=\s*"no"\s+class\s*=\s*"notranslate"\s+id\s*=\s*"p_(\d+)"\s*>\s*<\s*\/\s*span\s*>/ig, (match, id) => {
        return placeholders[parseInt(id)];
      });
      
      // Decode HTML entities that might have been encoded by Google Translate
      translatedText = translatedText.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      this.cache.set(cacheKey, translatedText);
      return translatedText;
    } catch (error) {
      // On API failure, log the error and return the original text without throwing
      if (logger && logger.error) {
        logger.error({ err: error, text }, 'Google Cloud Translation API failed');
      } else {
        console.error('Google Cloud Translation API failed:', error);
      }
      return text;
    }
  }
}

module.exports = new TranslationService();

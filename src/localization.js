const fs = require('fs');
const path = require('path');

const locales = {
  ar: {},
  en: {}
};

function loadLocales() {
  try {
    const arPath = path.join(__dirname, '..', 'locales', 'ar.json');
    const enPath = path.join(__dirname, '..', 'locales', 'en.json');
    
    if (fs.existsSync(arPath)) {
      locales['ar'] = JSON.parse(fs.readFileSync(arPath, 'utf8'));
    }
    if (fs.existsSync(enPath)) {
      locales['en'] = JSON.parse(fs.readFileSync(enPath, 'utf8'));
    }
  } catch (error) {
    console.error('[Localization] Error loading locale files:', error);
  }
}

// Load once at startup
loadLocales();

function normalizeLanguage(lang) {
  if (!lang || typeof lang !== 'string') return 'ar';
  
  const normalized = lang.toLowerCase().trim();
  
  if (normalized.startsWith('en') || normalized === 'english') {
    return 'en';
  }
  
  if (normalized.startsWith('ar') || normalized === 'arabic') {
    return 'ar';
  }
  
  return 'ar'; // Default language
}

function t(language, key) {
  if (!key) return '';
  
  const lang = normalizeLanguage(language);
  
  // Try requested language
  if (locales[lang] && locales[lang][key] !== undefined) {
    return locales[lang][key];
  }
  
  // Fallback to Arabic
  if (lang !== 'ar' && locales['ar'] && locales['ar'][key] !== undefined) {
    return locales['ar'][key];
  }
  
  // If missing in both, return the key
  return key;
}

module.exports = {
  t,
  normalizeLanguage
};

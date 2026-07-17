const assert = require('assert');

// Mock dependencies before requiring TranslationService
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(name) {
  if (name === 'pg') {
    return {
      Pool: class {
        query() { return Promise.resolve({ rows: [] }); }
      }
    };
  }
  if (name === './logger') {
    return { info: () => {}, error: () => {}, warn: () => {} };
  }
  if (name === 'google-translate-api-x') {
    return async (text, options) => {
      // Mock translation: just convert to uppercase for test verification, but KEEP tokens intact
      let translated = text.toUpperCase();
      // Tokens like {{{0}}} stay uppercase when mocked, we don't change them
      return { text: translated };
    };
  }
  return originalRequire.apply(this, arguments);
};

const translationService = require('./translation-service');

async function runTests() {
  console.log('Running tests...');

  // 1. One custom emoji
  const test1 = 'Hello <tg-emoji emoji-id="123">😀</tg-emoji> world';
  const res1 = await translationService.translate(test1, 'en');
  assert(res1.includes('<tg-emoji emoji-id="123">😀</tg-emoji>'), 'Test 1 failed');

  // 2. Multiple custom emojis
  const test2 = 'Hello <tg-emoji emoji-id="123">😀</tg-emoji> world <tg-emoji emoji-id="456">👍</tg-emoji>';
  const res2 = await translationService.translate(test2, 'en');
  assert(res2.includes('<tg-emoji emoji-id="123">😀</tg-emoji>'), 'Test 2 failed (first emoji missing)');
  assert(res2.includes('<tg-emoji emoji-id="456">👍</tg-emoji>'), 'Test 2 failed (second emoji missing)');

  // 3. Repeated custom emojis
  const test3 = '<tg-emoji emoji-id="123">😀</tg-emoji> <tg-emoji emoji-id="123">😀</tg-emoji>';
  const res3 = await translationService.translate(test3, 'en');
  assert.strictEqual((res3.match(/<tg-emoji emoji-id="123">😀<\/tg-emoji>/g) || []).length, 2, 'Test 3 failed');

  // 4. Emojis on multiple lines
  const test4 = 'Line 1 <tg-emoji emoji-id="123">😀</tg-emoji>\nLine 2 <tg-emoji emoji-id="456">👍</tg-emoji>';
  const res4 = await translationService.translate(test4, 'en');
  assert(res4.includes('LINE 1 <tg-emoji emoji-id="123">😀</tg-emoji>\nLINE 2 <tg-emoji emoji-id="456">👍</tg-emoji>'), 'Test 4 failed');

  console.log('All tests passed!');
  process.exit(0);
}

runTests().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});

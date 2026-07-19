/**
 * backup-crypto.js — AES-256-GCM encryption/decryption for backups.
 *
 * Binary format of an encrypted backup:
 *   [IV: 16 bytes][AuthTag: 16 bytes][Ciphertext: N bytes]
 *
 * The encryption key is read from the BACKUP_ENCRYPTION_KEY env var
 * and must be exactly 64 hex characters (32 bytes).
 */

'use strict';

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;        // 128-bit IV (recommended for GCM)
const AUTH_TAG_LENGTH = 16;  // 128-bit authentication tag

/**
 * Validate and parse the hex encryption key.
 * @param {string} keyHex — 64-character hex string
 * @returns {Buffer} — 32-byte key buffer
 */
function parseKey(keyHex) {
  if (!keyHex || typeof keyHex !== 'string') {
    throw new Error('[Backup Crypto] BACKUP_ENCRYPTION_KEY is not set');
  }
  const cleaned = keyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error('[Backup Crypto] BACKUP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(cleaned, 'hex');
}

/**
 * Encrypt a buffer using AES-256-GCM.
 * @param {Buffer} plaintext — Data to encrypt
 * @param {string} keyHex   — 64-char hex encryption key
 * @returns {Buffer} — Encrypted payload: [IV][AuthTag][Ciphertext]
 */
function encrypt(plaintext, keyHex) {
  const key = parseKey(keyHex);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: IV + AuthTag + Ciphertext
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer that was encrypted with `encrypt()`.
 * @param {Buffer} encryptedPayload — [IV][AuthTag][Ciphertext]
 * @param {string} keyHex           — 64-char hex encryption key
 * @returns {Buffer} — Decrypted plaintext
 */
function decrypt(encryptedPayload, keyHex) {
  const key = parseKey(keyHex);

  if (encryptedPayload.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('[Backup Crypto] Encrypted payload is too short to be valid');
  }

  const iv = encryptedPayload.subarray(0, IV_LENGTH);
  const authTag = encryptedPayload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encryptedPayload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted;
}

module.exports = { encrypt, decrypt };

/**
 * backup-compressor.js — ZIP compression/decompression for backups.
 *
 * Uses Node.js built-in `zlib` module only (no external dependencies).
 *
 * Internal format (custom container):
 *   - A JSON-encoded header (manifest of files + their compressed sizes)
 *   - Followed by the concatenated deflated file contents
 *
 * Structure:
 *   [4 bytes: header length (UInt32BE)]
 *   [header JSON bytes]
 *   [deflated file 1]
 *   [deflated file 2]
 *   ...
 */

'use strict';

const zlib = require('node:zlib');

/**
 * Compress a map of filename → Buffer into a single archive buffer.
 *
 * @param {Object<string, Buffer>} dataMap — e.g. { 'manifest.json': Buffer, 'faculties.csv': Buffer }
 * @returns {Promise<Buffer>} — The compressed archive
 */
async function compress(dataMap) {
  const entries = Object.entries(dataMap);
  const header = [];
  const compressedParts = [];

  for (const [name, data] of entries) {
    const compressed = await deflate(data);
    header.push({
      name,
      originalSize: data.length,
      compressedSize: compressed.length
    });
    compressedParts.push(compressed);
  }

  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLenBuf = Buffer.alloc(4);
  headerLenBuf.writeUInt32BE(headerJson.length, 0);

  return Buffer.concat([headerLenBuf, headerJson, ...compressedParts]);
}

/**
 * Decompress an archive buffer back into a map of filename → Buffer.
 *
 * @param {Buffer} archive — The compressed archive
 * @returns {Promise<Object<string, Buffer>>} — The decompressed file map
 */
async function decompress(archive) {
  if (archive.length < 4) {
    throw new Error('[Backup Compressor] Archive is too short to be valid');
  }

  const headerLen = archive.readUInt32BE(0);
  if (archive.length < 4 + headerLen) {
    throw new Error('[Backup Compressor] Archive header is truncated');
  }

  const headerJson = archive.subarray(4, 4 + headerLen);
  const header = JSON.parse(headerJson.toString('utf8'));

  const dataMap = {};
  let offset = 4 + headerLen;

  for (const entry of header) {
    if (offset + entry.compressedSize > archive.length) {
      throw new Error(`[Backup Compressor] Archive data truncated for entry: ${entry.name}`);
    }
    const compressedChunk = archive.subarray(offset, offset + entry.compressedSize);
    dataMap[entry.name] = await inflate(compressedChunk);
    offset += entry.compressedSize;
  }

  return dataMap;
}

/**
 * Deflate a buffer (zlib raw deflate).
 */
function deflate(buffer) {
  return new Promise((resolve, reject) => {
    zlib.deflate(buffer, { level: zlib.constants.Z_BEST_COMPRESSION }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * Inflate a deflated buffer.
 */
function inflate(buffer) {
  return new Promise((resolve, reject) => {
    zlib.inflate(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

module.exports = { compress, decompress };

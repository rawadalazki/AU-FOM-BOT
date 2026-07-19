/**
 * backup-storage.js — Cloudflare R2 operations for backups.
 *
 * Provides upload, download, list, and delete for the `backups/` prefix
 * in the configured R2 bucket. Uses its own S3Client instance to access
 * ListObjectsV2Command which is not exposed by the main storage.js.
 *
 * IMPORTANT: No pre-signed URLs or download URLs are ever generated.
 */

'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const logger = require('../../logger');

const BACKUP_PREFIX = 'backups/';

let s3Client = null;
let bucketName = null;

/**
 * Initialize the S3 client for backup operations.
 * Called once at module load time.
 */
function init() {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  const region = process.env.S3_REGION || 'auto';
  bucketName = process.env.S3_BUCKET || 'fombot-uploads';

  if (endpoint && accessKey && secretKey) {
    s3Client = new S3Client({
      region,
      endpoint,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey
      },
      forcePathStyle: true
    });
    logger.info(`[Backup Storage] R2 client initialized (bucket: ${bucketName}, prefix: ${BACKUP_PREFIX})`);
  } else {
    logger.warn('[Backup Storage] S3 credentials not configured — backup storage is unavailable');
  }
}

// Auto-initialize on require
init();

/**
 * Check if storage is available.
 */
function isAvailable() {
  return s3Client !== null;
}

/**
 * Upload an encrypted backup buffer to R2.
 * @param {string} key    — Object key (e.g. 'backups/fombot-backup-2026-07-19.enc')
 * @param {Buffer} buffer — The encrypted backup data
 */
async function upload(key, buffer) {
  if (!s3Client) throw new Error('[Backup Storage] S3 not configured');

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: 'application/octet-stream'
  }));

  logger.info({ key, size: buffer.length }, '[Backup Storage] Uploaded backup');
}

/**
 * Download a backup buffer from R2.
 * @param {string} key — Object key
 * @returns {Promise<Buffer>} — The raw (encrypted) backup data
 */
async function download(key) {
  if (!s3Client) throw new Error('[Backup Storage] S3 not configured');

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: key
  }));

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * List all backup objects in the `backups/` prefix.
 * Returns metadata only — never exposes download URLs.
 *
 * @returns {Promise<Array<{key: string, size: number, lastModified: Date}>>}
 */
async function list() {
  if (!s3Client) throw new Error('[Backup Storage] S3 not configured');

  const results = [];
  let continuationToken = undefined;

  do {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: BACKUP_PREFIX,
      ContinuationToken: continuationToken
    }));

    if (response.Contents) {
      for (const obj of response.Contents) {
        results.push({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified
        });
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  // Sort newest first
  results.sort((a, b) => b.lastModified - a.lastModified);

  return results;
}

/**
 * Delete a backup object from R2.
 * @param {string} key — Object key to delete
 */
async function remove(key) {
  if (!s3Client) throw new Error('[Backup Storage] S3 not configured');

  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key
  }));

  logger.info({ key }, '[Backup Storage] Deleted backup');
}

module.exports = {
  isAvailable,
  upload,
  download,
  list,
  remove,
  BACKUP_PREFIX
};

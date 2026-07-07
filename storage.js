const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl: s3GetSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('./logger');

// ── S3 Client Configuration ──────────────────────────
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_BUCKET = process.env.S3_BUCKET || 'fombot-uploads';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL || '';

let s3Client = null;

if (S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY) {
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY
    },
    forcePathStyle: true // Required for R2 and MinIO
  });
  logger.info(`[Storage] S3-compatible storage configured (bucket: ${S3_BUCKET})`);
} else {
  logger.warn('[Storage] WARNING: S3 credentials not configured. File uploads will fail.');
}

/**
 * Generate a unique S3 object key from a filename.
 */
function generateKey(originalName) {
  const sanitized = (originalName || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const uniqueId = Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  return `uploads/${uniqueId}_${sanitized}`;
}

/**
 * Upload a Buffer to S3.
 * @param {Buffer} buffer - The file content
 * @param {string} originalName - Original filename (used for key generation and Content-Disposition)
 * @returns {Promise<{key: string, url: string}>}
 */
async function uploadFile(buffer, originalName) {
  if (!s3Client) throw new Error('S3 storage is not configured');

  const key = generateKey(originalName);
  const ext = path.extname(originalName || '').toLowerCase();
  const contentType = getMimeType(ext);

  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ContentDisposition: `inline; filename="${originalName || 'file'}"`,
  }));

  return { key, url: getFileProxyUrl(key) };
}

/**
 * Upload a Stream to S3.
 * @param {ReadableStream} stream - The file stream
 * @param {string} originalName - Original filename
 * @returns {Promise<{key: string, url: string}>}
 */
async function uploadStream(stream, originalName) {
  if (!s3Client) throw new Error('S3 storage is not configured');

  const key = generateKey(originalName);
  const ext = path.extname(originalName || '').toLowerCase();
  const contentType = getMimeType(ext);

  const parallelUploads3 = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: stream,
      ContentType: contentType,
      ContentDisposition: `inline; filename="${originalName || 'file'}"`,
    },
  });

  await parallelUploads3.done();

  return { key, url: getFileProxyUrl(key) };
}

/**
 * Get a pre-signed download URL for an S3 object (expires in 1 hour).
 * @param {string} key - S3 object key
 * @returns {Promise<string>}
 */
async function getSignedUrl(key) {
  if (!s3Client) throw new Error('S3 storage is not configured');

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key
  });

  return await s3GetSignedUrl(s3Client, command, { expiresIn: 3600 });
}

/**
 * Delete an object from S3.
 * @param {string} key - S3 object key
 */
async function deleteFile(key) {
  if (!s3Client || !key) return;

  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    }));
  } catch (err) {
    logger.error({ err, key }, `[Storage] Failed to delete file`);
  }
}

/**
 * Read a file from S3 into a Buffer.
 * @param {string} key - S3 object key
 * @returns {Promise<Buffer>}
 */
async function getFileBuffer(key) {
  if (!s3Client) throw new Error('S3 storage is not configured');

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key
  }));

  // Convert readable stream to Buffer
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Get the S3 GetObject response (for streaming to HTTP response).
 * @param {string} key - S3 object key
 * @returns {Promise<object>} - S3 GetObjectCommandOutput
 */
async function getFileStream(key) {
  if (!s3Client) throw new Error('S3 storage is not configured');

  return await s3Client.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key
  }));
}

/**
 * Copy an S3 object to a new key (used for faculty duplication).
 * @param {string} sourceKey - Original S3 object key
 * @param {string} originalName - Filename for the new key
 * @returns {Promise<string>} - New S3 object key
 */
async function copyFile(sourceKey, originalName) {
  if (!s3Client) throw new Error('S3 storage is not configured');

  const newKey = generateKey(originalName || path.basename(sourceKey));

  await s3Client.send(new CopyObjectCommand({
    Bucket: S3_BUCKET,
    CopySource: `${S3_BUCKET}/${sourceKey}`,
    Key: newKey
  }));

  return newKey;
}

/**
 * Get the proxy URL for serving a file through our API.
 * This is used in API responses so clients can download files.
 * @param {string} key - S3 object key
 * @returns {string}
 */
function getFileProxyUrl(key) {
  if (!key) return null;
  // If a public S3 URL is configured, use it directly
  if (S3_PUBLIC_URL) {
    return `${S3_PUBLIC_URL}/${key}`;
  }
  // Otherwise use our built-in proxy endpoint
  return `/api/files/${encodeURIComponent(key)}`;
}

/**
 * Determine MIME type from file extension.
 */
function getMimeType(ext) {
  const types = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = {
  uploadFile,
  uploadStream,
  getSignedUrl,
  deleteFile,
  getFileBuffer,
  getFileStream,
  copyFile,
  getFileProxyUrl,
  getMimeType
};

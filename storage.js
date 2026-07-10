const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl: s3GetSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const logger = require('./logger');

// S3 Client Configuration
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

function getMimeType(ext) {
  const map = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

async function uploadStream(stream, key) {
  if (!s3Client) throw new Error('S3 storage is not configured');
  const parallelUploads3 = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: stream,
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  });
  await parallelUploads3.done();
}

async function uploadFile(buffer, key, mimeType) {
  if (!s3Client) throw new Error('S3 storage is not configured');
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType
  }));
}

async function getSignedDownloadUrl(key) {
  if (!s3Client) throw new Error('S3 storage is not configured');
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key
  });
  return await s3GetSignedUrl(s3Client, command, { expiresIn: 3600 });
}

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

async function getFileBuffer(key) {
  if (!s3Client) throw new Error('S3 storage is not configured');
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key
  }));
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function getFileStream(key) {
  if (!s3Client) throw new Error('S3 storage is not configured');
  return await s3Client.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key
  }));
}

async function copyFile(sourceKey, targetKey) {
  if (!s3Client) throw new Error('S3 storage is not configured');
  await s3Client.send(new CopyObjectCommand({
    Bucket: S3_BUCKET,
    CopySource: `${S3_BUCKET}/${sourceKey}`,
    Key: targetKey
  }));
  return targetKey;
}

function getFileProxyUrl(key) {
  if (S3_PUBLIC_URL) {
    return `${S3_PUBLIC_URL}/${key}`;
  }
  return `/api/files/download/${encodeURIComponent(key)}`;
}

module.exports = {
  uploadFile,
  uploadStream,
  getSignedDownloadUrl,
  deleteFile,
  getFileBuffer,
  getFileStream,
  copyFile,
  getFileProxyUrl,
  getMimeType
};

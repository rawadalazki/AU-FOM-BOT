const { exec } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('./logger');
const storage = require('./storage');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const BACKUP_ENABLED = process.env.BACKUP_ENABLED === 'true';
const BACKUP_CRON = process.env.BACKUP_CRON || '0 3 * * *'; // default 3 AM daily
const BACKUP_RETENTION = parseInt(process.env.BACKUP_RETENTION || '7', 10);
const DB_URL = process.env.DATABASE_URL;

// Re-initialize a lightweight S3 client just for listing/deleting backup files
// since storage.js doesn't expose ListObjectsV2 directly.
let s3Client;
if (process.env.S3_ACCESS_KEY) {
  s3Client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true
  });
}

/**
 * Runs a pg_dump and uploads it to S3
 */
async function performBackup() {
  if (!BACKUP_ENABLED) return;
  if (!DB_URL) {
    logger.warn('[Backup] DATABASE_URL not set. Skipping backup.');
    return;
  }
  if (!s3Client) {
    logger.warn('[Backup] S3 credentials not fully configured. Skipping backup.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `fombot-backup-${timestamp}.sql`;
  const filepath = path.join('/tmp', filename);

  logger.info({ filename }, '[Backup] Starting PostgreSQL backup');

  return new Promise((resolve, reject) => {
    // Run pg_dump
    exec(`pg_dump ${DB_URL} -F c -f ${filepath}`, async (error, stdout, stderr) => {
      if (error) {
        logger.error({ err: error, stderr }, '[Backup] pg_dump failed');
        return resolve(false);
      }

      try {
        // Upload to S3
        const fileStream = fs.createReadStream(filepath);
        const s3Key = `backups/${filename}`;
        
        await storage.uploadStream(fileStream, s3Key);
        logger.info({ s3Key }, '[Backup] Successfully uploaded backup to S3');

        // Delete local temp file
        fs.unlinkSync(filepath);

        // Enforce retention policy
        await enforceRetentionPolicy();

        resolve(true);
      } catch (err) {
        logger.error({ err }, '[Backup] Failed to upload or process backup');
        resolve(false);
      }
    });
  });
}

async function enforceRetentionPolicy() {
  try {
    const listCmd = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET,
      Prefix: 'backups/'
    });

    const response = await s3Client.send(listCmd);
    if (!response.Contents) return;

    // Sort by LastModified descending (newest first)
    const files = response.Contents.sort((a, b) => b.LastModified - a.LastModified);
    
    // If we have more files than the retention limit, delete the oldest
    if (files.length > BACKUP_RETENTION) {
      const toDelete = files.slice(BACKUP_RETENTION);
      for (const file of toDelete) {
        logger.info({ key: file.Key }, '[Backup] Deleting old backup to enforce retention');
        const deleteCmd = new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: file.Key
        });
        await s3Client.send(deleteCmd);
      }
    }
  } catch (err) {
    logger.error({ err }, '[Backup] Failed to enforce retention policy');
  }
}

let timerId = null;

function parseCronAndGetNextMs(cronExpression) {
  // A very simplified cron parser just for testing/daily schedules.
  // In a real production app, use the 'node-cron' or 'cron' package.
  // We'll approximate a daily run by just checking every hour if it's the right time,
  // or simply running setInterval every 24 hours.
  
  // For simplicity without adding another npm dependency (node-cron), 
  // we'll run a check every minute.
  
  const [min, hour, dom, mon, dow] = cronExpression.split(' ');
  const targetHour = hour === '*' ? 3 : parseInt(hour, 10);
  const targetMin = min === '*' ? 0 : parseInt(min, 10);

  const now = new Date();
  let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHour, targetMin, 0, 0);
  
  if (now.getTime() >= next.getTime()) {
    next.setDate(next.getDate() + 1); // tomorrow
  }
  
  return next.getTime() - now.getTime();
}

function scheduleNextBackup() {
  if (!BACKUP_ENABLED) return;
  
  const delayMs = parseCronAndGetNextMs(BACKUP_CRON);
  logger.info(`[Backup] Next backup scheduled in ${Math.round(delayMs / 60000)} minutes`);
  
  timerId = setTimeout(async () => {
    await performBackup();
    scheduleNextBackup(); // schedule the next one
  }, delayMs);
}

function startScheduler() {
  if (BACKUP_ENABLED) {
    logger.info(`[Backup] Automatic backups ENABLED (Cron: ${BACKUP_CRON}, Retention: ${BACKUP_RETENTION})`);
    scheduleNextBackup();
  } else {
    logger.info('[Backup] Automatic backups DISABLED (BACKUP_ENABLED != true)');
  }
}

function stopScheduler() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  performBackup
};

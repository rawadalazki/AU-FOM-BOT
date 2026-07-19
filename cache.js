const { createClient } = require('redis');
const logger = require('./logger');

const REDIS_URL = process.env.REDIS_URL;
const DEFAULT_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10); // Default 5 mins

let client = null;
let isConnected = false;

if (REDIS_URL) {
  client = createClient({ url: REDIS_URL });

  client.on('error', (err) => {
    logger.error({ err }, '[Cache] Redis client error');
    isConnected = false;
  });

  client.on('connect', () => {
    logger.info('[Cache] Redis connecting...');
  });

  client.on('ready', () => {
    logger.info('[Cache] Redis connected and ready');
    isConnected = true;
  });

  client.on('end', () => {
    logger.warn('[Cache] Redis connection closed');
    isConnected = false;
  });

  // Non-blocking connect
  client.connect().catch(err => {
    logger.error({ err }, '[Cache] Redis failed to connect initially. Falling back to DB-only mode.');
    isConnected = false;
  });
} else {
  logger.info('[Cache] REDIS_URL not provided. Operating in DB-only mode (No cache).');
}

/**
 * Get a value from the cache.
 * @param {string} key 
 * @returns {Promise<any>}
 */
async function get(key) {
  if (!isConnected || !client) return null;
  try {
    const val = await client.get(key);
    if (val) return JSON.parse(val);
  } catch (err) {
    logger.warn({ err, key }, '[Cache] Error reading from cache');
  }
  return null;
}

/**
 * Set a value in the cache.
 * @param {string} key 
 * @param {any} value 
 * @param {number} ttlSeconds 
 */
async function set(key, value, ttlSeconds = DEFAULT_TTL) {
  if (!isConnected || !client) return;
  try {
    const str = JSON.stringify(value);
    await client.set(key, str, { EX: ttlSeconds });
  } catch (err) {
    logger.warn({ err, key }, '[Cache] Error writing to cache');
  }
}

/**
 * Delete a value from the cache.
 * @param {string} key 
 */
async function del(key) {
  if (!isConnected || !client) return;
  try {
    await client.del(key);
  } catch (err) {
    logger.warn({ err, key }, '[Cache] Error deleting from cache');
  }
}

/**
 * Check if Redis is alive.
 * @returns {Promise<boolean>}
 */
async function ping() {
  if (!client || !isConnected) return false;
  try {
    const res = await client.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Close Redis connection cleanly.
 */
async function close() {
  if (client) {
    try {
      await client.quit();
      logger.info('[Cache] Redis connection closed cleanly.');
    } catch (err) {
      logger.error({ err }, '[Cache] Error closing Redis connection');
    }
  }
}

/**
 * Flush all keys from the cache.
 */
async function flush() {
  if (!isConnected || !client) return;
  try {
    await client.flushAll();
    logger.info('[Cache] Flushed all keys');
  } catch (err) {
    logger.warn({ err }, '[Cache] Error flushing cache');
  }
}

module.exports = {
  get,
  set,
  del,
  flush,
  ping,
  close,
  isActive: () => isConnected
};

const cache = require('./cache');
const logger = require('./logger');

// In-memory fallback map if Redis is not available
// Key: IP, Value: { count: number, resetAt: number }
const memoryStore = new Map();

// Configuration
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 100; // 100 requests per IP per minute

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Check if the current request exceeds the rate limit.
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse} res 
 * @returns {Promise<boolean>} True if allowed, false if rate-limited.
 */
async function rateLimit(req, res) {
  const ip = getClientIp(req);
  const now = Date.now();
  const redisKey = `ratelimit:${ip}`;

  try {
    if (cache.isActive()) {
      // Redis is active, use it for distributed rate limiting
      const current = await cache.get(redisKey);
      
      if (!current) {
        // First request in window
        await cache.set(redisKey, { count: 1 }, WINDOW_MS / 1000);
        return true;
      }

      if (current.count >= MAX_REQUESTS_PER_WINDOW) {
        logger.warn({ ip, limit: MAX_REQUESTS_PER_WINDOW }, 'Rate limit exceeded (Redis)');
        send429(res);
        return false;
      }

      // Increment count (In a real scenario with Redis, INCR is better, but this matches our cache API)
      current.count += 1;
      
      // We don't want to reset TTL, so we just set it again.
      // A pure Redis INCR would be better, but we are using the abstraction.
      // This is slightly racy in high concurrency but sufficient for simple limiting.
      await cache.set(redisKey, current, WINDOW_MS / 1000);
      return true;
    } else {
      // In-memory fallback
      let record = memoryStore.get(ip);
      
      if (!record || now > record.resetAt) {
        memoryStore.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return true;
      }
      
      if (record.count >= MAX_REQUESTS_PER_WINDOW) {
        logger.warn({ ip, limit: MAX_REQUESTS_PER_WINDOW }, 'Rate limit exceeded (Memory)');
        send429(res);
        return false;
      }
      
      record.count += 1;
      return true;
    }
  } catch (err) {
    // If rate limiter fails, allow the request rather than bringing down the service
    logger.error({ err, ip }, 'Rate limiter encountered an error, allowing request');
    return true;
  }
}

// Memory leak protection for the in-memory fallback
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of memoryStore.entries()) {
    if (now > record.resetAt) {
      memoryStore.delete(ip);
    }
  }
}, 60 * 1000).unref();

function send429(res) {
  res.writeHead(429, { 
    'Content-Type': 'application/json',
    'Retry-After': 60
  });
  res.end(JSON.stringify({ error: 'Too many requests, please try again later.' }));
}

module.exports = {
  rateLimit
};

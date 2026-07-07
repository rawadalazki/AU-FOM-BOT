const pino = require('pino');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const transport = process.env.NODE_ENV !== 'production'
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
  : undefined;

const logger = pino({
  level: LOG_LEVEL,
  transport,
  redact: {
    paths: [
      'telegram_token', 
      'secret_token',
      'password',
      'token',
      'req.headers["x-telegram-bot-api-secret-token"]',
      'req.headers.authorization',
      'req.headers.cookie'
    ],
    censor: '[REDACTED]'
  }
});

module.exports = logger;

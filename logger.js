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

// Global intercept to funnel all logger.error calls into the centralized error reporter
const originalError = logger.error.bind(logger);
logger.error = function(obj, msg, ...args) {
  originalError(obj, msg, ...args);
  if (obj && obj.err) {
    // We defer require to avoid circular dependencies
    const { reportRuntimeError } = require('./error-reporter');
    reportRuntimeError({
      Severity: 'ERROR',
      Faculty_ID: obj.facultyId || null,
      Request_ID: obj.reqId || null,
      Error_Type: obj.err.name || 'Error',
      Error_Message: obj.err.message || String(obj.err),
      Stack_Trace: obj.err.stack || '',
      Operation: msg || 'Unknown Logged Error',
      File_Name: 'Unknown',
      Function_Name: 'System Logger',
      ...obj
    });
  }
};


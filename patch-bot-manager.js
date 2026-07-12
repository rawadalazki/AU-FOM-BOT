const fs = require('fs');

let content = fs.readFileSync('bot-manager.js', 'utf8');

// Patch logError
const logErrorReplacement = `
  logError(msg, err, obj = {}) {
    logger.error({ reqId: this.reqId, facultyId: this.facultyId, err, ...obj }, msg);
    const { reportRuntimeError } = require('./error-reporter');
    reportRuntimeError({
      Severity: 'ERROR',
      Faculty_ID: this.facultyId,
      Request_ID: this.reqId,
      Error_Type: err ? err.name : 'BotError',
      Error_Message: err ? (err.message || String(err)) : 'Unknown Error',
      Stack_Trace: err ? err.stack : '',
      Operation: msg,
      File_Name: 'bot-manager.js',
      Function_Name: 'TelegramBotService.logError',
      ...obj
    });
  }
`;
content = content.replace(/logError\(msg, err, obj = \{\}\) \{\s*logger\.error\(\{ reqId: this\.reqId, facultyId: this\.facultyId, err, \.\.\.obj \}, msg\);\s*\}/, logErrorReplacement.trim());

// Patch apiCall
const apiCallOriginal = `
  apiCall(method, payload) {
    return new Promise((resolve, reject) => {
`;
const apiCallReplacement = `
  async apiCall(method, payload, isRetry = false) {
    try {
      const res = await this._rawApiCall(method, payload);
      if (!res.ok) {
        const desc = (res.description || '').toLowerCase();
        const shouldRetry = res.error_code === 400 || res.error_code === 404 || res.error_code === 403 || desc.includes('invalid file') || desc.includes('file reference expired');
        if (shouldRetry && !isRetry) {
          this.logInfo(\`Automatic recovery: Retrying \${method} due to \${res.error_code} \${res.description}\`);
          return await this.apiCall(method, payload, true);
        }
      }
      return res;
    } catch (e) {
      if (!isRetry) {
        this.logInfo(\`Automatic recovery: Retrying \${method} due to exception \${e.message}\`);
        return await this.apiCall(method, payload, true);
      }
      throw e;
    }
  }

  _rawApiCall(method, payload) {
    return new Promise((resolve, reject) => {
`;
content = content.replace(apiCallOriginal, apiCallReplacement);

fs.writeFileSync('bot-manager.js', content);
console.log('Patched bot-manager.js');

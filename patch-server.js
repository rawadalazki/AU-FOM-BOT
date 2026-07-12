const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// Add require
if (!content.includes(`const { reportRuntimeError, recoverUnsentReports } = require('./error-reporter');`)) {
  content = content.replace(
    `const auth = require('./authentication');`,
    `const auth = require('./authentication');\nconst { reportRuntimeError, recoverUnsentReports } = require('./error-reporter');`
  );
}

// Add global handlers
const globalHandlers = `
process.on('uncaughtException', (err) => {
  reportRuntimeError({
    Severity: 'CRITICAL',
    Error_Type: 'UncaughtException',
    Error_Message: err.message,
    Stack_Trace: err.stack,
    Function_Name: 'process.on(uncaughtException)',
    File_Name: 'server.js',
    Operation: 'Unhandled Application Crash'
  });
});

process.on('unhandledRejection', (reason, promise) => {
  reportRuntimeError({
    Severity: 'CRITICAL',
    Error_Type: 'UnhandledRejection',
    Error_Message: reason ? reason.message || String(reason) : 'Unknown',
    Stack_Trace: reason ? reason.stack : '',
    Function_Name: 'process.on(unhandledRejection)',
    File_Name: 'server.js',
    Operation: 'Unhandled Promise Rejection'
  });
});
`;
if (!content.includes('process.on(\'uncaughtException\'')) {
  content = content.replace(`const server = http.createServer(async (req, res) => {`, globalHandlers + `\nconst server = http.createServer(async (req, res) => {`);
}

// Startup call
if (!content.includes('recoverUnsentReports()')) {
  content = content.replace(`logger.info(\`[Server] Starting...\`);`, `logger.info(\`[Server] Starting...\`);\n  recoverUnsentReports();`);
}

// Fix Content-Disposition (Regression 6)
content = content.replace(
  /'Content-Disposition': \`inline; filename="\$\{menu\.file_name \|\| 'file'\}"\`/g,
  `'Content-Disposition': \`inline; filename="download"; filename*=UTF-8''\${encodeURIComponent(menu.file_name || 'file')}\``
);
content = content.replace(
  /'Content-Disposition': \`inline; filename="\$\{mf\.file_name \|\| 'file'\}"\`/g,
  `'Content-Disposition': \`inline; filename="download"; filename*=UTF-8''\${encodeURIComponent(mf.file_name || 'file')}\``
);
content = content.replace(
  /'Content-Disposition': \`inline; filename="\$\{ann\.file_name \|\| 'file'\}"\`/g,
  `'Content-Disposition': \`inline; filename="download"; filename*=UTF-8''\${encodeURIComponent(ann.file_name || 'file')}\``
);

// Replace logger.error / logger.warn in server.js
content = content.replace(/logger\.warn\(\{([^}]+)\},\s*'([^']+)'\)/g, (match, objStr, msg) => {
  if (objStr.includes('err:')) {
    return `reportRuntimeError({
      Severity: 'WARNING',
      Error_Type: 'Warning',
      Error_Message: ${objStr.includes('err.message') ? 'err.message' : 'err.message || String(err)'},
      Stack_Trace: err.stack || '',
      Operation: '${msg}',
      Request_ID: reqId,
      File_Name: 'server.js',
      Function_Name: 'Server API Handler'
    })`;
  }
  return match;
});

content = content.replace(/logger\.error\(\{([^}]+)\},\s*'([^']+)'\)/g, (match, objStr, msg) => {
  if (objStr.includes('err:')) {
    let errVar = 'err';
    if (objStr.includes('err: e')) errVar = 'e';
    return `reportRuntimeError({
      Severity: 'ERROR',
      Error_Type: 'API_Error',
      Error_Message: ${errVar}.message || String(${errVar}),
      Stack_Trace: ${errVar}.stack || '',
      Operation: '${msg}',
      Request_ID: reqId,
      File_Name: 'server.js',
      Function_Name: 'Server API Endpoint'
    })`;
  }
  return match;
});

// Write it back
fs.writeFileSync('server.js', content);
console.log('Patched server.js');

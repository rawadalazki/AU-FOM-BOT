const fs = require('fs');

const dbContent = fs.readFileSync('c:/Users/Rawad/Desktop/FOMbot/database.js', 'utf8');

let newContent = dbContent;

// 1. Add safeInitQuery before initDb()
const safeInitQueryCode = `
/**
 * Retry-safe query execution for Neon DB transient errors.
 */
async function safeInitQuery(queryText, params = [], { retries = 5, delay = 1000, optional = false } = {}) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await pool.query(queryText, params);
    } catch (err) {
      const isTransient = 
        err.code === 'XX000' || 
        (err.message && (
          err.message.includes('Control plane request failed') ||
          err.message.includes('Connection terminated') ||
          err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT')
        ));
      
      if (!isTransient || attempt === retries) {
        if (optional) {
          logger.warn({ err }, \`[DB INIT] Optional table/query skipped after \${attempt} retries: \${queryText.substring(0, 50)}...\`);
          return null;
        }
        logger.error({ err }, \`[DB INIT] Fatal database initialization failure after \${attempt} retries: \${queryText.substring(0, 50)}...\`);
        throw err;
      }

      attempt++;
      logger.warn(\`[DB INIT] Retry \${attempt}/\${retries} for query: \${queryText.substring(0, 50)}...\`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2; // Exponential backoff
    }
  }
}
`;

if (!newContent.includes('safeInitQuery(')) {
  newContent = newContent.replace('async function initDb() {', safeInitQueryCode + '\nasync function initDb() {');
}

// 2. Replace core tables pool.query with safeInitQuery(..., [], { optional: false })
// and optional tables with safeInitQuery(..., [], { optional: true })

// faculties - Core
newContent = newContent.replace(/await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS faculties/, "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS faculties");
// menus - Core
newContent = newContent.replace(/await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS menus/, "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS menus");
// announcements - Core
newContent = newContent.replace(/await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS announcements/, "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS announcements");
// bot_users - Core
newContent = newContent.replace(/await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS bot_users/, "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS bot_users");
// admins - Core
newContent = newContent.replace(/await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admins/, "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS admins");
// admin_users - Core
newContent = newContent.replace(/await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_users/, "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS admin_users");

// admin_states - Optional
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_states([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS admin_states$1\`, [], { optional: true });"
);

// admin_sessions - Optional
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_sessions([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS admin_sessions$1\`, [], { optional: true });"
);

// admin_audit_log - Optional
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_audit_log([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS admin_audit_log$1\`, [], { optional: true });"
);

// bot_users_log - Optional
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS bot_users_log([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS bot_users_log$1\`, [], { optional: true });"
);

// menu_files - Core (Since it is essential for app logic now)
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS menu_files([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS menu_files$1\`, [], { optional: false });"
);

// announcement_messages - Core
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS announcement_messages([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE TABLE IF NOT EXISTS announcement_messages$1\`, [], { optional: false });"
);

// Indexes - Core / Optional based on tables
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE UNIQUE INDEX IF NOT EXISTS one_deputy_owner([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE UNIQUE INDEX IF NOT EXISTS one_deputy_owner$1\`, [], { optional: false });"
);
newContent = newContent.replace(
  /await pool\.query\(`\s*CREATE UNIQUE INDEX IF NOT EXISTS one_owner([\s\S]*?)`\);/,
  "await safeInitQuery(`\n    CREATE UNIQUE INDEX IF NOT EXISTS one_owner$1\`, [], { optional: false });"
);

// Alter queries loop - make it use safeInitQuery with optional=true
newContent = newContent.replace(
  /for \(const q of alterQueries\) \{\s*await pool\.query\(q\)\.catch\(e => logger\.warn\(`\[DB Migration\] Note: \$\{e\.message\}`\)\);\s*\}/,
  "for (const q of alterQueries) {\n    await safeInitQuery(q, [], { optional: true });\n  }"
);

// Alter columns with explicit try/catch - we'll just leave them or convert to safeInitQuery
newContent = newContent.replace(
  /try \{\s*await pool\.query\(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS notify_new_user BOOLEAN DEFAULT false;`\);\s*\} catch\(e\) \{\}/,
  "await safeInitQuery(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS notify_new_user BOOLEAN DEFAULT false;`, [], { optional: true });"
);

newContent = newContent.replace(
  /await pool\.query\(\s*`ALTER TABLE menus ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`\s*\);/,
  "await safeInitQuery(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`, [], { optional: true });"
);

newContent = newContent.replace(
  /await pool\.query\(\s*`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`\s*\);/,
  "await safeInitQuery(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`, [], { optional: true });"
);

// Expose safeInitQuery in module.exports
if (newContent.includes('module.exports = {') && !newContent.includes('safeInitQuery,')) {
  newContent = newContent.replace('module.exports = {', 'module.exports = {\n  safeInitQuery,');
}

fs.writeFileSync('c:/Users/Rawad/Desktop/FOMbot/database.js', newContent);
console.log('database.js refactored.');

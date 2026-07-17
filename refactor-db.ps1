$content = Get-Content -Path 'C:\Users\Rawad\Desktop\FOMbot\database.js' -Raw -Encoding UTF8

$safeInitQueryCode = @"

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
"@

if (-not $content.Contains("safeInitQuery(")) {
    $content = $content -replace "async function initDb\(\) \{", "$safeInitQueryCode`nasync function initDb() {"
}

$content = $content -replace "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS faculties", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS faculties"
$content = $content -replace "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS menus", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS menus"
$content = $content -replace "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS announcements", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS announcements"
$content = $content -replace "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS bot_users", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS bot_users"
$content = $content -replace "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admins", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS admins"
$content = $content -replace "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_users", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS admin_users"

$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_states([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS admin_states`$1``, [], { optional: true });")
$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_sessions([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS admin_sessions`$1``, [], { optional: true });")
$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS admin_audit_log([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS admin_audit_log`$1``, [], { optional: true });")
$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS bot_users_log([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS bot_users_log`$1``, [], { optional: true });")

$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS menu_files([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS menu_files`$1``, [], { optional: false });")
$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE TABLE IF NOT EXISTS announcement_messages([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE TABLE IF NOT EXISTS announcement_messages`$1``, [], { optional: false });")

$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE UNIQUE INDEX IF NOT EXISTS one_deputy_owner([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE UNIQUE INDEX IF NOT EXISTS one_deputy_owner`$1``, [], { optional: false });")
$content = [regex]::Replace($content, "await pool\.query\(`\s*CREATE UNIQUE INDEX IF NOT EXISTS one_owner([\s\S]*?)`\);", "await safeInitQuery(``n    CREATE UNIQUE INDEX IF NOT EXISTS one_owner`$1``, [], { optional: false });")

$content = [regex]::Replace($content, "for \(const q of alterQueries\) \{\s*await pool\.query\(q\)\.catch\(e => logger\.warn\(`\[DB Migration\] Note: \`\$\{e\.message\}`\)`\);\s*\}", "for (const q of alterQueries) {`n    await safeInitQuery(q, [], { optional: true });`n  }")

$content = [regex]::Replace($content, "try \{\s*await pool\.query\(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS notify_new_user BOOLEAN DEFAULT false;`\);\s*\} catch\(e\) \{\}", "await safeInitQuery(``ALTER TABLE faculties ADD COLUMN IF NOT EXISTS notify_new_user BOOLEAN DEFAULT false;``, [], { optional: true });")
$content = [regex]::Replace($content, "await pool\.query\(\s*`ALTER TABLE menus ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`\s*\);", "await safeInitQuery(``ALTER TABLE menus ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;``, [], { optional: true });")
$content = [regex]::Replace($content, "await pool\.query\(\s*`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`\s*\);", "await safeInitQuery(``ALTER TABLE announcements ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;``, [], { optional: true });")

if ($content -match "module.exports = \{" -and -not $content.Contains("safeInitQuery,")) {
    $content = $content -replace "module\.exports = \{", "module.exports = {`n  safeInitQuery,"
}

Set-Content -Path 'C:\Users\Rawad\Desktop\FOMbot\database.js' -Value $content -Encoding UTF8
Write-Output "database.js refactored."

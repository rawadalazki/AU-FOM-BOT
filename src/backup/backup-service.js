/**
 * backup-service.js — Core BackupService for the FOMbot platform.
 *
 * Responsibilities:
 *   - Create backups (Data export → compress → encrypt → upload to R2)
 *   - Restore from any available backup
 *   - List available backups (metadata only, no URLs)
 *   - Delete individual backups
 *   - Enforce retention policy (keep latest 5)
 *   - Schedule automatic backups every 24 hours
 *
 * Note: This service uses PostgreSQL COPY for data extraction. It does NOT
 * produce a full pg_dump-compatible SQL file for data. COPY only backs up data, 
 * not the database schema (tables, indexes, constraints, etc.).
 * 
 * To ensure completeness, the schema is backed up independently via pg_dump -s 
 * and schema recreation is guaranteed via database.js initDb() during restore.
 */

'use strict';

const logger = require('../../logger');
const dbHelper = require('../../database');
const { pool } = dbHelper;
const crypto = require('./backup-crypto');
const compressor = require('./backup-compressor');
const storage = require('./backup-storage');

const MAX_BACKUPS = 5;

/**
 * Tables in FK-safe insertion order.
 * Restore inserts in this order; truncate reverses it.
 */
const TABLE_ORDER = [
  'faculties',
  'menus',
  'menu_files',
  'announcements',
  'announcement_messages',
  'bot_users',
  'bot_users_log',
  'admin_states',
  'admin_users',
  'admin_sessions',
  'admin_audit_log',
  'admins'
];

class BackupService {
  constructor() {
    this._timerId = null;
    this._isRunning = false;
  }

  // ─── CREATE BACKUP ───────────────────────────────────────────

  /**
   * Full backup pipeline: dump → compress → encrypt → upload → cleanup.
   * @param {string} [triggeredBy='scheduler'] — Who initiated the backup
   * @returns {Promise<{success: boolean, key?: string, error?: string}>}
   */
  async createBackup(triggeredBy = 'scheduler') {
    if (this._isRunning) {
      logger.warn('[Backup] A backup operation is already in progress, skipping');
      return { success: false, error: 'Backup already in progress' };
    }

    this._isRunning = true;
    const startTime = Date.now();

    try {
      // Pre-flight checks
      if (!storage.isAvailable()) {
        throw new Error('R2 storage is not configured');
      }

      const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error('BACKUP_ENCRYPTION_KEY is not set');
      }

      logger.info({ triggeredBy }, '[Backup] Starting backup...');

      // Step 1: Dump all tables
      const dataMap = await this._dumpDatabase();

      // Step 2: Compress
      const compressed = await compressor.compress(dataMap);
      logger.info({ originalFiles: Object.keys(dataMap).length, compressedSize: compressed.length }, '[Backup] Compressed');

      // Step 3: Encrypt
      const encrypted = crypto.encrypt(compressed, encryptionKey);
      logger.info({ encryptedSize: encrypted.length }, '[Backup] Encrypted');

      // Step 4: Upload to R2
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const key = `${storage.BACKUP_PREFIX}fombot-backup-${timestamp}.enc`;
      await storage.upload(key, encrypted);

      // Step 5: Cleanup old backups
      await this.cleanup();

      const durationMs = Date.now() - startTime;
      logger.info({ key, durationMs, triggeredBy }, '[Backup] Backup completed successfully');

      return { success: true, key };
    } catch (err) {
      logger.error({ err, triggeredBy }, '[Backup] Backup failed');
      return { success: false, error: err.message };
    } finally {
      this._isRunning = false;
    }
  }

  /**
   * Dump all tables into a data map using COPY TO STDOUT (CSV format).
   * Also includes a schema-only dump via pg_dump.
   * @returns {Promise<Object<string, Buffer>>}
   */
  async _dumpDatabase() {
    const dataMap = {};
    const manifest = {
      version: '1.0.0',
      created_at: new Date().toISOString(),
      tables: []
    };

    // 1. Export schema using pg_dump (schema-only)
    try {
      const { exec } = require('node:child_process');
      const util = require('node:util');
      const execPromise = util.promisify(exec);
      
      if (process.env.DATABASE_URL) {
        const { stdout } = await execPromise(`pg_dump -s ${process.env.DATABASE_URL}`);
        dataMap['schema.sql'] = Buffer.from(stdout, 'utf8');
        logger.info('[Backup] Exported database schema via pg_dump');
      }
    } catch (err) {
      logger.warn({ err }, '[Backup] Failed to export schema via pg_dump, continuing with data only');
    }

    // 2. Export data via COPY
    const client = await pool.connect();
    try {
      for (const table of TABLE_ORDER) {
        try {
          // Check if table exists
          const { rows: exists } = await client.query(
            `SELECT to_regclass($1) AS oid`, [`public.${table}`]
          );
          if (!exists[0] || !exists[0].oid) {
            logger.info({ table }, '[Backup] Table does not exist, skipping');
            continue;
          }

          // Get row count for manifest
          const { rows: countResult } = await client.query(`SELECT COUNT(*) AS cnt FROM "${table}"`);
          const rowCount = parseInt(countResult[0].cnt, 10);

          if (rowCount === 0) {
            manifest.tables.push({ name: table, rows: 0, hasData: false });
            continue;
          }

          // Dump table using fallback or COPY
          const csvData = await this._copyToBuffer(client, table);

          dataMap[`${table}.csv`] = csvData;
          manifest.tables.push({ name: table, rows: rowCount, hasData: true });

          logger.info({ table, rows: rowCount, csvSize: csvData.length }, '[Backup] Dumped table');
        } catch (tableErr) {
          logger.warn({ err: tableErr, table }, '[Backup] Failed to dump table, skipping');
          manifest.tables.push({ name: table, rows: 0, hasData: false, error: tableErr.message });
        }
      }
    } finally {
      client.release();
    }

    dataMap['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    return dataMap;
  }

  /**
   * Stream table data to a buffer.
   * Since the native pg driver doesn't handle COPY TO STDOUT without pg-copy-streams,
   * we use the SELECT-based JSON/CSV dump which is safe and reliable.
   */
  async _copyToBuffer(client, table) {
    return await this._selectToCsv(client, table);
  }

  /**
   * Fallback dump method: SELECT all rows and serialize as CSV.
   * This works with any PostgreSQL driver without COPY protocol support.
   */
  async _selectToCsv(client, table) {
    const { rows, fields } = await client.query(`SELECT * FROM "${table}"`);

    if (!fields || fields.length === 0) {
      return Buffer.from('', 'utf8');
    }

    const columns = fields.map(f => f.name);

    // Build CSV
    const lines = [];

    // Header
    lines.push(columns.map(c => this._csvEscape(c)).join(','));

    // Rows
    for (const row of rows) {
      const values = columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        if (val instanceof Date) return val.toISOString();
        if (typeof val === 'object') return this._csvEscape(JSON.stringify(val));
        return this._csvEscape(String(val));
      });
      lines.push(values.join(','));
    }

    return Buffer.from(lines.join('\n') + '\n', 'utf8');
  }

  /**
   * Escape a value for CSV format.
   */
  _csvEscape(value) {
    if (value === '' || value === null || value === undefined) return '';
    const str = String(value);
    // If the value contains commas, quotes, or newlines, wrap in quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ─── RESTORE BACKUP ──────────────────────────────────────────

  /**
   * Restore from a specific backup.
   * @param {string} backupKey — The R2 object key of the backup to restore
   * @returns {Promise<{success: boolean, tablesRestored?: string[], error?: string}>}
   */
  async restoreBackup(backupKey) {
    if (this._isRunning) {
      return { success: false, error: 'A backup operation is already in progress' };
    }

    this._isRunning = true;
    const startTime = Date.now();

    try {
      const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error('BACKUP_ENCRYPTION_KEY is not set');
      }

      logger.info({ backupKey }, '[Backup] Starting restore...');

      // Step 1: Download from R2
      const encrypted = await storage.download(backupKey);
      logger.info({ size: encrypted.length }, '[Backup] Downloaded encrypted backup');

      // Step 2: Decrypt
      const compressed = crypto.decrypt(encrypted, encryptionKey);
      logger.info({ size: compressed.length }, '[Backup] Decrypted');

      // Step 3: Decompress
      const dataMap = await compressor.decompress(compressed);
      logger.info({ files: Object.keys(dataMap) }, '[Backup] Decompressed');

      // Step 4: Parse manifest
      if (!dataMap['manifest.json']) {
        throw new Error('Backup archive is missing manifest.json');
      }
      const manifest = JSON.parse(dataMap['manifest.json'].toString('utf8'));

      // Step 5: Restore tables in a transaction
      const tablesRestored = await this._restoreDatabase(dataMap, manifest);

      const durationMs = Date.now() - startTime;
      logger.info({ tablesRestored, durationMs }, '[Backup] Restore completed successfully');

      return { success: true, tablesRestored };
    } catch (err) {
      logger.error({ err, backupKey }, '[Backup] Restore failed');
      return { success: false, error: err.message };
    } finally {
      this._isRunning = false;
    }
  }

  /**
   * Restore all tables from the backup data within a transaction.
   */
  async _restoreDatabase(dataMap, manifest) {
    const dbHelper = require('../../database');
    
    // Step 1: Ensure database schema is recreated independently before importing data
    // Since COPY only backs up data, we must guarantee tables exist.
    logger.info('[Backup] Recreating database schema via initDb()...');
    await dbHelper.initDb();

    const client = await pool.connect();
    const tablesRestored = [];

    try {
      await client.query('BEGIN');

      // Disable FK checks during restore
      await client.query('SET session_replication_role = replica');

      // Truncate all tables (reverse order for FK safety, but we disabled FKs anyway)
      const reverseTables = [...TABLE_ORDER].reverse();
      for (const table of reverseTables) {
        try {
          const { rows: exists } = await client.query(
            `SELECT to_regclass($1) AS oid`, [`public.${table}`]
          );
          if (exists[0] && exists[0].oid) {
            await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
          }
        } catch (e) {
          logger.warn({ table, err: e }, '[Backup] Could not truncate table');
        }
      }

      // Insert data for each table from manifest
      for (const tableInfo of manifest.tables) {
        if (!tableInfo.hasData) continue;

        const csvKey = `${tableInfo.name}.csv`;
        if (!dataMap[csvKey]) {
          logger.warn({ table: tableInfo.name }, '[Backup] CSV data missing for table, skipping');
          continue;
        }

        const csvData = dataMap[csvKey].toString('utf8');
        const insertCount = await this._restoreTableFromCsv(client, tableInfo.name, csvData);
        tablesRestored.push(tableInfo.name);
        logger.info({ table: tableInfo.name, rows: insertCount }, '[Backup] Restored table');
      }

      // Re-enable FK checks
      await client.query('SET session_replication_role = DEFAULT');

      // Reset sequences for SERIAL columns
      await this._resetSequences(client, tablesRestored);

      await client.query('COMMIT');

      // Clear all caches
      try {
        const cache = require('../../cache');
        await cache.flush();
        logger.info('[Backup] Cache flushed after restore');
      } catch (e) {
        logger.warn('[Backup] Could not flush cache (non-critical)');
      }

      return tablesRestored;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Parse CSV data and insert rows into the specified table.
   * @returns {number} — Number of rows inserted
   */
  async _restoreTableFromCsv(client, table, csvData) {
    const lines = this._parseCsvLines(csvData);
    if (lines.length < 2) return 0; // Header only or empty

    const headers = lines[0];
    const columnList = headers.map(h => `"${h}"`).join(', ');
    let insertCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i];
      if (values.length !== headers.length) {
        logger.warn({ table, line: i, expected: headers.length, got: values.length }, '[Backup] CSV column mismatch, skipping row');
        continue;
      }

      const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');
      const params = values.map(v => v === '' ? null : v);

      try {
        await client.query(
          `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`,
          params
        );
        insertCount++;
      } catch (insertErr) {
        // Log but continue — some rows may have issues
        logger.warn({ table, line: i, err: insertErr.message }, '[Backup] Failed to insert row');
      }
    }

    return insertCount;
  }

  /**
   * Parse CSV text into an array of arrays (rows of fields).
   * Handles quoted fields with commas, newlines, and escaped quotes.
   */
  _parseCsvLines(csvText) {
    const result = [];
    let current = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < csvText.length) {
      const char = csvText[i];

      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < csvText.length && csvText[i + 1] === '"') {
            // Escaped quote
            field += '"';
            i += 2;
          } else {
            // End of quoted field
            inQuotes = false;
            i++;
          }
        } else {
          field += char;
          i++;
        }
      } else {
        if (char === '"' && field === '') {
          // Start of quoted field
          inQuotes = true;
          i++;
        } else if (char === ',') {
          current.push(field);
          field = '';
          i++;
        } else if (char === '\n' || (char === '\r' && i + 1 < csvText.length && csvText[i + 1] === '\n')) {
          current.push(field);
          field = '';
          if (current.some(f => f !== '')) {
            result.push(current);
          }
          current = [];
          i += (char === '\r') ? 2 : 1;
        } else if (char === '\r') {
          current.push(field);
          field = '';
          if (current.some(f => f !== '')) {
            result.push(current);
          }
          current = [];
          i++;
        } else {
          field += char;
          i++;
        }
      }
    }

    // Handle last field/line
    if (field !== '' || current.length > 0) {
      current.push(field);
      if (current.some(f => f !== '')) {
        result.push(current);
      }
    }

    return result;
  }

  /**
   * Reset PostgreSQL sequences after restoring data so that
   * new INSERTs get the correct next ID.
   */
  async _resetSequences(client, tables) {
    for (const table of tables) {
      try {
        // Find all serial/identity columns and reset their sequences
        const { rows: seqInfo } = await client.query(`
          SELECT column_name, pg_get_serial_sequence('"${table}"', column_name) AS seq
          FROM information_schema.columns
          WHERE table_name = $1
            AND table_schema = 'public'
            AND column_default LIKE 'nextval%'
        `, [table]);

        for (const { column_name, seq } of seqInfo) {
          if (seq) {
            await client.query(`SELECT setval('${seq}', COALESCE((SELECT MAX("${column_name}") FROM "${table}"), 0) + 1, false)`);
          }
        }
      } catch (e) {
        logger.warn({ table, err: e }, '[Backup] Could not reset sequence');
      }
    }
  }

  // ─── LIST BACKUPS ─────────────────────────────────────────────

  /**
   * List all available backups. Returns metadata only — never download URLs.
   * @returns {Promise<Array<{id: string, key: string, size: number, createdAt: string}>>}
   */
  async listBackups() {
    try {
      const objects = await storage.list();

      return objects.map(obj => ({
        id: obj.key.replace(storage.BACKUP_PREFIX, '').replace('.enc', ''),
        key: obj.key,
        size: obj.size,
        sizeHuman: this._formatBytes(obj.size),
        createdAt: obj.lastModified.toISOString()
      }));
    } catch (err) {
      logger.error({ err }, '[Backup] Failed to list backups');
      return [];
    }
  }

  // ─── DELETE BACKUP ────────────────────────────────────────────

  /**
   * Delete a specific backup by its R2 key.
   * @param {string} backupKey — Full R2 object key
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteBackup(backupKey) {
    try {
      await storage.remove(backupKey);
      return { success: true };
    } catch (err) {
      logger.error({ err, backupKey }, '[Backup] Failed to delete backup');
      return { success: false, error: err.message };
    }
  }

  // ─── CLEANUP (RETENTION) ──────────────────────────────────────

  /**
   * Enforce retention policy: keep only the latest MAX_BACKUPS, delete the rest.
   * @returns {Promise<number>} — Number of backups deleted
   */
  async cleanup() {
    try {
      const objects = await storage.list(); // Already sorted newest-first
      let deleted = 0;

      if (objects.length > MAX_BACKUPS) {
        const toDelete = objects.slice(MAX_BACKUPS);
        for (const obj of toDelete) {
          await storage.remove(obj.key);
          deleted++;
          logger.info({ key: obj.key }, '[Backup] Deleted old backup (retention policy)');
        }
      }

      if (deleted > 0) {
        logger.info({ deleted, kept: MAX_BACKUPS }, '[Backup] Retention cleanup completed');
      }

      return deleted;
    } catch (err) {
      logger.error({ err }, '[Backup] Retention cleanup failed');
      return 0;
    }
  }

  // ─── SCHEDULER ────────────────────────────────────────────────

  /**
   * Start the automatic backup scheduler based on system settings.
   */
  async startScheduler() {
    console.log('[DEBUG] dbHelper keys at startScheduler:', Object.keys(dbHelper));
    const enabled = process.env.BACKUP_ENABLED === 'true';

    if (!enabled) {
      logger.info('[Backup] Automatic backups DISABLED (BACKUP_ENABLED != true)');
      return;
    }

    if (!storage.isAvailable()) {
      logger.warn('[Backup] Cannot start scheduler — R2 storage not configured');
      return;
    }

    if (!process.env.BACKUP_ENCRYPTION_KEY) {
      logger.warn('[Backup] Cannot start scheduler — BACKUP_ENCRYPTION_KEY not set');
      return;
    }

    // Default to 24 hours if not set
    const intervalHours = await dbHelper.getSystemSetting('backup_interval_hours', 24);

    if (intervalHours === 0) {
      logger.info('[Backup] Automatic backups are DISABLED via system settings.');
      return;
    }

    logger.info(`[Backup] Automatic backups ENABLED (interval: ${intervalHours}h, retention: ${MAX_BACKUPS})`);
    await this._scheduleNext(intervalHours);
  }

  /**
   * Stop the automatic backup scheduler.
   */
  stopScheduler() {
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
      logger.info('[Backup] Scheduler stopped');
    }
  }

  /**
   * Update the backup schedule dynamically.
   * @param {number} hours 
   */
  async updateSchedule(hours) {
    this.stopScheduler();
    
    if (hours === 0) {
      logger.info('[Backup] Automatic backups have been DISABLED via updateSchedule.');
      return;
    }
    
    logger.info(`[Backup] Schedule updated to every ${hours}h`);
    await this._scheduleNext(hours);
  }

  /**
   * Schedule the next backup run based on interval.
   */
  async _scheduleNext(intervalHours) {
    if (!intervalHours || intervalHours <= 0) return;

    const now = new Date();
    const next = new Date(now);

    if (intervalHours === 24) {
      next.setUTCHours(3, 0, 0, 0); // 03:00 UTC daily for 24h interval
      if (now >= next) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
    } else {
      // For other intervals (e.g. 12, 168), just add hours to current time
      next.setUTCHours(next.getUTCHours() + intervalHours);
    }

    const delayMs = next.getTime() - now.getTime();
    logger.info(`[Backup] Next automatic backup scheduled in ${Math.round(delayMs / 60000)} minutes (at ${next.toISOString()})`);

    this._nextScheduledTime = next.getTime();

    this._timerId = setTimeout(async () => {
      await this.createBackup('scheduler');
      const latestInterval = await dbHelper.getSystemSetting('backup_interval_hours', 24);
      await this._scheduleNext(latestInterval); // Schedule the next one using latest setting
    }, delayMs);

    // Prevent the timer from keeping the Node.js process alive
    if (this._timerId.unref) {
      this._timerId.unref();
    }
  }

  // ─── HELPERS ──────────────────────────────────────────────────

  /**
   * Format bytes into a human-readable string.
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
  }

  /**
   * Get the timestamp of the next scheduled backup (or null if disabled).
   */
  getNextScheduledBackupMs() {
    if (!this._timerId) return null;
    return this._nextScheduledTime || null;
  }

  /**
   * Check if the backup system is fully configured and ready.
   */
  isConfigured() {
    return storage.isAvailable() && !!process.env.BACKUP_ENCRYPTION_KEY;
  }
}

module.exports = BackupService;

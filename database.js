const { Pool } = require('pg');
const logger = require('./logger');
const cache = require('./cache');
const bcrypt = require('bcryptjs');

// Create a connection pool using the DATABASE_URL environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

// Initialization state
let initPromise = null;
const initStatus = {
  coreOk: false,
  optionalFailed: false
};

/**
 * Helper to execute a query.
 */
async function runQuery(text, params = []) {
  return await pool.query(text, params);
}

/**
 * Initialize the PostgreSQL database schema.
 */

/**
 * Retry-safe query execution for Neon DB transient errors.
 */
async function safeInitQuery(queryText, params = [], { retries = 5, delay = 500, optional = false } = {}) {
  let attempt = 0;
  let currentDelay = delay;
  while (attempt <= retries) {
    if (attempt > 0) {
      logger.info(`[DB INIT] Attempt ${attempt}/${retries}`);
    }
    try {
      const queryObj = {
        text: queryText,
        values: params,
        query_timeout: 15000
      };
      const res = await pool.query(queryObj);
      return res;
    } catch (err) {
      const isTransient = 
        (err.code === 'XX000' && err.message && err.message.includes('Control plane')) || 
        err.code === 'ECONNRESET' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ENOTFOUND' ||
        err.code === '57P03' ||
        err.code === '53300' ||
        (err.message && (
          err.message.includes('ECONNRESET') ||
          err.message.includes('ECONNREFUSED') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('ENOTFOUND')
        ));
      
      if (!isTransient || attempt === retries) {
        if (optional) {
          logger.warn({ err }, `[DB INIT] Optional table skipped after retries.`);
          initStatus.optionalFailed = true;
          return null;
        }
        logger.error({ err }, `[DB INIT] Fatal database initialization failure after ${attempt} retries: ${queryText.substring(0, 50)}...`);
        throw err;
      }

      attempt++;
      const jitter = Math.floor(Math.random() * 300); // 0-300ms jitter
      const waitTime = currentDelay + jitter;
      logger.info(`[DB INIT] Waiting ${waitTime}ms...`);
      await new Promise(r => setTimeout(r, waitTime));
      currentDelay *= 2; // Exponential backoff (0.5s -> 1s -> 2s -> 4s -> 8s)
    }
  }
}

async function initDb() {
  if (!initPromise) {
    initPromise = _initDb();
  }
  return initPromise;
}

async function _initDb() {
  logger.info('[DB INIT] Initializing PostgreSQL database...');

  // Health check
  await safeInitQuery('SELECT 1', [], { optional: false });

  // 1. Create faculties table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS faculties (
      id SERIAL PRIMARY KEY,
      name_en TEXT NOT NULL,
      name_ar TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      telegram_token TEXT,
      admin_chat_id TEXT,
      welcome_en TEXT,
      welcome_ar TEXT,
      bot_enabled INTEGER DEFAULT 0,
      disabled_message_en TEXT,
      disabled_message_ar TEXT,
      telegram_api_server TEXT DEFAULT 'api.telegram.org',
      empty_msg_en TEXT,
      empty_msg_ar TEXT,
      unknown_msg_en TEXT,
      unknown_msg_ar TEXT,
      no_file_msg_en TEXT,
      no_file_msg_ar TEXT,
      notify_new_user BOOLEAN DEFAULT false,
      disabled_button_text TEXT,
      disabled_button_url TEXT,
      welcome_button_text TEXT,
      welcome_button_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  try {
    await safeInitQuery(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS notify_new_user BOOLEAN DEFAULT false;`);
    await safeInitQuery(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS disabled_button_text TEXT;`);
    await safeInitQuery(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS disabled_button_url TEXT;`);
    await safeInitQuery(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS welcome_button_text TEXT;`);
    await safeInitQuery(`ALTER TABLE faculties ADD COLUMN IF NOT EXISTS welcome_button_url TEXT;`);
  } catch (e) {
    console.log('Error adding columns to faculties:', e.message);
  }

  // 2. Create menus table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS menus (
      id SERIAL PRIMARY KEY,
      faculty_id INTEGER NOT NULL,
      parent_id INTEGER,
      title_en TEXT NOT NULL,
      title_ar TEXT NOT NULL,
      reply_type TEXT NOT NULL CHECK (reply_type IN ('text', 'file', 'submenu')),
      reply_content_en TEXT,
      reply_content_ar TEXT,
      file_name TEXT,
      file_path TEXT,
      telegram_file_id TEXT,
      mime_type TEXT,
      file_size INTEGER,
      sort_order INTEGER DEFAULT 0,
      row_index INTEGER DEFAULT 0,
      inline_buttons TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (faculty_id) REFERENCES faculties (id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES menus (id) ON DELETE CASCADE
    )
  `);

  // 3. Create announcements table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      faculty_id INTEGER NOT NULL,
      title_en TEXT NOT NULL,
      title_ar TEXT NOT NULL,
      content_en TEXT NOT NULL,
      content_ar TEXT NOT NULL,
      file_name TEXT,
      file_path TEXT,
      telegram_file_id TEXT,
      mime_type TEXT,
      file_size INTEGER,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (faculty_id) REFERENCES faculties (id) ON DELETE CASCADE
    )
  `);

  // 4. Create bot_users table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id SERIAL PRIMARY KEY,
      faculty_id INTEGER NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('telegram', 'web')),
      chat_id TEXT NOT NULL,
      username TEXT,
      language TEXT DEFAULT 'en' CHECK (language IN ('en', 'ar')),
      current_menu_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(faculty_id, platform, chat_id),
      FOREIGN KEY (faculty_id) REFERENCES faculties (id) ON DELETE CASCADE
    )
  `);

  // 5. Create admin_states table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS admin_states (
      chat_id TEXT PRIMARY KEY,
      state JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 6. Create admin_users table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'SUPER_ADMIN',
      is_active BOOLEAN DEFAULT true,
      is_deputy_owner BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safeInitQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_deputy_owner 
    ON admin_users ((is_deputy_owner)) 
    WHERE is_deputy_owner = TRUE
  `);

  await safeInitQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_owner 
    ON admin_users (role) 
    WHERE role = 'OWNER'
  `);

  // 7. Create admin_sessions table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 8. Create admin_audit_log table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      ip_address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 9. Create system_settings table
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Idempotent migrations for new features
  await safeInitQuery(`
    ALTER TABLE menus
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;
  `);

  await safeInitQuery(`
    ALTER TABLE faculties
    ADD COLUMN IF NOT EXISTS forward_user_messages BOOLEAN DEFAULT false;
  `);

  // Keep the `bot_users_log` from earlier migrations if it exists
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS bot_users_log (
      id SERIAL PRIMARY KEY,
      faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
      platform TEXT,
      chat_id TEXT,
      operation TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Phase B: Multi-File Support
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS menu_files (
      id SERIAL PRIMARY KEY,
      menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
      telegram_file_id TEXT NOT NULL,
      file_name TEXT,
      mime_type TEXT,
      file_size INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS announcement_messages (
      id SERIAL PRIMARY KEY,
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Idempotent Migration: Move existing single files from menus to menu_files
  await safeInitQuery(`
    INSERT INTO menu_files (menu_id, telegram_file_id, file_name, mime_type, file_size, sort_order)
    SELECT id, telegram_file_id, file_name, mime_type, file_size, 0
    FROM menus
    WHERE telegram_file_id IS NOT NULL 
      AND telegram_file_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM menu_files WHERE menu_files.menu_id = menus.id AND menu_files.telegram_file_id = menus.telegram_file_id
      )
  `);

  // Ensure telegram_file_id column exists just in case it was dropped (backward compatibility)
  await safeInitQuery(
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`
  );
  await safeInitQuery(
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`
  );

  // Phase: Telegram Bot Roles
  await safeInitQuery(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'SUB_ADMIN',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(faculty_id, chat_id)
    )
  `);

  // Automatic Migration from faculties.admin_chat_id
  try {
    const { rows: facultiesToMigrate } = await safeInitQuery('SELECT id, admin_chat_id FROM faculties WHERE admin_chat_id IS NOT NULL AND admin_chat_id != $1', ['']);
    for (const f of facultiesToMigrate) {
      if (f.admin_chat_id) {
        const adminIds = f.admin_chat_id.split(',').map(s => s.trim()).filter(s => s);
        for (let i = 0; i < adminIds.length; i++) {
          const role = i === 0 ? 'OWNER' : 'SUB_ADMIN';
          await safeInitQuery(`
            INSERT INTO admins (faculty_id, chat_id, role)
            VALUES ($1, $2, $3)
            ON CONFLICT (faculty_id, chat_id) DO NOTHING
          `, [f.id, adminIds[i], role]);
        }
      }
    }
  } catch (e) {
    logger.error(`[DB] Error during admins table migration: ${e.message}`);
  }

  // Handle column migrations (PostgreSQL native approach)
  const alterQueries = [
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_deputy_owner BOOLEAN NOT NULL DEFAULT FALSE;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS row_index INTEGER DEFAULT 0;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS inline_buttons TEXT;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS mime_type TEXT;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS file_size INTEGER;`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS mime_type TEXT;`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS file_size INTEGER;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS bot_enabled INTEGER DEFAULT 0;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS disabled_message_en TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS disabled_message_ar TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS telegram_api_server TEXT DEFAULT 'api.telegram.org';`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS empty_msg_en TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS empty_msg_ar TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS unknown_msg_en TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS unknown_msg_ar TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS no_file_msg_en TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS no_file_msg_ar TEXT;`,
    `ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW();`,
    `ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0;`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS monitoring_enabled BOOLEAN DEFAULT false;`
  ];

  for (const q of alterQueries) {
    await safeInitQuery(q).catch(e => logger.warn(`[DB Migration] Note: ${e.message}`));
  }

  // Seed data if empty
  await seedData();
  await seedAdminData();

  initStatus.coreOk = true;

  logger.info(`[DB INIT] Core tables: ${initStatus.coreOk ? 'OK' : 'FAILED'}`);
  logger.info(`[DB INIT] Optional tables: ${initStatus.optionalFailed ? 'PARTIAL' : 'OK'}`);
  logger.info(`[DB INIT] Startup completed successfully`);
}

async function seedData() {
  const { rows } = await safeInitQuery('SELECT COUNT(*) as count FROM faculties');
  if (parseInt(rows[0].count) > 0) return;

  logger.info('[DB] Seeding initial data...');

  try {
    const { rows: facRows } = await safeInitQuery(`
      INSERT INTO faculties (name_en, name_ar, slug, telegram_token) 
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `, ['Faculty of Medicine', 'كلية الطب البشري', 'fom', '']);
    
    if (facRows.length === 0) return; // Already seeded by another instance
    
    const facId = facRows[0].id;

    const { rows: menuRows1 } = await safeInitQuery(`
      INSERT INTO menus (faculty_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [facId, 'About Faculty', 'عن الكلية', 'text', 'The Faculty of Medicine was established to provide top-tier medical education.', 'تأسست كلية الطب البشري لتقديم تعليم طبي على أعلى مستوى.']);

    const { rows: menuRows2 } = await safeInitQuery(`
      INSERT INTO menus (faculty_id, title_en, title_ar, reply_type)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [facId, 'Departments', 'الأقسام', 'submenu']);
    const deptId = menuRows2[0].id;

    await safeInitQuery(`
      INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [facId, deptId, 'Surgery', 'الجراحة', 'text', 'Surgery department handles all surgical specialties.', 'قسم الجراحة يختص بكافة التخصصات الجراحية.']);

    await safeInitQuery(`
      INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [facId, deptId, 'Internal Medicine', 'الطب الباطني', 'text', 'Internal Medicine covers adult diseases.', 'قسم الباطنية يعنى بأمراض البالغين.']);
  } catch (err) {
    logger.error({ err }, '[DB] Seeding race condition averted or error');
  }
}

async function seedAdminData() {
  try {
    // 1. Promote INITIAL_ADMIN_USERNAME to OWNER if they are still SUPER_ADMIN
    if (process.env.INITIAL_ADMIN_USERNAME) {
      const { rowCount } = await safeInitQuery(`
        UPDATE admin_users SET role = 'OWNER' 
        WHERE username = $1 AND role = 'SUPER_ADMIN' 
        AND NOT EXISTS (SELECT 1 FROM admin_users WHERE role = 'OWNER')
      `, [process.env.INITIAL_ADMIN_USERNAME]);
      if (rowCount > 0) logger.info('[DB] Promoted initial admin to OWNER.');
    }

    // 2. Check if an OWNER exists
    const { rows: ownerRows } = await safeInitQuery("SELECT COUNT(*) as count FROM admin_users WHERE role = 'OWNER'");
    if (parseInt(ownerRows[0].count) > 0) return;

    if (process.env.INITIAL_ADMIN_USERNAME && process.env.INITIAL_ADMIN_PASSWORD) {
      logger.info('[DB] Seeding initial OWNER...');
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(process.env.INITIAL_ADMIN_PASSWORD, salt);
      await safeInitQuery(`
        INSERT INTO admin_users (username, password_hash, role) 
        VALUES ($1, $2, 'OWNER')
        ON CONFLICT DO NOTHING
      `, [process.env.INITIAL_ADMIN_USERNAME, hash]);
      logger.info('[DB] Initial OWNER created successfully.');
    } else {
      logger.warn('[DB] No INITIAL_ADMIN_USERNAME provided. Dashboard authentication will be unavailable until seeded.');
    }
  } catch (err) {
    logger.error({ err }, '[DB] Error seeding initial admin data');
  }
}

// ── CRUD Helpers ──────────────────────────────────────────────

async function getFaculties() {
  const cacheKey = 'faculties:all';
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query('SELECT * FROM faculties ORDER BY name_en');
  await cache.set(cacheKey, rows);
  return rows;
}

async function getFacultyById(id) {
  const cacheKey = `faculty:id:${id}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query('SELECT * FROM faculties WHERE id = $1', [id]);
  if (rows[0]) await cache.set(cacheKey, rows[0]);
  return rows[0];
}

async function getFacultyBySlug(slug) {
  const cacheKey = `faculty:slug:${slug}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query('SELECT * FROM faculties WHERE slug = $1', [slug]);
  if (rows[0]) await cache.set(cacheKey, rows[0]);
  return rows[0];
}

async function createFaculty(nameEn, nameAr, slug) {
  const { rows } = await pool.query(`
    INSERT INTO faculties (name_en, name_ar, slug) 
    VALUES ($1, $2, $3) RETURNING id
  `, [nameEn, nameAr, slug]);
  
  await cache.del('faculties:all');
  return rows[0].id;
}

async function updateFaculty(id, nameEn, nameAr, slug, token, adminChat, welcomeEn, welcomeAr, botEnabled, disabledEn, disabledAr, apiServer, emptyEn, emptyAr, unknownEn, unknownAr, noFileEn, noFileAr, notifyNewUser, disabledBtnText, disabledBtnUrl, welcomeBtnText, welcomeBtnUrl) {
  await pool.query(`
    UPDATE faculties 
    SET name_en = $1, name_ar = $2, slug = $3, telegram_token = $4, admin_chat_id = $5,
        welcome_en = $6, welcome_ar = $7, bot_enabled = $8, disabled_message_en = $9, 
        disabled_message_ar = $10, telegram_api_server = $11, empty_msg_en = $12, empty_msg_ar = $13,
        unknown_msg_en = $14, unknown_msg_ar = $15, no_file_msg_en = $16, no_file_msg_ar = $17,
        notify_new_user = $18, disabled_button_text = $19, disabled_button_url = $20,
        welcome_button_text = $21, welcome_button_url = $22
    WHERE id = $23
  `, [nameEn, nameAr, slug, token, adminChat, welcomeEn, welcomeAr, botEnabled, disabledEn, disabledAr, apiServer, emptyEn, emptyAr, unknownEn, unknownAr, noFileEn, noFileAr, notifyNewUser, disabledBtnText, disabledBtnUrl, welcomeBtnText, welcomeBtnUrl, id]);
  
  await cache.del('faculties:all');
  await cache.del(`faculty:id:${id}`);
  await cache.del(`faculty:slug:${slug}`);
}

async function updateAdminChatId(facultyId, newAdminChatIds) {
  const fac = await getFacultyById(facultyId);
  if (!fac) return;
  await pool.query('UPDATE faculties SET admin_chat_id = $1 WHERE id = $2', [newAdminChatIds, facultyId]);
  await cache.del('faculties:all');
  await cache.del(`faculty:id:${facultyId}`);
  await cache.del(`faculty:slug:${fac.slug}`);
}

async function updateMonitoringEnabled(id, enabled) {
  await pool.query('UPDATE faculties SET monitoring_enabled = $1, forward_user_messages = $1 WHERE id = $2', [enabled, id]);
  await cache.del('faculties:all');
  await cache.del(`faculty:id:${id}`);
}

async function deleteFaculty(id) {
  const fac = await getFacultyById(id);
  if (fac) {
    await cache.del(`faculty:slug:${fac.slug}`);
  }
  await pool.query('DELETE FROM faculties WHERE id = $1', [id]);
  await cache.del('faculties:all');
  await cache.del(`faculty:id:${id}`);
}

async function getMenusByFaculty(facultyId) {
  const cacheKey = `menus:faculty:${facultyId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query('SELECT * FROM menus WHERE faculty_id = $1 ORDER BY sort_order ASC, id ASC', [facultyId]);
  await cache.set(cacheKey, rows);
  return rows;
}

async function getMenuById(id) {
  const cacheKey = `menu:id:${id}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const { rows } = await pool.query('SELECT * FROM menus WHERE id = $1', [id]);
  if (rows[0]) await cache.set(cacheKey, rows[0]);
  return rows[0];
}

async function createMenu(facultyId, parentId, titleEn, titleAr, replyType, contentEn, contentAr, fileName, telegramFileId, mimeType, fileSize, sortOrder, rowIndex) {
  const { rows } = await pool.query(`
    INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar, file_name, telegram_file_id, mime_type, file_size, sort_order, row_index)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id
  `, [facultyId, parentId || null, titleEn, titleAr, replyType, contentEn, contentAr, fileName, telegramFileId, mimeType, fileSize, sortOrder || 0, rowIndex || 0]);
  
  await cache.del(`menus:faculty:${facultyId}`);
  return rows[0].id;
}

async function updateMenu(id, parentId, titleEn, titleAr, replyType, contentEn, contentAr, fileName, telegramFileId, mimeType, fileSize, sortOrder, rowIndex, inlineButtons = undefined) {
  const existing = await getMenuById(id);
  if (inlineButtons !== undefined) {
    await pool.query(`
      UPDATE menus 
      SET parent_id = $1, title_en = $2, title_ar = $3, reply_type = $4, 
          reply_content_en = $5, reply_content_ar = $6, file_name = $7, telegram_file_id = $8, 
          mime_type = $9, file_size = $10, sort_order = $11, row_index = $12, inline_buttons = $13
      WHERE id = $14
    `, [parentId || null, titleEn, titleAr, replyType, contentEn, contentAr, fileName, telegramFileId, mimeType, fileSize, sortOrder || 0, rowIndex || 0, inlineButtons, id]);
  } else {
    await pool.query(`
      UPDATE menus 
      SET parent_id = $1, title_en = $2, title_ar = $3, reply_type = $4, 
          reply_content_en = $5, reply_content_ar = $6, file_name = $7, telegram_file_id = $8, 
          mime_type = $9, file_size = $10, sort_order = $11, row_index = $12
      WHERE id = $13
    `, [parentId || null, titleEn, titleAr, replyType, contentEn, contentAr, fileName, telegramFileId, mimeType, fileSize, sortOrder || 0, rowIndex || 0, id]);
  }

  if (existing) await cache.del(`menus:faculty:${existing.faculty_id}`);
  await cache.del(`menu:id:${id}`);
}

async function updateMenuFileId(id, fileId) {
  const existing = await getMenuById(id);
  await pool.query('UPDATE menus SET telegram_file_id = $1 WHERE id = $2', [fileId, id]);
  if (existing) await cache.del(`menus:faculty:${existing.faculty_id}`);
  await cache.del(`menu:id:${id}`);
}

async function deleteMenu(id) {
  const existing = await getMenuById(id);
  await pool.query('DELETE FROM menus WHERE id = $1', [id]);
  if (existing) await cache.del(`menus:faculty:${existing.faculty_id}`);
  await cache.del(`menu:id:${id}`);
}

async function getMenuFiles(menuId) {
  const { rows } = await pool.query('SELECT * FROM menu_files WHERE menu_id = $1 ORDER BY sort_order ASC, created_at ASC', [menuId]);
  return rows;
}

async function addMenuFile(menuId, telegramFileId, fileName, mimeType, fileSize) {
  const { rows: countRows } = await pool.query('SELECT count(*) as count FROM menu_files WHERE menu_id = $1', [menuId]);
  if (parseInt(countRows[0].count, 10) >= 40) {
    throw new Error('Maximum of 40 files allowed per menu button.');
  }

  const { rows } = await pool.query(`
    INSERT INTO menu_files (menu_id, telegram_file_id, file_name, mime_type, file_size)
    VALUES ($1, $2, $3, $4, $5) RETURNING id
  `, [menuId, telegramFileId, fileName, mimeType, fileSize]);
  
  // Update the legacy column for backward compatibility (stores the latest uploaded file)
  await pool.query('UPDATE menus SET telegram_file_id = $1, file_name = $2, mime_type = $3, file_size = $4 WHERE id = $5', [telegramFileId, fileName, mimeType, fileSize, menuId]);
  
  return rows[0].id;
}

async function deleteMenuFile(fileId) {
  const { rows: fileRows } = await pool.query('SELECT menu_id FROM menu_files WHERE id = $1', [fileId]);
  if (fileRows.length === 0) return;
  const menuId = fileRows[0].menu_id;

  await pool.query('DELETE FROM menu_files WHERE id = $1', [fileId]);

  // Sync backward compatible columns to the latest uploaded file or null
  const { rows: remaining } = await pool.query('SELECT * FROM menu_files WHERE menu_id = $1 ORDER BY id DESC LIMIT 1', [menuId]);
  if (remaining.length > 0) {
    const f = remaining[0];
    await pool.query('UPDATE menus SET telegram_file_id = $1, file_name = $2, mime_type = $3, file_size = $4 WHERE id = $5', [f.telegram_file_id, f.file_name, f.mime_type, f.file_size, menuId]);
  } else {
    await pool.query('UPDATE menus SET telegram_file_id = NULL, file_name = NULL, mime_type = NULL, file_size = NULL WHERE id = $1', [menuId]);
  }
}

async function getAnnouncementsByFaculty(facultyId) {
  const { rows } = await pool.query('SELECT * FROM announcements WHERE faculty_id = $1 ORDER BY sent_at DESC', [facultyId]);
  return rows; // Unlikely to need heavy caching for announcements list since it's only occasionally fetched by users/admins
}

async function createAnnouncement(facultyId, titleEn, titleAr, contentEn, contentAr, fileName, telegramFileId, mimeType, fileSize, isPinned = false) {
  const { rows } = await pool.query(`
    INSERT INTO announcements (faculty_id, title_en, title_ar, content_en, content_ar, file_name, telegram_file_id, mime_type, file_size, is_pinned)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
  `, [facultyId, titleEn, titleAr, contentEn, contentAr, fileName, telegramFileId, mimeType, fileSize, isPinned]);
  return rows[0].id;
}

async function addAnnouncementMessage(announcementId, chatId, messageId) {
  try {
    await pool.query('INSERT INTO announcement_messages (announcement_id, chat_id, message_id) VALUES ($1, $2, $3)', [announcementId, chatId, messageId]);
  } catch(e) {
    logger.warn('Failed to save announcement message ' + e.message);
  }
}

async function getAnnouncementMessages(announcementId) {
  const { rows } = await pool.query('SELECT chat_id, message_id FROM announcement_messages WHERE announcement_id = $1', [announcementId]);
  return rows;
}

async function getAnnouncementById(announcementId) {
  const { rows } = await pool.query('SELECT * FROM announcements WHERE id = $1', [announcementId]);
  return rows.length ? rows[0] : null;
}

async function updateAnnouncementContent(id, titleAr, titleEn, contentAr, contentEn) {
  await pool.query(
    'UPDATE announcements SET title_ar = $1, title_en = $2, content_ar = $3, content_en = $4 WHERE id = $5',
    [titleAr, titleEn, contentAr, contentEn, id]
  );
}

async function deleteAnnouncement(id) {
  await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
}

async function updateAnnouncementFileId(id, fileId) {
  await pool.query('UPDATE announcements SET telegram_file_id = $1 WHERE id = $2', [fileId, id]);
}

async function getBotUser(facultyId, platform, chatId) {
  // We can cache the user state very briefly or rely on fast PG lookups.
  // DB is fast enough for single user lookups usually, but we could cache it.
  const { rows } = await pool.query('SELECT * FROM bot_users WHERE faculty_id = $1 AND platform = $2 AND chat_id = $3', [facultyId, platform, chatId]);
  return rows[0];
}

async function upsertBotUser(facultyId, platform, chatId, username, language) {
  const existing = await pool.query('SELECT id FROM bot_users WHERE faculty_id = $1 AND platform = $2 AND chat_id = $3', [facultyId, platform, chatId]);
  const isNew = existing.rowCount === 0;

  const { rows } = await pool.query(`
    INSERT INTO bot_users (faculty_id, platform, chat_id, username, language)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (faculty_id, platform, chat_id) 
    DO UPDATE SET username = EXCLUDED.username, language = COALESCE(EXCLUDED.language, bot_users.language), last_active_at = NOW(), is_blocked = FALSE
    RETURNING *
  `, [facultyId, platform, chatId, username, language]);
  
  const result = rows[0];
  result.isNew = isNew;
  return result;
}

async function getBotUsersByFaculty(facultyId, platform = null) {
  if (platform) {
    const { rows } = await pool.query('SELECT * FROM bot_users WHERE faculty_id = $1 AND platform = $2 ORDER BY created_at DESC', [facultyId, platform]);
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM bot_users WHERE faculty_id = $1 ORDER BY created_at DESC', [facultyId]);
  return rows;
}

async function updateBotUserMenu(userId, currentMenuId) {
  await pool.query('UPDATE bot_users SET current_menu_id = $1 WHERE id = $2', [currentMenuId || null, userId]);
}

async function getAdminState(chatId) {
  const { rows } = await pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [chatId]);
  return rows[0] ? rows[0].state : null;
}

async function setAdminState(chatId, state, pushToHistory = false) {
  const currentState = await getAdminState(chatId) || {};
  let history = currentState.history_stack || [];

  if (state.action === 'admin_home') {
    history = [];
  } else if (pushToHistory) {
    const stateToSave = { ...currentState };
    delete stateToSave.history_stack;
    if (Object.keys(stateToSave).length > 0) {
      // Avoid pushing duplicate states sequentially
      const lastState = history.length > 0 ? history[history.length - 1] : null;
      if (!lastState || JSON.stringify(lastState) !== JSON.stringify(stateToSave)) {
         history.push(stateToSave);
      }
    }
  }

  state.history_stack = history;

  await pool.query(`
    INSERT INTO admin_states (chat_id, state, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (chat_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
  `, [chatId, JSON.stringify(state)]);
}

async function popAdminState(chatId) {
  const currentState = await getAdminState(chatId) || {};
  const history = currentState.history_stack || [];
  if (history.length > 0) {
    const prevState = history.pop();
    prevState.history_stack = history;
    await pool.query('UPDATE admin_states SET state = $1, updated_at = NOW() WHERE chat_id = $2', [JSON.stringify(prevState), chatId]);
    return prevState;
  }
  const homeState = { action: 'admin_home', history_stack: [] };
  await pool.query('UPDATE admin_states SET state = $1, updated_at = NOW() WHERE chat_id = $2', [JSON.stringify(homeState), chatId]);
  return homeState;
}

async function deleteAdminState(chatId) {
  await pool.query('DELETE FROM admin_states WHERE chat_id = $1', [chatId]);
}

async function getAdminByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
  return rows[0];
}

async function getAdminById(id) {
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [id]);
  return rows[0];
}

async function createAdmin(username, passwordHash, role) {
  const { rows } = await pool.query('INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id', [username, passwordHash, role]);
  return rows[0].id;
}

async function updateAdminPassword(id, passwordHash) {
  await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
}

async function toggleAdminStatus(id, active) {
  await pool.query('UPDATE admin_users SET is_active = $1 WHERE id = $2', [active, id]);
}

async function deleteAdmin(id) {
  await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
}

async function updateLastLogin(id) {
  await pool.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [id]);
}

async function getAllAdmins() {
  const { rows } = await pool.query('SELECT id, username, role, is_active, is_deputy_owner, last_login_at, created_at FROM admin_users ORDER BY created_at ASC');
  return rows;
}

// ==========================================
// TELEGRAM BOT ADMIN ROLE HELPERS
// ==========================================

async function getAdminRole(facultyId, chatId) {
  const { rows } = await pool.query('SELECT role FROM admins WHERE faculty_id = $1 AND chat_id = $2', [facultyId, chatId]);
  if (rows.length > 0) return rows[0].role;
  return null;
}

async function setAdminRole(facultyId, chatId, role) {
  await pool.query(`
    INSERT INTO admins (faculty_id, chat_id, role) 
    VALUES ($1, $2, $3) 
    ON CONFLICT (faculty_id, chat_id) DO UPDATE SET role = $3
  `, [facultyId, chatId, role]);
}

async function removeAdmin(facultyId, chatId) {
  await pool.query('DELETE FROM admins WHERE faculty_id = $1 AND chat_id = $2', [facultyId, chatId]);
}

async function getAdminsByFaculty(facultyId) {
  const { rows } = await pool.query('SELECT chat_id, role, created_at FROM admins WHERE faculty_id = $1 ORDER BY created_at ASC', [facultyId]);
  return rows;
}

async function hasPermission(chatId, facultyId, permission) {
  const role = await getAdminRole(facultyId, chatId);
  if (!role) return false;

  if (role === 'OWNER') return true;

  if (role === 'DEPUTY_ADMIN') {
    return ['MANAGE_FILES', 'MANAGE_FOLDERS', 'ANNOUNCEMENTS', 'MONITORING'].includes(permission);
  }

  if (role === 'SUB_ADMIN') {
    return ['MANAGE_FILES', 'MANAGE_FOLDERS'].includes(permission);
  }

  return false;
}

async function createSession(adminId, sessionHash, expiresAt) {
  await pool.query('INSERT INTO admin_sessions (admin_id, session_hash, expires_at) VALUES ($1, $2, $3)', [adminId, sessionHash, expiresAt]);
}

async function getSessionByHash(sessionHash) {
  const { rows } = await pool.query('SELECT * FROM admin_sessions WHERE session_hash = $1 AND expires_at > NOW()', [sessionHash]);
  return rows[0];
}

async function deleteSession(sessionHash) {
  await pool.query('DELETE FROM admin_sessions WHERE session_hash = $1', [sessionHash]);
}

async function deleteAllSessions(adminId) {
  await pool.query('DELETE FROM admin_sessions WHERE admin_id = $1', [adminId]);
}

async function cleanupExpiredSessions() {
  await pool.query('DELETE FROM admin_sessions WHERE expires_at < NOW()');
}

async function logAdminAction(adminId, action, entity, entityId, ipAddress) {
  await pool.query(
    'INSERT INTO admin_audit_log (admin_id, action, entity, entity_id, ip_address) VALUES ($1, $2, $3, $4, $5)', 
    [adminId, action, entity, entityId, ipAddress]
  );
}

async function assignDeputyOwner(newDeputyId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Clear old deputy owner
    await client.query('UPDATE admin_users SET is_deputy_owner = FALSE WHERE is_deputy_owner = TRUE');
    // Set new deputy owner if provided
    if (newDeputyId) {
      await client.query("UPDATE admin_users SET is_deputy_owner = TRUE WHERE id = $1 AND role = 'SUPER_ADMIN'", [newDeputyId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
async function toggleMenuStatus(menuId, field, value) {
  if (field !== 'is_active' && field !== 'is_hidden') throw new Error('Invalid field');
  await runQuery(`UPDATE menus SET ${field} = $1 WHERE id = $2`, [value, menuId]);
}

async function toggleFacultyForwarding(facultyId, value) {
  await runQuery(`UPDATE faculties SET forward_user_messages = $1, monitoring_enabled = $1 WHERE id = $2`, [value, facultyId]);
  await cache.del('faculties:all');
  await cache.del(`faculty:id:${facultyId}`);
}

async function updateUserActivity(facultyId, platform, chatId) {
  try {
    await pool.query(
      'UPDATE bot_users SET last_active_at = NOW(), is_blocked = FALSE WHERE faculty_id = $1 AND platform = $2 AND chat_id = $3',
      [facultyId, platform, chatId]
    );
  } catch (err) {
    logger.error('Error updating user activity', err);
  }
}

async function blockBotUser(facultyId, platform, chatId) {
  try {
    await pool.query(
      'UPDATE bot_users SET is_blocked = TRUE WHERE faculty_id = $1 AND platform = $2 AND chat_id = $3',
      [facultyId, platform, chatId]
    );
  } catch (err) {
    logger.error('Error blocking user', err);
  }
}

async function incrementMenuClickCount(menuId) {
  try {
    await pool.query('UPDATE menus SET click_count = click_count + 1 WHERE id = $1', [menuId]);
  } catch (err) {
    logger.error('Error incrementing menu click count', err);
  }
}

async function updateTranslationField(table, id, enColumn, translatedText) {
  const allowedTables = ['menus', 'faculties', 'announcements'];
  if (!allowedTables.includes(table)) {
    throw new Error('Invalid table for translation update');
  }
  
  // Safe column name validation (must match exactly the known english columns)
  const allowedColumns = [
    'title_en', 'reply_content_en', 'name_en', 'welcome_en', 'disabled_message_en',
    'empty_msg_en', 'unknown_msg_en', 'no_file_msg_en', 'content_en', 'inline_buttons'
  ];
  if (!allowedColumns.includes(enColumn)) {
    throw new Error('Invalid column for translation update');
  }

  try {
    await runQuery(`UPDATE ${table} SET ${enColumn} = $1 WHERE id = $2`, [translatedText, id]);
  } catch (err) {
    logger.error(`Error updating translation field ${enColumn} in ${table}`, err);
  }
}

// ---------------------------------------------------------------------------
// SYSTEM SETTINGS
// ---------------------------------------------------------------------------

async function getSystemSetting(key, defaultValue = null) {
  try {
    const { rows } = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    if (rows.length > 0) {
      return rows[0].value;
    }
    return defaultValue;
  } catch (err) {
    logger.error({ err, key }, 'Error getting system setting');
    return defaultValue;
  }
}

async function setSystemSetting(key, value) {
  try {
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) 
       VALUES ($1, $2, NOW()) 
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    return true;
  } catch (err) {
    logger.error({ err, key }, 'Error setting system setting');
    return false;
  }
}

module.exports = {
  pool,
  initStatus,
  runQuery,
  safeInitQuery,
  initDb,
  getSystemSetting,
  setSystemSetting,
  addAnnouncementMessage,
  getAnnouncementMessages,
  getAnnouncementById,
  updateAnnouncementContent,
  deleteAnnouncement,
  updateUserActivity,
  blockBotUser,
  incrementMenuClickCount,
  toggleMenuStatus,
  toggleFacultyForwarding,
  updateTranslationField,
  getFaculties,
  getFacultyById,
  getFacultyBySlug,
  createFaculty,
  updateFaculty,
  updateAdminChatId,
  updateMonitoringEnabled,
  deleteFaculty,
  getMenusByFaculty,
  getMenuById,
  createMenu,
  updateMenu,
  updateMenuFileId,
  deleteMenu,
  getMenuFiles,
  addMenuFile,
  deleteMenuFile,
  getAnnouncementsByFaculty,
  createAnnouncement,
  updateAnnouncementFileId,
  getBotUser,
  upsertBotUser,
  getBotUsersByFaculty,
  updateBotUserMenu,
  getAdminState,
  setAdminState,
  popAdminState,
  deleteAdminState,
  getAdminByUsername,
  getAdminById,
  createAdmin,
  updateAdminPassword,
  toggleAdminStatus,
  deleteAdmin,
  updateLastLogin,
  getAllAdmins,
  
  // Telegram Bot Admins
  getAdminRole,
  setAdminRole,
  removeAdmin,
  getAdminsByFaculty,
  hasPermission,

  createSession,
  getSessionByHash,
  deleteSession,
  deleteAllSessions,
  cleanupExpiredSessions,
  logAdminAction,
  assignDeputyOwner
};


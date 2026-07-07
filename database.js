const { Pool } = require('pg');
const logger = require('./logger');
const cache = require('./cache');

// Create a connection pool using the DATABASE_URL environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

/**
 * Helper to execute a query.
 */
async function runQuery(text, params = []) {
  return await pool.query(text, params);
}

/**
 * Initialize the PostgreSQL database schema.
 */
async function initDb() {
  logger.info('[DB] Initializing PostgreSQL database...');

  // 1. Create faculties table
  await pool.query(`
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 2. Create menus table
  await pool.query(`
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
      sort_order INTEGER DEFAULT 0,
      inline_buttons TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (faculty_id) REFERENCES faculties (id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES menus (id) ON DELETE CASCADE
    )
  `);

  // 3. Create announcements table
  await pool.query(`
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
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (faculty_id) REFERENCES faculties (id) ON DELETE CASCADE
    )
  `);

  // 4. Create bot_users table
  await pool.query(`
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_states (
      chat_id TEXT PRIMARY KEY,
      state JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Handle column migrations (PostgreSQL native approach)
  const alterQueries = [
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS inline_buttons TEXT;`,
    `ALTER TABLE menus ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS bot_enabled INTEGER DEFAULT 0;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS disabled_message_en TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS disabled_message_ar TEXT;`,
    `ALTER TABLE faculties ADD COLUMN IF NOT EXISTS telegram_api_server TEXT DEFAULT 'api.telegram.org';`
  ];

  for (const q of alterQueries) {
    await pool.query(q).catch(e => logger.warn(`[DB Migration] Note: ${e.message}`));
  }

  // Seed data if empty
  await seedData();

  logger.info('[DB] PostgreSQL initialization complete.');
}

async function seedData() {
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM faculties');
  if (parseInt(rows[0].count) > 0) return;

  logger.info('[DB] Seeding initial data...');

  try {
    const { rows: facRows } = await pool.query(`
      INSERT INTO faculties (name_en, name_ar, slug, telegram_token) 
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `, ['Faculty of Medicine', 'كلية الطب البشري', 'fom', '']);
    
    if (facRows.length === 0) return; // Already seeded by another instance
    
    const facId = facRows[0].id;

    const { rows: menuRows1 } = await pool.query(`
      INSERT INTO menus (faculty_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [facId, 'About Faculty', 'عن الكلية', 'text', 'The Faculty of Medicine was established to provide top-tier medical education.', 'تأسست كلية الطب البشري لتقديم تعليم طبي على أعلى مستوى.']);

    const { rows: menuRows2 } = await pool.query(`
      INSERT INTO menus (faculty_id, title_en, title_ar, reply_type)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [facId, 'Departments', 'الأقسام', 'submenu']);
    const deptId = menuRows2[0].id;

    await pool.query(`
      INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [facId, deptId, 'Surgery', 'الجراحة', 'text', 'Surgery department handles all surgical specialties.', 'قسم الجراحة يختص بكافة التخصصات الجراحية.']);

    await pool.query(`
      INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [facId, deptId, 'Internal Medicine', 'الطب الباطني', 'text', 'Internal Medicine covers adult diseases.', 'قسم الباطنية يعنى بأمراض البالغين.']);
  } catch (err) {
    logger.error({ err }, '[DB] Seeding race condition averted or error');
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

async function updateFaculty(id, nameEn, nameAr, slug, token, adminChat, welcomeEn, welcomeAr, botEnabled, disabledEn, disabledAr, apiServer) {
  await pool.query(`
    UPDATE faculties 
    SET name_en = $1, name_ar = $2, slug = $3, telegram_token = $4, admin_chat_id = $5,
        welcome_en = $6, welcome_ar = $7, bot_enabled = $8, disabled_message_en = $9, 
        disabled_message_ar = $10, telegram_api_server = $11
    WHERE id = $12
  `, [nameEn, nameAr, slug, token, adminChat, welcomeEn, welcomeAr, botEnabled, disabledEn, disabledAr, apiServer, id]);
  
  await cache.del('faculties:all');
  await cache.del(`faculty:id:${id}`);
  await cache.del(`faculty:slug:${slug}`);
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

async function createMenu(facultyId, parentId, titleEn, titleAr, replyType, contentEn, contentAr, fileName, filePath, sortOrder) {
  const { rows } = await pool.query(`
    INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar, file_name, file_path, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
  `, [facultyId, parentId || null, titleEn, titleAr, replyType, contentEn, contentAr, fileName, filePath, sortOrder || 0]);
  
  await cache.del(`menus:faculty:${facultyId}`);
  return rows[0].id;
}

async function updateMenu(id, parentId, titleEn, titleAr, replyType, contentEn, contentAr, fileName, filePath, sortOrder, inlineButtons = undefined) {
  const existing = await getMenuById(id);
  if (inlineButtons !== undefined) {
    await pool.query(`
      UPDATE menus 
      SET parent_id = $1, title_en = $2, title_ar = $3, reply_type = $4, 
          reply_content_en = $5, reply_content_ar = $6, file_name = $7, file_path = $8, 
          sort_order = $9, inline_buttons = $10
      WHERE id = $11
    `, [parentId || null, titleEn, titleAr, replyType, contentEn, contentAr, fileName, filePath, sortOrder || 0, inlineButtons, id]);
  } else {
    await pool.query(`
      UPDATE menus 
      SET parent_id = $1, title_en = $2, title_ar = $3, reply_type = $4, 
          reply_content_en = $5, reply_content_ar = $6, file_name = $7, file_path = $8, 
          sort_order = $9, telegram_file_id = NULL
      WHERE id = $10
    `, [parentId || null, titleEn, titleAr, replyType, contentEn, contentAr, fileName, filePath, sortOrder || 0, id]);
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

async function getAnnouncementsByFaculty(facultyId) {
  const { rows } = await pool.query('SELECT * FROM announcements WHERE faculty_id = $1 ORDER BY sent_at DESC', [facultyId]);
  return rows; // Unlikely to need heavy caching for announcements list since it's only occasionally fetched by users/admins
}

async function createAnnouncement(facultyId, titleEn, titleAr, contentEn, contentAr, fileName, filePath) {
  const { rows } = await pool.query(`
    INSERT INTO announcements (faculty_id, title_en, title_ar, content_en, content_ar, file_name, file_path)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [facultyId, titleEn, titleAr, contentEn, contentAr, fileName, filePath]);
  return rows[0].id;
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
  const { rows } = await pool.query(`
    INSERT INTO bot_users (faculty_id, platform, chat_id, username, language)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (faculty_id, platform, chat_id) 
    DO UPDATE SET username = EXCLUDED.username, language = EXCLUDED.language
    RETURNING *
  `, [facultyId, platform, chatId, username, language]);
  return rows[0];
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

async function setAdminState(chatId, state) {
  await pool.query(`
    INSERT INTO admin_states (chat_id, state, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (chat_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
  `, [chatId, JSON.stringify(state)]);
}

async function deleteAdminState(chatId) {
  await pool.query('DELETE FROM admin_states WHERE chat_id = $1', [chatId]);
}

module.exports = {
  pool,
  initDb,
  runQuery,
  getFaculties,
  getFacultyById,
  getFacultyBySlug,
  createFaculty,
  updateFaculty,
  deleteFaculty,
  getMenusByFaculty,
  getMenuById,
  createMenu,
  updateMenu,
  updateMenuFileId,
  deleteMenu,
  getAnnouncementsByFaculty,
  createAnnouncement,
  updateAnnouncementFileId,
  getBotUser,
  upsertBotUser,
  getBotUsersByFaculty,
  updateBotUserMenu,
  getAdminState,
  setAdminState,
  deleteAdminState
};

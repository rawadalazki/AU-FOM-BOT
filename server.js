const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const busboy = require('busboy');
const { createHttpTerminator } = require('http-terminator');

const logger = require('./logger');
const dbHelper = require('./database');
const botManager = require('./bot-manager');
const cache = require('./cache');
const rateLimiter = require('./rate-limiter');
const backup = require('./backup');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Async multipart parser that saves files to temp dir instead of S3.
 */
async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers });
    } catch (e) {
      return reject(new Error('Failed to initialize busboy: ' + e.message));
    }

    const fields = {};
    const files = {};
    const writePromises = [];

    bb.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      if (!filename) {
        file.resume();
        return;
      }
      
      const tmpPath = path.join(os.tmpdir(), `fombot_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${filename}`);
      const ws = fs.createWriteStream(tmpPath);
      let fileSize = 0;
      
      file.on('data', (chunk) => { fileSize += chunk.length; });
      
      const p = new Promise((res, rej) => {
        file.pipe(ws);
        ws.on('finish', () => {
          files[name] = { name: filename, tmpPath, mimeType: mimeType || 'application/octet-stream', size: fileSize };
          res();
        });
        ws.on('error', rej);
      });
      
      writePromises.push(p);
    });

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('close', async () => {
      try {
        await Promise.all(writePromises);
        resolve({ fields, files });
      } catch (e) {
        reject(e);
      }
    });

    bb.on('error', reject);
    req.pipe(bb);
  });
}

/** Helper to clean up temp files after upload */
function cleanupTempFile(tmpPath) {
  if (tmpPath) {
    fs.unlink(tmpPath, (err) => {
      if (err && err.code !== 'ENOENT') logger.warn({ err, tmpPath }, 'Failed to cleanup temp file');
    });
  }
}

let isShuttingDown = false;

const server = http.createServer(async (req, res) => {
  if (isShuttingDown) {
    res.writeHead(503);
    res.end('Service unavailable (shutting down)');
    return;
  }

  const reqId = crypto.randomUUID();
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  logger.info({ reqId, method, pathname }, 'Incoming request');

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Bot-Api-Secret-Token'
    });
    res.end();
    return;
  }

  // ── 0. Rate Limiting ───────────────────────────────────────────────────────
  // Apply rate limiting to all /api/ routes, EXCEPT verified webhooks
  if (pathname.startsWith('/api/')) {
    const webhookMatch = pathname.match(/^\/api\/telegram\/webhook\/(\d+)$/);
    let bypassRateLimit = false;

    if (webhookMatch && method === 'POST') {
      const facultyId = parseInt(webhookMatch[1], 10);
      const expectedSecret = botManager.getWebhookSecret(facultyId);
      const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (receivedSecret === expectedSecret) {
        bypassRateLimit = true; // Legit Telegram traffic
      }
    }

    if (!bypassRateLimit) {
      const allowed = await rateLimiter.rateLimit(req, res);
      if (!allowed) return; // Response is already handled (429)
    }
  }

  // ── 1. Health & Readiness Probes ───────────────────────────────────────────
  if (method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
  }

  if (method === 'GET' && pathname === '/ready') {
    try {
      await dbHelper.pool.query('SELECT 1');
      if (cache.isActive() && !(await cache.ping())) {
        return sendJson(res, 503, { status: 'error', component: 'redis' });
      }
      // Assuming S3 client initialized if storage module is loaded
      return sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error({ reqId, err }, 'Readiness probe failed');
      return sendJson(res, 503, { status: 'error', error: err.message });
    }
  }

  if (method === 'GET' && pathname === '/metrics') {
    // Placeholder for Prometheus metrics
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('# HELP fombot_requests_total Total number of HTTP requests\n# TYPE fombot_requests_total counter\nfombot_requests_total 0\n');
    return;
  }

  // ── 2. Telegram Webhook Endpoint ──────────────────────────────────────────────
  const webhookMatch = pathname.match(/^\/api\/telegram\/webhook\/(\d+)$/);
  if (method === 'POST' && webhookMatch) {
    const facultyId = parseInt(webhookMatch[1], 10);
    try {
      const expectedSecret = botManager.getWebhookSecret(facultyId);
      const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (receivedSecret !== expectedSecret) {
        logger.warn({ reqId, facultyId }, 'Invalid webhook secret token');
        return sendJson(res, 403, { error: 'Invalid secret token' });
      }
      
      const update = await parseJson(req);
      
      // Handle asynchronously — always return 200 to Telegram immediately
      botManager.handleWebhookUpdate(facultyId, update, reqId).catch(err => {
        logger.error({ reqId, facultyId, err }, `Webhook update error`);
      });
      
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      logger.error({ reqId, facultyId, err }, `Webhook parse error`);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── 3. File Proxy Endpoint (streams from Telegram) ──────────────────────────
  const fileProxyMenuMatch = pathname.match(/^\/api\/files\/menu\/(\d+)$/);
  if (method === 'GET' && fileProxyMenuMatch) {
    try {
      const menuId = parseInt(fileProxyMenuMatch[1], 10);
      const menu = await dbHelper.getMenuById(menuId);
      if (!menu || !menu.telegram_file_id) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }
      
      const stream = await botManager.getFileStreamFromTelegram(menu.faculty_id, reqId, menu.telegram_file_id);
      const contentType = menu.mime_type || 'application/octet-stream';
      
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Content-Disposition': `inline; filename="${menu.file_name || 'file'}"`
      });
      
      stream.pipe(res);
      return;
    } catch (err) {
      logger.warn({ reqId, pathname, err: err.message }, 'File proxy error');
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
  }

  const fileProxyAnnMatch = pathname.match(/^\/api\/files\/announcement\/(\d+)$/);
  if (method === 'GET' && fileProxyAnnMatch) {
    try {
      const annId = parseInt(fileProxyAnnMatch[1], 10);
      const { rows } = await dbHelper.runQuery('SELECT * FROM announcements WHERE id = $1', [annId]);
      const ann = rows[0];
      if (!ann || !ann.telegram_file_id) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }
      
      const stream = await botManager.getFileStreamFromTelegram(ann.faculty_id, reqId, ann.telegram_file_id);
      const contentType = ann.mime_type || 'application/octet-stream';
      
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Content-Disposition': `inline; filename="${ann.file_name || 'file'}"`
      });
      
      stream.pipe(res);
      return;
    } catch (err) {
      logger.warn({ reqId, pathname, err: err.message }, 'Announcement file proxy error');
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
  }

  // Legacy file proxy endpoint (backwards compat with old S3 keys)
  const fileMatch = pathname.match(/^\/api\/files\/(.+)$/);
  if (method === 'GET' && fileMatch) {
    // Old S3-based URLs are no longer supported
    res.writeHead(410, { 'Content-Type': 'text/plain' });
    res.end('This file endpoint has been migrated. Please use /api/files/menu/:id or /api/files/announcement/:id');
    return;
  }

  // ── API ROUTES ─────────────────────────────────────────────────────────────

  // --- Faculties API ---
  if (pathname === '/api/faculties') {
    if (method === 'GET') {
      const faculties = await dbHelper.getFaculties();
      // Inject bot status
      for (const fac of faculties) {
        const botStatus = await botManager.getBotStatus(fac.id);
        fac.bot_status = botStatus.status;
        if (botStatus.username) fac.bot_username = botStatus.username;
        if (botStatus.error) fac.bot_error = botStatus.error;
      }
      return sendJson(res, 200, faculties);
    } 
    else if (method === 'POST') {
      try {
        const data = await parseJson(req);
        if (!data.name_en || !data.name_ar || !data.slug) {
          return sendJson(res, 400, { error: 'Missing required fields' });
        }
        if (!/^[a-z0-9_-]+$/.test(data.slug)) {
          return sendJson(res, 400, { error: 'Invalid slug format' });
        }

        const existing = await dbHelper.getFacultyBySlug(data.slug);
        if (existing) {
          return sendJson(res, 400, { error: 'Slug already exists' });
        }

        const id = await dbHelper.createFaculty(data.name_en, data.name_ar, data.slug);
        return sendJson(res, 201, { id });
      } catch (e) {
        logger.error({ reqId, err: e }, 'POST /api/faculties error');
        return sendJson(res, 500, { error: e.message });
      }
    }
  }

  const facMatch = pathname.match(/^\/api\/faculties\/(\d+)$/);
  if (facMatch) {
    const id = parseInt(facMatch[1], 10);
    if (method === 'PUT') {
      try {
        const data = await parseJson(req);
        const fac = await dbHelper.getFacultyById(id);
        if (!fac) return sendJson(res, 404, { error: 'Faculty not found' });
        
        await dbHelper.updateFaculty(
          id, 
          data.name_en || fac.name_en,
          data.name_ar || fac.name_ar,
          data.slug || fac.slug,
          data.telegram_token !== undefined ? data.telegram_token : fac.telegram_token,
          data.admin_chat_id !== undefined ? data.admin_chat_id : fac.admin_chat_id,
          data.welcome_en !== undefined ? data.welcome_en : fac.welcome_en,
          data.welcome_ar !== undefined ? data.welcome_ar : fac.welcome_ar,
          data.bot_enabled !== undefined ? data.bot_enabled : fac.bot_enabled,
          data.disabled_message_en !== undefined ? data.disabled_message_en : fac.disabled_message_en,
          data.disabled_message_ar !== undefined ? data.disabled_message_ar : fac.disabled_message_ar,
          data.telegram_api_server !== undefined ? data.telegram_api_server : fac.telegram_api_server
        );

        // Manage bot lifecycle based on changes
        if (data.bot_enabled !== undefined || data.telegram_token !== undefined || data.telegram_api_server !== undefined) {
          const updatedFac = await dbHelper.getFacultyById(id);
          if (updatedFac.bot_enabled !== 0 && updatedFac.telegram_token) {
             await botManager.registerWebhookForFaculty(updatedFac, reqId).catch(e => logger.error({reqId, err: e}, 'Register webhook failed'));
          } else {
             await botManager.deleteWebhookForFaculty(updatedFac, reqId).catch(e => logger.error({reqId, err: e}, 'Delete webhook failed'));
          }
        }

        return sendJson(res, 200, { ok: true });
      } catch (e) {
        logger.error({ reqId, err: e }, 'PUT /api/faculties/:id error');
        return sendJson(res, 500, { error: e.message });
      }
    } else if (method === 'DELETE') {
      try {
        const fac = await dbHelper.getFacultyById(id);
        if (fac) {
          await botManager.deleteWebhookForFaculty(fac, reqId).catch(e => logger.error({reqId, err: e}, 'Delete webhook failed'));
          // No S3 cleanup needed — files are on Telegram
          await dbHelper.deleteFaculty(id);
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        logger.error({ reqId, err: e }, 'DELETE /api/faculties/:id error');
        return sendJson(res, 500, { error: e.message });
      }
    }
  }

  // --- Duplicate Faculty Route ---
  const dupMatch = pathname.match(/^\/api\/faculties\/(\d+)\/duplicate$/);
  if (dupMatch && method === 'POST') {
    const sourceId = parseInt(dupMatch[1], 10);
    try {
      const data = await parseJson(req);
      if (!data.name_en || !data.name_ar || !data.slug) {
        return sendJson(res, 400, { error: 'Missing required fields' });
      }

      const existing = await dbHelper.getFacultyBySlug(data.slug);
      if (existing) return sendJson(res, 400, { error: 'Slug already exists' });
      
      const sourceFac = await dbHelper.getFacultyById(sourceId);
      if (!sourceFac) return sendJson(res, 404, { error: 'Source faculty not found' });

      // Create new faculty (without tokens or users)
      const newFacId = await dbHelper.createFaculty(data.name_en, data.name_ar, data.slug);
      const newTelegramToken = data.telegram_token || '';
      const newAdminChatId = data.admin_chat_id || '';
      const newBotEnabled = data.bot_enabled !== undefined ? data.bot_enabled : 0;

      await dbHelper.updateFaculty(
        newFacId, data.name_en, data.name_ar, data.slug,
        newTelegramToken, newAdminChatId, sourceFac.welcome_en, sourceFac.welcome_ar, 
        newBotEnabled, sourceFac.disabled_message_en, sourceFac.disabled_message_ar, sourceFac.telegram_api_server
      );

      // If new bot is enabled and token provided, register its webhook
      if (newBotEnabled && newTelegramToken) {
         const newFac = await dbHelper.getFacultyById(newFacId);
         await botManager.registerWebhookForFaculty(newFac, reqId).catch(e => logger.error({reqId, err: e}, 'Register webhook failed during duplicate'));
      }

      // Helper function to auto-migrate files if target bot token is available
      async function migrateFile(sourceFileId, fileName, mimeType) {
        if (!sourceFileId) return null;
        if (!newTelegramToken || !newAdminChatId) return null; // Cannot copy between different bots if no target token
        
        try {
          const stream = await botManager.getFileStreamFromTelegram(sourceId, reqId, sourceFileId);
          const tmpPath = path.join(os.tmpdir(), `dup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`);
          const ws = fs.createWriteStream(tmpPath);
          await new Promise((resolve, reject) => {
            stream.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
          });
          
          const tgResult = await botManager.uploadFileToTelegram(newFacId, reqId, tmpPath, fileName, mimeType);
          cleanupTempFile(tmpPath);
          
          return tgResult.telegram_file_id;
        } catch (e) {
          logger.error({ reqId, err: e, sourceFileId }, 'Failed to auto-migrate file during duplication');
          return null;
        }
      }

      // Duplicate Menus mapping
      const sourceMenus = await dbHelper.getMenusByFaculty(sourceId);
      const menuIdMap = new Map(); // sourceId -> newId

      // Level 1: Roots
      for (const sm of sourceMenus.filter(m => m.parent_id === null)) {
        const newFileId = await migrateFile(sm.telegram_file_id, sm.file_name, sm.mime_type);
        const { rows } = await dbHelper.runQuery(`
          INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar, file_name, telegram_file_id, mime_type, file_size, sort_order, inline_buttons)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id
        `, [newFacId, null, sm.title_en, sm.title_ar, sm.reply_type, sm.reply_content_en, sm.reply_content_ar, sm.file_name, newFileId, sm.mime_type, sm.file_size, sm.sort_order, sm.inline_buttons]);
        
        menuIdMap.set(sm.id, rows[0].id);
      }

      // Level 2, 3, etc.
      let keepProcessing = true;
      while(keepProcessing) {
        keepProcessing = false;
        for (const sm of sourceMenus) {
          if (sm.parent_id !== null && menuIdMap.has(sm.parent_id) && !menuIdMap.has(sm.id)) {
            const newFileId = await migrateFile(sm.telegram_file_id, sm.file_name, sm.mime_type);
            const { rows } = await dbHelper.runQuery(`
              INSERT INTO menus (faculty_id, parent_id, title_en, title_ar, reply_type, reply_content_en, reply_content_ar, file_name, telegram_file_id, mime_type, file_size, sort_order, inline_buttons)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id
            `, [newFacId, menuIdMap.get(sm.parent_id), sm.title_en, sm.title_ar, sm.reply_type, sm.reply_content_en, sm.reply_content_ar, sm.file_name, newFileId, sm.mime_type, sm.file_size, sm.sort_order, sm.inline_buttons]);
            
            menuIdMap.set(sm.id, rows[0].id);
            keepProcessing = true;
          }
        }
      }

      // Duplicate Announcements
      const sourceAnns = await dbHelper.getAnnouncementsByFaculty(sourceId);
      for (const sa of sourceAnns) {
        const newFileId = await migrateFile(sa.telegram_file_id, sa.file_name, sa.mime_type);
        await dbHelper.createAnnouncement(newFacId, sa.title_en, sa.title_ar, sa.content_en, sa.content_ar, sa.file_name, newFileId, sa.mime_type, sa.file_size);
      }

      return sendJson(res, 201, { id: newFacId });
    } catch (e) {
      logger.error({ reqId, err: e }, 'Duplicate faculty error');
      return sendJson(res, 500, { error: e.message });
    }
  }

  // --- Menus API ---
  if (pathname === '/api/menus') {
    if (method === 'GET') {
      const facId = parsedUrl.searchParams.get('faculty_id');
      if (!facId) return sendJson(res, 400, { error: 'Missing faculty_id' });
      const menus = await dbHelper.getMenusByFaculty(facId);
      const enhancedMenus = menus.map(m => ({
        ...m,
        file_url: m.telegram_file_id ? `/api/files/menu/${m.id}` : null
      }));
      return sendJson(res, 200, enhancedMenus);
    }
    else if (method === 'POST') {
      const tmpFiles = [];
      try {
        const { fields, files } = await parseMultipart(req);
        
        let parentId = parseInt(fields.parent_id, 10);
        if (isNaN(parentId)) parentId = null;
        
        let fileName = null;
        let telegramFileId = null;
        let mimeType = null;
        let fileSize = null;

        if (files.file) {
          tmpFiles.push(files.file.tmpPath);
          fileName = files.file.name;
          mimeType = files.file.mimeType;
          fileSize = files.file.size;
          
          const tgResult = await botManager.uploadFileToTelegram(
            parseInt(fields.faculty_id, 10), reqId,
            files.file.tmpPath, files.file.name, files.file.mimeType
          );
          telegramFileId = tgResult.telegram_file_id;
          if (tgResult.file_size) fileSize = tgResult.file_size;
          if (tgResult.mime_type) mimeType = tgResult.mime_type;
        }

        const id = await dbHelper.createMenu(
          fields.faculty_id,
          parentId,
          fields.title_en,
          fields.title_ar,
          fields.reply_type,
          fields.reply_content_en,
          fields.reply_content_ar,
          fileName,
          telegramFileId,
          mimeType,
          fileSize,
          parseInt(fields.sort_order || 0, 10)
        );
        return sendJson(res, 201, { id });
      } catch (e) {
        logger.error({ reqId, err: e }, 'POST /api/menus error');
        return sendJson(res, 500, { error: e.message });
      } finally {
        tmpFiles.forEach(cleanupTempFile);
      }
    }
  }

  const menuMatch = pathname.match(/^\/api\/menus\/(\d+)$/);
  if (menuMatch) {
    const id = parseInt(menuMatch[1], 10);
    if (method === 'PUT') {
      const tmpFiles = [];
      try {
        const { fields, files } = await parseMultipart(req);
        const menu = await dbHelper.getMenuById(id);
        if (!menu) return sendJson(res, 404, { error: 'Menu not found' });

        let parentId = parseInt(fields.parent_id, 10);
        if (isNaN(parentId)) parentId = null;

        let fileName = menu.file_name;
        let telegramFileId = menu.telegram_file_id;
        let mimeType = menu.mime_type;
        let fileSize = menu.file_size;

        if (files.file) {
          tmpFiles.push(files.file.tmpPath);
          fileName = files.file.name;
          mimeType = files.file.mimeType;
          fileSize = files.file.size;
          
          const tgResult = await botManager.uploadFileToTelegram(
            menu.faculty_id, reqId,
            files.file.tmpPath, files.file.name, files.file.mimeType
          );
          telegramFileId = tgResult.telegram_file_id;
          if (tgResult.file_size) fileSize = tgResult.file_size;
          if (tgResult.mime_type) mimeType = tgResult.mime_type;
        } else if (fields.remove_file === 'true') {
          fileName = null;
          telegramFileId = null;
          mimeType = null;
          fileSize = null;
        }

        await dbHelper.updateMenu(
          id,
          parentId,
          fields.title_en,
          fields.title_ar,
          fields.reply_type,
          fields.reply_content_en,
          fields.reply_content_ar,
          fileName,
          telegramFileId,
          mimeType,
          fileSize,
          parseInt(fields.sort_order || 0, 10)
        );
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        logger.error({ reqId, err: e }, 'PUT /api/menus error');
        return sendJson(res, 500, { error: e.message });
      } finally {
        tmpFiles.forEach(cleanupTempFile);
      }
    } else if (method === 'DELETE') {
      try {
        const menu = await dbHelper.getMenuById(id);
        if (menu) {
          // No S3 cleanup needed — files are on Telegram
          await dbHelper.deleteMenu(id);
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        logger.error({ reqId, err: e }, 'DELETE /api/menus error');
        return sendJson(res, 500, { error: e.message });
      }
    }
  }

  // --- Announcements API ---
  if (pathname === '/api/announcements') {
    if (method === 'GET') {
      const facId = parsedUrl.searchParams.get('faculty_id');
      if (!facId) return sendJson(res, 400, { error: 'Missing faculty_id' });
      const anns = await dbHelper.getAnnouncementsByFaculty(facId);
      const enhanced = anns.map(a => ({
        ...a,
        file_url: a.telegram_file_id ? `/api/files/announcement/${a.id}` : null
      }));
      return sendJson(res, 200, enhanced);
    }
    else if (method === 'POST') {
      const tmpFiles = [];
      try {
        const { fields, files } = await parseMultipart(req);
        
        let fileName = null;
        let telegramFileId = null;
        let mimeType = null;
        let fileSize = null;

        if (files.file) {
          tmpFiles.push(files.file.tmpPath);
          fileName = files.file.name;
          mimeType = files.file.mimeType;
          fileSize = files.file.size;
          
          const tgResult = await botManager.uploadFileToTelegram(
            parseInt(fields.faculty_id, 10), reqId,
            files.file.tmpPath, files.file.name, files.file.mimeType
          );
          telegramFileId = tgResult.telegram_file_id;
          if (tgResult.file_size) fileSize = tgResult.file_size;
          if (tgResult.mime_type) mimeType = tgResult.mime_type;
        }

        const annId = await dbHelper.createAnnouncement(
          fields.faculty_id,
          fields.title_en,
          fields.title_ar,
          fields.content_en,
          fields.content_ar,
          fileName,
          telegramFileId,
          mimeType,
          fileSize
        );

        const ann = {
          id: annId,
          faculty_id: fields.faculty_id,
          title_en: fields.title_en,
          title_ar: fields.title_ar,
          content_en: fields.content_en,
          content_ar: fields.content_ar,
          file_name: fileName,
          telegram_file_id: telegramFileId
        };

        await botManager.broadcastAnnouncement(ann, reqId);
        return sendJson(res, 201, { id: annId });
      } catch (e) {
        logger.error({ reqId, err: e }, 'POST /api/announcements error');
        return sendJson(res, 500, { error: e.message });
      } finally {
        tmpFiles.forEach(cleanupTempFile);
      }
    }
  }

  // --- Bot Users / Analytics API ---
  if (pathname === '/api/bot_users' && method === 'GET') {
    const facId = parsedUrl.searchParams.get('faculty_id');
    if (!facId) return sendJson(res, 400, { error: 'Missing faculty_id' });
    
    try {
      const users = await dbHelper.getBotUsersByFaculty(facId);
      const telegram = users.filter(u => u.platform === 'telegram').length;
      const web = users.filter(u => u.platform === 'web').length;

      return sendJson(res, 200, {
        total: users.length,
        telegram,
        web,
        users: users
      });
    } catch(e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // --- Web Chatbot API ---
  if (pathname === '/api/chat/start' && method === 'POST') {
    try {
      const data = await parseJson(req);
      const { faculty_slug, chat_id, language, username } = data;
      
      const faculty = await dbHelper.getFacultyBySlug(faculty_slug);
      if (!faculty) return sendJson(res, 404, { error: 'Faculty not found' });

      await dbHelper.upsertBotUser(faculty.id, 'web', chat_id, username || 'Web User', language || 'en');
      await dbHelper.updateBotUserMenu(chatIdIdFromName(chat_id), null);

      const menus = await dbHelper.getMenusByFaculty(faculty.id);
      const rootMenus = menus.filter(m => m.parent_id === null).sort((a,b) => a.sort_order - b.sort_order);

      return sendJson(res, 200, {
        faculty_name_en: faculty.name_en,
        faculty_name_ar: faculty.name_ar,
        welcome_en: faculty.welcome_en,
        welcome_ar: faculty.welcome_ar,
        menus: rootMenus
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/chat/select' && method === 'POST') {
    try {
      const data = await parseJson(req);
      const { faculty_slug, chat_id, menu_id, language } = data;
      
      const faculty = await dbHelper.getFacultyBySlug(faculty_slug);
      if (!faculty) return sendJson(res, 404, { error: 'Faculty not found' });

      const menu = await dbHelper.getMenuById(menu_id);
      if (!menu || menu.faculty_id !== faculty.id) {
        return sendJson(res, 404, { error: 'Menu not found' });
      }

      await dbHelper.upsertBotUser(faculty.id, 'web', chat_id, 'Web User', language || 'en');
      await dbHelper.updateBotUserMenu(chatIdIdFromName(chat_id), menu_id);

      const response = {
        title_en: menu.title_en,
        title_ar: menu.title_ar,
        reply_type: menu.reply_type,
        parent_id: menu.parent_id
      };

      if (menu.reply_type === 'submenu') {
        const allMenus = await dbHelper.getMenusByFaculty(faculty.id);
        const children = allMenus.filter(m => m.parent_id === menu.id).sort((a,b) => a.sort_order - b.sort_order);
        response.menus = children;
      } else if (menu.reply_type === 'text') {
        response.reply_content_en = menu.reply_content_en;
        response.reply_content_ar = menu.reply_content_ar;
        if (menu.inline_buttons) {
          try {
            const btns = JSON.parse(menu.inline_buttons);
            if (btns && btns.length > 0) {
               response.reply_content_en += '\n\nLinks:\n' + btns.map(b => `- ${b.text_en}: ${b.url}`).join('\n');
               response.reply_content_ar += '\n\nروابط:\n' + btns.map(b => `- ${b.text_ar}: ${b.url}`).join('\n');
            }
          } catch(e) {}
        }
      } else if (menu.reply_type === 'file') {
        response.reply_content_en = menu.reply_content_en;
        response.reply_content_ar = menu.reply_content_ar;
        response.file_name = menu.file_name;
        response.file_url = menu.telegram_file_id ? `/api/files/menu/${menu.id}` : null;
      }

      return sendJson(res, 200, response);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/chat/announcements' && method === 'GET') {
    const slug = parsedUrl.searchParams.get('faculty_slug');
    if (!slug) return sendJson(res, 400, { error: 'Missing faculty_slug' });
    
    try {
      const faculty = await dbHelper.getFacultyBySlug(slug);
      if (!faculty) return sendJson(res, 404, { error: 'Faculty not found' });

      const anns = await dbHelper.getAnnouncementsByFaculty(faculty.id);
      const enhanced = anns.map(a => ({
        ...a,
        file_url: a.telegram_file_id ? `/api/files/announcement/${a.id}` : null
      }));
      return sendJson(res, 200, enhanced);
    } catch(e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/chat/search' && method === 'GET') {
    const slug = parsedUrl.searchParams.get('faculty_slug');
    const query = parsedUrl.searchParams.get('query');
    if (!slug || !query) return sendJson(res, 400, { error: 'Missing params' });
    
    try {
      const faculty = await dbHelper.getFacultyBySlug(slug);
      if (!faculty) return sendJson(res, 404, { error: 'Faculty not found' });

      const term = `%${query.toLowerCase()}%`;
      const { rows } = await dbHelper.runQuery(`
        SELECT id, title_en, title_ar, file_name, telegram_file_id 
        FROM menus 
        WHERE faculty_id = $1 
          AND reply_type = 'file' 
          AND (LOWER(title_en) LIKE $2 OR LOWER(title_ar) LIKE $2 OR LOWER(file_name) LIKE $2)
        LIMIT 10
      `, [faculty.id, term]);

      const enhanced = rows.map(r => ({
        ...r,
        file_url: r.telegram_file_id ? `/api/files/menu/${r.id}` : null
      }));

      return sendJson(res, 200, enhanced);
    } catch(e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // --- Static File Server ---
  if (method === 'GET') {
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    
    if (!filePath.startsWith(path.join(__dirname, 'public'))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      
      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          return res.end('Server error');
        }
        
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const webChatIdMap = new Map();
function chatIdIdFromName(name) {
  if (webChatIdMap.has(name)) return webChatIdMap.get(name);
  const id = Math.floor(Math.random() * 1000000);
  webChatIdMap.set(name, id);
  return id;
}

const httpTerminator = createHttpTerminator({ server });

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  isShuttingDown = true;

  try {
    backup.stopScheduler();

    // 1. Drain active HTTP connections gracefully
    await httpTerminator.terminate();
    logger.info('HTTP server closed (active requests finished)');

    // 2. Close PostgreSQL connections
    await dbHelper.pool.end();
    logger.info('PostgreSQL pool closed');

    // 3. Close Redis connection
    await cache.close();
    logger.info('Redis connection closed');

    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function main() {
  try {
    const requiredEnv = ['DATABASE_URL'];
    const missing = requiredEnv.filter(e => !process.env[e]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    await dbHelper.initDb();
    
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`[Server] FOMbot server listening on port ${PORT}`);
      backup.startScheduler();
    });
  } catch (err) {
    logger.error({ err }, '[Server] Failed to start server');
    process.exit(1);
  }
}

main();

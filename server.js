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
const auth = require('./auth');
const bcrypt = require('bcryptjs');
const { reportRuntimeError, recoverUnsentReports, initReporterDB } = require('./error-reporter');

process.on('uncaughtException', async (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  try {
    const isFatal = true; // All uncaught exceptions are fatal by default in Node
    await reportRuntimeError({
      Severity: 'CRITICAL',
      Error_Type: 'UncaughtException',
      Error_Message: err.message,
      Stack_Trace: err.stack,
      Function_Name: 'process.on(uncaughtException)',
      File_Name: 'server.js',
      Operation: 'Unhandled Application Crash'
    });
    await flushPendingNotifications();
  } catch(e) {
    console.error('Failed to report uncaught exception:', e);
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  try {
    await reportRuntimeError({
      Severity: 'CRITICAL',
      Error_Type: 'UnhandledRejection',
      Error_Message: reason ? (reason.message || String(reason)) : 'Unknown',
      Stack_Trace: reason ? reason.stack : '',
      Function_Name: 'process.on(unhandledRejection)',
      File_Name: 'server.js',
      Operation: 'Unhandled Promise Rejection'
    });
    await flushPendingNotifications();
  } catch(e) {
    console.error('Failed to report unhandled rejection:', e);
  }
  // Let Node.js exit if it's going to, or we can force it:
  process.exit(1);
});

const loginAttempts = new Map();

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
      
      // Independent Monitoring Layer
      const monitor = require('./src/monitoring/monitor');
      monitor.onIncomingUpdate(facultyId, update).catch(err => {
        logger.error({ reqId, facultyId, err }, `Monitor update error`);
      });
      
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
        'Content-Disposition': `inline; filename="download"; filename*=UTF-8''${encodeURIComponent(menu.file_name || 'file')}`
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

  const fileProxyMenuFileMatch = pathname.match(/^\/api\/files\/menufile\/(\d+)$/);
  if (method === 'GET' && fileProxyMenuFileMatch) {
    try {
      const fileId = parseInt(fileProxyMenuFileMatch[1], 10);
      const { rows } = await dbHelper.runQuery('SELECT * FROM menu_files WHERE id = $1', [fileId]);
      const mf = rows[0];
      if (!mf || !mf.telegram_file_id) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }
      const { rows: menuRows } = await dbHelper.runQuery('SELECT faculty_id FROM menus WHERE id = $1', [mf.menu_id]);
      if (!menuRows[0]) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }
      const stream = await botManager.getFileStreamFromTelegram(menuRows[0].faculty_id, reqId, mf.telegram_file_id);
      const contentType = mf.mime_type || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Content-Disposition': `inline; filename="download"; filename*=UTF-8''${encodeURIComponent(mf.file_name || 'file')}`
      });
      stream.pipe(res);
      return;
    } catch (err) {
      logger.warn({ reqId, pathname, err: err.message }, 'Menu file proxy error');
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
        'Content-Disposition': `inline; filename="download"; filename*=UTF-8''${encodeURIComponent(ann.file_name || 'file')}`
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


  // ── API ROUTES ─────────────────────────────────────────────────────────────

  // ── AUTH & SUPERADMIN ROUTES ───────────────────────────────────────────────
  if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/superadmin/')) {
    if (pathname === '/api/auth/login' && method === 'POST') {
      try {
        const ip = await auth.getClientIp(req);
        const now = Date.now();
        const attempts = loginAttempts.get(ip) || { count: 0, time: now };
        if (now - attempts.time > 15 * 60 * 1000) { attempts.count = 0; attempts.time = now; }
        if (attempts.count >= 5) {
          return sendJson(res, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
        }

        const data = await parseJson(req);
        const admin = await dbHelper.getAdminByUsername(data.username);
        
        if (!admin || !admin.is_active || !(await bcrypt.compare(data.password, admin.password_hash))) {
          attempts.count++;
          loginAttempts.set(ip, attempts);
          return sendJson(res, 401, { error: 'Invalid username or password' });
        }

        loginAttempts.delete(ip);
        const { sessionId, expiresAt } = await auth.loginAdmin(admin.id);
        await dbHelper.logAdminAction(admin.id, 'login', 'system', null, ip);

        res.setHeader('Set-Cookie', `admin_session=${sessionId}; HttpOnly; Path=/; Expires=${expiresAt.toUTCString()}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return sendJson(res, 200, { ok: true, role: admin.role });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const admin = await auth.authenticateRequest(req);
      if (admin) {
        await auth.logoutAdmin(req);
        await dbHelper.logAdminAction(admin.id, 'logout', 'system', null, await auth.getClientIp(req));
      }
      res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const admin = await auth.authenticateRequest(req);
      if (!admin) return sendJson(res, 401, { error: 'Unauthorized' });
      return sendJson(res, 200, { username: admin.username, role: admin.role, is_deputy_owner: admin.is_deputy_owner });
    }

    // Protected Super Admin Routes
    const adminUser = await auth.authenticateRequest(req);
    if (!adminUser) return sendJson(res, 401, { error: 'Unauthorized' });

    if (pathname.startsWith('/api/superadmin/users')) {
      if (!auth.authorize(adminUser, 'manage_admins')) return sendJson(res, 403, { error: 'Forbidden' });
    }

    if (pathname === '/api/superadmin/users' && method === 'GET') {
      const users = await dbHelper.getAllAdmins();
      return sendJson(res, 200, users);
    }

    if (pathname === '/api/superadmin/users' && method === 'POST') {
      try {
        const data = await parseJson(req);
        if (!data.username || !data.password) return sendJson(res, 400, { error: 'Missing fields' });
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(data.password, salt);
        const newId = await dbHelper.createAdmin(data.username, hash, 'SUPER_ADMIN');
        await dbHelper.logAdminAction(adminUser.id, 'create_admin', 'admin_users', newId, await auth.getClientIp(req));
        return sendJson(res, 201, { id: newId });
      } catch (e) {
        if (e.code === '23505') return sendJson(res, 400, { error: 'Username already exists' });
        return sendJson(res, 500, { error: e.message });
      }
    }

    const resetMatch = pathname.match(/^\/api\/superadmin\/users\/([^/]+)\/reset$/);
    if (resetMatch && method === 'POST') {
      try {
        const id = resetMatch[1];
        const targetAdmin = await dbHelper.getAdminById(id);
        if (!auth.canManageUser(adminUser, targetAdmin)) {
          await dbHelper.logAdminAction(adminUser.id, 'blocked_unauthorized_admin_action', 'admin_users', id, await auth.getClientIp(req));
          return sendJson(res, 403, { error: 'Forbidden: Cannot manage this user' });
        }
        const data = await parseJson(req);
        if (!data.password) return sendJson(res, 400, { error: 'Missing password' });
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(data.password, salt);
        await dbHelper.updateAdminPassword(id, hash);
        await dbHelper.deleteAllSessions(id);
        await dbHelper.logAdminAction(adminUser.id, 'reset_password', 'admin_users', id, await auth.getClientIp(req));
        return sendJson(res, 200, { ok: true });
      } catch(e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    const toggleMatch = pathname.match(/^\/api\/superadmin\/users\/([^/]+)\/toggle$/);
    if (toggleMatch && method === 'POST') {
      try {
        const id = toggleMatch[1];
        if (id === adminUser.id) return sendJson(res, 400, { error: 'Cannot disable yourself' });
        const targetAdmin = await dbHelper.getAdminById(id);
        if (!auth.canManageUser(adminUser, targetAdmin)) {
          await dbHelper.logAdminAction(adminUser.id, 'blocked_unauthorized_admin_action', 'admin_users', id, await auth.getClientIp(req));
          return sendJson(res, 403, { error: 'Forbidden: Cannot manage this user' });
        }
        const data = await parseJson(req);
        await dbHelper.toggleAdminStatus(id, data.is_active);
        if (!data.is_active) await dbHelper.deleteAllSessions(id);
        await dbHelper.logAdminAction(adminUser.id, 'toggle_admin', 'admin_users', id, await auth.getClientIp(req));
        return sendJson(res, 200, { ok: true });
      } catch(e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    const deputyMatch = pathname.match(/^\/api\/superadmin\/users\/([^/]+)\/deputy$/);
    if (deputyMatch && method === 'POST') {
      try {
        if (adminUser.role !== 'OWNER') {
          await dbHelper.logAdminAction(adminUser.id, 'blocked_unauthorized_admin_action', 'admin_users', 'deputy_assign', await auth.getClientIp(req));
          return sendJson(res, 403, { error: 'Only the OWNER can manage Deputy Owner status' });
        }
        const id = deputyMatch[1];
        const data = await parseJson(req);
        
        if (data.is_deputy_owner) {
          const targetAdmin = await dbHelper.getAdminById(id);
          if (!targetAdmin || targetAdmin.role !== 'SUPER_ADMIN') {
            return sendJson(res, 400, { error: 'Can only promote regular SUPER_ADMIN accounts' });
          }
          await dbHelper.assignDeputyOwner(id);
          await dbHelper.logAdminAction(adminUser.id, 'assign_deputy_owner', 'admin_users', id, await auth.getClientIp(req));
        } else {
          // Verify we are removing it from the currently assigned deputy (or just clearing it)
          await dbHelper.assignDeputyOwner(null);
          await dbHelper.logAdminAction(adminUser.id, 'remove_deputy_owner', 'admin_users', id, await auth.getClientIp(req));
        }
        return sendJson(res, 200, { ok: true });
      } catch(e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    const deleteMatch = pathname.match(/^\/api\/superadmin\/users\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      try {
        const id = deleteMatch[1];
        const targetAdmin = await dbHelper.getAdminById(id);
        if (!auth.canManageUser(adminUser, targetAdmin)) {
          await dbHelper.logAdminAction(adminUser.id, 'blocked_unauthorized_admin_action', 'admin_users', id, await auth.getClientIp(req));
          return sendJson(res, 403, { error: 'Forbidden: Cannot delete this user' });
        }
        await dbHelper.deleteAdmin(id);
        await dbHelper.deleteAllSessions(id);
        await dbHelper.logAdminAction(adminUser.id, 'delete_admin', 'admin_users', id, await auth.getClientIp(req));
        return sendJson(res, 200, { ok: true });
      } catch(e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // --- System Settings API ---
    if (pathname === '/api/superadmin/settings/backup') {
      if (method === 'GET') {
        try {
          const raw = await dbHelper.getSystemSetting('backup_interval_hours', 24);
          const interval = parseInt(raw, 10);
          return sendJson(res, 200, { intervalHours: isNaN(interval) ? 24 : interval });
        } catch(e) {
          logger.error({ err: e }, '[Backup Route] Error reading backup settings');
          return sendJson(res, 500, { error: e.message });
        }
      }

      if (method === 'POST') {
        if (adminUser.role !== 'OWNER' && !adminUser.is_deputy_owner) {
          return sendJson(res, 403, { error: 'Forbidden: Requires OWNER or DEPUTY Owner' });
        }
        
        try {
          const body = await parseJsonBody(req);
          const hours = parseInt(body.intervalHours, 10);
          
          if (isNaN(hours) || hours < 0) {
            return sendJson(res, 400, { error: 'Invalid interval hours' });
          }

          await dbHelper.setSystemSetting('backup_interval_hours', hours);
          await dbHelper.logAdminAction(adminUser.id, 'update_backup_schedule', 'system_settings', `${hours}h`, await auth.getClientIp(req));
          
          // Update the live scheduler
          const backupMod = require('./backup');
          await backupMod.updateSchedule(hours);
          
          return sendJson(res, 200, { ok: true, intervalHours: hours });
        } catch(e) {
          logger.error({ err: e }, '[Backup Route] Error updating backup schedule');
          return sendJson(res, 500, { error: e.message });
        }
      }
    }

    // --- Backups API ---
    if (pathname.startsWith('/api/superadmin/backups')) {
      const backupMod = require('./backup');
      const bs = backupMod.backupService;

      if (pathname === '/api/superadmin/backups' && method === 'GET') {
        const list = await bs.listBackups();
        const nextMs = bs.getNextScheduledBackupMs();
        return sendJson(res, 200, {
          isConfigured: bs.isConfigured(),
          nextScheduledMs: nextMs,
          backups: list
        });
      }

      if (pathname === '/api/superadmin/backups/create' && method === 'POST') {
        const result = await bs.createBackup('manual');
        if (result.success) {
          await dbHelper.logAdminAction(adminUser.id, 'create_backup', 'backups', result.key, await auth.getClientIp(req));
          return sendJson(res, 200, result);
        }
        return sendJson(res, 500, result);
      }

      if (pathname === '/api/superadmin/backups/restore' && method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.key) return sendJson(res, 400, { error: 'Missing backup key' });
        
        const list = await bs.listBackups();
        if (!list.some(b => b.key === body.key)) return sendJson(res, 404, { error: 'Backup not found' });

        const result = await bs.restoreBackup(body.key);
        if (result.success) {
          await dbHelper.logAdminAction(adminUser.id, 'restore_backup', 'backups', body.key, await auth.getClientIp(req));
          return sendJson(res, 200, result);
        }
        return sendJson(res, 500, result);
      }

      // Owner & Deputy only for Delete and Download
      if (adminUser.role !== 'OWNER' && !adminUser.is_deputy_owner) {
        return sendJson(res, 403, { error: 'Forbidden: Requires OWNER or DEPUTY Owner' });
      }

      const backupDeleteMatch = pathname.match(/^\/api\/superadmin\/backups$/);
      if (backupDeleteMatch && method === 'DELETE') {
        const key = parsedUrl.searchParams.get('key');
        if (!key) return sendJson(res, 400, { error: 'Missing key parameter' });
        
        const list = await bs.listBackups();
        if (!list.some(b => b.key === key)) return sendJson(res, 404, { error: 'Backup not found' });

        const result = await bs.deleteBackup(key);
        if (result.success) {
          await dbHelper.logAdminAction(adminUser.id, 'delete_backup', 'backups', key, await auth.getClientIp(req));
          return sendJson(res, 200, result);
        }
        return sendJson(res, 500, result);
      }

      if (pathname === '/api/superadmin/backups/download' && method === 'GET') {
        const key = parsedUrl.searchParams.get('key');
        if (!key) return sendJson(res, 400, { error: 'Missing key parameter' });
        
        const list = await bs.listBackups();
        if (!list.some(b => b.key === key)) return sendJson(res, 404, { error: 'Backup not found' });

        try {
          const storage = require('./src/backup/backup-storage');
          const buffer = await storage.download(key);
          const filename = key.split('/').pop();
          
          await dbHelper.logAdminAction(adminUser.id, 'download_backup', 'backups', key, await auth.getClientIp(req));

          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length
          });
          res.end(buffer);
          return;
        } catch (err) {
          logger.error({ err, key }, 'Failed to download backup');
          return sendJson(res, 500, { error: 'Failed to download backup' });
        }
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  // Protect Dashboard APIs
  if (pathname.startsWith('/api/faculties') || pathname.startsWith('/api/menus') || pathname.startsWith('/api/announcements') || pathname.startsWith('/api/bot_users')) {
    const adminUser = await auth.authenticateRequest(req);
    if (!adminUser) return sendJson(res, 401, { error: 'Unauthorized' });
    if (!auth.authorize(adminUser, 'manage_faculties')) return sendJson(res, 403, { error: 'Forbidden' });
    req.adminUser = adminUser;
  }

  // Protect Runtime Errors Dashboard APIs
  if (pathname.startsWith('/api/errors') || pathname.startsWith('/api/menu-builder')) {
    const adminUser = await auth.authenticateRequest(req);
    if (!adminUser) return sendJson(res, 401, { error: 'Unauthorized' });
    if (adminUser.role !== 'OWNER' && adminUser.role !== 'DEPUTY_OWNER') {
      return sendJson(res, 403, { error: 'Forbidden' });
    }
    req.adminUser = adminUser;
  }

  // --- Menu Builder API ---
  if (pathname === '/api/menu-builder/tree') {
    if (method === 'GET') {
      const facId = parsedUrl.searchParams.get('faculty_id');
      if (!facId) return sendJson(res, 400, { error: 'Missing faculty_id' });
      try {
        const { buildMenuTree } = require('./menu-builder');
        const tree = await buildMenuTree(facId);
        return sendJson(res, 200, tree);
      } catch (e) {
        logger.error({ reqId, err: e }, 'GET /api/menu-builder/tree error');
        return sendJson(res, 500, { error: e.message });
      }
    }
  }

  if (pathname === '/api/menu-builder/validate') {
    if (method === 'GET') {
      const facId = parsedUrl.searchParams.get('faculty_id');
      if (!facId) return sendJson(res, 400, { error: 'Missing faculty_id' });
      try {
        const { validateHierarchy } = require('./menu-builder');
        const validation = await validateHierarchy(facId);
        return sendJson(res, 200, validation);
      } catch (e) {
        logger.error({ reqId, err: e }, 'GET /api/menu-builder/validate error');
        return sendJson(res, 500, { error: e.message });
      }
    }
  }

  // --- Runtime Errors API ---
  if (pathname === '/api/errors') {
    if (method === 'GET') {
      try {
        const query = parsedUrl.searchParams;
        const page = parseInt(query.get('page') || '1', 10);
        const limit = parseInt(query.get('limit') || '50', 10);
        const offset = (page - 1) * limit;
        
        let conditions = [];
        let params = [];
        
        const severity = query.get('severity');
        if (severity) { params.push(severity); conditions.push(`severity = $${params.length}`); }
        const facultyId = query.get('faculty_id');
        if (facultyId) { params.push(facultyId); conditions.push(`faculty_id = $${params.length}`); }
        const status = query.get('status');
        if (status === 'resolved') { conditions.push(`resolved = true`); }
        else if (status === 'unresolved') { conditions.push(`resolved = false`); }
        
        let whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const countRes = await dbHelper.pool.query(`SELECT count(*) FROM runtime_error_logs ${whereClause}`, params);
        const total = parseInt(countRes.rows[0].count, 10);
        
        const dataRes = await dbHelper.pool.query(`
          SELECT id, severity, faculty_id, bot_id, user_telegram_id, operation, error_message, occurrence_count, first_occurrence, last_occurrence, resolved, resolved_by, resolved_at, notes
          FROM runtime_error_logs 
          ${whereClause} 
          ORDER BY last_occurrence DESC 
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);
        
        return sendJson(res, 200, { data: dataRes.rows, total, page, limit });
      } catch (e) {
        logger.error({ reqId, err: e }, 'GET /api/errors error');
        return sendJson(res, 500, { error: 'Server Error' });
      }
    }
  }

  const errorMatch = pathname.match(/^\/api\/errors\/(\d+)$/);
  if (errorMatch) {
    const id = parseInt(errorMatch[1], 10);
    if (method === 'GET') {
      try {
        const dataRes = await dbHelper.pool.query(`SELECT * FROM runtime_error_logs WHERE id = $1`, [id]);
        if (dataRes.rows.length === 0) return sendJson(res, 404, { error: 'Not found' });
        return sendJson(res, 200, dataRes.rows[0]);
      } catch (e) {
        logger.error({ reqId, err: e }, 'GET /api/errors/:id error');
        return sendJson(res, 500, { error: 'Server Error' });
      }
    }
  }

  const errorResolveMatch = pathname.match(/^\/api\/errors\/(\d+)\/resolve$/);
  if (errorResolveMatch && method === 'PUT') {
    const id = parseInt(errorResolveMatch[1], 10);
    try {
      const data = await parseJson(req);
      const resolved = !!data.resolved;
      await dbHelper.pool.query(`
        UPDATE runtime_error_logs 
        SET resolved = $1, resolved_by = $2, resolved_at = $3 
        WHERE id = $4
      `, [resolved, resolved ? req.adminUser.username : null, resolved ? new Date() : null, id]);
      
      await dbHelper.pool.query(
         'INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
         [req.adminUser.id, 'RESOLVE_ERROR', 'ERROR_LOG', id, JSON.stringify({ resolved })]
      );
      return sendJson(res, 200, { success: true });
    } catch (e) {
      logger.error({ reqId, err: e }, 'PUT /api/errors/:id/resolve error');
      return sendJson(res, 500, { error: 'Server Error' });
    }
  }

  const errorNotesMatch = pathname.match(/^\/api\/errors\/(\d+)\/notes$/);
  if (errorNotesMatch && method === 'PUT') {
    const id = parseInt(errorNotesMatch[1], 10);
    try {
      const data = await parseJson(req);
      await dbHelper.pool.query(`UPDATE runtime_error_logs SET notes = $1 WHERE id = $2`, [data.notes, id]);
      
      await dbHelper.pool.query(
         'INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
         [req.adminUser.id, 'UPDATE_ERROR_NOTES', 'ERROR_LOG', id, JSON.stringify({ notes: data.notes })]
      );
      return sendJson(res, 200, { success: true });
    } catch (e) {
      logger.error({ reqId, err: e }, 'PUT /api/errors/:id/notes error');
      return sendJson(res, 500, { error: 'Server Error' });
    }
  }

  const errorSeverityMatch = pathname.match(/^\/api\/errors\/(\d+)\/severity$/);
  if (errorSeverityMatch && method === 'PUT') {
    const id = parseInt(errorSeverityMatch[1], 10);
    try {
      const data = await parseJson(req);
      await dbHelper.pool.query(`UPDATE runtime_error_logs SET severity = $1 WHERE id = $2`, [data.severity, id]);
      
      await dbHelper.pool.query(
         'INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
         [req.adminUser.id, 'UPDATE_ERROR_SEVERITY', 'ERROR_LOG', id, JSON.stringify({ severity: data.severity })]
      );
      return sendJson(res, 200, { success: true });
    } catch (e) {
      logger.error({ reqId, err: e }, 'PUT /api/errors/:id/severity error');
      return sendJson(res, 500, { error: 'Server Error' });
    }
  }

  // --- Faculties API ---
  if (pathname === '/api/faculties') {
    if (method === 'GET') {
      try {
        const faculties = await dbHelper.getFaculties();
        // Inject bot status
        for (const fac of faculties) {
          const botStatus = await botManager.getBotStatus(fac.id);
          fac.bot_status = botStatus.status;
          if (botStatus.username) fac.bot_username = botStatus.username;
          if (botStatus.error) fac.bot_error = botStatus.error;
        }
        return sendJson(res, 200, faculties);
      } catch (e) {
        logger.error({ reqId, err: e }, 'GET /api/faculties error');
        return sendJson(res, 500, { error: e.message });
      }
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
        if (req.adminUser) await dbHelper.logAdminAction(req.adminUser.id, 'create_faculty', 'faculties', id.toString(), await auth.getClientIp(req));
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
          data.telegram_api_server !== undefined ? data.telegram_api_server : fac.telegram_api_server,
          data.empty_msg_en !== undefined ? data.empty_msg_en : fac.empty_msg_en,
          data.empty_msg_ar !== undefined ? data.empty_msg_ar : fac.empty_msg_ar,
          data.unknown_msg_en !== undefined ? data.unknown_msg_en : fac.unknown_msg_en,
          data.unknown_msg_ar !== undefined ? data.unknown_msg_ar : fac.unknown_msg_ar,
          data.no_file_msg_en !== undefined ? data.no_file_msg_en : fac.no_file_msg_en,
          data.no_file_msg_ar !== undefined ? data.no_file_msg_ar : fac.no_file_msg_ar
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
          if (req.adminUser) await dbHelper.logAdminAction(req.adminUser.id, 'delete_faculty', 'faculties', id.toString(), await auth.getClientIp(req));
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
        newBotEnabled, sourceFac.disabled_message_en, sourceFac.disabled_message_ar, sourceFac.telegram_api_server,
        sourceFac.empty_msg_en, sourceFac.empty_msg_ar, sourceFac.unknown_msg_en, sourceFac.unknown_msg_ar,
        sourceFac.no_file_msg_en, sourceFac.no_file_msg_ar
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
      try {
        const facId = parsedUrl.searchParams.get('faculty_id');
        if (!facId) return sendJson(res, 400, { error: 'Missing faculty_id' });
        const menus = await dbHelper.getMenusByFaculty(facId);
        const enhancedMenus = [];
        for (const m of menus) {
          const enhanced = {
            ...m,
            file_url: m.telegram_file_id ? `/api/files/menu/${m.id}` : null
          };
          if (m.reply_type === 'file') {
            const files = await dbHelper.getMenuFiles(m.id);
            enhanced.files = files.map(f => ({
              id: f.id,
              file_name: f.file_name,
              mime_type: f.mime_type,
              file_size: f.file_size,
              file_url: `/api/files/menufile/${f.id}`
            }));
          }
          enhancedMenus.push(enhanced);
        }
        return sendJson(res, 200, enhancedMenus);
      } catch (e) {
        logger.error({ reqId, err: e }, 'GET /api/menus error');
        return sendJson(res, 500, { error: e.message });
      }
    }
    else if (method === 'POST') {
      const tmpFiles = [];
      try {
        const { fields, files } = await parseMultipart(req);
        
        let parentId = parseInt(fields.parent_id, 10);
        if (isNaN(parentId)) parentId = null;

        if (parentId !== null) {
          if (parentId === id) {
            return sendJson(res, 400, { error: 'Self-parenting is not allowed' });
          }
          const parentMenu = await dbHelper.getMenuById(parentId);
          if (!parentMenu) return sendJson(res, 400, { error: 'Parent menu not found' });
          if (parentMenu.faculty_id !== menu.faculty_id) return sendJson(res, 400, { error: 'Cross-faculty parent assignment not allowed' });
          
          let currentParentId = parentMenu.id;
          let depth = 0;
          while (currentParentId !== null && depth < 20) {
            if (currentParentId === id) return sendJson(res, 400, { error: 'Circular reference detected' });
            const currMenu = await dbHelper.getMenuById(currentParentId);
            currentParentId = currMenu ? currMenu.parent_id : null;
            depth++;
          }
        }
        
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
        } else if (fields.telegram_file_id) {
          telegramFileId = fields.telegram_file_id;
          fileName = fields.file_name;
          mimeType = fields.mime_type;
          fileSize = fields.file_size ? parseInt(fields.file_size, 10) : null;
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
          parseInt(fields.sort_order || 0, 10),
          parseInt(fields.row_index || 0, 10)
        );
        
        if (telegramFileId) {
          await dbHelper.addMenuFile(id, telegramFileId, fileName, mimeType, fileSize);
        }
        
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

        if (parentId !== null) {
          if (parentId === id) {
            return sendJson(res, 400, { error: 'Self-parenting is not allowed' });
          }
          const parentMenu = await dbHelper.getMenuById(parentId);
          if (!parentMenu) return sendJson(res, 400, { error: 'Parent menu not found' });
          if (parentMenu.faculty_id !== menu.faculty_id) return sendJson(res, 400, { error: 'Cross-faculty parent assignment not allowed' });
          
          let currentParentId = parentMenu.id;
          let depth = 0;
          while (currentParentId !== null && depth < 20) {
            if (currentParentId === id) return sendJson(res, 400, { error: 'Circular reference detected' });
            const currMenu = await dbHelper.getMenuById(currentParentId);
            currentParentId = currMenu ? currMenu.parent_id : null;
            depth++;
          }
        }

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
        } else if (fields.telegram_file_id) {
          telegramFileId = fields.telegram_file_id;
          fileName = fields.file_name;
          mimeType = fields.mime_type;
          fileSize = fields.file_size ? parseInt(fields.file_size, 10) : null;
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
          parseInt(fields.sort_order || 0, 10),
          parseInt(fields.row_index || 0, 10)
        );

        if (files.file) {
          await dbHelper.addMenuFile(id, telegramFileId, fileName, mimeType, fileSize);
        } else if (fields.remove_file === 'true') {
          // Backward compatibility: clear the multiple files as well
          await dbHelper.pool.query('DELETE FROM menu_files WHERE menu_id = $1', [id]);
        } else if (fields.telegram_file_id && !menu.telegram_file_id) {
          await dbHelper.addMenuFile(id, telegramFileId, fileName, mimeType, fileSize);
        }

        return sendJson(res, 200, { success: true });
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

  // --- Menu Files Individual DELETE API ---
  const menuFileDelMatch = pathname.match(/^\/api\/menu-files\/(\d+)$/);
  if (menuFileDelMatch && method === 'DELETE') {
    const fileId = parseInt(menuFileDelMatch[1], 10);
    try {
      await dbHelper.deleteMenuFile(fileId);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      logger.error({ reqId, err: e }, 'DELETE /api/menu-files error');
      return sendJson(res, 500, { error: e.message });
    }
  }

  // --- Announcements API ---
  if (pathname === '/api/announcements') {
    if (method === 'GET') {
      try {
        const facId = parsedUrl.searchParams.get('faculty_id');
        if (!facId) return sendJson(res, 400, { error: 'Missing faculty_id' });
        const anns = await dbHelper.getAnnouncementsByFaculty(facId);
        const enhanced = anns.map(a => ({
          ...a,
          file_url: a.telegram_file_id ? `/api/files/announcement/${a.id}` : null
        }));
        return sendJson(res, 200, enhanced);
      } catch (e) {
        logger.error({ reqId, err: e }, 'GET /api/announcements error');
        return sendJson(res, 500, { error: e.message });
      }
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
        const files = await dbHelper.getMenuFiles(menu.id);
        response.files = files.map(f => ({
          id: f.id,
          file_name: f.file_name,
          mime_type: f.mime_type,
          file_size: f.file_size,
          file_url: `/api/files/menufile/${f.id}`
        }));
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

    // 1. Wait until initDb() finishes
    await dbHelper.initDb();
    
    // 2. Initialize optional services
    await initReporterDB();
    
    const translationService = require('./translation-service');
    await translationService.initDb();
    
    // 3. Start Backup Scheduler
    await backup.startScheduler();
    
    // 4. Start Telegram Bot (implicit by webhooks being enabled now)
    
    // 5. Start HTTP server
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`[Server] FOMbot server listening on port ${PORT}`);
      console.log('Server Ready');
    });
  } catch (err) {
    logger.error({ err }, '[Server] Fatal database initialization failure');
    process.exit(1);
  }
}

main();



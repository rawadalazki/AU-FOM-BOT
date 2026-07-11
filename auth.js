const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const dbHelper = require('./database');

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

/**
 * Validates the session and returns the user object if authenticated.
 */
async function authenticateRequest(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['admin_session'];
  if (!sessionId) return null;

  // Hash the incoming session ID to compare with DB
  const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  const session = await dbHelper.getSessionByHash(sessionHash);
  
  if (!session) return null;

  const admin = await dbHelper.getAdminById(session.admin_id);
  if (!admin || !admin.is_active) {
    // If admin is disabled or deleted, the session is effectively invalid.
    return null;
  }

  return admin;
}

/**
 * Centralized authorization checker.
 */
function authorize(admin, action, resource = null) {
  if (!admin || !admin.is_active) return false;

  switch (action) {
    case 'manage_admins':
      // OWNER and DEPUTY_OWNER can access the admin management panel/API
      return admin.role === 'OWNER' || admin.is_deputy_owner;
    case 'manage_faculties':
    case 'manage_menus':
    case 'manage_announcements':
      // All active admins can manage bots
      return admin.role === 'OWNER' || admin.role === 'SUPER_ADMIN';
    default:
      return false;
  }
}

/**
 * Validates if the actor is permitted to manage (edit/disable/reset) the target user.
 */
function canManageUser(actor, target) {
  if (!actor || !actor.is_active || !target) return false;

  // Nobody can manage the OWNER (except maybe the OWNER themselves for some non-destructive actions, but to be safe, no one manages OWNER)
  // The prompt states: "No user other than the OWNER may: Delete the OWNER... Modify the OWNER account." 
  // However, even the OWNER should not disable themselves or reset their own password via standard APIs to prevent lockouts.
  if (target.role === 'OWNER') {
    return false; // Strict OWNER protection
  }

  if (actor.role === 'OWNER') {
    return true; // OWNER can manage anyone else
  }

  if (actor.is_deputy_owner) {
    // Deputy Owner can manage regular SUPER_ADMINs
    return target.role === 'SUPER_ADMIN' && !target.is_deputy_owner;
  }

  // Regular SUPER_ADMIN cannot manage anyone
  return false;
}

/**
 * Creates a secure session for an admin.
 * Returns the raw session token to be sent as a cookie.
 */
async function loginAdmin(adminId) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  
  // 24 hours expiration
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
  await dbHelper.createSession(adminId, sessionHash, expiresAt);
  await dbHelper.updateLastLogin(adminId);
  
  return { sessionId, expiresAt };
}

async function logoutAdmin(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['admin_session'];
  if (sessionId) {
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    await dbHelper.deleteSession(sessionHash);
  }
}

async function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

module.exports = {
  parseCookies,
  authenticateRequest,
  authorize,
  canManageUser,
  loginAdmin,
  logoutAdmin,
  getClientIp
};

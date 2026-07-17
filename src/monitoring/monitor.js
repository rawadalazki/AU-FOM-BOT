const dbHelper = require('../../database');

class Monitor {
  constructor() {
    this.blockedCache = new Set();
  }

  /**
   * Monitor incoming updates (read-only)
   */
  async onIncomingUpdate(botService, update) {
    try {
      if (!botService || !botService.facultyId) return;

      const faculty = await dbHelper.getFacultyById(botService.facultyId);
      if (!faculty || !faculty.admin_chat_id || !faculty.monitoring_enabled) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;
      const primaryAdminId = adminIds[0];

      // Identify user from update
      const msg = update.message || update.callback_query?.message;
      const from = update.message?.from || update.callback_query?.from;
      if (!from || from.is_bot) return;

      const telegramId = from.id.toString();
      
      // Ignore updates from administrators
      if (adminIds.includes(telegramId)) return;

      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
      const username = from.username ? `@${from.username}` : 'N/A';
      const lang = from.language_code || 'N/A';
      
      let text = update.message?.text || update.callback_query?.data || '';
      let command = text.startsWith('/') ? text.split(' ')[0] : 'None';

      const notifyText = `💬 User Activity\nName: ${name}\nUsername: ${username}\nTelegram ID: ${telegramId}\nLanguage: ${lang}\nMessage: ${text}\nCommand: ${command}\nTime: ${new Date().toISOString()}`;

      console.log(`[Monitor] Sending activity alert to ${primaryAdminId}`);
      botService.apiCall('sendMessage', {
        chat_id: primaryAdminId,
        text: notifyText
      }).catch(() => {});
    } catch (e) {
      // Silently ignore all errors
    }
  }

  /**
   * Monitor new user registrations
   */
  async onNewUser(botService, user) {
    try {
      if (!botService || !botService.facultyId) return;

      const faculty = await dbHelper.getFacultyById(botService.facultyId);
      if (!faculty || !faculty.admin_chat_id || !faculty.monitoring_enabled) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;
      const primaryAdminId = adminIds[0];

      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
      const username = user.username ? `@${user.username}` : 'N/A';
      const telegramId = user.id ? user.id.toString() : 'Unknown';
      const lang = user.language_code || 'N/A';

      const notifyText = `🟢 New User\nName: ${name}\nUsername: ${username}\nTelegram ID: ${telegramId}\nLanguage: ${lang}\nFaculty: ${faculty.name_en || faculty.slug || 'Unknown'}\nTime: ${new Date().toISOString()}`;

      console.log(`[Monitor] Sending new user alert to ${primaryAdminId}`);
      botService.apiCall('sendMessage', {
        chat_id: primaryAdminId,
        text: notifyText
      }).catch(() => {});
    } catch (e) {}
  }

  /**
   * Monitor blocked bot
   */
  async onUserBlocked(botService, user) {
    try {
      if (!botService || !botService.facultyId) return;

      const chatId = user.chat_id || user.id?.toString();
      if (!chatId) return;

      // Ignore duplicate notifications
      const cacheKey = `${botService.facultyId}_${chatId}`;
      if (this.blockedCache.has(cacheKey)) return;
      this.blockedCache.add(cacheKey);

      const faculty = await dbHelper.getFacultyById(botService.facultyId);
      if (!faculty || !faculty.admin_chat_id || !faculty.monitoring_enabled) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;
      const primaryAdminId = adminIds[0];

      const username = user.username ? `@${user.username}` : 'N/A';
      let name = [user.first_name, user.last_name].filter(Boolean).join(' ');
      if (!name) {
          // fallback to db
          const userRes = await dbHelper.pool.query('SELECT * FROM bot_users WHERE chat_id = $1 AND faculty_id = $2', [chatId.toString(), botService.facultyId]);
          if (userRes.rows[0]) {
              name = userRes.rows[0].username || 'Unknown';
          } else {
              name = 'Unknown';
          }
      }

      const notifyText = `🚫 Bot Blocked\nName: ${name}\nUsername: ${username}\nTelegram ID: ${chatId}\nTime: ${new Date().toISOString()}`;

      console.log(`[Monitor] Sending bot blocked alert to ${primaryAdminId}`);
      botService.apiCall('sendMessage', {
        chat_id: primaryAdminId,
        text: notifyText
      }).catch(() => {});
    } catch (e) {}
  }

  /**
   * Monitor Telegram API Errors
   */
  async onTelegramError(botService, error) {
    try {
      if (!botService || !botService.facultyId) return;

      const faculty = await dbHelper.getFacultyById(botService.facultyId);
      if (!faculty || !faculty.admin_chat_id || !faculty.monitoring_enabled) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;
      const primaryAdminId = adminIds[0];

      const errorCode = error.error_code || 'Unknown';
      const description = error.description || 'No description';

      const notifyText = `⚠️ <b>Telegram API Error</b>\n<b>Code:</b> ${errorCode}\n<b>Description:</b> ${description}\n<b>Time:</b> ${new Date().toISOString()}`;

      botService.apiCall('sendMessage', {
        chat_id: primaryAdminId,
        text: notifyText,
        parse_mode: 'HTML'
      }).catch(() => {});
    } catch (e) {}
  }
}

module.exports = new Monitor();

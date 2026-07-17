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
      if (!faculty || !faculty.admin_chat_id) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;

      // Identify user from update
      const msg = update.message || update.callback_query?.message;
      const from = update.message?.from || update.callback_query?.from;
      if (!from) return;

      const telegramId = from.id.toString();
      
      // Ignore updates from administrators
      if (adminIds.includes(telegramId)) return;

      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
      const username = from.username ? `@${from.username}` : 'N/A';
      const lang = from.language_code || 'N/A';
      const premium = from.is_premium ? 'Yes' : 'No';
      let updateType = update.message ? 'Message' : (update.callback_query ? 'Callback Query' : 'Other');
      
      let text = update.message?.text || update.callback_query?.data || '';
      let command = text.startsWith('/') ? text.split(' ')[0] : 'None';

      const notifyText = `📡 <b>Live Monitoring: Update</b>\n<b>Name:</b> ${name}\n<b>Username:</b> ${username}\n<b>ID:</b> <code>${telegramId}</code>\n<b>Language:</b> ${lang}\n<b>Premium:</b> ${premium}\n<b>Type:</b> ${updateType}\n<b>Text/Data:</b> ${text}\n<b>Command:</b> ${command}`;

      // Dispatch non-blocking
      for (const adminId of adminIds) {
        botService.apiCall('sendMessage', {
          chat_id: adminId,
          text: notifyText,
          parse_mode: 'HTML'
        }).catch(() => {});
      }
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
      if (!faculty || !faculty.admin_chat_id) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;

      // Get total users
      const totalUsersRes = await dbHelper.pool.query(
        'SELECT COUNT(*) as count FROM bot_users WHERE faculty_id = $1', 
        [botService.facultyId]
      );
      const totalUsers = totalUsersRes.rows[0].count;

      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Unknown';
      const username = user.username ? `@${user.username}` : 'N/A';
      const telegramId = user.id ? user.id.toString() : 'Unknown';
      const lang = user.language_code || 'N/A';
      const premium = user.is_premium ? 'Yes' : 'No';

      const notifyText = `🆕 <b>New User Registration</b>\n<b>Name:</b> ${name}\n<b>Username:</b> ${username}\n<b>ID:</b> <code>${telegramId}</code>\n<b>Language:</b> ${lang}\n<b>Premium:</b> ${premium}\n<b>Total Users:</b> ${totalUsers}`;

      for (const adminId of adminIds) {
        botService.apiCall('sendMessage', {
          chat_id: adminId,
          text: notifyText,
          parse_mode: 'HTML'
        }).catch(() => {});
      }
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
      if (!faculty || !faculty.admin_chat_id) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;

      // Try to fetch full name from DB if they had it? The DB 'bot_users' doesn't have full name natively. 
      // But we will fetch what we can, or just use what is passed.
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

      const notifyText = `🚫 <b>Bot Blocked by User</b>\n<b>Username:</b> ${username}\n<b>ID:</b> <code>${chatId}</code>\n<b>User full name:</b> ${name}\n<b>Time:</b> ${new Date().toISOString()}`;

      for (const adminId of adminIds) {
        botService.apiCall('sendMessage', {
          chat_id: adminId,
          text: notifyText,
          parse_mode: 'HTML'
        }).catch(() => {});
      }
    } catch (e) {}
  }

  /**
   * Monitor Telegram API Errors
   */
  async onTelegramError(botService, error) {
    try {
      if (!botService || !botService.facultyId) return;

      const faculty = await dbHelper.getFacultyById(botService.facultyId);
      if (!faculty || !faculty.admin_chat_id) return;
      
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean);
      if (adminIds.length === 0) return;

      const errorCode = error.error_code || 'Unknown';
      const description = error.description || 'No description';

      const notifyText = `⚠️ <b>Telegram API Error</b>\n<b>Code:</b> ${errorCode}\n<b>Description:</b> ${description}\n<b>Time:</b> ${new Date().toISOString()}`;

      for (const adminId of adminIds) {
        botService.apiCall('sendMessage', {
          chat_id: adminId,
          text: notifyText,
          parse_mode: 'HTML'
        }).catch(() => {});
      }
    } catch (e) {}
  }
}

module.exports = new Monitor();

const dbHelper = require('../../database');

class Monitor {
  constructor() {}

  getBotManager() {
    if (!this.botManager) {
      this.botManager = require('../../bot-manager');
    }
    return this.botManager;
  }

  async onIncomingUpdate(facultyId, update) {
    try {
      console.log('[Monitor] Update Received');

      if (!facultyId || !update) return;

      const faculty = await dbHelper.getFacultyById(facultyId);
      if (!faculty) return;

      if (!faculty.monitoring_enabled) return;
      console.log('[Monitor] Monitoring Enabled');

      const admins = await dbHelper.getAdminsByFaculty(facultyId);
      const owner = admins.find(a => a.role === 'OWNER');
      if (!owner) return;
      const primaryAdminId = owner.chat_id;
      const adminIds = admins.map(a => a.chat_id);

      // Extract user info
      let from = null;
      let text = '';
      
      if (update.message) {
        from = update.message.from;
        text = update.message.text || update.message.caption || '';
        if (!text) {
          if (update.message.photo) text = '[Photo]';
          else if (update.message.document) text = '[Document]';
          else if (update.message.video) text = '[Video]';
          else if (update.message.audio) text = '[Audio]';
          else if (update.message.voice) text = '[Voice]';
          else text = '[Other Media]';
        }
      } else if (update.callback_query) {
        from = update.callback_query.from;
        text = update.callback_query.data || '';
      } else if (update.edited_message) {
        from = update.edited_message.from;
        text = update.edited_message.text || update.edited_message.caption || '[Edited Message]';
      } else if (update.my_chat_member) {
        // e.g. blocked/unblocked
        from = update.my_chat_member.from;
        text = '[Chat Member Status Change]';
      } else {
        // Other updates
        return;
      }

      if (!from || from.is_bot) return;

      const telegramId = from.id.toString();
      // Ignore admins interacting with the bot
      if (adminIds.includes(telegramId)) return;

      console.log('[Monitor] Processing Message');

      const username = from.username ? `@${from.username}` : 'N/A';
      const lang = from.language_code || 'N/A';
      const facultyName = faculty.name_en || faculty.slug || 'Unknown';

      let notifyText = '';
      if (text.trim() === '/start') {
        notifyText = `🟢 New User\n\nUsername: ${username}\nID: ${telegramId}\nLanguage: ${lang}\nFaculty: ${facultyName}`;
      } else {
        notifyText = `💬 User Message\n\nUsername: ${username}\nID: ${telegramId}\nText: ${text}`;
      }

      console.log('[Monitor] Sending Alert');

      const botService = await this.getBotManager().getBotService(facultyId);
      
      await botService.apiCall('sendMessage', {
        chat_id: primaryAdminId,
        text: notifyText
      });

      console.log('[Monitor] Alert Sent');

      if (update.message) {
        try {
          await botService.apiCall('forwardMessage', {
            chat_id: primaryAdminId,
            from_chat_id: update.message.chat.id,
            message_id: update.message.message_id
          });
        } catch (fErr) {
          console.log('[Monitor] Forward failed');
        }
      }

    } catch (e) {
      // Ignore silently as this is non-intrusive monitoring
    }
  }
}

module.exports = new Monitor();

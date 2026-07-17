const https = require('node:https');
const crypto = require('node:crypto');
const monitor = require('./src/monitoring/monitor');
const FormData = require('form-data');
const dbHelper = require('./database');
const logger = require('./logger');
const cache = require('./cache');
const translationService = require('./translation-service');
const { t } = require('./src/localization');
const AdminRoutes = require('./src/admin-routes');

function getWebhookSecret(facultyId) {
  const secret = process.env.WEBHOOK_SECRET || 'default-webhook-secret';
  return crypto.createHmac('sha256', secret).update(`faculty-${facultyId}`).digest('hex').substring(0, 64);
}

/**
 * Stateless service object for handling Telegram bot logic.
 * Encapsulates API calls, webhook handling, and business logic.
 * Relies entirely on PostgreSQL for runtime state and Redis for caching.
 */
class TelegramBotService {
  constructor(facultyId, token, apiServer = 'api.telegram.org', reqId = 'system') {
    this.facultyId = facultyId;
    this.token = token;
    this.apiServer = apiServer;
    this.reqId = reqId;
    this.userRuntimeContext = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [chatId, ctx] of this.userRuntimeContext.entries()) {
        if (now - ctx.lastActivity > 30 * 60 * 1000) {
          this.userRuntimeContext.delete(chatId);
        }
      }
    }, 5 * 60 * 1000).unref();
  }

  updateUserContext(chatId, payload) {
    if (!chatId) return;
    const cid = chatId.toString();
    const crypto = require('crypto');
    let ctx = this.userRuntimeContext.get(cid);
    if (!ctx) {
      ctx = { sessionId: crypto.randomUUID() };
    } else {
      ctx = JSON.parse(JSON.stringify(ctx));
    }
    ctx = { ...ctx, ...payload, lastActivity: Date.now() };
    this.userRuntimeContext.set(cid, ctx);
  }

  logInfo(msg, obj = {}) {
    logger.info({ reqId: this.reqId, facultyId: this.facultyId, ...obj }, msg);
  }

  logError(msg, err, obj = {}) {
    logger.error({ reqId: this.reqId, facultyId: this.facultyId, err, ...obj }, msg);
    const { reportRuntimeError, getUserHistory } = require('./error-reporter');
    
    (async () => {
      try {
        const dbHelper = require('./database');
        let facultyName = '';
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        if (faculty) facultyName = faculty.name_en || faculty.name_ar;

        let chatId = obj.chat_id || obj.Telegram_User_ID;
        if (!chatId && obj.update) {
          if (obj.update.message && obj.update.message.chat) chatId = obj.update.message.chat.id;
          else if (obj.update.callback_query && obj.update.callback_query.message && obj.update.callback_query.message.chat) chatId = obj.update.callback_query.message.chat.id;
        }

        let ctx = null;
        if (chatId) {
          ctx = this.userRuntimeContext.get(chatId.toString());
        }
        
        if (!ctx) ctx = {};
        else ctx = JSON.parse(JSON.stringify(ctx));

        const combined = { ...ctx, ...obj };
        const cid = chatId ? chatId.toString() : null;
        
        let history = [];
        if (cid) history = getUserHistory(cid);

        let menuPath = combined.menuPath || 'Unknown';
        let parentMenu = combined.parentMenuTitle || 'Unknown';
        let replyType = combined.replyType || combined.lastReplyType || 'Unknown';
        let currentMenu = combined.currentMenuTitle || 'Unknown';

        if (combined.currentMenuId) {
          try {
            const { getMenuPathContext } = require('./menu-builder');
            const pathCtx = await getMenuPathContext(combined.currentMenuId);
            if (pathCtx) {
              menuPath = pathCtx.menuPath;
              if (parentMenu === 'Unknown') {
                parentMenu = pathCtx.parentMenuTitle;
              }
              if (currentMenu === 'Unknown') currentMenu = pathCtx.currentMenuTitle;
              replyType = combined.lastReplyType || pathCtx.replyType || 'Unknown';
            }
          } catch (err) {
            console.error('Menu path context resolution failed', err);
            menuPath = 'Unknown (Error resolving path)';
          }
        }

        reportRuntimeError({
          Severity: combined.Severity || 'ERROR',
          Faculty_ID: this.facultyId,
          Faculty_Name: facultyName,
          Bot_ID: this.token ? this.token.split(':')[0] : '',
          Bot_Username: this.username || '',
          Request_ID: this.reqId,
          Error_Type: err ? err.name : 'BotError',
          Error_Message: err ? (err.message || String(err)) : 'Unknown Error',
          Stack_Trace: err ? err.stack : '',
          Operation: combined.currentOperation || msg,
          File_Name: 'bot-manager.js',
          Function_Name: 'TelegramBotService.logError',
          Telegram_User_ID: combined.telegramUserId || 'Unknown',
          Telegram_Full_Name: combined.firstName ? `${combined.firstName} ${combined.lastName !== 'Unknown' ? combined.lastName : ''}`.trim() : 'Unknown',
          Telegram_Username: combined.username || 'Unknown',
          Current_Menu_ID: combined.currentMenuId || 'Unknown',
          Current_Menu: currentMenu,
          Parent_Menu: parentMenu,
          Menu_Path: menuPath,
          Reply_Type: replyType,
          Current_Button: combined.currentButtonTitle || combined.lastButtonText || 'Unknown',
          Admin_State: combined.adminState || 'Unknown',
          Message_Text: combined.messageText || 'Unknown',
          Callback_Data: combined.callbackData || combined.lastButtonCallback || 'Unknown',
          Message_ID: combined.messageId || 'Unknown',
          Update_ID: combined.updateId || 'Unknown',
          Last_10_Operations: history,
          Telegram_Update: combined.update || null,
          HTTP_Request: combined.request || null,
          API_Payload: combined.api_payload || null,
          Session_ID: combined.sessionId || 'Unknown',
          Last_Button_Callback: combined.lastButtonCallback || 'Unknown',
          Last_Button_Text: combined.lastButtonText || 'Unknown',
          Last_Reply_Type: combined.lastReplyType || 'Unknown',
          Bot_Message_ID: combined.botMessageId || 'Unknown',
          File_Name_Sending: combined.fileName || 'Unknown',
          File_Mime_Type: combined.fileType || combined.mimeType || 'Unknown',
          File_Page_Number: combined.pageNumber !== undefined ? combined.pageNumber : 'Unknown',
          ...combined
        });
      } catch (innerErr) {
        reportRuntimeError({
          Severity: 'ERROR',
          Faculty_ID: this.facultyId,
          Request_ID: this.reqId,
          Error_Type: 'LogErrorCrash',
          Error_Message: innerErr.message,
          Stack_Trace: innerErr.stack,
          Operation: 'Extracting Context',
          File_Name: 'bot-manager.js',
          Function_Name: 'TelegramBotService.logError'
        });
      }
    })();
  }

  async getBotInfo() {
    const cacheKey = `bot_info:${this.facultyId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    try {
      const me = await this.apiCall('getMe', {});
      if (me.ok) {
        await cache.set(cacheKey, me.result, 86400); // cache for 1 day
        return me.result;
      }
    } catch(err) {
      this.logError('Failed to get bot info', err);
    }
    return null;
  }

  async registerWebhook() {
    const webhookUrl = `${process.env.WEBHOOK_URL}/api/telegram/webhook/${this.facultyId}`;
    const secret = getWebhookSecret(this.facultyId);
    
    this.logInfo(`Registering webhook: ${webhookUrl}`);
    
    const res = await this.apiCall('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      secret_token: secret,
      drop_pending_updates: false
    });
    
    if (!res.ok) {
      throw new Error(`Failed to set webhook: ${res.description}`);
    }
    
    // Attempt to register commands and cache bot info
    await this.registerBotCommands().catch(e => this.logError('Failed to register commands', e));
    await this.getBotInfo();
  }

  async deleteWebhook() {
    try {
      await this.apiCall('deleteWebhook', { drop_pending_updates: false });
      await cache.del(`bot_info:${this.facultyId}`);
      this.logInfo(`Webhook deleted`);
    } catch(err) {
      this.logError('Failed to delete webhook', err);
    }
  }

  // --- Webhook Update Handler ---
  async handleUpdate(update) {
    const startTime = Date.now();
    try {
      console.log("UPDATE RECEIVED:");
      console.log(JSON.stringify(update, null, 2));

      if (update.message) {
          await this.handleMessage(update.message);
      } else if (update.callback_query) {
          await this.handleCallbackQuery(update.callback_query);
      } else {
          console.log("UNKNOWN UPDATE TYPE");
      }
    } finally {
      const latency = Date.now() - startTime;
      if (!global.botLatencies) global.botLatencies = [];
      global.botLatencies.push(latency);
      if (global.botLatencies.length > 100) global.botLatencies.shift();
    }
  }

  // --- Message Handling ---
  async handleMessage(message) {
    const chatId = message.chat.id.toString();
    const text = message.text || '';
    
    this.updateUserContext(chatId, {
      telegramUserId: message.from.id,
      username: message.from.username || 'Unknown',
      firstName: message.from.first_name || 'Unknown',
      lastName: message.from.last_name || 'Unknown',
      messageText: text,
      messageId: message.message_id
    });

    try {
      const { logUserOperation } = require('./error-reporter');
      const dbHelper = require('./database');
      const adminStateRow = await dbHelper.pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [chatId]);
      const adminState = adminStateRow.rows.length > 0 ? adminStateRow.rows[0].state : null;
      logUserOperation(chatId, {
        type: 'MESSAGE',
        op: text.substring(0, 50),
        admin_state: adminState,
        message_text: text
      });
    } catch(e) {}

    const faculty = await dbHelper.getFacultyById(this.facultyId);
    if (!faculty) return;

    let isNewUserRegistration = false;
    let user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
    if (!user) {
      console.log(`[LANG] New user: showing language selector`);
      user = await dbHelper.upsertBotUser(
        this.facultyId, 
        'telegram', 
        chatId, 
        message.from.username || message.from.first_name, 
        null
      );
      isNewUserRegistration = true;
      monitor.onNewUser(this, message.from);
    } else {
      console.log(`[LANG] Existing user: id=${user.id}, language=${user.language}`);
      await dbHelper.updateUserActivity(this.facultyId, 'telegram', chatId);
    }

    if (isNewUserRegistration && faculty.notify_new_user) {
      const adminIds = (await dbHelper.getAdminsByFaculty(faculty.id)).filter(a => a.role === 'OWNER').map(a => a.chat_id);
      const notifyText = `👤 <b>مستخدم جديد دخل البوت</b>\n` +
                         `ا??سم: ${message.from.first_name || 'غير متوفر'}\n` +
                         `Username: ${message.from.username ? '@' + message.from.username : 'غير متوفر'}\n` +
                         `ID: <code>${chatId}</code>`;
      
      for (const adminId of adminIds) {
        await this.apiCall('sendMessage', {
          chat_id: adminId,
          text: notifyText,
          parse_mode: 'HTML'
        }).catch(() => {});
      }
    }

    const adminRole = await dbHelper.getAdminRole(faculty.id, chatId);
    const isAdmin = !!adminRole;
    if (faculty.bot_enabled === 0 && !isAdmin) {
      const disabledMsg = user.language === 'ar' 
        ? (faculty.disabled_message_ar || 'عذراً، البوت متوقف حالياً لإجراء بعض التحديثات.') 
        : (faculty.disabled_message_en || 'Sorry, the bot is temporarily offline for maintenance.');
      
      const res = await this.apiCall('sendMessage', { chat_id: chatId, text: disabledMsg, parse_mode: 'Markdown' });
      if (!res.ok) {
        await this.apiCall('sendMessage', { chat_id: chatId, text: disabledMsg });
      }
      return;
    }

    if (faculty.forward_user_messages && !isAdmin) {
      const adminIds = (await dbHelper.getAdminsByFaculty(faculty.id)).filter(a => a.role === 'OWNER').map(a => a.chat_id);
      for (const adminId of adminIds) {
        if (adminId) {
          const userStr = message.from.username ? `@${message.from.username}` : message.from.first_name;
          await this.apiCall('sendMessage', { 
            chat_id: adminId, 
            text: `🔴 **نشاط مباشر**\n\n👤 المستخدم: ${userStr} (ID: ${message.from.id})\n💬 النص: ${text}`,
            parse_mode: 'Markdown'
          });
        }
      }
    }


    const adminState = await dbHelper.getAdminState(chatId);

    if (text === '/start' || text.startsWith('/start ')) {
      if (adminState) {
        await dbHelper.deleteAdminState(chatId);
      }
      const parts = text.split(' ');
      if (parts.length > 1) {
        const fileIdMatch = parts[1].match(/^file_(\d+)$/);
        if (fileIdMatch) {
          const menuId = parseInt(fileIdMatch[1], 10);
          await this.handleDirectFileLink(chatId, menuId, user.language);
          return;
        }
      }

      await dbHelper.updateBotUserMenu(user.id, null);
      if (isNewUserRegistration || !user.language) {
        await this.sendLanguageSelection(chatId, user.language || 'ar');
      } else {
        await this.sendMenu(chatId, null, user.language);
      }
      return;
    }

    if ((text === '/admin' || text === t('en', 'MSG_ADMIN_81') || text === t('ar', 'MSG_ADMIN_81') || text === t(user.language, 'MSG_ADMIN_81') || text === 'MSG_ADMIN_81') && isAdmin) {
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.sendAdminHome(chatId, user.language);
      return;
    }

    if (adminState && isAdmin) {
      await this.handleAdminStateMessage(chatId, message, user.language, adminState);
      return;
    }

    if (text === '/changelanguage') {
      await this.sendLanguageSelection(chatId, user ? user.language : 'ar');
      return;
    }

    if (text === '/id' || text === '/myid') {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: `Your Telegram Chat ID is: \`${chatId}\``,
        parse_mode: 'Markdown'
      });
      return;
    }

    if (text === '/back' || text === t('en', 'BTN_BACK') || text === t('ar', 'BTN_BACK') || text === t(user.language, 'BTN_BACK') || text === 'BTN_BACK') {
      await this.handleBackNavigation(chatId, user);
      return;
    }

    if (text.startsWith('/search ') || text.startsWith('بحث ') || text.startsWith('ابحث ')) {
      const query = text.replace(/^\/search\s+|^بحث\s+|^ابحث\s+/i, '').trim();
      await this.searchFiles(chatId, query, user.language);
      return;
    }

    const currentMenuId = user.current_menu_id;
    const menus = await dbHelper.getMenusByFaculty(this.facultyId);
    const siblings = menus.filter(m => m.parent_id === currentMenuId);

    const clickedMenu = siblings.find(m => 
      (m.title_en && m.title_en.toLowerCase() === text.toLowerCase()) || 
      (m.title_ar && m.title_ar.toLowerCase() === text.toLowerCase())
    );

    if (clickedMenu) {
      await this.processMenuClick(chatId, user, clickedMenu, menus);
    } else {
      if (text === t(user.language, 'BTN_HOME') || text === t('ar', 'BTN_HOME') || text === t('en', 'BTN_HOME') || text === 'BTN_HOME') {
        await dbHelper.updateBotUserMenu(user.id, null);
        await this.sendMenu(chatId, null, user.language);
        return;
      }
      
      const faculty = await dbHelper.getFacultyById(this.facultyId);
      let unknownMsg = user.language === 'ar' ? (faculty.unknown_msg_ar || t('ar', 'UNKNOWN_MSG_FALLBACK')) : (faculty.unknown_msg_en || t('en', 'UNKNOWN_MSG_FALLBACK'));
      await this.apiCall('sendMessage', { chat_id: chatId, text: unknownMsg });
      await this.sendMenu(chatId, currentMenuId, user.language);
    }
  }

  async processMenuClick(chatId, user, clickedMenu, allMenus) {
    if (clickedMenu.is_active === false) {
      const msg = user.language === 'ar' ? '⛔ هذا الزر معطل حالياً.' : '⛔ This button is currently disabled.';
      await this.apiCall('sendMessage', { chat_id: chatId, text: msg });
      return;
    }

    if (user.language === 'en') {
      const translationService = require('./translation-service');
      await translationService.ensureTranslated(clickedMenu, 'menus', 'id', { title_ar: 'title_en', reply_content_ar: 'reply_content_en' });
    }

    await dbHelper.incrementMenuClickCount(clickedMenu.id);

    if (clickedMenu.reply_type === 'submenu') {
      await dbHelper.updateBotUserMenu(user.id, clickedMenu.id);
      await this.sendMenu(chatId, clickedMenu.id, user.language);
    } 
    else if (clickedMenu.reply_type === 'text') {
      const reply = user.language === 'ar' ? clickedMenu.reply_content_ar : clickedMenu.reply_content_en;
      let keyboard = null;
      
      if (clickedMenu.inline_buttons) {
        try {
          const btns = JSON.parse(clickedMenu.inline_buttons);
          if (btns && btns.length > 0) {
            keyboard = {
              inline_keyboard: btns.map(b => {
                const btn = { text: user.language === 'ar' ? b.text_ar : b.text_en };
                const link = (b.url || '').trim();
                if (link.startsWith('@')) {
                  btn.url = 'https://t.me/' + link.substring(1);
                } else if (link.startsWith('http') || link.startsWith('tg://')) {
                  btn.url = link;
                } else {
                  btn.callback_data = 'btn_cmd_' + link;
                }
                return [btn];
              })
            };
          }
        } catch(e) {
          this.logError('Failed to parse inline buttons', e, { chat_id: chatId });
        }
      }

      await this.apiCall('sendMessage', { 
        chat_id: chatId, 
        text: reply || (user.language === 'ar' ? 'لا يوجد محتوى' : 'No content'),
        reply_markup: keyboard,
        parse_mode: 'HTML'
      });
      await this.sendMenu(chatId, clickedMenu.parent_id, user.language);
    } 
    else if (clickedMenu.reply_type === 'file') {
    const caption = user.language === 'ar' ? clickedMenu.reply_content_ar : clickedMenu.reply_content_en;
      await this.sendFilePage(chatId, clickedMenu.id, 0, user.language, caption);
    }
  }

  async handleDirectFileLink(chatId, menuId, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu || menu.faculty_id !== this.facultyId || menu.reply_type !== 'file') {
        const err = t(lang, 'FILE_NOT_FOUND');
      await this.apiCall('sendMessage', { chat_id: chatId, text: err });
      return;
    }
    if (lang === 'en') {
      await translationService.ensureTranslated(menu, 'menus', 'id', { title_ar: 'title_en', reply_content_ar: 'reply_content_en' });
    }
    const caption = lang === 'ar' ? menu.reply_content_ar : menu.reply_content_en;
    await this.sendFilePage(chatId, menu.id, 0, lang, caption);
  }

  async handleBackNavigation(chatId, user) {
    if (!user.current_menu_id) {
      await this.sendMenu(chatId, null, user.language);
      return;
    }
    const currentMenu = await dbHelper.getMenuById(user.current_menu_id);
    if (currentMenu) {
      await dbHelper.updateBotUserMenu(user.id, currentMenu.parent_id);
      await this.sendMenu(chatId, currentMenu.parent_id, user.language);
    } else {
      await dbHelper.updateBotUserMenu(user.id, null);
      await this.sendMenu(chatId, null, user.language);
    }
  }

  async searchFiles(chatId, query, lang) {
    if (query.length < 2) {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'SEARCH_MIN_CHARS') });
      return;
    }
    
    const term = `%${query.toLowerCase()}%`;
    const { rows } = await dbHelper.runQuery(`
      SELECT * FROM menus 
      WHERE faculty_id = $1 
        AND reply_type = 'file' 
        AND (LOWER(title_en) LIKE $2 OR LOWER(title_ar) LIKE $2 OR LOWER(file_name) LIKE $2)
      LIMIT 10
    `, [this.facultyId, term]);

    if (rows.length === 0) {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'SEARCH_NO_RESULTS') });
      return;
    }

      let resultText = `${t(lang, 'SEARCH_RESULTS_FOR')} "${query}":\n\n`;
    const botInfo = await this.getBotInfo();
    const botUsername = botInfo ? botInfo.username : '';
    
    if (lang === 'en') {
      for (const row of rows) {
        await translationService.ensureTranslated(row, 'menus', 'id', { title_ar: 'title_en' });
      }
    }
    for (const row of rows) {
      const title = lang === 'ar' ? row.title_ar : row.title_en;
      resultText += `📄 ${title}\n🔗 https://t.me/${botUsername}?start=file_${row.id}\n\n`;
    }

    await this.apiCall('sendMessage', { chat_id: chatId, text: resultText, disable_web_page_preview: true });
  }

  async handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id.toString();
    
    let btnText = 'Unknown';
    if (callbackQuery.message.reply_markup && callbackQuery.message.reply_markup.inline_keyboard) {
      for (const row of callbackQuery.message.reply_markup.inline_keyboard) {
        for (const btn of row) {
          if (btn.callback_data === data) {
            btnText = btn.text;
          }
        }
      }
    }
    
    const dbHelper = require('./database');
    const faculty = await dbHelper.getFacultyById(this.facultyId);
    let user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
    if (!user) {
      user = await dbHelper.upsertBotUser(this.facultyId, 'telegram', chatId, callbackQuery.from.username || callbackQuery.from.first_name, null);
    } else {
      await dbHelper.updateUserActivity(this.facultyId, 'telegram', chatId);
    }
    const lang = user.language || 'ar';
    this.updateUserContext(chatId, {
      telegramUserId: callbackQuery.from.id,
      username: callbackQuery.from.username || 'Unknown',
      firstName: callbackQuery.from.first_name || 'Unknown',
      lastName: callbackQuery.from.last_name || 'Unknown',
      callbackData: data,
      lastButtonCallback: data,
      lastButtonText: btnText,
      callbackQueryId: callbackQuery.id
    });

    try {
      const { logUserOperation } = require('./error-reporter');
      const dbHelper = require('./database');
      const adminStateRow = await dbHelper.pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [chatId]);
      const adminState = adminStateRow.rows.length > 0 ? adminStateRow.rows[0].state : null;
      logUserOperation(chatId, {
        type: 'CALLBACK',
        op: data,
        admin_state: adminState,
        callback_data: data
      });
    } catch(e) {}

    try {
      const dbHelper = require('./database');
      const faculty = await dbHelper.getFacultyById(this.facultyId);
      const adminRole = await dbHelper.getAdminRole(faculty.id, chatId);
    const isAdmin = !!adminRole;
      if (faculty && faculty.forward_user_messages && !isAdmin) {
        const adminIds = (await dbHelper.getAdminsByFaculty(faculty.id)).filter(a => a.role === 'OWNER').map(a => a.chat_id);
        for (const adminId of adminIds) {
          if (adminId) {
            const userStr = callbackQuery.from.username ? `@${callbackQuery.from.username}` : callbackQuery.from.first_name;
            await this.apiCall('sendMessage', { 
              chat_id: adminId, 
              text: `🔴 **نشاط مباشر (زر)**\n\n👤 المستخدم: ${userStr} (ID: ${callbackQuery.from.id})\n🔘 الزر: ${btnText} (${data})`,
              parse_mode: 'Markdown'
            });
          }
        }
      }
    } catch(e) {}

    if (data.startsWith('btn_cmd_')) {
      const cmd = data.replace('btn_cmd_', '');
      const mockMessage = {
         from: callbackQuery.from,
         chat: callbackQuery.message.chat,
         text: cmd,
         message_id: callbackQuery.message.message_id,
         date: Math.floor(Date.now() / 1000)
      };
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
      // Use setImmediate to let this callback finish and avoid blocking
      setImmediate(() => {
        this.handleMessage(mockMessage).catch(e => this.logError('btn_cmd_ handleMessage failed', e));
      });
      return;
    }

    if (data.startsWith('lang_')) {
      const lang = data === 'lang_ar' ? 'ar' : 'en';

      let isNewUserRegistration = !user || !user.language;
      user = await dbHelper.upsertBotUser(this.facultyId, 'telegram', chatId, callbackQuery.from.username || callbackQuery.from.first_name, lang);
      user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      console.log(`[LANG] Language saved: ${user.language}`);
      
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

      const faculty = await dbHelper.getFacultyById(this.facultyId);
      if (lang === 'en' && faculty) {
        await translationService.ensureTranslated(faculty, 'faculties', 'id', {
          welcome_ar: 'welcome_en',
          disabled_message_ar: 'disabled_message_en',
          empty_msg_ar: 'empty_msg_en',
          unknown_msg_ar: 'unknown_msg_en',
          no_file_msg_ar: 'no_file_msg_en'
        });
      }
      if (isNewUserRegistration && faculty && faculty.notify_new_user) {
        const adminIds = (await dbHelper.getAdminsByFaculty(faculty.id)).filter(a => a.role === 'OWNER').map(a => a.chat_id);
        const notifyText = `👤 <b>مستخدم جديد دخل البوت</b>\n` +
                           `ا??سم: ${callbackQuery.from.first_name || 'غير متوفر'}\n` +
                           `Username: ${callbackQuery.from.username ? '@' + callbackQuery.from.username : 'غير متوفر'}\n` +
                           `ID: <code>${chatId}</code>`;
        for (const adminId of adminIds) {
          await this.apiCall('sendMessage', {
            chat_id: adminId,
            text: notifyText,
            parse_mode: 'HTML'
          }).catch(() => {});
        }
      }

      const welcome = lang === 'ar' 
        ? (faculty.welcome_ar || t(lang, 'LANGUAGE_UPDATED'))
        : (faculty.welcome_en || t(lang, 'LANGUAGE_UPDATED'));

      await this.apiCall('sendMessage', { chat_id: chatId, text: welcome });
      
      user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      await this.sendMenu(chatId, user ? user.current_menu_id : null, lang);
    }
    else if (data.startsWith('fp_')) {
      // File pagination: fp_menuId_page
      const parts = data.split('_');
      const menuId = parseInt(parts[1], 10);
      const page = parseInt(parts[2], 10);
      
      const { getMenuPathContext } = require('./menu-builder');
      const pathCtx = await getMenuPathContext(menuId);

      if (pathCtx) {
        this.updateUserContext(chatId, {
          currentMenuId: pathCtx.currentMenuId,
          currentMenuTitle: pathCtx.currentMenuTitle,
          parentMenuId: pathCtx.parentMenuId,
          parentMenuTitle: pathCtx.parentMenuTitle,
          menuPath: pathCtx.menuPath,
          lastReplyType: pathCtx.lastReplyType
        });
      }

      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
      // using global lang
      await this.sendFilePage(chatId, menuId, page, lang);
    }
    else if (data.startsWith('fe_')) {
      // File exit: close pagination
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: '✅' });
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    }
    else if (data.startsWith('del_file_')) {
      if (!(await dbHelper.hasPermission(chatId, this.facultyId, 'MANAGE_FILES'))) return this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Unauthorized', show_alert: true });
      const fileId = parseInt(data.replace('del_file_', ''), 10);
      const fRes = await dbHelper.runQuery('SELECT menu_id FROM menu_files WHERE id = $1', [fileId]);
      const fileMenuId = fRes.rows.length > 0 ? fRes.rows[0].menu_id : null;
      await dbHelper.setAdminState(chatId, { action: 'awaiting_del_file_confirm', fileId, menuId: fileMenuId });
      const confirmKb = { keyboard: [[{ text: t(lang, 'BTN_YES_DELETE_ICON') }], [{ text: t(lang, 'BTN_CANCEL') }]], resize_keyboard: true };
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1'), reply_markup: confirmKb });
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    }
    else if (data.startsWith('edit_ann_')) {
      if (!(await dbHelper.hasPermission(chatId, this.facultyId, 'ANNOUNCEMENTS'))) return this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Unauthorized', show_alert: true });
      const annId = parseInt(data.replace('edit_ann_', ''), 10);
      // using global lang
      await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_ann_text', annId });
      const cancelKb = { keyboard: [[{ text: t(lang, 'MSG_ADMIN_2') }]], resize_keyboard: true };
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_3'), reply_markup: cancelKb });
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    }
    else if (data.startsWith('del_sub_')) {
      if (!(await dbHelper.hasPermission(chatId, this.facultyId, 'MANAGE_FOLDERS'))) return this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Unauthorized', show_alert: true });
      const subId = data.replace('del_sub_', '');
      await dbHelper.setAdminState(chatId, { action: 'awaiting_del_sub_confirm', subId });
      const confirmKb = { keyboard: [[{ text: t(lang, 'BTN_YES_ICON') }, { text: t(lang, 'BTN_NO_ICON') }]], resize_keyboard: true };
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ARE_YOU_SURE'), reply_markup: confirmKb });
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    }
    else if (data.startsWith('del_ann_')) {
      if (!(await dbHelper.hasPermission(chatId, this.facultyId, 'ANNOUNCEMENTS'))) return this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Unauthorized', show_alert: true });
      const annId = parseInt(data.replace('del_ann_', ''), 10);
      await dbHelper.setAdminState(chatId, { action: 'awaiting_del_ann_confirm', annId });
      const confirmKb = { keyboard: [[{ text: t(lang, 'MSG_ADMIN_4') }], [{ text: t(lang, 'MSG_ADMIN_2') }]], resize_keyboard: true };
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1'), reply_markup: confirmKb });
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    }
    else if (data.startsWith('unpin_ann_')) {
      if (!(await dbHelper.hasPermission(chatId, this.facultyId, 'ANNOUNCEMENTS'))) return this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Unauthorized', show_alert: true });
      const annId = parseInt(data.replace('unpin_ann_', ''), 10);
      const annMsgList = await dbHelper.getAnnouncementMessages(annId);
      for (const msg of annMsgList) {
         try {
            await this.apiCall('unpinChatMessage', { chat_id: msg.chat_id, message_id: msg.message_id });
         } catch(e) {}
      }
      await dbHelper.runQuery('UPDATE announcements SET is_pinned = FALSE WHERE id = $1', [annId]);
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: '?? ????? التثبيت لدى الجميع.', show_alert: true });
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    }
    else if (data.startsWith('admin_')) {
      if (!(await dbHelper.hasPermission(chatId, this.facultyId, 'MANAGE_FOLDERS')) && !(await dbHelper.hasPermission(chatId, this.facultyId, 'MANAGE_FILES'))) return this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Unauthorized', show_alert: true });
      // using global lang
      const action = data.split('_')[1];
      const menuId = parseInt(data.split('_')[2], 10);
      const cancelKb = { keyboard: [[{ text: t(lang, 'MSG_ADMIN_2') }]], resize_keyboard: true };

      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

      if (action === 'rename') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_rename_title_ar', menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_5'), reply_markup: cancelKb });
      } else if (action === 'delbtn') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_del_btn_confirm', menuId });
        const confirmKb = { keyboard: [[{ text: t(lang, 'MSG_ADMIN_4') }], [{ text: t(lang, 'MSG_ADMIN_2') }]], resize_keyboard: true };
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1'), reply_markup: confirmKb });
      } else if (action === 'open') {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuId, viewingMenuDetailsId: null });
        await this.sendAdminReplyMenus(chatId, menuId, lang);
      } else if (action === 'delcontent') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_del_content_confirm', menuId });
        const confirmKb = { keyboard: [[{ text: t(lang, 'BTN_YES_DELETE_ICON') }], [{ text: t(lang, 'BTN_CANCEL') }]], resize_keyboard: true };
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1'), reply_markup: confirmKb });
      } else if (action === 'previewfiles') {
        const menu = await dbHelper.getMenuById(menuId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_6') });
        await this.sendFilePage(chatId, menuId, 0, lang, lang === 'ar' ? menu.reply_content_ar : menu.reply_content_en, true);
        await this.sendAdminMenuDetails(chatId, menuId, lang); // send details again at bottom
      } else if (action === 'addfile') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_file_doc', menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_7'), reply_markup: cancelKb });
      } else if (action === 'edittext') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_text_ar', menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_8'), reply_markup: cancelKb });
      } else if (action === 'inline') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_inline_btn', menuId });
        const m = t(lang, 'MSG_ADMIN_9');
        await this.apiCall('sendMessage', { chat_id: chatId, text: m, reply_markup: cancelKb });
      } else if (action === 'move') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_move_dest', menuId });
        const m = t(lang, 'MSG_ADMIN_10');
        
        const allMenus = await dbHelper.getMenusByFaculty(this.facultyId);
        const folders = allMenus.filter(f => f.reply_type === 'submenu' && f.id !== menuId);
        const kb = [];
        kb.push([{ text: 'null' }]);
        
        for (let i = 0; i < folders.length; i += 2) {
          const row = [];
          row.push({ text: `${folders[i].id} - ${lang === 'ar' ? folders[i].title_ar : folders[i].title_en}` });
          if (i + 1 < folders.length) {
            row.push({ text: `${folders[i+1].id} - ${lang === 'ar' ? folders[i+1].title_ar : folders[i+1].title_en}` });
          }
          kb.push(row);
        }
        kb.push([{ text: t(lang, 'MSG_ADMIN_2') }]);
        
        await this.apiCall('sendMessage', { chat_id: chatId, text: m, reply_markup: { keyboard: kb, resize_keyboard: true } });
      } else if (action === 'order') {
        const menu = await dbHelper.getMenuById(menuId);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus_move_order', menuId, currentMenuId: menu ? menu.parent_id : null });
        const AdminMenuNavigation = require('./admin-menu-navigation');
        await AdminMenuNavigation.sendAdminMoveOrderPosition(this, chatId, menuId, lang);
      } else if (action === 'toggleactive') {
        const menu = await dbHelper.getMenuById(menuId);
        await dbHelper.toggleMenuStatus(menuId, 'is_active', menu.is_active === false ? true : false);
        await this.sendAdminMenuDetails(chatId, menuId, lang);
      } else if (action === 'togglehidden') {
        const menu = await dbHelper.getMenuById(menuId);
        await dbHelper.toggleMenuStatus(menuId, 'is_hidden', menu.is_hidden === true ? false : true);
        await this.sendAdminMenuDetails(chatId, menuId, lang);
      }
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    }
  }

  // --- Admin State Machine ---
  getAdminActionFromText(text) {
    if (!text) return null;
    const trimmedText = text.trim();
    
    // Check against English and Arabic localization keys
    const match = (key) => trimmedText === t('ar', key) || trimmedText === t('en', key);

    if (match('BTN_MANAGE_MENUS')) return 'manage_menus';
    if (match('BTN_MANAGE_FOLDERS')) return 'manage_folders';
    if (match('BTN_NEW_ANNOUNCEMENT')) return 'new_announcement';
    if (match('BTN_MANAGE_ANNOUNCEMENTS')) return 'manage_announcements';
    if (match('BTN_STATISTICS')) return 'statistics';
    if (match('BTN_SETTINGS')) return 'core_settings';
    
    if (match('BTN_MANAGE_ADMINS')) return 'manage_admins'; // Sub-admins alias
    if (match('BTN_MANAGE_SUBADMINS')) return 'manage_admins';
    if (match('BTN_MANAGE_DEPUTIES')) return 'manage_deputies';
    
    if (match('BTN_MONITORING')) return 'admin_monitoring';
    if (match('BTN_ENABLE_MONITORING')) return 'enable_monitoring';
    if (match('BTN_DISABLE_MONITORING')) return 'disable_monitoring';
    
    if (match('BTN_ADD') || match('BTN_ADD_SUBADMIN')) return 'add_subadmin';
    if (match('BTN_VIEW') || match('BTN_VIEW_SUBADMINS')) return 'view_subadmins';
    if (match('BTN_REMOVE') || match('BTN_REMOVE_SUBADMIN')) return 'remove_subadmin';
    
    if (match('BTN_BACK')) return 'back';
    if (match('BTN_CLOSE')) return 'close';
    if (match('BTN_CANCEL') || trimmedText === '/cancel') return 'cancel';

    // Settings Keyboard
    if (match('BTN_CFG_WELCOME')) return 'cfg_welcome';
    if (match('BTN_CFG_MAINTENANCE')) return 'cfg_maintenance';
    if (match('BTN_CFG_EMPTY_BTN')) return 'cfg_empty_btn';
    if (match('BTN_CFG_UNKNOWN_TEXT')) return 'cfg_unknown_text';
    if (match('BTN_CFG_NO_FILE')) return 'cfg_no_file';
    if (match('BTN_CFG_HOME')) return 'cfg_home';

    // Global
    if (match('BTN_LIVE_ACTIVITY')) return 'live_activity';
    
    return null;
  }

  async handleAdminStateMessage(chatId, message, lang, state) {
    let text = message.text || '';
    const actionId = this.getAdminActionFromText(text);

    const role = await dbHelper.getAdminRole(this.facultyId, chatId);
    
    // Centralized Permission Checking via AdminRoutes
    if (actionId && AdminRoutes[actionId]) {
      const allowedRoles = AdminRoutes[actionId].roles;
      if (!allowedRoles.includes(role)) {
        console.warn('[SECURITY] Denied Attempt', { 
          chatId, 
          username: message.from.username, 
          role, 
          actionId, 
          timestamp: new Date() 
        });
        await this.apiCall('sendMessage', { 
          chat_id: chatId, 
          text: t(lang, 'ERR_NO_PERMISSION') 
        });
        return;
      }
    }

    console.log('[Admin Button]:', text);
    console.log('[Resolved Action]:', actionId);
    console.log('[Current Role]:', role);
    console.log('[Current State]:', state.action);
    console.log('[Permission]:', role ? 'GRANTED' : 'DENIED');
    console.log('[Handler Executed]:', 'handleAdminStateMessage');

    // Global admin intercepts for navigation
    if (actionId === 'close') {
      await dbHelper.deleteAdminState(chatId);
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_PANEL_CLOSED'), reply_markup: { remove_keyboard: true } });
      const userObj = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      if (userObj) {
        await dbHelper.updateBotUserMenu(userObj.id, null);
        await this.sendMenu(chatId, null, userObj.language);
      }
      return;
    }

    if (actionId === 'admin_home' || actionId === 'cfg_home') {
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.sendAdminHome(chatId, lang);
      return;
    }

    if (actionId === 'cancel') {
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ACTION_CANCELLED') });
      await this.sendAdminHome(chatId, lang);
      return;
    }

    if (actionId === 'back') {
      if (state.action === 'awaiting_new_admin_id' || state.action === 'awaiting_remove_admin_id') {
        const targetRole = state.targetRole || 'SUB_ADMIN';
        const isDeputy = targetRole === 'DEPUTY_ADMIN';
        const roleTitle = isDeputy ? (t(lang, 'MSG_ADMIN_11')) : (t(lang, 'MSG_ADMIN_12'));
        const keyboard = [
          [{ text: t(lang, 'BTN_ADD') }],
          [{ text: t(lang, 'BTN_VIEW') }],
          [{ text: t(lang, 'BTN_REMOVE') }],
          [{ text: t(lang, 'BTN_BACK') }]
        ];
        await dbHelper.setAdminState(chatId, { action: isDeputy ? 'admin_manage_deputies_menu' : 'admin_manage_admins_menu' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: roleTitle, reply_markup: { keyboard, resize_keyboard: true } });
        return;
      }

      // Let admin-menu-navigation handle back if we are managing menus
      if (state.action && state.action.startsWith('managing_menus')) {
          // fall through to local handlers
      } else if (state.action && state.action.startsWith('managing_config')) {
          // config has no separate back handler, go to admin_home
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.sendAdminHome(chatId, lang);
          return;
      } else {
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.sendAdminHome(chatId, lang);
          return;
      }
    }

    const premiumTextStates = [
      'awaiting_edit_submenu_ar',
      'awaiting_edit_text_ar',
      'awaiting_edit_file_cap_ar',
      'awaiting_welcome_ar',
      'awaiting_disabled_msg_ar',
      'awaiting_empty_msg_ar',
      'awaiting_unknown_msg_ar',
      'awaiting_no_file_msg_ar',
      'awaiting_announcement_text',
      'awaiting_edit_ann_text'
    ];
    if (premiumTextStates.includes(state.action)) {
      text = this.parsePremiumEmojis(message) || text;
    }

    const cancelKb = { keyboard: [[{ text: t(lang, 'MSG_ADMIN_2') }]], resize_keyboard: true };

    // --- HOME MENU ---
    if (state.action === 'admin_home') {
      if (actionId === 'manage_menus') {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: null, viewingMenuDetailsId: null });
        await this.sendAdminReplyMenus(chatId, null, lang);
      } else if (actionId === 'new_announcement' || actionId === 'manage_announcements' || actionId === 'statistics') {
        if (actionId === 'new_announcement') {
          await dbHelper.setAdminState(chatId, { action: 'awaiting_announcement_text' });
          const cancelKb = { keyboard: [[{ text: t(lang, 'BTN_CANCEL_OP') }]], resize_keyboard: true };
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_13'), reply_markup: cancelKb });
        } else if (actionId === 'manage_announcements') {
          await this.sendAdminAnnouncementsList(chatId, lang);
        } else if (actionId === 'statistics') {
          const pool = dbHelper.pool;
        
        const usersRes = await pool.query('SELECT created_at, last_active_at, is_blocked FROM bot_users WHERE faculty_id = $1 AND platform = $2', [this.facultyId, 'telegram']);
        const allUsers = usersRes.rows;
        
        const now = new Date();
        const oneDay = 24 * 60 * 60 * 1000;
        
        let dailyActive = 0, weeklyActive = 0, monthlyActive = 0;
        let weeklySubscribers = 0, monthlySubscribers = 0;
        let blockedUsers = 0;
        
        allUsers.forEach(u => {
          if (u.is_blocked) blockedUsers++;
          
          if (u.last_active_at) {
             const diff = now - new Date(u.last_active_at);
             if (diff <= oneDay) dailyActive++;
             if (diff <= 7 * oneDay) weeklyActive++;
             if (diff <= 30 * oneDay) monthlyActive++;
          }
          
          if (u.created_at) {
             const diff = now - new Date(u.created_at);
             if (diff <= 7 * oneDay) weeklySubscribers++;
             if (diff <= 30 * oneDay) monthlySubscribers++;
          }
        });
        
        const totalUsers = allUsers.length;
        const nonBlocked = totalUsers - blockedUsers;
        const reachPercentage = nonBlocked > 0 ? ((monthlyActive / nonBlocked) * 100).toFixed(1) : 0;
        const logRes = await pool.query('SELECT COUNT(*) as cnt FROM bot_users_log WHERE faculty_id = $1', [this.facultyId]);
        const totalRequests = logRes.rows[0].cnt;
        
        const menusRes = await pool.query('SELECT COUNT(*) as cnt FROM menus WHERE faculty_id = $1', [this.facultyId]);
        const totalButtons = menusRes.rows[0].cnt;
        
        const filesRes = await pool.query('SELECT COUNT(*) as cnt FROM menu_files mf JOIN menus m ON mf.menu_id = m.id WHERE m.faculty_id = $1', [this.facultyId]);
        const totalFiles = filesRes.rows[0].cnt;
        
        const topMenuRes = await pool.query('SELECT title_ar, title_en, click_count FROM menus WHERE faculty_id = $1 ORDER BY click_count DESC LIMIT 1', [this.facultyId]);
        let topButtonStr = (t(lang, 'MSG_ADMIN_14'));
        if (topMenuRes.rows.length > 0 && topMenuRes.rows[0].click_count > 0) {
           const tm = topMenuRes.rows[0];
           topButtonStr = ` ()`;
        }
        
        let avgLatency = 0;
        if (global.botLatencies && global.botLatencies.length > 0) {
           const sum = global.botLatencies.reduce((a, b) => a + b, 0);
           avgLatency = (sum / global.botLatencies.length).toFixed(0);
        }
        
        const statsAr = `📊 **إحصائيات البوت الشاملة:**\n\n` +
          `👥 **المشتركون**\n` +
          `- إجمالي المشتركين: ${totalUsers}\n` +
          `- المشتركون الجدد (أسبوع): ${weeklySubscribers}\n` +
          `- المشتركون الجدد (شهر): ${monthlySubscribers}\n\n` +
          `📈 **النشاط**\n` +
          `- نشط اليوم: ${dailyActive}\n` +
          `- نشط هذا الأسبوع: ${weeklyActive}\n` +
          `- نشط هذا الشهر: ${monthlyActive}\n\n` +
          `🚀 **الأداء والتفاعل**\n` +
          `- نسبة الوصول (شهرياً): ${reachPercentage}%\n` +
          `- إجمالي الطلبات/التفاعلات: ${totalRequests}\n` +
          `- زمن الاستجابة (متوسط): ${avgLatency}ms\n\n` +
          `🗂️ **المحتوى**\n` +
          `- عدد الأزرار المتاحة: ${totalButtons}\n` +
          `- عدد الملفات المرفوعة: ${totalFiles}\n` +
          `- الزر الأكثر طلباً: ${topButtonStr}\n\n` +
          `🛑 **الحظر**\n` +
          `- عدد من قام بحظر أو حذف البوت: ${blockedUsers}`;
          
        const statsEn = `📊 **Bot Statistics:**\n\n` +
          `👥 **Subscribers**\n` +
          `- Total: ${totalUsers}\n` +
          `- New (Weekly): ${weeklySubscribers}\n` +
          `- New (Monthly): ${monthlySubscribers}\n\n` +
          `📈 **Activity**\n` +
          `- Daily Active: ${dailyActive}\n` +
          `- Weekly Active: ${weeklyActive}\n` +
          `- Monthly Active: ${monthlyActive}\n\n` +
          `🚀 **Performance**\n` +
          `- Reach (Monthly): ${reachPercentage}%\n` +
          `- Total Requests: ${totalRequests}\n` +
          `- Avg Latency: ${avgLatency}ms\n\n` +
          `🗂️ **Content**\n` +
          `- Total Buttons: ${totalButtons}\n` +
          `- Total Files: ${totalFiles}\n` +
          `- Top Button: ${topButtonStr}\n\n` +
          `🛑 **Blocks**\n` +
          `- Blocked By: ${blockedUsers}`;
        
        await this.apiCall('sendMessage',
 { chat_id: chatId, text: lang === 'ar' ? statsAr : statsEn, parse_mode: 'Markdown' });
        }
      } else if (actionId === 'core_settings' || actionId === 'manage_admins' || actionId === 'manage_deputies' || actionId === 'admin_monitoring') {
        if (actionId === 'core_settings') {
          await dbHelper.setAdminState(chatId, { action: 'managing_config' });
          const fac = await dbHelper.getFacultyById(this.facultyId);
          const monStatus = fac.forward_user_messages ? t(lang, 'MSG_ADMIN_15') : t(lang, 'MSG_ADMIN_16');
          const cfgText = (lang === 'ar' ? 'إعدادات\n\nالمراقبة: ' : 'Settings\n\nMonitoring: ') + monStatus;
          const cfgKb = [
            [{ text: t(lang, 'BTN_CFG_WELCOME') }, { text: t(lang, 'BTN_CFG_MAINTENANCE') }],
            [{ text: t(lang, 'BTN_CFG_EMPTY_BTN') }, { text: t(lang, 'BTN_CFG_UNKNOWN_TEXT') }],
            [{ text: t(lang, 'BTN_CFG_NO_FILE') }],
            [{ text: t(lang, 'BTN_CFG_HOME') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: cfgText, reply_markup: { keyboard: cfgKb, resize_keyboard: true } });
        } else if (actionId === 'manage_admins' || actionId === 'manage_deputies') {
          const isDeputy = actionId === 'manage_deputies';
          const roleTitle = isDeputy ? t(lang, 'MSG_ADMIN_11') : t(lang, 'MSG_ADMIN_12');
          const keyboard = [
            [{ text: t(lang, 'BTN_ADD') }],
            [{ text: t(lang, 'BTN_VIEW') }],
            [{ text: t(lang, 'BTN_REMOVE') }],
            [{ text: t(lang, 'BTN_BACK') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: roleTitle, reply_markup: { keyboard, resize_keyboard: true } });
          await dbHelper.setAdminState(chatId, { action: isDeputy ? 'admin_manage_deputies_menu' : 'admin_manage_admins_menu' });
        } else if (actionId === 'admin_monitoring') {
          const keyboard = [
            [{ text: t(lang, 'BTN_ENABLE_MONITORING') }],
            [{ text: t(lang, 'BTN_DISABLE_MONITORING') }],
            [{ text: t(lang, 'BTN_BACK') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'BTN_MONITORING') + ':', reply_markup: { keyboard, resize_keyboard: true } });
          await dbHelper.setAdminState(chatId, { action: 'admin_monitoring_menu' });
        }
      }
      return;
    }

    // --- CORE SETTINGS ---
    if (state.action === 'managing_config') {
      if (text.includes('نشاط مباشر') || text.includes('Live Activity')) {
        const fac = await dbHelper.getFacultyById(this.facultyId);
        await dbHelper.toggleFacultyForwarding(this.facultyId, !fac.forward_user_messages);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_17') });
        return this.handleAdminStateMessage(chatId, { text: t(lang, 'MSG_ADMIN_18') }, lang, { action: 'managing_admin' });
      } else if (actionId === 'cfg_welcome') {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_19'), reply_markup: cancelKb });
      } else if (actionId === 'cfg_maintenance') {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_20'), reply_markup: cancelKb });
      } else if (actionId === 'cfg_empty_btn') {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_21'), reply_markup: cancelKb });
      } else if (actionId === 'cfg_unknown_text') {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_22'), reply_markup: cancelKb });
      } else if (actionId === 'cfg_no_file') {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_23'), reply_markup: cancelKb });
      }
    }

    // --- MANAGING MENUS ---
    const AdminMenuNavigation = require('./admin-menu-navigation');
    console.log(`[DEBUG bot-manager] text: "${text}", action: "${state.action}", currentMenuId: ${state.currentMenuId}`);
    const handledByAdminNav = await AdminMenuNavigation.handleNavigation(this, chatId, text, state, lang);
    if (handledByAdminNav) return;

    // --- NORMAL AWAITING STATES ---
    if (state.action === 'admin_manage_admins_menu' || state.action === 'admin_manage_deputies_menu') {
      const targetRole = state.action === 'admin_manage_admins_menu' ? 'SUB_ADMIN' : 'DEPUTY_ADMIN';
      const roleName = targetRole === 'SUB_ADMIN' ? t(lang, 'MSG_ADMIN_24') : t(lang, 'MSG_ADMIN_25');
      if (actionId === 'add_subadmin' || actionId === 'add_deputy') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_new_admin_id', targetRole });
        const cancelKb = { keyboard: [[{ text: t(lang, 'BTN_CANCEL') }]], resize_keyboard: true };
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_26').replace('${roleName}', roleName), reply_markup: cancelKb });
      } else if (actionId === 'view_subadmins' || actionId === 'view_deputies') {
        const admins = await dbHelper.getAdminsByFaculty(this.facultyId);
        const targets = admins.filter(a => a.role === targetRole);
        if (targets.length === 0) {
           await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_27').replace('${roleName}', roleName) });
           return;
        }
        let msgText = t(lang, 'MSG_ADMIN_28') + targets.length + '\n\n';
        for (const tAdmin of targets) {
           const secUserRes = await dbHelper.pool.query('SELECT username, language, created_at FROM bot_users WHERE chat_id = $1', [tAdmin.chat_id]);
           const secUser = secUserRes.rows[0];
           msgText += `ID: <code>${tAdmin.chat_id}</code>\n`;
           if (secUser) {
              msgText += `Name: ${secUser.username || 'Unknown'}\nLanguage: ${secUser.language || 'N/A'}\nRegistered: ${secUser.created_at ? new Date(secUser.created_at).toLocaleString() : 'Unknown'}\n\n`;
           } else {
              msgText += `Name: Unknown\n\n`;
           }
        }
        await this.apiCall('sendMessage', { chat_id: chatId, text: msgText, parse_mode: 'HTML' });
        return;
      } else if (actionId === 'remove_subadmin' || actionId === 'remove_deputy') {
        const admins = await dbHelper.getAdminsByFaculty(this.facultyId);
        const targets = admins.filter(a => a.role === targetRole);
        if (targets.length === 0) {
           await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_NO_SECONDARY_ADMINS') });
           return;
        }
        const inlineKeyboard = targets.map(a => ([{ text: 'ID: ' + a.chat_id, callback_data: 'del_sub_' + a.chat_id }]));
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_CHOOSE_ADMIN_TO_REMOVE'), reply_markup: { inline_keyboard: inlineKeyboard } });
        return;
      }
    }
    
    if (state.action === 'admin_monitoring_menu') {
      if (actionId === 'enable_monitoring' || actionId === 'disable_monitoring') {
        const isEnable = actionId === 'enable_monitoring';
        await dbHelper.updateMonitoringEnabled(this.facultyId, isEnable);
        await this.apiCall('sendMessage', { chat_id: chatId, text: isEnable ? t(lang, 'MSG_MONITORING_ENABLED') : t(lang, 'MSG_MONITORING_DISABLED') });
        await dbHelper.setAdminState(chatId, { action: 'admin_home' });
        await this.sendAdminHome(chatId, lang);
        return;
      }
    }

    switch (state.action) {
      case 'awaiting_new_admin_id': {
        const targetRole = state.targetRole || 'SUB_ADMIN';
        const roleName = targetRole === 'SUB_ADMIN' ? t(lang, 'MSG_ADMIN_24') : t(lang, 'MSG_ADMIN_25');
        const nextStateAction = targetRole === 'SUB_ADMIN' ? 'admin_manage_admins_menu' : 'admin_manage_deputies_menu';
        if (text === '❌ إلغاء' || text === '❌ Cancel' || text === '⭅️ Cancel Operation' || text === '⭅️ إلغاء الأمد' || text === t(lang, 'BTN_CANCEL_OP')) {
          await dbHelper.setAdminState(chatId, { action: nextStateAction });
          const keyboard = [
            [{ text: t(lang, 'BTN_ADD') }],
            [{ text: t(lang, 'BTN_VIEW') }],
            [{ text: t(lang, 'BTN_REMOVE') }],
            [{ text: t(lang, 'MSG_ADMIN_29') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_30'), reply_markup: { keyboard, resize_keyboard: true } });
          return;
        }
        if (!/^\d+/.test(text)) {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_31') });
          return;
        }
        const existingRole = await dbHelper.getAdminRole(this.facultyId, text, targetRole);
        if (existingRole) {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_32') });
        } else {
          await dbHelper.createAdmin(text, targetRole, this.facultyId);
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_33').replace('${roleName}', roleName) });
          await dbHelper.setAdminState(chatId, { action: nextStateAction });
          const keyboard = [
            [{ text: t(lang, 'BTN_ADD') }],
            [{ text: t(lang, 'BTN_VIEW') }],
            [{ text: t(lang, 'BTN_REMOVE') }],
            [{ text: t(lang, 'MSG_ADMIN_29') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_34').replace('${roleName}', roleName), reply_markup: { keyboard, resize_keyboard: true } });
        }
        break;
      }
      case 'awaiting_announcement_text': {
        const lines = text.split('\n');
        state.titleAr = lines[0].trim();
        state.contentAr = lines.slice(1).join('\n').trim() || ' '; // To ensure content isn't strictly empty
        state.titleEn = '';
        state.contentEn = '';
        state.action = 'awaiting_announcement_file';
        await dbHelper.setAdminState(chatId, state);
        
        const fileKb = {
          keyboard: [
             [{ text: t(lang, 'MSG_ADMIN_35') }],
             [{ text: t(lang, 'MSG_ADMIN_2') }]
          ],
          resize_keyboard: true
        };
        await this.apiCall('sendMessage', { 
          chat_id: chatId, 
          text: t(lang, 'MSG_ADMIN_36'), 
          reply_markup: fileKb 
        });
        break;
      }
      case 'awaiting_announcement_file': {
        let doc = null;
        if (text !== '/skip' && text !== '/skip (تخطي بدون ملف)' && text !== t(lang, 'MSG_ADMIN_35')) {
          doc = this.extractTelegramAttachment(message);
          if (!doc) {
            await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_37') });
            return;
          }
        }
        state.doc = doc;
        state.action = 'awaiting_announcement_pin';
        await dbHelper.setAdminState(chatId, state);

        const pinKb = {
          keyboard: [
             [{ text: t(lang, 'MSG_ADMIN_38') }, { text: t(lang, 'MSG_ADMIN_39') }],
             [{ text: t(lang, 'MSG_ADMIN_2') }]
          ],
          resize_keyboard: true
        };
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'MSG_ADMIN_40'),
          reply_markup: pinKb
        });
        break;
      }
      case 'awaiting_announcement_pin': {
        state.isPinned = text === 'نعم (تثبيت)' || text === 'Yes (Pin)' || text === t(lang, 'MSG_ADMIN_38');
        await this.handleAdminAnnouncementBroadcast(chatId, state, lang);
        break;
      }

      case 'awaiting_edit_ann_text': {
        const editLines = text.split('\n');
        const eTitleAr = editLines[0].trim();
        const eContentAr = editLines.slice(1).join('\n').trim() || ' ';
        const eTitleEn = '';
        const eContentEn = '';
        
        await dbHelper.updateAnnouncementContent(state.annId, eTitleAr, eTitleEn, eContentAr, eContentEn);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_41') });
        
        (async () => {
          const msgs = await dbHelper.getAnnouncementMessages(state.annId);
          const updatedAnn = await dbHelper.getAnnouncementById(state.annId);
          const translationService = require('./translation-service');
          for (const msg of msgs) {
            try {
               const u = await dbHelper.getBotUser(this.facultyId, 'telegram', msg.chat_id);
               const uLang = u ? u.language : 'ar';
               
               if (uLang === 'en') {
                 await translationService.ensureTranslated(updatedAnn, 'announcements', 'id', { title_ar: 'title_en', content_ar: 'content_en' });
               }
               const msgTitle = uLang === 'ar' ? updatedAnn.title_ar : updatedAnn.title_en;
               const msgContent = uLang === 'ar' ? updatedAnn.content_ar : updatedAnn.content_en;
               const txt = `📢 *${msgTitle}*\n\n${msgContent}\n\n${updatedAnn.is_pinned ? '📌 (Pinned)' : ''}`;
               await this.apiCall('editMessageText', { chat_id: msg.chat_id, message_id: msg.message_id, text: txt, parse_mode: 'Markdown' });
            } catch(e) {}
          }
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_42') });
        })();
        
        await dbHelper.deleteAdminState(chatId);
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_del_sub_confirm': {
        const delRole = await dbHelper.getAdminRole(this.facultyId, state.subId);
        const nextDelState = delRole === 'SUB_ADMIN' ? 'admin_manage_admins_menu' : 'admin_manage_deputies_menu';
        
        if (text === t(lang, 'BTN_YES_ICON') || text === '✅ نعم، حذف' || text === '✅ Yes, Delete') {
           if (!delRole) {
               await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1') });
           } else if (delRole === 'OWNER') {
               await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_43') });
           } else {
               await dbHelper.deleteAdmin(state.subId);
               await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_44') });
           }
        }
        await dbHelper.setAdminState(chatId, { action: nextDelState });
        const keyboard = [
          [{ text: t(lang, 'BTN_ADD') }],
          [{ text: t(lang, 'BTN_VIEW') }],
          [{ text: t(lang, 'BTN_REMOVE') }],
          [{ text: t(lang, 'MSG_ADMIN_29') }]
        ];
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_45'), reply_markup: { keyboard, resize_keyboard: true } });
        break;
      }

      case 'awaiting_del_ann_confirm': {
        if (text === '✅ نعم، حذف' || text === '✅ Yes, Delete') {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_46') });
          (async () => {
            const msgs = await dbHelper.getAnnouncementMessages(state.annId);
            for (const msg of msgs) {
              try {
                 await this.apiCall('deleteMessage', { chat_id: msg.chat_id, message_id: msg.message_id });
              } catch(e) {}
            }
            await dbHelper.deleteAnnouncement(state.annId);
            await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_47') });
          })();
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_DELETION_CANCELLED') });
        }
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_del_btn_confirm': {
        if (text === '✅ نعم، حذف' || text === '✅ Yes, Delete') {
          const menu = await dbHelper.getMenuById(state.menuId);
          await dbHelper.deleteMenu(state.menuId);
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_48'), reply_markup: { remove_keyboard: true } });
          if (menu && menu.parent_id !== null) {
            const AdminMenuNavigation = require('./admin-menu-navigation');
            await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id, viewingMenuDetailsId: null });
            await AdminMenuNavigation.sendAdminReplyMenus(this, chatId, menu.parent_id, lang);
          } else {
            await dbHelper.deleteAdminState(chatId);
            await this.sendAdminHome(chatId, lang);
          }
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_DELETION_CANCELLED') });
        }
        break;
      }

      case 'awaiting_del_content_confirm': {
        if (text === '✅ نعم، حذف' || text === '✅ Yes, Delete') {
          await dbHelper.runQuery('DELETE FROM menu_files WHERE menu_id = $1', [state.menuId]);
          await dbHelper.runQuery('UPDATE menus SET reply_content_ar = NULL, reply_content_en = NULL, inline_buttons = NULL WHERE id = $1', [state.menuId]);
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_49'), reply_markup: { remove_keyboard: true } });
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_DELETION_CANCELLED') });
        }
        await dbHelper.setAdminState(chatId, { action: 'admin_home' });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_del_file_confirm': {
        if (text === '✅ نعم، حذف' || text === '✅ Yes, Delete') {
          await dbHelper.runQuery('DELETE FROM menu_files WHERE id = $1', [state.fileId]);
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_50'), reply_markup: { remove_keyboard: true } });
          if (state.menuId) {
            const AdminMenuNavigation = require('./admin-menu-navigation');
            await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.menuId, viewingMenuDetailsId: null });
            await AdminMenuNavigation.sendAdminMenuDetails(this, chatId, state.menuId, lang);
          } else { 
            await dbHelper.deleteAdminState(chatId); 
            await this.sendAdminHome(chatId, lang); 
          }
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_DELETION_CANCELLED'), reply_markup: { remove_keyboard: true } });
          if (state.menuId) {
            const AdminMenuNavigation = require('./admin-menu-navigation');
            await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.menuId, viewingMenuDetailsId: null });
            await AdminMenuNavigation.sendAdminMenuDetails(this, chatId, state.menuId, lang);
          } else {
            await dbHelper.deleteAdminState(chatId);
            await this.sendAdminHome(chatId, lang);
          }
        }
        break;
      }

      case 'awaiting_rename_title_ar': {
        const rTitleEn = await this.translateArToEn(text);
        const rMenu = await dbHelper.getMenuById(state.menuId);
        await dbHelper.updateMenu(state.menuId, rMenu.parent_id, rTitleEn, text, rMenu.reply_type, rMenu.reply_content_en, rMenu.reply_content_ar, rMenu.file_name, rMenu.telegram_file_id, rMenu.mime_type, rMenu.file_size, rMenu.sort_order, rMenu.row_index);
        await dbHelper.setAdminState(chatId, { action: 'admin_home' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_52') });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_edit_submenu_ar': {
        const rSubEn = await this.translateArToEn(text);
        const rMenu2 = await dbHelper.getMenuById(state.menuId);
        await dbHelper.updateMenu(state.menuId, rMenu2.parent_id, rMenu2.title_en, rMenu2.title_ar, rMenu2.reply_type, rSubEn, text, rMenu2.file_name, rMenu2.telegram_file_id, rMenu2.mime_type, rMenu2.file_size, rMenu2.sort_order, rMenu2.row_index);
        await dbHelper.setAdminState(chatId, { action: 'admin_home' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_53') });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_edit_text_ar': {
        const textEn = await this.translateArToEn(text);
        const m1 = await dbHelper.getMenuById(state.menuId);
        await dbHelper.updateMenu(state.menuId, m1.parent_id, m1.title_en, m1.title_ar, 'text', textEn, text, m1.file_name, m1.telegram_file_id, m1.mime_type, m1.file_size, m1.sort_order, m1.row_index);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: m1.parent_id, viewingMenuDetailsId: null });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_54') });
        const adminNavT = require('./admin-menu-navigation');
        await adminNavT.sendAdminReplyMenus(this, chatId, m1.parent_id, lang);
        break;
      }

      case 'awaiting_replace_file_doc': {
        if (text === '/cancel') {
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_55') });
          await this.sendAdminHome(chatId, lang);
          return;
        }
        const docReplace = this.extractTelegramAttachment(message);
        if (docReplace) {
          try {
            await dbHelper.runQuery('DELETE FROM menu_files WHERE menu_id = $1', [state.menuId]);
            await dbHelper.addMenuFile(state.menuId, docReplace.file_id, docReplace.file_name, docReplace.mime_type, docReplace.file_size);
            
            state.action = 'awaiting_edit_file_doc';
            await dbHelper.setAdminState(chatId, state);
            
            const doneBtn = t(lang, 'MSG_ADMIN_56');
            await this.apiCall('sendMessage', { 
              chat_id: chatId, 
              text: t(lang, 'MSG_ADMIN_57'),
              reply_markup: { keyboard: [[{ text: doneBtn }]], resize_keyboard: true }
            });
          } catch (e) {
            await this.apiCall('sendMessage', { chat_id: chatId, text: `❌ Error: ${e.message}` });
          }
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_58') });
        }
        break;
      }

      case 'awaiting_edit_file_doc': {
        if (text === '/skip' || text === '✅ Done' || text === '✅ تم' || text === '/done') {
          state.action = 'awaiting_edit_file_cap_ar';
          await dbHelper.setAdminState(chatId, state);
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_59'), reply_markup: cancelKb });
        } else {
          const doc2 = this.extractTelegramAttachment(message);
          if (doc2) {
            try {
              await dbHelper.addMenuFile(state.menuId, doc2.file_id, doc2.file_name, doc2.mime_type, doc2.file_size);
              
              if (message.caption && !state.captionAr) {
                state.captionAr = message.caption;
                state.captionEn = await this.translateArToEn(message.caption);
                const m2 = await dbHelper.getMenuById(state.menuId);
                await dbHelper.updateMenu(state.menuId, m2.parent_id, m2.title_en, m2.title_ar, 'file', state.captionEn, state.captionAr, doc2.file_name, doc2.file_id, doc2.mime_type, doc2.file_size, m2.sort_order, m2.row_index);
              }
              const doneBtn = t(lang, 'MSG_ADMIN_56');
              await this.apiCall('sendMessage', { 
                chat_id: chatId, 
                text: t(lang, 'MSG_ADMIN_57'),
                reply_markup: { keyboard: [[{ text: doneBtn }]], resize_keyboard: true }
              });
            } catch (e) {
               await this.apiCall('sendMessage', { chat_id: chatId, text: `❌ Error: ${e.message}` });
            }
          } else {
            await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_60') });
          }
        }
        break;
      }

      case 'awaiting_edit_file_cap_ar': {
        const m3 = await dbHelper.getMenuById(state.menuId);
        let cAr = m3.reply_content_ar;
        let cEn = m3.reply_content_en;
        if (text !== '/skip' && text !== '✅ Done' && text !== '✅ تم') {
          cAr = text;
          cEn = await this.translateArToEn(text);
        }
        
        await dbHelper.updateMenu(state.menuId, m3.parent_id, m3.title_en, m3.title_ar, 'file', cEn, cAr, m3.file_name, m3.telegram_file_id, m3.mime_type, m3.file_size, m3.sort_order, m3.row_index);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: m3.parent_id, viewingMenuDetailsId: null });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_61'), reply_markup: { remove_keyboard: true } });
        const adminNavF = require('./admin-menu-navigation');
        await adminNavF.sendAdminReplyMenus(this, chatId, m3.parent_id, lang);
        break;
      }
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_61'), reply_markup: { remove_keyboard: true } });
      case 'awaiting_move_dest':
        const m4 = await dbHelper.getMenuById(state.menuId);
        const targetMenuId = text === 'null' ? null : parseInt(text, 10);
        await dbHelper.updateMenu(state.menuId, targetMenuId, m4.title_en, m4.title_ar, m4.reply_type, m4.reply_content_en, m4.reply_content_ar, m4.file_name, m4.telegram_file_id, m4.mime_type, m4.file_size, m4.sort_order, m4.row_index);
        await dbHelper.setAdminState(chatId, { action: 'admin_home' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1') });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_newmenu_title_ar': {
        const nTitleEn = await this.translateArToEn(text);
        const lastOrderRes = await dbHelper.runQuery('SELECT MAX(sort_order) as max_order FROM menus WHERE parent_id IS NOT DISTINCT FROM $1 AND faculty_id = $2', [state.currentMenuId, this.facultyId]);
        const nextOrder = (lastOrderRes.rows[0].max_order || 0) + 1;
        
        let targetRowIndex = state.targetRow;
        if (targetRowIndex === 'new') {
          const lastRowRes = await dbHelper.runQuery('SELECT MAX(row_index) as max_row FROM menus WHERE parent_id IS NOT DISTINCT FROM $1 AND faculty_id = $2', [state.currentMenuId, this.facultyId]);
          targetRowIndex = (lastRowRes.rows[0].max_row || 0) + 1;
        } else if (targetRowIndex === null || targetRowIndex === undefined) {
          targetRowIndex = 0;
        }
        
        if (state.newType === 'submenu') {
          const newMenuId = await dbHelper.createMenu(this.facultyId, state.currentMenuId, nTitleEn, text, 'submenu', null, null, null, null, null, null, nextOrder, targetRowIndex);
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: newMenuId, viewingMenuDetailsId: null });
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_62') });
          const adminNav = require('./admin-menu-navigation');
          await adminNav.sendAdminReplyMenus(this, chatId, newMenuId, lang);
        } else if (state.newType === 'text') {
          const newMenuId = await dbHelper.createMenu(this.facultyId, state.currentMenuId, nTitleEn, text, 'text', null, null, null, null, null, null, nextOrder, targetRowIndex);
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_63') });
          await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_text_ar', menuId: newMenuId });
        } else if (state.newType === 'file') {
          const newMenuId = await dbHelper.createMenu(this.facultyId, state.currentMenuId, nTitleEn, text, 'file', null, null, null, null, null, null, nextOrder, targetRowIndex);
          await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_file_doc', menuId: newMenuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_64'), reply_markup: cancelKb });
        }
        break;
      }

      case 'awaiting_cfg_welcome_ar': {
        const fac2 = await dbHelper.getFacultyById(this.facultyId);
        const welEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac2.id, fac2.name_en, fac2.name_ar, fac2.slug, fac2.telegram_token, fac2.admin_chat_id, welEn, text, fac2.bot_enabled, fac2.disabled_message_en, fac2.disabled_message_ar, fac2.telegram_api_server, fac2.empty_msg_en, fac2.empty_msg_ar, fac2.unknown_msg_en, fac2.unknown_msg_ar, fac2.no_file_msg_en, fac2.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_65') });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_cfg_maintenance_ar': {
        const fac1 = await dbHelper.getFacultyById(this.facultyId);
        const disEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac1.id, fac1.name_en, fac1.name_ar, fac1.slug, fac1.telegram_token, fac1.admin_chat_id, fac1.welcome_en, fac1.welcome_ar, fac1.bot_enabled, disEn, text, fac1.telegram_api_server, fac1.empty_msg_en, fac1.empty_msg_ar, fac1.unknown_msg_en, fac1.unknown_msg_ar, fac1.no_file_msg_en, fac1.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_66') });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_cfg_empty_btn_ar': {
        const fac3 = await dbHelper.getFacultyById(this.facultyId);
        const empEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac3.id, fac3.name_en, fac3.name_ar, fac3.slug, fac3.telegram_token, fac3.admin_chat_id, fac3.welcome_en, fac3.welcome_ar, fac3.bot_enabled, fac3.disabled_message_en, fac3.disabled_message_ar, fac3.telegram_api_server, empEn, text, fac3.unknown_msg_en, fac3.unknown_msg_ar, fac3.no_file_msg_en, fac3.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_67') });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_cfg_unknown_text_ar': {
        const fac4 = await dbHelper.getFacultyById(this.facultyId);
        const unkEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac4.id, fac4.name_en, fac4.name_ar, fac4.slug, fac4.telegram_token, fac4.admin_chat_id, fac4.welcome_en, fac4.welcome_ar, fac4.bot_enabled, fac4.disabled_message_en, fac4.disabled_message_ar, fac4.telegram_api_server, fac4.empty_msg_en, fac4.empty_msg_ar, unkEn, text, fac4.no_file_msg_en, fac4.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_68') });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_cfg_no_file_ar': {
        const fac5 = await dbHelper.getFacultyById(this.facultyId);
        const nofEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac5.id, fac5.name_en, fac5.name_ar, fac5.slug, fac5.telegram_token, fac5.admin_chat_id, fac5.welcome_en, fac5.welcome_ar, fac5.bot_enabled, fac5.disabled_message_en, fac5.disabled_message_ar, fac5.telegram_api_server, fac5.empty_msg_en, fac5.empty_msg_ar, fac5.unknown_msg_en, fac5.unknown_msg_ar, nofEn, text);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_69') });
        await this.sendAdminHome(chatId, lang);
        break;
      }

      case 'awaiting_inline_btn_ar': {
        const menuBtn = await dbHelper.getMenuById(state.menuId);
        if (text === '/clear') {
          await dbHelper.updateMenu(menuBtn.id, menuBtn.parent_id, menuBtn.title_en, menuBtn.title_ar, menuBtn.reply_type, menuBtn.reply_content_en, menuBtn.reply_content_ar, menuBtn.file_name, menuBtn.telegram_file_id, menuBtn.mime_type, menuBtn.file_size, menuBtn.sort_order, menuBtn.row_index, null);
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_70') });
          await this.sendAdminHome(chatId, lang);
          break;
        }
        
        let bTitleAr = '';
        let bUrl = '';
        
        if (text.includes('-')) {
          const btnParts = text.split('-');
          bTitleAr = btnParts[0].trim();
          bUrl = btnParts.slice(1).join('-').trim();
        } else {
          bTitleAr = text.trim();
          bUrl = text.trim();
        }
        
        // No validation needed here, it will be mapped correctly at render time
        
        const bTitleEn = await this.translateArToEn(bTitleAr);
        const currentBtns = menuBtn.inline_buttons ? JSON.parse(menuBtn.inline_buttons) : [];
        currentBtns.push({ text_ar: bTitleAr, text_en: bTitleEn, url: bUrl });
        
        await dbHelper.updateMenu(menuBtn.id, menuBtn.parent_id, menuBtn.title_en, menuBtn.title_ar, menuBtn.reply_type, menuBtn.reply_content_en, menuBtn.reply_content_ar, menuBtn.file_name, menuBtn.telegram_file_id, menuBtn.mime_type, menuBtn.file_size, menuBtn.sort_order, menuBtn.row_index, JSON.stringify(currentBtns));
        await dbHelper.setAdminState(chatId, { action: 'admin_home' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_71') });
        await this.sendAdminHome(chatId, lang);
        break;
      }
      
      default:
        // Clear state if stuck
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_72'), reply_markup: { remove_keyboard: true } });
        break;
    }
  }

  async sendAdminHome(chatId, lang) {
    const role = await dbHelper.getAdminRole(this.facultyId, chatId);
    if (!role) return;

    const keyboard = [];

    keyboard.push([{ text: t(lang, 'BTN_MANAGE_MENUS') }]);

    if (role === 'OWNER' || role === 'DEPUTY_ADMIN') {
        keyboard.push([
            { text: t(lang, 'BTN_NEW_ANNOUNCEMENT') },
            { text: t(lang, 'BTN_MANAGE_ANNOUNCEMENTS') }
        ]);
        keyboard.push([{ text: t(lang, 'BTN_STATISTICS') }]);
    }

    if (role === 'OWNER') {
      keyboard.push([
        { text: t(lang, 'BTN_SETTINGS') },
        { text: t(lang, 'BTN_MANAGE_DEPUTIES') }
      ]);
      keyboard.push([
        { text: t(lang, 'BTN_MANAGE_SUBADMINS') },
        { text: t(lang, 'BTN_MONITORING') }
      ]);
    }

    keyboard.push([{ text: t(lang, 'BTN_CLOSE') }]);

    await this.apiCall('sendMessage', { 
      chat_id: chatId, 
      text: t(lang, 'MSG_ADMIN_73'), 
      reply_markup: { keyboard, resize_keyboard: true } 
    });
  }
  async uploadFileToTelegram(filePath, fileName, mimeType) {
    return new Promise(async (resolve, reject) => {
      try {
        const fs = require('node:fs');
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        if (!faculty) {
           return reject(new Error('Faculty does not have an admin_chat_id to store the file'));
        }
        
        const admins = await dbHelper.getAdminsByFaculty(faculty.id);
        const targetChatId = admins.length > 0 ? admins[0].chat_id : null;
        if (!targetChatId) return reject(new Error('No admins found'));
        const form = new FormData();
        form.append('chat_id', targetChatId);
        form.append('document', fs.createReadStream(filePath), {
          filename: fileName,
          contentType: mimeType || 'application/octet-stream'
        });
        form.append('disable_notification', 'true');
        
        const req = https.request({
          hostname: this.apiServer,
          port: 443,
          path: `/bot${this.token}/sendDocument`,
          method: 'POST',
          headers: form.getHeaders()
        }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.ok) {
                 const doc = this.extractTelegramAttachment(parsed.result);
                 resolve({ 
                   telegram_file_id: doc.file_id, 
                   file_size: doc.file_size || 0,
                   mime_type: doc.mime_type || mimeType
                 });
              } else {
                 reject(new Error(parsed.description));
              }
            } catch(e) { reject(e); }
          });
        });
        req.on('error', reject);
        form.pipe(req);
      } catch(e) {
        reject(e);
      }
    });
  }

  async getFileStreamFromTelegram(telegramFileId) {
    const fileInfo = await this.apiCall('getFile', { file_id: telegramFileId });
    if (!fileInfo.ok) throw new Error(`getFile failed: ${fileInfo.description}`);
    
    const url = `https://${this.apiServer}/file/bot${this.token}/${fileInfo.result.file_path}`;
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          return reject(new Error(`Telegram server returned ${response.statusCode}`));
        }
        resolve(response);
      }).on('error', reject);
    });
  }

  async handleAdminAnnouncementBroadcast(chatId, state, lang) {
    let doc = state.doc || null;
    let fileName = null;
    let telegramFileId = null;
    let mimeType = null;
    let fileSize = null;

    const stMsg = await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1') });
    
    try {
      if (doc) {
    const stMsg = await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_74') });
        telegramFileId = doc.file_id;
        mimeType = doc.mime_type || 'application/octet-stream';
        fileSize = doc.file_size || 0;
      }

      const annId = await dbHelper.createAnnouncement(this.facultyId, state.titleEn, state.titleAr, state.contentEn, state.contentAr, fileName, telegramFileId, mimeType, fileSize, state.isPinned);
      
      const announcement = {
        id: annId,
        faculty_id: this.facultyId,
        title_en: state.titleEn,
        title_ar: state.titleAr,
        content_en: state.contentEn,
        content_ar: state.contentAr,
        file_name: fileName,
        telegram_file_id: telegramFileId,
        mime_type: mimeType,
        is_pinned: state.isPinned
      };

      // Start the broadcast async (don't await so the admin panel unblocks immediately)
      this.sendAnnouncementLive(announcement, chatId, stMsg.result ? stMsg.result.message_id : null, lang).catch(e => {
        this.logError('Broadcast failed in background', e);
      });

      await dbHelper.deleteAdminState(chatId);
      await this.sendAdminHome(chatId, lang);
    } catch(e) {
      this.logError('Broadcast preparation failed', e, { chat_id: chatId });
      await this.apiCall('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
      await dbHelper.deleteAdminState(chatId);
    }
  }

  async sendAnnouncementLive(announcement, adminChatId, statusMsgId, lang) {
    const users = await dbHelper.getBotUsersByFaculty(this.facultyId, 'telegram');
    const totalUsers = users.length;
    let sent = 0;
    let blocked = 0;
    let failed = 0;
    const startTime = Date.now();
    let lastUpdateTime = Date.now();
    
    const updateProgress = async (final = false) => {
       const now = Date.now();
       if (!final && now - lastUpdateTime < 1000) return; // Update at most once per second
       lastUpdateTime = now;
       
       const avgLatencyMs = sent > 0 ? Math.round((now - startTime) / sent) : 0;
       const reach = (totalUsers - blocked) > 0 ? ((sent / (totalUsers - blocked)) * 100).toFixed(1) : 0;
       
       const txt = lang === 'ar' ? 
          `📡 *جاري الإرسال...*\n\nالرسائل المرسلة: ${sent} / ${totalUsers}\nالمستخدمين الذين قاموا بالحظر: ${blocked}\nفشل: ${failed}\nالوقت المنقضي: ${Math.round((now - startTime) / 1000)} ثانية\n\n_معدل الاستجابة: ${avgLatencyMs}ms/msg | الوصول الفعلي: ${reach}%_` :
          `📡 *Broadcasting...*\n\nSent: ${sent} / ${totalUsers}\nBlocked By Users: ${blocked}\nFailed: ${failed}\nElapsed Time: ${Math.round((now - startTime) / 1000)}s\n\n_Avg Latency: ${avgLatencyMs}ms/msg | Real Reach: ${reach}%_`;
          
       if (statusMsgId && adminChatId) {
          await this.apiCall('editMessageText', { chat_id: adminChatId, message_id: statusMsgId, text: txt, parse_mode: 'Markdown' });
       } else if (adminChatId) {
          const m = await this.apiCall('sendMessage', { chat_id: adminChatId, text: txt, parse_mode: 'Markdown' });
          if (m.result) statusMsgId = m.result.message_id;
       }
    };
    
    for (const user of users) {
      try {
        await this.withRetry(async () => {
          // Fallback to ensuring regular DB translation exists
          if (user.language === 'en') {
            await translationService.ensureTranslated(announcement, 'announcements', 'id', { title_ar: 'title_en', content_ar: 'content_en' });
          }

          let finalTxt = '';
          let finalEntities = null;

          if (announcement.content_ar.includes('<tg-emoji') || announcement.title_ar.includes('<tg-emoji')) {
             // Entities mode
             const combinedTextAr = `📢 ${announcement.title_ar}\n\n${announcement.content_ar}`;
             if (user.language === 'ar') {
                if (!announcement.parsed_ar) announcement.parsed_ar = await translationService.processPremiumEntities(combinedTextAr, null);
                finalTxt = announcement.parsed_ar.text;
                // Deep clone to safely add title entity
                finalEntities = JSON.parse(JSON.stringify(announcement.parsed_ar.entities));
             } else {
                if (!announcement.parsed_en) announcement.parsed_en = await translationService.processPremiumEntities(combinedTextAr, 'en');
                finalTxt = announcement.parsed_en.text;
                finalEntities = JSON.parse(JSON.stringify(announcement.parsed_en.entities));
             }

             // Title Bold Entity (Offset 2 accounts for '📢 ')
             const titleLength = user.language === 'ar' ? announcement.title_ar.length : (announcement.title_en ? announcement.title_en.length : announcement.title_ar.length); 
             // Note: Google Translate might change title length, calculating exact length of first line:
             const firstLineLen = finalTxt.split('\n')[0].length;
             finalEntities.push({
               type: 'bold',
               offset: 2,
               length: firstLineLen > 2 ? firstLineLen - 2 : 0
             });
             
             finalEntities.sort((a, b) => a.offset - b.offset);

          } else {
             // Standard Markdown mode
             const title = user.language === 'ar' ? announcement.title_ar : announcement.title_en;
             const content = user.language === 'ar' ? announcement.content_ar : announcement.content_en;
             finalTxt = `📢 *${title}*\n\n${content}`;
          }
          
          let res;
          if (announcement.telegram_file_id) {
            const apiOpts = finalEntities ? { caption_entities: finalEntities } : { parse_mode: 'Markdown' };
            res = await this.sendTelegramFile(
              user.chat_id,
              { telegram_file_id: announcement.telegram_file_id, file_name: announcement.file_name, mime_type: announcement.mime_type || null },
              finalTxt,
              apiOpts
            );
          } else {
            const apiOpts = finalEntities ? { entities: finalEntities } : { parse_mode: 'Markdown' };
            res = await this.apiCall('sendMessage', { chat_id: user.chat_id, text: finalTxt, ...apiOpts });
          }
          
          if (res && res.ok && res.result && res.result.message_id) {
             const msgId = res.result.message_id;
             await dbHelper.addAnnouncementMessage(announcement.id, user.chat_id, msgId);
             
             if (announcement.is_pinned) {
                await this.apiCall('pinChatMessage', { chat_id: user.chat_id, message_id: msgId, disable_notification: false });
             }
             sent++;
          } else if (res && !res.ok) {
             if (res.error_code === 403) {
               this.logInfo(`[Broadcast] User ${user.chat_id} skipped (blocked/deactivated)`);
               blocked++;
             }
             else failed++;
          }
        });
        
        await updateProgress();
      } catch(e) {
        failed++;
      }
    }
    
    await updateProgress(true);
  }

  async handleAdminAddFileButton(chatId, state, doc, lang) {
    try {
      const fileName = doc.file_name || 'document';
      const telegramFileId = doc.file_id;
      const mimeType = doc.mime_type || 'application/octet-stream';
      const fileSize = doc.file_size || 0;

      const newMenuId = await dbHelper.createMenu(this.facultyId, state.parentId, state.titleEn, state.titleAr, 'file', state.contentEn, state.contentAr, fileName, telegramFileId, mimeType, fileSize, 0);
      await dbHelper.addMenuFile(newMenuId, telegramFileId, fileName, mimeType, fileSize);

      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_1') });
      await this.sendAdminHome(chatId, lang);
    } catch(e) {
      this.logError('Add file failed', e, { chat_id: chatId });
      await this.apiCall('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_75') });
    }
  }

  async handleAdminEditFileButton(chatId, state, doc, lang) {
    const menu = await dbHelper.getMenuById(state.menuId);
    try {
      const fileName = doc.file_name || 'document';
      const telegramFileId = doc.file_id;
      const mimeType = doc.mime_type || 'application/octet-stream';
      const fileSize = doc.file_size || 0;

      await dbHelper.addMenuFile(menu.id, telegramFileId, fileName, mimeType, fileSize);
      await dbHelper.updateMenu(menu.id, menu.parent_id, menu.title_en, menu.title_ar, 'file', state.contentEn, state.contentAr, fileName, telegramFileId, mimeType, fileSize, menu.sort_order, menu.row_index);

      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_76') });
      await this.sendAdminHome(chatId, lang);
    } catch(e) {
      this.logError('Edit file failed', e, { chat_id: chatId });
      await this.apiCall('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
    }
  }

  async sendAdminAnnouncementsList(chatId, lang) {
    const anns = await dbHelper.getAnnouncementsByFaculty(this.facultyId);
    if (!anns || anns.length === 0) {
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_77') });
      return;
    }
    
    // Show the last 5 announcements
    const recentAnns = anns.slice(0, 5);
    for (const ann of recentAnns) {
      const title = lang === 'ar' ? ann.title_ar : ann.title_en;
      const date = new Date(ann.sent_at).toLocaleString('en-US', { timeZone: 'Asia/Damascus' });
      const txt = `📢 *${title}*\n📅 ${date}\n${ann.is_pinned ? '📌 (Pinned)' : ''}`;
      
      const inlineKeyboard = [
        [{ text: t(lang, 'MSG_ADMIN_78'), callback_data: `edit_ann_${ann.id}` }],
        [{ text: t(lang, 'MSG_ADMIN_79'), callback_data: `del_ann_${ann.id}` }]
      ];
      
      if (ann.is_pinned) {
        inlineKeyboard.push([{ text: t(lang, 'MSG_ADMIN_80'), callback_data: `unpin_ann_${ann.id}` }]);
      }
      
      await this.apiCall('sendMessage', { 
        chat_id: chatId, 
        text: txt, 
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    }
  }

  async sendAdminReplyMenus(chatId, parentId, lang) {
    const AdminMenuNavigation = require('./admin-menu-navigation');
    await AdminMenuNavigation.sendAdminReplyMenus(this, chatId, parentId, lang);
  }

  async sendAdminMenuDetails(chatId, menuId, lang) {
    const AdminMenuNavigation = require('./admin-menu-navigation');
    await AdminMenuNavigation.sendAdminMenuDetails(this, chatId, menuId, lang);
  }


  async sendLanguageSelection(chatId, lang = 'ar') {
    await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'CHOOSE_LANGUAGE'),
      reply_markup: {
        inline_keyboard: [
          [{ text: "🇺🇸 English", callback_data: "lang_en" }, { text: "🇸🇦 العربية", callback_data: "lang_ar" }]
        ]
      }
    });
  }

  async sendMenu(chatId, parentId, lang) {
    const menus = await dbHelper.getMenusByFaculty(this.facultyId);
    const faculty = await dbHelper.getFacultyById(this.facultyId);
    
    if (lang === 'en') {
      const pMenu = parentId ? menus.find(m => m.id === parentId) : null;
      if (pMenu) {
        await translationService.ensureTranslated(pMenu, 'menus', 'id', { title_ar: 'title_en', reply_content_ar: 'reply_content_en' });
      }
    }

    let currentLevel = menus.filter(m => m.parent_id === parentId);
    
    if (lang === 'en') {
      for (const m of currentLevel) {
        await translationService.ensureTranslated(m, 'menus', 'id', { title_ar: 'title_en', reply_content_ar: 'reply_content_en' });
      }
    }
    
    const adminRole = await dbHelper.getAdminRole(faculty.id, chatId);
    const isAdmin = !!adminRole;

    if (!isAdmin) {
      currentLevel = currentLevel.filter(m => m.is_hidden !== true);
    }
    
    let promptText = '';
    let inlineKeyboardMarkup = null;

    if (parentId === null) {
      promptText = lang === 'ar' ? (faculty.welcome_ar || 'مرحباً بك') : (faculty.welcome_en || 'Welcome');
    } else {
      const pMenu = menus.find(m => m.id === parentId);
      const customPrompt = lang === 'ar' ? pMenu.reply_content_ar : pMenu.reply_content_en;
      promptText = customPrompt ? customPrompt : (lang === 'ar' ? pMenu.title_ar : pMenu.title_en);

      if (pMenu.inline_buttons) {
        try {
          const btns = JSON.parse(pMenu.inline_buttons);
          if (btns && btns.length > 0) {
            inlineKeyboardMarkup = {
              inline_keyboard: btns.map(b => {
                const btn = { text: lang === 'ar' ? b.text_ar : b.text_en };
                const link = (b.url || '').trim();
                if (link.startsWith('@')) {
                  btn.url = 'https://t.me/' + link.substring(1);
                } else if (link.startsWith('http') || link.startsWith('tg://')) {
                  btn.url = link;
                } else {
                  btn.callback_data = 'btn_cmd_' + link;
                }
                return [btn];
              })
            };
          }
        } catch(e) {}
      }
    }

    const rowsMap = new Map();
    currentLevel.forEach(item => {
      const ri = item.row_index || 0;
      if (!rowsMap.has(ri)) rowsMap.set(ri, []);
      rowsMap.get(ri).push(item);
    });

    const sortedRows = Array.from(rowsMap.keys()).sort((a,b) => a - b);
    const keyboard = [];

    sortedRows.forEach(ri => {
      const rowItems = rowsMap.get(ri).sort((a,b) => a.sort_order - b.sort_order);
      const maxButtonsPerRow = 3;
      for (let i = 0; i < rowItems.length; i += maxButtonsPerRow) {
        const chunk = rowItems.slice(i, i + maxButtonsPerRow);
        const row = chunk.map(item => {
          let title = lang === 'ar' ? item.title_ar : item.title_en;
          if (isAdmin && item.is_hidden === true) title = `?? ` + title;
          return { text: title };
        });
        keyboard.push(row);
      }
    });

    if (parentId !== null) {
      const backRow = [{ text: t(lang, 'BTN_BACK') }];
      const pMenu = menus.find(m => m.id === parentId);
      if (pMenu && pMenu.parent_id !== null) {
        backRow.push({ text: t(lang, 'BTN_HOME') });
      }
      keyboard.push(backRow);
    }

    if (isAdmin && parentId === null) {
      keyboard.push([{ text: t(lang, 'MSG_ADMIN_81') }]);
    }

    const replyMarkup = keyboard.length > 0 ? { keyboard, resize_keyboard: true } : { remove_keyboard: true };

    let res;
    if (inlineKeyboardMarkup) {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: promptText,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboardMarkup
      });
      res = await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: t(lang, 'MENU_HEADER'),
        reply_markup: replyMarkup
      });
    } else {
      res = await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: promptText,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    }







    if (!res.ok) {
      this.logError('Failed to send menu', null, { description: res.description, promptText, chat_id: chatId });
      // Fallback without Markdown if the welcome message has bad characters
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: promptText,
        reply_markup: replyMarkup
      });
    }
  }

  async registerBotCommands() {
    const en = [
      { command: 'start', description: 'Start the bot and view main menu' },
      { command: 'changelanguage', description: 'Change interface language' },
      { command: 'back', description: 'Go back to previous menu' },
      { command: 'id', description: 'Get your Telegram Chat ID' },
      { command: 'admin', description: 'Admin control panel' }
    ];
    const ar = [
      { command: 'start', description: 'البدء واسترجاع القائمة' },
      { command: 'changelanguage', description: 'تغيير لغة البوت' },
      { command: 'back', description: 'العودة للقائمة السابقة' },
      { command: 'id', description: 'الحصول على معرف تيليجرام' },
      { command: 'admin', description: 'لوحة التحكم للمشرفين' }
    ];
    await this.apiCall('setMyCommands', { commands: en });
    await this.apiCall('setMyCommands', { commands: ar, language_code: 'ar' });
  }

  async apiCall(method, payload, isRetry = false) {
    try {
      const res = await this._rawApiCall(method, payload);
      if (!res.ok) {
        monitor.onTelegramError(this, res);
        if (res.error_code === 403 && payload && payload.chat_id) {
          const dbHelper = require('./database');
          await dbHelper.blockBotUser(this.facultyId, 'telegram', payload.chat_id.toString());
          monitor.onUserBlocked(this, { chat_id: payload.chat_id });
        }
        const desc = (res.description || '').toLowerCase();
        const shouldRetry = res.error_code === 429 || [500, 502, 503, 504].includes(res.error_code);
        if (shouldRetry && !isRetry) {
          this.logInfo(`Automatic recovery: Retrying ${method} due to ${res.error_code} ${res.description}`);
          return await this.apiCall(method, payload, true);
        }
      } else {
        if (res.result && res.result.message_id && payload && payload.chat_id) {
          const trackingMethods = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAudio', 'sendVoice', 'sendAnimation', 'editMessageText', 'editMessageReplyMarkup'];
          if (trackingMethods.includes(method)) {
             this.updateUserContext(payload.chat_id, { botMessageId: res.result.message_id });
          }
        }
      }
      return res;
    } catch (e) {
      if (!isRetry) {
        this.logInfo(`Automatic recovery: Retrying ${method} due to exception ${e.message}`);
        return await this.apiCall(method, payload, true);
      }
      throw e;
    }
  }

  _extractCustomEmojiEntities(payload) {
    if (!payload) return;
    const fields = ['text', 'caption'];
    for (const field of fields) {
      if (payload[field] && typeof payload[field] === 'string' && payload[field].includes('<tg-emoji')) {
        if (payload.parse_mode === 'HTML') continue;
        
        let text = payload[field];
        const entities = payload.entities || [];
        const regex = /<tg-emoji emoji-id="([^"]+)">([^<]+)<\/tg-emoji>/g;
        let cleanText = '';
        let lastIndex = 0;
        let match;
        
        while ((match = regex.exec(text)) !== null) {
          const emojiId = match[1];
          const emojiChar = match[2];
          
          cleanText += text.substring(lastIndex, match.index);
          const offset = cleanText.length;
          const length = emojiChar.length;
          
          entities.push({
            type: 'custom_emoji',
            offset: offset,
            length: length,
            custom_emoji_id: emojiId
          });
          
          cleanText += emojiChar;
          lastIndex = regex.lastIndex;
        }
        
        cleanText += text.substring(lastIndex);
        
        payload[field] = cleanText;
        if (entities.length > 0) {
          payload.entities = entities;
          delete payload.parse_mode;
        }
      }
    }
  }

  _rawApiCall(method, payload) {
    this._extractCustomEmojiEntities(payload);
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = https.request({
        hostname: this.apiServer,
        port: 443,
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 5000
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { 
            const parsed = JSON.parse(body);
            if (!parsed.ok) {
              console.error(`[TELEGRAM API ERROR] Method: ${method}, Payload: ${data}, Response: ${body}`);
            } else {
              console.log(`[TELEGRAM SUCCESS] Method: ${method}, ChatId: ${payload.chat_id || 'N/A'}`);
            }
            resolve(parsed); 
          } catch(e) { reject(e); }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Telegram API request timed out'));
      });
      req.on('error', (err) => {
        console.error(`[TELEGRAM HTTP ERROR] Method: ${method}, Error: ${err.message}`);
        reject(err);
      });
      req.write(data);
      req.end();
    });
  }

  // *** Centralized file delivery helper ***
  // All file delivery code MUST use this method instead of calling Telegram
  // API methods directly. It inspects mime_type and chooses the correct API.
  async sendTelegramFile(chatId, file, caption = null, replyMarkup = null) {
    const telegramFileId = file.telegram_file_id;
    if (!telegramFileId) throw new Error('No telegram_file_id available for this file');

    const method = this._getTelegramMethodForMime(file.mime_type);
    const field = this._getFieldNameForMethod(method);
    const payload = { chat_id: chatId, [field]: telegramFileId };
    if (caption) payload.caption = caption;
    if (replyMarkup) payload.reply_markup = replyMarkup;

    let fileType = file.mime_type || 'Unknown';
    if (file.file_name && file.file_name.includes('.')) {
      fileType = file.file_name.split('.').pop();
    }
    if (method === 'sendPhoto') fileType = 'image/jpeg';
    else if (method === 'sendVideo') fileType = 'video/mp4';
    else if (method === 'sendAudio' || method === 'sendVoice') fileType = 'audio/mpeg';

    this.updateUserContext(chatId, {
      currentOperation: "Sending File",
      fileId: telegramFileId,
      fileName: file.file_name || 'Unknown',
      mimeType: file.mime_type || 'Unknown',
      fileType: fileType
    });

    try {
      const res = await this.apiCall(method, payload);
      if (res.ok) return res;

      // If a specific method failed, fall back to sendDocument
      if (method !== 'sendDocument') {
        this.logWarn(`${method} failed for ${file.file_name}, falling back to sendDocument`, { description: res.description });
        const fbPayload = { chat_id: chatId, document: telegramFileId };
        if (caption) fbPayload.caption = caption;
        if (replyMarkup) fbPayload.reply_markup = replyMarkup;
        const fbRes = await this.apiCall('sendDocument', fbPayload);
        if (fbRes.ok) return fbRes;
      }

      // Notify admin about the failure
      await this._notifyAdminFileError(file.file_name, res.description);
      throw new Error(`File delivery failed: ${res.description || 'Unknown error'}`);
    } catch (e) {
      // If the primary method threw (network error etc.) and wasn't sendDocument, try fallback
      if (method !== 'sendDocument' && !e.message.startsWith('File delivery failed')) {
        try {
          const fbPayload = { chat_id: chatId, document: telegramFileId };
          if (caption) fbPayload.caption = caption;
          if (replyMarkup) fbPayload.reply_markup = replyMarkup;
          const fbRes = await this.apiCall('sendDocument', fbPayload);
          if (fbRes.ok) return fbRes;
        } catch (_) { /* fallback also failed */ }
      }
      this.logError('sendTelegramFile failed', e, { telegramFileId, method, chat_id: chatId });
      throw e;
    }
  }

  _getTelegramMethodForMime(mimeType) {
    if (!mimeType) return 'sendDocument';
    const m = mimeType.toLowerCase();
    if (m === 'image/gif') return 'sendAnimation';
    if (m.startsWith('image/')) return 'sendPhoto';
    if (m === 'audio/ogg' || m === 'audio/opus') return 'sendVoice';
    if (m.startsWith('audio/')) return 'sendAudio';
    if (m.startsWith('video/')) return 'sendVideo';
    return 'sendDocument';
  }

  _getFieldNameForMethod(method) {
    const map = {
      sendPhoto: 'photo', sendAudio: 'audio', sendVideo: 'video',
      sendVoice: 'voice', sendAnimation: 'animation', sendDocument: 'document'
    };
    return map[method] || 'document';
  }

  async _notifyAdminFileError(fileName, errorDesc) {
    try {
      const admins = await dbHelper.getAdminsByFaculty(this.facultyId);
      const owner = admins.find(a => a.role === 'OWNER');
      if (owner) {
        await this.apiCall('sendMessage', {
          chat_id: owner.chat_id,
          text: `⚠️ Error: A file could not be delivered.\n\nFile Name: ${fileName || 'Unknown'}\nError: ${errorDesc || 'Unknown error'}\n\nPlease re-upload the file in the admin panel.`
        });
      }
    } catch (adminErr) {
      this.logError('Failed to notify admin about file error', adminErr);
    }
  }

  // Legacy wrapper kept so any remaining call sites still work
  async sendDocumentWithFallback(chatId, fileKey, fileName, caption, replyMarkup, telegramFileId = null, dbUpdateFn = null) {
    return this.sendTelegramFile(chatId, { telegram_file_id: telegramFileId, file_name: fileName, mime_type: null }, caption, replyMarkup);
  }

  // *** Paginated file delivery ***
  async sendFilePage(chatId, menuId, page, lang, caption = null, isAdminPreview = false) {
    const FILES_PER_PAGE = 10;
    const allFiles = await dbHelper.getMenuFiles(menuId);

    // Legacy fallback: no menu_files rows → try the legacy menus column
    if (!allFiles || allFiles.length === 0) {
      const menu = await dbHelper.getMenuById(menuId);
      if (menu && menu.telegram_file_id) {
        try {
          await this.sendTelegramFile(chatId, { telegram_file_id: menu.telegram_file_id, file_name: menu.file_name, mime_type: menu.mime_type }, caption);
        } catch (e) {
          this.logError('Error sending legacy file', e, { chat_id: chatId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'ERROR_SENDING_FILE') });
        }
      } else {
        await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'NO_ATTACHED_FILE') });
      }
      return;
    }

    const totalFiles = allFiles.length;
    const totalPages = Math.ceil(totalFiles / FILES_PER_PAGE);
    const startIdx = page * FILES_PER_PAGE;
    const endIdx = Math.min(startIdx + FILES_PER_PAGE, totalFiles);
    const pageFiles = allFiles.slice(startIdx, endIdx);

    this.updateUserContext(chatId, {
      pageNumber: page + 1,
      totalFiles: totalFiles
    });

    let hasError = false;
    for (let i = 0; i < pageFiles.length; i++) {
      const file = pageFiles[i];
      const fileCaption = (page === 0 && i === 0) ? caption : null;
      try {
        let replyMarkup = null;
        const kbButtons = [];
        if (!isAdminPreview && page === 0 && i === 0) {
          const menu = await dbHelper.getMenuById(menuId);
          if (menu && menu.inline_buttons) {
            try {
              const btns = JSON.parse(menu.inline_buttons);
              if (btns && btns.length > 0) {
                btns.forEach(b => {
                  const btn = { text: lang === 'ar' ? b.text_ar : b.text_en };
                  const link = (b.url || '').trim();
                  if (link.startsWith('@')) {
                    btn.url = 'https://t.me/' + link.substring(1);
                  } else if (link.startsWith('http') || link.startsWith('tg://')) {
                    btn.url = link;
                  } else {
                    btn.callback_data = 'btn_cmd_' + link;
                  }
                  kbButtons.push([btn]);
                });
              }
            } catch(e) {}
          }
        }
        if (isAdminPreview) {
          kbButtons.push([{ text: t(lang, 'MSG_ADMIN_82'), callback_data: `del_file_${file.id}` }]);
        }
        if (kbButtons.length > 0) {
          replyMarkup = { inline_keyboard: kbButtons };
        }
        await this.sendTelegramFile(chatId, file, fileCaption, replyMarkup);
      } catch (e) {
        this.logError('Error sending file', e, { chat_id: chatId });
        hasError = true;
      }
    }

    if (hasError) {
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'ERROR_SENDING_SOME_FILES') });
    }

    // Show pagination controls when there are multiple pages
    if (totalPages > 1) {
      const pageLabel = `${t(lang, 'PAGE')} ${page + 1} ${t(lang, 'OF')} ${totalPages}`;
      const kb = [];
      const navRow = [];
      if (page > 0) {
        navRow.push({ text: t(lang, 'BTN_PREV'), callback_data: `fp_${menuId}_${page - 1}` });
      }
      if (page < totalPages - 1) {
        navRow.push({ text: t(lang, 'BTN_NEXT'), callback_data: `fp_${menuId}_${page + 1}` });
      }
      if (navRow.length > 0) kb.push(navRow);
      kb.push([{ text: t(lang, 'BTN_CLOSE'), callback_data: `fe_${menuId}` }]);

      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: pageLabel,
        reply_markup: { inline_keyboard: kb }
      });
    }
  }

  async withRetry(fn, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) throw err;
        
        let waitTime = Math.pow(2, attempt) * 1000;
        if (err && err.response && err.response.parameters && err.response.parameters.retry_after) {
          waitTime = err.response.parameters.retry_after * 1000;
        }
        
        this.logWarn(`Telegram API error, retrying in ${waitTime}ms`, { attempt, msg: err.message });
        await new Promise(res => setTimeout(res, waitTime));
      }
    }
  }

  logWarn(msg, obj = {}) {
    logger.warn({ reqId: this.reqId, facultyId: this.facultyId, ...obj }, msg);
  }

  async sendAnnouncement(announcement) {
    // Fallback for API usage
    await this.sendAnnouncementLive(announcement, null, null, 'ar');
  }

  async translateArToEn(text) {
    return await translationService.translate(text, 'en');
  }

  extractTelegramAttachment(message) {
    if (message.document) return message.document;
    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      return { file_id: photo.file_id, file_name: 'photo.jpg', mime_type: 'image/jpeg', file_size: photo.file_size };
    }
    if (message.audio) return { file_id: message.audio.file_id, file_name: message.audio.file_name || 'audio.mp3', mime_type: message.audio.mime_type || 'audio/mpeg', file_size: message.audio.file_size };
    if (message.voice) return { file_id: message.voice.file_id, file_name: 'voice.ogg', mime_type: message.voice.mime_type || 'audio/ogg', file_size: message.voice.file_size };
    if (message.video) return { file_id: message.video.file_id, file_name: message.video.file_name || 'video.mp4', mime_type: message.video.mime_type || 'video/mp4', file_size: message.video.file_size };
    if (message.animation) return { file_id: message.animation.file_id, file_name: message.animation.file_name || 'animation.gif', mime_type: message.animation.mime_type || 'image/gif', file_size: message.animation.file_size };
    return null;
  }

  parsePremiumEmojis(message) {
    if (!message || !message.text) return '';
    let text = message.text;
    
    // Convert Telegram custom emoji entities to HTML <tg-emoji> tags
    if (message.entities) {
      const customEmojis = message.entities
        .filter(e => e.type === 'custom_emoji')
        .sort((a, b) => b.offset - a.offset);
        
      for (const e of customEmojis) {
        if (e.custom_emoji_id) {
          const prefix = text.substring(0, e.offset);
          const emojiStr = text.substring(e.offset, e.offset + e.length);
          const suffix = text.substring(e.offset + e.length);
          text = prefix + `<tg-emoji emoji-id="${e.custom_emoji_id}">${emojiStr}</tg-emoji>` + suffix;
        }
      }
    }
    return text;
  }
}

async function getBotService(facultyId, reqId = 'system') {
  const fac = await dbHelper.getFacultyById(facultyId);
  if (!fac || !fac.telegram_token) return null;
  return new TelegramBotService(fac.id, fac.telegram_token, fac.telegram_api_server, reqId);
}

module.exports = {
  async registerWebhookForFaculty(faculty, reqId) {
    const svc = new TelegramBotService(faculty.id, faculty.telegram_token, faculty.telegram_api_server, reqId);
    await svc.registerWebhook();
  },

  async deleteWebhookForFaculty(faculty, reqId) {
    const svc = new TelegramBotService(faculty.id, faculty.telegram_token, faculty.telegram_api_server, reqId);
    await svc.deleteWebhook();
  },

  async getBotStatus(facultyId) {
    const svc = await getBotService(facultyId);
    if (!svc) return { status: 'Unknown', username: null, error: null };
    const info = await svc.getBotInfo();
    if (info) return { status: 'Active', username: info.username, error: null };
    return { status: 'Error', username: null, error: 'Could not fetch bot info' };
  },

  async broadcastAnnouncement(announcement, reqId) {
    const svc = await getBotService(announcement.faculty_id, reqId);
    if (svc) {
      await svc.sendAnnouncement(announcement);
    }
  },

  async handleWebhookUpdate(facultyId, update, reqId) {
    const svc = await getBotService(facultyId, reqId);
    if (svc) {
      await svc.handleUpdate(update);
    }
  },

  async uploadFileToTelegram(facultyId, reqId, filePath, fileName, mimeType) {
    const svc = await getBotService(facultyId, reqId);
    if (!svc) throw new Error('Bot not configured for this faculty');
    return await svc.uploadFileToTelegram(filePath, fileName, mimeType);
  },

  async getFileStreamFromTelegram(facultyId, reqId, telegramFileId) {
    const svc = await getBotService(facultyId, reqId);
    if (!svc) throw new Error('Bot not configured for this faculty');
    return await svc.getFileStreamFromTelegram(telegramFileId);
  },

  getWebhookSecret,
  getBotService
};
















const https = require('node:https');
const crypto = require('node:crypto');
const FormData = require('form-data');
const dbHelper = require('./database');
const logger = require('./logger');
const cache = require('./cache');

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
  }

  logInfo(msg, obj = {}) {
    logger.info({ reqId: this.reqId, facultyId: this.facultyId, ...obj }, msg);
  }

  logError(msg, err, obj = {}) {
    logger.error({ reqId: this.reqId, facultyId: this.facultyId, err, ...obj }, msg);
    const { reportRuntimeError, getUserHistory } = require('./error-reporter');
    
    // We do a best-effort async context extraction to not block the caller
    (async () => {
      try {
        const dbHelper = require('./database');
        let facultyName = '';
        let telegramFullName = obj.Telegram_Full_Name || '';
        let telegramUsername = obj.Telegram_Username || '';
        let adminState = null;
        let botUsername = this.username || '';
        let currentMenu = obj.Current_Menu || '';
        let currentButton = obj.Current_Button || '';
        
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        if (faculty) facultyName = faculty.name_en || faculty.name_ar;

        let history = [];
        let menuPath = '';
        let parentMenu = '';
        let currentMenuId = '';
        let replyType = '';
        let callbackData = '';
        let msgText = '';

        if (obj.update) {
          if (obj.update.message && obj.update.message.text) msgText = obj.update.message.text;
          if (obj.update.callback_query && obj.update.callback_query.data) callbackData = obj.update.callback_query.data;
          
          if (obj.update.message && obj.update.message.from) {
             telegramFullName = `${obj.update.message.from.first_name || ''} ${obj.update.message.from.last_name || ''}`.trim();
             telegramUsername = obj.update.message.from.username || '';
          } else if (obj.update.callback_query && obj.update.callback_query.from) {
             telegramFullName = `${obj.update.callback_query.from.first_name || ''} ${obj.update.callback_query.from.last_name || ''}`.trim();
             telegramUsername = obj.update.callback_query.from.username || '';
          }
        }

        if (obj.chat_id || obj.Telegram_User_ID) {
          const cid = obj.chat_id || obj.Telegram_User_ID;
          history = getUserHistory(cid.toString());
          const stateRow = await dbHelper.pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [cid.toString()]);
          if (stateRow.rows.length > 0) adminState = stateRow.rows[0].state;
          
          const uRow = await dbHelper.pool.query('SELECT * FROM bot_users WHERE chat_id = $1', [cid.toString()]);
          if (uRow.rows.length > 0) {
             if (!telegramFullName) telegramFullName = `${uRow.rows[0].first_name} ${uRow.rows[0].last_name || ''}`.trim();
             if (!telegramUsername) telegramUsername = uRow.rows[0].username || '';
             
             if (uRow.rows[0].current_menu_id) {
                currentMenuId = uRow.rows[0].current_menu_id;
                let currMenuId = currentMenuId;
                let pathArr = [];
                let parentId = null;
                
                let limit = 20; // safety
                while (currMenuId && limit-- > 0) {
                  const mRow = await dbHelper.pool.query('SELECT * FROM menus WHERE id = $1', [currMenuId]);
                  if (mRow.rows.length > 0) {
                    const m = mRow.rows[0];
                    const mTitle = m.title_en || m.title_ar || 'Unknown';
                    pathArr.unshift(mTitle);
                    
                    if (currMenuId === currentMenuId) {
                      currentMenu = mTitle;
                      parentId = m.parent_id;
                      replyType = m.reply_type || '';
                    }
                    currMenuId = m.parent_id;
                  } else {
                    pathArr.unshift('Unknown (deleted)');
                    break;
                  }
                }
                menuPath = pathArr.join(' â†’ ');
                
                if (parentId) {
                   const pRow = await dbHelper.pool.query('SELECT title_en, title_ar FROM menus WHERE id = $1', [parentId]);
                   if (pRow.rows.length > 0) {
                     parentMenu = pRow.rows[0].title_en || pRow.rows[0].title_ar || 'Unknown';
                   }
                }
             }
          }
        }

        reportRuntimeError({
          Severity: obj.Severity,
          Faculty_ID: this.facultyId,
          Faculty_Name: facultyName,
          Bot_ID: this.token ? this.token.split(':')[0] : '',
          Bot_Username: botUsername,
          Request_ID: this.reqId,
          Error_Type: err ? err.name : 'BotError',
          Error_Message: err ? (err.message || String(err)) : 'Unknown Error',
          Stack_Trace: err ? err.stack : '',
          Operation: msg,
          File_Name: 'bot-manager.js',
          Function_Name: 'TelegramBotService.logError',
          Telegram_User_ID: obj.chat_id || obj.Telegram_User_ID,
          Telegram_Full_Name: telegramFullName,
          Telegram_Username: telegramUsername,
          Current_Menu_ID: currentMenuId,
          Current_Menu: currentMenu,
          Parent_Menu: parentMenu,
          Menu_Path: menuPath,
          Reply_Type: replyType,
          Current_Button: currentButton,
          Admin_State: adminState,
          Message_Text: msgText,
          Callback_Data: callbackData,
          Message_ID: obj.message_id,
          Update_ID: obj.update_id,
          Last_10_Operations: history,
          Telegram_Update: obj.update,
          HTTP_Request: obj.request,
          API_Payload: obj.api_payload,
          ...obj
        });
      } catch (innerErr) {
        // Safe fallback
        reportRuntimeError({
          Severity: 'ERROR',
          Faculty_ID: this.facultyId,
          Request_ID: this.reqId,
          Error_Type: err ? err.name : 'BotError',
          Error_Message: err ? (err.message || String(err)) : 'Unknown Error',
          Stack_Trace: err ? err.stack : '',
          Operation: msg,
          File_Name: 'bot-manager.js',
          Function_Name: 'TelegramBotService.logError',
          ...obj
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
    console.log("UPDATE RECEIVED:");
    console.log(JSON.stringify(update, null, 2));

    if (update.message) {
        await this.handleMessage(update.message);
    } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
    } else {
        console.log("UNKNOWN UPDATE TYPE");
    }
  }

  // --- Message Handling ---
  async handleMessage(message) {
    const chatId = message.chat.id.toString();
    const text = message.text || '';
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

    let user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
    if (!user) {
      user = await dbHelper.upsertBotUser(
        this.facultyId, 
        'telegram', 
        chatId, 
        message.from.username || message.from.first_name, 
        'en'
      );
    }

    const faculty = await dbHelper.getFacultyById(this.facultyId);
    if (!faculty) return;

    if (faculty.bot_enabled === 0) {
      const disabledMsg = user.language === 'ar' 
        ? (faculty.disabled_message_ar || 'Ø¹Ø°Ø±Ø§Ù‹ØŒ Ø§Ù„Ø¨ÙˆØª Ù…ØªÙˆÙ‚Ù Ø­Ø§Ù„ÙŠØ§Ù‹ Ù„Ù„ØµÙŠØ§Ù†Ø©.') 
        : (faculty.disabled_message_en || 'Sorry, the bot is temporarily offline for maintenance.');
      
      const res = await this.apiCall('sendMessage', { chat_id: chatId, text: disabledMsg, parse_mode: 'Markdown' });
      if (!res.ok) {
        // Fallback without Markdown in case the custom message contains invalid Markdown characters
        await this.apiCall('sendMessage', { chat_id: chatId, text: disabledMsg });
      }
      return;
    }

    const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);

    if (faculty.forward_user_messages && !isAdmin && faculty.admin_chat_id) {
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim());
      for (const adminId of adminIds) {
        if (adminId) {
          const userStr = message.from.username ? `@${message.from.username}` : message.from.first_name;
          await this.apiCall('sendMessage', { 
            chat_id: adminId, 
            text: `👀 **مراقبة النشاط**\n\n👤 المستخدم: ${userStr} (ID: ${message.from.id})\n💬 النص: ${message.text || ''}`,
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
      if (user.language === 'en' && !text.includes('lang_')) {
        await this.sendLanguageSelection(chatId);
      } else {
        await this.sendMenu(chatId, null, user.language);
      }
      return;
    }

    if (adminState && isAdmin) {
      await this.handleAdminStateMessage(chatId, message, user.language, adminState);
      return;
    }

    if (text === '/changelanguage') {
      await this.sendLanguageSelection(chatId);
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

    if (text === '/admin' && isAdmin) {
      await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: null });
      await this.sendAdminReplyMenus(chatId, null, user.language);
      return;
    }

    if (text === '/back') {
      await this.handleBackNavigation(chatId, user);
      return;
    }

    if (text.startsWith('/search ') || text.startsWith('Ø¨Ø­Ø« ') || text.startsWith('Ø§Ø¨Ø­Ø« ')) {
      const query = text.replace(/^\/search\s+|^Ø¨Ø­Ø«\s+|^Ø§Ø¨Ø­Ø«\s+/i, '').trim();
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
      if (text === 'â¬…ï¸ Back' || text === 'â¬…ï¸ Ø¹ÙˆØ¯Ø©') {
        await this.handleBackNavigation(chatId, user);
        return;
      }
      
      if (text === 'ðŸ› ï¸ Admin Panel' || text === 'ðŸ› ï¸ Ù„ÙˆØ­Ø© Ø§Ù„ØªØ­ÙƒÙ… Ù„Ù„Ù…Ø´Ø±ÙÙŠÙ†') {
        if (isAdmin) {
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: null });
          await this.sendAdminReplyMenus(chatId, null, user.language);
        }
        return;
      }

      const unknownMsg = user.language === 'ar' ? 'Ø¹Ø°Ø±Ø§Ù‹ØŒ Ù„Ù… Ø£ÙÙ‡Ù… Ø·Ù„Ø¨Ùƒ. Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø§Ø®ØªÙŠØ§Ø± Ù…Ù† Ø§Ù„Ù‚Ø§Ø¦Ù…Ø©.' : 'Sorry, I did not understand that. Please select from the menu.';
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
              inline_keyboard: btns.map(b => [{
                text: user.language === 'ar' ? b.text_ar : b.text_en,
                url: b.url
              }])
            };
          }
        } catch(e) {
          this.logError('Failed to parse inline buttons', e);
        }
      }

      await this.apiCall('sendMessage', { 
        chat_id: chatId, 
        text: reply || (user.language === 'ar' ? 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ø­ØªÙˆÙ‰' : 'No content'),
        reply_markup: keyboard
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
      const err = lang === 'ar' ? 'Ø§Ù„Ù…Ù„Ù ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯ Ø£Ùˆ ØªÙ… Ø­Ø°ÙÙ‡.' : 'File not found or deleted.';
      await this.apiCall('sendMessage', { chat_id: chatId, text: err });
      return;
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
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø¥Ø¯Ø®Ø§Ù„ Ø­Ø±ÙÙŠÙ† Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„.' : 'Please enter at least 2 characters.' });
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
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âŒ Ù„Ù… ÙŠØªÙ… Ø§Ù„Ø¹Ø«ÙˆØ± Ø¹Ù„Ù‰ Ù†ØªØ§Ø¦Ø¬.' : 'âŒ No results found.' });
      return;
    }

    let resultText = lang === 'ar' ? `ðŸ” Ù†ØªØ§Ø¦Ø¬ Ø§Ù„Ø¨Ø­Ø« Ø¹Ù† "${query}":\n\n` : `ðŸ” Search results for "${query}":\n\n`;
    const botInfo = await this.getBotInfo();
    const botUsername = botInfo ? botInfo.username : '';
    
    for (const row of rows) {
      const title = lang === 'ar' ? row.title_ar : row.title_en;
      resultText += `ðŸ“„ ${title}\nðŸ”— https://t.me/${botUsername}?start=file_${row.id}\n\n`;
    }

    await this.apiCall('sendMessage', { chat_id: chatId, text: resultText, disable_web_page_preview: true });
  }

  async handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id.toString();
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
      const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);
      if (faculty && faculty.forward_user_messages && !isAdmin && faculty.admin_chat_id) {
        const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim());
        for (const adminId of adminIds) {
          if (adminId) {
            const userStr = callbackQuery.from.username ? `@${callbackQuery.from.username}` : callbackQuery.from.first_name;
            await this.apiCall('sendMessage', { 
              chat_id: adminId, 
              text: `👀 **مراقبة النشاط (زر)**\n\n👤 المستخدم: ${userStr} (ID: ${callbackQuery.from.id})\n🔘 الزر: ${data} ()`,
              parse_mode: 'Markdown'
            });
          }
        }
      }
    } catch(e) {}

    if (data.startsWith('lang_')) {
      const lang = data === 'lang_ar' ? 'ar' : 'en';
      await dbHelper.upsertBotUser(this.facultyId, 'telegram', chatId, callbackQuery.from.username || callbackQuery.from.first_name, lang);
      
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

      const faculty = await dbHelper.getFacultyById(this.facultyId);
      const welcome = lang === 'ar' 
        ? (faculty.welcome_ar || 'ØªÙ… ØªØ­Ø¯ÙŠØ« Ø§Ù„Ù„ØºØ© Ø¨Ù†Ø¬Ø§Ø­.')
        : (faculty.welcome_en || 'Language updated successfully.');

      await this.apiCall('sendMessage', { chat_id: chatId, text: welcome });
      
      const user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      await this.sendMenu(chatId, user ? user.current_menu_id : null, lang);
    }
    else if (data.startsWith('fp_')) {
      // File pagination: fp_menuId_page
      const parts = data.split('_');
      const menuId = parseInt(parts[1], 10);
      const page = parseInt(parts[2], 10);
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
      const user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      const lang = user ? user.language : 'en';
      await this.sendFilePage(chatId, menuId, page, lang);
    }
    else if (data.startsWith('fe_')) {
      // File exit: close pagination
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'âœ…' });
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});
    }
    else if (data.startsWith('admin_')) {
      const userObj = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      const lang = userObj ? userObj.language : 'ar';
      const action = data.split('_')[1];
      const menuId = parseInt(data.split('_')[2], 10);
      const cancelKb = { keyboard: [[{ text: lang === 'ar' ? '🚫 إلغاء العملية' : '🚫 Cancel Operation' }]], resize_keyboard: true };

      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

      if (action === 'rename') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_rename_title_ar', menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل الاسم الجديد للزر (بالعربية):' : 'Send the new name in Arabic:', reply_markup: cancelKb });
      } else if (action === 'delbtn') {
        const menu = await dbHelper.getMenuById(menuId);
        await dbHelper.deleteMenu(menuId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم حذف الزر' : '✅ Button Deleted' });
        if (menu) await this.sendAdminReplyMenus(chatId, menu.parent_id, lang);
      } else if (action === 'open') {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuId, viewingMenuDetailsId: null });
        await this.sendAdminReplyMenus(chatId, menuId, lang);
      } else if (action === 'delcontent') {
        const menu = await dbHelper.getMenuById(menuId);
        if (menu.reply_type === 'text') {
          await dbHelper.updateMenuContent(menuId, null, null);
        } else if (menu.reply_type === 'file') {
          const files = await dbHelper.getFilesByMenu(menuId);
          for (const f of files) {
            await dbHelper.deleteFile(f.id);
          }
        }
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم حذف المحتوى' : '✅ Content Deleted' });
        await this.sendAdminMenuDetails(chatId, menuId, lang);
      } else if (action === 'previewfiles') {
        await this.sendFilePage(chatId, menuId, 0, lang);
      } else if (action === 'addfile') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_file_doc', menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل الملف الجديد. ويمكنك إرفاق الشرح باللغة العربية معه:' : 'Send the new file, with optional Arabic caption:', reply_markup: cancelKb });
      } else if (action === 'edittext') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_text_ar', menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل النص الجديد (بالعربي):' : 'Send the new text (Arabic):', reply_markup: cancelKb });
      } else if (action === 'inline') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_inline_btn', menuId });
        const m = lang === 'ar' 
          ? '🔗 إضافة زر شفاف (رابط)\n\nأرسل اسم الزر والرابط مفصولين بشرطة (-)\nمثال: موقع الجامعة - https://example.com\nأو أرسل /clear لمسح الأزرار الحالية.' 
          : '🔗 Add Inline Button (URL)\n\nSend title and URL separated by hyphen (-)\nExample: Website - https://example.com\nOr send /clear to remove all.';
        await this.apiCall('sendMessage', { chat_id: chatId, text: m, parse_mode: 'Markdown', reply_markup: cancelKb });
      } else if (action === 'move') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_move_target', menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل الـ ID الخاص بالقائمة الهدف (اكتب null لنقله للقائمة الرئيسية):' : 'Send target Menu ID (or null for root):', reply_markup: cancelKb });
      } else if (action === 'order') {
        const menu = await dbHelper.getMenuById(menuId);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus_move_order', currentMenuId: menu.parent_id, viewingMenuDetailsId: menuId });
        await this.sendAdminMoveOrder(chatId, menuId, lang);
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
  async handleAdminStateMessage(chatId, message, lang, state) {
    const text = message.text || '';

    // Global admin intercepts for navigation
    if (text === 'âŒ Ø¥ØºÙ„Ø§Ù‚' || text === 'âŒ Close') {
      await dbHelper.deleteAdminState(chatId);
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ØªÙ… Ø¥ØºÙ„Ø§Ù‚ Ù„ÙˆØ­Ø© Ø§Ù„Ù…Ø´Ø±Ù.' : 'Admin panel closed.', reply_markup: { remove_keyboard: true } });
      return;
    }
    
    if (text === 'ðŸ  Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠØ©' || text === 'ðŸ  Home') {
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.sendAdminHome(chatId, lang);
      return;
    }

    if (text === '/cancel') {
      await dbHelper.deleteAdminState(chatId);
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ØªÙ… Ø§Ù„Ø¥Ù„ØºØ§Ø¡.' : 'Action cancelled.', reply_markup: { remove_keyboard: true } });
      await this.sendAdminHome(chatId, lang);
      return;
    }

    // --- HOME MENU ---
    if (state.action === 'admin_home') {
      if (text.includes('Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ù‚ÙˆØ§Ø¦Ù…') || text.includes('Manage Menus')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: null, viewingMenuDetailsId: null });
        await this.sendAdminReplyMenus(chatId, null, lang);
      } else if (text.includes('Ø¥Ø¹Ù„Ø§Ù† Ø¬Ø¯ÙŠØ¯') || text.includes('Broadcast')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_announcement_title_ar' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ðŸ“¢ Ø¥Ø±Ø³Ø§Ù„ Ø¥Ø¹Ù„Ø§Ù† Ø¬Ø¯ÙŠØ¯\n\nØ§Ù„Ø±Ø¬Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ **Ø¹Ù†ÙˆØ§Ù†** Ø§Ù„Ø¥Ø¹Ù„Ø§Ù† (Ø¨Ø§Ù„Ù„ØºØ© Ø§Ù„Ø¹Ø±Ø¨ÙŠØ©):' : 'ðŸ“¢ New Announcement\n\nPlease send the **Title** in Arabic:', reply_markup: { remove_keyboard: true }});
      } else if (text.includes('Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª') || text.includes('Stats')) {
        const users = await dbHelper.getBotUsersByFaculty(this.facultyId, 'telegram');
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? `ðŸ“Š Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª Ø§Ù„Ø¨ÙˆØª:\n\nØ¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„Ù…Ø´ØªØ±ÙƒÙŠÙ†: ${users.length}` : `ðŸ“Š Bot Stats:\n\nTotal Subscribers: ${users.length}` });
      } else if (text.includes('Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª') || text.includes('Core Settings')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_config' });
        const cfgText = lang === 'ar' 
          ? 'âš™ï¸ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ø¨ÙˆØª\n\nØ§Ø®ØªØ± Ø§Ù„Ø¥Ø¹Ø¯Ø§Ø¯ Ø§Ù„Ø°ÙŠ ØªØ±ØºØ¨ Ø¨ØªØ¹Ø¯ÙŠÙ„Ù‡:'
          : 'âš™ï¸ Bot Configuration\n\nWhat would you like to edit?';
        const cfgKb = [
          [{ text: lang === 'ar' ? 'ðŸ“ Ø§Ù„ØªØ±Ø­ÙŠØ¨' : 'ðŸ“ Welcome Msg' }, { text: lang === 'ar' ? 'â¸ï¸ Ø±Ø³Ø§Ù„Ø© Ø§Ù„Ø¥ÙŠÙ‚Ø§Ù' : 'â¸ï¸ Maintenance Msg' }],
          [{ text: lang === 'ar' ? 'â“ Ø±Ø³Ø§Ù„Ø© Ø§Ù„Ø²Ø± Ø§Ù„ÙØ§Ø±Øº' : 'â“ Empty Button Msg' }, { text: lang === 'ar' ? 'â“ Ø±Ø³Ø§Ù„Ø© Ù†Øµ ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ' : 'â“ Unknown Text Msg' }],
          [{ text: lang === 'ar' ? 'âš ï¸ Ø±Ø³Ø§Ù„Ø© Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ù„Ù' : 'âš ï¸ No File Msg' }],
          [{ text: lang === 'ar' ? 'ðŸ  Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠØ©' : 'ðŸ  Home' }]
        ];
        await this.apiCall('sendMessage', { chat_id: chatId, text: cfgText, reply_markup: { keyboard: cfgKb, resize_keyboard: true } });
      } else if (text.includes('Ø¥Ø¶Ø§ÙØ© Ù…Ø´Ø±Ù') || text.includes('Add Sub-Admin')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_subadmin_id' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ù…Ø¹Ø±Ù (ID) Ø§Ù„Ø®Ø§Øµ Ø¨Ø§Ù„Ù…Ø´Ø±Ù Ø§Ù„ÙØ±Ø¹ÙŠ Ø§Ù„Ø¬Ø¯ÙŠØ¯ Ù„ÙŠØªÙ… Ø¥Ø¶Ø§ÙØªÙ‡:' : 'Please send the Telegram Chat ID of the new sub-admin:', reply_markup: { remove_keyboard: true }});
      }
      return;
    }

    // --- CORE SETTINGS ---
    if (state.action === 'managing_config') {
      if (text.includes('Ø§Ù„ØªØ±Ø­ÙŠØ¨') || text.includes('Welcome Msg')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_welcome_ar' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø±Ø³Ø§Ù„Ø© Ø§Ù„ØªØ±Ø­ÙŠØ¨ Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø© (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Send new welcome message (Arabic):', reply_markup: { remove_keyboard: true } });
      } else if (text.includes('Ø±Ø³Ø§Ù„Ø© Ø§Ù„Ø¥ÙŠÙ‚Ø§Ù') || text.includes('Maintenance Msg')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_disabled_msg_ar' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø±Ø³Ø§Ù„Ø© Ø§Ù„Ø¥ÙŠÙ‚Ø§Ù Ù„Ù„ØµÙŠØ§Ù†Ø© (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Send maintenance message (Arabic):', reply_markup: { remove_keyboard: true } });
      } else if (text.includes('Ø±Ø³Ø§Ù„Ø© Ø§Ù„Ø²Ø± Ø§Ù„ÙØ§Ø±Øº') || text.includes('Empty Button Msg')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_empty_msg_ar' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ø±Ø³Ø§Ù„Ø© Ø§Ù„ØªÙŠ ØªØ¸Ù‡Ø± Ø¹Ù†Ø¯ Ø§Ù„Ø¶ØºØ· Ø¹Ù„Ù‰ Ø²Ø± Ù„Ø§ ÙŠØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ù†Øµ Ù…Ø®ØµØµ (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Send new empty button message (Arabic):', reply_markup: { remove_keyboard: true } });
      } else if (text.includes('Ù†Øµ ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ') || text.includes('Unknown Text Msg')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_unknown_msg_ar' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ø±Ø³Ø§Ù„Ø© Ø§Ù„ØªÙŠ ØªØ¸Ù‡Ø± Ø¹Ù†Ø¯Ù…Ø§ ÙŠØ±Ø³Ù„ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù†ØµØ§Ù‹ Ù„Ø§ ÙŠÙÙ‡Ù…Ù‡ Ø§Ù„Ø¨ÙˆØª (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Send message for unknown user input (Arabic):', reply_markup: { remove_keyboard: true } });
      } else if (text.includes('Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ù„Ù') || text.includes('No File Msg')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_no_file_msg_ar' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ø±Ø³Ø§Ù„Ø© Ø§Ù„ØªÙŠ ØªØ¸Ù‡Ø± Ø¹Ù†Ø¯Ù…Ø§ ÙŠØ­Ø§ÙˆÙ„ Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ÙØªØ­ Ø²Ø± Ù…Ù„Ù ÙˆÙ„ÙƒÙ† Ø§Ù„Ù…Ù„Ù Ù…Ø­Ø°ÙˆÙ (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Send message when a file is missing (Arabic):', reply_markup: { remove_keyboard: true } });
      }
      return;
    }

    // --- MANAGING MENUS ---
    if (state.action === 'managing_menus') {
      // 1. Check if they clicked a specific menu from the list
      const match = text.match(/\(#(\d+)\)/);
      if (match) {
        const menuId = parseInt(match[1], 10);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: menuId });
        await this.sendAdminMenuDetails(chatId, menuId, lang);
        return;
      }

      // 2. Navigation Actions
      if (text.includes('Ø§Ù„Ù…Ø³ØªÙˆÙ‰ Ø§Ù„Ø³Ø§Ø¨Ù‚') || text.includes('Parent Menu')) {
        if (state.currentMenuId !== null) {
          const pMenu = await dbHelper.getMenuById(state.currentMenuId);
          const targetId = pMenu ? pMenu.parent_id : null;
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: targetId, viewingMenuDetailsId: null });
          await this.sendAdminReplyMenus(chatId, targetId, lang);
        }
        return;
      }

      // 3. Details Actions (when viewingMenuDetailsId is set)
      if (state.viewingMenuDetailsId) {
        const menuId = state.viewingMenuDetailsId;
        if (text.includes('Ø¹ÙˆØ¯Ø© Ù„Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø³Ø§Ø¨Ù‚Ø©') || text.includes('Back to Parent')) {
          const menu = await dbHelper.getMenuById(menuId);
          const targetId = menu ? menu.parent_id : null;
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: targetId, viewingMenuDetailsId: null });
          await this.sendAdminReplyMenus(chatId, targetId, lang);
        } else if (text.includes('Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„ØªØ³Ù…ÙŠØ©') || text.includes('Rename')) {
          await dbHelper.setAdminState(chatId, { action: 'awaiting_rename_title_ar', menuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ø§Ø³Ù… Ø§Ù„Ø¬Ø¯ÙŠØ¯ Ù„Ù„Ø²Ø± (Ø¨Ø§Ù„Ù„ØºØ© Ø§Ù„Ø¹Ø±Ø¨ÙŠØ©):' : 'Send the new name in Arabic:', reply_markup: { remove_keyboard: true } });
        } else if (text.includes('ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„Ù…Ø­ØªÙˆÙ‰') || text.includes('Edit Content')) {
          const menu = await dbHelper.getMenuById(menuId);
          if (menu.reply_type === 'submenu') {
             await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_submenu_ar', menuId });
             await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ø±Ø³Ø§Ù„Ø© Ø§Ù„ØªÙ…Ù‡ÙŠØ¯ÙŠØ© Ø§Ù„ØªÙŠ Ø³ØªØ¸Ù‡Ø± Ø¹Ù†Ø¯ Ø¯Ø®ÙˆÙ„ Ù‡Ø°Ù‡ Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Send the prompt message for this submenu (Arabic):', reply_markup: { remove_keyboard: true } });
          } else if (menu.reply_type === 'text') {
             await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_text_ar', menuId });
             await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ù†Øµ Ø§Ù„Ø¬Ø¯ÙŠØ¯ (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Send the new text (Arabic):', reply_markup: { remove_keyboard: true } });
          } else if (menu.reply_type === 'file') {
             await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_file_doc', menuId });
             await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ù…Ù„Ù Ø§Ù„Ø¬Ø¯ÙŠØ¯. ÙˆÙŠÙ…ÙƒÙ†Ùƒ Ø¥Ø±ÙØ§Ù‚ Ø§Ù„Ø´Ø±Ø­ Ø¨Ø§Ù„Ù„ØºØ© Ø§Ù„Ø¹Ø±Ø¨ÙŠØ© Ù…Ø¹Ù‡:' : 'Send the new file, with optional Arabic caption:', reply_markup: { remove_keyboard: true } });
          }
        } else if (text.includes('Ø§Ø³ØªØ¨Ø¯Ø§Ù„ Ø§Ù„Ù…Ù„Ù') || text.includes('Replace File')) {
          await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_file_doc', menuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ù…Ù„Ù Ø§Ù„Ø¬Ø¯ÙŠØ¯ Ø§Ù„Ø¢Ù†ØŒ Ø£Ùˆ Ø£Ø±Ø³Ù„ /skip Ù„ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„Ø´Ø±Ø­ ÙÙ‚Ø·:' : 'Send the new file, or /skip to only edit caption:', reply_markup: { remove_keyboard: true } });
        } else if (text.includes('Ø£Ø²Ø±Ø§Ø± Ø´ÙØ§ÙØ©') || text.includes('Inline Buttons')) {
          await dbHelper.setAdminState(chatId, { action: 'awaiting_inline_btn', menuId });
          const m = lang === 'ar' 
            ? 'Ø¥Ø¶Ø§ÙØ© Ø²Ø± Ø´ÙØ§Ù (Ø±Ø§Ø¨Ø·)\n\nØ£Ø±Ø³Ù„ Ø§Ø³Ù… Ø§Ù„Ø²Ø± ÙˆØ§Ù„Ø±Ø§Ø¨Ø· Ù…ÙØµÙˆÙ„ÙŠÙ† Ø¨Ø´Ø±Ø·Ø© (-)\nÙ…Ø«Ø§Ù„: `Ù…ÙˆÙ‚Ø¹ Ø§Ù„Ø¬Ø§Ù…Ø¹Ø© - https://example.com`\nØ£Ùˆ Ø£Ø±Ø³Ù„ /clear Ù„Ù…Ø³Ø­ Ø§Ù„Ø£Ø²Ø±Ø§Ø± Ø§Ù„Ø­Ø§Ù„ÙŠØ©.' 
            : 'Add Inline Button (URL)\n\nSend title and URL separated by hyphen (-)\nExample: `Website - https://example.com`\nOr send /clear to remove all.';
          await this.apiCall('sendMessage', { chat_id: chatId, text: m, parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
        } else if (text.includes('ØªØºÙŠÙŠØ± Ø§Ù„ØªØ±ØªÙŠØ¨') || text.includes('Change Order')) {
          await dbHelper.setAdminState(chatId, { action: 'managing_menus_move_order', currentMenuId: state.currentMenuId, viewingMenuDetailsId: menuId });
          await this.sendAdminMoveOrder(chatId, menuId, lang);
        } else if (text.includes('Ù†Ù‚Ù„ Ø¥Ù„Ù‰ Ù‚Ø§Ø¦Ù…Ø© Ø£Ø®Ø±Ù‰') || text.includes('Move Menu')) {
          await dbHelper.setAdminState(chatId, { action: 'awaiting_move_target', menuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ù€ ID Ø§Ù„Ø®Ø§Øµ Ø¨Ø§Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ù‡Ø¯Ù (Ø§ÙƒØªØ¨ null Ù„Ù†Ù‚Ù„Ù‡ Ù„Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠØ©):' : 'Send target Menu ID (or null for root):', reply_markup: { remove_keyboard: true } });
        } else if (text.includes('Ø­Ø°Ù Ø§Ù„Ø²Ø±') || text.includes('Delete Button')) {
          const menu = await dbHelper.getMenuById(menuId);
          if (menu) {
            const parentId = menu.parent_id;
            await dbHelper.deleteMenu(menuId);
            await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ØªÙ… Ø§Ù„Ø­Ø°Ù Ø¨Ù†Ø¬Ø§Ø­.' : 'Deleted successfully.' });
            await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: parentId, viewingMenuDetailsId: null });
            await this.sendAdminReplyMenus(chatId, parentId, lang);
          }
        }
        return;
      }

      // 4. Add Actions (when viewing sibling list)
      if (text.includes('Ø¥Ø¶Ø§ÙØ© Ø²Ø± Ø¬Ø¯ÙŠØ¯') || text.includes('Add New Button')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus_add_type', currentMenuId: state.currentMenuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ù…Ø§ Ù†ÙˆØ¹ Ø§Ù„Ø²Ø± Ø§Ù„Ø¬Ø¯ÙŠØ¯ØŸ' : 'What type of button?', reply_markup: {
          keyboard: [
            [{ text: lang === 'ar' ? 'ðŸ“ Ø²Ø± Ù‚Ø§Ø¦Ù…Ø© (Ù…Ø¬Ù„Ø¯)' : 'ðŸ“ Menu Button (Folder)' }],
            [{ text: lang === 'ar' ? 'ðŸ“„ Ø²Ø± Ù…Ù„ÙØ§Øª' : 'ðŸ“„ File Button' }],
            [{ text: lang === 'ar' ? 'ðŸ“ Ø²Ø± Ù†ØµÙŠ' : 'ðŸ“ Text Button' }],
            [{ text: lang === 'ar' ? 'â¬…ï¸ Ø¥Ù„ØºØ§Ø¡' : 'â¬…ï¸ Cancel' }]
          ], resize_keyboard: true
        }});
        return;
      }
    }

    if (state.action === 'managing_menus_add_type') {
      if (text.includes('Ø¥Ù„ØºØ§Ø¡') || text.includes('Cancel')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: null });
        await this.sendAdminReplyMenus(chatId, state.currentMenuId, lang);
        return;
      }
      let type = null;
      if (text.includes('Ù‚Ø§Ø¦Ù…Ø©') || text.includes('Folder')) type = 'submenu';
      else if (text.includes('Ù…Ù„ÙØ§Øª') || text.includes('File')) type = 'file';
      else if (text.includes('Ù†ØµÙŠ') || text.includes('Text')) type = 'text';

      if (type) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_newmenu_title_ar', currentMenuId: state.currentMenuId, newType: type });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ø³Ù… Ø§Ù„Ø²Ø± Ø§Ù„Ø¬Ø¯ÙŠØ¯ (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠØ©):' : 'Send the new button name (Arabic):', reply_markup: { remove_keyboard: true } });
      }
      return;
    }

    if (state.action === 'managing_menus_move_order') {
      if (text.includes('Ø¥Ù„ØºØ§Ø¡ Ø§Ù„ØªØ±ØªÙŠØ¨') || text.includes('Cancel Order')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: state.viewingMenuDetailsId });
        await this.sendAdminMenuDetails(chatId, state.viewingMenuDetailsId, lang);
        return;
      }
      let direction = null;
      if (text.includes('Up') || text.includes('â¬†ï¸')) direction = 'up';
      if (text.includes('Down') || text.includes('â¬‡ï¸')) direction = 'down';

      if (direction) {
        await this.moveMenuOrder(chatId, state.viewingMenuDetailsId, direction, lang);
      }
      return;
    }

    // --- NORMAL AWAITING STATES ---
    switch (state.action) {
      case 'awaiting_subadmin_id':
        if (!/^\d+$/.test(text)) {
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ù…Ø¹Ø±Ù ØºÙŠØ± ØµØ§Ù„Ø­. ÙŠØ¬Ø¨ Ø£Ù† ÙŠØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ø£Ø±Ù‚Ø§Ù… ÙÙ‚Ø·.' : 'Invalid ID. Must contain only digits.' });
          return;
        }
        const facultyData = await dbHelper.getFacultyById(this.facultyId);
        const currentAdmins = facultyData.admin_chat_id ? facultyData.admin_chat_id.split(',').map(s => s.trim()) : [];
        if (currentAdmins.includes(text)) {
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ù‡Ø°Ø§ Ø§Ù„Ù…Ø¹Ø±Ù Ù…ÙˆØ¬ÙˆØ¯ Ù…Ø³Ø¨Ù‚Ø§Ù‹.' : 'This ID already exists.' });
        } else {
          currentAdmins.push(text);
          await dbHelper.updateFaculty(facultyData.id, facultyData.name_en, facultyData.name_ar, facultyData.slug, facultyData.telegram_token, currentAdmins.join(','), facultyData.welcome_en, facultyData.welcome_ar, facultyData.bot_enabled, facultyData.disabled_message_en, facultyData.disabled_message_ar, facultyData.telegram_api_server, facultyData.empty_msg_en, facultyData.empty_msg_ar, facultyData.unknown_msg_en, facultyData.unknown_msg_ar, facultyData.no_file_msg_en, facultyData.no_file_msg_ar);
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? `âœ… ØªÙ… Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù…Ø´Ø±Ù Ø¨Ù†Ø¬Ø§Ø­.\n\nØ§Ù„Ù…Ø´Ø±ÙÙˆÙ† Ø§Ù„Ø­Ø§Ù„ÙŠÙˆÙ†:\n${currentAdmins.join('\n')}` : `âœ… Sub-admin added.\n\nCurrent admins:\n${currentAdmins.join('\n')}` });
        }
        await dbHelper.deleteAdminState(chatId);
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_announcement_title_ar':
        state.titleAr = text;
        state.action = 'awaiting_announcement_content_ar';
        await dbHelper.setAdminState(chatId, state);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ù…Ù…ØªØ§Ø². Ø§Ù„Ø¢Ù† Ø£Ø±Ø³Ù„ Ù…Ø­ØªÙˆÙ‰ Ø§Ù„Ø¥Ø¹Ù„Ø§Ù† Ø§Ù„ØªÙØµÙŠÙ„ÙŠ (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'Great. Now send the detailed content (Arabic):' });
        break;

      case 'awaiting_announcement_content_ar':
        state.contentAr = text;
        const statusAnnMsg = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ðŸ”„ Ø¬Ø§Ø±ÙŠ ØªØ±Ø¬Ù…Ø© Ø§Ù„Ø¥Ø¹Ù„Ø§Ù† ØªÙ„Ù‚Ø§Ø¦ÙŠØ§Ù‹...' : 'ðŸ”„ Translating announcement...' });
        
        state.titleEn = await this.translateArToEn(state.titleAr);
        state.contentEn = await this.translateArToEn(state.contentAr);
        state.action = 'awaiting_announcement_file';
        await dbHelper.setAdminState(chatId, state);

        if (statusAnnMsg.result) {
          await this.apiCall('deleteMessage', { chat_id: chatId, message_id: statusAnnMsg.result.message_id }).catch(()=>({}));
        }

        await this.apiCall('sendMessage', { 
          chat_id: chatId, 
          text: lang === 'ar' ? 'ØªÙ…Øª Ø§Ù„ØªØ±Ø¬Ù…Ø©. Ø¥Ø°Ø§ ÙƒØ§Ù† Ù‡Ù†Ø§Ùƒ Ù…Ù„Ù Ù…Ø±ÙÙ‚ Ù„Ù„Ø¥Ø¹Ù„Ø§Ù† Ø£Ø±Ø³Ù„Ù‡ Ø§Ù„Ø¢Ù†ØŒ Ø£Ùˆ Ø£Ø±Ø³Ù„ /skip Ù„ØªØ®Ø·ÙŠ Ø¥Ø±ÙØ§Ù‚ Ù…Ù„Ù ÙˆØ¨Ø« Ø§Ù„Ø¥Ø¹Ù„Ø§Ù† Ù…Ø¨Ø§Ø´Ø±Ø©.' : 'Translated. Send an attachment file now, or /skip to broadcast without a file.'
        });
        break;

      case 'awaiting_announcement_file':
        if (text === '/skip') {
          await this.handleAdminAnnouncementBroadcast(chatId, state, null, lang);
        } else {
          const doc = this.extractTelegramAttachment(message);
          if (doc) {
            await this.handleAdminAnnouncementBroadcast(chatId, state, doc, lang);
          } else {
            await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø¹Ø°Ø±Ø§Ù‹ØŒ Ù„Ù… Ø£ØªÙ…ÙƒÙ† Ù…Ù† Ø§Ù„ØªØ¹Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ù…Ù„Ù. Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø§Ù„Ø¥Ø±Ø³Ø§Ù„ ÙƒÙ€ Document Ø£Ùˆ Ø£Ø±Ø³Ù„ /skip.' : 'File not recognized. Send as Document or /skip.' });
          }
        }
        break;

      case 'awaiting_rename_title_ar':
        const rTitleEn = await this.translateArToEn(text);
        const rMenu = await dbHelper.getMenuById(state.menuId);
        await dbHelper.updateMenu(state.menuId, rMenu.parent_id, rTitleEn, text, rMenu.reply_type, rMenu.reply_content_en, rMenu.reply_content_ar, rMenu.file_name, rMenu.telegram_file_id, rMenu.mime_type, rMenu.file_size, rMenu.sort_order);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: rMenu.parent_id, viewingMenuDetailsId: state.menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ…Øª Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„ØªØ³Ù…ÙŠØ© Ø¨Ù†Ø¬Ø§Ø­!' : 'âœ… Renamed!' });
        await this.sendAdminMenuDetails(chatId, state.menuId, lang);
        break;

      case 'awaiting_edit_submenu_ar':
        const rSubEn = await this.translateArToEn(text);
        const rMenu2 = await dbHelper.getMenuById(state.menuId);
        await dbHelper.updateMenu(state.menuId, rMenu2.parent_id, rMenu2.title_en, rMenu2.title_ar, rMenu2.reply_type, rSubEn, text, rMenu2.file_name, rMenu2.telegram_file_id, rMenu2.mime_type, rMenu2.file_size, rMenu2.sort_order);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: rMenu2.parent_id, viewingMenuDetailsId: state.menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… ØªØ­Ø¯ÙŠØ« Ø§Ù„Ø±Ø³Ø§Ù„Ø© Ø§Ù„ØªÙ…Ù‡ÙŠØ¯ÙŠØ©!' : 'âœ… Prompt message updated!' });
        await this.sendAdminMenuDetails(chatId, state.menuId, lang);
        break;

      case 'awaiting_edit_text_ar':
        const textEn = await this.translateArToEn(text);
        const m1 = await dbHelper.getMenuById(state.menuId);
        await dbHelper.updateMenu(state.menuId, m1.parent_id, m1.title_en, m1.title_ar, 'text', textEn, text, m1.file_name, m1.telegram_file_id, m1.mime_type, m1.file_size, m1.sort_order);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: m1.parent_id, viewingMenuDetailsId: state.menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… ØªØ­Ø¯ÙŠØ« Ø§Ù„Ù†Øµ!' : 'âœ… Text updated!' });
        await this.sendAdminMenuDetails(chatId, state.menuId, lang);
        break;

      case 'awaiting_replace_file_doc':
        if (text === '/cancel') {
          const mCancel = await dbHelper.getMenuById(state.menuId);
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: mCancel.parent_id, viewingMenuDetailsId: state.menuId });
          await this.sendAdminMenuDetails(chatId, state.menuId, lang);
          return;
        }
        const docReplace = this.extractTelegramAttachment(message);
        if (docReplace) {
          try {
            await dbHelper.runQuery('DELETE FROM menu_files WHERE menu_id = $1', [state.menuId]);
            await dbHelper.addMenuFile(state.menuId, docReplace.file_id, docReplace.file_name, docReplace.mime_type, docReplace.file_size);
            
            state.action = 'awaiting_edit_file_doc';
            await dbHelper.setAdminState(chatId, state);
            
            const doneBtn = lang === 'ar' ? 'âœ… ØªÙ…' : 'âœ… Done';
            await this.apiCall('sendMessage', { 
              chat_id: chatId, 
              text: lang === 'ar' ? 'âœ… ØªÙ… Ø§Ø³ØªØ¨Ø¯Ø§Ù„ Ø§Ù„Ù…Ù„ÙØ§Øª ÙˆØ§Ø³ØªÙ„Ø§Ù… Ø§Ù„Ù…Ù„Ù Ø§Ù„Ø£ÙˆÙ„. Ø£Ø±Ø³Ù„ Ø§Ù„Ù…Ø²ÙŠØ¯ Ø£Ùˆ Ø§Ø¶ØºØ· "ØªÙ…":' : 'âœ… Files replaced. Send more or press "Done":',
              reply_markup: { keyboard: [[{ text: doneBtn }]], resize_keyboard: true }
            });
          } catch (e) {
            await this.apiCall('sendMessage', { chat_id: chatId, text: `âŒ Error: ${e.message}` });
          }
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ Ù…Ù„Ù.' : 'Please send a document.' });
        }
        break;

      case 'awaiting_edit_file_doc':
        if (text === '/skip' || text === 'âœ… Done' || text === 'âœ… ØªÙ…' || text === '/done') {
          state.action = 'awaiting_edit_file_cap_ar';
          await dbHelper.setAdminState(chatId, state);
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø£Ø±Ø³Ù„ Ø§Ù„Ø´Ø±Ø­ Ø§Ù„Ø¬Ø¯ÙŠØ¯ Ù„Ù„Ù…Ù„Ù (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ) Ø£Ùˆ /skip Ù„Ù„Ø§Ø­ØªÙØ§Ø¸ Ø¨Ø§Ù„Ø­Ø§Ù„ÙŠ:' : 'Send new Arabic caption, or /skip to keep current:', reply_markup: { remove_keyboard: true } });
        } else {
          const doc2 = this.extractTelegramAttachment(message);
          if (doc2) {
            try {
              await dbHelper.addMenuFile(state.menuId, doc2.file_id, doc2.file_name, doc2.mime_type, doc2.file_size);
              
              if (message.caption && !state.captionAr) {
                state.captionAr = message.caption;
                state.captionEn = await this.translateArToEn(message.caption);
                const m2 = await dbHelper.getMenuById(state.menuId);
                await dbHelper.updateMenu(state.menuId, m2.parent_id, m2.title_en, m2.title_ar, 'file', state.captionEn, state.captionAr, doc2.file_name, doc2.file_id, doc2.mime_type, doc2.file_size, m2.sort_order);
              }

              const files = await dbHelper.getMenuFiles(state.menuId);
              const doneBtn = lang === 'ar' ? 'âœ… ØªÙ…' : 'âœ… Done';
              const msg = lang === 'ar' 
                ? `âœ… ØªÙ… Ø¥Ø¶Ø§ÙØ© Ù…Ù„Ù. Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ: ${files.length}\nØ£Ø±Ø³Ù„ Ø§Ù„Ù…Ø²ÙŠØ¯ØŒ Ø£Ùˆ Ø§Ø¶ØºØ· "ØªÙ…":`
                : `âœ… File added. Total: ${files.length}\nSend more, or press "Done":`;
                
              await this.apiCall('sendMessage', { 
                chat_id: chatId, 
                text: msg,
                reply_markup: { keyboard: [[{ text: doneBtn }]], resize_keyboard: true }
              });
            } catch (e) {
               await this.apiCall('sendMessage', { chat_id: chatId, text: `âŒ Error: ${e.message}` });
            }
          } else {
            await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø¥Ø±Ø³Ø§Ù„ Ù…Ù„Ù (Document) Ø£Ùˆ Ø§Ù„Ø¶ØºØ· Ø¹Ù„Ù‰ "ØªÙ…".' : 'Please send a document or press "Done".' });
          }
        }
        break;

      case 'awaiting_edit_file_cap_ar':
        const m3 = await dbHelper.getMenuById(state.menuId);
        let cAr = m3.reply_content_ar;
        let cEn = m3.reply_content_en;
        if (text !== '/skip' && text !== 'âœ… Done' && text !== 'âœ… ØªÙ…') {
          cAr = text;
          cEn = await this.translateArToEn(text);
        }
        
        await dbHelper.updateMenu(state.menuId, m3.parent_id, m3.title_en, m3.title_ar, 'file', cEn, cAr, m3.file_name, m3.telegram_file_id, m3.mime_type, m3.file_size, m3.sort_order);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: m3.parent_id, viewingMenuDetailsId: state.menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø§Ù„Ø­ÙØ¸ Ø¨Ù†Ø¬Ø§Ø­!' : 'âœ… Saved successfully!', reply_markup: { remove_keyboard: true } });
        await this.sendAdminMenuDetails(chatId, state.menuId, lang);
        break;

      case 'awaiting_move_target':
        const m4 = await dbHelper.getMenuById(state.menuId);
        const targetMenuId = text === 'null' ? null : parseInt(text, 10);
        await dbHelper.updateMenu(state.menuId, targetMenuId, m4.title_en, m4.title_ar, m4.reply_type, m4.reply_content_en, m4.reply_content_ar, m4.file_name, m4.telegram_file_id, m4.mime_type, m4.file_size, m4.sort_order);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: targetMenuId, viewingMenuDetailsId: state.menuId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø§Ù„Ù†Ù‚Ù„ Ø¨Ù†Ø¬Ø§Ø­!' : 'âœ… Moved successfully!' });
        await this.sendAdminMenuDetails(chatId, state.menuId, lang);
        break;

      case 'awaiting_newmenu_title_ar':
        const nTitleEn = await this.translateArToEn(text);
        const lastOrderRes = await dbHelper.runQuery('SELECT MAX(sort_order) as max_order FROM menus WHERE parent_id IS NOT DISTINCT FROM $1 AND faculty_id = $2', [state.currentMenuId, this.facultyId]);
        const nextOrder = (lastOrderRes.rows[0].max_order || 0) + 1;
        
        if (state.newType === 'submenu') {
          const newMenuId = await dbHelper.createMenu(this.facultyId, state.currentMenuId, nTitleEn, text, 'submenu', null, null, null, null, null, null, nextOrder);
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: newMenuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ…Øª Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ù‚Ø§Ø¦Ù…Ø©! ÙŠÙ…ÙƒÙ†Ùƒ Ø§Ù„Ø¯Ø®ÙˆÙ„ Ø¥Ù„ÙŠÙ‡Ø§ Ø§Ù„Ø¢Ù† Ù„Ø¥Ø¶Ø§ÙØ© Ø£Ø²Ø±Ø§Ø± ÙØ±Ø¹ÙŠØ©.' : 'âœ… Submenu added!' });
          await this.sendAdminMenuDetails(chatId, newMenuId, lang);
        } else if (state.newType === 'text') {
          const newMenuId = await dbHelper.createMenu(this.facultyId, state.currentMenuId, nTitleEn, text, 'text', null, null, null, null, null, null, nextOrder);
          await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_text_ar', menuId: newMenuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø­ÙØ¸ Ø§Ù„Ø§Ø³Ù…. Ø£Ø±Ø³Ù„ Ø§Ù„Ø¢Ù† Ø§Ù„Ù…Ø­ØªÙˆÙ‰ Ø§Ù„Ù†ØµÙŠ Ù„Ù„Ø²Ø± (Ø¨Ø§Ù„Ø¹Ø±Ø¨ÙŠ):' : 'âœ… Name saved. Send text content (Arabic):' });
        } else if (state.newType === 'file') {
          const newMenuId = await dbHelper.createMenu(this.facultyId, state.currentMenuId, nTitleEn, text, 'file', null, null, null, null, null, null, nextOrder);
          await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_file_doc', menuId: newMenuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø­ÙØ¸ Ø§Ù„Ø§Ø³Ù…. Ø£Ø±Ø³Ù„ Ø§Ù„Ø¢Ù† Ø§Ù„Ù…Ù„Ù Ø§Ù„Ù…Ø±ÙÙ‚ (Document):' : 'âœ… Name saved. Send the file document:' });
        }
        break;

      case 'awaiting_welcome_ar':
        const fac2 = await dbHelper.getFacultyById(this.facultyId);
        const welEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac2.id, fac2.name_en, fac2.name_ar, fac2.slug, fac2.telegram_token, fac2.admin_chat_id, welEn, text, fac2.bot_enabled, fac2.disabled_message_en, fac2.disabled_message_ar, fac2.telegram_api_server, fac2.empty_msg_en, fac2.empty_msg_ar, fac2.unknown_msg_en, fac2.unknown_msg_ar, fac2.no_file_msg_en, fac2.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø§Ù„ØªØ­Ø¯ÙŠØ«!' : 'âœ… Updated!' });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_disabled_msg_ar':
        const fac1 = await dbHelper.getFacultyById(this.facultyId);
        const disEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac1.id, fac1.name_en, fac1.name_ar, fac1.slug, fac1.telegram_token, fac1.admin_chat_id, fac1.welcome_en, fac1.welcome_ar, fac1.bot_enabled, disEn, text, fac1.telegram_api_server, fac1.empty_msg_en, fac1.empty_msg_ar, fac1.unknown_msg_en, fac1.unknown_msg_ar, fac1.no_file_msg_en, fac1.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø§Ù„ØªØ­Ø¯ÙŠØ«!' : 'âœ… Updated!' });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_empty_msg_ar':
        const fac3 = await dbHelper.getFacultyById(this.facultyId);
        const empEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac3.id, fac3.name_en, fac3.name_ar, fac3.slug, fac3.telegram_token, fac3.admin_chat_id, fac3.welcome_en, fac3.welcome_ar, fac3.bot_enabled, fac3.disabled_message_en, fac3.disabled_message_ar, fac3.telegram_api_server, empEn, text, fac3.unknown_msg_en, fac3.unknown_msg_ar, fac3.no_file_msg_en, fac3.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… ØªØ­Ø¯ÙŠØ« Ø±Ø³Ø§Ù„Ø© Ø§Ù„Ø²Ø± Ø§Ù„ÙØ§Ø±Øº!' : 'âœ… Updated!' });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_unknown_msg_ar':
        const fac4 = await dbHelper.getFacultyById(this.facultyId);
        const unkEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac4.id, fac4.name_en, fac4.name_ar, fac4.slug, fac4.telegram_token, fac4.admin_chat_id, fac4.welcome_en, fac4.welcome_ar, fac4.bot_enabled, fac4.disabled_message_en, fac4.disabled_message_ar, fac4.telegram_api_server, fac4.empty_msg_en, fac4.empty_msg_ar, unkEn, text, fac4.no_file_msg_en, fac4.no_file_msg_ar);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… ØªØ­Ø¯ÙŠØ« Ø±Ø³Ø§Ù„Ø© Ø§Ù„Ù†Øµ ØºÙŠØ± Ø§Ù„Ù…Ø¹Ø±ÙˆÙ!' : 'âœ… Updated!' });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_no_file_msg_ar':
        const fac5 = await dbHelper.getFacultyById(this.facultyId);
        const nofEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac5.id, fac5.name_en, fac5.name_ar, fac5.slug, fac5.telegram_token, fac5.admin_chat_id, fac5.welcome_en, fac5.welcome_ar, fac5.bot_enabled, fac5.disabled_message_en, fac5.disabled_message_ar, fac5.telegram_api_server, fac5.empty_msg_en, fac5.empty_msg_ar, fac5.unknown_msg_en, fac5.unknown_msg_ar, nofEn, text);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… ØªØ­Ø¯ÙŠØ« Ø±Ø³Ø§Ù„Ø© ÙÙ‚Ø¯Ø§Ù† Ø§Ù„Ù…Ù„Ù!' : 'âœ… Updated!' });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_inline_btn':
        const menuBtn = await dbHelper.getMenuById(state.menuId);
        if (text === '/clear') {
          await dbHelper.updateMenu(menuBtn.id, menuBtn.parent_id, menuBtn.title_en, menuBtn.title_ar, menuBtn.reply_type, menuBtn.reply_content_en, menuBtn.reply_content_ar, menuBtn.file_name, menuBtn.telegram_file_id, menuBtn.mime_type, menuBtn.file_size, menuBtn.sort_order, null);
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuBtn.parent_id, viewingMenuDetailsId: menuBtn.id });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ØªÙ… Ù…Ø³Ø­ Ø§Ù„Ø£Ø²Ø±Ø§Ø± Ø§Ù„Ø´ÙØ§ÙØ©.' : 'Inline buttons cleared.' });
          await this.sendAdminMenuDetails(chatId, menuBtn.id, lang);
          break;
        }

        const btnParts = text.split('-');
        if (btnParts.length < 2) {
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ØªÙ†Ø³ÙŠÙ‚ Ø®Ø§Ø·Ø¦. Ø§Ø³ØªØ®Ø¯Ù…: Ø§Ù„Ø§Ø³Ù… - Ø§Ù„Ø±Ø§Ø¨Ø·' : 'Invalid format. Use: Title - URL' });
          break;
        }

        const bTitleAr = btnParts[0].trim();
        const bUrl = btnParts.slice(1).join('-').trim();
        if (!bUrl.startsWith('http')) {
           await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø§Ù„Ø±Ø§Ø¨Ø· ÙŠØ¬Ø¨ Ø£Ù† ÙŠØ¨Ø¯Ø£ Ø¨Ù€ http Ø£Ùˆ https' : 'URL must start with http or https' });
           break;
        }
        
        const bTitleEn = await this.translateArToEn(bTitleAr);
        const currentBtns = menuBtn.inline_buttons ? JSON.parse(menuBtn.inline_buttons) : [];
        currentBtns.push({ text_ar: bTitleAr, text_en: bTitleEn, url: bUrl });
        
        await dbHelper.updateMenu(menuBtn.id, menuBtn.parent_id, menuBtn.title_en, menuBtn.title_ar, menuBtn.reply_type, menuBtn.reply_content_en, menuBtn.reply_content_ar, menuBtn.file_name, menuBtn.telegram_file_id, menuBtn.mime_type, menuBtn.file_size, menuBtn.sort_order, JSON.stringify(currentBtns));
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuBtn.parent_id, viewingMenuDetailsId: menuBtn.id });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… Ø£Ø¶ÙŠÙ' : 'âœ… Added' });
        await this.sendAdminMenuDetails(chatId, menuBtn.id, lang);
        break;

      default:
        // Clear state if stuck
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ØªÙ… Ø¥Ù†Ù‡Ø§Ø¡ Ø§Ù„Ø¬Ù„Ø³Ø© Ø§Ù„Ø¥Ø¯Ø§Ø±ÙŠØ©.' : 'Admin session closed.', reply_markup: { remove_keyboard: true } });
        break;
    }
  }

  async uploadFileToTelegram(filePath, fileName, mimeType) {
    return new Promise(async (resolve, reject) => {
      try {
        const fs = require('node:fs');
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        if (!faculty || !faculty.admin_chat_id) {
           return reject(new Error('Faculty does not have an admin_chat_id to store the file'));
        }
        
        const targetChatId = faculty.admin_chat_id.split(',')[0].trim();
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

  async handleAdminAnnouncementBroadcast(chatId, state, doc, lang) {
    let fileName = null;
    let telegramFileId = null;
    let mimeType = null;
    let fileSize = null;

    const stMsg = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ðŸ“¢ Ø¬Ø§Ø±ÙŠ Ø§Ù„Ø¨Ø«...' : 'ðŸ“¢ Broadcasting...' });
    
    try {
      if (doc) {
        fileName = doc.file_name || 'attachment';
        telegramFileId = doc.file_id;
        mimeType = doc.mime_type || 'application/octet-stream';
        fileSize = doc.file_size || 0;
      }

      const annId = await dbHelper.createAnnouncement(this.facultyId, state.titleEn, state.titleAr, state.contentEn, state.contentAr, fileName, telegramFileId, mimeType, fileSize);
      
      const announcement = {
        id: annId,
        faculty_id: this.facultyId,
        title_en: state.titleEn,
        title_ar: state.titleAr,
        content_en: state.contentEn,
        content_ar: state.contentAr,
        file_name: fileName,
        telegram_file_id: telegramFileId
      };

      await this.sendAnnouncement(announcement);

      await dbHelper.deleteAdminState(chatId);
      if (stMsg.result) await this.apiCall('deleteMessage', { chat_id: chatId, message_id: stMsg.result.message_id }).catch(()=>({}));
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø§Ù„Ø¨Ø«!' : 'âœ… Broadcasted!' });
      await this.sendAdminHome(chatId, lang);
    } catch(e) {
      this.logError('Broadcast failed', e);
      await this.apiCall('sendMessage', { chat_id: chatId, text: 'âŒ Error: ' + e.message });
      await dbHelper.deleteAdminState(chatId);
    }
  }

  async handleAdminAddFileButton(chatId, state, doc, lang) {
    try {
      const fileName = doc.file_name || 'document';
      const telegramFileId = doc.file_id;
      const mimeType = doc.mime_type || 'application/octet-stream';
      const fileSize = doc.file_size || 0;

      const newMenuId = await dbHelper.createMenu(this.facultyId, state.parentId, state.titleEn, state.titleAr, 'file', state.contentEn, state.contentAr, fileName, telegramFileId, mimeType, fileSize, 0);
      await dbHelper.addMenuFile(newMenuId, telegramFileId, fileName, mimeType, fileSize);

      await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.parentId });
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø¥Ø¶Ø§ÙØ© Ø²Ø± Ø§Ù„Ù…Ù„Ù Ø¨Ù†Ø¬Ø§Ø­!' : 'âœ… File button added!' });
      await this.sendAdminReplyMenus(chatId, state.parentId, lang);
    } catch(e) {
      this.logError('Add file failed', e);
      await this.apiCall('sendMessage', { chat_id: chatId, text: 'âŒ Error: ' + e.message });
      await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.parentId });
      await this.sendAdminReplyMenus(chatId, state.parentId, lang);
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
      await dbHelper.updateMenu(menu.id, menu.parent_id, menu.title_en, menu.title_ar, 'file', state.contentEn, state.contentAr, fileName, telegramFileId, mimeType, fileSize, menu.sort_order);

      await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id });
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'âœ… ØªÙ… Ø§Ù„ØªØ­Ø¯ÙŠØ«' : 'âœ… Updated' });
      await this.sendAdminMenuDetails(chatId, menu.id, lang);
    } catch(e) {
      this.logError('Edit file failed', e);
      await this.apiCall('sendMessage', { chat_id: chatId, text: 'âŒ Error: ' + e.message });
    }
  }

  async sendAdminHome(chatId, lang) {
    const faculty = await dbHelper.getFacultyById(this.facultyId);
    const centralAdminId = faculty && faculty.admin_chat_id ? faculty.admin_chat_id.split(',')[0].trim() : null;
    const isCentralAdmin = centralAdminId === chatId;

    const keyboard = [
      [{ text: lang === 'ar' ? 'ðŸ“‚ Ø¥Ø¯Ø§Ø±Ø© Ø§Ù„Ù‚ÙˆØ§Ø¦Ù… ÙˆØ§Ù„Ù…Ù„ÙØ§Øª' : 'ðŸ“‚ Manage Menus & Files' }],
      [{ text: lang === 'ar' ? 'ðŸ“¢ Ø¥Ø±Ø³Ø§Ù„ Ø¥Ø¹Ù„Ø§Ù† Ø¬Ø¯ÙŠØ¯' : 'ðŸ“¢ Broadcast Announcement' },
       { text: lang === 'ar' ? 'ðŸ“Š Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª Ø§Ù„Ø¨ÙˆØª' : 'ðŸ“Š Bot Statistics' }]
    ];
    
    if (isCentralAdmin) {
      keyboard.push([
        { text: lang === 'ar' ? 'âš™ï¸ Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ø¨ÙˆØª Ø§Ù„Ø£Ø³Ø§Ø³ÙŠØ©' : 'âš™ï¸ Core Settings' },
        { text: lang === 'ar' ? 'âž• Ø¥Ø¶Ø§ÙØ© Ù…Ø´Ø±Ù ÙØ±Ø¹ÙŠ' : 'âž• Add Sub-Admin' }
      ]);
    }
    
    keyboard.push([{ text: lang === 'ar' ? 'âŒ Ø¥ØºÙ„Ø§Ù‚' : 'âŒ Close' }]);

    await this.apiCall('sendMessage', { 
      chat_id: chatId, 
      text: lang === 'ar' ? 'ðŸ› ï¸ Ù„ÙˆØ­Ø© Ø§Ù„Ù…Ø´Ø±Ù:' : 'ðŸ› ï¸ Admin Panel:', 
      reply_markup: { keyboard, resize_keyboard: true } 
    });
  }

  async sendAdminReplyMenus(chatId, parentId, lang) {
    const menus = await dbHelper.getMenusByFaculty(this.facultyId);
    const siblings = menus.filter(m => m.parent_id === parentId).sort((a,b) => a.sort_order - b.sort_order);
    let txt = lang === 'ar' ? 'ðŸ“‚ Ø§Ù„Ù‚ÙˆØ§Ø¦Ù… Ø§Ù„Ø­Ø§Ù„ÙŠØ©:' : 'ðŸ“‚ Current Menus:';
    if (parentId !== null) {
      const pMenu = menus.find(m => m.id === parentId);
      txt = lang === 'ar' ? `ðŸ“‚ Ø¯Ø§Ø®Ù„: ${pMenu.title_ar}` : `ðŸ“‚ Inside: ${pMenu.title_en}`;
    }

    const kb = [];
    for (const s of siblings) {
      const icon = s.reply_type === 'submenu' ? 'ðŸ“' : (s.reply_type === 'file' ? 'ðŸ“„' : 'ðŸ“');
      const title = lang === 'ar' ? s.title_ar : s.title_en;
      kb.push([{ text: `${icon} ${title} (#${s.id})` }]);
    }

    kb.push([{ text: lang === 'ar' ? 'âž• Ø¥Ø¶Ø§ÙØ© Ø²Ø± Ø¬Ø¯ÙŠØ¯' : 'âž• Add New Button' }]);

    if (parentId !== null) {
      kb.push([{ text: lang === 'ar' ? 'â¬†ï¸ Ø§Ù„Ù…Ø³ØªÙˆÙ‰ Ø§Ù„Ø³Ø§Ø¨Ù‚' : 'â¬†ï¸ Parent Menu' }]);
    }
    kb.push([{ text: lang === 'ar' ? 'ðŸ  Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠØ©' : 'ðŸ  Home' }]);

    await this.apiCall('sendMessage', { 
      chat_id: chatId, 
      text: txt, 
      reply_markup: { keyboard: kb, resize_keyboard: true }
    });
  }

  async sendAdminMenuDetails(chatId, menuId, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu) return;

    const typeStr = menu.reply_type === 'submenu' ? (lang === 'ar' ? '📁 مجلد (قائمة)' : 'Folder') :
                    menu.reply_type === 'file' ? (lang === 'ar' ? '📑 ملف' : 'Files') :
                    (lang === 'ar' ? '📝 نص' : 'Text');

    let txt = lang === 'ar' 
      ? "<b>📋 تفاصيل الزر:</b>\n\n<b>الاسم:</b> \n<b>النوع:</b> "
      : "<b>📋 Button Details:</b>\n\n<b>Name:</b> \n<b>Type:</b> ";

    const kb = [];
    
    // Core actions for all types
    kb.push([
      { text: lang === 'ar' ? '✏️ إعادة التسمية' : '✏️ Rename', callback_data: "admin_rename_" },
      { text: lang === 'ar' ? '🗑️ حذف الزر' : '🗑️ Delete Button', callback_data: "admin_delbtn_" }
    ]);

    // Type specific actions
    if (menu.reply_type === 'submenu') {
      kb.push([{ text: lang === 'ar' ? '📂 فتح المجلد' : '📂 Open Folder', callback_data: "admin_open_" }]);
    } else if (menu.reply_type === 'file') {
      kb.push([{ text: lang === 'ar' ? '🗑️ حذف المحتوى' : '🗑️ Delete Content', callback_data: "admin_delcontent_" }]);
      kb.push([
        { text: lang === 'ar' ? '👁️ معاينة الملفات' : '👁️ Preview Files', callback_data: "admin_previewfiles_" },
        { text: lang === 'ar' ? '➕ إضافة ملف' : '➕ Add File', callback_data: "admin_addfile_" }
      ]);
    } else if (menu.reply_type === 'text') {
      kb.push([{ text: lang === 'ar' ? '🗑️ حذف المحتوى' : '🗑️ Delete Content', callback_data: "admin_delcontent_" }]);
      kb.push([{ text: lang === 'ar' ? '📝 تعديل النص' : '📝 Edit Text', callback_data: "admin_edittext_" }]);
    }

    // Advanced options (Inline buttons, Move, Order)
    kb.push([
      { text: lang === 'ar' ? '🔗 أزرار شفافة' : '🔗 Inline Buttons', callback_data: "admin_inline_" },
      { text: lang === 'ar' ? '🔄 نقل' : '🔄 Move', callback_data: "admin_move_" }
    ]);

    kb.push([{ text: lang === 'ar' ? '↕️ تغيير الترتيب' : '↕️ Change Order', callback_data: "admin_order_" }]);

    // Status Toggles
    const isActive = menu.is_active !== false; 
    const isHidden = menu.is_hidden === true;

    const toggleActiveStr = isActive
      ? (lang === 'ar' ? '🔴 إيقاف الزر' : '🔴 Disable') 
      : (lang === 'ar' ? '🟢 تشغيل الزر' : '🟢 Enable');
    const toggleHiddenStr = isHidden
      ? (lang === 'ar' ? '👁️ إظهار الزر' : '👁️ Show Button')
      : (lang === 'ar' ? '🚫 إخفاء الزر' : '🚫 Hide Button');

    kb.push([
      { text: toggleActiveStr, callback_data: "admin_toggleactive_" },
      { text: toggleHiddenStr, callback_data: "admin_togglehidden_" }
    ]);

    await this.apiCall('sendMessage', { 
      chat_id: chatId, 
      text: txt, 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: kb } 
    });
  }

  async sendAdminMoveOrder(chatId, menuId, lang) {
    const kb = [
      [
        { text: 'â¬†ï¸ Up' },
        { text: 'â¬‡ï¸ Down' }
      ],
      [{ text: lang === 'ar' ? 'â¬…ï¸ Ø¥Ù„ØºØ§Ø¡ Ø§Ù„ØªØ±ØªÙŠØ¨' : 'â¬…ï¸ Cancel Order' }]
    ];
    await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø§Ø®ØªØ± Ø§Ù„Ø§ØªØ¬Ø§Ù‡ Ù„Ø²Ø± Ø§Ù„Ù†Ù‚Ù„:' : 'Choose direction:', reply_markup: { keyboard: kb, resize_keyboard: true } });
  }

  async moveMenuOrder(chatId, menuId, direction, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    const menus = await dbHelper.getMenusByFaculty(this.facultyId);
    const siblings = menus.filter(m => m.parent_id === menu.parent_id).sort((a,b) => a.sort_order - b.sort_order);
    const idx = siblings.findIndex(m => m.id === menuId);

    if (direction === 'up' && idx > 0) {
      const swap = siblings[idx - 1];
      const temp = menu.sort_order;
      await dbHelper.runQuery('UPDATE menus SET sort_order = $1 WHERE id = $2', [swap.sort_order, menu.id]);
      await dbHelper.runQuery('UPDATE menus SET sort_order = $1 WHERE id = $2', [temp, swap.id]);
    } else if (direction === 'down' && idx < siblings.length - 1) {
      const swap = siblings[idx + 1];
      const temp = menu.sort_order;
      await dbHelper.runQuery('UPDATE menus SET sort_order = $1 WHERE id = $2', [swap.sort_order, menu.id]);
      await dbHelper.runQuery('UPDATE menus SET sort_order = $1 WHERE id = $2', [temp, swap.id]);
    }
    await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id, viewingMenuDetailsId: menuId });
    await this.sendAdminMenuDetails(chatId, menuId, lang);
  }

  async sendLanguageSelection(chatId) {
    await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: "Please select your language / Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø§Ø®ØªÙŠØ§Ø± Ø§Ù„Ù„ØºØ©:",
      reply_markup: {
        inline_keyboard: [
          [{ text: "ðŸ‡ºðŸ‡¸ English", callback_data: "lang_en" }, { text: "ðŸ‡¸ðŸ‡¦ Ø§Ù„Ø¹Ø±Ø¨ÙŠØ©", callback_data: "lang_ar" }]
        ]
      }
    });
  }

  async sendMenu(chatId, parentId, lang) {
    const menus = await dbHelper.getMenusByFaculty(this.facultyId);
    const currentLevel = menus.filter(m => m.parent_id === parentId);
    const faculty = await dbHelper.getFacultyById(this.facultyId);
    
    let promptText = '';
    if (parentId === null) {
      promptText = lang === 'ar' ? (faculty.welcome_ar || 'Ù…Ø±Ø­Ø¨Ø§Ù‹ Ø¨Ùƒ') : (faculty.welcome_en || 'Welcome');
    } else {
      const pMenu = menus.find(m => m.id === parentId);
      promptText = lang === 'ar' ? pMenu.title_ar : pMenu.title_en;
    }

    const keyboard = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const row = [{ text: lang === 'ar' ? currentLevel[i].title_ar : currentLevel[i].title_en }];
      if (i + 1 < currentLevel.length) {
        row.push({ text: lang === 'ar' ? currentLevel[i+1].title_ar : currentLevel[i+1].title_en });
      }
      keyboard.push(row);
    }

    if (parentId !== null) {
      keyboard.push([{ text: lang === 'ar' ? 'â¬…ï¸ Ø¹ÙˆØ¯Ø©' : 'â¬…ï¸ Back' }]);
    }

    const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);
    if (isAdmin && parentId === null) {
      keyboard.push([{ text: lang === 'ar' ? 'ðŸ› ï¸ Ù„ÙˆØ­Ø© Ø§Ù„ØªØ­ÙƒÙ… Ù„Ù„Ù…Ø´Ø±ÙÙŠÙ†' : 'ðŸ› ï¸ Admin Panel' }]);
    }

    const replyMarkup = keyboard.length > 0 ? { keyboard, resize_keyboard: true } : { remove_keyboard: true };

    const res = await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: promptText,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    });

    if (!res.ok) {
      this.logError('Failed to send menu', null, { description: res.description, promptText });
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
      { command: 'start', description: 'Ø§Ù„Ø¨Ø¯Ø¡ ÙˆØ§Ø³ØªØ¹Ø±Ø§Ø¶ Ø§Ù„Ù‚Ø§Ø¦Ù…Ø©' },
      { command: 'changelanguage', description: 'ØªØºÙŠÙŠØ± Ù„ØºØ© Ø§Ù„Ø¨ÙˆØª' },
      { command: 'back', description: 'Ø§Ù„Ø¹ÙˆØ¯Ø© Ù„Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø³Ø§Ø¨Ù‚Ø©' },
      { command: 'id', description: 'Ø§Ù„Ø­ØµÙˆÙ„ Ø¹Ù„Ù‰ Ù…Ø¹Ø±Ù ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù…' },
      { command: 'admin', description: 'Ù„ÙˆØ­Ø© Ø§Ù„ØªØ­ÙƒÙ… Ù„Ù„Ù…Ø´Ø±ÙÙŠÙ†' }
    ];
    await this.apiCall('setMyCommands', { commands: en });
    await this.apiCall('setMyCommands', { commands: ar, language_code: 'ar' });
  }

  async apiCall(method, payload, isRetry = false) {
    try {
      const res = await this._rawApiCall(method, payload);
      if (!res.ok) {
        const desc = (res.description || '').toLowerCase();
        const shouldRetry = res.error_code === 400 || res.error_code === 404 || res.error_code === 403 || desc.includes('invalid file') || desc.includes('file reference expired');
        if (shouldRetry && !isRetry) {
          this.logInfo(`Automatic recovery: Retrying ${method} due to ${res.error_code} ${res.description}`);
          return await this.apiCall(method, payload, true);
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

  _rawApiCall(method, payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = https.request({
        hostname: this.apiServer,
        port: 443,
        path: `/bot${this.token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
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
      req.on('error', (err) => {
        console.error(`[TELEGRAM HTTP ERROR] Method: ${method}, Error: ${err.message}`);
        reject(err);
      });
      req.write(data);
      req.end();
    });
  }

  // â”€â”€ Centralized file delivery helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      this.logError('sendTelegramFile failed', e, { telegramFileId, method });
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
      const faculty = await dbHelper.getFacultyById(this.facultyId);
      if (faculty && faculty.admin_chat_id) {
        const adminChatId = faculty.admin_chat_id.split(',')[0].trim();
        await this.apiCall('sendMessage', {
          chat_id: adminChatId,
          text: `âš ï¸ Error: A file could not be delivered.\n\nFile Name: ${fileName || 'Unknown'}\nError: ${errorDesc || 'Unknown error'}\n\nPlease re-upload the file in the admin panel.`
        });
      }
    } catch (adminErr) {
      this.logError('Failed to notify admin about file error', adminErr);
    }
  }

  // Legacy wrapper â€” kept so any remaining call sites still work
  async sendDocumentWithFallback(chatId, fileKey, fileName, caption, replyMarkup, telegramFileId = null, dbUpdateFn = null) {
    return this.sendTelegramFile(chatId, { telegram_file_id: telegramFileId, file_name: fileName, mime_type: null }, caption, replyMarkup);
  }

  // â”€â”€ Paginated file delivery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async sendFilePage(chatId, menuId, page, lang, caption = null) {
    const FILES_PER_PAGE = 10;
    const allFiles = await dbHelper.getMenuFiles(menuId);

    // Legacy fallback: no menu_files rows â†’ try the legacy menus column
    if (!allFiles || allFiles.length === 0) {
      const menu = await dbHelper.getMenuById(menuId);
      if (menu && menu.telegram_file_id) {
        try {
          await this.sendTelegramFile(chatId, { telegram_file_id: menu.telegram_file_id, file_name: menu.file_name, mime_type: menu.mime_type }, caption);
        } catch (e) {
          this.logError('Error sending legacy file', e);
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø®Ø·Ø£ ÙÙŠ Ø§Ù„Ø¥Ø±Ø³Ø§Ù„' : 'Error sending file' });
        }
      } else {
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø¹Ø°Ø±Ø§Ù‹ØŒ Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ù…Ù„Ù Ù…Ø±ÙÙ‚.' : 'Sorry, no file attached.' });
      }
      return;
    }

    const totalFiles = allFiles.length;
    const totalPages = Math.ceil(totalFiles / FILES_PER_PAGE);
    const startIdx = page * FILES_PER_PAGE;
    const endIdx = Math.min(startIdx + FILES_PER_PAGE, totalFiles);
    const pageFiles = allFiles.slice(startIdx, endIdx);

    let hasError = false;
    for (let i = 0; i < pageFiles.length; i++) {
      const file = pageFiles[i];
      const fileCaption = (page === 0 && i === 0) ? caption : null;
      try {
        await this.sendTelegramFile(chatId, file, fileCaption);
      } catch (e) {
        this.logError('Error sending file', e);
        hasError = true;
      }
    }

    if (hasError) {
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø®Ø·Ø£ ÙÙŠ Ø¥Ø±Ø³Ø§Ù„ Ø¨Ø¹Ø¶ Ø§Ù„Ù…Ù„ÙØ§Øª.' : 'Error sending some files.' });
    }

    // Show pagination controls when there are multiple pages
    if (totalPages > 1) {
      const pageLabel = lang === 'ar'
        ? `ðŸ“ ØµÙØ­Ø© ${page + 1} Ù…Ù† ${totalPages} (${totalFiles} Ù…Ù„Ù)`
        : `ðŸ“ Page ${page + 1} of ${totalPages} (${totalFiles} files)`;
      const kb = [];
      const navRow = [];
      if (page > 0) {
        navRow.push({ text: lang === 'ar' ? 'â¬…ï¸ Ø§Ù„Ø³Ø§Ø¨Ù‚' : 'â¬…ï¸ Previous', callback_data: `fp_${menuId}_${page - 1}` });
      }
      if (page < totalPages - 1) {
        navRow.push({ text: lang === 'ar' ? 'Ø§Ù„ØªØ§Ù„ÙŠ âž¡ï¸' : 'Next âž¡ï¸', callback_data: `fp_${menuId}_${page + 1}` });
      }
      if (navRow.length > 0) kb.push(navRow);
      kb.push([{ text: lang === 'ar' ? 'âŒ Ø¥ØºÙ„Ø§Ù‚' : 'âŒ Exit', callback_data: `fe_${menuId}` }]);

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
    const users = await dbHelper.getBotUsersByFaculty(this.facultyId, 'telegram');
    for (const user of users) {
      try {
        await this.withRetry(async () => {
          const title = user.language === 'ar' ? announcement.title_ar : announcement.title_en;
          const content = user.language === 'ar' ? announcement.content_ar : announcement.content_en;
          const txt = `ðŸ“¢ *${title}*\n\n${content}`;
          
          if (announcement.telegram_file_id) {
            const res = await this.sendTelegramFile(
              user.chat_id,
              { telegram_file_id: announcement.telegram_file_id, file_name: announcement.file_name, mime_type: announcement.mime_type || null },
              txt
            );
            if (res && !res.ok) throw new Error(res.description);
          } else {
            const res = await this.apiCall('sendMessage', { chat_id: user.chat_id, text: txt, parse_mode: 'Markdown' });
            if (res && !res.ok) throw new Error(res.description);
          }
        });
      } catch(e) {
        this.logError('Failed to deliver announcement to user after retries', e, { chat_id: user.chat_id });
      }
    }
  }

  async translateArToEn(text) {
    const dict = {
      'Ø¹Ù† Ø§Ù„ÙƒÙ„ÙŠØ©': 'About the Faculty', 'Ø§Ù„ÙƒÙ„ÙŠØ©': 'Faculty', 'Ø§Ù„Ø£Ù‚Ø³Ø§Ù…': 'Departments', 'Ø§Ù„Ù…Ù„ÙØ§Øª': 'Files',
      'Ø§Ù„Ù…Ø³ØªÙ†Ø¯Ø§Øª': 'Documents', 'ØªÙˆØ§ØµÙ„ Ù…Ø¹Ù†Ø§': 'Contact Us', 'Ø¥Ø¹Ù„Ø§Ù†Ø§Øª': 'Announcements', 'Ø´Ø¤ÙˆÙ† Ø§Ù„Ø·Ù„Ø§Ø¨': 'Student Affairs'
    };
    const t = text.trim();
    if (dict[t]) return dict[t];
    return "Translated: " + t.substring(0, 20); 
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

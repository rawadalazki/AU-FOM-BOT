const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const FormData = require('form-data');
const dbHelper = require('./database');
const storage = require('./storage');
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
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  // --- Message Handling ---
  async handleMessage(message) {
    const chatId = message.chat.id.toString();
    const text = message.text || '';

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
        ? (faculty.disabled_message_ar || 'عذراً، البوت متوقف حالياً للصيانة.') 
        : (faculty.disabled_message_en || 'Sorry, the bot is temporarily offline for maintenance.');
      await this.apiCall('sendMessage', { chat_id: chatId, text: disabledMsg });
      return;
    }

    const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);
    const adminState = await dbHelper.getAdminState(chatId);

    if (adminState && isAdmin) {
      await this.handleAdminStateMessage(chatId, message, user.language, adminState);
      return;
    }

    if (text === '/start' || text.startsWith('/start ')) {
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
      await this.sendAdminHome(chatId, user.language);
      return;
    }

    if (text === '/back') {
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
      if (text === '⬅️ Back' || text === '⬅️ عودة') {
        await this.handleBackNavigation(chatId, user);
        return;
      }
      
      if (text === '🛠️ Admin Panel' || text === '🛠️ لوحة التحكم للمشرفين') {
        if (isAdmin) await this.sendAdminHome(chatId, user.language);
        return;
      }

      const unknownMsg = user.language === 'ar' ? 'عذراً، لم أفهم طلبك. الرجاء اختيار من القائمة.' : 'Sorry, I did not understand that. Please select from the menu.';
      await this.apiCall('sendMessage', { chat_id: chatId, text: unknownMsg });
      await this.sendMenu(chatId, currentMenuId, user.language);
    }
  }

  async processMenuClick(chatId, user, clickedMenu, allMenus) {
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
        text: reply || (user.language === 'ar' ? 'لا يوجد محتوى' : 'No content'),
        reply_markup: keyboard
      });
      await this.sendMenu(chatId, clickedMenu.parent_id, user.language);
    } 
    else if (clickedMenu.reply_type === 'file') {
      const caption = user.language === 'ar' ? clickedMenu.reply_content_ar : clickedMenu.reply_content_en;
      
      if (clickedMenu.file_path) {
        try {
          await this.sendDocumentWithFallback(
            chatId, 
            clickedMenu.file_path, 
            clickedMenu.file_name, 
            caption, 
            null, 
            clickedMenu.telegram_file_id,
            (newId) => dbHelper.updateMenuFileId(clickedMenu.id, newId)
          );
        } catch (e) {
          this.logError('Error sending file', e);
          const errText = user.language === 'ar' ? 'عذراً، حدث خطأ أثناء إرسال الملف.' : 'Sorry, error sending file.';
          await this.apiCall('sendMessage', { chat_id: chatId, text: errText });
        }
      } else {
        const noFile = user.language === 'ar' ? 'عذراً، لا يوجد ملف مرفق.' : 'Sorry, no file attached.';
        await this.apiCall('sendMessage', { chat_id: chatId, text: noFile });
      }
      await this.sendMenu(chatId, clickedMenu.parent_id, user.language);
    }
  }

  async handleDirectFileLink(chatId, menuId, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu || menu.faculty_id !== this.facultyId || menu.reply_type !== 'file') {
      const err = lang === 'ar' ? 'الملف غير موجود أو تم حذفه.' : 'File not found or deleted.';
      await this.apiCall('sendMessage', { chat_id: chatId, text: err });
      return;
    }
    const caption = lang === 'ar' ? menu.reply_content_ar : menu.reply_content_en;
    if (menu.file_path) {
      try {
        await this.sendDocumentWithFallback(
          chatId, 
          menu.file_path, 
          menu.file_name, 
          caption, 
          null, 
          menu.telegram_file_id,
          (newId) => dbHelper.updateMenuFileId(menu.id, newId)
        );
      } catch (e) {
        this.logError('Error sending direct file', e);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'خطأ في الإرسال' : 'Error sending file' });
      }
    }
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
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'الرجاء إدخال حرفين على الأقل.' : 'Please enter at least 2 characters.' });
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
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '❌ لم يتم العثور على نتائج.' : '❌ No results found.' });
      return;
    }

    let resultText = lang === 'ar' ? `🔍 نتائج البحث عن "${query}":\n\n` : `🔍 Search results for "${query}":\n\n`;
    const botInfo = await this.getBotInfo();
    const botUsername = botInfo ? botInfo.username : '';
    
    for (const row of rows) {
      const title = lang === 'ar' ? row.title_ar : row.title_en;
      resultText += `📄 ${title}\n🔗 https://t.me/${botUsername}?start=file_${row.id}\n\n`;
    }

    await this.apiCall('sendMessage', { chat_id: chatId, text: resultText, disable_web_page_preview: true });
  }

  async handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id.toString();

    if (data.startsWith('lang_')) {
      const lang = data === 'lang_ar' ? 'ar' : 'en';
      await dbHelper.upsertBotUser(this.facultyId, 'telegram', chatId, callbackQuery.from.username || callbackQuery.from.first_name, lang);
      
      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});

      const faculty = await dbHelper.getFacultyById(this.facultyId);
      const welcome = lang === 'ar' 
        ? (faculty.welcome_ar || 'تم تحديث اللغة بنجاح.')
        : (faculty.welcome_en || 'Language updated successfully.');

      await this.apiCall('sendMessage', { chat_id: chatId, text: welcome });
      
      const user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      await this.sendMenu(chatId, user ? user.current_menu_id : null, lang);
    } 
    else if (data.startsWith('admin_')) {
      const faculty = await dbHelper.getFacultyById(this.facultyId);
      const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);
      if (!isAdmin) return;

      const user = await dbHelper.getBotUser(this.facultyId, 'telegram', chatId);
      const lang = user ? user.language : 'en';
      const parts = data.split('_');
      const action = parts[1];

      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(()=>{});

      if (action === 'menus') {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: null });
        await this.sendAdminReplyMenus(chatId, null, lang);
      } 
      else if (action === 'announcement') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_announcement_title_ar' });
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: lang === 'ar' ? '📢 إرسال إعلان جديد\n\nالرجاء إرسال **عنوان** الإعلان (باللغة العربية):' : '📢 New Announcement\n\nPlease send the **Title** in Arabic:'
        });
      } 
      else if (action === 'stats') {
        const users = await dbHelper.getBotUsersByFaculty(this.facultyId, 'telegram');
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: lang === 'ar' ? `📊 إحصائيات البوت:\n\nإجمالي المشتركين: ${users.length}` : `📊 Bot Stats:\n\nTotal Subscribers: ${users.length}`
        });
        await this.sendAdminHome(chatId, lang);
      } 
      else if (action === 'config') {
        await dbHelper.setAdminState(chatId, { action: 'managing_config' });
        const text = lang === 'ar' 
          ? '⚙️ إعدادات البوت\n\nما الذي ترغب بتعديله؟\n\n/welcome - تعديل رسالة الترحيب\n/disabled - تعديل رسالة الإيقاف للصيانة\n/cancel - العودة'
          : '⚙️ Bot Configuration\n\nWhat would you like to edit?\n\n/welcome - Edit Welcome Message\n/disabled - Edit Offline/Maintenance Message\n/cancel - Go back';
        await this.apiCall('sendMessage', { chat_id: chatId, text });
      } 
      else if (action === 'cancel') {
        await dbHelper.deleteAdminState(chatId);
        await this.sendAdminHome(chatId, lang);
      }
      else if (action === 'menu') {
        const menuId = parseInt(parts[2], 10);
        await this.sendAdminMenuDetails(chatId, menuId, lang);
      }
      else if (action === 'nav') {
        const targetIdStr = parts[2];
        const targetId = targetIdStr === 'null' ? null : parseInt(targetIdStr, 10);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: targetId });
        await this.sendAdminReplyMenus(chatId, targetId, lang);
      }
      else if (action === 'addsubmenu') {
        const parentId = parts[2] === 'null' ? null : parseInt(parts[2], 10);
        await dbHelper.setAdminState(chatId, { action: 'awaiting_submenu_title_ar', parentId });
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: lang === 'ar' ? 'الرجاء إرسال اسم القائمة الفرعية (بالعربي):' : 'Send submenu title (Arabic):'
        });
      }
      else if (action === 'addtext') {
        const parentId = parts[2] === 'null' ? null : parseInt(parts[2], 10);
        await dbHelper.setAdminState(chatId, { action: 'awaiting_text_title_ar', parentId });
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: lang === 'ar' ? 'الرجاء إرسال اسم زر الرد النصي (بالعربي):' : 'Send text button title (Arabic):'
        });
      }
      else if (action === 'addfile') {
        const parentId = parts[2] === 'null' ? null : parseInt(parts[2], 10);
        await dbHelper.setAdminState(chatId, { action: 'awaiting_file_title_ar', parentId });
        await this.apiCall('sendMessage', {
          chat_id: chatId,
          text: lang === 'ar' ? 'الرجاء إرسال اسم زر الملف (بالعربي):' : 'Send file button title (Arabic):'
        });
      }
      else if (action === 'editcontent') {
        const menuId = parseInt(parts[2], 10);
        const menu = await dbHelper.getMenuById(menuId);
        if (menu.reply_type === 'text') {
          await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_text_ar', menuId });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل النص الجديد (بالعربي):' : 'Send new text (Arabic):' });
        } else if (menu.reply_type === 'file') {
          await dbHelper.setAdminState(chatId, { action: 'awaiting_edit_file_doc', menuId });
          const m = lang === 'ar' ? 'أرسل الملف الجديد الآن، أو أرسل /skip لتعديل الشرح فقط:' : 'Send the new file, or /skip to only edit caption:';
          await this.apiCall('sendMessage', { chat_id: chatId, text: m });
        }
      }
      else if (action === 'deletemenu') {
        const menuId = parseInt(parts[2], 10);
        const menu = await dbHelper.getMenuById(menuId);
        if (menu) {
          if (menu.file_path) {
            await storage.deleteFile(menu.file_path);
          }
          const parentId = menu.parent_id;
          await dbHelper.deleteMenu(menuId);
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'تم الحذف بنجاح.' : 'Deleted successfully.' });
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: parentId });
          await this.sendAdminReplyMenus(chatId, parentId, lang);
        }
      }
      else if (action === 'movemenu') {
        const menuId = parseInt(parts[2], 10);
        await this.sendAdminMoveOrder(chatId, menuId, lang);
      }
      else if (action === 'setorder') {
        const menuId = parseInt(parts[2], 10);
        const direction = parts[3]; 
        await this.moveMenuOrder(chatId, menuId, direction, lang);
      }
      else if (action === 'inlinebtns') {
        const menuId = parseInt(parts[2], 10);
        await dbHelper.setAdminState(chatId, { action: 'awaiting_inline_btn', menuId });
        const m = lang === 'ar' 
          ? 'إضافة زر شفاف (رابط)\n\nأرسل اسم الزر والرابط مفصولين بشرطة (-)\nمثال: `موقع الجامعة - https://example.com`\nأو أرسل /clear لمسح الأزرار الحالية.' 
          : 'Add Inline Button (URL)\n\nSend title and URL separated by hyphen (-)\nExample: `Website - https://example.com`\nOr send /clear to remove all.';
        await this.apiCall('sendMessage', { chat_id: chatId, text: m, parse_mode: 'Markdown' });
      }
    }
  }

  // --- Admin State Machine ---
  async handleAdminStateMessage(chatId, message, lang, state) {
    const text = message.text || '';

    if (text === '/cancel') {
      await dbHelper.deleteAdminState(chatId);
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'تم الإلغاء.' : 'Action cancelled.' });
      await this.sendAdminHome(chatId, lang);
      return;
    }

    if (state.action === 'managing_config') {
      if (text === '/welcome') {
        state.action = 'awaiting_welcome_ar';
        await dbHelper.setAdminState(chatId, state);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل رسالة الترحيب الجديدة (بالعربي):' : 'Send new welcome message (Arabic):' });
      } else if (text === '/disabled') {
        state.action = 'awaiting_disabled_msg_ar';
        await dbHelper.setAdminState(chatId, state);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل رسالة الإيقاف للصيانة (بالعربي):' : 'Send maintenance message (Arabic):' });
      }
      return;
    }

    switch (state.action) {
      case 'awaiting_announcement_title_ar':
        state.titleAr = text;
        state.action = 'awaiting_announcement_content_ar';
        await dbHelper.setAdminState(chatId, state);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ممتاز. الآن أرسل محتوى الإعلان التفصيلي (بالعربي):' : 'Great. Now send the detailed content (Arabic):' });
        break;

      case 'awaiting_announcement_content_ar':
        state.contentAr = text;
        const statusAnnMsg = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '🔄 جاري ترجمة الإعلان تلقائياً...' : '🔄 Translating announcement...' });
        
        state.titleEn = await this.translateArToEn(state.titleAr);
        state.contentEn = await this.translateArToEn(state.contentAr);
        state.action = 'awaiting_announcement_file';
        await dbHelper.setAdminState(chatId, state);

        if (statusAnnMsg.result) {
          await this.apiCall('deleteMessage', { chat_id: chatId, message_id: statusAnnMsg.result.message_id }).catch(()=>({}));
        }

        await this.apiCall('sendMessage', { 
          chat_id: chatId, 
          text: lang === 'ar' ? 'تمت الترجمة. إذا كان هناك ملف مرفق للإعلان أرسله الآن، أو أرسل /skip لتخطي إرفاق ملف وبث الإعلان مباشرة.' : 'Translated. Send an attachment file now, or /skip to broadcast without a file.'
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
            await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'الرجاء إرسال ملف صالح أو /skip' : 'Send a valid file or /skip' });
          }
        }
        break;

      case 'awaiting_submenu_title_ar':
        state.titleAr = text;
        const stMsg1 = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '🔄 جاري الترجمة...' : '🔄 Translating...' });
        state.titleEn = await this.translateArToEn(state.titleAr);
        if (stMsg1.result) await this.apiCall('deleteMessage', { chat_id: chatId, message_id: stMsg1.result.message_id }).catch(()=>({}));
        
        await dbHelper.createMenu(this.facultyId, state.parentId, state.titleEn, state.titleAr, 'submenu', null, null, null, null, 0);
        
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.parentId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم إنشاء القائمة الفرعية!' : '✅ Submenu created!' });
        await this.sendAdminReplyMenus(chatId, state.parentId, lang);
        break;

      case 'awaiting_text_title_ar':
        state.titleAr = text;
        state.action = 'awaiting_text_content_ar';
        await dbHelper.setAdminState(chatId, state);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل نص الرد (بالعربي):' : 'Send the reply text (Arabic):' });
        break;

      case 'awaiting_text_content_ar':
        state.contentAr = text;
        const stMsg2 = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '🔄 جاري الترجمة والحفظ...' : '🔄 Translating and saving...' });
        
        state.titleEn = await this.translateArToEn(state.titleAr);
        state.contentEn = await this.translateArToEn(state.contentAr);

        if (stMsg2.result) await this.apiCall('deleteMessage', { chat_id: chatId, message_id: stMsg2.result.message_id }).catch(()=>({}));

        await dbHelper.createMenu(this.facultyId, state.parentId, state.titleEn, state.titleAr, 'text', state.contentEn, state.contentAr, null, null, 0);
        
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.parentId });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم إنشاء زر النص!' : '✅ Text button created!' });
        await this.sendAdminReplyMenus(chatId, state.parentId, lang);
        break;

      case 'awaiting_file_title_ar':
        state.titleAr = text;
        state.action = 'awaiting_file_content_ar';
        await dbHelper.setAdminState(chatId, state);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل الشرح المرفق للملف (بالعربي) أو /skip إذا لم يوجد:' : 'Send file caption (Arabic) or /skip:' });
        break;

      case 'awaiting_file_content_ar':
        state.contentAr = text === '/skip' ? '' : text;
        const stMsg3 = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '🔄 جاري الترجمة...' : '🔄 Translating...' });
        
        state.titleEn = await this.translateArToEn(state.titleAr);
        state.contentEn = state.contentAr ? await this.translateArToEn(state.contentAr) : '';

        state.action = 'awaiting_file_doc';
        await dbHelper.setAdminState(chatId, state);

        if (stMsg3.result) await this.apiCall('deleteMessage', { chat_id: chatId, message_id: stMsg3.result.message_id }).catch(()=>({}));

        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'الآن أرسل الملف المطلوب:' : 'Now send the file:' });
        break;

      case 'awaiting_file_doc':
        const fileDoc = this.extractTelegramAttachment(message);
        if (fileDoc) {
          await this.handleAdminAddFileButton(chatId, state, fileDoc, lang);
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'لم يتم التعرف على الملف. أرسل ملفاً صالحاً.' : 'File not recognized. Send a valid file.' });
        }
        break;

      case 'awaiting_edit_text_ar':
        const menuToEdit = await dbHelper.getMenuById(state.menuId);
        const stMsg4 = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '🔄 جاري الترجمة والحفظ...' : '🔄 Translating and saving...' });
        
        const newContentEn = await this.translateArToEn(text);
        if (stMsg4.result) await this.apiCall('deleteMessage', { chat_id: chatId, message_id: stMsg4.result.message_id }).catch(()=>({}));

        await dbHelper.updateMenu(menuToEdit.id, menuToEdit.parent_id, menuToEdit.title_en, menuToEdit.title_ar, 'text', newContentEn, text, null, null, menuToEdit.sort_order);
        
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuToEdit.parent_id });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم التحديث!' : '✅ Updated!' });
        await this.sendAdminMenuDetails(chatId, menuToEdit.id, lang);
        break;

      case 'awaiting_edit_file_doc':
        const fileAttachment = this.extractTelegramAttachment(message);
        if (text === '/skip') {
          state.action = 'awaiting_edit_file_caption_ar';
          await dbHelper.setAdminState(chatId, state);
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل الشرح الجديد للملف (بالعربي):' : 'Send new file caption (Arabic):' });
        } else if (fileAttachment) {
          await this.handleAdminEditFileButton(chatId, state, fileAttachment, lang);
        } else {
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ملف غير صالح أو /skip' : 'Invalid file or /skip' });
        }
        break;

      case 'awaiting_edit_file_caption_ar':
        const menuToEditCap = await dbHelper.getMenuById(state.menuId);
        const stMsg5 = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '🔄 جاري الترجمة والحفظ...' : '🔄 Translating...' });
        
        const newCapEn = await this.translateArToEn(text);
        if (stMsg5.result) await this.apiCall('deleteMessage', { chat_id: chatId, message_id: stMsg5.result.message_id }).catch(()=>({}));

        await dbHelper.updateMenu(menuToEditCap.id, menuToEditCap.parent_id, menuToEditCap.title_en, menuToEditCap.title_ar, 'file', newCapEn, text, menuToEditCap.file_name, menuToEditCap.file_path, menuToEditCap.sort_order);
        
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuToEditCap.parent_id });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم تحديث الشرح' : '✅ Caption updated' });
        await this.sendAdminMenuDetails(chatId, menuToEditCap.id, lang);
        break;

      case 'awaiting_disabled_msg_ar':
        const fac1 = await dbHelper.getFacultyById(this.facultyId);
        const disEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac1.id, fac1.name_en, fac1.name_ar, fac1.slug, fac1.telegram_token, fac1.admin_chat_id, fac1.welcome_en, fac1.welcome_ar, fac1.bot_enabled, disEn, text, fac1.telegram_api_server);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم التحديث!' : '✅ Updated!' });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_welcome_ar':
        const fac2 = await dbHelper.getFacultyById(this.facultyId);
        const welEn = await this.translateArToEn(text);
        await dbHelper.updateFaculty(fac2.id, fac2.name_en, fac2.name_ar, fac2.slug, fac2.telegram_token, fac2.admin_chat_id, welEn, text, fac2.bot_enabled, fac2.disabled_message_en, fac2.disabled_message_ar, fac2.telegram_api_server);
        await dbHelper.deleteAdminState(chatId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم التحديث!' : '✅ Updated!' });
        await this.sendAdminHome(chatId, lang);
        break;

      case 'awaiting_inline_btn':
        const menuBtn = await dbHelper.getMenuById(state.menuId);
        if (text === '/clear') {
          await dbHelper.updateMenu(menuBtn.id, menuBtn.parent_id, menuBtn.title_en, menuBtn.title_ar, menuBtn.reply_type, menuBtn.reply_content_en, menuBtn.reply_content_ar, menuBtn.file_name, menuBtn.file_path, menuBtn.sort_order, null);
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuBtn.parent_id });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ مسح الأزرار' : '✅ Cleared' });
          await this.sendAdminMenuDetails(chatId, menuBtn.id, lang);
          break;
        }

        const parts = text.split('-');
        if (parts.length < 2) return;
        
        const titleAr = parts[0].trim();
        let urlVal = parts[1].trim();
        if (urlVal.startsWith('@')) urlVal = 'https://t.me/' + urlVal.slice(1);
        if (!urlVal.startsWith('http')) urlVal = 'https://' + urlVal;

        const titleEn = await this.translateArToEn(titleAr);
        const currentBtns = menuBtn.inline_buttons ? JSON.parse(menuBtn.inline_buttons) : [];
        currentBtns.push({ text_ar: titleAr, text_en: titleEn, url: urlVal });
        
        await dbHelper.updateMenu(menuBtn.id, menuBtn.parent_id, menuBtn.title_en, menuBtn.title_ar, menuBtn.reply_type, menuBtn.reply_content_en, menuBtn.reply_content_ar, menuBtn.file_name, menuBtn.file_path, menuBtn.sort_order, JSON.stringify(currentBtns));
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menuBtn.parent_id });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ أضيف' : '✅ Added' });
        await this.sendAdminMenuDetails(chatId, menuBtn.id, lang);
        break;
    }
  }

  // --- S3 File Uploads (STREAMING) ---
  async downloadAndUploadStreamToS3(telegramFilePath, fileName) {
    return new Promise((resolve, reject) => {
      const url = `https://${this.apiServer}/file/bot${this.token}/${telegramFilePath}`;
      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          return reject(new Error(`Telegram server returned ${response.statusCode}`));
        }
        
        storage.uploadStream(response, fileName)
          .then(resolve)
          .catch(reject);
      }).on('error', reject);
    });
  }

  async handleAdminAnnouncementBroadcast(chatId, state, doc, lang) {
    let fileName = null;
    let s3Key = null;

    const stMsg = await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '📢 جاري البث...' : '📢 Broadcasting...' });
    
    try {
      if (doc) {
        fileName = doc.file_name || 'attachment';
        const fileInfo = await this.apiCall('getFile', { file_id: doc.file_id });
        if (fileInfo.ok) {
          const uploadRes = await this.downloadAndUploadStreamToS3(fileInfo.result.file_path, fileName);
          s3Key = uploadRes.key;
        }
      }

      const annId = await dbHelper.createAnnouncement(this.facultyId, state.titleEn, state.titleAr, state.contentEn, state.contentAr, fileName, s3Key);
      
      const announcement = {
        id: annId,
        faculty_id: this.facultyId,
        title_en: state.titleEn,
        title_ar: state.titleAr,
        content_en: state.contentEn,
        content_ar: state.contentAr,
        file_name: fileName,
        file_path: s3Key
      };

      await this.sendAnnouncement(announcement);

      await dbHelper.deleteAdminState(chatId);
      if (stMsg.result) await this.apiCall('deleteMessage', { chat_id: chatId, message_id: stMsg.result.message_id }).catch(()=>({}));
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم البث!' : '✅ Broadcasted!' });
      await this.sendAdminHome(chatId, lang);
    } catch(e) {
      this.logError('Broadcast failed', e);
      await this.apiCall('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
      await dbHelper.deleteAdminState(chatId);
    }
  }

  async handleAdminAddFileButton(chatId, state, doc, lang) {
    try {
      const fileName = doc.file_name || 'document';
      const fileInfo = await this.apiCall('getFile', { file_id: doc.file_id });
      if (!fileInfo.ok) throw new Error('getFile failed');
      
      const uploadRes = await this.downloadAndUploadStreamToS3(fileInfo.result.file_path, fileName);

      await dbHelper.createMenu(this.facultyId, state.parentId, state.titleEn, state.titleAr, 'file', state.contentEn, state.contentAr, fileName, uploadRes.key, 0);

      await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.parentId });
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم إضافة زر الملف بنجاح!' : '✅ File button added!' });
      await this.sendAdminReplyMenus(chatId, state.parentId, lang);
    } catch(e) {
      this.logError('Add file failed', e);
      await this.apiCall('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
      await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.parentId });
      await this.sendAdminReplyMenus(chatId, state.parentId, lang);
    }
  }

  async handleAdminEditFileButton(chatId, state, doc, lang) {
    const menu = await dbHelper.getMenuById(state.menuId);
    try {
      const fileName = doc.file_name || 'document';
      const fileInfo = await this.apiCall('getFile', { file_id: doc.file_id });
      if (!fileInfo.ok) throw new Error('getFile failed');
      
      const uploadRes = await this.downloadAndUploadStreamToS3(fileInfo.result.file_path, fileName);

      if (menu.file_path) {
        await storage.deleteFile(menu.file_path);
      }

      await dbHelper.updateMenu(menu.id, menu.parent_id, menu.title_en, menu.title_ar, 'file', state.contentEn, state.contentAr, fileName, uploadRes.key, menu.sort_order);

      await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id });
      await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم التحديث' : '✅ Updated' });
      await this.sendAdminMenuDetails(chatId, menu.id, lang);
    } catch(e) {
      this.logError('Edit file failed', e);
      await this.apiCall('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
    }
  }

  async sendAdminHome(chatId, lang) {
    const keyboard = {
      inline_keyboard: [
        [{ text: lang === 'ar' ? '📂 إدارة القوائم والملفات' : '📂 Manage Menus & Files', callback_data: 'admin_menus' }],
        [{ text: lang === 'ar' ? '📢 إرسال إعلان للطلاب' : '📢 Broadcast Announcement', callback_data: 'admin_announcement' }],
        [{ text: lang === 'ar' ? '📊 إحصائيات البوت' : '📊 Bot Statistics', callback_data: 'admin_stats' }],
        [{ text: lang === 'ar' ? '⚙️ إعدادات البوت الأساسية' : '⚙️ Core Settings', callback_data: 'admin_config' }],
        [{ text: lang === 'ar' ? '❌ إغلاق' : '❌ Close', callback_data: 'admin_cancel' }]
      ]
    };
    await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '🛠️ لوحة تحكم المشرفين:' : '🛠️ Admin Panel:', reply_markup: keyboard });
  }

  async sendAdminReplyMenus(chatId, parentId, lang) {
    const menus = await dbHelper.getMenusByFaculty(this.facultyId);
    const siblings = menus.filter(m => m.parent_id === parentId).sort((a,b) => a.sort_order - b.sort_order);
    let txt = lang === 'ar' ? '📂 القوائم الحالية:' : '📂 Current Menus:';
    if (parentId !== null) {
      const pMenu = menus.find(m => m.id === parentId);
      txt = lang === 'ar' ? `📂 داخل: ${pMenu.title_ar}` : `📂 Inside: ${pMenu.title_en}`;
    }

    const kb = [];
    for (const m of siblings) {
      let icon = m.reply_type === 'submenu' ? '📁' : (m.reply_type === 'file' ? '📄' : '💬');
      kb.push([{ text: `${icon} ${lang === 'ar' ? m.title_ar : m.title_en}`, callback_data: `admin_menu_${m.id}` }]);
    }
    
    kb.push([{ text: lang === 'ar' ? '➕ قائمة فرعية' : '➕ Submenu', callback_data: `admin_addsubmenu_${parentId}` }]);
    kb.push([{ text: lang === 'ar' ? '➕ زر نصي' : '➕ Text Button', callback_data: `admin_addtext_${parentId}` }]);
    kb.push([{ text: lang === 'ar' ? '➕ زر ملف' : '➕ File Button', callback_data: `admin_addfile_${parentId}` }]);

    if (parentId !== null) {
      const pMenu = menus.find(m => m.id === parentId);
      kb.push([{ text: lang === 'ar' ? '⬅️ عودة للأعلى' : '⬅️ Back up', callback_data: `admin_nav_${pMenu.parent_id}` }]);
    } else {
      kb.push([{ text: lang === 'ar' ? '⬅️ للقائمة الرئيسية للمشرف' : '⬅️ Admin Home', callback_data: 'admin_cancel' }]);
    }

    await this.apiCall('sendMessage', { chat_id: chatId, text: txt, reply_markup: { inline_keyboard: kb } });
  }

  async sendAdminMenuDetails(chatId, menuId, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    let txt = `*${lang === 'ar' ? menu.title_ar : menu.title_en}*\n\n`;
    txt += `Type: ${menu.reply_type}\n`;
    if (menu.reply_type !== 'submenu') {
      txt += `Content: ${lang === 'ar' ? menu.reply_content_ar : menu.reply_content_en}\n`;
    }
    if (menu.reply_type === 'file') {
      txt += `File: ${menu.file_name}\n`;
    }

    const kb = [];
    if (menu.reply_type === 'submenu') {
      kb.push([{ text: lang === 'ar' ? '📂 الدخول للقائمة' : '📂 Enter Submenu', callback_data: `admin_nav_${menu.id}` }]);
    }
    if (menu.reply_type !== 'submenu') {
      kb.push([{ text: lang === 'ar' ? '📝 تعديل المحتوى' : '📝 Edit Content', callback_data: `admin_editcontent_${menu.id}` }]);
    }
    if (menu.reply_type === 'text') {
      kb.push([{ text: lang === 'ar' ? '🔗 إدارة الأزرار الشفافة' : '🔗 Manage Inline Buttons', callback_data: `admin_inlinebtns_${menu.id}` }]);
    }
    kb.push([{ text: lang === 'ar' ? '↕️ ترتيب الزر' : '↕️ Reorder', callback_data: `admin_movemenu_${menu.id}` }]);
    kb.push([{ text: lang === 'ar' ? '🗑️ حذف' : '🗑️ Delete', callback_data: `admin_deletemenu_${menu.id}` }]);
    kb.push([{ text: lang === 'ar' ? '⬅️ عودة' : '⬅️ Back', callback_data: `admin_nav_${menu.parent_id}` }]);

    await this.apiCall('sendMessage', { chat_id: chatId, text: txt, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
  }

  async sendAdminMoveOrder(chatId, menuId, lang) {
    const kb = [
      [
        { text: '⬆️ Up', callback_data: `admin_setorder_${menuId}_up` },
        { text: '⬇️ Down', callback_data: `admin_setorder_${menuId}_down` }
      ],
      [{ text: lang === 'ar' ? '⬅️ عودة' : '⬅️ Back', callback_data: `admin_menu_${menuId}` }]
    ];
    await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'اختر الاتجاه:' : 'Choose direction:', reply_markup: { inline_keyboard: kb } });
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
    await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id });
    await this.sendAdminReplyMenus(chatId, menu.parent_id, lang);
  }

  async sendLanguageSelection(chatId) {
    await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: "Please select your language / الرجاء اختيار اللغة:",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🇺🇸 English", callback_data: "lang_en" }, { text: "🇸🇦 العربية", callback_data: "lang_ar" }]
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
      promptText = lang === 'ar' ? (faculty.welcome_ar || 'مرحباً بك') : (faculty.welcome_en || 'Welcome');
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
      keyboard.push([{ text: lang === 'ar' ? '⬅️ عودة' : '⬅️ Back' }]);
    }

    const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);
    if (isAdmin && parentId === null) {
      keyboard.push([{ text: lang === 'ar' ? '🛠️ لوحة التحكم للمشرفين' : '🛠️ Admin Panel' }]);
    }

    await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: promptText,
      reply_markup: { keyboard, resize_keyboard: true }
    });
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
      { command: 'start', description: 'البدء واستعراض القائمة' },
      { command: 'changelanguage', description: 'تغيير لغة البوت' },
      { command: 'back', description: 'العودة للقائمة السابقة' },
      { command: 'id', description: 'الحصول على معرف تيليجرام' },
      { command: 'admin', description: 'لوحة التحكم للمشرفين' }
    ];
    await this.apiCall('setMyCommands', { commands: en });
    await this.apiCall('setMyCommands', { commands: ar, language_code: 'ar' });
  }

  apiCall(method, payload) {
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
          try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async sendDocumentWithFallback(chatId, fileKey, fileName, caption, replyMarkup, telegramFileId = null, dbUpdateFn = null) {
    // 1. Try to send using cached Telegram file_id
    if (telegramFileId) {
      try {
        const payload = { chat_id: chatId, document: telegramFileId };
        if (caption) payload.caption = caption;
        if (replyMarkup) payload.reply_markup = replyMarkup;
        const res = await this.apiCall('sendDocument', payload);
        if (res.ok) return res;
        this.logInfo('Cached telegram_file_id rejected, falling back to S3 stream', { telegramFileId });
      } catch(e) {
        this.logInfo('Cached telegram_file_id error, falling back to S3 stream', { err: e.message });
      }
    }

    // 2. Fallback: Stream from S3
    return new Promise(async (resolve, reject) => {
      try {
        const s3Object = await storage.getFileStream(fileKey);
        
        const form = new FormData();
        form.append('chat_id', chatId);
        if (caption) form.append('caption', caption);
        if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
        
        form.append('document', s3Object.Body, {
          filename: fileName,
          contentType: 'application/octet-stream'
        });

        const req = https.request({
          hostname: this.apiServer,
          port: 443,
          path: `/bot${this.token}/sendDocument`,
          method: 'POST',
          headers: form.getHeaders()
        }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', async () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.ok && dbUpdateFn) {
                const doc = this.extractTelegramAttachment(parsed.result);
                if (doc && doc.file_id) {
                   await dbUpdateFn(doc.file_id).catch(err => this.logError('Failed to save new telegram_file_id', err));
                }
              }
              resolve(parsed);
            } catch(err) { resolve(body); }
          });
        });
        
        req.on('error', reject);
        form.pipe(req);
      } catch(e) {
        reject(e);
      }
    });
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
          const txt = `📢 *${title}*\n\n${content}`;
          
          if (announcement.file_path) {
            const res = await this.sendDocumentWithFallback(
              user.chat_id, 
              announcement.file_path, 
              announcement.file_name, 
              txt,
              null,
              announcement.telegram_file_id,
              (newId) => {
                 announcement.telegram_file_id = newId; // update in memory for next users
                 return dbHelper.updateAnnouncementFileId(announcement.id, newId);
              }
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
      'عن الكلية': 'About the Faculty', 'الكلية': 'Faculty', 'الأقسام': 'Departments', 'الملفات': 'Files',
      'المستندات': 'Documents', 'تواصل معنا': 'Contact Us', 'إعلانات': 'Announcements', 'شؤون الطلاب': 'Student Affairs'
    };
    const t = text.trim();
    if (dict[t]) return dict[t];
    return "Translated: " + t.substring(0, 20); 
  }

  extractTelegramAttachment(message) {
    if (message.document) return message.document;
    if (message.photo && message.photo.length > 0) return { file_id: message.photo[message.photo.length - 1].file_id, file_name: `photo.jpg` };
    if (message.audio) return { file_id: message.audio.file_id, file_name: message.audio.file_name || `audio.mp3` };
    if (message.voice) return { file_id: message.voice.file_id, file_name: `voice.ogg` };
    if (message.video) return { file_id: message.video.file_id, file_name: message.video.file_name || `video.mp4` };
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

  getWebhookSecret
};

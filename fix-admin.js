const fs = require('fs');

let content = fs.readFileSync('bot-manager.js', 'utf8');

// Fix 1: getAdminActionFromText to support BTN_CANCEL_OP
content = content.replace(
    /if \(match\('BTN_CANCEL'\) \|\| trimmedText === '\/cancel'\) return 'cancel';/,
    "if (match('BTN_CANCEL') || match('BTN_CANCEL_OP') || trimmedText === '/cancel' || trimmedText === '⭐ إلغاء العملية' || trimmedText === '❌ إلغاء العملية') return 'cancel';"
);

// Fix 2: Back handler to support awaiting_del_sub_confirm
const backHandlerSearch = `    if (actionId === 'back') {
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
      }`;

const backHandlerReplace = `    if (actionId === 'back') {
      if (state.action === 'awaiting_new_admin_id' || state.action === 'awaiting_remove_admin_id' || state.action === 'awaiting_del_sub_confirm') {
        let isDeputy = false;
        if (state.action === 'awaiting_del_sub_confirm' && state.subId) {
            const delRole = await dbHelper.getAdminRole(this.facultyId, state.subId);
            isDeputy = (delRole === 'DEPUTY_ADMIN');
        } else {
            const targetRole = state.targetRole || 'SUB_ADMIN';
            isDeputy = (targetRole === 'DEPUTY_ADMIN');
        }
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
      }`;
      
content = content.replace(backHandlerSearch, backHandlerReplace);

// Fix 3: awaiting_announcement_pin fallback and cancel text
const pinSearch = `      case 'awaiting_announcement_pin': {
        if (text === t(lang, 'MSG_ADMIN_2') || text === '? ????? ???????') {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_30') });
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.sendAdminHome(chatId, lang);
          return;
        }
        state.isPinned = text === t(lang, 'MSG_ADMIN_38');
        await this.handleAdminAnnouncementBroadcast(chatId, state, lang);
        break;
      }`;
      
const pinReplace = `      case 'awaiting_announcement_pin': {
        if (text === t(lang, 'MSG_ADMIN_2') || text === '⭐ إلغاء العملية' || text === '❌ إلغاء العملية' || actionId === 'cancel') {
          await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_30') });
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.sendAdminHome(chatId, lang);
          return;
        }
        state.isPinned = (text === t(lang, 'MSG_ADMIN_38') || text === 'نعم (تثبيت)');
        await this.handleAdminAnnouncementBroadcast(chatId, state, lang);
        break;
      }`;
      
content = content.replace(pinSearch, pinReplace);

fs.writeFileSync('bot-manager.js', content, 'utf8');
console.log("Fixes applied successfully.");

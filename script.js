const fs = require('fs');
let code = fs.readFileSync('bot-manager.js', 'utf8');

// Replace /admin entry
code = code.replace(
  /if \(\(text === '\/admin'.+?\{[\s\S]+?await dbHelper.setAdminState.+?'managing_menus'[\s\S]+?sendAdminReplyMenus[\s\S]+?return;\s*\}/,
  \if ((text === '/admin' || text === '🛠️ Admin Panel' || text === '🛠️ لوحة تحكم المشرفين') && isAdmin) {
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.sendAdminHome(chatId, user.language);
      return;
    }\
);

// Replace /cancel trap in awaiting_replace_file_doc
code = code.replace(
  /if \(text === '\/cancel'\) \{\s*const mCancel = await dbHelper\.getMenuById\(state\.menuId\);\s*await dbHelper\.setAdminState\(chatId, \{ action: 'managing_menus', currentMenuId: mCancel\.parent_id, viewingMenuDetailsId: state\.menuId \}\);\s*await this\.sendAdminMenuDetails\(chatId, state\.menuId, lang\);\s*return;\s*\}/,
  \if (text === '/cancel') {
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'تم إلغاء الأمر. عدنا للرئيسية.' : 'Action cancelled. Returned to home.' });
          await this.sendAdminHome(chatId, lang);
          return;
        }\
);

// Other edit/add completions that go back to managing_menus -> we should redirect to admin_home
// E.g. "await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id, viewingMenuDetailsId: null });\nawait this.sendAdminReplyMenus(chatId, menu.parent_id, lang);"
// This is tedious to regex safely.

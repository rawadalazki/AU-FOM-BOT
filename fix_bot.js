const fs = require('fs');
let content = fs.readFileSync('bot-manager.js', 'utf8');

// 1. Fix handleCallbackQuery previewfiles
content = content.replace(
  /} else if \(action === 'delsinglefile'\) \{\s+const fileId = parseInt\(data\.split\('_'\)\[3\], 10\);\s+await dbHelper\.deleteMenuFile\(fileId\);\s+await this\.apiCall\('sendMessage', \{ chat_id: chatId, text: lang === 'ar' \? '✅ تم حذف الملف' : '✅ File Deleted' \}\);\s+await this\.sendFilePage\(chatId, menuId, 0, lang\);\s+\} else if \(action === 'previewfiles'\) \{\s+await this\.sendFilePage\(chatId, menuId, 0, lang\);\s+\} else if \(action === 'addfile'\) \{/g,
  } else if (action === 'delsinglefile') {
        const fileId = parseInt(data.split('_')[3], 10);
        await dbHelper.deleteMenuFile(fileId);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم حذف الملف' : '✅ File Deleted' });
        await this.sendFilePage(chatId, menuId, 0, lang, null, true);
      } else if (action === 'previewfiles') {
        await this.sendFilePage(chatId, menuId, 0, lang, null, true);
      } else if (action === 'addfile') {
);

// 2. Fix sendAdminReplyMenus layout
content = content.replace(
  /const rowsMap = new Map\(\)[\s\S]*?kb\.push\(\[\{ text: lang === 'ar' \? '🏠 الرئيسية' : '🏠 Home' \}\]\);/g,
  const kb = [];
    let currentRow = [];
    for (const s of siblings) {
      const icon = s.reply_type === 'submenu' ? '📁' : (s.reply_type === 'file' ? '📄' : '📝');
      const title = lang === 'ar' ? s.title_ar : s.title_en;
      currentRow.push({ text: \\ \\ });
      if (currentRow.length === 3) {
        kb.push(currentRow);
        currentRow = [];
      }
    }
    currentRow.push({ text: '➕' });
    kb.push(currentRow);

    if (parentId !== null) {
      kb.push([{ text: lang === 'ar' ? '⬆️ المستوى السابق' : '⬆️ Parent Menu' }]);
    }
    kb.push([{ text: lang === 'ar' ? '🏠 الرئيسية' : '🏠 Home' }]);
);

// 3. Fix sendFilePage signature
content = content.replace(
  /async sendFilePage\(chatId, menuId, page, lang, caption = null\) \{/g,
  sync sendFilePage(chatId, menuId, page, lang, caption = null, isAdminPreview = false) {
);

// 4. Fix sendFilePage replyMarkup
content = content.replace(
  /const fileCaption = \(page === 0 && i === 0\) \? caption : null;\s+try \{\s+await this\.sendTelegramFile\(chatId, file, fileCaption\);\s+\} catch \(e\) \{/g,
  const fileCaption = (page === 0 && i === 0) ? caption : null;
      let replyMarkup = null;
      if (isAdminPreview) {
        replyMarkup = {
          inline_keyboard: [[
             { text: lang === 'ar' ? '🗑️ حذف هذا الملف' : '🗑️ Delete this file', callback_data: \dmin_delsinglefile_\_\\ }
          ]]
        };
      }
      try {
        await this.sendTelegramFile(chatId, file, fileCaption, replyMarkup);
      } catch (e) {
);

fs.writeFileSync('bot-manager.js', content, 'utf8');
console.log('Fixed successfully');

$bytes = [System.IO.File]::ReadAllBytes('bot-manager.js')
$content = [System.Text.Encoding]::UTF8.GetString($bytes)

# --- Fix Cancel returning to home ---
$cancelTarget = "    if (actionId === 'cancel') {
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ACTION_CANCELLED') });
      await this.sendAdminHome(chatId, lang);
      return;
    }"
$cancelReplacement = "    if (actionId === 'cancel') {
      await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ACTION_CANCELLED') });
      if (state.menuId) {
        const menu = await dbHelper.getMenuById(state.menuId);
        if (menu) {
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id, viewingMenuDetailsId: menu.id });
          await this.sendAdminMenuDetails(chatId, menu.id, lang);
          return;
        }
      } else if (state.currentMenuId || state.viewingMenuDetailsId) {
         await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: state.viewingMenuDetailsId });
         if (state.viewingMenuDetailsId) {
            await this.sendAdminMenuDetails(chatId, state.viewingMenuDetailsId, lang);
         } else {
            const adminNavRep = require('./admin-menu-navigation');
            await adminNavRep.sendAdminReplyMenus(this, chatId, state.currentMenuId, lang);
         }
         return;
      }
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.sendAdminHome(chatId, lang);
      return;
    }"
$content = $content.Replace($cancelTarget, $cancelReplacement)

# --- Fix Replace File ---
$replaceTarget = "        const docReplace = this.extractTelegramAttachment(message);
        if (docReplace) {
          try {
            await dbHelper.runQuery('DELETE FROM menu_files WHERE menu_id = $1', [state.menuId]);
            await dbHelper.addMenuFile(state.menuId, docReplace.file_id, docReplace.file_name, docReplace.mime_type, docReplace.file_size);"
$replaceReplacement = "        let docReplace = this.extractTelegramAttachment(message);
        if (!docReplace && text && !text.startsWith('/')) {
           const trimmedText = text.trim();
           const isLink = /^https?:\/\//i.test(trimmedText);
           const type = isLink ? 'text/link' : 'text/plain';
           const fName = isLink ? '🔗 الرابط' : (trimmedText.length > 20 ? trimmedText.substring(0, 20) + '...' : trimmedText);
           docReplace = { file_id: trimmedText, file_name: fName, mime_type: type, file_size: Buffer.byteLength(trimmedText, 'utf8') };
        }
        if (docReplace) {
          try {
            await dbHelper.runQuery('DELETE FROM menu_files WHERE menu_id = $1', [state.menuId]);
            await dbHelper.addMenuFile(state.menuId, docReplace.file_id, docReplace.file_name, docReplace.mime_type, docReplace.file_size);"
$content = $content.Replace($replaceTarget, $replaceReplacement)

# --- Fix Add File ---
$addFileTarget = "        } else {
          const doc2 = this.extractTelegramAttachment(message);
          if (doc2) {
            try {
              await dbHelper.addMenuFile(state.menuId, doc2.file_id, doc2.file_name, doc2.mime_type, doc2.file_size);"
$addFileReplacement = "        } else {
          let doc2 = this.extractTelegramAttachment(message);
          if (!doc2 && text && !text.startsWith('/')) {
             const trimmedText = text.trim();
             const isLink = /^https?:\/\//i.test(trimmedText);
             const type = isLink ? 'text/link' : 'text/plain';
             const fName = isLink ? '🔗 الرابط' : (trimmedText.length > 20 ? trimmedText.substring(0, 20) + '...' : trimmedText);
             doc2 = { file_id: trimmedText, file_name: fName, mime_type: type, file_size: Buffer.byteLength(trimmedText, 'utf8') };
          }
          if (doc2) {
            try {
              await dbHelper.addMenuFile(state.menuId, doc2.file_id, doc2.file_name, doc2.mime_type, doc2.file_size);"
$content = $content.Replace($addFileTarget, $addFileReplacement)

# --- Fix sendTelegramFile ---
$sendTelegramFileTarget = "  async sendTelegramFile(chatId, file, caption = null, replyMarkup = null) {
    const telegramFileId = file.telegram_file_id;
    if (!telegramFileId) throw new Error('No telegram_file_id available for this file');

    const method = this._getTelegramMethodForMime(file.mime_type);"
$sendTelegramFileReplacement = "  async sendTelegramFile(chatId, file, caption = null, replyMarkup = null) {
    const telegramFileId = file.telegram_file_id;
    if (!telegramFileId) throw new Error('No telegram_file_id available for this file');

    if (file.mime_type === 'text/plain' || file.mime_type === 'text/link') {
       let finalTxt = telegramFileId;
       if (caption) finalTxt += '\n\n' + caption;
       
       const payload = { 
           chat_id: chatId, 
           text: finalTxt, 
           parse_mode: 'HTML',
           disable_web_page_preview: file.mime_type === 'text/plain'
       };
       if (replyMarkup) payload.reply_markup = replyMarkup;
       
       this.updateUserContext(chatId, {
           currentOperation: \"Sending Text/Link\",
           fileId: telegramFileId.substring(0, 50),
           mimeType: file.mime_type
       });

       try {
         const res = await this.apiCall('sendMessage', payload);
         if (res.ok) return res;
         throw new Error(`Text delivery failed: ${res.description}`);
       } catch (e) {
         this.logError('sendTelegramFile text/link failed', e, { chat_id: chatId });
         throw e;
       }
    }

    const method = this._getTelegramMethodForMime(file.mime_type);"
$content = $content.Replace($sendTelegramFileTarget, $sendTelegramFileReplacement)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText('bot-manager.js', $content, $utf8NoBom)
Write-Host "Replacements completed!"

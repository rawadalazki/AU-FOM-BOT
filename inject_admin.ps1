$code = [System.IO.File]::ReadAllText("bot-manager.js", [System.Text.Encoding]::UTF8)

$adminHandlers = @"
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
          ? '🔗 إضافة زر شفاف (رابط)\n\nأرسل اسم الزر والرابط مفصولين بشرطة (-)\nمثال: `موقع الجامعة - https://example.com`\nأو أرسل /clear لمسح الأزرار الحالية.' 
          : '🔗 Add Inline Button (URL)\n\nSend title and URL separated by hyphen (-)\nExample: `Website - https://example.com`\nOr send /clear to remove all.';
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
"@

$code = $code -replace "(?s)    else if \(data\.startsWith\('fe_'\)\) \{.*?\r?\n    \}" , "`$0`r`n$adminHandlers"

[System.IO.File]::WriteAllText("bot-manager.js", $code, [System.Text.Encoding]::UTF8)

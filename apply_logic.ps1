$code = [System.IO.File]::ReadAllText("bot-manager.js", [System.Text.Encoding]::UTF8)

# 1. sendAdminMenuDetails
$newSendAdmin = @"
  async sendAdminMenuDetails(chatId, menuId, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu) return;

    const typeStr = menu.reply_type === 'submenu' ? (lang === 'ar' ? '📁 مجلد (قائمة)' : 'Folder') :
                    menu.reply_type === 'file' ? (lang === 'ar' ? '📑 ملف' : 'Files') :
                    (lang === 'ar' ? '📝 نص' : 'Text');

    let txt = lang === 'ar' 
      ? `"<b>📋 تفاصيل الزر:</b>\n\n<b>الاسم:</b> ${menu.title_ar}\n<b>النوع:</b> ${typeStr}"`
      : `"<b>📋 Button Details:</b>\n\n<b>Name:</b> ${menu.title_en}\n<b>Type:</b> ${typeStr}"`;

    const kb = [];
    
    // Core actions for all types
    kb.push([
      { text: lang === 'ar' ? '✏️ إعادة التسمية' : '✏️ Rename', callback_data: `"admin_rename_${menuId}"` },
      { text: lang === 'ar' ? '🗑️ حذف الزر' : '🗑️ Delete Button', callback_data: `"admin_delbtn_${menuId}"` }
    ]);

    // Type specific actions
    if (menu.reply_type === 'submenu') {
      kb.push([{ text: lang === 'ar' ? '📂 فتح المجلد' : '📂 Open Folder', callback_data: `"admin_open_${menuId}"` }]);
    } else if (menu.reply_type === 'file') {
      kb.push([{ text: lang === 'ar' ? '🗑️ حذف المحتوى' : '🗑️ Delete Content', callback_data: `"admin_delcontent_${menuId}"` }]);
      kb.push([
        { text: lang === 'ar' ? '👁️ معاينة الملفات' : '👁️ Preview Files', callback_data: `"admin_previewfiles_${menuId}"` },
        { text: lang === 'ar' ? '➕ إضافة ملف' : '➕ Add File', callback_data: `"admin_addfile_${menuId}"` }
      ]);
    } else if (menu.reply_type === 'text') {
      kb.push([{ text: lang === 'ar' ? '🗑️ حذف المحتوى' : '🗑️ Delete Content', callback_data: `"admin_delcontent_${menuId}"` }]);
      kb.push([{ text: lang === 'ar' ? '📝 تعديل النص' : '📝 Edit Text', callback_data: `"admin_edittext_${menuId}"` }]);
    }

    // Advanced options (Inline buttons, Move, Order)
    kb.push([
      { text: lang === 'ar' ? '🔗 أزرار شفافة' : '🔗 Inline Buttons', callback_data: `"admin_inline_${menuId}"` },
      { text: lang === 'ar' ? '🔄 نقل' : '🔄 Move', callback_data: `"admin_move_${menuId}"` }
    ]);

    kb.push([{ text: lang === 'ar' ? '↕️ تغيير الترتيب' : '↕️ Change Order', callback_data: `"admin_order_${menuId}"` }]);

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
      { text: toggleActiveStr, callback_data: `"admin_toggleactive_${menuId}"` },
      { text: toggleHiddenStr, callback_data: `"admin_togglehidden_${menuId}"` }
    ]);

    await this.apiCall('sendMessage', { 
      chat_id: chatId, 
      text: txt, 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: kb } 
    });
  }

  async sendAdminMoveOrder
"@

$code = $code -replace '(?s)  async sendAdminMenuDetails\(chatId, menuId, lang\).*?  async sendAdminMoveOrder', $newSendAdmin

[System.IO.File]::WriteAllText("bot-manager.js", $code, [System.Text.Encoding]::UTF8)

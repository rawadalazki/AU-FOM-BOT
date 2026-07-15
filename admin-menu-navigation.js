const dbHelper = require('./database');

class AdminMenuNavigation {
  
  static async sendAdminReplyMenus(botCtx, chatId, parentId, lang) {
    const menus = await dbHelper.getMenusByFaculty(botCtx.facultyId);
    const siblings = menus.filter(m => m.parent_id === parentId);
    let txt = lang === 'ar' ? '📂 القوائم الحالية:' : '📂 Current Menus:';
    if (parentId !== null) {
      const pMenu = menus.find(m => m.id === parentId);
      txt = lang === 'ar' ? `📂 داخل: ${pMenu.title_ar}` : `📂 Inside: ${pMenu.title_en}`;
    }

    const rowsMap = new Map();
    siblings.forEach(item => {
      const ri = item.row_index || 0;
      if (!rowsMap.has(ri)) rowsMap.set(ri, []);
      rowsMap.get(ri).push(item);
    });

    const sortedRows = Array.from(rowsMap.keys()).sort((a,b) => a - b);
    const kb = [];

    sortedRows.forEach(ri => {
      const rowItems = rowsMap.get(ri).sort((a,b) => a.sort_order - b.sort_order);
      const maxButtonsPerRow = 3;
      
      const chunk = rowItems.slice(0, maxButtonsPerRow);
      const rowKb = chunk.map(s => {
        const icon = s.reply_type === 'submenu' ? '📁' : (s.reply_type === 'file' ? '📄' : '📝');
        const title = lang === 'ar' ? s.title_ar : s.title_en;
        return { text: `${icon} ${title}` };
      });

      if (rowKb.length < maxButtonsPerRow) {
        rowKb.push({ text: lang === 'ar' ? `➕ بجانبهم (r${ri})` : `➕ Add Here (r${ri})` });
      }
      kb.push(rowKb);
    });

    kb.push([{ text: lang === 'ar' ? '➕ سطر جديد' : '➕ New Row' }]);

    if (parentId !== null) {
      kb.push([{ text: lang === 'ar' ? '⬆️ المستوى السابق' : '⬆️ Parent Menu' }]);
    }
    kb.push([{ text: lang === 'ar' ? '🏠 الرئيسية' : '🏠 Home' }]);

    await botCtx.apiCall('sendMessage', { 
      chat_id: chatId, 
      text: txt, 
      reply_markup: { keyboard: kb, resize_keyboard: true }
    });
  }

  static async sendAdminMenuDetails(botCtx, chatId, menuId, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu) return;

    const typeStr = menu.reply_type === 'submenu' ? (lang === 'ar' ? 'مجلد (قائمة)' : 'Folder') :
                    menu.reply_type === 'file' ? (lang === 'ar' ? 'ملفات' : 'Files') :
                    (lang === 'ar' ? 'نص' : 'Text');

    let txt = lang === 'ar' 
      ? `<b>📝 تفاصيل الزر:</b>\n\n<b>الاسم:</b> ${menu.title_ar}\n<b>النوع:</b> ${typeStr}`
      : `<b>📝 Button Details:</b>\n\n<b>Name:</b> ${menu.title_en}\n<b>Type:</b> ${typeStr}`;

    const kb = [];
    
    // Core actions for all types
    kb.push([
      { text: lang === 'ar' ? '✏️ إعادة التسمية' : '✏️ Rename', callback_data: `admin_rename_${menuId}` },
      { text: lang === 'ar' ? '🗑️ حذف الزر' : '🗑️ Delete Button', callback_data: `admin_delbtn_${menuId}` }
    ]);

    // Type specific actions
    if (menu.reply_type === 'submenu') {
      kb.push([{ text: lang === 'ar' ? '📂 فتح المجلد' : '📂 Open Folder', callback_data: `admin_open_${menuId}` }]);
    } else if (menu.reply_type === 'file') {
      kb.push([{ text: lang === 'ar' ? '🗑️ حذف المحتوى' : '🗑️ Delete Content', callback_data: `admin_delcontent_${menuId}` }]);
      kb.push([
        { text: lang === 'ar' ? '👁️ معاينة الملفات' : '👁️ Preview Files', callback_data: `admin_previewfiles_${menuId}` },
        { text: lang === 'ar' ? '➕ إضافة ملف آخر' : '➕ Add File', callback_data: `admin_addfile_${menuId}` }
      ]);
    } else if (menu.reply_type === 'text') {
      kb.push([{ text: lang === 'ar' ? '🗑️ حذف المحتوى' : '🗑️ Delete Content', callback_data: `admin_delcontent_${menuId}` }]);
      kb.push([{ text: lang === 'ar' ? '📝 تعديل النص' : '📝 Edit Text', callback_data: `admin_edittext_${menuId}` }]);
    }

    // Advanced options (Inline buttons, Move, Order)
    kb.push([
      { text: lang === 'ar' ? '🔗 أزرار شفافة' : '🔗 Inline Buttons', callback_data: `admin_inline_${menuId}` },
      { text: lang === 'ar' ? '🔄 نقل الزر' : '🔄 Move', callback_data: `admin_move_${menuId}` }
    ]);

    kb.push([{ text: lang === 'ar' ? '↕️ تغيير الترتيب' : '↕️ Change Order', callback_data: `admin_order_${menuId}` }]);

    // Status Toggles
    const isActive = menu.is_active !== false; 
    const isHidden = menu.is_hidden === true;

    const toggleActiveStr = isActive
      ? (lang === 'ar' ? '🟢 إيقاف الزر' : '🟢 Disable') 
      : (lang === 'ar' ? '🔴 تشغيل الزر' : '🔴 Enable');
    const toggleHiddenStr = isHidden
      ? (lang === 'ar' ? '👻 إظهار الزر' : '👻 Show Button')
      : (lang === 'ar' ? '👁️ إخفاء الزر' : '👁️ Hide Button');

    kb.push([
      { text: toggleActiveStr, callback_data: `admin_toggleactive_${menuId}` },
      { text: toggleHiddenStr, callback_data: `admin_togglehidden_${menuId}` }
    ]);

    await botCtx.apiCall('sendMessage', { 
      chat_id: chatId, 
      text: txt, 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: kb } 
    });
  }

  static async sendAdminMoveOrderPosition(botCtx, chatId, menuId, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu) return;

    const menus = await dbHelper.getMenusByFaculty(botCtx.facultyId);
    const siblings = menus.filter(m => m.parent_id === menu.parent_id).sort((a,b) => a.sort_order - b.sort_order);
    
    const kb = [];
    
    siblings.forEach((s, index) => {
      kb.push([{ text: `📍 انقل إلى هذا السطر (${index + 1})` }]);
      const icon = s.reply_type === 'submenu' ? '📁' : (s.reply_type === 'file' ? '📄' : '📝');
      const title = lang === 'ar' ? s.title_ar : s.title_en;
      const marker = s.id === menuId ? '🔄 ' : ''; 
      kb.push([{ text: `${marker}${icon} ${title}` }]);
    });
    
    kb.push([{ text: '📍 انقل إلى نهاية القائمة' }]);
    kb.push([{ text: lang === 'ar' ? '⬅️ إلغاء الأمر' : '⬅️ Cancel Operation' }]);
    
    const txt = lang === 'ar' ? 'اختر الموضع الجديد الذي تريد نقل الزر إليه:' : 'Choose the new position for the button:';
    await botCtx.apiCall('sendMessage', { chat_id: chatId, text: txt, reply_markup: { keyboard: kb, resize_keyboard: true } });
  }

  static async moveMenuOrderPosition(botCtx, chatId, menuId, newPositionIndex, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu) return;

    const menus = await dbHelper.getMenusByFaculty(botCtx.facultyId);
    const siblings = menus.filter(m => m.parent_id === menu.parent_id).sort((a,b) => a.sort_order - b.sort_order);
    
    const filteredSiblings = siblings.filter(m => m.id !== menuId);
    
    let finalIndex = newPositionIndex;
    if (finalIndex < 0) finalIndex = 0;
    if (finalIndex > filteredSiblings.length) finalIndex = filteredSiblings.length;
    
    filteredSiblings.splice(finalIndex, 0, menu);
    
    for (let i = 0; i < filteredSiblings.length; i++) {
      const item = filteredSiblings[i];
      await dbHelper.runQuery('UPDATE menus SET sort_order = $1 WHERE id = $2', [i + 1, item.id]);
    }
    
    await botCtx.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم نقل الزر بنجاح.' : '✅ Button moved successfully.', reply_markup: { remove_keyboard: true } });
    await this.sendAdminMenuDetails(botCtx, chatId, menuId, lang);
  }

  static async handleNavigation(botCtx, chatId, text, state, lang) {
    console.log(`[DEBUG admin-menu-navigation start] text: "${text}", action: "${state.action}"`);
    const cancelKb = { keyboard: [[{ text: lang === 'ar' ? '⬅️ إلغاء الأمر' : '⬅️ Cancel Operation' }]], resize_keyboard: true };

    if (state.action === 'managing_menus') {
      // 1. Check if they clicked a specific menu from the list
      const siblingMenus = await dbHelper.getMenusByFaculty(botCtx.facultyId);
      const possibleMenus = siblingMenus.filter(m => m.parent_id === state.currentMenuId);
      
      const clickedMenu = possibleMenus.find(m => {
        const icon = m.reply_type === 'submenu' ? '📁' : (m.reply_type === 'file' ? '📄' : '📝');
        const expectedAr = `${icon} ${m.title_ar}`;
        const expectedEn = `${icon} ${m.title_en}`;
        return text === expectedAr || text === expectedEn;
      });

      if (clickedMenu) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: clickedMenu.id });
        await this.sendAdminMenuDetails(botCtx, chatId, clickedMenu.id, lang);
        return true;
      }

      // 2. Navigation Actions
      if (text.includes('المستوى السابق') || text.includes('Parent Menu') || text.includes('رجوع') || text.includes('عودة') || text.includes('Back')) {
        console.log(`[DEBUG admin-menu-navigation condition] Entered navigation action with currentMenuId: ${state.currentMenuId}`);
        if (state.currentMenuId !== null) {
          const pMenu = await dbHelper.getMenuById(state.currentMenuId);
          const targetId = pMenu ? pMenu.parent_id : null;
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: targetId, viewingMenuDetailsId: null });
          if (targetId) {
            const { getMenuPathContext } = require('./menu-builder');
            const pathCtx = await getMenuPathContext(targetId);
            if (pathCtx) {
              botCtx.updateUserContext(chatId, {
                currentMenuId: pathCtx.currentMenuId,
                currentMenuTitle: pathCtx.currentMenuTitle,
                parentMenuId: pathCtx.parentMenuId,
                menuPath: pathCtx.menuPath,
                currentButtonTitle: pathCtx.currentMenuTitle
              });
            }
          }
          await this.sendAdminReplyMenus(botCtx, chatId, targetId, lang);
        } else {
          // If already at root and they press back, just reload root or send to admin home
          await this.sendAdminReplyMenus(botCtx, chatId, null, lang);
        }
        return true;
      }

      // 4. Add Actions (when viewing sibling list)
      const rowAddMatch = text.match(/➕.*\(r(\d+)\)/i);
      let targetRow = null;
      if (rowAddMatch) targetRow = parseInt(rowAddMatch[1], 10);
      else if (text.includes('سطر جديد') || text.includes('New Row')) targetRow = 'new';
      
      if (targetRow !== null || text.includes('إضافة زر جديد') || text.includes('Add New Button')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus_add_type', currentMenuId: state.currentMenuId, targetRow });
        await botCtx.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ما نوع الزر الجديد؟' : 'What type of button?', reply_markup: {
          keyboard: [
            [{ text: lang === 'ar' ? '📁 زر قائمة (مجلد)' : '📁 Menu Button (Folder)' }],
            [{ text: lang === 'ar' ? '📄 زر ملفات' : '📄 File Button' }],
            [{ text: lang === 'ar' ? '📝 زر نصي' : '📝 Text Button' }],
            [{ text: lang === 'ar' ? '⬅️ إلغاء الأمر' : '⬅️ Cancel Operation' }]
          ], resize_keyboard: true
        }});
        return true;
      }
    }

    if (state.action === 'managing_menus_add_type') {
      if (text.includes('إلغاء الأمر') || text.includes('Cancel Operation') || text.includes('إلغاء') || text.includes('Cancel')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: null });
        await this.sendAdminReplyMenus(botCtx, chatId, state.currentMenuId, lang);
        return true;
      }
      let type = null;
      if (text.includes('قائمة') || text.includes('Folder')) type = 'submenu';
      else if (text.includes('ملفات') || text.includes('File')) type = 'file';
      else if (text.includes('نصي') || text.includes('Text')) type = 'text';

      if (type) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_newmenu_title_ar', currentMenuId: state.currentMenuId, newType: type, targetRow: state.targetRow });
        await botCtx.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل اسم الزر الجديد (بالعربية):' : 'Send the new button name (Arabic):', reply_markup: cancelKb });
      }
      return true;
    }

    if (state.action === 'managing_menus_move_order') {
      const targetMenuId = state.menuId || state.viewingMenuDetailsId;
      if (text.includes('إلغاء') || text.includes('Cancel')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: targetMenuId });
        await this.sendAdminMenuDetails(botCtx, chatId, targetMenuId, lang);
        return true;
      }

      let newPositionIndex = null;
      
      if (text.includes('📍 انقل إلى هذا السطر (')) {
        // Extract the number
        const match = text.match(/\((\d+)\)/);
        if (match) {
          newPositionIndex = parseInt(match[1], 10) - 1; // 0-based index
        }
      } else if (text.includes('📍 انقل إلى نهاية القائمة')) {
        // Will be bounded to max length in the move function
        newPositionIndex = 99999;
      }

      if (newPositionIndex !== null) {
        await this.moveMenuOrderPosition(botCtx, chatId, targetMenuId, newPositionIndex, lang);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: targetMenuId });
      }
      return true;
    }

    return false; // Not handled
  }

}

module.exports = AdminMenuNavigation;

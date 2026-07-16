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
      kb.push([{ text: lang === 'ar' ? '🔙 رجوع' : '🔙 Back' }]);
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
    const siblings = menus.filter(m => m.parent_id === menu.parent_id);
    
    // Group siblings by row_index
    const rowsMap = new Map();
    siblings.forEach(item => {
      const ri = item.row_index || 0;
      if (!rowsMap.has(ri)) rowsMap.set(ri, []);
      rowsMap.get(ri).push(item);
    });

    const sortedRows = Array.from(rowsMap.keys()).sort((a,b) => a - b);
    const kb = [];

    let rowDisplayCount = 1;

    sortedRows.forEach(ri => {
      const rowItems = rowsMap.get(ri).sort((a,b) => a.sort_order - b.sort_order);
      // Exclude the currently moving button from the row capacity calculation
      const rowItemsExcludingMoving = rowItems.filter(m => m.id !== menuId);
      
      if (rowItemsExcludingMoving.length > 0) {
        if (rowItemsExcludingMoving.length < 3) {
          const buttonNames = rowItemsExcludingMoving.map(m => lang === 'ar' ? m.title_ar : m.title_en).join('، ');
          kb.push([{ text: `📍 السطر ${rowDisplayCount} (${buttonNames})` }]);
        }
        rowDisplayCount++;
      }
    });

    kb.push([{ text: '📍 سطر جديد في نهاية القائمة' }]);
    kb.push([{ text: lang === 'ar' ? '⬅️ إلغاء الأمر' : '⬅️ Cancel Operation' }]);
    
    const txt = lang === 'ar' ? 'اختر السطر الذي تريد نقل الزر إليه:' : 'Choose the row to move the button to:';
    await botCtx.apiCall('sendMessage', { chat_id: chatId, text: txt, reply_markup: { keyboard: kb, resize_keyboard: true } });
  }

  static async moveMenuOrderPosition(botCtx, chatId, menuId, targetRowDisplay, lang) {
    const menu = await dbHelper.getMenuById(menuId);
    if (!menu) return;

    const menus = await dbHelper.getMenusByFaculty(botCtx.facultyId);
    const siblings = menus.filter(m => m.parent_id === menu.parent_id);
    
    const rowsMap = new Map();
    siblings.forEach(item => {
      const ri = item.row_index || 0;
      if (!rowsMap.has(ri)) rowsMap.set(ri, []);
      rowsMap.get(ri).push(item);
    });

    const sortedRows = Array.from(rowsMap.keys()).sort((a,b) => a - b);
    
    let targetRowIndex = -1;

    if (targetRowDisplay === 'new') {
      targetRowIndex = sortedRows.length > 0 ? sortedRows[sortedRows.length - 1] + 1 : 0;
    } else {
      let rowDisplayCount = 1;
      for (const ri of sortedRows) {
        const rowItems = rowsMap.get(ri);
        const rowItemsExcludingMoving = rowItems.filter(m => m.id !== menuId);
        
        if (rowItemsExcludingMoving.length > 0) {
          if (rowDisplayCount === targetRowDisplay) {
            targetRowIndex = ri;
            break;
          }
          rowDisplayCount++;
        }
      }
    }

    if (targetRowIndex === -1) {
      await botCtx.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '⚠️ حدث خطأ أثناء تحديد السطر.' : '⚠️ Error identifying row.' });
      return;
    }

    // Change the moving menu's row_index
    menu.row_index = targetRowIndex;
    
    // We now have all siblings including the moved menu with their updated row_index
    // We must sequence all row_indices to 0, 1, 2... and sort_order within each row
    const newRowsMap = new Map();
    siblings.forEach(item => {
      const ri = item.id === menu.id ? targetRowIndex : (item.row_index || 0);
      if (!newRowsMap.has(ri)) newRowsMap.set(ri, []);
      newRowsMap.get(ri).push(item);
    });

    const newSortedRows = Array.from(newRowsMap.keys()).sort((a,b) => a - b);
    
    let globalRowIndex = 0;
    for (const ri of newSortedRows) {
      const itemsInRow = newRowsMap.get(ri);
      // If a row is completely empty, it is naturally skipped because newRowsMap only has populated rows!
      if (itemsInRow.length > 0) {
        // Sort items inside this row. The newly moved menu should be at the end.
        // We do this by sorting existing ones by sort_order, but the moved one gets put at the end artificially
        const existingItems = itemsInRow.filter(m => m.id !== menu.id).sort((a,b) => a.sort_order - b.sort_order);
        const movedItem = itemsInRow.find(m => m.id === menu.id);
        
        if (movedItem) {
          existingItems.push(movedItem);
        }

        for (let i = 0; i < existingItems.length; i++) {
          const item = existingItems[i];
          // We update row_index = globalRowIndex and sort_order = i + 1
          await dbHelper.runQuery('UPDATE menus SET row_index = $1, sort_order = $2 WHERE id = $3', [globalRowIndex, i + 1, item.id]);
        }
        globalRowIndex++;
      }
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
        if (clickedMenu.reply_type === 'submenu') {
          await this.sendAdminMenuDetails(botCtx, chatId, clickedMenu.id, lang);
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: clickedMenu.id, viewingMenuDetailsId: null });
          await this.sendAdminReplyMenus(botCtx, chatId, clickedMenu.id, lang);
        } else {
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: clickedMenu.id });
          await this.sendAdminMenuDetails(botCtx, chatId, clickedMenu.id, lang);
        }
        return true;
      }

      // 2. Navigation Actions
      if (text.includes('القائمة السابقة') || text.includes('Parent Menu') || text.includes('رجوع') || text.includes('الرجوع') || text.includes('Back') || text.includes('عودة')) {
        console.log(`[DEBUG admin-menu-navigation condition] Entered navigation action with currentMenuId: ${state.currentMenuId}`);
        const dbHelper = require('./database');
        const prevState = await dbHelper.popAdminState(chatId);
        
        if (prevState.action === 'admin_home') {
          await botCtx.sendAdminHome(chatId, lang);
        } else if (prevState.action === 'managing_menus') {
          if (prevState.viewingMenuDetailsId) {
            await botCtx.sendAdminMenuDetails(chatId, prevState.viewingMenuDetailsId, lang);
          } else {
            await botCtx.sendAdminReplyMenus(chatId, prevState.currentMenuId, lang);
          }
        } else {
          // Fallback
          await botCtx.sendAdminReplyMenus(chatId, null, lang);
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

      let targetRowDisplay = null;
      
      if (text.includes('📍 السطر ')) {
        const match = text.match(/📍 السطر (\d+)/);
        if (match) {
          targetRowDisplay = parseInt(match[1], 10);
        }
      } else if (text.includes('📍 سطر جديد في نهاية القائمة')) {
        targetRowDisplay = 'new';
      }

      if (targetRowDisplay !== null) {
        await this.moveMenuOrderPosition(botCtx, chatId, targetMenuId, targetRowDisplay, lang);
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: targetMenuId });
      }
      return true;
    }

    return false; // Not handled
  }

}

module.exports = AdminMenuNavigation;

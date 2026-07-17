const dbHelper = require('./database');
const { t } = require('./src/localization');

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
        rowKb.push({ text: `${t(lang, 'BTN_ADD_HERE')} (r${ri})` });
      }
      kb.push(rowKb);
    });

    kb.push([{ text: t(lang, 'BTN_NEW_ROW') }]);

    if (parentId !== null) {
      kb.push([{ text: t(lang, 'BTN_BACK') }]);
    }
    kb.push([{ text: t(lang, 'BTN_CFG_HOME') }]);

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
      { text: t(lang, 'BTN_RENAME'), callback_data: `admin_rename_${menuId}` },
      { text: t(lang, 'BTN_DELETE_BUTTON'), callback_data: `admin_delbtn_${menuId}` }
    ]);

    // Type specific actions
    if (menu.reply_type === 'submenu') {
      kb.push([{ text: t(lang, 'BTN_OPEN_FOLDER'), callback_data: `admin_open_${menuId}` }]);
    } else if (menu.reply_type === 'file') {
      kb.push([{ text: t(lang, 'BTN_DELETE_CONTENT'), callback_data: `admin_delcontent_${menuId}` }]);
      kb.push([
        { text: t(lang, 'BTN_PREVIEW_FILES'), callback_data: `admin_previewfiles_${menuId}` },
        { text: t(lang, 'BTN_ADD_FILE'), callback_data: `admin_addfile_${menuId}` }
      ]);
    } else if (menu.reply_type === 'text') {
      kb.push([{ text: t(lang, 'BTN_DELETE_CONTENT'), callback_data: `admin_delcontent_${menuId}` }]);
      kb.push([{ text: t(lang, 'BTN_EDIT_TEXT'), callback_data: `admin_edittext_${menuId}` }]);
    }

    // Advanced options (Inline buttons, Move, Order)
    kb.push([
      { text: t(lang, 'BTN_INLINE_BUTTONS'), callback_data: `admin_inline_${menuId}` },
      { text: t(lang, 'BTN_MOVE'), callback_data: `admin_move_${menuId}` }
    ]);

    kb.push([{ text: t(lang, 'BTN_CHANGE_ORDER'), callback_data: `admin_order_${menuId}` }]);

    // Status Toggles
    const isActive = menu.is_active !== false; 
    const isHidden = menu.is_hidden === true;

    const toggleActiveStr = isActive ? t(lang, 'BTN_DISABLE') : t(lang, 'BTN_ENABLE');
    const toggleHiddenStr = isHidden ? t(lang, 'BTN_SHOW_BUTTON') : t(lang, 'BTN_HIDE_BUTTON');

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

    kb.push([{ text: t(lang, 'BTN_NEW_ROW_END') }]);
    kb.push([{ text: t(lang, 'BTN_CANCEL_OP') }]);
    
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
    const cancelKb = { keyboard: [[{ text: t(lang, 'BTN_CANCEL_OP') }]], resize_keyboard: true };

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
      if (text === t('ar', 'BTN_CFG_HOME') || text === t('en', 'BTN_CFG_HOME')) {
        await botCtx.sendAdminHome(chatId, lang);
        return true;
      }

      if (text === t('ar', 'BTN_BACK') || text === t('en', 'BTN_BACK')) {
        if (state.viewingMenuDetailsId) {
          // If viewing details, go back to sibling list
          await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: null });
          await this.sendAdminReplyMenus(botCtx, chatId, state.currentMenuId, lang);
        } else if (state.currentMenuId !== null) {
          // If viewing sibling list, go to parent
          const currentMenu = await dbHelper.getMenuById(state.currentMenuId);
          if (currentMenu && currentMenu.parent_id !== null) {
            await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: currentMenu.parent_id, viewingMenuDetailsId: null });
            await this.sendAdminReplyMenus(botCtx, chatId, currentMenu.parent_id, lang);
          } else {
            await botCtx.sendAdminHome(chatId, lang);
          }
        } else {
          await botCtx.sendAdminHome(chatId, lang);
        }
        return true;
      }

      // 4. Add Actions (when viewing sibling list)
      const baseAddHereAr = t('ar', 'BTN_ADD_HERE');
      const baseAddHereEn = t('en', 'BTN_ADD_HERE');
      
      let targetRow = null;
      if (text.startsWith(baseAddHereAr) || text.startsWith(baseAddHereEn)) {
          const rowAddMatch = text.match(/\(r(\d+)\)/i);
          if (rowAddMatch) targetRow = parseInt(rowAddMatch[1], 10);
      } else if (text === t('ar', 'BTN_NEW_ROW') || text === t('en', 'BTN_NEW_ROW')) {
          targetRow = 'new';
      }
      
      if (targetRow !== null) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus_add_type', currentMenuId: state.currentMenuId, targetRow });
        const canAddFolder = await dbHelper.hasPermission(chatId, botCtx.facultyId, 'MANAGE_FOLDERS');
        const keyboard = [];
        if (canAddFolder) {
            keyboard.push([{ text: t(lang, 'BTN_MENU_FOLDER') }]);
        }
        keyboard.push([{ text: t(lang, 'BTN_FILE_BUTTON') }]);
        keyboard.push([{ text: t(lang, 'BTN_TEXT_BUTTON') }]);
        keyboard.push([{ text: t(lang, 'BTN_CANCEL_OP') }]);

        await botCtx.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ما نوع الزر الجديد؟' : 'What type of button?', reply_markup: {
          keyboard, resize_keyboard: true
        }});
        return true;
      }
    }

    if (state.action === 'managing_menus_add_type') {
      if (text === t('ar', 'BTN_CANCEL_OP') || text === t('en', 'BTN_CANCEL_OP')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: null });
        await this.sendAdminReplyMenus(botCtx, chatId, state.currentMenuId, lang);
        return true;
      }
      
      let type = null;
      if (text === t('ar', 'BTN_MENU_FOLDER') || text === t('en', 'BTN_MENU_FOLDER')) {
          if (!(await dbHelper.hasPermission(chatId, botCtx.facultyId, 'MANAGE_FOLDERS'))) {
              await botCtx.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'ليس لديك صلاحية لإضافة مجلد.' : 'No permission to add folder.' });
              return true;
          }
          type = 'submenu';
      }
      else if (text === t('ar', 'BTN_FILE_BUTTON') || text === t('en', 'BTN_FILE_BUTTON')) type = 'file';
      else if (text === t('ar', 'BTN_TEXT_BUTTON') || text === t('en', 'BTN_TEXT_BUTTON')) type = 'text';

      if (type) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_newmenu_title_ar', currentMenuId: state.currentMenuId, newType: type, targetRow: state.targetRow });
        await botCtx.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل اسم الزر الجديد (بالعربية):' : 'Send the new button name (Arabic):', reply_markup: cancelKb });
      }
      return true;
    }

    if (state.action === 'managing_menus_move_order') {
      const targetMenuId = state.menuId || state.viewingMenuDetailsId;
      if (text === t('ar', 'BTN_CANCEL_OP') || text === t('en', 'BTN_CANCEL_OP')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: state.currentMenuId, viewingMenuDetailsId: targetMenuId });
        await this.sendAdminMenuDetails(botCtx, chatId, targetMenuId, lang);
        return true;
      }

      let targetRowDisplay = null;
      
      if (text.startsWith('📍 السطر ')) {
        const match = text.match(/📍 السطر (\d+)/);
        if (match) {
          targetRowDisplay = parseInt(match[1], 10);
        }
      } else if (text === t('ar', 'BTN_NEW_ROW_END') || text === t('en', 'BTN_NEW_ROW_END')) {
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

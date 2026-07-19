  async sendAdminMoveOrder(chatId, menuId, lang) {
    const kb = [
      [
        { text: 'â¬†ï¸ Up' },
        { text: 'â¬‡ï¸ Down' }
      ],
      [{ text: lang === 'ar' ? 'â¬…ï¸ Ø¥Ù„ØºØ§Ø¡ Ø§Ù„ØªØ±ØªÙŠØ¨' : 'â¬…ï¸ Cancel Order' }]
    ];
    await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'Ø§Ø®ØªØ± Ø§Ù„Ø§ØªØ¬Ø§Ù‡ Ù„Ø²Ø± Ø§Ù„Ù†Ù‚Ù„:' : 'Choose direction:', reply_markup: { keyboard: kb, resize_keyboard: true } });
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
    await dbHelper.setAdminState(chatId, { action: 'managing_menus', currentMenuId: menu.parent_id, viewingMenuDetailsId: menuId });
    await this.sendAdminMenuDetails(chatId, menuId, lang);
  }

  async sendLanguageSelection(chatId) {
    await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: "Please select your language / Ø§Ù„Ø±Ø¬Ø§Ø¡ Ø§Ø®ØªÙŠØ§Ø± Ø§Ù„Ù„ØºØ©:",
      reply_markup: {
        inline_keyboard: [
          [{ text: "ðŸ‡ºðŸ‡¸ English", callback_data: "lang_en" }, { text: "ðŸ‡¸ðŸ‡¦ Ø§Ù„Ø¹Ø±Ø¨ÙŠØ©", callback_data: "lang_ar" }]
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
      promptText = lang === 'ar' ? (faculty.welcome_ar || 'Ù…Ø±Ø­Ø¨Ø§Ù‹ Ø¨Ùƒ') : (faculty.welcome_en || 'Welcome');
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
      keyboard.push([{ text: lang === 'ar' ? 'â¬…ï¸ Ø¹ÙˆØ¯Ø©' : 'â¬…ï¸ Back' }]);
    }

    const adminRole = await dbHelper.getAdminRole(faculty.id, chatId);
    const isAdmin = adminRole !== 'USER';
    if (isAdmin && parentId === null) {
      keyboard.push([{ text: lang === 'ar' ? 'ðŸ› ï¸ Ù„ÙˆØ­Ø© Ø§Ù„ØªØ­ÙƒÙ… Ù„Ù„Ù…Ø´Ø±ÙÙŠÙ†' : 'ðŸ› ï¸ Admin Panel' }]);
    }

    const replyMarkup = keyboard.length > 0 ? { keyboard, resize_keyboard: true } : { remove_keyboard: true };

    const res = await this.apiCall('sendMessage', {
      chat_id: chatId,
      text: promptText,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    });

    if (!res.ok) {
      this.logError('Failed to send menu', null, { description: res.description, promptText });
      // Fallback without Markdown if the welcome message has bad characters
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: promptText,
        reply_markup: replyMarkup
      });
    }
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
      { command: 'start', description: 'Ø§Ù„Ø¨Ø¯Ø¡ ÙˆØ§Ø³ØªØ¹Ø±Ø§Ø¶ Ø§Ù„Ù‚Ø§Ø¦Ù…Ø©' },
      { command: 'changelanguage', description: 'ØªØºÙŠÙŠØ± Ù„ØºØ© Ø§Ù„Ø¨ÙˆØª' },
      { command: 'back', description: 'Ø§Ù„Ø¹ÙˆØ¯Ø© Ù„Ù„Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø³Ø§Ø¨Ù‚Ø©' },
      { command: 'id', description: 'Ø§Ù„Ø­ØµÙˆÙ„ Ø¹Ù„Ù‰ Ù…Ø¹Ø±Ù ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù…' },
      { command: 'admin', description: 'Ù„ÙˆØ­Ø© Ø§Ù„ØªØ­ÙƒÙ… Ù„Ù„Ù…Ø´Ø±ÙÙŠÙ†' }
    ];
    await this.apiCall('setMyCommands', { commands: en });
    await this.apiCall('setMyCommands', { commands: ar, language_code: 'ar' });
  }



$code = [System.IO.File]::ReadAllText("bot-manager.js", [System.Text.Encoding]::UTF8)

# 1. processMenuClick
$newProcessMenuClick = @"
  async processMenuClick(chatId, user, clickedMenu, allMenus) {
    if (clickedMenu.is_active === false) {
      const msg = user.language === 'ar' ? '⛔ هذا الزر معطل حالياً.' : '⛔ This button is currently disabled.';
      await this.apiCall('sendMessage', { chat_id: chatId, text: msg });
      return;
    }

    if (clickedMenu.reply_type === 'submenu') {
"@
$code = $code -replace '(?s)  async processMenuClick\(chatId, user, clickedMenu, allMenus\) \{\r?\n    if \(clickedMenu\.reply_type === ''submenu''\) \{', $newProcessMenuClick

# 2. handleMessage Live Monitoring
$newHandleMessage = @"
    const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);

    if (faculty.forward_user_messages && !isAdmin && faculty.admin_chat_id) {
      const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim());
      for (const adminId of adminIds) {
        if (adminId) {
          const userStr = message.from.username ? `@${message.from.username}` : message.from.first_name;
          await this.apiCall('sendMessage', { 
            chat_id: adminId, 
            text: `👀 **مراقبة النشاط**\n\n👤 المستخدم: ${userStr} (ID: ${message.from.id})\n💬 النص: ${text}`,
            parse_mode: 'Markdown'
          });
        }
      }
    }
    const adminState = await dbHelper.getAdminState(chatId);
"@
$code = $code -replace '(?s)    const isAdmin = faculty\.admin_chat_id.*?    const adminState = await dbHelper\.getAdminState\(chatId\);', $newHandleMessage

# 3. handleCallbackQuery Live Monitoring
$newCallbackMon = @"
    try {
      const dbHelper = require('./database');
      const faculty = await dbHelper.getFacultyById(this.facultyId);
      const isAdmin = faculty.admin_chat_id && faculty.admin_chat_id.split(',').map(s => s.trim()).includes(chatId);
      if (faculty && faculty.forward_user_messages && !isAdmin && faculty.admin_chat_id) {
        const adminIds = faculty.admin_chat_id.split(',').map(s => s.trim());
        for (const adminId of adminIds) {
          if (adminId) {
            const userStr = callbackQuery.from.username ? `@${callbackQuery.from.username}` : callbackQuery.from.first_name;
            await this.apiCall('sendMessage', { 
              chat_id: adminId, 
              text: `👀 **مراقبة النشاط (زر)**\n\n👤 المستخدم: ${userStr} (ID: ${callbackQuery.from.id})\n🔘 الزر: ${btnText} (${data})`,
              parse_mode: 'Markdown'
            });
          }
        }
      }
    } catch(e) {}

    if (data.startsWith('lang_')) {
"@
$code = $code -replace "(?s)    if \(data\.startsWith\('lang_'\)\) \{", $newCallbackMon

# 4. Core Settings Live Activity Toggle
$newCoreSettings = @"
      } else if (text.includes('إعدادات') || text.includes('Core Settings')) {
        await dbHelper.setAdminState(chatId, { action: 'managing_config' });
        const cfgText = lang === 'ar' 
          ? '⚙️ إعدادات البوت\n\nاختر الإعداد الذي ترغب بتعديله:'
          : '⚙️ Bot Configuration\n\nWhat would you like to edit?';
        const fac = await dbHelper.getFacultyById(this.facultyId);
        const monStatus = fac.forward_user_messages ? (lang === 'ar' ? 'مفعل 🟢' : 'ON 🟢') : (lang === 'ar' ? 'معطل 🔴' : 'OFF 🔴');
        const cfgKb = [
          [{ text: lang === 'ar' ? '👋 رسالة الترحيب' : '👋 Welcome Msg' }, { text: lang === 'ar' ? '🚧 رسالة الصيانة' : '🚧 Maintenance Msg' }],
          [{ text: lang === 'ar' ? '🗑️ رسالة الزر الفارغ' : '🗑️ Empty Button Msg' }, { text: lang === 'ar' ? '❓ رسالة نص غير معروف' : '❓ Unknown Text Msg' }],
          [{ text: lang === 'ar' ? '❌ رسالة لا يوجد ملف' : '❌ No File Msg' }, { text: lang === 'ar' ? `👀 مراقبة النشاط: ${monStatus}` : `👀 Live Activity: ${monStatus}` }],
          [{ text: lang === 'ar' ? '🏠 الرئيسية' : '🏠 Home' }]
        ];
        await this.apiCall('sendMessage', { chat_id: chatId, text: cfgText, reply_markup: { keyboard: cfgKb, resize_keyboard: true } });
      } else if (text.includes('إضافة مشرف') || text.includes('Add Sub-Admin')) {
"@
$code = $code -replace '(?s)      \} else if \(text\.includes\(''[^'']*إعدادات.*?\)\) \{\r?\n        await dbHelper\.setAdminState.*?\} else if \(text\.includes\(''[^'']*إضافة مشرف.*?\)\) \{', $newCoreSettings

# 5. Core Settings Toggle Action
$newToggleAction = @"
      if (text.includes('Welcome Msg') || text.includes('رسالة الترحيب')) {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_welcome_ar' });
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? 'أرسل رسالة الترحيب الجديدة (بالعربية):' : 'Send new welcome message (Arabic):', reply_markup: { remove_keyboard: true } });
      } else if (text.includes('مراقبة النشاط') || text.includes('Live Activity')) {
        const fac = await dbHelper.getFacultyById(this.facultyId);
        await dbHelper.toggleFacultyForwarding(this.facultyId, !fac.forward_user_messages);
        await this.apiCall('sendMessage', { chat_id: chatId, text: lang === 'ar' ? '✅ تم التغيير بنجاح' : '✅ Toggled successfully' });
        return this.handleAdminStateMessage(chatId, { text: lang === 'ar' ? 'إعدادات' : 'Settings' }, lang, { action: 'managing_admin' });
      } else if (text.includes('Maintenance Msg') || text.includes('رسالة الصيانة')) {
"@
$code = $code -replace '(?s)      if \(text\.includes\(''(?:Welcome Msg|[^'']*الترحيب)[^'']*''\) \|\| text\.includes\(''(?:Welcome Msg|[^'']*الترحيب)[^'']*''\)\) \{\r?\n.*?\} else if \(text\.includes\(''(?:Maintenance Msg|[^'']*الصيانة)[^'']*''\) \|\| text\.includes\(''(?:Maintenance Msg|[^'']*الصيانة)[^'']*''\)\) \{', $newToggleAction

[System.IO.File]::WriteAllText("bot-manager.js", $code, [System.Text.Encoding]::UTF8)

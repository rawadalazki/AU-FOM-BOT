const fs = require('fs');
let code = fs.readFileSync('bot-manager.js', 'utf8');

// 1. In `handleAdminStateMessage` under `managing_admin`, we replace the `add_subadmin` handling
const replacement = `} else if (actionId === 'manage_admins') {
        const keyboard = [
          [{ text: require('./src/localization').t(lang, 'BTN_ADD_SUBADMIN') }],
          [{ text: require('./src/localization').t(lang, 'BTN_VIEW_SUBADMINS') }],
          [{ text: require('./src/localization').t(lang, 'BTN_REMOVE_SUBADMIN') }],
          [{ text: require('./src/localization').t(lang, 'BTN_BACK') }]
        ];
        await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'BTN_MANAGE_ADMINS') + ':', reply_markup: { keyboard, resize_keyboard: true } });
        await dbHelper.setAdminState(chatId, { action: 'admin_manage_admins_menu' });
        return;
      } else if (actionId === 'admin_monitoring') {
        const keyboard = [
          [{ text: require('./src/localization').t(lang, 'BTN_ENABLE_MONITORING') }],
          [{ text: require('./src/localization').t(lang, 'BTN_DISABLE_MONITORING') }],
          [{ text: require('./src/localization').t(lang, 'BTN_BACK') }]
        ];
        await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'BTN_MONITORING') + ':', reply_markup: { keyboard, resize_keyboard: true } });
        await dbHelper.setAdminState(chatId, { action: 'admin_monitoring_menu' });
        return;
      } else if (actionId === 'add_subadmin') {`;

if (!code.includes("actionId === 'manage_admins'")) {
  code = code.replace(/\} else if \(actionId === 'add_subadmin'\) \{/, replacement);
}

// 2. Handle sub-admin states inside handleAdminStateMessage main switch block (or at the start)
// The global `actionId === 'cancel'` handles cancellation. We need to prevent it from going to `admin_home` if state is `awaiting_subadmin_id`.
const cancelRegex = /if \(\(actionId === 'cancel' \|\| text === '\/cancel' \|\| text\.includes\('إلغاء الأمر'\) \|\| text\.includes\('الغاء الامر'\) \|\| text\.includes\('Cancel Operation'\)\)\) \{/;
const origCancel = `if (actionId === 'cancel' || text === '/cancel' || text.includes('إلغاء الأمر') || text.includes('الغاء الامر') || text.includes('Cancel Operation')) {`;
if (code.includes(origCancel)) {
   code = code.replace(origCancel, `if (actionId === 'cancel' || text === '/cancel' || text.includes('إلغاء الأمر') || text.includes('الغاء الامر') || text.includes('Cancel Operation') || text === require('./src/localization').t(lang, 'BTN_CANCEL_OP')) {
      if (state.action === 'awaiting_subadmin_id') {
         await dbHelper.setAdminState(chatId, { action: 'admin_manage_admins_menu' });
         const keyboard = [
           [{ text: require('./src/localization').t(lang, 'BTN_ADD_SUBADMIN') }],
           [{ text: require('./src/localization').t(lang, 'BTN_VIEW_SUBADMINS') }],
           [{ text: require('./src/localization').t(lang, 'BTN_REMOVE_SUBADMIN') }],
           [{ text: require('./src/localization').t(lang, 'BTN_BACK') }]
         ];
         await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_ACTION_CANCELLED'), reply_markup: { keyboard, resize_keyboard: true } });
         return;
      }`);
}

// 3. Handle 'back'
const backRegex = /if \(actionId === 'back'\) \{([\s\S]*?)return;\s*\}/;
if (code.includes("if (actionId === 'back') {")) {
  code = code.replace(backRegex, (match) => {
    if (match.includes("admin_manage_admins_menu")) return match;
    return `if (actionId === 'back') {
      if (state && (state.action === 'admin_manage_admins_menu' || state.action === 'admin_monitoring_menu')) {
          await dbHelper.setAdminState(chatId, { action: 'admin_home' });
          await this.sendAdminHome(chatId, lang);
          return;
      }
      await dbHelper.setAdminState(chatId, { action: 'admin_home' });
      await this.sendAdminHome(chatId, lang);
      return;
    }`;
  });
}

// 4. Handle states for manage_admins_menu and monitoring_menu
// We'll append them before the `switch (state.action)` or handle them if they are top-level actions
const newStates = `
    if (state.action === 'admin_manage_admins_menu') {
      if (actionId === 'add_subadmin') {
        await dbHelper.setAdminState(chatId, { action: 'awaiting_subadmin_id' });
        const cancelKb = { keyboard: [[{ text: require('./src/localization').t(lang, 'BTN_CANCEL_OP') }]], resize_keyboard: true };
        await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_SEND_SUBADMIN_ID'), reply_markup: cancelKb });
        return;
      } else if (actionId === 'view_subadmins') {
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        const adminIds = faculty.admin_chat_id ? faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean) : [];
        const secondaryIds = adminIds.slice(1);
        if (secondaryIds.length === 0) {
           await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_NO_SECONDARY_ADMINS') });
           return;
        }
        let msgText = require('./src/localization').t(lang, 'MSG_TOTAL_ADMINS') + ' ' + secondaryIds.length + '\\n\\n';
        for (const secId of secondaryIds) {
           const secUserRes = await dbHelper.pool.query('SELECT * FROM bot_users WHERE chat_id = $1 AND faculty_id = $2', [secId, this.facultyId]);
           const secUser = secUserRes.rows[0];
           msgText += \`ID: <code>\${secId}</code>\\n\`;
           if (secUser) {
              msgText += \`Name: \${secUser.username || 'Unknown'}\\nLanguage: \${secUser.language || 'N/A'}\\nRegistered: \${secUser.created_at ? new Date(secUser.created_at).toLocaleString() : 'Unknown'}\\n\\n\`;
           } else {
              msgText += \`Name: Unknown\\n\\n\`;
           }
        }
        await this.apiCall('sendMessage', { chat_id: chatId, text: msgText, parse_mode: 'HTML' });
        return;
      } else if (actionId === 'remove_subadmin') {
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        const adminIds = faculty.admin_chat_id ? faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean) : [];
        const secondaryIds = adminIds.slice(1);
        if (secondaryIds.length === 0) {
           await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_NO_SECONDARY_ADMINS') });
           return;
        }
        const inlineKeyboard = secondaryIds.map(id => ([{ text: \`ID: \${id}\`, callback_data: \`del_sub_\${id}\` }]));
        await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_CHOOSE_ADMIN_TO_REMOVE'), reply_markup: { inline_keyboard: inlineKeyboard } });
        return;
      }
    }
    
    if (state.action === 'admin_monitoring_menu') {
      if (actionId === 'enable_monitoring' || actionId === 'disable_monitoring') {
        const isEnable = actionId === 'enable_monitoring';
        await dbHelper.updateMonitoringEnabled(this.facultyId, isEnable);
        await this.apiCall('sendMessage', { chat_id: chatId, text: isEnable ? require('./src/localization').t(lang, 'MSG_MONITORING_ENABLED') : require('./src/localization').t(lang, 'MSG_MONITORING_DISABLED') });
        await dbHelper.setAdminState(chatId, { action: 'admin_home' });
        await this.sendAdminHome(chatId, lang);
        return;
      }
    }
`;
if (!code.includes(`state.action === 'admin_manage_admins_menu'`)) {
  code = code.replace(/switch \(state\.action\) \{/, `${newStates}\n    switch (state.action) {`);
}

// 5. Update awaiting_subadmin_id to return to manage_admins instead of admin_home after successful add
if (code.includes("case 'awaiting_subadmin_id':")) {
    const successReturnRegex = /await this\.sendAdminHome\(chatId, lang\);\s*break;/g;
    code = code.replace(successReturnRegex, (match, offset, str) => {
        // We only want to replace it within `awaiting_subadmin_id` block.
        // It's safer to just do a direct string replace for the specific block.
        return match; 
    });
    // Wait, let's just do it manually.
    const addSubBlock = /case 'awaiting_subadmin_id':([\s\S]*?)break;/;
    code = code.replace(addSubBlock, (match) => {
        let res = match.replace(/await this\.sendAdminHome\(chatId, lang\);/, `await dbHelper.setAdminState(chatId, { action: 'admin_manage_admins_menu' });
          const keyboard = [
            [{ text: require('./src/localization').t(lang, 'BTN_ADD_SUBADMIN') }],
            [{ text: require('./src/localization').t(lang, 'BTN_VIEW_SUBADMINS') }],
            [{ text: require('./src/localization').t(lang, 'BTN_REMOVE_SUBADMIN') }],
            [{ text: require('./src/localization').t(lang, 'BTN_BACK') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'BTN_MANAGE_ADMINS') + ':', reply_markup: { keyboard, resize_keyboard: true } });`);
        return res;
    });
}

// 6. Handle del_sub_ in handleCallbackQuery
const delSubReplacement = `} else if (data.startsWith('del_sub_')) {
      const subId = data.replace('del_sub_', '');
      await dbHelper.setAdminState(chatId, { action: 'awaiting_del_sub_confirm', subId });
      const confirmKb = { keyboard: [[{ text: require('./src/localization').t(lang, 'BTN_YES_ICON') }, { text: require('./src/localization').t(lang, 'BTN_NO_ICON') }]], resize_keyboard: true };
      await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_ARE_YOU_SURE'), reply_markup: confirmKb });
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    }
    else if (data.startsWith('del_ann_')) {`;
if (!code.includes(`data.startsWith('del_sub_')`)) {
    code = code.replace(/else if \(data\.startsWith\('del_ann_'\)\) \{/, delSubReplacement);
}

// 7. Handle awaiting_del_sub_confirm in switch
const caseDelSubConfirm = `case 'awaiting_del_sub_confirm':
        if (text === require('./src/localization').t(lang, 'BTN_YES_ICON')) {
           const faculty = await dbHelper.getFacultyById(this.facultyId);
           const adminIds = faculty.admin_chat_id ? faculty.admin_chat_id.split(',').map(s => s.trim()).filter(Boolean) : [];
           if (state.subId !== adminIds[0] && adminIds.includes(state.subId)) {
               const newIds = adminIds.filter(id => id !== state.subId).join(',');
               await dbHelper.runQuery('UPDATE faculties SET admin_chat_id = $1 WHERE id = $2', [newIds, this.facultyId]);
               await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_SUBADMIN_REMOVED') });
           }
        }
        await dbHelper.setAdminState(chatId, { action: 'admin_manage_admins_menu' });
        {
          const keyboard = [
            [{ text: require('./src/localization').t(lang, 'BTN_ADD_SUBADMIN') }],
            [{ text: require('./src/localization').t(lang, 'BTN_VIEW_SUBADMINS') }],
            [{ text: require('./src/localization').t(lang, 'BTN_REMOVE_SUBADMIN') }],
            [{ text: require('./src/localization').t(lang, 'BTN_BACK') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'BTN_MANAGE_ADMINS') + ':', reply_markup: { keyboard, resize_keyboard: true } });
        }
        break;
      case 'awaiting_del_ann_confirm':`;
if (!code.includes("case 'awaiting_del_sub_confirm':")) {
    code = code.replace(/case 'awaiting_del_ann_confirm':/, caseDelSubConfirm);
}

// Write the file
fs.writeFileSync('bot-manager.js', code);
console.log('Done patching bot-manager.js');

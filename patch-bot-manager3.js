const fs = require('fs');

let code = fs.readFileSync('bot-manager.js', 'utf8');

// 1. Update sendAdminHome
code = code.replace(
  /\{\s*text:\s*lang\s*===\s*'ar'\s*\?\s*'👥 المشرفين'\s*:\s*'👥 Administrators'\s*\}/g,
  `{ text: require('./src/localization').t(lang, 'BTN_MANAGE_ADMINS') }`
);

if (!code.includes(`{ text: require('./src/localization').t(lang, 'BTN_MONITORING') }`)) {
  code = code.replace(
    /(\{\s*text:\s*require\('\.\/src\/localization'\)\.t\(lang,\s*'BTN_MANAGE_ADMINS'\)\s*\}\s*\]\s*;)/g,
    `$1\n      keyboard.push([{ text: require('./src/localization').t(lang, 'BTN_MONITORING') }]);`
  );
  // Alternative replacement if the array format doesn't match exactly
  code = code.replace(
    /(\{\s*text:\s*require\('\.\/src\/localization'\)\.t\(lang,\s*'BTN_MANAGE_ADMINS'\)\s*\}\s*\]\s*\);)/g,
    `$1\n      keyboard.push([{ text: require('./src/localization').t(lang, 'BTN_MONITORING') }]);`
  );
}

// 2. Update getAdminActionFromText
const adminActionsRegex = /if \(t === '🔙 رجوع' \|\| t === '🔙 Back'\) return 'back';/;
const newActions = `
    const loc = require('./src/localization').t;
    if (t === loc('ar', 'BTN_MANAGE_ADMINS') || t === loc('en', 'BTN_MANAGE_ADMINS')) return 'manage_admins';
    if (t === loc('ar', 'BTN_MONITORING') || t === loc('en', 'BTN_MONITORING')) return 'admin_monitoring';
    if (t === loc('ar', 'BTN_ADD_SUBADMIN') || t === loc('en', 'BTN_ADD_SUBADMIN')) return 'add_subadmin';
    if (t === loc('ar', 'BTN_VIEW_SUBADMINS') || t === loc('en', 'BTN_VIEW_SUBADMINS')) return 'view_subadmins';
    if (t === loc('ar', 'BTN_REMOVE_SUBADMIN') || t === loc('en', 'BTN_REMOVE_SUBADMIN')) return 'remove_subadmin';
    if (t === loc('ar', 'BTN_ENABLE_MONITORING') || t === loc('en', 'BTN_ENABLE_MONITORING')) return 'enable_monitoring';
    if (t === loc('ar', 'BTN_DISABLE_MONITORING') || t === loc('en', 'BTN_DISABLE_MONITORING')) return 'disable_monitoring';
`;
if (!code.includes("return 'manage_admins';")) {
  code = code.replace(adminActionsRegex, `${newActions}\n    $&`);
}
// Remove old `add_subadmin` mapping if present
code = code.replace(/if \(t === '👥 المشرفين' \|\| t === '👥 Administrators'\) return 'add_subadmin';\n/g, '');


// 3. Update handleAdminStateMessage to inject the new admin management logic
const handleAdminStateRegex = /\} else if \(actionId === 'add_subadmin'\) \{([\s\S]*?)\} else if \(actionId === 'view_subadmins'\) \{/;
if (!code.includes(`actionId === 'manage_admins'`)) {
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
      } else if (actionId === 'enable_monitoring' || actionId === 'disable_monitoring') {
        const isEnable = actionId === 'enable_monitoring';
        await dbHelper.updateMonitoringEnabled(this.facultyId, isEnable);
        await this.apiCall('sendMessage', { chat_id: chatId, text: isEnable ? require('./src/localization').t(lang, 'MSG_MONITORING_ENABLED') : require('./src/localization').t(lang, 'MSG_MONITORING_DISABLED') });
        await this.sendAdminHome(chatId, lang);
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
           const secUser = await dbHelper.getBotUser(this.facultyId, 'telegram', secId);
           msgText += \`ID: <code>\${secId}</code>\\n\`;
           if (secUser) {
              msgText += \`Name: \${secUser.username || 'Unknown'}\\nLanguage: \${secUser.language || 'N/A'}\\nRegistered: \${secUser.created_at || 'Unknown'}\\n\\n\`;
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
      } else if (actionId === 'add_subadmin') {`;

  code = code.replace(/\} else if \(actionId === 'add_subadmin'\) \{/, replacement);
}

// 4. Update the add sub admin cancel button mapping so it maps back to manage_admins
const addSubadminRegex = /case 'awaiting_subadmin_id':([\s\S]*?)break;/;
if (code.includes('awaiting_subadmin_id')) {
    code = code.replace(addSubadminRegex, (match) => {
        // We handle cancel at global level if 'Cancel Operation' is used.
        // Wait, the global cancel goes to `admin_home`. We want it to go to `manage_admins`.
        // To fix this, we can intercept text inside the case 'awaiting_subadmin_id':
        let inner = match;
        const cancelIntercept = `
        if (text === require('./src/localization').t(lang, 'BTN_CANCEL_OP')) {
          await dbHelper.setAdminState(chatId, { action: 'admin_manage_admins_menu' });
          const keyboard = [
            [{ text: require('./src/localization').t(lang, 'BTN_ADD_SUBADMIN') }],
            [{ text: require('./src/localization').t(lang, 'BTN_VIEW_SUBADMINS') }],
            [{ text: require('./src/localization').t(lang, 'BTN_REMOVE_SUBADMIN') }],
            [{ text: require('./src/localization').t(lang, 'BTN_BACK') }]
          ];
          await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_ACTION_CANCELLED'), reply_markup: { keyboard, resize_keyboard: true } });
          return;
        }\n`;
        if (!inner.includes('BTN_CANCEL_OP')) {
            inner = inner.replace(/case 'awaiting_subadmin_id':\s*/, `case 'awaiting_subadmin_id':${cancelIntercept}`);
        }
        return inner;
    });
}

// 5. Add handling for 'del_sub_' in handleCallbackQuery
const delSubRegex = /else if \(data\.startsWith\('del_ann_'\)\) \{/;
if (!code.includes(`data.startsWith('del_sub_')`)) {
    const delSubReplacement = `else if (data.startsWith('del_sub_')) {
      const subId = data.replace('del_sub_', '');
      await dbHelper.setAdminState(chatId, { action: 'awaiting_del_sub_confirm', subId });
      const confirmKb = { keyboard: [[{ text: require('./src/localization').t(lang, 'BTN_YES_ICON') }, { text: require('./src/localization').t(lang, 'BTN_NO_ICON') }]], resize_keyboard: true };
      await this.apiCall('sendMessage', { chat_id: chatId, text: require('./src/localization').t(lang, 'MSG_ARE_YOU_SURE'), reply_markup: confirmKb });
      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    }\n    else if (data.startsWith('del_ann_')) {`;
    code = code.replace(delSubRegex, delSubReplacement);
}

// 6. Handle 'awaiting_del_sub_confirm' in handleAdminStateMessage
const awaitingDelSubRegex = /case 'awaiting_del_ann_confirm':/;
if (!code.includes(`case 'awaiting_del_sub_confirm':`)) {
    const caseReplacement = `case 'awaiting_del_sub_confirm':
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
    code = code.replace(awaitingDelSubRegex, caseReplacement);
}

// 7. Prevent global cancel from catching `BTN_CANCEL_OP` if we are in `awaiting_subadmin_id`.
// Wait, the global cancel is at the start of handleAdminStateMessage.
// So if it matches 'Cancel Operation', it intercepts it immediately!
// Let's modify global cancel to skip if `state.action === 'awaiting_subadmin_id'`
const globalCancelRegex = /if \(actionId === 'cancel' \|\| text === '\/cancel' \|\| text\.includes\('إلغاء الأمر'\) \|\| text\.includes\('الغاء الامر'\) \|\| text\.includes\('Cancel Operation'\)\) \{/;
if (!code.includes(`&& state.action !== 'awaiting_subadmin_id'`)) {
    code = code.replace(globalCancelRegex, `if ((actionId === 'cancel' || text === '/cancel' || text.includes('إلغاء الأمر') || text.includes('الغاء الامر') || text.includes('Cancel Operation')) && state.action !== 'awaiting_subadmin_id') {`);
}

// 8. Fix global Back button so it doesn't intercept inner menus? The prompt says "All Back buttons must return to the previous admin menu."
// Currently `actionId === 'back'` just sends to `admin_home`.
// We can intercept 'back' action specifically in `admin_manage_admins_menu` and `admin_monitoring_menu`.
const globalBackRegex = /if \(actionId === 'back'\) \{([\s\S]*?)return;\s*\}/;
if (code.includes('if (actionId === \'back\')')) {
    code = code.replace(globalBackRegex, (match) => {
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

fs.writeFileSync('bot-manager.js', code);
console.log('bot-manager.js patched successfully!');

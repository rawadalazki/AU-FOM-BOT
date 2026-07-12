const fs = require('fs');

let content = fs.readFileSync('bot-manager.js', 'utf8');

// Patch handleMessage
if (!content.includes(`const { logUserOperation } = require('./error-reporter');`)) {
  const msgTarget = `  async handleMessage(message) {
    const chatId = message.chat.id.toString();
    const text = message.text || '';`;
  const msgRepl = `  async handleMessage(message) {
    const chatId = message.chat.id.toString();
    const text = message.text || '';
    try {
      const { logUserOperation } = require('./error-reporter');
      const dbHelper = require('./database');
      const adminStateRow = await dbHelper.pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [chatId]);
      const adminState = adminStateRow.rows.length > 0 ? adminStateRow.rows[0].state : null;
      logUserOperation(chatId, {
        type: 'MESSAGE',
        op: text.substring(0, 50),
        admin_state: adminState,
        message_text: text
      });
    } catch(e) {}`;
  content = content.replace(msgTarget, msgRepl);

  // Patch handleCallbackQuery
  const cbTarget = `  async handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id.toString();`;
  const cbRepl = `  async handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id.toString();
    try {
      const { logUserOperation } = require('./error-reporter');
      const dbHelper = require('./database');
      const adminStateRow = await dbHelper.pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [chatId]);
      const adminState = adminStateRow.rows.length > 0 ? adminStateRow.rows[0].state : null;
      logUserOperation(chatId, {
        type: 'CALLBACK',
        op: data,
        admin_state: adminState,
        callback_data: data
      });
    } catch(e) {}`;
  content = content.replace(cbTarget, cbRepl);
}

// Patch logError to include deeply expanded context
const logErrorTarget = /logError\(msg, err, obj = \{\}\) \{([\s\S]*?)Function_Name: 'TelegramBotService.logError',\s*\.\.\.obj\s*\}\);\s*\}/;

const logErrorRepl = `logError(msg, err, obj = {}) {
    logger.error({ reqId: this.reqId, facultyId: this.facultyId, err, ...obj }, msg);
    const { reportRuntimeError, getUserHistory } = require('./error-reporter');
    
    // We do a best-effort async context extraction to not block the caller
    (async () => {
      try {
        const dbHelper = require('./database');
        let facultyName = '';
        let telegramFullName = obj.Telegram_Full_Name || '';
        let telegramUsername = obj.Telegram_Username || '';
        let adminState = null;
        let botUsername = this.username || '';
        let currentMenu = obj.Current_Menu || '';
        let currentButton = obj.Current_Button || '';
        
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        if (faculty) facultyName = faculty.name_en || faculty.name_ar;

        let history = [];
        if (obj.chat_id || obj.Telegram_User_ID) {
          const cid = obj.chat_id || obj.Telegram_User_ID;
          history = getUserHistory(cid.toString());
          const stateRow = await dbHelper.pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [cid.toString()]);
          if (stateRow.rows.length > 0) adminState = stateRow.rows[0].state;
          
          const uRow = await dbHelper.pool.query('SELECT * FROM bot_users WHERE chat_id = $1', [cid.toString()]);
          if (uRow.rows.length > 0) {
             telegramFullName = \`\${uRow.rows[0].first_name} \${uRow.rows[0].last_name || ''}\`.trim();
             telegramUsername = uRow.rows[0].username || '';
             if (uRow.rows[0].current_menu_id) {
                const mRow = await dbHelper.pool.query('SELECT title_en FROM menus WHERE id = $1', [uRow.rows[0].current_menu_id]);
                if (mRow.rows.length > 0) currentMenu = mRow.rows[0].title_en;
             }
          }
        }

        reportRuntimeError({
          Severity: obj.Severity,
          Faculty_ID: this.facultyId,
          Faculty_Name: facultyName,
          Bot_ID: this.token ? this.token.split(':')[0] : '',
          Bot_Username: botUsername,
          Request_ID: this.reqId,
          Error_Type: err ? err.name : 'BotError',
          Error_Message: err ? (err.message || String(err)) : 'Unknown Error',
          Stack_Trace: err ? err.stack : '',
          Operation: msg,
          File_Name: 'bot-manager.js',
          Function_Name: 'TelegramBotService.logError',
          Telegram_User_ID: obj.chat_id || obj.Telegram_User_ID,
          Telegram_Full_Name: telegramFullName,
          Telegram_Username: telegramUsername,
          Current_Menu: currentMenu,
          Current_Button: currentButton,
          Admin_State: adminState,
          Message_ID: obj.message_id,
          Callback_Query_ID: obj.callback_query_id,
          Update_ID: obj.update_id,
          Last_10_Operations: history,
          Telegram_Update: obj.update,
          HTTP_Request: obj.request,
          API_Payload: obj.api_payload,
          ...obj
        });
      } catch (innerErr) {
        // Safe fallback
        reportRuntimeError({
          Severity: 'ERROR',
          Faculty_ID: this.facultyId,
          Request_ID: this.reqId,
          Error_Type: err ? err.name : 'BotError',
          Error_Message: err ? (err.message || String(err)) : 'Unknown Error',
          Stack_Trace: err ? err.stack : '',
          Operation: msg,
          File_Name: 'bot-manager.js',
          Function_Name: 'TelegramBotService.logError',
          ...obj
        });
      }
    })();
  }`;

content = content.replace(logErrorTarget, logErrorRepl);

fs.writeFileSync('bot-manager.js', content);
console.log('bot-manager.js patched');

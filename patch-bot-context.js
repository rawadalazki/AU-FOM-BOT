const fs = require('fs');
const file = 'bot-manager.js';
let content = fs.readFileSync(file, 'utf8');

const target = `
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

        reportRuntimeError({`;

const replacement = `
        const faculty = await dbHelper.getFacultyById(this.facultyId);
        if (faculty) facultyName = faculty.name_en || faculty.name_ar;

        let history = [];
        let menuPath = '';
        let parentMenu = '';
        let currentMenuId = '';
        let replyType = '';
        let callbackData = '';
        let msgText = '';

        if (obj.update) {
          if (obj.update.message && obj.update.message.text) msgText = obj.update.message.text;
          if (obj.update.callback_query && obj.update.callback_query.data) callbackData = obj.update.callback_query.data;
          
          if (obj.update.message && obj.update.message.from) {
             telegramFullName = \`\${obj.update.message.from.first_name || ''} \${obj.update.message.from.last_name || ''}\`.trim();
             telegramUsername = obj.update.message.from.username || '';
          } else if (obj.update.callback_query && obj.update.callback_query.from) {
             telegramFullName = \`\${obj.update.callback_query.from.first_name || ''} \${obj.update.callback_query.from.last_name || ''}\`.trim();
             telegramUsername = obj.update.callback_query.from.username || '';
          }
        }

        if (obj.chat_id || obj.Telegram_User_ID) {
          const cid = obj.chat_id || obj.Telegram_User_ID;
          history = getUserHistory(cid.toString());
          const stateRow = await dbHelper.pool.query('SELECT state FROM admin_states WHERE chat_id = $1', [cid.toString()]);
          if (stateRow.rows.length > 0) adminState = stateRow.rows[0].state;
          
          const uRow = await dbHelper.pool.query('SELECT * FROM bot_users WHERE chat_id = $1', [cid.toString()]);
          if (uRow.rows.length > 0) {
             if (!telegramFullName) telegramFullName = \`\${uRow.rows[0].first_name} \${uRow.rows[0].last_name || ''}\`.trim();
             if (!telegramUsername) telegramUsername = uRow.rows[0].username || '';
             
             if (uRow.rows[0].current_menu_id) {
                currentMenuId = uRow.rows[0].current_menu_id;
                let currMenuId = currentMenuId;
                let pathArr = [];
                let parentId = null;
                
                let limit = 20; // safety
                while (currMenuId && limit-- > 0) {
                  const mRow = await dbHelper.pool.query('SELECT * FROM menus WHERE id = $1', [currMenuId]);
                  if (mRow.rows.length > 0) {
                    const m = mRow.rows[0];
                    const mTitle = m.title_en || m.title_ar || 'Unknown';
                    pathArr.unshift(mTitle);
                    
                    if (currMenuId === currentMenuId) {
                      currentMenu = mTitle;
                      parentId = m.parent_id;
                      replyType = m.reply_type || '';
                    }
                    currMenuId = m.parent_id;
                  } else {
                    pathArr.unshift('Unknown (deleted)');
                    break;
                  }
                }
                menuPath = pathArr.join(' → ');
                
                if (parentId) {
                   const pRow = await dbHelper.pool.query('SELECT title_en, title_ar FROM menus WHERE id = $1', [parentId]);
                   if (pRow.rows.length > 0) {
                     parentMenu = pRow.rows[0].title_en || pRow.rows[0].title_ar || 'Unknown';
                   }
                }
             }
          }
        }

        reportRuntimeError({`;

content = content.replace(target, replacement);

const target2 = `
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
`;

const replacement2 = `
          Telegram_User_ID: obj.chat_id || obj.Telegram_User_ID,
          Telegram_Full_Name: telegramFullName,
          Telegram_Username: telegramUsername,
          Current_Menu_ID: currentMenuId,
          Current_Menu: currentMenu,
          Parent_Menu: parentMenu,
          Menu_Path: menuPath,
          Reply_Type: replyType,
          Current_Button: currentButton,
          Admin_State: adminState,
          Message_Text: msgText,
          Callback_Data: callbackData,
          Message_ID: obj.message_id,
          Update_ID: obj.update_id,
          Last_10_Operations: history,
          Telegram_Update: obj.update,
          HTTP_Request: obj.request,
          API_Payload: obj.api_payload,
          ...obj
`;
content = content.replace(target2, replacement2);

fs.writeFileSync(file, content);
console.log('bot-manager.js patched');

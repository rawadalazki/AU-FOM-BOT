const crypto = require('crypto');
const dbHelper = require('./database');
const os = require('os');

// Ensure table exists on load
(async function initReporterDB() {
  try {
    await dbHelper.runQuery(`
      CREATE TABLE IF NOT EXISTS runtime_error_logs (
        id SERIAL PRIMARY KEY,
        severity VARCHAR(20) DEFAULT 'ERROR',
        faculty_id INTEGER,
        bot_id VARCHAR(50),
        user_telegram_id VARCHAR(50),
        operation VARCHAR(100),
        error_signature VARCHAR(255),
        error_message TEXT,
        stack_trace TEXT,
        full_context JSONB,
        first_occurrence TIMESTAMP DEFAULT NOW(),
        last_occurrence TIMESTAMP DEFAULT NOW(),
        occurrence_count INTEGER DEFAULT 1,
        resolved BOOLEAN DEFAULT FALSE,
        resolved_by VARCHAR(100),
        resolved_at TIMESTAMP,
        notes TEXT,
        notification_sent BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
  } catch (e) {
    console.error('Failed to initialize runtime_error_logs table', e);
  }
})();

// In-memory tracker for active timeouts to send notifications after 60s
const activeTimers = new Map();

// In-memory circular history for users
const userHistoryMap = new Map();

function logUserOperation(chatId, operationObj) {
  if (!chatId) return;
  if (!userHistoryMap.has(chatId)) {
    userHistoryMap.set(chatId, []);
  }
  const history = userHistoryMap.get(chatId);
  history.push({
    timestamp: new Date().toISOString(),
    ...operationObj
  });
  if (history.length > 10) {
    history.shift();
  }
}

function getUserHistory(chatId) {
  if (!chatId) return [];
  return userHistoryMap.get(chatId) || [];
}

function createSignature(context) {
  const parts = [
    context.Function_Name || '',
    context.Operation || '',
    context.Error_Type || '',
    context.Error_Message || ''
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function escapeMarkdown(text) {
  if (!text) return '';
  // Telegram Markdown needs these escaped
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function determineSeverity(ctx) {
  if (ctx.Severity) return ctx.Severity;
  
  const msg = (ctx.Error_Message || '').toLowerCase();
  const type = (ctx.Error_Type || '').toLowerCase();
  
  if (type === 'uncaughtexception' || type === 'unhandledrejection' || msg.includes('out of memory') || msg.includes('heap') || msg.includes('startup failure') || msg.includes('database unavailable') || msg.includes('pool corruption')) {
    return 'CRITICAL';
  }
  if (msg.includes('timeout') || msg.includes('translation') || msg.includes('optional file')) {
    return 'WARNING';
  }
  if (msg.includes('mistake') || msg.includes('validation')) {
    return 'INFO';
  }
  
  return 'ERROR';
}

function appendSystemMetrics(ctx) {
  const mem = process.memoryUsage();
  ctx.Server_Info = {
    Node_Version: process.version,
    Memory_RSS: Math.round(mem.rss / 1024 / 1024) + ' MB',
    Memory_Heap_Used: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
    Memory_Heap_Total: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
    Memory_External: Math.round(mem.external / 1024 / 1024) + ' MB',
    Memory_ArrayBuffers: Math.round(mem.arrayBuffers / 1024 / 1024) + ' MB',
    Process_Uptime: Math.round(process.uptime()) + 's',
    Timestamp: new Date().toISOString(),
    NODE_ENV: process.env.NODE_ENV || 'development',
    Render_Service: process.env.RENDER_SERVICE_NAME || 'N/A',
    Render_Region: process.env.RENDER_REGION || 'N/A',
    Commit_SHA: process.env.RENDER_GIT_COMMIT || 'N/A'
  };

  try {
    if (dbHelper.pool && typeof dbHelper.pool.totalCount === 'number') {
      ctx.Server_Info.DB_Total_Clients = dbHelper.pool.totalCount;
      ctx.Server_Info.DB_Idle_Clients = dbHelper.pool.idleCount;
      ctx.Server_Info.DB_Waiting_Clients = dbHelper.pool.waitingCount;
    }
  } catch (e) {
    // Ignore pool metric errors
  }
}

/**
 * Main entry point for reporting any runtime error
 */
async function reportRuntimeError(errorContext) {
  try {
    appendSystemMetrics(errorContext);
    
    // Parse stack trace for source/line
    if (errorContext.Stack_Trace) {
      const match = errorContext.Stack_Trace.match(/at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)/) || errorContext.Stack_Trace.match(/at\s+(.*?):(\d+):(\d+)/);
      if (match) {
        errorContext.Source_File = match[2] || match[1];
        errorContext.Line_Number = match[3] || match[2];
        if (!errorContext.Function_Name) {
           errorContext.Function_Name = match.length > 4 ? match[1] : 'anonymous';
        }
      }
    }

    const signature = createSignature(errorContext);
    const severity = determineSeverity(errorContext);
    errorContext.Severity = severity;

    // Find active unnotified log for this signature
    const { rows } = await dbHelper.runQuery(`
      SELECT * FROM runtime_error_logs 
      WHERE error_signature = $1 AND notification_sent = false
    `, [signature]);

    let logId;
    let isFirst = false;

    if (rows.length > 0) {
      logId = rows[0].id;
      const ctx = rows[0].full_context || {};
      const users = ctx.Affected_Users || [];
      if (errorContext.Telegram_User_ID && !users.includes(errorContext.Telegram_User_ID)) {
        users.push(errorContext.Telegram_User_ID);
      }
      ctx.Affected_Users = users;
      // Overwrite the most recent context
      
      await dbHelper.runQuery(`
        UPDATE runtime_error_logs 
        SET occurrence_count = occurrence_count + 1, 
            last_occurrence = NOW(),
            full_context = $1
        WHERE id = $2
      `, [JSON.stringify(errorContext), logId]);
    } else {
      isFirst = true;
      const fullContext = { ...errorContext, Affected_Users: errorContext.Telegram_User_ID ? [errorContext.Telegram_User_ID] : [] };
      const res = await dbHelper.runQuery(`
        INSERT INTO runtime_error_logs (
          severity, faculty_id, bot_id, user_telegram_id, operation, error_signature, error_message, stack_trace, full_context, first_occurrence, last_occurrence, occurrence_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), 1) RETURNING id
      `, [
        severity, 
        errorContext.Faculty_ID || null, 
        errorContext.Bot_ID || null, 
        errorContext.Telegram_User_ID || null,
        errorContext.Operation || 'Unknown',
        signature,
        errorContext.Error_Message || 'Unknown',
        errorContext.Stack_Trace || '',
        JSON.stringify(fullContext)
      ]);
      logId = res.rows[0].id;
    }

    if (isFirst && !activeTimers.has(logId)) {
      const timer = setTimeout(() => sendAggregatedReport(logId), 60000);
      activeTimers.set(logId, timer);
    }
  } catch (e) {
    console.error('CRITICAL: Failed to log runtime error to DB', e);
  }
}

async function sendAggregatedReport(logId) {
  activeTimers.delete(logId);
  try {
    const { rows } = await dbHelper.runQuery(`
      UPDATE runtime_error_logs 
      SET notification_sent = true 
      WHERE id = $1 AND notification_sent = false
      RETURNING *
    `, [logId]);

    if (rows.length === 0) return; // Already sent or deleted
    const log = rows[0];
    const ctx = log.full_context;

    if (!log.faculty_id) {
      console.error('Cannot route error notification: No faculty_id attached to error', log);
      return;
    }

    const faculty = await dbHelper.getFacultyById(log.faculty_id);
    if (!faculty || !faculty.admin_chat_id) {
      console.error('Cannot route error notification: Faculty not found or has no admin_chat_id', log.faculty_id);
      return;
    }

    const botManager = require('./bot-manager');
    const svc = await botManager.getBotService(faculty.id, 'error-reporter');
    if (!svc) {
      console.error('Cannot route error notification: BotService not initialized for faculty', faculty.id);
      return;
    }

    const histStr = (ctx.Last_10_Operations || []).map((o, i) => `[${i+1}] ${o.type} - ${o.op}`).join('\n');
    const stackSnippet = (log.stack_trace || '').substring(0, 300) + '...';

    // Summarize heavy attachments
    const hasTgUpdate = ctx.Telegram_Update ? 'Yes (See Dashboard)' : 'No';
    const hasHttpReq = ctx.HTTP_Request ? 'Yes (See Dashboard)' : 'No';

    const msg = `🚨 *Runtime Error*\n\n` +
      `*Severity:* ${escapeMarkdown(log.severity)}\n` +
      `*Faculty:* ${escapeMarkdown(ctx.Faculty_Name || faculty.name_en || log.faculty_id)}\n` +
      `*Bot:* ${escapeMarkdown(ctx.Bot_Username || log.bot_id || 'Unknown')}\n` +
      `*Error:* ${escapeMarkdown(log.error_message)}\n` +
      `*Occurrences:* ${log.occurrence_count}\n\n` +
      `👤 *User*\n` +
      `ID: ${escapeMarkdown(ctx.Telegram_User_ID || log.user_telegram_id || '')}\n` +
      `Username: ${escapeMarkdown(ctx.Telegram_Username || '')}\n` +
      `Name: ${escapeMarkdown(ctx.Telegram_Full_Name || '')}\n\n` +
      `📍 *Location*\n` +
      `Menu ID: ${escapeMarkdown(ctx.Current_Menu_ID || '')}\n` +
      `Menu: ${escapeMarkdown(ctx.Current_Menu || 'N/A')}\n` +
      `Parent: ${escapeMarkdown(ctx.Parent_Menu || 'N/A')}\n` +
      `Menu Path: ${escapeMarkdown(ctx.Menu_Path || 'N/A')}\n\n` +
      `⚙️ *Operation*\n` +
      `${escapeMarkdown(log.operation)}\n\n` +
      `📦 *Update*\n` +
      (ctx.Callback_Data ? `Callback Data: ${escapeMarkdown(ctx.Callback_Data)}\n` : '') +
      (ctx.Message_Text ? `Message Text: ${escapeMarkdown(ctx.Message_Text)}\n` : '') +
      `\n*Server Metrics:*\nNode: ${escapeMarkdown(ctx.Server_Info?.Node_Version)} | RSS: ${escapeMarkdown(ctx.Server_Info?.Memory_RSS)} | DB Idle: ${ctx.Server_Info?.DB_Idle_Clients || 'N/A'}\n\n` +
      `*Attachments:* TG Update: ${hasTgUpdate} | HTTP: ${hasHttpReq}\n\n` +
      `*Recent History:*\n\`${escapeMarkdown(histStr.substring(0, 500))}\`\n\n` +
      `*Stack:*\n\`${escapeMarkdown(stackSnippet)}\``;

    const adminChats = faculty.admin_chat_id.split(',').map(s => s.trim());
    for (const adminChat of adminChats) {
      await svc.apiCall('sendMessage', { chat_id: adminChat, text: msg, parse_mode: 'Markdown' });
    }
  } catch (e) {
    console.error('Failed to send Telegram error report', e);
  }
}

// Recovers any unsent error notifications due to app restart
async function recoverUnsentReports() {
  try {
    const { rows } = await dbHelper.runQuery(`
      SELECT id FROM runtime_error_logs 
      WHERE notification_sent = false 
      AND last_occurrence < NOW() - INTERVAL '1 minute'
    `);
    for (const row of rows) {
      await sendAggregatedReport(row.id);
    }
  } catch(e) {
    console.error('Failed to recover unsent error reports', e);
  }
}

async function flushPendingNotifications() {
  const logIds = Array.from(activeTimers.keys());
  for (const logId of logIds) {
    clearTimeout(activeTimers.get(logId));
    await sendAggregatedReport(logId);
  }
}

module.exports = { reportRuntimeError, recoverUnsentReports, flushPendingNotifications, logUserOperation, getUserHistory };

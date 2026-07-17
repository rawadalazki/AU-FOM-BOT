const fs = require('fs');
let code = fs.readFileSync('bot-manager.js', 'utf8');
const extract = JSON.parse(fs.readFileSync('extract.json', 'utf8'));

// Chunk 1: Unpin
code = code.replace(
  extract.chunk1,
  "      await dbHelper.runQuery('UPDATE announcements SET is_pinned = FALSE WHERE id = $1', [annId]);\n      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: lang === 'ar' ? 'تم إلغاء تثبيت الإعلان لدى الجميع.' : 'Announcement unpinned.', show_alert: true });\n      await this.apiCall('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});"
);

// Chunk 2: Stats
code = code.replace(
  extract.chunk2,
  "        const statsAr = `\uD83D\uDCCA **إحصائيات البوت التفصيلية:**\\n\\n` +\n" +
  "          `\uD83D\uDC65 **المشتركون**\\n` +\n" +
  "          `- إجمالي المشتركين: ${totalUsers}\\n` +\n" +
  "          `- المشتركون الجدد (أسبوع): ${weeklySubscribers}\\n` +\n" +
  "          `- المشتركون الجدد (شهر): ${monthlySubscribers}\\n\\n` +\n" +
  "          `\uD83D\uDCC8 **النشاط**\\n` +\n" +
  "          `- نشط اليوم: ${dailyActive}\\n` +\n" +
  "          `- نشط هذا الأسبوع: ${weeklyActive}\\n` +\n" +
  "          `- نشط هذا الشهر: ${monthlyActive}\\n\\n` +\n" +
  "          `\u26A1 **الوصول والأداء**\\n` +\n" +
  "          `- نسبة الوصول (شهرياً): ${reachPercentage}%\\n` +\n" +
  "          `- إجمالي الطلبات/النقرات: ${totalRequests}\\n` +\n" +
  "          `- متوسط الاستجابة (ميلي ثانية): ${avgLatency}ms\\n\\n` +\n" +
  "          `\uD83D\uDCC1 **المحتوى**\\n` +\n" +
  "          `- عدد الأزرار المتاحة: ${totalButtons}\\n` +\n" +
  "          `- عدد الملفات المرفوعة: ${totalFiles}\\n` +\n" +
  "          `- الزر الأكثر طلباً: ${topButtonStr}\\n\\n` +\n" +
  "          `\uD83D\uDEAB **الحظر**\\n` +\n" +
  "          `- عدد من قام بحظر البوت: ${blockedUsers}`;\n" +
  "          "
);

// Chunk 3: Config text
code = code.replace(
  extract.chunk3,
  "          const cfgText = (lang === 'ar' ? 'الإعدادات\\n\\nالمراقبة: ' : 'Settings\\n\\nMonitoring: ') + monStatus;\n          const cfgKb = ["
);

// Chunk 6: Skip
code = code.replace(
  extract.chunk6,
  "        if (text !== '/skip' && text !== t(lang, 'MSG_ADMIN_35')) {\n          doc = this.extractTelegramAttachment(message);"
);

// Chunk 7: Pin
code = code.replace(
  extract.chunk7,
  "        state.isPinned = text === t(lang, 'MSG_ADMIN_38');\n        await this.handleAdminAnnouncementBroadcast(chatId, state, lang);"
);

// Chunk 8: Broadcast txt
code = code.replace(
  extract.chunk8,
  "               const txt = `\uD83D\uDCE2 *${msgTitle}*\\n\\n${msgContent}\\n\\n${updatedAnn.is_pinned ? '\uD83D\uDCCC (Pinned)' : ''}`;\n               await this.apiCall('editMessageText', { chat_id: msg.chat_id, message_id: msg.message_id, text: txt, parse_mode: 'Markdown' });"
);

fs.writeFileSync('bot-manager.js', code, 'utf8');
console.log("Replaced successfully!");

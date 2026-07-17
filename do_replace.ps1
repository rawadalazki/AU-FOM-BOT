$ErrorActionPreference = 'Stop'

$botPath = "bot-manager.js"
$jsonPath = "extract.json"

$content = [System.IO.File]::ReadAllText($botPath, [System.Text.Encoding]::UTF8)
$extract = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json

# Chunk 1
$repl1 = '      await dbHelper.runQuery(''UPDATE announcements SET is_pinned = FALSE WHERE id = $1'', [annId]);' + "`n" + '      await this.apiCall(''answerCallbackQuery'', { callback_query_id: callbackQuery.id, text: lang === ''ar'' ? ''تم إلغاء تثبيت الإعلان لدى الجميع.'' : ''Announcement unpinned.'', show_alert: true });' + "`n" + '      await this.apiCall(''deleteMessage'', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(() => {});'
$content = $content.Replace($extract.chunk1, $repl1)

# Chunk 2
$repl2 = '        const statsAr = `📊 **إحصائيات البوت التفصيلية:**\n\n` +' + "`n" +
'          `👥 **المشتركون**\n` +' + "`n" +
'          `- إجمالي المشتركين: ${totalUsers}\n` +' + "`n" +
'          `- المشتركون الجدد (أسبوع): ${weeklySubscribers}\n` +' + "`n" +
'          `- المشتركون الجدد (شهر): ${monthlySubscribers}\n\n` +' + "`n" +
'          `📈 **النشاط**\n` +' + "`n" +
'          `- نشط اليوم: ${dailyActive}\n` +' + "`n" +
'          `- نشط هذا الأسبوع: ${weeklyActive}\n` +' + "`n" +
'          `- نشط هذا الشهر: ${monthlyActive}\n\n` +' + "`n" +
'          `⚡ **الوصول والأداء**\n` +' + "`n" +
'          `- نسبة الوصول (شهرياً): ${reachPercentage}%\n` +' + "`n" +
'          `- إجمالي الطلبات/النقرات: ${totalRequests}\n` +' + "`n" +
'          `- متوسط الاستجابة (ميلي ثانية): ${avgLatency}ms\n\n` +' + "`n" +
'          `📁 **المحتوى**\n` +' + "`n" +
'          `- عدد الأزرار المتاحة: ${totalButtons}\n` +' + "`n" +
'          `- عدد الملفات المرفوعة: ${totalFiles}\n` +' + "`n" +
'          `- الزر الأكثر طلباً: ${topButtonStr}\n\n` +' + "`n" +
'          `🚫 **الحظر**\n` +' + "`n" +
'          `- عدد من قام بحظر البوت: ${blockedUsers}`;' + "`n          "
$content = $content.Replace($extract.chunk2, $repl2)

# Chunk 3
$repl3 = '          const cfgText = (lang === ''ar'' ? ''الإعدادات\n\nالمراقبة: '' : ''Settings\n\nMonitoring: '') + monStatus;' + "`n" + '          const cfgKb = ['
$content = $content.Replace($extract.chunk3, $repl3)

# Chunk 4
$repl4 = '            [{ text: t(lang, ''BTN_BACK'') }]' + "`n" + '          ];'
$content = $content.Replace($extract.chunk4, $repl4)

# Chunk 5
$repl5 = '            [{ text: t(lang, ''BTN_BACK'') }]' + "`n" + '          ];'
$content = $content.Replace($extract.chunk5, $repl5)

# Chunk 6
$repl6 = '        if (text !== ''/skip'' && text !== t(lang, ''MSG_ADMIN_35'')) {' + "`n" + '          doc = this.extractTelegramAttachment(message);'
$content = $content.Replace($extract.chunk6, $repl6)

# Chunk 7
$repl7 = '        state.isPinned = text === t(lang, ''MSG_ADMIN_38'');' + "`n" + '        await this.handleAdminAnnouncementBroadcast(chatId, state, lang);'
$content = $content.Replace($extract.chunk7, $repl7)

# Chunk 8
$repl8 = '               const txt = `📢 *${msgTitle}*\n\n${msgContent}\n\n${updatedAnn.is_pinned ? ''📌 (Pinned)'' : ''}`;' + "`n" + '               await this.apiCall(''editMessageText'', { chat_id: msg.chat_id, message_id: msg.message_id, text: txt, parse_mode: ''Markdown'' });'
$content = $content.Replace($extract.chunk8, $repl8)

[System.IO.File]::WriteAllText($botPath, $content, [System.Text.Encoding]::UTF8)
Write-Output "Replacements completed successfully."

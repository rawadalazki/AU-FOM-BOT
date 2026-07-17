const fs = require('fs');
let content = fs.readFileSync('bot-manager.js', 'utf8');

const lines = content.split('\n');

lines[747] = "      await this.apiCall('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: lang === 'ar' ? 'تم إلغاء تثبيت الإعلان لدى الجميع.' : 'Announcement unpinned.', show_alert: true });";
lines[1044] = "        const statsAr = `\uD83D\uDCCA **إحصائيات البوت التفصيلية:**\\n\\n` +";
lines[1045] = "          `\uD83D\uDC65 **المشتركون**\\n` +";
lines[1046] = "          `- إجمالي المشتركين: ${totalUsers}\\n` +";
lines[1047] = "          `- المشتركون الجدد (أسبوع): ${weeklySubscribers}\\n` +";
lines[1048] = "          `- المشتركون الجدد (شهر): ${monthlySubscribers}\\n\\n` +";
lines[1049] = "          `\uD83D\uDCC8 **النشاط**\\n` +";
lines[1050] = "          `- نشط اليوم: ${dailyActive}\\n` +";
lines[1051] = "          `- نشط هذا الأسبوع: ${weeklyActive}\\n` +";
lines[1052] = "          `- نشط هذا الشهر: ${monthlyActive}\\n\\n` +";
lines[1053] = "          `\u26A1 **الوصول والأداء**\\n` +";
lines[1054] = "          `- نسبة الوصول (شهرياً): ${reachPercentage}%\\n` +";
lines[1055] = "          `- إجمالي الطلبات/النقرات: ${totalRequests}\\n` +";
lines[1056] = "          `- متوسط الاستجابة (ميلي ثانية): ${avgLatency}ms\\n\\n` +";
lines[1057] = "          `\uD83D\uDCC1 **المحتوى**\\n` +";
lines[1058] = "          `- عدد الأزرار المتاحة: ${totalButtons}\\n` +";
lines[1059] = "          `- عدد الملفات المرفوعة: ${totalFiles}\\n` +";
lines[1060] = "          `- الزر الأكثر طلباً: ${topButtonStr}\\n\\n` +";
lines[1061] = "          `\uD83D\uDEAB **الحظر**\\n` +";
lines[1062] = "          `- عدد من قام بحظر البوت: ${blockedUsers}`;";
lines[1063] = "";

lines[1092] = "          const cfgText = (lang === 'ar' ? 'الإعدادات\\n\\nالمراقبة: ' : 'Settings\\n\\nMonitoring: ') + monStatus;";
lines[1265] = "        if (text !== '/skip' && text !== t(lang, 'MSG_ADMIN_35')) {";
lines[1291] = "        state.isPinned = text === t(lang, 'MSG_ADMIN_38');";
lines[1320] = "               const txt = `\uD83D\uDCE2 *${msgTitle}*\\n\\n${msgContent}\\n\\n${updatedAnn.is_pinned ? '\uD83D\uDCCC (Pinned)' : ''}`;";

lines[1336] = "        if (text === t(lang, 'BTN_YES_ICON')) {";
lines[1337] = "           if (!delRole) {";
lines[1338] = "               await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_43') });";
lines[1339] = "           } else if (delRole === 'OWNER') {";
lines[1340] = "               await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_ADMIN_44') });";
lines[1341] = "           } else {";
lines[1342] = "               await dbHelper.removeAdmin(this.facultyId, state.subId);";
lines[1343] = "               await this.apiCall('sendMessage', { chat_id: chatId, text: t(lang, 'MSG_SUBADMIN_REMOVED') });";
lines[1344] = "           }";
lines[1345] = "        }";

fs.writeFileSync('bot-manager.js', lines.join('\n'), 'utf8');

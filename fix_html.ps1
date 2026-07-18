$ErrorActionPreference = 'Stop'
$botFile = 'bot-manager.js'
$lines = [System.IO.File]::ReadAllLines($botFile, [System.Text.Encoding]::UTF8)
$newLines = [System.Collections.ArrayList]::new()
$skipUntil = -1

for ($i = 0; $i -lt $lines.Length; $i++) {
    $lineNum = $i + 1
    if ($lineNum -le $skipUntil) { continue }

    # 1. Add escapeHTML method after apiCall
    if ($lineNum -eq 2218) {
        $newLines.Add($lines[$i]) | Out-Null
        continue
    }

    if ($lines[$i] -match "async apiCall\(") {
        $newLines.Add("  escapeHTML(text) {") | Out-Null
        $newLines.Add("    if (!text) return '';") | Out-Null
        $newLines.Add("    return text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');") | Out-Null
        $newLines.Add("  }") | Out-Null
        $newLines.Add("") | Out-Null
        $newLines.Add($lines[$i]) | Out-Null
        continue
    }

    # 2. Fix admin notifications to use HTML and escape user input (line 324)
    if ($lines[$i] -match "\`📝 \*\*") {
        $newLines.Add("            text: `📝 <b>رسالة جديدة</b>\n\n👤 المرسل: ${this.escapeHTML(userStr)} (ID: ${message.from.id})\n💬 النص: ${this.escapeHTML(text)}`,") | Out-Null
        $newLines.Add("            parse_mode: 'HTML'") | Out-Null
        $skipUntil = $lineNum + 1
        continue
    }

    # 3. Fix callback query admin notification (line 604)
    if ($lines[$i] -match "\`👆 \*\*") {
        $newLines.Add("              text: `👆 <b>نقرة على القائمة المضمنة (إنلاين)</b>\n\n👤 المستخدم: ${this.escapeHTML(userStr)} (ID: ${callbackQuery.from.id})\n🔘 الزر: ${this.escapeHTML(btnText)} (${data})`,") | Out-Null
        $newLines.Add("              parse_mode: 'HTML'") | Out-Null
        $skipUntil = $lineNum + 1
        continue
    }

    # 4. Fix handleDirectFileLink reply
    if ($lines[$i] -match "text: reply \|\| \(user\.language === 'ar'") {
        $newLines.Add("        text: this.escapeHTML(reply) || (user.language === 'ar' ? 'لا يوجد محتوى' : 'No content'),") | Out-Null
        continue
    }

    # 5. Fix handleUserMessage promptText
    if ($lines[$i] -match "const promptText = content \?") {
        $newLines.Add("    const safeTitle = this.escapeHTML(title);") | Out-Null
        $newLines.Add("    const safeContent = this.escapeHTML(content);") | Out-Null
        $newLines.Add("    const promptText = safeContent ? `📁 <b>${safeTitle}</b>\n\n${safeContent}` : `📁 <b>${safeTitle}</b>`;") | Out-Null
        continue
    }

    # 6. Fix handleAdminAnnouncementBroadcast standard mode (1914)
    if ($lines[$i] -match "finalTxt = \`📣 \*\$\{title\}\*") {
        $newLines.Add("             finalTxt = `📣 <b>${this.escapeHTML(title)}</b>\n\n${this.escapeHTML(content)}`;") | Out-Null
        continue
    }

    # 7. Fix handleAdminAnnouncementBroadcast parse_mode (1919)
    if ($lines[$i] -match "const apiOpts = finalEntities \? \{ caption_entities: finalEntities \} : \{ parse_mode: 'Markdown' \};") {
        $newLines.Add("            const apiOpts = finalEntities ? { caption_entities: finalEntities } : { parse_mode: 'HTML' };") | Out-Null
        continue
    }
    
    # 8. Fix handleAdminAnnouncementBroadcast parse_mode (1927)
    if ($lines[$i] -match "const apiOpts = finalEntities \? \{ entities: finalEntities \} : \{ parse_mode: 'Markdown' \};") {
        $newLines.Add("            const apiOpts = finalEntities ? { entities: finalEntities } : { parse_mode: 'HTML' };") | Out-Null
        continue
    }

    $newLines.Add($lines[$i]) | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($botFile, $newLines.ToArray(), $utf8NoBom)
Write-Output "Done! Original: $($lines.Length) lines, New: $($newLines.Count) lines"

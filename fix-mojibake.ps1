# Fix double-encoded Arabic in bot-manager.js
# The file has Arabic text that was encoded as UTF-8, then the bytes were
# misinterpreted as Latin-1 and re-encoded as UTF-8 (double-encoding).

$bytes = [System.IO.File]::ReadAllBytes('bot-manager.js')
$content = [System.Text.Encoding]::UTF8.GetString($bytes)

# === Fix 1: Lines 289-291 - New user notification ===
$old1 = 'const notifyText = `ðŸ''¤ <b>Ù…Ø³ØªØ®Ø¯Ù… Ø¬Ø¯ÙŠØ¯ Ø¯Ø®Ù„ Ø§Ù„Ø¨ÙˆØª</b>\n` +'
$new1 = 'const notifyText = `👤 <b>مستخدم جديد دخل البوت</b>\n` +'

$old2 = '                         `Ø§??Ø³Ù…: ${message.from.first_name || ''ØºÙŠØ± Ù…ØªÙˆÙØ±''}\n` +'
$new2 = '                         `الاسم: ${message.from.first_name || ''غير متوفر''}\n` +'

$old3 = '                         `Username: ${message.from.username ? ''@'' + message.from.username : ''ØºÙŠØ± Ù…ØªÙˆÙØ±''}\n` +'
$new3 = '                         `Username: ${message.from.username ? ''@'' + message.from.username : ''غير متوفر''}\n` +'

Write-Host "Attempting replacements..."

# We need to work with the raw bytes to match the double-encoded content
# Strategy: Read as bytes, decode as UTF-8, find the mojibake patterns, replace with correct Arabic

# Let's do line-by-line replacement using the actual UTF-8 string content
$lines = $content -split "`r`n"
$changed = 0

for ($i = 0; $i -lt $lines.Length; $i++) {
    $lineNum = $i + 1
    $original = $lines[$i]
    
    # Line 289: New user notification title
    if ($lineNum -eq 289) {
        $lines[$i] = '      const notifyText = `👤 <b>مستخدم جديد دخل البوت</b>\n` +'
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 289" }
    }
    # Line 290: Name label
    if ($lineNum -eq 290) {
        $lines[$i] = '                         `الاسم: ${message.from.first_name || ''غير متوفر''}\n` +'
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 290" }
    }
    # Line 291: Username fallback
    if ($lineNum -eq 291) {
        $lines[$i] = '                         `Username: ${message.from.username ? ''@'' + message.from.username : ''غير متوفر''}\n` +'
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 291" }
    }
    # Line 307: Disabled bot message
    if ($lineNum -eq 307) {
        $lines[$i] = '        ? (faculty.disabled_message_ar || ''عذراً، البوت متوقف حالياً لإجراء بعض التحديثات.'') '
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 307" }
    }
    # Line 2055: Language selection buttons
    if ($lineNum -eq 2055) {
        $lines[$i] = '          [{ text: "🇺🇸 English", callback_data: "lang_en" }, { text: "🇸🇦 العربية", callback_data: "lang_ar" }]'
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 2055" }
    }
    # Line 2091: Welcome message fallback
    if ($lineNum -eq 2091) {
        $lines[$i] = "      promptText = lang === 'ar' ? (faculty.welcome_ar || 'مرحباً بك') : (faculty.welcome_en || 'Welcome');"
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 2091" }
    }
    # Line 2210: start command description
    if ($lineNum -eq 2210) {
        $lines[$i] = "      { command: 'start', description: 'البدء واسترجاع القائمة' },"
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 2210" }
    }
    # Line 2211: changelanguage command description
    if ($lineNum -eq 2211) {
        $lines[$i] = "      { command: 'changelanguage', description: 'تغيير لغة البوت' },"
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 2211" }
    }
    # Line 2212: back command description
    if ($lineNum -eq 2212) {
        $lines[$i] = "      { command: 'back', description: 'العودة للقائمة السابقة' },"
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 2212" }
    }
    # Line 2213: id command description
    if ($lineNum -eq 2213) {
        $lines[$i] = "      { command: 'id', description: 'الحصول على معرف تيليجرام' },"
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 2213" }
    }
    # Line 2214: admin command description
    if ($lineNum -eq 2214) {
        $lines[$i] = "      { command: 'admin', description: 'لوحة التحكم للمشرفين' }"
        if ($lines[$i] -ne $original) { $changed++; Write-Host "Fixed line 2214" }
    }
}

$result = $lines -join "`r`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText('bot-manager.js', $result, $utf8NoBom)

Write-Host ""
Write-Host "Total lines changed: $changed"
Write-Host "File saved as UTF-8 without BOM"

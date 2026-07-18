$bytes = [System.IO.File]::ReadAllBytes('bot-manager.js')
$str = [System.Text.Encoding]::UTF8.GetString($bytes)
$lines = $str -split "`n"
$lines = $lines | ForEach-Object { $_.TrimEnd("`r") }

# We replace lines by 0-based index
$lines[288] = '      const notifyText = `👤 <b>مستخدم جديد دخل البوت</b>\n` +'
$lines[289] = '                         `الاسم: ${message.from.first_name || ''غير متوفر''}\n` +'
$lines[290] = '                         `Username: ${message.from.username ? ''@'' + message.from.username : ''غير متوفر''}\n` +'

$lines[306] = '        ? (faculty.disabled_message_ar || ''عذراً، البوت متوقف حالياً لإجراء بعض التحديثات.'') '

$lines[2054] = '          [{ text: "🇺🇸 English", callback_data: "lang_en" }, { text: "🇸🇦 العربية", callback_data: "lang_ar" }]'

$lines[2090] = "      promptText = lang === 'ar' ? (faculty.welcome_ar || 'مرحباً بك') : (faculty.welcome_en || 'Welcome');"

$lines[2209] = "      { command: 'start', description: 'البدء واسترجاع القائمة' },"
$lines[2210] = "      { command: 'changelanguage', description: 'تغيير لغة البوت' },"
$lines[2211] = "      { command: 'back', description: 'العودة للقائمة السابقة' },"
$lines[2212] = "      { command: 'id', description: 'الحصول على معرف تيليجرام' },"
$lines[2213] = "      { command: 'admin', description: 'لوحة التحكم للمشرفين' }"

$result = $lines -join "`r`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText('bot-manager.js', $result, $utf8NoBom)
Write-Host "Replacements done."

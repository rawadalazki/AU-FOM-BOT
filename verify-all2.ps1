$bytes = [System.IO.File]::ReadAllBytes('admin-menu-navigation.js')
$str = [System.Text.Encoding]::UTF8.GetString($bytes)
$lines = $str -split "`n"

Write-Host "=== admin-menu-navigation.js ==="
Write-Host "Total lines: $($lines.Length)"

# Brace balance
$openBraces = ([regex]::Matches($str, '\{')).Count
$closeBraces = ([regex]::Matches($str, '\}')).Count
$openParens = ([regex]::Matches($str, '\(')).Count
$closeParens = ([regex]::Matches($str, '\)')).Count
$openBrackets = ([regex]::Matches($str, '\[')).Count
$closeBrackets = ([regex]::Matches($str, '\]')).Count

Write-Host "Curly braces: { = $openBraces, } = $closeBraces, diff = $($openBraces - $closeBraces)"
Write-Host "Parentheses: ( = $openParens, ) = $closeParens, diff = $($openParens - $closeParens)"
Write-Host "Brackets: [ = $openBrackets, ] = $closeBrackets, diff = $($openBrackets - $closeBrackets)"

if (($openBraces -eq $closeBraces) -and ($openParens -eq $closeParens) -and ($openBrackets -eq $closeBrackets)) {
    Write-Host "ALL BALANCED OK"
} else {
    Write-Host "WARNING: IMBALANCED!"
}

# Double-encoded Arabic
$doubleEncLines = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
    $lineBytes = [System.Text.Encoding]::UTF8.GetBytes($lines[$i])
    for ($j = 0; $j -lt $lineBytes.Length - 3; $j++) {
        if ($lineBytes[$j] -eq 0xC3 -and $lineBytes[$j+1] -eq 0x98 -and $lineBytes[$j+2] -eq 0xC2) {
            $doubleEncLines += ($i + 1)
            break
        }
    }
}
Write-Host "Lines with double-encoded Arabic: $($doubleEncLines.Length)"

# ===== Check server.js =====
Write-Host ""
Write-Host "=== server.js ==="
$bytes2 = [System.IO.File]::ReadAllBytes('server.js')
$str2 = [System.Text.Encoding]::UTF8.GetString($bytes2)

$openBraces2 = ([regex]::Matches($str2, '\{')).Count
$closeBraces2 = ([regex]::Matches($str2, '\}')).Count
$openParens2 = ([regex]::Matches($str2, '\(')).Count
$closeParens2 = ([regex]::Matches($str2, '\)')).Count

Write-Host "Curly braces: { = $openBraces2, } = $closeBraces2, diff = $($openBraces2 - $closeBraces2)"
Write-Host "Parentheses: ( = $openParens2, ) = $closeParens2, diff = $($openParens2 - $closeParens2)"

if (($openBraces2 -eq $closeBraces2) -and ($openParens2 -eq $closeParens2)) {
    Write-Host "ALL BALANCED OK"
} else {
    Write-Host "WARNING: IMBALANCED!"
}

# ===== Check database.js =====
Write-Host ""
Write-Host "=== database.js ==="
$bytes3 = [System.IO.File]::ReadAllBytes('database.js')
$str3 = [System.Text.Encoding]::UTF8.GetString($bytes3)

$openBraces3 = ([regex]::Matches($str3, '\{')).Count
$closeBraces3 = ([regex]::Matches($str3, '\}')).Count
$openParens3 = ([regex]::Matches($str3, '\(')).Count
$closeParens3 = ([regex]::Matches($str3, '\)')).Count

Write-Host "Curly braces: { = $openBraces3, } = $closeBraces3, diff = $($openBraces3 - $closeBraces3)"
Write-Host "Parentheses: ( = $openParens3, ) = $closeParens3, diff = $($openParens3 - $closeParens3)"

if (($openBraces3 -eq $closeBraces3) -and ($openParens3 -eq $closeParens3)) {
    Write-Host "ALL BALANCED OK"
} else {
    Write-Host "WARNING: IMBALANCED!"
}

# ===== Validate JSON locale files =====
Write-Host ""
Write-Host "=== Locale files JSON validation ==="
try {
    $arJson = Get-Content 'locales\ar.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host "ar.json: VALID JSON ($($arJson.PSObject.Properties.Count) keys)"
} catch {
    Write-Host "ar.json: INVALID JSON - $($_.Exception.Message)"
}

try {
    $enJson = Get-Content 'locales\en.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host "en.json: VALID JSON ($($enJson.PSObject.Properties.Count) keys)"
} catch {
    Write-Host "en.json: INVALID JSON - $($_.Exception.Message)"
}

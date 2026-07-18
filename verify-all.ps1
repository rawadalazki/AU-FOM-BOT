$bytes = [System.IO.File]::ReadAllBytes('bot-manager.js')
$str = [System.Text.Encoding]::UTF8.GetString($bytes)
$lines = $str -split "`n"

# Find all lines with C3 98 pattern (double-encoded Arabic)
Write-Host "=== Scanning for double-encoded Arabic (C3 98 C2 xx pattern) ==="

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
foreach ($ln in $doubleEncLines) {
    Write-Host "  Line $ln"
}

# Check all hardcoded Arabic strings in the file that are NOT from locale files
Write-Host ""
Write-Host "=== Checking hardcoded Arabic strings ==="
$arabicPattern = '[\u0600-\u06FF]'
$arabicLines = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match $arabicPattern) {
        $arabicLines += ($i + 1)
    }
}
Write-Host "Lines with Arabic characters: $($arabicLines.Length)"
foreach ($ln in $arabicLines) {
    $content = $lines[$ln - 1].Trim()
    if ($content.Length -gt 100) { $content = $content.Substring(0, 100) + '...' }
    Write-Host "  Line ${ln}: $content"
}

# Syntax check: Count braces
Write-Host ""
Write-Host "=== Brace Balance Check ==="
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

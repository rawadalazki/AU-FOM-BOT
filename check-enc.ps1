$bytes = [System.IO.File]::ReadAllBytes('bot-manager.js')
$str = [System.Text.Encoding]::UTF8.GetString($bytes)
$lines = $str -split "`n"
Write-Host "Total lines: $($lines.Length)"
Write-Host ""
Write-Host "=== Line 2210 ==="
Write-Host $lines[2209]
Write-Host "=== Line 2211 ==="
Write-Host $lines[2210]
Write-Host "=== Line 2212 ==="
Write-Host $lines[2211]
Write-Host "=== Line 2213 ==="
Write-Host $lines[2212]
Write-Host "=== Line 2214 ==="
Write-Host $lines[2213]

# Check for BOM
if ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Write-Host "`nFile has UTF-8 BOM"
} else {
    Write-Host "`nFile has NO BOM. First 3 bytes: $($bytes[0].ToString('X2')) $($bytes[1].ToString('X2')) $($bytes[2].ToString('X2'))"
}

# Check if the Arabic in line 2210 is double-encoded
# Look for the pattern C3 98 which is the UTF-8 encoding of U+00D8 (Ø)
# This pattern indicates double-encoding of Arabic text
$lineBytes = [System.Text.Encoding]::UTF8.GetBytes($lines[2209])
$hexLine = ($lineBytes | ForEach-Object { $_.ToString('X2') }) -join ' '
Write-Host "`n=== Hex of line 2210 (first 150 bytes) ==="
Write-Host ($hexLine.Substring(0, [Math]::Min(450, $hexLine.Length)))

# Count mojibake patterns in whole file
$mojibakeCount = ([regex]::Matches($str, 'Ø§|Ù„|Ø¨|Ø¹|Ù…|ÙˆØ')).Count
Write-Host "`n=== Mojibake pattern count in entire file: $mojibakeCount ==="

# Check specifically which lines have mojibake
$mojibakeLines = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match 'Ø[§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿]') {
        $mojibakeLines += ($i + 1)
    }
}
Write-Host "Lines with mojibake patterns: $($mojibakeLines -join ', ')"

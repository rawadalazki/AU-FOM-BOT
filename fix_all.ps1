$ErrorActionPreference = 'Stop'

$botFile = 'bot-manager.js'
$replFile = 'replacements.txt'

# Read both files as raw UTF8
$lines = [System.IO.File]::ReadAllLines($botFile, [System.Text.Encoding]::UTF8)
$replContent = [System.IO.File]::ReadAllText($replFile, [System.Text.Encoding]::UTF8)

# Parse the replacements file into blocks
$blocks = @{}
$currentKey = $null
$currentLines = @()

foreach ($rLine in ($replContent -split "`n")) {
    $rLine = $rLine.TrimEnd("`r")
    if ($rLine -eq 'END') {
        if ($currentKey) {
            $blocks[$currentKey] = $currentLines
        }
        $currentKey = $null
        $currentLines = @()
    } elseif ($null -eq $currentKey) {
        $currentKey = $rLine
        $currentLines = @()
    } else {
        $currentLines += $rLine
    }
}

Write-Output "Parsed blocks: $($blocks.Keys -join ', ')"

# Build new file content
$newLines = [System.Collections.ArrayList]::new()
$skipUntil = -1

for ($i = 0; $i -lt $lines.Length; $i++) {
    $lineNum = $i + 1

    # Skip lines we're replacing
    if ($lineNum -le $skipUntil) { continue }

    # STATSARBLOCK: replace lines 1044-1049 with full block
    if ($lineNum -eq 1044 -and $blocks.ContainsKey('STATSARBLOCK')) {
        foreach ($bl in $blocks['STATSARBLOCK']) {
            $newLines.Add($bl) | Out-Null
        }
        $skipUntil = 1049
        continue
    }

    # Single line replacements
    if ($lineNum -eq 748 -and $blocks.ContainsKey('LINE748')) {
        foreach ($bl in $blocks['LINE748']) { $newLines.Add($bl) | Out-Null }
        continue
    }
    if ($lineNum -eq 1036 -and $blocks.ContainsKey('LINE1036')) {
        foreach ($bl in $blocks['LINE1036']) { $newLines.Add($bl) | Out-Null }
        continue
    }
    if ($lineNum -eq 1079 -and $blocks.ContainsKey('LINE1079')) {
        foreach ($bl in $blocks['LINE1079']) { $newLines.Add($bl) | Out-Null }
        continue
    }
    if ($lineNum -eq 1113 -and $blocks.ContainsKey('LINE1113')) {
        foreach ($bl in $blocks['LINE1113']) { $newLines.Add($bl) | Out-Null }
        continue
    }
    if ($lineNum -eq 1252 -and $blocks.ContainsKey('LINE1252')) {
        foreach ($bl in $blocks['LINE1252']) { $newLines.Add($bl) | Out-Null }
        continue
    }
    if ($lineNum -eq 1278 -and $blocks.ContainsKey('LINE1278')) {
        foreach ($bl in $blocks['LINE1278']) { $newLines.Add($bl) | Out-Null }
        continue
    }
    if ($lineNum -eq 1307 -and $blocks.ContainsKey('LINE1307')) {
        foreach ($bl in $blocks['LINE1307']) { $newLines.Add($bl) | Out-Null }
        continue
    }
    if ($lineNum -eq 1816 -and $blocks.ContainsKey('LINE1816')) {
        foreach ($bl in $blocks['LINE1816']) { $newLines.Add($bl) | Out-Null }
        continue
    }

    # Keep existing line
    $newLines.Add($lines[$i]) | Out-Null
}

# Write result
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($botFile, $newLines.ToArray(), $utf8NoBom)
Write-Output "Done! Original: $($lines.Length) lines, New: $($newLines.Count) lines"

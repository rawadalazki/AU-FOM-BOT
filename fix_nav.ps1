$ErrorActionPreference = 'Stop'
$botFile = 'bot-manager.js'
$replFile = 'replacements.txt'

$lines = [System.IO.File]::ReadAllLines($botFile, [System.Text.Encoding]::UTF8)
$replContent = [System.IO.File]::ReadAllText($replFile, [System.Text.Encoding]::UTF8)

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

$newLines = [System.Collections.ArrayList]::new()
$skipUntil = -1

for ($i = 0; $i -lt $lines.Length; $i++) {
    $lineNum = $i + 1
    if ($lineNum -le $skipUntil) { continue }

    if ($lineNum -eq 1387 -and $blocks.ContainsKey('DEL_BTN')) {
        foreach ($bl in $blocks['DEL_BTN']) { $newLines.Add($bl) | Out-Null }
        $skipUntil = 1406
        continue
    }

    if ($lineNum -eq 1408 -and $blocks.ContainsKey('DEL_CONTENT')) {
        foreach ($bl in $blocks['DEL_CONTENT']) { $newLines.Add($bl) | Out-Null }
        $skipUntil = 1419
        continue
    }

    if ($lineNum -eq 1421 -and $blocks.ContainsKey('DEL_FILE')) {
        foreach ($bl in $blocks['DEL_FILE']) { $newLines.Add($bl) | Out-Null }
        $skipUntil = 1445
        continue
    }

    if ($lineNum -eq 1447 -and $blocks.ContainsKey('RENAME_TITLE')) {
        foreach ($bl in $blocks['RENAME_TITLE']) { $newLines.Add($bl) | Out-Null }
        $skipUntil = 1455
        continue
    }

    if ($lineNum -eq 1457 -and $blocks.ContainsKey('EDIT_SUBMENU')) {
        foreach ($bl in $blocks['EDIT_SUBMENU']) { $newLines.Add($bl) | Out-Null }
        $skipUntil = 1465
        continue
    }

    if ($lineNum -eq 1467 -and $blocks.ContainsKey('EDIT_TEXT')) {
        foreach ($bl in $blocks['EDIT_TEXT']) { $newLines.Add($bl) | Out-Null }
        $skipUntil = 1476
        continue
    }

    $newLines.Add($lines[$i]) | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($botFile, $newLines.ToArray(), $utf8NoBom)
Write-Output "Done! Original: $($lines.Length) lines, New: $($newLines.Count) lines"

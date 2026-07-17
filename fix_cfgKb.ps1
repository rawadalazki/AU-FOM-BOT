$ErrorActionPreference = 'Stop'
$lines = Get-Content bot-manager.js -Encoding UTF8
$newLines = @()
foreach ($line in $lines) {
    $newLines += $line
    if ($line.Trim() -match '^const cfgText = \(lang === ''ar'' \? ''الإعدادات') {
        $newLines += '          const cfgKb = ['
    }
}
$newLines | Set-Content bot-manager.js -Encoding UTF8

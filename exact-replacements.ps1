$ErrorActionPreference = 'Stop'

$botPath = "bot-manager.js"
$jsonPath = "extract.json"
$replPath = "replacements.json"

$content = [System.IO.File]::ReadAllText($botPath, [System.Text.Encoding]::UTF8)
$extract = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$repls = Get-Content $replPath -Raw -Encoding UTF8 | ConvertFrom-Json

$content = $content.Replace($extract.chunk1, $repls.chunk1)
$content = $content.Replace($extract.chunk2, $repls.chunk2)
$content = $content.Replace($extract.chunk3, $repls.chunk3)
$content = $content.Replace($extract.chunk4, $repls.chunk4)
$content = $content.Replace($extract.chunk5, $repls.chunk5)
$content = $content.Replace($extract.chunk6, $repls.chunk6)
$content = $content.Replace($extract.chunk7, $repls.chunk7)
$content = $content.Replace($extract.chunk8, $repls.chunk8)

[System.IO.File]::WriteAllText($botPath, $content, [System.Text.Encoding]::UTF8)
Write-Output "Exact string replacements completed successfully."

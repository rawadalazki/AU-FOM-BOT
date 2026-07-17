$lines = Get-Content bot-manager.js -Encoding UTF8
$extract = @{
    chunk1 = $lines[746..748] -join "`n"
    chunk2 = $lines[1044..1063] -join "`n"
    chunk3 = $lines[1092..1093] -join "`n"
    chunk4 = $lines[1214..1215] -join "`n"
    chunk5 = $lines[1234..1235] -join "`n"
    chunk6 = $lines[1265..1266] -join "`n"
    chunk7 = $lines[1291..1292] -join "`n"
    chunk8 = $lines[1320..1321] -join "`n"
}
$extract | ConvertTo-Json | Set-Content extract.json -Encoding UTF8

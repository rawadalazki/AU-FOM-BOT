$bytes = [System.IO.File]::ReadAllBytes('bot-manager.js')
$str = [System.Text.Encoding]::UTF8.GetString($bytes)
$lines = $str -split "`n"
$lines = $lines | ForEach-Object { $_.TrimEnd("`r") }

# We replace lines by 0-based index using Base64 decoded UTF-8 strings
function Decode($b64) {
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

$lines[288] = Decode "ICAgICAgY29uc3Qgbm90aWZ5VGV4dCA9IGDwn5GkIDxiPtmF2LPYqtiu2K/ZhSDYrdiv2YrZryDYrdiv2K7ZhCAg2KfZhNio2YjYqjwvYj5cbmAgKw=="
$lines[289] = Decode "ICAgICAgICAgICAgICAgICAgICAgICAgIGDYp9mE2KfYs9mFOiAke21lc3NhZ2UuZnJvbS5maXJzdF9uYW1lIHx8ICfYutmK2LEg2YXYqtmI2YHYsSd9XG5gICs="
$lines[290] = Decode "ICAgICAgICAgICAgICAgICAgICAgICAgIGBVc2VybmFtZTogJHttZXNzYWdlLmZyb20udXNlcm5hbWUgPyAnQCcgKyBtZXNzYWdlLmZyb20udXNlcm5hbWUgOiAn2LrYr9ixINmF2KrZiNmB2LEnfVxuYCAr"

$lines[306] = Decode "ICAgICAgICA/IChmYWN1bHR5LmRpc2FibGVkX21lc3NhZ2VfYXIgfHwgJ9i52LDYsdin2YzYjCDYp9mE2KjZiNiqINmF2KrZiNmC2YEg2K3Yp9mE2YrYp9mMINmE2KXYrNix2KfYoSDYqNi52LYg2KfZhNiq2K3Yr9mK2KvZp9iqLicpIA=="

$lines[2054] = Decode "ICAgICAgICAgIFt7IHRleHQ6ICLwn4e68J+HuCBFbmdsaXNoIiwgY2FsbGJhY2tfZGF0YTogImxhbmdfZW4iIH0sIHsgdGV4dDogIvCfh7jwn4emINin2YTYudix2KjZitipIiwgY2FsbGJhY2tfZGF0YTogImxhbmdfYXIiIH1d"

$lines[2090] = Decode "ICAgICAgcHJvbXB0VGV4dCA9IGxhbmcgPT09ICdhcicgPyAoZmFjdWx0eS53ZWxjb21lX2FyIHx8ICfZhdiv2K3YqNin2Ywg2KjZgycpIDogKGZhY3VsdHkud2VsY29tZV9lbiB8fCAnV2VsY29tZScpOw=="

$lines[2209] = Decode "ICAgICAgeyBjb21tYW5kOiAnc3RhcnQnLCBkZXNjcmlwdGlvbjogJ9in2YTYqNiv2KEg2YjYp9iz2KrYsdis2KfYuSDYp9mE2YLYp9im2YXYqScgfSw="
$lines[2210] = Decode "ICAgICAgeyBjb21tYW5kOiAnY2hhbmdlbGFuZ3VhZ2UnLCBkZXNjcmlwdGlvbjogJ9iq2LrZitmK2LEg2YTYutinINin2YTYqNmI2KonIH0s"
$lines[2211] = Decode "ICAgICAgeyBjb21tYW5kOiAnYmFjaycsIGRlc2NyaXB0aW9uOiAn2KfZhNi52YjYr9ipINmE2YTZgtin2KbZhdivINin2YTYs9in2KjZgtipJyB9LA=="
$lines[2212] = Decode "ICAgICAgeyBjb21tYW5kOiAnaWQnLCBkZXNjcmlwdGlvbjogJ9in2YTYrdi12YjZhCDYudmE2Ykg2YXYudix2YEg2KrZitmE2YrYrNix2KfZhScgfSw="
$lines[2213] = Decode "ICAgICAgeyBjb21tYW5kOiAnYWRtaW4nLCBkZXNjcmlwdGlvbjogJ9mE2YjYrdivINin2YTYqtit2YPYhSDZhNmE2YXYtNix2YHZitmGJyB9"

$result = $lines -join "`r`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText('bot-manager.js', $result, $utf8NoBom)
Write-Host "Replacements done using base64."

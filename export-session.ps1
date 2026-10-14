<#
Export one Claude Code / Roam Desk session to Markdown.

Usage:
  .\export-session.ps1                      # lists recent sessions, then exports the newest
  .\export-session.ps1 -SessionId 00000000-0000-0000-0000-000000000000
  .\export-session.ps1 -List                # list only
  .\export-session.ps1 -IncludeTools        # also include tool calls and results
  .\export-session.ps1 -OutDir C:\Exports

Sessions live in %USERPROFILE%\.claude\projects\<project>\<session-id>.jsonl
#>
param(
    [string]$SessionId,
    [string]$OutDir = "$env:USERPROFILE\Documents",
    [switch]$List,
    [switch]$IncludeTools
)

$root = Join-Path $env:USERPROFILE '.claude\projects'
$files = Get-ChildItem $root -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\subagents\\' } |
    Sort-Object LastWriteTime -Descending

if ($List -or -not $SessionId) {
    $files | Select-Object -First 15 @{n='SessionId';e={$_.BaseName}}, @{n='Project';e={$_.Directory.Name}}, LastWriteTime, @{n='KB';e={[int]($_.Length/1KB)}} | Format-Table -AutoSize
    if ($List) { return }
}

$file = if ($SessionId) { $files | Where-Object BaseName -eq $SessionId | Select-Object -First 1 } else { $files | Select-Object -First 1 }
if (-not $file) { Write-Error "Session not found."; return }

function Get-Text($content, [bool]$tools) {
    if ($content -is [string]) { return $content }
    $parts = foreach ($b in $content) {
        switch ($b.type) {
            'text'     { $b.text }
            'thinking' { }
            'tool_use' { if ($tools) { "``[tool: $($b.name)]`` " + ($b.input | ConvertTo-Json -Depth 5 -Compress) } }
            'tool_result' {
                if ($tools) {
                    $c = $b.content
                    if ($c -isnot [string]) { $c = ($c | ForEach-Object { $_.text }) -join "`n" }
                    "``[result]```n$c"
                }
            }
            'image'    { '[image]' }
        }
    }
    ($parts | Where-Object { $_ }) -join "`n`n"
}

$out = New-Object System.Collections.Generic.List[string]
$out.Add("# Session $($file.BaseName)`n")
foreach ($line in [System.IO.File]::ReadLines($file.FullName)) {
    try { $e = $line | ConvertFrom-Json } catch { continue }
    if ($e.type -notin 'user','assistant' -or $e.isSidechain -or -not $e.message) { continue }
    $text = Get-Text $e.message.content $IncludeTools.IsPresent
    if (-not $text -or -not $text.Trim()) { continue }
    $who = if ($e.type -eq 'user') { 'You' } else { 'Claude' }
    $ts = if ($e.timestamp) { ([datetime]$e.timestamp).ToLocalTime().ToString('dd/MM/yyyy HH:mm') } else { '' }
    $out.Add("## $who  ($ts)`n`n$text`n")
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
$path = Join-Path $OutDir "session-$($file.BaseName).md"
$n = 1
while (Test-Path $path) { $path = Join-Path $OutDir "session-$($file.BaseName)-$n.md"; $n++ }
$out | Set-Content -Path $path -Encoding UTF8
Write-Host "Saved: $path"

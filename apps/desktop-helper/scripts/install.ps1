# Installs (or updates) the Roam Desk helper for the CURRENT Windows user:
# builds it, then registers a Task Scheduler task that starts it hidden at sign-in and restarts it if it stops.
# Run from the repo:  powershell -ExecutionPolicy Bypass -File apps\desktop-helper\scripts\install.ps1
# -Quiet: unattended update started by the helper itself (phone or dashboard button): logs to update.log, no browser.
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$helper = Resolve-Path (Join-Path $PSScriptRoot '..')
$repo = Resolve-Path (Join-Path $helper '..\..')
$taskName = 'Roam Desk Helper'
$logDir = Join-Path $env:LOCALAPPDATA 'ClaudeAnywhere'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'helper.log'
$resultFile = Join-Path $logDir 'update-result.json'

function Write-Result([bool]$ok, [string]$message) {
  @{ ok = $ok; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); message = $message } | ConvertTo-Json | Set-Content -Encoding UTF8 $resultFile
}

if ($Quiet) {
  # Detach from the helper we're about to replace; it started us and will be ended below.
  Start-Sleep -Seconds 2
  Start-Transcript -Path (Join-Path $logDir 'update.log') -Force | Out-Null
}

try {
  Push-Location $repo
  # A copy installed from GitHub fetches the latest code first. If that fails (offline, or local changes in the way),
  # the code already here is built instead.
  if ((Test-Path (Join-Path $repo '.git')) -and (Get-Command git -ErrorAction SilentlyContinue) -and (git config --get remote.origin.url)) {
    Write-Host "Getting the latest code..." -ForegroundColor Cyan
    git pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { Write-Host "Couldn't get the latest code (git exit $LASTEXITCODE); building what's here." -ForegroundColor Yellow }
  }
  Write-Host "Building helper..." -ForegroundColor Cyan
  npm install --silent
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
  npm -w apps/desktop-helper run build --silent
  if ($LASTEXITCODE -ne 0) { throw "the helper build failed (exit $LASTEXITCODE)" }
  Pop-Location
} catch {
  Pop-Location -ErrorAction SilentlyContinue
  # The running helper is untouched, so nothing is broken; report and stop.
  Write-Host "Not updated: $($_.Exception.Message)" -ForegroundColor Red
  Write-Result $false "Not updated: $($_.Exception.Message). The old helper is still running."
  if ($Quiet) { Stop-Transcript | Out-Null }
  exit 1
}

# Stopping the task only ends wscript; the node process it launched keeps the port, so end it too.
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'desktop-helper[\\/]dist' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }

# wscript runs the launcher with no window; the launcher waits on node so restarts work.
$launcher = Join-Path $helper 'scripts\launch-hidden.vbs'
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "//B //NoLogo `"$launcher`"" -WorkingDirectory $helper
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Lets your paired phone talk to Claude on this PC. Dashboard: http://127.0.0.1:8787/' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Start-Sleep -Seconds 6
try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/state -TimeoutSec 5 | Out-Null
  Write-Result $true "Updated and running."
  Write-Host "Installed and running." -ForegroundColor Green
  if (-not $Quiet) { Start-Process 'http://127.0.0.1:8787/' }
} catch {
  Write-Result $false "Installed, but the helper isn't answering yet. Check $log"
  Write-Host "Installed, but the helper isn't answering yet. Check $log" -ForegroundColor Yellow
}
if ($Quiet) { Stop-Transcript | Out-Null }

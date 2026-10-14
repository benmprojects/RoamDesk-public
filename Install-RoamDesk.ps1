# Roam Desk: one-file installer for a new user's Windows PC.
# Installs the tools (Node.js, Git, Tailscale, Claude Code and, optionally, the .NET 8 SDK), signs in to Tailscale and
# Claude, gets Roam Desk from GitHub (public, over https) into %USERPROFILE%\RoamDesk, and installs the helper so it starts hidden at sign-in. After that, "Update helper" on the dashboard fetches
# new versions from GitHub. Running this again is safe; settings and pairings are kept.
#
#   Double-click "Install Roam Desk.cmd", or in PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\Install-RoamDesk.ps1 [-DesktopControl] [-InstallDir <folder>]
param(
  # Also install desktop control (lets Claude see the screen and use the mouse and keyboard). Needs the .NET 8 SDK.
  [switch]$DesktopControl,
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'RoamDesk')
)

$ErrorActionPreference = 'Stop'
$tailscaleExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$repoUrl = 'https://github.com/benmprojects/RoamDesk-public.git'
$branch = 'master'

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   $text" -ForegroundColor Green }
function Note($text) { Write-Host "   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host ""; Write-Host "Stopped: $text" -ForegroundColor Red; exit 1 }

# Programs installed a moment ago aren't on this window's PATH yet.
function Update-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$(Join-Path $env:USERPROFILE '.local\bin')"
}

function Install-Package($id, $name) {
  Write-Host "   Installing $name..."
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { Fail "$name didn't install (winget exit $LASTEXITCODE)." } # -1978335189: already installed
  Update-Path
}

function Node-Major {
  try { return [int]((node -v) -replace '^v(\d+).*', '$1') } catch { return 0 }
}

Write-Host "Roam Desk installer" -ForegroundColor White
Write-Host "Installs to $InstallDir. Some steps open a browser for you to sign in."

# ---------------------------------------------------------------- checks
Step "Checking this PC"
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail "Roam Desk needs Windows 10 or 11." }
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fail "winget isn't available. Install 'App Installer' from the Microsoft Store, then run this again."
}
Update-Path
Ok "Windows and winget found."

# ---------------------------------------------------------------- tools
Step "Installing tools"
if ((Node-Major) -ge 24) { Ok "Node.js $(node -v) is installed." }
else {
  Install-Package 'OpenJS.NodeJS.LTS' 'Node.js'
  if ((Node-Major) -lt 24) { Fail "Node.js 24 or later is needed, but $(node -v) is installed. Update Node.js, then run this again." }
  Ok "Node.js $(node -v) installed."
}

# The helper keeps its keys in Windows Credential Manager through a native module that needs the Visual C++ runtime,
# which a fresh Windows install doesn't always have.
$vcDlls = 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll' | ForEach-Object { Join-Path $env:SystemRoot "System32\$_" }
if (-not ($vcDlls | Where-Object { -not (Test-Path $_) })) { Ok "Visual C++ runtime is installed." }
else { Install-Package 'Microsoft.VCRedist.2015+.x64' 'Visual C++ runtime'; Ok "Visual C++ runtime installed." }

if (Get-Command git -ErrorAction SilentlyContinue) { Ok "Git is installed." }
else { Install-Package 'Git.Git' 'Git'; Ok "Git installed." }

if (Test-Path $tailscaleExe) { Ok "Tailscale is installed." }
else { Install-Package 'Tailscale.Tailscale' 'Tailscale'; Ok "Tailscale installed." }

if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "Claude Code is installed." }
else {
  Write-Host "   Installing Claude Code (Anthropic's installer)..."
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Update-Path
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail "Claude Code didn't install. Close this window, open a new one and run this again." }
  Ok "Claude Code installed."
}

if ($DesktopControl) {
  $hasSdk8 = (Get-Command dotnet -ErrorAction SilentlyContinue) -and ((dotnet --list-sdks 2>$null) -match '^8\.')
  if ($hasSdk8) { Ok ".NET 8 SDK is installed." }
  else { Install-Package 'Microsoft.DotNet.SDK.8' '.NET 8 SDK'; Ok ".NET 8 SDK installed." }
}

# ---------------------------------------------------------------- Tailscale
Step "Signing in to Tailscale"
function Tailscale-Status { try { & $tailscaleExe status --json 2>$null | ConvertFrom-Json } catch { $null } }
$ts = Tailscale-Status
if ($ts.BackendState -ne 'Running') {
  Note "Sign in with YOUR OWN Tailscale account in the browser (if no browser opens, open the link shown below). Use the same account on your phone later."
  & $tailscaleExe up | Out-Host
  $ts = Tailscale-Status
  if ($ts.BackendState -ne 'Running') { Fail "Tailscale isn't connected. Open Tailscale from the Start menu, sign in, then run this again." }
}
Ok "Connected as $($ts.User.([string]$ts.Self.UserID).LoginName)."

# The phone app only uses the encrypted (HTTPS) link, which needs MagicDNS and HTTPS certificates on the tailnet.
for ($try = 1; -not $ts.CertDomains; $try++) {
  if ($try -gt 3) { Fail "HTTPS certificates still aren't on for your Tailscale network. Ask your Tailscale admin to turn on MagicDNS and HTTPS Certificates (admin console, DNS page), then run this again." }
  Note "Your Tailscale network needs MagicDNS and HTTPS Certificates turned on. It's a one-off setting for the whole network."
  Note "On a work or company network, only your Tailscale admin can do this: ask them, then press Enter here once it's done."
  Note "On your own network: in the Tailscale page that opens, under DNS, turn on MagicDNS, then HTTPS Certificates."
  Start-Process 'https://login.tailscale.com/admin/dns'
  Read-Host "   Press Enter when it's on"
  $ts = Tailscale-Status
}
Ok "Encrypted link available: $($ts.Self.DNSName.TrimEnd('.'))"

# ---------------------------------------------------------------- Claude
Step "Signing in to Claude"
function Claude-SignedIn { try { (claude auth status 2>$null | Out-String | ConvertFrom-Json).loggedIn -eq $true } catch { $false } }
if (-not (Claude-SignedIn)) {
  Note "A browser window opens: sign in with the Claude account that has Claude Code."
  claude auth login | Out-Host
  if (-not (Claude-SignedIn)) { Fail "Claude isn't signed in. Run 'claude auth login' in a new window, then run this again." }
}
Ok "Claude is signed in."

# ---------------------------------------------------------------- Roam Desk
Step "Getting Roam Desk from GitHub into $InstallDir"
$dst = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')

# Earlier installs fetched over ssh with a deploy key. Point them at the public https address and drop the key setting.
function Use-Https {
  git -C $dst config --unset core.sshCommand 2>$null
  git -C $dst remote set-url origin $repoUrl 2>$null
}

if (Test-Path (Join-Path $dst '.git')) {
  Use-Https
  git -C $dst pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't update from GitHub (git exit $LASTEXITCODE). Check the internet connection." }
  Ok "Updated to the latest version."
} elseif (Test-Path $dst) {
  # An earlier install copied from a zip: turn it into a GitHub copy. Only code is replaced; settings, pairings and
  # logs live in AppData and aren't touched.
  git -C $dst init --quiet
  if (-not (git -C $dst config --get remote.origin.url)) { git -C $dst remote add origin $repoUrl }
  Use-Https
  git -C $dst fetch --quiet origin $branch
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't reach GitHub (git exit $LASTEXITCODE). Check the internet connection." }
  git -C $dst checkout --quiet -f -B $branch "origin/$branch"
  git -C $dst branch --quiet --set-upstream-to "origin/$branch"
  Ok "Switched the existing copy to GitHub updates."
} else {
  git clone --quiet --branch $branch $repoUrl $dst
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't download from GitHub (git exit $LASTEXITCODE). Check the internet connection." }
  Ok "Downloaded."
}

Step "Installing the Roam Desk helper"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dst 'apps\desktop-helper\scripts\install.ps1')
if ($LASTEXITCODE -ne 0) { Fail "The helper didn't install (see the messages above)." }

if ($DesktopControl) {
  Step "Installing desktop control"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dst 'apps\desktop-control\scripts\install.ps1')
  if ($LASTEXITCODE -ne 0) { Note "Desktop control didn't install. Roam Desk still works without it." }
}

# ---------------------------------------------------------------- done
Step "Done"
Ok "Roam Desk runs in the background and starts when you sign in to Windows."
Write-Host @"

   Next, pair your phone:
   1. On the phone, install Tailscale from the Play Store and sign in with the SAME Tailscale account.
   2. Open the Roam Desk testing link you were sent, tap Accept, then install Roam Desk from the Play Store.
   3. On this PC, open the dashboard (http://127.0.0.1:8787), click 'Pair a device',
      then in the app tap 'Pair with my PC' and scan the QR code.

   To use it from a browser on another computer, sign that computer in to the same Tailscale account,
   open the 'Web client' address shown on the dashboard, and paste the pairing text from 'Pair a device'.

   To update later, click 'Update helper' on the dashboard (or 'Update PC helper' in the phone app's Settings).
"@

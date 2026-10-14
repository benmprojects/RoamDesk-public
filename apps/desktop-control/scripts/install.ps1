# Builds the desktop-control server into the plugin and installs (or updates) it in Claude Code for this user.
# Run again after changing the code. Restart Claude Code sessions afterwards to pick it up.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "plugin\bin"

Write-Host "Building..."
dotnet publish (Join-Path $root "src\DesktopControl\DesktopControl.csproj") -c Release -o $bin --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "Build failed." }

Write-Host "Checking the plugin..."
claude plugin validate $root
if ($LASTEXITCODE -ne 0) { throw "Plugin check failed." }

$markets = claude plugin marketplace list 2>&1 | Out-String
if ($markets -notmatch "claude-anywhere-local") { claude plugin marketplace add $root }
else { claude plugin marketplace update claude-anywhere-local }

$installed = claude plugin list 2>&1 | Out-String
if ($installed -match "desktop-control@claude-anywhere-local") { claude plugin update desktop-control@claude-anywhere-local }
else { claude plugin install desktop-control@claude-anywhere-local }

Write-Host "Done. Start a new Claude Code session to use it."

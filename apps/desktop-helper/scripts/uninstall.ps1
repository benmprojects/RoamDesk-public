# Removes the sign-in task and stops the helper. Paired phones, config and audit logs are kept;
# delete %APPDATA%\ClaudeAnywhere and %LOCALAPPDATA%\ClaudeAnywhere yourself to remove them.
$taskName = 'Roam Desk Helper'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed '$taskName'."
} else {
  Write-Host "'$taskName' isn't installed."
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*desktop-helper*main.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped helper (PID $($_.ProcessId))." }

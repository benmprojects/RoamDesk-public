' Starts the Roam Desk helper with no visible window and waits for it to exit
' (so Task Scheduler's restart-on-failure works). Output is appended to helper.log.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
helperDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
mainJs = helperDir & "\dist\apps\desktop-helper\src\main.js"
logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\ClaudeAnywhere"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logFile = logDir & "\helper.log"
sh.CurrentDirectory = helperDir
cmd = "cmd.exe /c node """ & mainJs & """ >> """ & logFile & """ 2>&1"
exitCode = sh.Run(cmd, 0, True)
WScript.Quit exitCode

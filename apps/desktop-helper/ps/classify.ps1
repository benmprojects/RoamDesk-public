# Long-lived PowerShell AST inspector for the Roam Desk policy engine.
# Reads one base64 (UTF-8) script per line on stdin; writes one compact JSON line per input on stdout.
# It only PARSES — nothing is ever executed.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$L = [System.Management.Automation.Language.Ast]

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim()))
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)

    $commands = New-Object System.Collections.ArrayList
    foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
      $name = $c.GetCommandName()
      $cargs = New-Object System.Collections.ArrayList
      foreach ($e in ($c.CommandElements | Select-Object -Skip 1)) { [void]$cargs.Add($e.Extent.Text) }
      [void]$commands.Add([ordered]@{
        name = $name
        args = $cargs.ToArray()
        dynamic = ($null -eq $name)
        invocation = $c.InvocationOperator.ToString()
      })
    }
    $members = New-Object System.Collections.ArrayList
    foreach ($m in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
      [void]$members.Add($m.Member.Extent.Text)
    }
    $redirections = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst] }, $true)).Count
    $result = [ordered]@{
      ok = ($errors.Count -eq 0)
      errors = @($errors | ForEach-Object { $_.Message })
      commands = $commands.ToArray()
      members = $members.ToArray()
      redirections = $redirections
    }
    ConvertTo-Json -InputObject $result -Compress -Depth 6
  } catch {
    ConvertTo-Json -InputObject ([ordered]@{ ok = $false; errors = @($_.Exception.Message); commands = @(); members = @(); redirections = 0 }) -Compress
  }
}

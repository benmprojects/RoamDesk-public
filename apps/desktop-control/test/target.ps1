# A window that belongs to the smoke test, so the test never types into the user's own apps.
# Save writes the text box to -Out. The test closes it by process id.
param([Parameter(Mandatory)] [string] $Out)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = "DesktopControl Test Target"
$form.Size = New-Object System.Drawing.Size(640, 360)
$form.StartPosition = "CenterScreen"
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.AccessibleName = "Test text"
$box.Font = New-Object System.Drawing.Font("Segoe UI", 14)
$box.SetBounds(16, 16, 590, 220)
$save = New-Object System.Windows.Forms.Button
$save.Text = "Save"
$save.SetBounds(16, 250, 120, 40)
$save.Add_Click({ [IO.File]::WriteAllText($Out, $box.Text); $form.Text = "DesktopControl Test Target - saved" })
$form.Controls.AddRange(@($box, $save))
$form.Add_Shown({ $form.Activate() })
# Application.Run rather than ShowDialog, which would make PowerShell's console window the form's owner.
[System.Windows.Forms.Application]::Run($form)

# Run this in a normal (non-admin is fine) PowerShell, AFTER closing every
# VS Code / Claude Code window. This moves ALL VS Code extensions and user
# settings/data to M:, not just Claude's extension.
#
# What it does:
#   1. Safety check: aborts if Code.exe or claude.exe is still running
#   2. Copies %USERPROFILE%\.vscode\extensions -> M:\vscode-extensions
#   3. Copies %APPDATA%\Code (settings, keybindings, extension global storage) -> M:\vscode-data
#   4. Edits your Start Menu "Visual Studio Code" shortcut to launch with
#      --extensions-dir and --user-data-dir pointing at M:
#
# It does NOT delete the old C: folders. After running this, launch VS Code
# from the edited shortcut, confirm Claude Code and your other extensions
# still work, THEN delete the old folders yourself:
#   Remove-Item "$env:USERPROFILE\.vscode\extensions" -Recurse -Force
#   Remove-Item "$env:APPDATA\Code" -Recurse -Force

$ErrorActionPreference = "Stop"

$running = Get-Process code, claude -ErrorAction SilentlyContinue
if ($running) {
    Write-Error "VS Code or Claude is still running (PID $($running.Id -join ', ')). Close all windows first."
    exit 1
}

New-Item -ItemType Directory -Force -Path "M:\vscode-extensions" | Out-Null
New-Item -ItemType Directory -Force -Path "M:\vscode-data" | Out-Null

Write-Output "Copying extensions..."
robocopy "$env:USERPROFILE\.vscode\extensions" "M:\vscode-extensions" /MIR /NFL /NDL /NJH

Write-Output "Copying user data (settings, keybindings, extension storage)..."
robocopy "$env:APPDATA\Code" "M:\vscode-data" /MIR /NFL /NDL /NJH

$lnkPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Visual Studio Code\Visual Studio Code.lnk"
Write-Output "Updating shortcut: $lnkPath"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$exeTarget = $shortcut.TargetPath
$shortcut.Arguments = '--extensions-dir "M:\vscode-extensions" --user-data-dir "M:\vscode-data"'
$shortcut.Save()

Write-Output ""
Write-Output "Done. Launch VS Code from the Start Menu shortcut (not a taskbar pin/search"
Write-Output "result that might bypass it), confirm Claude Code loads, then delete the old"
Write-Output "folders on C: as shown in the comment at the top of this script."

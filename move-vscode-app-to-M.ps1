# Run this AFTER closing every VS Code / Claude Code window.
# This moves the VS Code APPLICATION itself (Code.exe and friends) to M:.
# Note: this is separate from move-vscode-to-M.ps1, which already moved your
# extensions and user data/settings to M:\vscode-extensions and M:\vscode-data.
# If you haven't run that one yet, run it too (order doesn't matter).
#
# What it does:
#   1. Safety check: aborts if Code.exe or claude.exe is still running
#   2. Copies %LOCALAPPDATA%\Programs\Microsoft VS Code -> M:\Programs\Microsoft VS Code
#   3. Repoints the Start Menu shortcut to the new Code.exe
#   4. Deletes the old C: copy

$ErrorActionPreference = "Stop"

$running = Get-Process code, claude -ErrorAction SilentlyContinue
if ($running) {
    Write-Error "VS Code or Claude is still running (PID $($running.Id -join ', ')). Close all windows first."
    exit 1
}

$src = "$env:LOCALAPPDATA\Programs\Microsoft VS Code"
$dest = "M:\Programs\Microsoft VS Code"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Write-Output "Copying VS Code app..."
robocopy $src $dest /MIR /NFL /NDL /NJH

$newExe = Join-Path $dest "Code.exe"
if (-not (Test-Path $newExe)) {
    Write-Error "Code.exe not found at $newExe after copy - aborting, NOT deleting old copy."
    exit 1
}

$lnkPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Visual Studio Code\Visual Studio Code.lnk"
if (Test-Path $lnkPath) {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnkPath)
    # Preserve the --extensions-dir/--user-data-dir args from the earlier VS Code data move, if present
    $sc.TargetPath = $newExe
    $sc.WorkingDirectory = $dest
    $sc.Save()
    Write-Output "Shortcut repointed: $lnkPath -> $newExe"
}

Remove-Item $src -Recurse -Force
Write-Output ""
Write-Output "Done. Old C: copy removed. Launch VS Code from the Start Menu shortcut to verify."

# Run this in an elevated (Administrator) PowerShell, AFTER closing every
# VS Code / Claude Code window (they spawn node.exe child processes that
# will otherwise lock the files and abort the uninstall).
#
# What it does:
#   1. Safety check: aborts if any node.exe is still running
#   2. Downloads the exact currently-installed Node version (v24.16.0 x64) from nodejs.org
#   3. Uninstalls Node.js from C:\Program Files\nodejs
#   4. Installs the same version to M:\nodejs
#   5. Swaps M:\nodejs for C:\Program Files\nodejs in the system PATH

$ErrorActionPreference = "Stop"

$running = Get-Process node -ErrorAction SilentlyContinue
if ($running) {
    Write-Error "node.exe is still running (PID $($running.Id -join ', ')). Close all VS Code/Claude Code windows first."
    exit 1
}

$msiPath = "$env:TEMP\node-v24.16.0-x64.msi"
Write-Output "Downloading Node v24.16.0 x64 installer..."
Invoke-WebRequest -Uri "https://nodejs.org/dist/v24.16.0/node-v24.16.0-x64.msi" -OutFile $msiPath -UseBasicParsing

Write-Output "Uninstalling old Node.js from C:\Program Files\nodejs..."
Start-Process msiexec.exe -ArgumentList "/x {8E3EF5A2-585E-453B-B16C-B46E05A62DAC} /qn /norestart" -Wait

Write-Output "Installing Node.js to M:\nodejs..."
New-Item -ItemType Directory -Force -Path "M:\nodejs" | Out-Null
Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" INSTALLDIR=`"M:\nodejs`" /qn /norestart" -Wait

Write-Output "Updating system PATH..."
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$parts = $machinePath -split ";" | Where-Object { $_ -notlike "*\Program Files\nodejs*" }
if ($parts -notcontains "M:\nodejs\") { $parts += "M:\nodejs\" }
[Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "Machine")

Remove-Item $msiPath -Force -ErrorAction SilentlyContinue

Write-Output ""
Write-Output "Done. Close and reopen PowerShell/VS Code, then verify with:"
Write-Output "  node --version"
Write-Output "  (Get-Command node).Source    # should show M:\nodejs\node.exe"
Write-Output ""
Write-Output "If C:\Program Files\nodejs still exists and is empty, you can delete it manually."

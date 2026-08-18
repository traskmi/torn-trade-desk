# Run this in an elevated (Administrator) PowerShell.
Remove-Item "C:\Program Files (x86)\Pantheon" -Recurse -Force
Write-Output "Done. Freed ~7.6GB."
Test-Path "C:\Program Files (x86)\Pantheon"

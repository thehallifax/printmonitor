[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost
Assert-Administrator
Stop-MonitorTasks
Start-MonitorTasks
Write-Host "Printer Fleet Monitor scheduled tasks were restarted."

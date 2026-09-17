[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost
Assert-Administrator
Start-MonitorTasks
Write-Host "Printer Fleet Monitor scheduled tasks are enabled and started."

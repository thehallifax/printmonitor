[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost
Assert-Administrator
Stop-MonitorTasks
Write-Host "Printer Fleet Monitor scheduled tasks are disabled and stopped. Configuration, database, and logs were preserved."

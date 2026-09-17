[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost
Assert-Administrator

foreach ($service in @("web", "collector")) {
  $definition = Get-ServiceDefinition $service
  $task = Get-MonitorTask $definition.TaskName
  if ($null -ne $task) {
    Disable-ScheduledTask -InputObject $task | Out-Null
    Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
    Stop-ServiceHostProcess $service
    Unregister-ScheduledTask -TaskPath $script:TaskPath -TaskName $definition.TaskName -Confirm:$false
    Write-Host "Removed scheduled task: $($definition.DisplayName)"
  }
}

$firewallRule = Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue
if ($null -ne $firewallRule) {
  $firewallRule | Remove-NetFirewallRule
  Write-Host "Removed Printer Fleet Monitor firewall rule."
}
Remove-Item -LiteralPath $script:DeploymentStatePath -Force -ErrorAction SilentlyContinue
Write-Host "Windows process supervision was removed."
Write-Host "Preserved: .env, config\inventory.yaml, data (including SQLite), logs, private captures, and application source."

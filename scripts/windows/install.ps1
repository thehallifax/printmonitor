[CmdletBinding()]
param(
  [switch]$AllowInboundFirewall,
  [switch]$ExternalFirewallManaged
)

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost
Assert-Administrator
Assert-WindowsDeploymentTools
if ($AllowInboundFirewall -and $ExternalFirewallManaged) { throw "Choose either -AllowInboundFirewall or -ExternalFirewallManaged, not both." }

Write-Host "Printer Fleet Monitor Windows installation"
$node = Resolve-NodeExecutable
$npm = Resolve-NpmExecutable $node
$runtime = Assert-CompatibleRuntime $node $npm
Write-Host "Node.js $($runtime.Node), npm $($runtime.Npm) ($($runtime.Platform))"

New-Item -ItemType Directory -Path (Join-Path $script:ProjectRoot "data"), $script:LogDirectory, $script:RunDirectory, (Join-Path $script:ProjectRoot "config") -Force | Out-Null
$envPath = Join-Path $script:ProjectRoot ".env"
$inventoryPath = Join-Path $script:ProjectRoot "config\inventory.yaml"
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath (Join-Path $script:ProjectRoot ".env.example") -Destination $envPath
  Write-Host "Created .env. Set a read-only SNMP community before completing installation."
}
if (-not (Test-Path -LiteralPath $inventoryPath)) {
  Copy-Item -LiteralPath (Join-Path $script:ProjectRoot "config\inventory.example.yaml") -Destination $inventoryPath
  Write-Host "Created config\inventory.yaml. Replace the fictional inventory before completing installation."
}
Protect-EnvironmentFile $envPath

Set-Location -LiteralPath $script:ProjectRoot
Invoke-ProjectNpm $node $npm @("ci")
Invoke-ProjectNpm $node $npm @("run", "build")
& $node (Join-Path $script:ProjectRoot "scripts\project-env.mjs") validate $script:ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "Configuration validation failed. Correct .env and config\inventory.yaml, then rerun install.ps1." }

$configuration = Read-RuntimeConfiguration $node
Grant-ServiceFilesystemAccess $configuration $node
Protect-EnvironmentFile $envPath
$existingFirewall = Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue
$firewallManaged = $false
if (Test-LoopbackHost ([string]$configuration.host)) {
  if ($null -ne $existingFirewall) { $existingFirewall | Remove-NetFirewallRule }
  Write-Host "Loopback listen address detected; no inbound firewall rule is required."
} else {
  if (-not $AllowInboundFirewall -and -not $ExternalFirewallManaged -and $null -eq $existingFirewall) {
    throw "HOST=$($configuration.host) is not loopback. Rerun with -AllowInboundFirewall to create a narrow inbound rule, or -ExternalFirewallManaged to explicitly retain external firewall management."
  }
  if ($ExternalFirewallManaged) {
    if ($null -ne $existingFirewall) { $existingFirewall | Remove-NetFirewallRule }
    Write-Host "No firewall rule was created; external firewall management was explicitly selected."
  } elseif ($AllowInboundFirewall -or $null -ne $existingFirewall) {
    if ($null -ne $existingFirewall) { $existingFirewall | Remove-NetFirewallRule }
    $localAddress = Resolve-FirewallLocalAddress ([string]$configuration.host)
    New-NetFirewallRule -DisplayName $script:FirewallRuleName -Group $script:FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort ([int]$configuration.port) -LocalAddress $localAddress -Program $node -Profile Domain,Private | Out-Null
    $firewallManaged = $true
    Write-Host "Created inbound firewall rule for TCP port $($configuration.port) on Domain/Private profiles."
  }
}

$account = $script:ServiceAccount
$powerShell = Get-PowerShellExecutable
$serviceHost = Join-Path $PSScriptRoot "service-host.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited

foreach ($service in @("web", "collector")) {
  $definition = Get-ServiceDefinition $service
  $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $(Quote-TaskArgument $serviceHost) -Service $service -ProjectRoot $(Quote-TaskArgument $script:ProjectRoot) -NodeExecutable $(Quote-TaskArgument $node)"
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $script:ProjectRoot
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Printer Fleet Monitor $($definition.DisplayName); configuration is loaded from the repository .env at runtime."
  $existingTask = Get-MonitorTask $definition.TaskName
  if ($null -ne $existingTask) {
    Disable-ScheduledTask -InputObject $existingTask | Out-Null
    Stop-ScheduledTask -InputObject $existingTask -ErrorAction SilentlyContinue
  }
  Register-ScheduledTask -TaskPath $script:TaskPath -TaskName $definition.TaskName -InputObject $task -Force | Out-Null
}

Write-DeploymentState $node $account $firewallManaged
Start-MonitorTasks
Write-Host "Installation complete. The Web/API and Collector tasks are installed for automatic startup under $account."
Write-Host "Run scripts\windows\status.ps1 to verify service state and log paths."

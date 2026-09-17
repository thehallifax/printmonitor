Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:TaskPath = "\"
$script:WebTaskName = "Printer Fleet Monitor - Web API"
$script:CollectorTaskName = "Printer Fleet Monitor - Collector"
$script:ServiceAccount = "NT AUTHORITY\NETWORK SERVICE"
$script:ServiceAccountSid = "S-1-5-20"
$script:FirewallRuleName = "Printer Fleet Monitor Web API"
$script:FirewallGroup = "Printer Fleet Monitor"
$script:LogDirectory = Join-Path $script:ProjectRoot "data\log"
$script:RunDirectory = Join-Path $script:ProjectRoot "data\run"
$script:DeploymentStatePath = Join-Path $script:ProjectRoot ".windows-deployment.json"

function Assert-WindowsHost {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "This command supports Windows only. Use the scripts in scripts/ on macOS."
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Printer Fleet Monitor requires a 64-bit Windows installation."
  }
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
  if (-not (Test-Administrator)) {
    throw "Run this command from an elevated PowerShell window (Run as administrator). The installed monitor processes themselves run with a limited user token."
  }
}

function Assert-WindowsDeploymentTools {
  $requiredCommands = @(
    "Get-ScheduledTask", "Register-ScheduledTask", "New-ScheduledTask", "New-ScheduledTaskAction",
    "New-ScheduledTaskTrigger", "New-ScheduledTaskSettingsSet", "New-ScheduledTaskPrincipal",
    "Get-NetFirewallRule", "New-NetFirewallRule", "Remove-NetFirewallRule", "icacls.exe", "taskkill.exe"
  )
  foreach ($command in $requiredCommands) {
    if ($null -eq (Get-Command $command -ErrorAction SilentlyContinue)) {
      throw "Required Windows deployment command is unavailable: $command. Install/enable the built-in ScheduledTasks and NetSecurity management components."
    }
  }
}

function Get-DeploymentState {
  if (-not (Test-Path -LiteralPath $script:DeploymentStatePath -PathType Leaf)) { return $null }
  try {
    return Get-Content -LiteralPath $script:DeploymentStatePath -Raw | ConvertFrom-Json
  } catch {
    throw "The Windows deployment state file is invalid: $script:DeploymentStatePath"
  }
}

function Resolve-NodeExecutable {
  $candidates = New-Object System.Collections.Generic.List[string]
  $state = Get-DeploymentState
  if ($null -ne $state -and $state.PSObject.Properties.Name -contains "nodeExecutable") {
    $candidates.Add([string]$state.nodeExecutable)
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) { $candidates.Add($command.Source) }
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles "nodejs\node.exe")) }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  throw "Unable to find Node.js. Install 64-bit Node.js 22.12 or newer and ensure node.exe is on PATH."
}

function Resolve-NpmExecutable([string]$NodeExecutable) {
  $besideNode = Join-Path (Split-Path -Parent $NodeExecutable) "npm.cmd"
  if (Test-Path -LiteralPath $besideNode -PathType Leaf) { return $besideNode }
  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }
  throw "Unable to find npm beside $NodeExecutable or on PATH. Reinstall Node.js with npm."
}

function Assert-CompatibleRuntime([string]$NodeExecutable, [string]$NpmExecutable) {
  $platform = (& $NodeExecutable -p "process.platform + ' ' + process.arch").Trim()
  if ($LASTEXITCODE -ne 0 -or $platform -ne "win32 x64") {
    throw "Printer Fleet Monitor currently requires 64-bit Windows Node.js (win32 x64); detected '$platform'."
  }
  $nodeText = (& $NodeExecutable --version).Trim().TrimStart("v")
  $npmText = (& $NpmExecutable --version).Trim()
  try {
    $nodeVersion = [Version]($nodeText.Split("-")[0])
    $npmVersion = [Version]($npmText.Split("-")[0])
  } catch {
    throw "Unable to parse Node.js/npm versions: Node '$nodeText', npm '$npmText'."
  }
  if ($nodeVersion -lt [Version]"22.12.0") { throw "Node.js 22.12 or newer is required; found $nodeText." }
  if ($npmVersion -lt [Version]"10.0.0") { throw "npm 10 or newer is required; found $npmText." }
  return [pscustomobject]@{ Node = $nodeText; Npm = $npmText; Platform = $platform }
}

function Invoke-ProjectNpm([string]$NodeExecutable, [string]$NpmExecutable, [string[]]$Arguments) {
  $oldPath = $env:Path
  try {
    $env:Path = (Split-Path -Parent $NodeExecutable) + [IO.Path]::PathSeparator + $oldPath
    & $NpmExecutable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
  } finally {
    $env:Path = $oldPath
  }
}

function Read-RuntimeConfiguration([string]$NodeExecutable) {
  $helper = Join-Path $script:ProjectRoot "scripts\project-env.mjs"
  $json = & $NodeExecutable $helper runtime-config $script:ProjectRoot
  if ($LASTEXITCODE -ne 0) { throw "Unable to read Printer Fleet Monitor runtime configuration." }
  return ($json | Out-String | ConvertFrom-Json)
}

function Test-LoopbackHost([string]$HostName) {
  return $HostName -in @("127.0.0.1", "::1", "localhost")
}

function Resolve-FirewallLocalAddress([string]$HostName) {
  if ($HostName -in @("0.0.0.0", "::")) { return "Any" }
  $parsedAddress = $null
  if ([Net.IPAddress]::TryParse($HostName, [ref]$parsedAddress)) { return $parsedAddress.ToString() }
  return "Any"
}

function Get-ServiceDefinition([ValidateSet("web", "collector")][string]$Service) {
  if ($Service -eq "web") {
    return [pscustomobject]@{ Service = "web"; TaskName = $script:WebTaskName; DisplayName = "Web/API"; PidFile = (Join-Path $script:RunDirectory "web.pid") }
  }
  return [pscustomobject]@{ Service = "collector"; TaskName = $script:CollectorTaskName; DisplayName = "Collector"; PidFile = (Join-Path $script:RunDirectory "collector.pid") }
}

function Get-MonitorTask([string]$TaskName) {
  return Get-ScheduledTask -TaskPath $script:TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Assert-TasksInstalled {
  $web = Get-MonitorTask $script:WebTaskName
  $collector = Get-MonitorTask $script:CollectorTaskName
  if ($null -eq $web -or $null -eq $collector) {
    throw "Printer Fleet Monitor scheduled tasks are not fully installed. Run scripts\windows\install.ps1 from an elevated PowerShell window."
  }
}

function Get-PowerShellExecutable {
  $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf) { return $windowsPowerShell }
  $current = (Get-Process -Id $PID).Path
  if ($current -and (Test-Path -LiteralPath $current -PathType Leaf)) { return $current }
  throw "Unable to resolve the PowerShell executable used to host scheduled tasks."
}

function Quote-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Stop-ServiceHostProcess([ValidateSet("web", "collector")][string]$Service) {
  $definition = Get-ServiceDefinition $Service
  if (-not (Test-Path -LiteralPath $definition.PidFile -PathType Leaf)) { return }
  $pidText = (Get-Content -LiteralPath $definition.PidFile -Raw).Trim()
  $hostPid = 0
  if ([int]::TryParse($pidText, [ref]$hostPid)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $hostPid" -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.CommandLine -like "*service-host.ps1*" -and $process.CommandLine -like "*$script:ProjectRoot*") {
      & taskkill.exe /PID $hostPid /T /F | Out-Null
    }
  }
  Remove-Item -LiteralPath $definition.PidFile -Force -ErrorAction SilentlyContinue
}

function Stop-MonitorTasks {
  Assert-TasksInstalled
  foreach ($service in @("web", "collector")) {
    $definition = Get-ServiceDefinition $service
    $task = Get-MonitorTask $definition.TaskName
    Disable-ScheduledTask -InputObject $task | Out-Null
    Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $running = @(@($script:WebTaskName, $script:CollectorTaskName) | ForEach-Object { Get-MonitorTask $_ } | Where-Object { $_.State -eq "Running" })
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  Stop-ServiceHostProcess web
  Stop-ServiceHostProcess collector
}

function Start-MonitorTasks {
  Assert-TasksInstalled
  foreach ($taskName in @($script:WebTaskName, $script:CollectorTaskName)) {
    $task = Get-MonitorTask $taskName
    if ($task.State -eq "Disabled") {
      Enable-ScheduledTask -InputObject $task | Out-Null
      $task = Get-MonitorTask $taskName
    }
    if ($task.State -ne "Running") { Start-ScheduledTask -InputObject $task }
  }
}

function Protect-EnvironmentFile([string]$Path) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  & icacls.exe $Path /inheritance:r /grant:r "*$($sid):(M)" "*$($script:ServiceAccountSid):(R)" "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to restrict permissions on $Path." }
}

function Grant-ServiceFilesystemAccess($Configuration, [string]$NodeExecutable) {
  & icacls.exe $script:ProjectRoot /grant:r "*$($script:ServiceAccountSid):(OI)(CI)(RX)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to grant the service account read access to $script:ProjectRoot." }
  $nodeDirectory = Split-Path -Parent $NodeExecutable
  & icacls.exe $nodeDirectory /grant:r "*$($script:ServiceAccountSid):(OI)(CI)(RX)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to grant the service account read access to $nodeDirectory." }

  $writeDirectories = @(
    [IO.Path]::GetFullPath((Join-Path $script:ProjectRoot "data"))
    [IO.Path]::GetFullPath((Split-Path -Parent ([string]$Configuration.databasePath)))
  ) | Select-Object -Unique
  foreach ($directory in $writeDirectories) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    & icacls.exe $directory /grant:r "*$($script:ServiceAccountSid):(OI)(CI)(M)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to grant the service account modify access to $directory." }
  }

  $inventoryPath = [string]$Configuration.inventoryPath
  & icacls.exe $inventoryPath /grant:r "*$($script:ServiceAccountSid):(R)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to grant the service account read access to $inventoryPath." }
}

function Write-DeploymentState([string]$NodeExecutable, [string]$Account, [bool]$FirewallManaged) {
  $state = [ordered]@{
    version = 1
    projectRoot = $script:ProjectRoot
    nodeExecutable = $NodeExecutable
    account = $Account
    taskPath = $script:TaskPath
    firewallManaged = $FirewallManaged
    installedAt = [DateTime]::UtcNow.ToString("o")
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $script:DeploymentStatePath -Encoding UTF8
}

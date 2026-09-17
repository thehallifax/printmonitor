[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost

function Show-TaskStatus([ValidateSet("web", "collector")][string]$Service) {
  $definition = Get-ServiceDefinition $Service
  $task = Get-MonitorTask $definition.TaskName
  if ($null -eq $task) {
    Write-Host "$($definition.DisplayName): not installed"
    return
  }
  $pidLabel = ""
  if (Test-Path -LiteralPath $definition.PidFile -PathType Leaf) {
    $pidText = (Get-Content -LiteralPath $definition.PidFile -Raw).Trim()
    $hostPid = 0
    if ([int]::TryParse($pidText, [ref]$hostPid) -and $null -ne (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)) {
      $pidLabel = " (host PID $hostPid)"
    }
  }
  $info = Get-ScheduledTaskInfo -InputObject $task -ErrorAction SilentlyContinue
  $resultLabel = if ($null -ne $info) { "; last result $($info.LastTaskResult)" } else { "" }
  Write-Host "$($definition.DisplayName): installed, $($task.State)$pidLabel$resultLabel"
}

Write-Host "Printer Fleet Monitor Windows status"
Show-TaskStatus web
Show-TaskStatus collector

try {
  $node = Resolve-NodeExecutable
  $configuration = Read-RuntimeConfiguration $node
  Write-Host "Listen address: $($configuration.host):$($configuration.port)"
  Write-Host "Dashboard: $($configuration.dashboardUrl)"
  if ($null -ne $configuration.dashboardRedirectUrl) { Write-Host "Root redirect: $($configuration.dashboardRedirectUrl)" }
} catch {
  Write-Warning $_.Exception.Message
}

Write-Host "Web stdout: $(Join-Path $script:LogDirectory 'web.stdout.log')"
Write-Host "Web stderr: $(Join-Path $script:LogDirectory 'web.stderr.log')"
Write-Host "Collector stdout: $(Join-Path $script:LogDirectory 'collector.stdout.log')"
Write-Host "Collector stderr: $(Join-Path $script:LogDirectory 'collector.stderr.log')"

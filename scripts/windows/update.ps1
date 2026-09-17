[CmdletBinding()]
param(
  [switch]$VerboseOutput,
  [switch]$SkipTests
)

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost
Assert-Administrator

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -eq $git) { throw "Update stopped: Git for Windows is required and git.exe is not on PATH." }
Set-Location -LiteralPath $script:ProjectRoot
$repositoryRoot = (& $git.Source rev-parse --show-toplevel 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) { throw "Update stopped: $script:ProjectRoot is not a Git repository." }
if ([IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\') -ine $script:ProjectRoot.TrimEnd('\')) { throw "Update stopped: run the updater from the Printer Fleet Monitor repository root." }

$trackedChanges = (& $git.Source status --porcelain --untracked-files=no | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Update stopped: unable to inspect repository state." }
if ($trackedChanges) {
  if ($VerboseOutput) { Write-Host $trackedChanges -ForegroundColor Red }
  throw "Update stopped: tracked local changes are present. Commit or resolve them first; nothing was discarded."
}

$webInstalled = $null -ne (Get-MonitorTask $script:WebTaskName)
$collectorInstalled = $null -ne (Get-MonitorTask $script:CollectorTaskName)
if ($webInstalled -ne $collectorInstalled) { throw "Update stopped: only one scheduled task is installed. Run install.ps1 to repair the deployment." }

$node = Resolve-NodeExecutable
$npm = Resolve-NpmExecutable $node
$runtime = Assert-CompatibleRuntime $node $npm
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("printer-fleet-update-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$restartStage = $false

function Invoke-UpdateStep([string]$Label, [scriptblock]$Action) {
  $log = Join-Path $temporaryDirectory (($Label -replace '[^A-Za-z0-9]+', '-') + ".log")
  try {
    $output = & $Action 2>&1 | Out-String
    $output | Set-Content -LiteralPath $log -Encoding UTF8
    if ($VerboseOutput -and $output) { Write-Host $output.TrimEnd() }
    Write-Host "OK: $Label"
  } catch {
    $_ | Out-String | Add-Content -LiteralPath $log
    Get-Content -LiteralPath $log | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    if ($restartStage) {
      throw "Update failed during restart verification. Run status.ps1 and inspect the relevant logs."
    }
    throw "Update stopped because '$Label' failed. Installed tasks were not restarted."
  }
}

try {
  Invoke-UpdateStep "Git fast-forward update" {
    & $git.Source pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed with exit code $LASTEXITCODE." }
  }
  Invoke-UpdateStep "Dependency installation" { Invoke-ProjectNpm $node $npm @("ci") }
  Invoke-UpdateStep "Build" { Invoke-ProjectNpm $node $npm @("run", "build") }
  if (-not $SkipTests) {
    Invoke-UpdateStep "Tests" { Invoke-ProjectNpm $node $npm @("test") }
  } else {
    Write-Host "Tests skipped by explicit -SkipTests request."
  }

  if ($webInstalled -and $collectorInstalled) {
    $restartStage = $true
    Invoke-UpdateStep "Scheduled task restart" {
      Stop-MonitorTasks
      Start-MonitorTasks
      Start-Sleep -Seconds 2
      foreach ($taskName in @($script:WebTaskName, $script:CollectorTaskName)) {
        $task = Get-MonitorTask $taskName
        if ($null -eq $task -or $task.State -ne "Running") { throw "$taskName is not running." }
      }
    }
    Invoke-UpdateStep "Local API health check" {
      $configuration = Read-RuntimeConfiguration $node
      $healthUrl = ([string]$configuration.dashboardUrl).TrimEnd('/') + "/api/health"
      $healthy = $false
      for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
          $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
          if ($response.status -eq "ok") { $healthy = $true; break }
        } catch {
          Start-Sleep -Seconds 1
        }
      }
      if (-not $healthy) { throw "The local API did not return healthy JSON from $healthUrl." }
    }
  } else {
    Write-Host "Build ready; scheduled tasks are not installed, so restart and health verification were skipped."
  }
} finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Printer Fleet Monitor update completed with Node.js $($runtime.Node)."

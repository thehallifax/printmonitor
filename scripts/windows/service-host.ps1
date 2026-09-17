[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("web", "collector")]
  [string]$Service,
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,
  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$logDirectory = Join-Path $ProjectRoot "data\log"
$runDirectory = Join-Path $ProjectRoot "data\run"
$serviceEntry = Join-Path $ProjectRoot "scripts\service-entry.mjs"
$stdoutLog = Join-Path $logDirectory "$Service.stdout.log"
$stderrLog = Join-Path $logDirectory "$Service.stderr.log"
$pidFile = Join-Path $runDirectory "$Service.pid"

New-Item -ItemType Directory -Path $logDirectory, $runDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw "Configured Node.js executable not found: $NodeExecutable" }
if (-not (Test-Path -LiteralPath $serviceEntry -PathType Leaf)) { throw "Service entry point not found: $serviceEntry" }

$PID.ToString() | Set-Content -LiteralPath $pidFile -Encoding ASCII
$startedAt = [DateTime]::UtcNow.ToString("o")
[IO.File]::AppendAllText($stdoutLog, "[$startedAt] Scheduled service host starting $Service.`r`n")

$exitCode = 1
try {
  Set-Location -LiteralPath $ProjectRoot
  $commandLine = '""{0}" "{1}" {2} "{3}" 1>>"{4}" 2>>"{5}""' -f $NodeExecutable, $serviceEntry, $Service, $ProjectRoot, $stdoutLog, $stderrLog
  & $env:ComSpec /d /s /c $commandLine
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $failedAt = [DateTime]::UtcNow.ToString("o")
    [IO.File]::AppendAllText($stderrLog, "[$failedAt] $Service exited with code $exitCode; Task Scheduler will apply its restart policy.`r`n")
  }
} catch {
  $failedAt = [DateTime]::UtcNow.ToString("o")
  [IO.File]::AppendAllText($stderrLog, "[$failedAt] $($_.Exception.Message)`r`n")
  $exitCode = 1
} finally {
  if (Test-Path -LiteralPath $pidFile) {
    $recordedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($recordedPid -eq $PID.ToString()) { Remove-Item -LiteralPath $pidFile -Force }
  }
}

exit $exitCode

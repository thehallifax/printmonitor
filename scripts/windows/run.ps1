[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "common.ps1")
Assert-WindowsHost
$node = Resolve-NodeExecutable
$npm = Resolve-NpmExecutable $node
$runtime = Assert-CompatibleRuntime $node $npm
Write-Host "Running Printer Fleet Monitor in the foreground with Node.js $($runtime.Node). Keep this PowerShell window open."

& $node (Join-Path $script:ProjectRoot "scripts\project-env.mjs") validate $script:ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "Configuration validation failed." }
Set-Location -LiteralPath $script:ProjectRoot
& $node (Join-Path $script:ProjectRoot "scripts\run.mjs") $script:ProjectRoot
exit $LASTEXITCODE

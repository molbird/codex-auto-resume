$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
& $taskNode (Join-Path $PSScriptRoot 'codex-auto-resume.mjs') --stop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$taskLock = Join-Path $PSScriptRoot 'runtime\monitor.lock'
for ($taskIndex = 0; $taskIndex -lt 35; $taskIndex++) {
    if (-not (Test-Path -LiteralPath $taskLock)) {
        Write-Host 'Monitor stopped. Automatic keep-awake has been released.'
        exit 0
    }
    $taskExisting = Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json
    if (-not (Get-Process -Id $taskExisting.pid -ErrorAction SilentlyContinue)) {
        Write-Host 'Monitor is no longer running.'
        exit 0
    }
    Start-Sleep -Seconds 1
}
Write-Host 'Stop requested. The monitor will exit when its current request finishes.'

param(
    [switch]$Foreground,
    [switch]$Check,
    [switch]$NoKeepAwake
)
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskMajor = [int]((& $taskNode --version).TrimStart('v').Split('.')[0])
if ($taskMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
$taskScript = Join-Path $PSScriptRoot 'codex-auto-resume.mjs'

if ($Check) {
    & $taskNode $taskScript --check
    exit $LASTEXITCODE
}
if ($Foreground) {
    & (Join-Path $PSScriptRoot 'Run-Monitor.ps1') -NodePath $taskNode -NoKeepAwake:$NoKeepAwake
    exit $LASTEXITCODE
}

$taskRuntime = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskLock = Join-Path $taskRuntime 'monitor.lock'
if (Test-Path -LiteralPath $taskLock) {
    $taskExisting = Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json
    if (Get-Process -Id $taskExisting.pid -ErrorAction SilentlyContinue) {
        Write-Host "Monitor is already running (PID $($taskExisting.pid))."
        exit 0
    }
}
$taskArguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    ('"' + (Join-Path $PSScriptRoot 'Run-Monitor.ps1') + '"'),
    '-NodePath', ('"' + $taskNode + '"'))
if ($NoKeepAwake) { $taskArguments += '-NoKeepAwake' }
$taskProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $taskArguments `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskRuntime 'launcher.log') `
    -RedirectStandardError (Join-Path $taskRuntime 'launcher-error.log')
for ($taskIndex = 0; $taskIndex -lt 30; $taskIndex++) {
    Start-Sleep -Milliseconds 200
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) {
        throw "Monitor exited. Read $(Join-Path $taskRuntime 'launcher-error.log')"
    }
    if (Test-Path -LiteralPath $taskLock) {
        $taskStarted = Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json
        Write-Host "Monitor started in the background (PID $($taskStarted.pid))."
        Write-Host "Log: $(Join-Path $taskRuntime 'monitor.log')"
        Write-Host 'Keep Codex open and signed in. Close this window if you like.'
        exit 0
    }
}
throw "Startup is taking longer than expected. Read $(Join-Path $taskRuntime 'launcher-error.log') before starting again."

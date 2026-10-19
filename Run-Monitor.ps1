param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [switch]$NoKeepAwake
)
$ErrorActionPreference = 'Stop'
$taskGuardEnabled = $false
$taskExitCode = 1
try {
    if (-not $NoKeepAwake) {
        Add-Type -Namespace CodexAutoResume -Name PowerGuard -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint flags);
'@
        $taskPowerResult = [CodexAutoResume.PowerGuard]::SetThreadExecutionState([uint32]2147483649)
        if ($taskPowerResult -eq 0) { Write-Warning 'Could not keep the computer awake; check Windows sleep settings.' }
        else { $taskGuardEnabled = $true }
    }
    & $NodePath (Join-Path $PSScriptRoot 'codex-auto-resume.mjs') --watch --quiet
    $taskExitCode = $LASTEXITCODE
} finally {
    if ($taskGuardEnabled) {
        [CodexAutoResume.PowerGuard]::SetThreadExecutionState([uint32]2147483648) | Out-Null
    }
}
exit $taskExitCode

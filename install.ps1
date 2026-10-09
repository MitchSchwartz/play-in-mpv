# Registers the native messaging helper so the extension can launch mpv (Windows).
# Per-user (HKCU) only - no admin rights needed. Safe to re-run; re-run if you move the repo.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HostName = 'local.play_in_mpv'
$ExtensionId = 'coiofchhcnfpogppabiheboajgpmhcki'  # fixed by the "key" in extension/manifest.json
$Dir = $PSScriptRoot
$HostPath = Join-Path $Dir 'play_in_mpv_host.bat'
$ManifestPath = Join-Path $Dir "$HostName.json"

if (-not (Test-Path -LiteralPath $HostPath)) {
    throw "Helper wrapper not found: $HostPath"
}

# --- Dependency checks: warn only, the user may install these afterwards ---

if ($env:MPV_PATH) {
    if (-not (Test-Path -LiteralPath $env:MPV_PATH)) {
        Write-Warning "MPV_PATH is set to '$env:MPV_PATH' but that file does not exist."
    }
} elseif (-not (Get-Command mpv -ErrorAction SilentlyContinue)) {
    Write-Warning "mpv not found on PATH - install it with: scoop bucket add extras; scoop install mpv (or set MPV_PATH to the full path of mpv.exe)"
}

# Mirrors play_in_mpv_host.bat: 'python' first, then 'py -3'. Actually runs each one,
# so the Microsoft Store 'python' stub (which only prints an error) counts as missing.
$PythonCandidates = @(
    @{ Exe = 'python'; Args = @('--version') },
    @{ Exe = 'py'; Args = @('-3', '--version') }
)
$PythonFound = $null
$PythonFailures = @()
foreach ($Candidate in $PythonCandidates) {
    $Label = "$($Candidate.Exe) $($Candidate.Args -join ' ')"
    $Output = ''
    $Ok = $false
    try {
        $ErrorActionPreference = 'Continue'
        $CandidateArgs = $Candidate.Args
        $Output = ((& $Candidate.Exe @CandidateArgs 2>&1 | ForEach-Object { $_.ToString() }) -join ' ').Trim()
        $Ok = ($LASTEXITCODE -eq 0) -and ($Output -match '^Python 3\.')
    } catch {
        $Output = $_.Exception.Message
    } finally {
        $ErrorActionPreference = 'Stop'
    }
    if ($Ok) { $PythonFound = "$Output ($($Candidate.Exe))"; break }
    $PythonFailures += "'$Label' failed: $Output"
}
if ($PythonFound) {
    Write-Host "Found $PythonFound"
} else {
    Write-Warning "No working Python 3 found. $($PythonFailures -join ' / ')"
    Write-Warning "Install Python 3 with either 'scoop install python' or 'uv python install 3.13 --default', so 'python' runs. The Microsoft Store 'python' alias is only a stub and will not work."
}

# --- Native messaging manifest ---

$Manifest = [ordered]@{
    name            = $HostName
    description     = 'Launch mpv for Play in mpv extension'
    path            = $HostPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Json = ConvertTo-Json -InputObject $Manifest
# UTF-8 without BOM (Windows PowerShell 5.1's -Encoding UTF8 would add one).
[System.IO.File]::WriteAllText($ManifestPath, $Json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Wrote $ManifestPath"

# --- Registry: each browser looks up the manifest path in the key's default value ---

$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)
foreach ($Key in $RegistryKeys) {
    if (-not (Test-Path -LiteralPath $Key)) {
        New-Item -Path $Key -Force | Out-Null
    }
    Set-Item -LiteralPath $Key -Value $ManifestPath
    Write-Host "Registered helper at $Key"
}

Write-Host "Now load $Dir\extension via chrome://extensions -> Developer mode -> Load unpacked, then restart the browser."

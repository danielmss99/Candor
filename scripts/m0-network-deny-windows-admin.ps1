[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$CorePath = "",
  [string]$ReleaseDir = "",
  [string]$ProofDir = "",
  [switch]$ValidateOnly,
  [switch]$NoWait,
  [switch]$KeepOpen
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot

function Test-Windows {
  return [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
  )
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-ProofPath([string]$PathValue, [string]$DefaultRelativePath) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $DefaultRelativePath))
  }
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $PathValue))
}

function Quote-ProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Write-JsonFile([string]$PathValue, $Value) {
  $json = $Value | ConvertTo-Json -Depth 20
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($PathValue, $json, $encoding)
}

function Get-LatestWindowsNetworkProof([string]$ProofDirectory) {
  if (-not (Test-Path -LiteralPath $ProofDirectory -PathType Container)) {
    return $null
  }

  $latest = Get-ChildItem -LiteralPath $ProofDirectory -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^m0-network-deny-windows-\d{8}-\d{6}\.json$' } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if ($null -eq $latest) {
    return $null
  }

  $payload = $null
  $parseError = $null
  try {
    $payload = Get-Content -LiteralPath $latest.FullName -Raw | ConvertFrom-Json
  } catch {
    $parseError = $_.Exception.Message
  }

  $ruleCount = 0
  if ($payload -and $payload.temporaryFirewallRules) {
    $ruleCount = @($payload.temporaryFirewallRules).Count
  }
  $tcpCount = 0
  if ($payload -and $payload.observedTcpConnections) {
    $tcpCount = @($payload.observedTcpConnections).Count
  }
  $udpCount = 0
  if ($payload -and $payload.observedUdpEndpoints) {
    $udpCount = @($payload.observedUdpEndpoints).Count
  }

  return [ordered]@{
    file = $latest.FullName
    fileName = $latest.Name
    modifiedUtc = $latest.LastWriteTimeUtc.ToString("o")
    parsed = ($null -ne $payload)
    parseError = $parseError
    ok = if ($payload) { [bool]$payload.ok } else { $false }
    administrator = if ($payload -and $payload.prerequisites) { [bool]$payload.prerequisites.administrator } else { $false }
    canCreateFirewallRules = if ($payload -and $payload.prerequisites) { [bool]$payload.prerequisites.canCreateFirewallRules } else { $false }
    ruleCount = $ruleCount
    observedTcpConnectionCount = $tcpCount
    observedUdpEndpointCount = $udpCount
    cleanupAttempted = if ($payload -and $payload.cleanup) { [bool]$payload.cleanup.attempted } else { $false }
    cleanupRuleGroupRemoved = if ($payload -and $payload.cleanup) { [bool]$payload.cleanup.ruleGroupRemoved } else { $false }
    error = if ($payload) { $payload.error } else { $null }
  }
}

function Invoke-ProofRunnerValidateOnly {
  $args = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $repoRoot "scripts\m0-network-deny-windows.ps1"),
    "-ValidateOnly"
  )
  if (-not [string]::IsNullOrWhiteSpace($AppPath)) {
    $args += @("-AppPath", $AppPath)
  }
  if (-not [string]::IsNullOrWhiteSpace($CorePath)) {
    $args += @("-CorePath", $CorePath)
  }
  if (-not [string]::IsNullOrWhiteSpace($ReleaseDir)) {
    $args += @("-ReleaseDir", $ReleaseDir)
  }
  if (-not [string]::IsNullOrWhiteSpace($ProofDir)) {
    $args += @("-ProofDir", $ProofDir)
  }

  $output = & powershell @args 2>&1
  $text = ($output | Out-String).Trim()
  $parsed = $null
  if (-not [string]::IsNullOrWhiteSpace($text)) {
    try {
      $parsed = $text | ConvertFrom-Json
    } catch {
      $parsed = $null
    }
  }

  return [ordered]@{
    exitCode = $LASTEXITCODE
    stdout = $text
    parsed = $parsed
  }
}

function Invoke-LocalCommand([string]$Label, [string]$Command, [string[]]$Arguments, [bool]$AllowFailure = $false) {
  Write-Host ""
  Write-Host "== $Label =="
  & $Command @Arguments
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "$Label failed with exit code $exitCode"
  }
  return [ordered]@{
    label = $Label
    command = @($Command) + $Arguments
    exitCode = $exitCode
    ok = ($exitCode -eq 0)
    allowFailure = $AllowFailure
  }
}

if (-not (Test-Windows)) {
  throw "M0 Windows network proof admin launcher can only run on Windows."
}

$resolvedProofDir = Resolve-ProofPath $ProofDir "release-v3\proofs"
New-Item -ItemType Directory -Force -Path $resolvedProofDir | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$receiptPath = Join-Path $resolvedProofDir "m0-network-deny-windows-admin-launcher-$timestamp.json"
$administrator = Test-Administrator
$validation = Invoke-ProofRunnerValidateOnly

if ($ValidateOnly) {
  $receipt = [ordered]@{
    ok = ($validation.exitCode -eq 0 -and $null -ne $validation.parsed -and $validation.parsed.ok -eq $true)
    proofKind = "m0-network-deny-windows-admin-launcher"
    mode = "admin-launcher-validate-only"
    validateOnlyIsNotNetworkProof = $true
    administrator = $administrator
    proofDir = $resolvedProofDir
    launcherReceiptPath = $receiptPath
    runnerValidation = $validation
    latestNetworkProof = Get-LatestWindowsNetworkProof $resolvedProofDir
  }
  Write-JsonFile $receiptPath $receipt
  $receipt | ConvertTo-Json -Depth 20
  if ($receipt.ok) {
    exit 0
  }
  exit 1
}

if ($validation.exitCode -ne 0 -or $null -eq $validation.parsed -or $validation.parsed.ok -ne $true) {
  throw "Windows network-deny runner validation failed. $($validation.stdout)"
}

$resolvedReleaseDir = [System.IO.Path]::GetFullPath([string]$validation.parsed.releaseDir)
$resolvedAppPath = [System.IO.Path]::GetFullPath([string]$validation.parsed.appPath)
$resolvedCorePath = [System.IO.Path]::GetFullPath([string]$validation.parsed.corePath)
$resolvedProofDir = [System.IO.Path]::GetFullPath([string]$validation.parsed.proofDir)

if ($administrator) {
  $steps = New-Object System.Collections.Generic.List[object]
  $ok = $false
  $errorMessage = $null

  try {
    $proofArgs = @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      (Join-Path $repoRoot "scripts\m0-network-deny-windows.ps1")
    )
    $proofArgs += @("-AppPath", $resolvedAppPath)
    $proofArgs += @("-CorePath", $resolvedCorePath)
    $proofArgs += @("-ReleaseDir", $resolvedReleaseDir)
    $proofArgs += @("-ProofDir", $resolvedProofDir)

    $steps.Add((Invoke-LocalCommand "Run elevated Windows network-deny proof" "powershell" $proofArgs))
    $steps.Add((Invoke-LocalCommand "Refresh M0 artifact manifest" "node" @(
      "scripts/m0-artifact-manifest.mjs",
      "--release-dir", $resolvedReleaseDir,
      "--proof-dir", $resolvedProofDir
    )))
    $steps.Add((Invoke-LocalCommand "Refresh M0 proof audit summary" "node" @(
      "scripts/m0-proof-audit.mjs",
      "--proof-dir", $resolvedProofDir,
      "--write", (Join-Path $resolvedProofDir "m0-proof-audit-summary.json")
    ) $true))
    $ok = $true
  } catch {
    $errorMessage = $_.Exception.Message
    throw
  } finally {
    $receipt = [ordered]@{
      ok = $ok
      proofKind = "m0-network-deny-windows-admin-launcher"
      generatedAt = (Get-Date).ToUniversalTime().ToString("o")
      administrator = $true
      validateOnlyIsNotNetworkProof = $true
      networkBoundaryProofAttempted = $true
      releaseDir = $resolvedReleaseDir
      appPath = $resolvedAppPath
      corePath = $resolvedCorePath
      proofDir = $resolvedProofDir
      runnerValidation = $validation
      latestNetworkProof = Get-LatestWindowsNetworkProof $resolvedProofDir
      steps = $steps.ToArray()
      error = $errorMessage
    }
    Write-JsonFile $receiptPath $receipt
    Write-Host ""
    Write-Host "M0 Windows admin launcher receipt written to $receiptPath"
    if ($KeepOpen) {
      Read-Host "Press Enter to close this elevated window"
    }
  }

  exit 0
}

$scriptPath = Join-Path $repoRoot "scripts\m0-network-deny-windows-admin.ps1"
$elevatedArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $scriptPath
)
$elevatedArgs += @("-AppPath", $resolvedAppPath)
$elevatedArgs += @("-CorePath", $resolvedCorePath)
$elevatedArgs += @("-ReleaseDir", $resolvedReleaseDir)
$elevatedArgs += @("-ProofDir", $resolvedProofDir)
if ($KeepOpen) {
  $elevatedArgs += "-KeepOpen"
}

$argumentString = ($elevatedArgs | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
$startError = $null
$exitCode = $null
$launched = $false

try {
  $process = Start-Process -FilePath "powershell" -ArgumentList $argumentString -Verb RunAs -PassThru -Wait:(-not $NoWait)
  $launched = $true
  if (-not $NoWait) {
    $exitCode = $process.ExitCode
  }
} catch {
  $startError = $_.Exception.Message
  throw
} finally {
  $receipt = [ordered]@{
    ok = ($launched -and ($NoWait -or $exitCode -eq 0))
    proofKind = "m0-network-deny-windows-admin-launcher"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    administrator = $false
    validateOnlyIsNotNetworkProof = $true
    networkBoundaryProofAttempted = $false
    releaseDir = $resolvedReleaseDir
    appPath = $resolvedAppPath
    corePath = $resolvedCorePath
    proofDir = $resolvedProofDir
    runnerValidation = $validation
    latestNetworkProof = Get-LatestWindowsNetworkProof $resolvedProofDir
    elevatedLaunch = [ordered]@{
      launched = $launched
      waited = (-not $NoWait)
      exitCode = $exitCode
      error = $startError
    }
  }
  Write-JsonFile $receiptPath $receipt
  Write-Host "M0 Windows admin launcher receipt written to $receiptPath"
}

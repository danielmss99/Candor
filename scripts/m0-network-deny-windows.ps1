[CmdletBinding()]
param(
  [string]$AppPath = "",
  [string]$CorePath = "",
  [string]$ReleaseDir = "",
  [string]$ProofDir = "",
  [switch]$ValidateOnly
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

function Test-NetSecurityModule {
  return [bool](Get-Module -ListAvailable -Name NetSecurity -ErrorAction SilentlyContinue)
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

function Assert-File([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    throw "$Label not found: $PathValue. Run npm run electron:v3:dist first."
  }
}

function Assert-Directory([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "$Label not found: $PathValue. Run npm run electron:v3:dist first."
  }
}

function Assert-SamePath([string]$ActualPath, [string]$ExpectedPath, [string]$Label) {
  $actual = [System.IO.Path]::GetFullPath($ActualPath)
  $expected = [System.IO.Path]::GetFullPath($ExpectedPath)
  if (-not [string]::Equals($actual, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must come from the selected release root. Expected: $expected. Actual: $actual."
  }
}

function Get-FileEvidence([string]$PathValue) {
  $item = Get-Item -LiteralPath $PathValue
  $stream = [System.IO.File]::OpenRead($item.FullName)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha256.ComputeHash($stream)
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  $hash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
  return [ordered]@{
    path = [System.IO.Path]::GetFullPath($item.FullName)
    exists = $true
    bytes = [long]$item.Length
    sha256 = $hash
  }
}

function Assert-ArtifactEvidenceMatch($Expected, $Actual, [string]$Label) {
  if ($null -eq $Actual -or $Actual.exists -ne $true) {
    throw "Packaged smoke did not record existing $Label evidence."
  }
  Assert-SamePath ([string]$Actual.path) ([string]$Expected.path) "Packaged smoke $Label path"
  if ([long]$Actual.bytes -ne [long]$Expected.bytes) {
    throw "Packaged smoke $Label byte size does not match the selected release."
  }
  if (-not [string]::Equals(
      [string]$Actual.sha256,
      [string]$Expected.sha256,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Packaged smoke $Label SHA-256 does not match the selected release."
  }
}

function Quote-ProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Get-ProcessIdsForPath([string[]]$Paths) {
  $resolved = $Paths | ForEach-Object { [System.IO.Path]::GetFullPath($_) }
  $ids = New-Object System.Collections.Generic.List[int]
  foreach ($proc in Get-Process -ErrorAction SilentlyContinue) {
    try {
      if ($proc.Path -and ($resolved -contains [System.IO.Path]::GetFullPath($proc.Path))) {
        $ids.Add([int]$proc.Id)
      }
    } catch {
      continue
    }
  }
  return $ids
}

function Get-CandorTcpSnapshot([string[]]$Paths) {
  $ids = Get-ProcessIdsForPath $Paths
  if ($ids.Count -eq 0) {
    return @()
  }

  $connections = @()
  foreach ($id in $ids) {
    $connections += Get-NetTCPConnection -OwningProcess $id -ErrorAction SilentlyContinue |
      Where-Object { $_.State -ne "Closed" } |
      Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess
  }
  return @($connections)
}

function Get-CandorUdpSnapshot([string[]]$Paths) {
  $ids = Get-ProcessIdsForPath $Paths
  if ($ids.Count -eq 0) {
    return @()
  }

  $endpoints = @()
  foreach ($id in $ids) {
    $endpoints += Get-NetUDPEndpoint -OwningProcess $id -ErrorAction SilentlyContinue |
      Select-Object LocalAddress, LocalPort, OwningProcess
  }
  return @($endpoints)
}

function Convert-FirewallRuleEvidence($Rule) {
  $appFilter = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction SilentlyContinue |
    Select-Object -First 1

  return [ordered]@{
    displayName = $Rule.DisplayName
    direction = $Rule.Direction.ToString()
    action = $Rule.Action.ToString()
    enabled = $Rule.Enabled.ToString()
    program = $appFilter.Program
  }
}

function Write-JsonFile([string]$PathValue, $Value) {
  $json = $Value | ConvertTo-Json -Depth 20
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($PathValue, $json, $encoding)
}

if (-not (Test-Windows)) {
  throw "M0 Windows network-deny proof can only run on Windows."
}

$releaseDirProvided = -not [string]::IsNullOrWhiteSpace($ReleaseDir)
if ($releaseDirProvided) {
  $resolvedReleaseDir = Resolve-ProofPath $ReleaseDir "release-v3"
  $resolvedAppPath = if ([string]::IsNullOrWhiteSpace($AppPath)) {
    Join-Path $resolvedReleaseDir "win-unpacked\Candor v3 M0.exe"
  } else {
    Resolve-ProofPath $AppPath "release-v3\win-unpacked\Candor v3 M0.exe"
  }
  $resolvedCorePath = if ([string]::IsNullOrWhiteSpace($CorePath)) {
    Join-Path $resolvedReleaseDir "win-unpacked\resources\bin\candor-core.exe"
  } else {
    Resolve-ProofPath $CorePath "release-v3\win-unpacked\resources\bin\candor-core.exe"
  }
} else {
  $resolvedAppPath = Resolve-ProofPath $AppPath "release-v3\win-unpacked\Candor v3 M0.exe"
  $resolvedCorePath = Resolve-ProofPath $CorePath "release-v3\win-unpacked\resources\bin\candor-core.exe"
  $resolvedReleaseDir = Split-Path (Split-Path $resolvedAppPath -Parent) -Parent
}
$resolvedReleaseDir = [System.IO.Path]::GetFullPath($resolvedReleaseDir)
$resolvedAppPath = [System.IO.Path]::GetFullPath($resolvedAppPath)
$resolvedCorePath = [System.IO.Path]::GetFullPath($resolvedCorePath)
$resolvedAppArchivePath = Join-Path $resolvedReleaseDir "win-unpacked\resources\app.asar"
$resolvedProofDir = Resolve-ProofPath $ProofDir "release-v3\proofs"

Assert-Directory $resolvedReleaseDir "Release directory"
Assert-SamePath $resolvedAppPath (Join-Path $resolvedReleaseDir "win-unpacked\Candor v3 M0.exe") "Packaged app"
Assert-SamePath $resolvedCorePath (Join-Path $resolvedReleaseDir "win-unpacked\resources\bin\candor-core.exe") "Packaged candor-core sidecar"
Assert-File $resolvedAppPath "Packaged app"
Assert-File $resolvedCorePath "Packaged candor-core sidecar"
Assert-File $resolvedAppArchivePath "Packaged app.asar"

$releaseIdentity = [ordered]@{
  appExecutable = Get-FileEvidence $resolvedAppPath
  coreExecutable = Get-FileEvidence $resolvedCorePath
  appArchive = Get-FileEvidence $resolvedAppArchivePath
}

$administrator = Test-Administrator
$netSecurityAvailable = Test-NetSecurityModule

if ($ValidateOnly) {
  [ordered]@{
    ok = $true
    mode = "validate-only"
    validateOnlyIsNotNetworkProof = $true
    releaseDir = $resolvedReleaseDir
    appPath = $resolvedAppPath
    corePath = $resolvedCorePath
    appArchivePath = $resolvedAppArchivePath
    proofDir = $resolvedProofDir
    releaseIdentity = $releaseIdentity
    administrator = $administrator
    netSecurityAvailable = $netSecurityAvailable
    canCreateFirewallRules = ($administrator -and $netSecurityAvailable)
  } | ConvertTo-Json -Depth 5
  exit 0
}

New-Item -ItemType Directory -Force -Path $resolvedProofDir | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ruleGroup = "Candor v3 M0 Network Deny $PID $timestamp"
$smokeProofPath = Join-Path $resolvedProofDir "m0-packaged-runtime-smoke-win32-x64.json"
$networkProofPath = Join-Path $resolvedProofDir "m0-network-deny-windows-$timestamp.json"
$stdout = ""
$stderr = ""
$observedTcp = New-Object System.Collections.Generic.List[object]
$observedUdp = New-Object System.Collections.Generic.List[object]
$rulesCreated = @()
$ruleEvidence = @()
$ok = $false
$errorMessage = $null
$smokeProof = $null

if (-not $administrator) {
  $errorMessage = "Run this script from an elevated PowerShell session so it can create and remove temporary firewall rules."
  $networkProof = [ordered]@{
    ok = $false
    proofKind = "m0-network-deny-windows"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    denyMechanism = "Windows Defender Firewall outbound program block rules plus connection snapshot"
    ruleGroup = $ruleGroup
    releaseDir = $resolvedReleaseDir
    appPath = $resolvedAppPath
    corePath = $resolvedCorePath
    appArchivePath = $resolvedAppArchivePath
    releaseIdentity = $releaseIdentity
    smokeProofPath = $smokeProofPath
    prerequisites = [ordered]@{
      administrator = $administrator
      netSecurityAvailable = $netSecurityAvailable
      canCreateFirewallRules = $false
    }
    prerequisiteFailure = "administrator-required"
    temporaryFirewallRules = @()
    observedTcpConnections = @()
    observedUdpEndpoints = @()
    stdout = ""
    stderr = ""
    smokeProof = $null
    cleanup = [ordered]@{
      attempted = $false
      ruleGroupRemoved = $false
      error = "Firewall rules were not created."
    }
    error = $errorMessage
  }
  Write-JsonFile $networkProofPath $networkProof
  Write-Host "M0 Windows network-deny proof attempt written to $networkProofPath"
  throw $errorMessage
}

if (-not $netSecurityAvailable) {
  throw "The NetSecurity PowerShell module is required for the Windows network-deny proof."
}

try {
  Remove-Item -LiteralPath $smokeProofPath -Force -ErrorAction SilentlyContinue

  $rulesCreated += New-NetFirewallRule `
    -DisplayName "$ruleGroup app outbound block" `
    -Group $ruleGroup `
    -Direction Outbound `
    -Program $resolvedAppPath `
    -Action Block `
    -Profile Any `
    -Enabled True

  $rulesCreated += New-NetFirewallRule `
    -DisplayName "$ruleGroup core outbound block" `
    -Group $ruleGroup `
    -Direction Outbound `
    -Program $resolvedCorePath `
    -Action Block `
    -Profile Any `
    -Enabled True

  $ruleEvidence = @($rulesCreated | ForEach-Object { Convert-FirewallRuleEvidence $_ })

  $nodePath = (Get-Command node).Source
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $nodePath
  $psi.WorkingDirectory = $repoRoot
  $psi.Arguments = (@("scripts/m0-packaged-smoke.mjs", $resolvedAppPath) |
    ForEach-Object { Quote-ProcessArgument $_ }) -join " "
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.Environment["CANDOR_M0_PACKAGED_SMOKE_PROOF"] = $smokeProofPath

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  [void]$process.Start()

  while (-not $process.HasExited) {
    foreach ($connection in (Get-CandorTcpSnapshot @($resolvedAppPath, $resolvedCorePath))) {
      if ($observedTcp.Count -lt 100) {
        $observedTcp.Add($connection)
      }
    }
    foreach ($endpoint in (Get-CandorUdpSnapshot @($resolvedAppPath, $resolvedCorePath))) {
      if ($observedUdp.Count -lt 100) {
        $observedUdp.Add($endpoint)
      }
    }
    Start-Sleep -Milliseconds 100
  }

  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()

  if ($process.ExitCode -ne 0) {
    throw "Packaged smoke failed under temporary firewall deny rules with exit code $($process.ExitCode). $stderr"
  }
  if (-not (Test-Path -LiteralPath $smokeProofPath -PathType Leaf)) {
    throw "Packaged smoke did not write its expected proof: $smokeProofPath"
  }

  $smokeProof = Get-Content -LiteralPath $smokeProofPath -Raw | ConvertFrom-Json
  Assert-SamePath ([string]$smokeProof.executable) $resolvedAppPath "Packaged smoke executable"
  Assert-SamePath ([string]$smokeProof.corePath) $resolvedCorePath "Packaged smoke core path"
  Assert-ArtifactEvidenceMatch $releaseIdentity.appExecutable $smokeProof.packagedArtifacts.appExecutable "app executable"
  Assert-ArtifactEvidenceMatch $releaseIdentity.coreExecutable $smokeProof.packagedArtifacts.coreExecutable "core executable"
  Assert-ArtifactEvidenceMatch $releaseIdentity.appArchive $smokeProof.packagedArtifacts.appArchive "app archive"

  if ($observedTcp.Count -gt 0) {
    throw "Observed $($observedTcp.Count) TCP connection(s) for Candor processes under temporary firewall deny rules."
  }
  if ($observedUdp.Count -gt 0) {
    throw "Observed $($observedUdp.Count) UDP endpoint(s) for Candor processes under temporary firewall deny rules."
  }

  $ok = $true
} catch {
  $errorMessage = $_.Exception.Message
  throw
} finally {
  $cleanupError = $null
  if ($ruleEvidence.Count -lt $rulesCreated.Count) {
    try {
      $ruleEvidence = @($rulesCreated | ForEach-Object { Convert-FirewallRuleEvidence $_ })
    } catch {
      $ruleEvidence = @()
    }
  }
  try {
    Remove-NetFirewallRule -Group $ruleGroup -ErrorAction SilentlyContinue
  } catch {
    $cleanupError = $_.Exception.Message
  }

  if ($null -eq $smokeProof -and (Test-Path -LiteralPath $smokeProofPath -PathType Leaf)) {
    $smokeProof = Get-Content -LiteralPath $smokeProofPath -Raw | ConvertFrom-Json
  }

  $networkProof = [ordered]@{
    ok = $ok
    proofKind = "m0-network-deny-windows"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    denyMechanism = "Windows Defender Firewall outbound program block rules plus connection snapshot"
    ruleGroup = $ruleGroup
    releaseDir = $resolvedReleaseDir
    appPath = $resolvedAppPath
    corePath = $resolvedCorePath
    appArchivePath = $resolvedAppArchivePath
    releaseIdentity = $releaseIdentity
    smokeProofPath = $smokeProofPath
    prerequisites = [ordered]@{
      administrator = $administrator
      netSecurityAvailable = $netSecurityAvailable
      canCreateFirewallRules = ($administrator -and $netSecurityAvailable)
    }
    temporaryFirewallRules = @($ruleEvidence)
    observedTcpConnections = $observedTcp.ToArray()
    observedUdpEndpoints = $observedUdp.ToArray()
    stdout = $stdout.Trim()
    stderr = $stderr.Trim()
    smokeProof = $smokeProof
    cleanup = [ordered]@{
      attempted = $true
      ruleGroupRemoved = [string]::IsNullOrWhiteSpace($cleanupError)
      error = $cleanupError
    }
    error = $errorMessage
  }

  Write-JsonFile $networkProofPath $networkProof
  Write-Host "M0 Windows network-deny proof written to $networkProofPath"
}

$ErrorActionPreference = 'Stop'

if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
  throw 'This bootstrap script is Windows only.'
}

$Version = '5.42.2.1'
$Url = 'https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/SP_54221_64bit/strawberry-perl-5.42.2.1-64bit-portable.zip'
$ExpectedSha256 = '32d83be90cf04b807cfb9477482bc36302cdee6f5b04cf57e81adecbd8f07898'

$Root = Join-Path $env:LOCALAPPDATA 'CandorToolchains'
$DownloadDir = Join-Path $Root 'downloads'
$ZipPath = Join-Path $DownloadDir "strawberry-perl-$Version-64bit-portable.zip"
$TargetDir = Join-Path $Root "strawberry-perl-$Version-portable"
$PerlExe = Join-Path $TargetDir 'perl\bin\perl.exe'

function Test-NativePerl {
  param([string] $Path)

  if (-not (Test-Path $Path)) {
    return $false
  }

  $probe = & $Path -V:osname -V:archname 2>&1 | Out-String
  return $LASTEXITCODE -eq 0 -and $probe.Contains('MSWin32')
}

New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null

$needsDownload = $true
if (Test-Path $ZipPath) {
  $actual = (Get-FileHash -Algorithm SHA256 $ZipPath).Hash.ToLowerInvariant()
  $needsDownload = $actual -ne $ExpectedSha256
  if ($needsDownload) {
    Remove-Item -LiteralPath $ZipPath -Force
  }
}

if ($needsDownload) {
  & curl.exe -L --fail --retry 3 --output $ZipPath $Url
}

$actualHash = (Get-FileHash -Algorithm SHA256 $ZipPath).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedSha256) {
  throw "Strawberry Perl hash mismatch: $actualHash"
}

if (-not (Test-NativePerl $PerlExe)) {
  if (Test-Path $TargetDir) {
    Remove-Item -LiteralPath $TargetDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $TargetDir -Force
}

if (-not (Test-NativePerl $PerlExe)) {
  throw "Extracted Perl is not a native Windows Perl: $PerlExe"
}

Write-Host "Native Windows Perl ready: $PerlExe"

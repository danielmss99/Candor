[CmdletBinding()]
param(
  [switch]$Store,
  [switch]$NoBundle,
  [switch]$Ci,
  [switch]$KeepPdb,
  [string]$TargetDir = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$repoRootFull = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\')

if ([string]::IsNullOrWhiteSpace($TargetDir)) {
  $TargetDir = Join-Path $env:SystemDrive "CandorBuild\target"
}

$targetDirFull = [System.IO.Path]::GetFullPath($TargetDir).TrimEnd('\')
New-Item -ItemType Directory -Force -Path $targetDirFull | Out-Null

$vsDevCmd = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (Test-Path $vsDevCmd) {
  cmd /c "`"$vsDevCmd`" && set" | ForEach-Object {
    if ($_ -match '^([A-Za-z_][A-Za-z0-9_()]*)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}

$vsCmake = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin"
if (Test-Path (Join-Path $vsCmake "cmake.exe")) {
  $env:Path = "$vsCmake;$env:Path"
}

$pipLibclang = Join-Path $env:LOCALAPPDATA "Python\pythoncore-3.14-64\Lib\site-packages\clang\native"
if (Test-Path (Join-Path $pipLibclang "libclang.dll")) {
  $env:LIBCLANG_PATH = $pipLibclang
}

$env:CANDOR_SHA256_TINY_EN = "921E4CF8686FDD993DCD081A5DA5B6C365BFDE1162E72B08D75AC75289920B1F"
$env:CANDOR_SHA256_BASE_EN = "A03779C86DF3323075F5E796CB2CE5029F00EC8869EEE3FDFB897AFE36C6D002"
$env:CANDOR_SHA256_SMALL_EN = "C6138D6D58ECC8322097E0F987C32F1BE8BB0A18532A3F88F734D1BBF9C41E5D"

function Add-Remap {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$From,
    [string]$To
  )

  if ([string]::IsNullOrWhiteSpace($From)) {
    return
  }

  $full = [System.IO.Path]::GetFullPath($From).TrimEnd('\')
  $List.Add("--remap-path-prefix=$full=$To")
}

function Add-NativePathMap {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$From,
    [string]$To
  )

  if ([string]::IsNullOrWhiteSpace($From)) {
    return
  }

  $full = [System.IO.Path]::GetFullPath($From).TrimEnd('\')
  $List.Add("/pathmap:$full=$To")
}

$rustRemaps = [System.Collections.Generic.List[string]]::new()
Add-Remap $rustRemaps $repoRootFull "."
Add-Remap $rustRemaps $targetDirFull ".target"
Add-Remap $rustRemaps $env:USERPROFILE ".home"
Add-Remap $rustRemaps $(if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }) ".cargo"
Add-Remap $rustRemaps $env:LOCALAPPDATA ".localappdata"
Add-Remap $rustRemaps $env:TEMP ".temp"

$rustFlags = [System.Collections.Generic.List[string]]::new()
if (-not [string]::IsNullOrWhiteSpace($env:RUSTFLAGS)) {
  $rustFlags.Add($env:RUSTFLAGS)
}
foreach ($remap in $rustRemaps) {
  $rustFlags.Add($remap)
}
$rustFlags.Add("-C debuginfo=0")
$env:RUSTFLAGS = ($rustFlags | Select-Object -Unique) -join " "

$nativeMaps = [System.Collections.Generic.List[string]]::new()
Add-NativePathMap $nativeMaps $repoRootFull "."
Add-NativePathMap $nativeMaps $targetDirFull ".target"
Add-NativePathMap $nativeMaps $env:USERPROFILE ".home"
Add-NativePathMap $nativeMaps $(if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }) ".cargo"
Add-NativePathMap $nativeMaps $env:LOCALAPPDATA ".localappdata"
Add-NativePathMap $nativeMaps $env:TEMP ".temp"

$nativeFlags = @("-nologo", "-MD", "-Brepro", "-W0") + $nativeMaps
$nativeFlagString = ($nativeFlags | Select-Object -Unique) -join " "

$env:CMAKE_C_FLAGS = $nativeFlagString
$env:CMAKE_CXX_FLAGS = "/utf-8 $nativeFlagString"
$env:CMAKE_ASM_FLAGS = $nativeFlagString
$env:CMAKE_C_FLAGS_RELEASE = $nativeFlagString
$env:CMAKE_CXX_FLAGS_RELEASE = "/utf-8 $nativeFlagString"
$env:CMAKE_ASM_FLAGS_RELEASE = $nativeFlagString
$env:CARGO_TARGET_DIR = $targetDirFull

Set-Location $repoRootFull

& (Join-Path $PSScriptRoot "audit-source-security.ps1")

$tauriArgs = @("tauri", "build")
if ($Store) {
  $tauriArgs += @("--config", "src-tauri/tauri.store.conf.json")
}
if ($NoBundle) {
  $tauriArgs += "--no-bundle"
}
if ($Ci) {
  $tauriArgs += "--ci"
}

npx @tauriArgs

if (-not $KeepPdb) {
  $releaseRoot = Join-Path $targetDirFull "release"
  if (Test-Path -LiteralPath $releaseRoot) {
    Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -Filter *.pdb |
      Remove-Item -Force
  }
}

& (Join-Path $PSScriptRoot "audit-release-artifacts.ps1") -TargetRoot $targetDirFull

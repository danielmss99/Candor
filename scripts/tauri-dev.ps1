# Ensures Whisper/Tauri native build deps are on PATH for this session.
$ErrorActionPreference = "Stop"

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

Set-Location (Split-Path $PSScriptRoot -Parent)
npx tauri dev @args

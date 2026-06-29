# Candor dev launcher — sets up the native build environment for the
# whisper-rs / cpal backend, then runs `tauri dev`.
#
#   Requires: VS 2022 Build Tools (MSVC + bundled CMake), libclang (pip install libclang).
#   Usage:    pwsh ./dev.ps1   (or: ./dev.ps1 build  to just compile)

$ErrorActionPreference = "Stop"

# Base PATH (cargo, node, etc.)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

# Import the VS x64 developer environment so clang/bindgen find MSVC + Windows SDK headers.
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found — install VS 2022 Build Tools (VCTools)." }
cmd /c "`"$vcvars`" && set" | ForEach-Object {
  if ($_ -match '^([A-Za-z_][A-Za-z0-9_()]*)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
  }
}

# CMake is bundled with Build Tools; libclang comes from `pip install libclang`.
$cmakeBin = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin"
$env:Path = "$cmakeBin;$env:Path"
$env:LIBCLANG_PATH = "C:\Users\danny\AppData\Local\Python\pythoncore-3.14-64\Lib\site-packages\clang\native"

if (-not (Test-Path "$env:LIBCLANG_PATH\libclang.dll")) {
  Write-Warning "libclang.dll not found at LIBCLANG_PATH. Run: pip install libclang  (then update this path)."
}

Set-Location $PSScriptRoot
if ($args[0] -eq "build") {
  cargo build --manifest-path src-tauri/Cargo.toml
} else {
  npm run tauri dev
}

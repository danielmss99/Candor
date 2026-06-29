# Ensures Whisper/Tauri build deps are on PATH for this session.
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
$cmakeBin = "C:\Program Files\CMake\bin"
if ($env:Path -notlike "*$cmakeBin*") {
  $env:Path = "$cmakeBin;$env:Path"
}

Set-Location (Split-Path $PSScriptRoot -Parent)
npx tauri dev @args

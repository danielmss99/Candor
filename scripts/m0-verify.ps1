[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot

function Assert-NativeSuccess {
    param([Parameter(Mandatory = $true)][string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

Write-Host "== M0: Rust core tests =="
node scripts/cargo-with-local-perl.mjs test --manifest-path crates/candor-core/Cargo.toml
Assert-NativeSuccess "Rust core tests"

Write-Host "== M0: Rust core debug build =="
npm run core:v3:build
Assert-NativeSuccess "Rust core debug build"

Write-Host "== M0: Rust core stdio smoke =="
node scripts/m0-core-smoke.mjs
Assert-NativeSuccess "Rust core stdio smoke"

Write-Host "== M0: Electron static hardening audit =="
node scripts/m0-audit-electron.mjs
Assert-NativeSuccess "Electron static hardening audit"

Write-Host "== M0: CI contract smoke =="
node scripts/m0-ci-contract-smoke.mjs
Assert-NativeSuccess "CI contract smoke"

Write-Host "== M0: Proof audit self-test =="
node scripts/m0-proof-audit.mjs --self-test
Assert-NativeSuccess "Proof audit self-test"

Write-Host "== M0: Electron main/preload build =="
npm run electron:v3:build-main
Assert-NativeSuccess "Electron main and preload build"

Write-Host "== M0: v3 renderer typecheck =="
npm run electron:v3:typecheck-renderer
Assert-NativeSuccess "V3 renderer typecheck"

Write-Host "== M0: v3 renderer build =="
npm run electron:v3:build-renderer
Assert-NativeSuccess "V3 renderer build"

Write-Host "M0 local verification passed."

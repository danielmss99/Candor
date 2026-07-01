[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$repoRootFull = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\')

function Fail {
  param([string]$Message)
  throw "Source security audit failed: $Message"
}

Set-Location $repoRootFull

$trackedEnv = @(git ls-files -- .env .env.local .env.production)
if ($trackedEnv.Count -gt 0) {
  Fail "environment files are tracked: $($trackedEnv -join ', ')"
}

$ignoredEnv = @(git check-ignore .env .env.local .env.production 2>$null)
foreach ($expected in @(".env", ".env.local")) {
  if ($ignoredEnv -notcontains $expected) {
    Fail "$expected is not ignored by git"
  }
}

$buildScript = Get-Content -LiteralPath (Join-Path $repoRootFull "src-tauri\build.rs") -Raw
if ($buildScript -match "CANDOR_GOOGLE_CLIENT_SECRET") {
  Fail "Google client secrets must not be exported at compile time"
}

$tauriConfig = Get-Content -LiteralPath (Join-Path $repoRootFull "src-tauri\tauri.conf.json") -Raw
if ($tauriConfig -match "http://127\.0\.0\.1:\*" -or $tauriConfig -match "http://localhost:\*") {
  Fail "release CSP must not allow every localhost port"
}

$defaultCapability = Get-Content -LiteralPath (Join-Path $repoRootFull "src-tauri\capabilities\default.json") -Raw
if ($defaultCapability -match '"opener:default"') {
  Fail "main window must not expose broad frontend opener permissions"
}

$packageJson = Get-Content -LiteralPath (Join-Path $repoRootFull "package.json") -Raw
if ($packageJson -match '"@tauri-apps/plugin-opener"') {
  Fail "frontend opener package must not be shipped when only Rust opens controlled URLs"
}

$frontendOpenerImports = @(
  Get-ChildItem -LiteralPath (Join-Path $repoRootFull "src") -Recurse -File -Include *.ts,*.tsx |
    Select-String -Pattern "@tauri-apps/plugin-opener"
)
if ($frontendOpenerImports.Count -gt 0) {
  Fail "frontend code must not import the opener plugin directly"
}

$calendar = Get-Content -LiteralPath (Join-Path $repoRootFull "src-tauri\src\calendar.rs") -Raw
$plaintextFallbackPatterns = @(
  "\.or\(auth\.ms_access_token\)",
  "\.or\(auth\.ms_refresh_token\)",
  "\.or\(auth\.google_client_secret\)",
  "\.or\(auth\.google_access_token\)",
  "\.or\(auth\.google_refresh_token\)",
  "\.or\(auth\.apple_id\)",
  "\.or\(auth\.apple_app_password\)"
)

foreach ($pattern in $plaintextFallbackPatterns) {
  if ($calendar -match $pattern) {
    Fail "calendar auth still falls back to plaintext secrets"
  }
}

Write-Host "Source security audit passed."

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$node = Get-Command node -ErrorAction Stop

& $node.Source (Join-Path $PSScriptRoot "audit-source-security.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Source security audit failed."
}

Write-Host "PowerShell source security entry point passed for $repoRoot."

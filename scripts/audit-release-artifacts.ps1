[CmdletBinding()]
param(
  [string[]]$Path = @(),
  [string[]]$TargetRoot = @()
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$repoRootFull = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\')

function Add-IfPresent {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$Value
  )

  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $List.Add($Value)
  }
}

function Test-TextPresent {
  param(
    [string]$Text,
    [string]$Needle
  )

  if ([string]::IsNullOrEmpty($Needle)) {
    return $false
  }

  return $Text.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-ArtifactCandidates {
  $roots = [System.Collections.Generic.List[string]]::new()
  $hasExplicitScope = $Path.Count -gt 0 -or $TargetRoot.Count -gt 0

  foreach ($root in $TargetRoot) {
    Add-IfPresent $roots $root
  }

  if (-not $hasExplicitScope) {
    if (-not [string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
      Add-IfPresent $roots $env:CARGO_TARGET_DIR
    }

    Add-IfPresent $roots (Join-Path $env:SystemDrive "CandorBuild\target")
    Add-IfPresent $roots (Join-Path $repoRootFull "src-tauri\target")
  }

  $candidateFiles = [System.Collections.Generic.List[string]]::new()
  foreach ($root in ($roots | Select-Object -Unique)) {
    $releaseRoot = Join-Path $root "release"
    Add-IfPresent $candidateFiles (Join-Path $releaseRoot "candor.exe")
    Add-IfPresent $candidateFiles (Join-Path $releaseRoot "candor.pdb")

    $bundleRoot = Join-Path $releaseRoot "bundle"
    if (Test-Path -LiteralPath $bundleRoot) {
      Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Include *.exe,*.msi,*.pdb |
        ForEach-Object { Add-IfPresent $candidateFiles $_.FullName }
    }
  }

  foreach ($item in $Path) {
    if (Test-Path -LiteralPath $item -PathType Leaf) {
      Add-IfPresent $candidateFiles (Resolve-Path -LiteralPath $item).Path
    } elseif (Test-Path -LiteralPath $item -PathType Container) {
      Get-ChildItem -LiteralPath $item -Recurse -File -Include *.exe,*.msi,*.pdb |
        ForEach-Object { Add-IfPresent $candidateFiles $_.FullName }
    } else {
      throw "Artifact path does not exist: $item"
    }
  }

  $candidateFiles |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -Unique
}

function Get-DotEnvPatterns {
  $allowed = @{}
  if (-not [string]::IsNullOrWhiteSpace($env:CANDOR_RELEASE_ALLOWED_EMBEDDED_KEYS)) {
    foreach ($key in ($env:CANDOR_RELEASE_ALLOWED_EMBEDDED_KEYS -split ",")) {
      $trimmed = $key.Trim()
      if ($trimmed.Length -gt 0) {
        $allowed[$trimmed] = $true
      }
    }
  }

  $patterns = [System.Collections.Generic.List[object]]::new()
  foreach ($name in @(".env", ".env.local", ".env.production")) {
    $envPath = Join-Path $repoRootFull $name
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
      continue
    }

    foreach ($line in Get-Content -LiteralPath $envPath) {
      $trimmed = $line.Trim()
      if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
        continue
      }

      $equals = $trimmed.IndexOf("=")
      $key = $trimmed.Substring(0, $equals).Trim()
      $value = $trimmed.Substring($equals + 1).Trim().Trim('"').Trim("'")
      if ($value.Length -lt 8) {
        continue
      }

      if ($key -like "CANDOR_SHA256_*") {
        continue
      }

      if ($allowed.ContainsKey($key)) {
        continue
      }

      $patterns.Add([pscustomobject]@{
        Label = "unapproved .env value for $key"
        Value = $value
      })
    }
  }

  return $patterns
}

$forbidden = [System.Collections.Generic.List[object]]::new()

if (-not [string]::IsNullOrWhiteSpace($env:SystemDrive)) {
  $forbidden.Add([pscustomobject]@{
    Label = "Windows user profile path"
    Value = "$($env:SystemDrive)\Users\"
  })
}

if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
  $forbidden.Add([pscustomobject]@{
    Label = "current user profile path"
    Value = [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
  })
}

$forbidden.Add([pscustomobject]@{
  Label = "repo checkout path"
  Value = $repoRootFull
})

$repoParent = Split-Path $repoRootFull -Parent
if (-not [string]::IsNullOrWhiteSpace($repoParent) -and $repoParent -notmatch "\\Users$") {
  $forbidden.Add([pscustomobject]@{
    Label = "repo parent path"
    Value = $repoParent
  })
}

foreach ($pattern in Get-DotEnvPatterns) {
  $forbidden.Add($pattern)
}

$artifacts = @(Get-ArtifactCandidates)
if ($artifacts.Count -eq 0) {
  throw "No release artifacts found to audit."
}

$findings = [System.Collections.Generic.List[object]]::new()
foreach ($artifact in $artifacts) {
  $bytes = [System.IO.File]::ReadAllBytes($artifact)
  $latin = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
  $wide = [System.Text.Encoding]::Unicode.GetString($bytes)
  $wideOffset = ""
  if ($bytes.Length -gt 1) {
    $wideOffset = [System.Text.Encoding]::Unicode.GetString($bytes, 1, $bytes.Length - 1)
  }

  foreach ($pattern in $forbidden) {
    $found = (Test-TextPresent $latin $pattern.Value) -or
      (Test-TextPresent $wide $pattern.Value) -or
      (Test-TextPresent $wideOffset $pattern.Value)

    if ($found) {
      $findings.Add([pscustomobject]@{
        Artifact = $artifact
        Finding = $pattern.Label
      })
    }
  }
}

if ($findings.Count -gt 0) {
  Write-Host "Release artifact audit failed."
  $findings |
    Sort-Object Artifact, Finding -Unique |
    Format-Table -AutoSize |
    Out-String |
    Write-Host
  throw "Release artifact audit failed."
}

Write-Host "Release artifact audit passed for $($artifacts.Count) artifact(s)."

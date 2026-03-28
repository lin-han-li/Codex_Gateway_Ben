param(
  [switch]$DryRun,
  [switch]$ForceClear
)

$ErrorActionPreference = "Stop"

function Get-CandidateSettingsPaths {
  $paths = @(
    (Join-Path $env:APPDATA "Codex Gateway\data\settings.json"),
    (Join-Path $env:APPDATA "OAuth Multi Login\data\settings.json"),
    (Join-Path $env:APPDATA "oauth-multi-login-app\data\settings.json"),
    (Join-Path $env:LOCALAPPDATA "OAuthMultiLoginApp\data\settings.json")
  )

  $seen = @{}
  foreach ($path in $paths) {
    if ([string]::IsNullOrWhiteSpace($path)) {
      continue
    }
    if (-not $seen.ContainsKey($path)) {
      $seen[$path] = $true
      $path
    }
  }
}

function Is-LoopbackHost {
  param(
    [string]$HostName
  )

  $value = [string]$HostName
  return $value -eq "127.0.0.1" -or $value -eq "localhost"
}

function Load-SettingsObject {
  param(
    [string]$Path
  )

  $raw = Get-Content -Path $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{}
  }
  return $raw | ConvertFrom-Json
}

function Save-SettingsObject {
  param(
    [string]$Path,
    [object]$Settings
  )

  $json = $Settings | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-LocalServiceAddress {
  param(
    [object]$Settings
  )

  if ($null -eq $Settings) {
    return ""
  }

  $property = $Settings.PSObject.Properties["localServiceAddress"]
  if ($null -eq $property) {
    return ""
  }

  return [string]$property.Value
}

function Set-LocalServiceAddress {
  param(
    [object]$Settings,
    [string]$Value
  )

  $property = $Settings.PSObject.Properties["localServiceAddress"]
  if ($null -eq $property) {
    Add-Member -InputObject $Settings -NotePropertyName "localServiceAddress" -NotePropertyValue $Value
    return
  }

  $property.Value = $Value
}

$updated = @()
$skipped = @()
$missing = @()

foreach ($settingsPath in Get-CandidateSettingsPaths) {
  if (-not (Test-Path -LiteralPath $settingsPath)) {
    $missing += $settingsPath
    continue
  }

  try {
    $settings = Load-SettingsObject -Path $settingsPath
    $address = (Get-LocalServiceAddress -Settings $settings).Trim()
    if ([string]::IsNullOrWhiteSpace($address)) {
      $skipped += [pscustomobject]@{
        Path = $settingsPath
        Reason = "localServiceAddress is already empty"
      }
      continue
    }

    $uri = $null
    try {
      $uri = [uri]$address
    } catch {
      $uri = $null
    }

    if (-not $ForceClear -and $uri -and (Is-LoopbackHost -HostName $uri.Host)) {
      $skipped += [pscustomobject]@{
        Path = $settingsPath
        Reason = "localServiceAddress is already loopback"
      }
      continue
    }

    $backupPath = "$settingsPath.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
    if ($DryRun) {
      $updated += [pscustomobject]@{
        Path = $settingsPath
        Backup = $backupPath
        OldValue = $address
        NewValue = ""
        Mode = "dry-run"
      }
      continue
    }

    Copy-Item -LiteralPath $settingsPath -Destination $backupPath -Force
    Set-LocalServiceAddress -Settings $settings -Value ""
    Save-SettingsObject -Path $settingsPath -Settings $settings
    $updated += [pscustomobject]@{
      Path = $settingsPath
      Backup = $backupPath
      OldValue = $address
      NewValue = ""
      Mode = "updated"
    }
  } catch {
    $skipped += [pscustomobject]@{
      Path = $settingsPath
      Reason = $_.Exception.Message
    }
  }
}

Write-Host "Checked settings paths:" -ForegroundColor Cyan
Get-CandidateSettingsPaths | ForEach-Object { Write-Host "  $_" }

if ($updated.Count -gt 0) {
  Write-Host ""
  Write-Host "Updated entries:" -ForegroundColor Green
  $updated | Format-Table -AutoSize
}

if ($skipped.Count -gt 0) {
  Write-Host ""
  Write-Host "Skipped entries:" -ForegroundColor Yellow
  $skipped | Format-Table -AutoSize
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "Missing paths:" -ForegroundColor DarkYellow
  $missing | ForEach-Object { Write-Host "  $_" }
}

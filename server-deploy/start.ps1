$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $RootDir ".env"

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }
    $pair = $line.Split("=", 2)
    if ($pair.Count -ne 2) {
      return
    }
    $name = $pair[0].Trim()
    $value = $pair[1].Trim().Trim("'").Trim('"')
    if ($name) {
      Set-Item -Path ("Env:" + $name) -Value $value
    }
  }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw "bun is not installed or not in PATH"
}

if (-not $env:OAUTH_APP_DATA_DIR) {
  $env:OAUTH_APP_DATA_DIR = Join-Path $RootDir "data"
}
if (-not $env:OAUTH_APP_WEB_DIR) {
  $env:OAUTH_APP_WEB_DIR = Join-Path $RootDir "src\\web"
}
if (-not $env:OAUTH_APP_HOST) {
  $env:OAUTH_APP_HOST = "127.0.0.1"
}
if (-not $env:OAUTH_APP_PORT) {
  $env:OAUTH_APP_PORT = "4777"
}

$loopbackHosts = @("127.0.0.1", "localhost", "::1")
if ($loopbackHosts -notcontains $env:OAUTH_APP_HOST) {
  if (-not $env:OAUTH_APP_ENCRYPTION_KEY) {
    throw "OAUTH_APP_ENCRYPTION_KEY is required for non-loopback binding"
  }
  if (-not $env:OAUTH_APP_ADMIN_TOKEN) {
    throw "OAUTH_APP_ADMIN_TOKEN should be set for any non-loopback binding"
  }
}

New-Item -ItemType Directory -Force -Path $env:OAUTH_APP_DATA_DIR | Out-Null
Set-Location $RootDir
& bun src/index.ts

@echo off
setlocal EnableExtensions

REM Usage:
REM   setup-codex-intranet.cmd [gateway_base_url] [virtual_key]
REM Example:
REM   setup-codex-intranet.cmd http://192.168.0.139:4509 ocsk_live_xxx

set "GATEWAY_BASE=%~1"
if "%GATEWAY_BASE%"=="" set "GATEWAY_BASE=http://192.168.0.139:4509"

set "VIRTUAL_KEY=%~2"
if "%VIRTUAL_KEY%"=="" (
  echo.
  echo [ERROR] Missing virtual key.
  echo Usage: %~nx0 [gateway_base_url] [virtual_key]
  echo Example: %~nx0 http://192.168.0.139:4509 ocsk_live_xxx
  echo.
  pause
  exit /b 1
)

set "API_BASE=%GATEWAY_BASE%/v1"
set "CODEX_HOME=%USERPROFILE%\.codex"
set "CONFIG_FILE=%CODEX_HOME%\config.toml"
set "AUTH_FILE=%CODEX_HOME%\auth.json"
set "LAUNCHER_FILE=%CODEX_HOME%\codex-gateway.cmd"
set "START_MENU_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Codex Gateway.lnk"
set "DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\Codex Gateway.lnk"

if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
if exist "%CONFIG_FILE%" copy /Y "%CONFIG_FILE%" "%CODEX_HOME%\config.backup.%TS%.toml" >nul
if exist "%AUTH_FILE%" copy /Y "%AUTH_FILE%" "%CODEX_HOME%\auth.backup.%TS%.json" >nul

set "NO_PROXY_VALUE=localhost,127.0.0.1"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $hostName = [Uri]$env:API_BASE; if ($hostName.Host) { $hostName.Host } } catch { }"`) do set "GATEWAY_HOST=%%i"
if not "%GATEWAY_HOST%"=="" set "NO_PROXY_VALUE=%NO_PROXY_VALUE%,%GATEWAY_HOST%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$cfgPath=$env:CONFIG_FILE;" ^
  "$authPath=$env:AUTH_FILE;" ^
  "$launcherPath=$env:LAUNCHER_FILE;" ^
  "$startMenuShortcut=$env:START_MENU_SHORTCUT;" ^
  "$desktopShortcut=$env:DESKTOP_SHORTCUT;" ^
  "$apiBase=$env:API_BASE;" ^
  "$key=$env:VIRTUAL_KEY;" ^
  "$noProxy=$env:NO_PROXY_VALUE;" ^
  "$cfgLine='openai_base_url = ""' + $apiBase + '""';" ^
  "$cfg='';" ^
  "if (Test-Path $cfgPath) { $cfg=[System.IO.File]::ReadAllText($cfgPath) }" ^
  "$cfg=[System.Text.RegularExpressions.Regex]::Replace($cfg,'(?m)^[ \t]*openai_base_url\s*=.*(?:\r?\n)?','');" ^
  "$cfg=$cfg.TrimStart([char]13,[char]10);" ^
  "if ([string]::IsNullOrWhiteSpace($cfg)) { $cfg=$cfgLine + [Environment]::NewLine } else { $cfg=$cfgLine + [Environment]::NewLine + $cfg }" ^
  "$authObj=@{ auth_mode='apikey'; OPENAI_API_KEY=$key };" ^
  "$auth=($authObj | ConvertTo-Json -Depth 5) + [Environment]::NewLine;" ^
  "$launcherLines=@('@echo off','setlocal','set ""NO_PROXY=' + $noProxy + '""','set ""HTTP_PROXY=""','set ""HTTPS_PROXY=""','set ""ALL_PROXY=""','set ""OPENAI_BASE_URL=""','set ""OPENAI_API_BASE=""','set ""OPENAI_API_KEY=""','codex -p default %*','');" ^
  "$launcher=[string]::Join([Environment]::NewLine,$launcherLines);" ^
  "$utf8NoBom = New-Object System.Text.UTF8Encoding($false);" ^
  "[System.IO.File]::WriteAllText($cfgPath, $cfg, $utf8NoBom);" ^
  "[System.IO.File]::WriteAllText($authPath, $auth, $utf8NoBom);" ^
  "[System.IO.File]::WriteAllText($launcherPath, $launcher, $utf8NoBom);" ^
  "$shell=New-Object -ComObject WScript.Shell;" ^
  "foreach($shortcutPath in @($startMenuShortcut,$desktopShortcut)){ $dir=Split-Path -Parent $shortcutPath; if($dir -and -not (Test-Path $dir)){ New-Item -ItemType Directory -Force -Path $dir | Out-Null }; $shortcut=$shell.CreateShortcut($shortcutPath); $shortcut.TargetPath=$launcherPath; $shortcut.WorkingDirectory=$env:USERPROFILE; $shortcut.Description='Codex gateway launcher'; $shortcut.Save() }"

if errorlevel 1 (
  echo [ERROR] Failed to write config/auth files.
  pause
  exit /b 1
)

echo.
echo [OK] Updated official-style Codex files:
echo   Config : %CONFIG_FILE%
echo   Auth   : %AUTH_FILE%
echo   Launcher: %LAUNCHER_FILE%
echo   Start Menu Shortcut: %START_MENU_SHORTCUT%
echo   Desktop Shortcut   : %DESKTOP_SHORTCUT%
echo.
echo Backups (if existed):
echo   %CODEX_HOME%\config.backup.%TS%.toml
echo   %CODEX_HOME%\auth.backup.%TS%.json
echo.
echo Open Codex via the "Codex Gateway" shortcut from the desktop or Start Menu.
pause

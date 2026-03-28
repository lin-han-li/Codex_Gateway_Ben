@echo off
setlocal EnableExtensions

set "CODEX_HOME=%USERPROFILE%\.codex"
set "CONFIG_FILE=%CODEX_HOME%\config.toml"
set "AUTH_FILE=%CODEX_HOME%\auth.json"
set "LAUNCHER_FILE=%CODEX_HOME%\codex-gateway.cmd"
set "START_MENU_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Codex Gateway.lnk"
set "DESKTOP_SHORTCUT=%USERPROFILE%\Desktop\Codex Gateway.lnk"

if not exist "%CODEX_HOME%" (
  echo.
  echo [ERROR] Codex home does not exist: %CODEX_HOME%
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$codeHome=$env:CODEX_HOME;" ^
  "$configFile=$env:CONFIG_FILE;" ^
  "$authFile=$env:AUTH_FILE;" ^
  "$launcherFile=$env:LAUNCHER_FILE;" ^
  "$startMenuShortcut=$env:START_MENU_SHORTCUT;" ^
  "$desktopShortcut=$env:DESKTOP_SHORTCUT;" ^
  "$restoreWarn=$false;" ^
  "$configBackup=Get-ChildItem -Path $codeHome -Filter 'config.backup.*.toml' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1;" ^
  "$authBackup=Get-ChildItem -Path $codeHome -Filter 'auth.backup.*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1;" ^
  "if($configBackup){ Copy-Item -Force $configBackup.FullName $configFile; Write-Host '[OK] Restored config.toml from:'; Write-Host ('     ' + $configBackup.FullName) } else { Write-Host ('[WARN] No config backup found under ' + $codeHome); $restoreWarn=$true }" ^
  "if($authBackup){ Copy-Item -Force $authBackup.FullName $authFile; Write-Host '[OK] Restored auth.json from:'; Write-Host ('     ' + $authBackup.FullName) } else { Write-Host ('[WARN] No auth backup found under ' + $codeHome); $restoreWarn=$true }" ^
  "foreach($path in @($launcherFile,$startMenuShortcut,$desktopShortcut)){ if(Test-Path $path){ Remove-Item -Force $path -ErrorAction SilentlyContinue } }" ^
  "[Environment]::SetEnvironmentVariable('OPENAI_BASE_URL',$null,'User');" ^
  "[Environment]::SetEnvironmentVariable('OPENAI_API_BASE',$null,'User');" ^
  "[Environment]::SetEnvironmentVariable('OPENAI_API_KEY',$null,'User');" ^
  "[Environment]::SetEnvironmentVariable('HTTP_PROXY',$null,'User');" ^
  "[Environment]::SetEnvironmentVariable('HTTPS_PROXY',$null,'User');" ^
  "[Environment]::SetEnvironmentVariable('ALL_PROXY',$null,'User');" ^
  "[Environment]::SetEnvironmentVariable('NO_PROXY',$null,'User');" ^
  "Write-Host '';" ^
  "if($restoreWarn){ Write-Host '[WARN] Restore finished with warnings. Please review messages above.' } else { Write-Host '[OK] Codex defaults restored from backup files.' }" ^
  "Write-Host '[INFO] Launching Codex in default mode...';" ^
  "$launched=$false;" ^
  "$pkg=Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1;" ^
  "if($pkg){ $aumid=$pkg.PackageFamilyName + '!App'; Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $aumid); $launched=$true }" ^
  "if(-not $launched){ $startApp=Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID -like '*OpenAI.Codex*' } | Select-Object -First 1; if($startApp){ Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $startApp.AppID); $launched=$true } }" ^
  "if(-not $launched){ $cmd=Get-Command codex -ErrorAction SilentlyContinue; if($cmd){ Start-Process -FilePath 'codex' -ArgumentList '-p','default'; $launched=$true } }" ^
  "if($launched){ Write-Host '[OK] Codex launch command sent.' } else { Write-Host '[WARN] Failed to launch Codex automatically.'; Write-Host '[WARN] You can manually run: codex -p default' }"

if errorlevel 1 (
  echo [ERROR] Restore script failed unexpectedly.
  pause
  exit /b 1
)

echo.
pause

!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif
!include "LogicLib.nsh"

!macro KillKnownProcessTree FILE
  StrCpy $R1 0
  ${Do}
    IntOp $R1 $R1 + 1
    ${nsProcess::FindProcess} "${FILE}" $R2
    ${If} $R2 != 0
      ${ExitDo}
    ${EndIf}

    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /t /im "${FILE}" 1>nul 2>nul`
    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${FILE}" 1>nul 2>nul`

    Sleep 800
    ${If} $R1 >= 8
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

!macro ForceCloseCodexGatewayProcesses
  DetailPrint `Closing running "${PRODUCT_NAME}" automatically...`
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c wmic process where "name='powershell.exe' and commandline like '^%run-oauth-server.ps1^%'" call terminate 1>nul 2>nul`
  !insertmacro KillKnownProcessTree "${APP_EXECUTABLE_FILENAME}"
  !insertmacro KillKnownProcessTree "oauth-server.exe"
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c wmic process where "name='powershell.exe' and commandline like '^%run-oauth-server.ps1^%'" call terminate 1>nul 2>nul`
  Delete "$APPDATA\oauth-multi-login-app\run-oauth-server.ps1"
!macroend

!macro preInit
  !insertmacro ForceCloseCodexGatewayProcesses
!macroend

!macro customInit
  !insertmacro ForceCloseCodexGatewayProcesses
!macroend

!macro customCheckAppRunning
  !insertmacro ForceCloseCodexGatewayProcesses
!macroend

!macro customUnInit
  !insertmacro ForceCloseCodexGatewayProcesses
!macroend

!macro customInstall
  Delete "$DESKTOP\Codex Gateway.lnk"
  IfFileExists "$INSTDIR\resources\icons\icon.ico" 0 codexGatewayDesktopShortcutFallback
    CreateShortCut "$DESKTOP\Codex Gateway.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\icons\icon.ico" 0
    Goto codexGatewayDesktopShortcutDone
  codexGatewayDesktopShortcutFallback:
    CreateShortCut "$DESKTOP\Codex Gateway.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  codexGatewayDesktopShortcutDone:
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Codex Gateway.lnk"
!macroend

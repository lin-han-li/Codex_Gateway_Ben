!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif
!include "LogicLib.nsh"

!macro FindKnownProcess FILE OUTVAR
  !ifdef INSTALL_MODE_PER_ALL_USERS
    ${nsProcess::FindProcess} "${FILE}" ${OUTVAR}
  !else
    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${FILE}" /FO csv | %SYSTEMROOT%\System32\find.exe /I "${FILE}"`
    Pop ${OUTVAR}
  !endif
!macroend

!macro KillKnownProcessTree FILE
  StrCpy $R1 0
  ${Do}
    IntOp $R1 $R1 + 1
    !insertmacro FindKnownProcess "${FILE}" $R2
    ${If} $R2 != 0
      ${ExitDo}
    ${EndIf}

    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec `taskkill /t /im "${FILE}" 1>nul 2>nul`
      nsExec::Exec `taskkill /f /t /im "${FILE}" 1>nul 2>nul`
    !else
      nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /t /im "${FILE}" /fi "USERNAME eq %USERNAME%" 1>nul 2>nul`
      nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /t /im "${FILE}" /fi "USERNAME eq %USERNAME%" 1>nul 2>nul`
    !endif

    Sleep 800
    ${If} $R1 >= 4
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

!macro customCheckAppRunning
  DetailPrint `Closing running "${PRODUCT_NAME}" automatically...`
  !insertmacro KillKnownProcessTree "${APP_EXECUTABLE_FILENAME}"
  !insertmacro KillKnownProcessTree "oauth-server.exe"
!macroend

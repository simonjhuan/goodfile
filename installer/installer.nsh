; Configure local-network transfer during installation so users do not need to
; edit Windows Firewall settings themselves. The installer runs elevated.

!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="GoodFile local transfer"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="GoodFile local transfer" dir=in action=allow program="$INSTDIR\GoodFile.exe" enable=yes profile=any protocol=TCP localport=8080-8081'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="GoodFile local transfer"'
  Pop $0
!macroend

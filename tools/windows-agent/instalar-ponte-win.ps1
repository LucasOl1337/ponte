# Installs the Ponte agent as a logon task of PratesTech (hidden, no window flash) and starts it now.
$ErrorActionPreference = 'Stop'
$dir = 'C:\ProgramData\PC-Isa\ponte-win'
if (-not (Test-Path "$dir\token")) {
  $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') | Set-Content -NoNewline "$dir\token"
}
icacls $dir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administradores:(OI)(CI)F" "$env:COMPUTERNAME\PratesTech:(OI)(CI)F" | Out-Null
$user = "$env:COMPUTERNAME\PratesTech"
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$dir\rodar-escondido.vbs`""
$t = New-ScheduledTaskTrigger -AtLogOn -User $user
$p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PCIsa-PonteWin' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ? { $_.CommandLine -like '*ponte-win.ps1*' } | % { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 1
Start-ScheduledTask -TaskName 'PCIsa-PonteWin'
for ($i = 0; $i -lt 20; $i++) { if (Get-NetTCPConnection -State Listen -LocalPort 47811 -ErrorAction SilentlyContinue) { 'LISTENING'; break }; Start-Sleep 1 }
Get-Content "$dir\agent.log" -Tail 3 -ErrorAction SilentlyContinue

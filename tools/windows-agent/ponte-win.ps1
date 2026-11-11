# Started hidden by the PonteWin task in Herrero's session (see instalar-ponte-win.ps1).
$ErrorActionPreference = 'Stop'
$dir = 'C:\ProgramData\PC-Isa\ponte-win'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
Add-Type -TypeDefinition (Get-Content -Raw "$dir\PonteWin.cs") -ReferencedAssemblies System.Drawing, System.Windows.Forms, System.Web.Extensions
$token = (Get-Content -Raw "$dir\token").Trim()
"$(Get-Date -Format s) start pid $PID" | Add-Content "$dir\agent.log"
try { [PonteWin]::Run(47811, $token) } catch { "$(Get-Date -Format s) $_" | Add-Content "$dir\agent.log"; throw }

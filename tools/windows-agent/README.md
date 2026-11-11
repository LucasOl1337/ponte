# Windows agent: a Windows PC on Ponte's Screen

Ponte does not run on Windows. To still see and drive a Windows machine from the phone, that machine runs a small agent (`PonteWin.cs`, compiled at start by Windows PowerShell 5.1, no install) and the home node talks to it over SSH.

- The agent listens on `127.0.0.1:47811` only, in the logged-in user's session (a logon task, `PCIsa-PonteWin` on the PC Isa), hidden, at below-normal priority. It answers `GET /state` (monitors, cursor, foreground window), `GET /frame?monitor=&scale=&q=&x=&y=&w=&h=` (one JPEG with the cursor) and `POST /input` (`move`, `moveTo`, `click`, `button`, `wheel`, `text`, `keys`). Every request needs `Authorization: Bearer <token>`; the token is in `C:\ProgramData\PC-Isa\ponte-win\token` (folder readable by the user, admins and SYSTEM only).
- The home node lists the machine in its private config and keeps the same token in `~/.config/ponte/windows/<ALIAS>.token` (0600):

  ```json
  "windows": { "hosts": [{ "host": "pc-isa", "label": "PC Isa (Herrero)" }] }
  ```

  `backend/windows.mjs` opens one `ssh -N -L <socket>:127.0.0.1:47811 ALIAS` per machine on first use (again if it dies), and the device list shows the machine with `can.screen`/`can.control` via `windows`. The phone's **Control** selects it like a paired node; its `/api/state`, `/api/stream`, `/api/screenshot` and `/api/action` calls carry `?node=ssh:ALIAS` and are answered here: the MJPEG stream is the same `live.mjs` code, actions are translated to Windows virtual keys (`translateAction`). Workspaces, terminals, agents, audio and the H.264 video are not offered (`DEVICE_NOT_PONTE`).
- `ponte ctl state|screenshot --node ssh:ALIAS` works too.

Install or update on the Windows machine (admin SSH session):

```sh
scp tools/windows-agent/* ALIAS:C:/ProgramData/PC-Isa/ponte-win/
ssh ALIAS powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\PC-Isa\ponte-win\instalar-ponte-win.ps1
ssh ALIAS 'Get-Content -Raw C:\ProgramData\PC-Isa\ponte-win\token' | tr -d '\r\n' > ~/.config/ponte/windows/ALIAS.token
```

Limits: about 4 frames per second at half size over the tailnet (GDI capture, one frame per request); a UAC prompt or the lock screen comes out as a dark frame, and input into elevated windows is ignored unless the task runs elevated (it does on the PC Isa).

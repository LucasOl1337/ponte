# Ponte: domain vocabulary

Terms used in code, docs, measurements and conversation. The Portuguese name is the one used when talking about the product; the English gloss is how code and docs refer to it.

## Remote desktop over an internet link

**Atraso** (delay)
: Time from the capture of a frame on the target to its drawing on the client's screen (capture → draw). The lab measures it by the time band painted in the picture (`tools/lab/rd-measure.mjs`, `rd.html?probe=1`); a real session sees send → arrival on the server's clock. Queue delay (*atraso de fila*) is the part that waits behind other bytes on the link: the age of an acked frame minus the smallest age in the last 10 s.

**Congelamento** (freeze)
: More than 250 ms without a new frame on the client. The lab counts them after the first 5 s of a run.

**Degrau** (step)
: One encoder setting (fps, kbps, maximum width) on the WAN ladder W0–W5 of `backend/rd-rate.mjs`, from W0 (15 fps, 600 kbps, 1280 wide) to W5 (30 fps, 6000 kbps, native). A session opens on W3 (30 fps, 2500 kbps, 1920 wide). Moving to another step is one *reinício do encoder*.

**Modo WAN** (WAN mode)
: A session whose link is slower than a LAN: the first round trip is 15 ms or more, or a LAN session saw its round trip or its queue grow. It uses the steps, a long keyframe interval (300 s for a page that can ask for keyframes, 60 s for one that cannot) and rationed restarts. A LAN session keeps 60 fps, 12000 kbps and a keyframe every second. A session never goes back from WAN to LAN.

**Reinício do encoder** (encoder restart)
: gpu-screen-recorder cannot change bitrate, frame rate, size or force a keyframe while it runs, so every change is a new run: about 450 ms without a frame, then a keyframe (50–200 KB). Restarts are the price of every decision: down at once when the queue grows, up one step (or straight to what a keyframe measured) after 30 s calm and at most once a minute, a keyframe on request merged within 2 s.

## Devices (ADR 0002)

**Aparelho** (device)
: A computer or phone the home node reaches, whatever the way in. One entity in code (`backend/devices.mjs`), API (`/api/devices`, `devices.list`) and UI. "Máquina", "nó" and "peer" are older names of parts of it: the fleet's machine, the mesh's node, the API's peer.

**Este aparelho** (this device, `self`)
: The node that answered: the PC for the phone, the notebook for a browser on the notebook. Every list is from its point of view.

**Rota** (route)
: One way to reach a device: `ponte` (the mesh: paired, available, pending), `tailscale`, `ssh` (an alias of `~/.ssh/config`) or `adb` (a phone this node holds). A device is online when any route says so.

**Capacidade** (capability, `can.*`)
: What can be done with a device now (screen, control, terminal, agents, sessions, info, files, wake, pair, revoke, mirror), with the route it goes through (`via`) or the reason it cannot (`why`). Decided by the home node; surfaces only draw it.

**Words** (`PonteI18n.deviceWord(group, code)` in `public/i18n.js`)
: Kinds PC, Notebook, Celular, Servidor, Outro; states online, offline, sem conferir; Ponte route pareado, disponível, não pareado, aguardando aprovação, negado, expirou, controla este aparelho; actions Ver tela, Controlar, Terminal, Agentes, Sessões, Informações, Arquivos, Acordar, Pedir acesso, Revogar, Espelhar no PC, Aprovar, Negar, Continuar aqui. Every `why` code has one short sentence ("Não roda a Ponte.", "O SSH não respondeu."). A surface never prints a code.

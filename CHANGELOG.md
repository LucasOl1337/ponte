# Changelog

All notable changes to Ponte. The project is an experimental alpha; entries describe what was built and how it was verified, not promises.

## 0.1.0-alpha.40 (2026-10-01)

The Agents panel counts what is really open and says who is who. Server and page only;
the installed APK keeps working.

- **The right number.** JCode, Hermes and other harnesses are now detected; shared servers
  (`jcode serve`, Codex's app-server, sandboxes) and processes that only inherited a Maestri id
  no longer count. One item per Maestri terminal, even after the app restarts. The header says
  "N AGENTS · M BUSY" instead of an active count that read like a total. Shells with no agent
  are listed apart.
- **Who is who.** Each agent shows its canvas name, workspace, team (who recruited it, from
  the canvas ropes), Maestri role, model and effort, branch and the last thing it did. Teams
  are grouped by workspace with their lead on top, marked "Team lead (canvas connections)".
- **State from the transcript.** Codex and JCode turns come from what they write
  (task started or complete, an unanswered tool call), not from CPU.
- Read-only: transcripts are read from their last 96 KB, again only when they grew; a JCode
  snapshot over 100 MB is never read whole. On this PC a scan takes 55 ms with 19 agents.
- Verified: `npm test` 488 pass, 1 skipped; fake lab 8 agents in 2 teams; the real PC
  matched process by process (14 Maestri agents, nothing missing or extra).

## 0.1.0-alpha.39 (2026-10-01)

One list of your devices on the phone's Home (ADR 0002, slice 4). Page and one new reason
code; the installed APK keeps working.

- **"Your devices" replaces the separate devices card and the machine list.** One row per
  device (this PC, the notebook, servers, phones), with kind, state, routes (Ponte, Tailscale,
  SSH, ADB) and one main action: View screen on the device on screen, otherwise Control,
  Terminal or Ask for access; Agents and Sessions beside it, Revoke behind "…". When a device
  cannot be reached the row says why, in words. Incoming requests come first; offline
  unpaired devices fold under "Show N offline devices".
- **The header selector reads the same list:** only what can be controlled from here, and the
  device on screen stays selected if it goes offline.
- **Agent sessions** are their own card again ("Continue here"), filtered by the selected
  device with "show all".
- New reason `SSH_NOT_LISTED`: the device has an SSH alias that is not in Ponte's
  `ssh.hosts`, instead of "no route".
- A slow deep check behind the alpha.24 APK's 15 s proxy timeout shows the error, keeps the
  last good list and retries the cached read after 30 s.
- Verified: `npm test` 472 pass, 1 skipped; two-node lab with the phone layout (pair, approve,
  control the notebook, its screen).

## 0.1.0-alpha.38 (2026-10-01)

The Screen tab: nothing on the PC stays stuck under a floating button, and messages leave.
Page only; the installed APK keeps working.

- **Fix: a PC target under the mic (or any floating button) could not be tapped.** The
  button column was fixed over the picture and the pan stopped at the picture's edge, so the
  bottom-right corner of the PC sat under the mic at any zoom. The picture is now framed in
  the free area (the preview minus the controls, measured from their real boxes): at 1x it
  touches no control in portrait, landscape or with the keyboard, and zoomed in the pan
  goes past each edge by the size of the control there, so every PC pixel can be brought
  out and tapped. In portrait the buttons are one row in the black band under the picture.
  Lab (Poco 394x853 @3.25, 3440x1440, a target at 3390,1400): before, the tap landed on the
  mic; now it reaches the PC in portrait, landscape and with the keyboard, at Sharp 8x and
  Auto 4x.
- **Fix: "You said: …" never went away.** The dictation bubble and the toasts on the Screen
  tab sit at the top, take two lines at most, let touches through to the PC, and leave after
  a reading time (2.5 s + 55 ms a character, 9 s at most) or at the first touch on the
  picture. Progress ("Recording", "Transcribing") stays until it changes.
- Lab: `tools/lab/overlays.mjs` / `overlays-matrix.sh` (how much of the picture each control
  covers) and `tools/lab/under-fab.mjs` (the target-under-the-mic case), with
  `PONTE_LAB_TARGET_D` drawing an extra button "E" anywhere on the synthetic monitor.

## 0.1.0-alpha.37 (2026-10-01)

Pages and server messages; the installed APK keeps working.

- **Fix: "Bad connection · only 0 frames per second" for the first second of every
  session.** The verdict waited for nothing; it now appears one second after the first
  picture. Seen in the acceptance run against the two-node lab.
- **Fix: a device name that matches nothing said "This device is not paired…",** which read
  as if this PC were the problem. `MESH_PEER_NOT_FOUND` now says "No device with that name or id
  was found." (server and page), which also reads right when pairing.
- Verified: `npm test` 0 fail; an end-to-end acceptance on the two-node lab in a Chromium
  bench (rd-ux and the device picker) passed 26 of 26 twice.

## 0.1.0-alpha.36 (2026-10-01)

Pages and one server fix; the installed APK keeps working.

- **Auto picks the readable picture on a slow link.** On the phone, Auto with the video now
  hands over to JPEG Sharp when the video stays under the monitor's width for 8 s (under
  the native width it is never readable: 1920 px on a 3440 monitor is as soft as Balanced),
  and goes back to the video when two 3 s JPEG windows show room for a native step
  (8 Mbit/s, counting only the time spent sending, not grim's capture) and a wait has
  passed: 20 s, doubled on every hand-over up to 5 min, back to 20 s once native held a
  minute. A workspace opened meanwhile goes straight to JPEG Sharp. The alpha.24
  fallback and the "Nativo" choice are unchanged. Lab, 3440×1440 with 14 px text, readable =
  as sharp as JPEG Sharp: 2.5 Mbps never → from 11 s (83% of a minute); 20 → 2 → 20 Mbps
  14% → 85% of a minute, 9% → 82% of two; 2.5 → 30 Mbps from second 30: never readable →
  JPEG from 12 s, back on native video at 42 s and held; home link unchanged (native from
  6 s, no hand-over). Behind a proxy that refuses `/api/rd` like alpha.24: 0.2-0.4 s to a
  readable frame, as before.
- Lab: `tools/lab/auto-measure.mjs`, the phone's Auto over `rd-link.sh` (`RD_LINK_CLIENT`).
- **Fix (alpha.35): a tap on the Maestri canvas still opened the keyboard after a hover.**
  With follow_mouse, the owner's mouse or a phone scroll makes Maestri active with no input
  context focused, and the next tap only brings its own context back (8 of 51 measured
  clicks). The server now remembers the window of the last phone tap, and the first tap
  into another window counts as entering it, so it does not open the keyboard by itself.
- **The remote desktop's device picker reads the one device list** (`GET /api/devices`,
  ADR 0002). Each device says name, kind and state in words ("notebook-teste · Notebook ·
  online"); only what `can.control` allows is selectable, the rest sits under "Sem controle
  daqui" with the reason ("Não roda a Ponte.", "Está offline."), never a code. The list is
  read again every 30 s. A server without `/api/devices` falls back to `/api/mesh`.
- **"Este aparelho" has one spelling across the phone and the PC:** `{name} · este
  aparelho`; the rd-only keys `{name} (este aparelho)` and `{name} (offline)` are gone.
- Verified: `npm test` 450 pass, 1 skipped (new: picker from `/api/devices`, name/any-id
  `node=`, the device on the screen stays selectable, 500 does not fall back, 30 s refresh);
  two-node lab in a Chromium bench: the picker switched pc-teste ⇄ notebook-teste (monitor
  1920×1080 ⇄ 1366×768), `?node=notebook-teste` by name selected the notebook, and an
  alpha.33 server (no `/api/devices`, 404) still listed and switched through `/api/mesh`.

## 0.1.0-alpha.35 (2026-10-01)

The remote desktop page (`rd.html`) says in words where the keyboard goes and how the
connection is, and has a settings panel; the phone keyboard stops opening on taps that
are not on a field. Server and pages; the installed APK keeps working.

- **Ctrl+Alt+Shift now switches both ways, without full screen.** Before, the chord only
  released and taking control needed a click or full screen. Only the chord alone counts
  (Ctrl+Alt+Shift+T stays a shortcut here) and it never reaches the device. The bar's
  centre shows "Keyboard and mouse → notebook" (clickable), a big notice flashes for
  1.2 s on each switch, the stage gets a green frame and the window title starts with
  `⌨ notebook ·` while controlling.
- **The bar says the connection in words.** "Good connection" / "Unstable connection ·
  picture arriving late (up to 106 ms)" / "Bad", worst of the last 3 s; fps, Mbps, RTT
  and p95 moved to the settings' technical details with a legend.
- **Settings (gear):** pointer "Direct" / "Locked (games and 3D)" with an explanation
  (was Abs/Rel), the key list and what the window cannot get (Super, Ctrl+T), the chord
  can also enter full screen, a frame limit (60/30/15, sent as `maxFps`), clipboard
  sharing on/off, language.
- **Fix: the phone keyboard opened on any tap on the Maestri canvas.** The server called
  any focused fcitx input context a text field, and Maestri keeps its own focused 97% of
  the time it is active (45 real canvas clicks: same context before and after). A left tap
  now brings back the context focused before it and whether the active window changed;
  the phone opens the keyboard by itself only when the tap caused the focus in the same
  window (none -> one, or another field). A tap that also activates another window does
  not open it; the keyboard button always does; an automatic bar closes when the focus
  leaves its field; new "Auto keyboard" switch in the bar's options. Lab: canvas tapped
  3x, old rule opened 3, new 0, fields still open. Older pages keep the old answer.
- **Optional, not installed:** `tools/hypr/ponte_rd.lua` + `tools/hypr/ponte-rd-hypr.sh`
  (check/install/remove) put Hyprland in an empty submap while the rd window's title has
  the `⌨` mark, so Super reaches the device from the window too; exit with
  Super+Ctrl+Alt+Esc. See `docs/rd-control.md`.
- Verified: `npm test` 412 pass (new: both-way chord, settings, link verdict,
  install/remove byte for byte on a copy); the lab in a Chromium bench (keys reached the
  fake desktop as `KEY_A` only after the chord; the chord itself sent nothing); the live
  Hyprland config with the module passes `Hyprland --verify-config`.

## 0.1.0-alpha.34 (2026-10-01)

A readable screen at once, and one device model under every surface (ADR 0002, slices 1-3).
Only the server and the pages change. The installed APK keeps working; the alpha.33 shell
code (WebSocket tunnel for `/api/rd`, versionCode 22) is in the tree but not shipped yet.

- **Devices: one model served by the home node.** `backend/devices.mjs` composes the mesh,
  the fleet and `adb devices` into one list of devices (kind, status as the union of routes,
  `routes` over Ponte/Tailscale/SSH/ADB, `can` with `via` or `why`). Same body through
  `POST /api/action {type:'devices.list'}` (the only door old APKs allow), `GET /api/devices`
  and `./ponte devices` / `ponte ctl devices`; owner only, home node only. A paired node that
  is online over Ponte with SSH down is now online, not "no connection" (lab, two nodes).
  Optional `kind` in the mesh hello. `/api/mesh`, `/api/fleet` and `/api/state` keep their
  shapes. See docs/devices.md and docs/adr/0002-one-device-model.md.
- **One resolver.** `?node=` (every route and `/api/rd`), `ponte ctl --node`, `./ponte rd
  DEVICE` and the fleet (`--from/--to`, probe, check) take a device name or any of its ids;
  unknown is 404, a name two devices share is 409, 16-hex ids and `self`/`ssh:ALIAS` pass as
  before. New codes `MESH_PEER_NOT_PAIRED` and `DEVICE_NOT_PONTE`.
- **Words.** `public/i18n.js` gains the device vocabulary (kind, state, route, action, every
  why) in both languages, with `PonteI18n.deviceWord`; no layout change yet.
- **Fix: the fleet hid real Claude sessions.** The probe dropped every session whose folder
  contained "/tmp/" anywhere, so a project with a `tmp` folder (and every session of a home in
  a temp directory) never showed up to continue. A session is scratch now only when it ran
  under /tmp, /var/tmp or $TMPDIR by path and outside the home. This was the one test that
  failed since alpha.32.
- Tests: mesh tests no longer read the real tailnet or SSH config, and a race on `mesh.json`
  right after pairing (2 in 10 runs on the base) is fixed.

- **Fix: every screen opened blurry for ~12 s.** Auto started each session at Light (0.35,
  1204 px wide on a 3440 monitor) and climbed one rung per two 3 s windows, so Sharp came
  12-13 s later. A workspace on another monitor (on a three-monitor PC, most of them), a
  monitor switch or a return from the background is a new session, so it happened again
  each time. Auto now opens at the rung the last session with this PC settled on, or at
  Sharp without one from the last 30 min, and still steps down in the first window when
  frames lag. Lab, 3440×1440, emulator Chrome behind a proxy that refuses `/api/rd` like
  the alpha.24 APK: time to the first 3440 px frame 12.7 s → 0.6 s cold, 12.4-13.3 s →
  0.3-0.4 s per workspace on another monitor, 12.5 s → 0.9 s back from the background; at
  6 Mbit/s Sharp steps down after ~2 s and the next session opens at the remembered rung.
- **Fix: a video socket that never opens no longer holds the screen for 9 s.** If the
  WebSocket has not opened in 3 s the page goes to JPEG; one that opened still gets 9 s for
  the encoder's first frame. Behind a proxy that holds the upgrade: 23.5 s → 3.8 s to a
  readable frame. (The alpha.24 APK answers `/api/rd` with 404, which already fell back at
  once: ~0.2 s.)
- Lab: the fake `hyprctl` lists one workspace per extra monitor, so a workspace chip
  follows it to another monitor as on a multi-monitor PC.
- **Fix: the video over a roomy internet link stayed at 1920 px for ~45 s.** A session over
  15 ms (Tailscale at home) opens on W3, 1920 px wide: on a 3440 monitor the text is as soft
  as the phone's Balanced JPEG, and the first climb waited 30 s of calm. Now, in the first
  20 s of a run on the steps and before any fall, a keyframe that crossed with twice the room
  a higher step needs (and 2 s without a queue) climbs there at once; a move from the LAN
  that was only far, not queued, opens the same way. After a fall the old rules stand.
  Server only. Lab, 3440×1440 with 14 px text, legible = as sharp as the JPEG Sharp
  (27 dB on still text): 30 Mbps at 24 ms readable from 45 s → 5 s; LAN unchanged (1 s);
  2.5 Mbps never readable before or after (nothing under ~4 Mbps is, at native width
  either); 20 → 2 → 20 Mbps readable 13-17 s, then steps down with the link. Smoothness of
  ADR 0001 unchanged: no share over 500 ms, no stretches, the same freezes, p95 within the
  run-to-run spread.
- **Fix: the first keyframe of a session measured the link far too fast.** Its capacity was
  timed against a base round trip that already held the keyframe's own age, so the crossing
  counted as nothing: 110 KB on 2.7 Mbps came out as 17.6 Mbps.
- Lab: `tools/lab/text-backdrop.sh` and `PONTE_RD_LAB_BACKDROP` (small native text under the
  desktop scene), `rd-measure.mjs --legible` (PSNR of still text over time, time to
  readable).

## 0.1.0-alpha.33 (2026-09-30)

Picture quality on the phone and on the notebook. Three causes, each measured or seen in the
logs, none of them the link itself. Only the server and the pages change; the APK does not
(still versionCode 21).

- **Fix: the phone's Auto never reached Sharp on a big monitor.** grim scales on the CPU:
  on the 3440×1440 monitor Light takes 134 ms a frame and Balanced 141 ms (Sharp, unscaled,
  18 ms). Balanced asks 10 fps and could only ever make ~7, so Auto read a capture-bound
  stream as a slow link and stayed there, blurry, even on the home Wi-Fi. Each frame now
  carries `X-Capture-Ms` and Auto judges arrivals against what the PC can capture.
- **Fix: keyframe storms on the internet link.** The remote desktop page dropped a delta as
  soon as the decoder had more than two frames waiting. Over the internet frames arrive in
  bursts, so each burst asked for a keyframe, each keyframe was a new encoder run (~450 ms
  without a picture), and three a minute stepped the quality down: a real session on
  2026-09-30 spent 1 h 45 min on the lowest step (1280 px, 15 fps) with 35 key restarts. The
  server now tells the page `{t:'link', mode:'wan'}`, and there a delta is late only with a
  second of frames waiting. On the LAN nothing changes.
- **Fix: one stall sent a still desktop to the floor.** A step down went to what the link
  had delivered, but without a standing queue that is what the encoder made: a few hundred
  kbps on a still desktop, below every step. Without a queue it is now a fresh keyframe
  measurement or one step.
- **The stage can grow.** The width limit came from the page's size at connect, so a
  window opened small and then maximized stayed at the small picture for the whole session.
  The page sends `{t:'view'}` on resize, and the server restarts only if the limit changes.
- Verified: new regression tests for each (each fails on alpha.32); `tools/lab/rd-link.sh
  --plan 0:2500kbit --client new --seconds 45`: p95 115 ms, no freeze, one restart, as in
  alpha.31. `npm test`: the two failures (`fleet` Claude handoff, `phone wake`) were already
  failing on alpha.32.

## 0.1.0-alpha.32 (2026-09-30)

Ponte becomes a hub for the machines you reach over Tailscale and SSH: it lists them, checks
each route and lets an agent session started on one computer continue on another (notebook at
the office, PC at home). Only the server and the page change; the APK does not (still
versionCode 21). See docs/fleet.md.

- **Machines and connections.** One list from `tailscale status`, the concrete hosts of
  `~/.ssh/config` (resolved with `ssh -G`) and the mesh. Each key route is checked through a
  private SSH master (latency, or `TIMEOUT`/`DNS`/`REFUSED`/`AUTH`/`HOST_KEY`/...), and each
  reachable machine is probed for its agents and recent Claude Code, Codex and Jcode sessions
  by a stdlib Python script sent over SSH: nothing is installed there.
- **Continue here.** A handoff job brings the project by fast-forward (a git bundle of the
  missing commits), optionally carries uncommitted changes as a patch, copies the session with
  its paths rewritten and resumes it in a Ponte terminal (`claude --resume`, `codex resume`,
  `jcode --resume`). A dirty destination, a diverged branch, an open agent or a newer copy
  stops it with a `FLEET_*` code and en/pt text; nothing is discarded.
- **Where.** Home card "Machines and connections" on the phone (through `/api/action`, which
  the phone's proxy relays), `./ponte fleet [list --check|sessions|continue]`, and
  `ponte ctl fleet ...` for agents.
- Verified: `tests/fleet.test.mjs` runs real handoffs between two homes through a fake `ssh`
  (fast-forward plus patch, dirty and diverged refusals, `DEST_NEWER` with backup, Codex and
  Jcode copies); by hand, notebook → PC for Claude (history reopened), PC → notebook for Codex
  (resumed with history), Jcode resumed here, and the phone card in the two-node lab (list,
  a diverged refusal, a successful "Continue here" and "Open terminal"). `npm test`: 398 pass.
- Follow-up verification: a synthetic Claude conversation went PC → notebook through the
  running fleet job, and its resume opened a terminal on the paired mesh node over TLS.
  Reading that terminal through `ponte ctl --node ... terminals read` showed the original
  history and the notebook's rewritten cwd, after approving only the synthetic folder's
  trust prompt. The terminal was closed and both test copies archived, not deleted.
  Five new regression cases cover remote resume (HTTP 200/201), HTTP failure, exceptions
  and an unpaired destination, preserving the copied history and manual command on failure.
  `npm test`: 403 pass, 1 skip. The real phone card remains unverified: Redmi was offline.

## 0.1.0-alpha.31 (2026-09-29)

The remote desktop page now tells the watched computer which frame arrived, so an internet
link is paced from what it really delivers, and alpha.30's worst case on a very bad link is
gone. Both computers need this version for the new page (`./ponte rd` loads the page from the
computer it runs on); the watched one alone already gets the fixes. The APK does not change
(still versionCode 21).

- **Fix: a stall of up to a minute on a very bad link (alpha.30).** On the internet ladder a
  new encoder run's keyframe could be dropped behind what the previous run had queued, and an
  alpha.29 page then waited for the safety keyframe: 55 s frozen in the lab at 2.5 Mbps with
  3 % loss. The new run's keyframe now always goes out, and a key request merged into a
  restart is asked again.
- **Per-frame acks.** The page acks the last frame that arrived (at most every 50 ms,
  before decoding). On its own clock the watched computer reads the queue (age over its
  10 s floor), what the link delivers (acked bytes) and what is in flight, and steps down
  after half a second over 150 ms instead of two stats a second apart. A keyframe's burst
  also measures the link, so a climb can skip steps.
- **Keyframes on request.** A page that lost its reference sends `{t:'keyframe'}`
  (`{t:'key'}` is already a keystroke); with it the periodic keyframe outside the LAN is every
  300 s. The hello announces `caps: { ack, key }` and the stage size (`view`), and outside the
  LAN the picture is never encoded wider than the stage.
- **No blank start on a slow link.** The page used to drop the frames that arrived while its
  decoder was being set up, and waited for the next keyframe; it now decodes them as one
  burst. For an alpha.29 page the watched computer asks for a keyframe as soon as the previous
  one has landed.
- **Docs:** `CONTEXT.md` (vocabulary), `docs/adr/0001-rd-ack-control-over-tcp.md` (why acks
  over TCP now, WebRTC later), the new messages and the BBR note in `docs/mesh.md`.

Measured in the lab (desktop scene, 60 s each), new page / alpha.29 page against the new
computer: 2.5 Mbps with 1 % loss p95 110 / 165 ms, no freeze; a drop from 20 to 2 Mbps
recovers in 2-3 s / 4-5 s (25 s in alpha.29); 3 % loss p95 219-276 / 196-254 ms; LAN 60 fps,
p95 4 ms, no restart. Through two mesh nodes in a bench Chromium at 2.5 Mbps and 24 ms, glass
to glass p95 was 111-114 ms with the first picture in the 2nd second, against 204 ms and a
sawtooth with both sides on alpha.29.

## 0.1.0-alpha.30 (2026-09-29)

Remote desktop over an internet link stops piling up seconds of video. The node that is
being watched does all of it, so an older page (the notebook's alpha.29) benefits as soon as
the watched computer updates. The APK does not change (still versionCode 21).

- **Why it lagged.** On the notebook away from home, the PC's kernel held 400-850 KB of
  unsent video on the RD socket while the link delivered 1.2-2.6 Mbps: 2 to 5 seconds of
  picture waiting (`ss -tin`, `notsent`). The session only looked at Node's own buffer,
  which stayed empty, so it kept sending up to 6 Mbps. A keyframe every second
  (110-200 KB from gpu-screen-recorder at 1080p, against 3-6 KB per delta) added a
  ~350 ms stall each second on a 2.5 Mbps link.
- **LAN or internet, decided before the first frame.** Three WebSocket pings on the empty
  link: under 15 ms keeps today's LAN encoder (60 fps, 12 Mbps, native size, one keyframe a
  second). Otherwise the session opens on a ladder of internet steps, from 30 fps at 6 Mbps
  down to 15 fps at 600 kbps. Frame rate falls before the width, so text stays readable
  (1920 px wide until the floor, 1280 only there). A LAN session that turns slow moves to
  the ladder once and stays there.
- **Queue seen by the page's own pings.** The pong waits behind the video, so the round
  trip over its floor is the queue. Two bad reports step down at once, in one encoder
  restart, to what 80 % of the received rate carries; a keyframe's own burst does not
  count. Climbing is one step after 30 s calm, at most once a minute, with a doubling wait
  for a step that just failed. On the floor the node stops sending until the queue drains.
- **Keyframes on demand.** On the internet ladder the periodic keyframe is every 60 s
  instead of every second; a page that drops frames (its stats say so) gets one at once, as
  does any frame the node itself has to drop.
- **LAN fix:** a keyframe larger than the LAN ceiling (~350 KB at 12 Mbps) made the next
  deltas fall over it until the following keyframe, about a second frozen and a restart.
  The ceiling now leaves room for that keyframe for up to a second.
- **Lab:** `PONTE_RD_LAB_SCENE=desktop` paints a desktop with scrolling text whose
  keyframes and deltas are the size gpu-screen-recorder makes them, and
  `tools/lab/rd-link.sh` runs `rd-measure.mjs` in a private network namespace with netem,
  with an alpha.29 page emulated (`--client old`) and a per-second timeline.

Measured in the lab (desktop scene, alpha.29 page emulated, 60 s each), before → after:
2.5 Mbps with 1 % loss, capture → arrival p95 466 → 114 ms and freezes over 250 ms from
53 a minute to none; 2.5 Mbps with 3 % loss, p95 1206 → 191 ms and frames over 500 ms
from 41 % to none; a drop from 20 to 2 Mbps recovered in 25 s before and 4-5 s now. LAN:
60 fps, p95 4.9 ms, no restart; five LAN runs froze for ~1 s in 2 of 5 before and 0 of 5
now. `tcp_notsent_lowat` alone made the old code slightly worse, so no sysctl ships.

## 0.1.0-alpha.29 (2026-09-28)

SSH machines open as Ponte terminals, from the phone, from the other computer and from agents. The APK does not change (still versionCode 21).

- **SSH in Home and Dev.** A node lists outside machines in its private config
  (`ssh.hosts`, aliases from that user's `~/.ssh/config`, with an optional label). Home and
  Dev then show **SSH** next to Claude, Codex and Terminal, and the folder list becomes the
  machine list. The session runs `ssh ALIAS` in the node's private tmux, as one argv word;
  a first line is typed into it like a shell's. The button is hidden on a device without
  machines, and the folder and machine lists reload when the phone switches devices (they
  used to stay with the first device until the pairing changed).
- **`ctl`:** `terminals places` lists folders and machines, and `terminals create --agent ssh
  --host ALIAS` opens one, also with `--node`.
- **Refused before tmux runs:** an alias outside the list, a `user@host`, anything that
  starts with a dash, a host on a non-SSH session, and a project on an SSH one
  (`SSH_HOST_NOT_ALLOWED`). The config rejects an invalid list at startup.
- **Keys stay where they are.** The work VM's key lives only on the notebook and the
  Hostinger VM's only on the PC. Each computer reaches the other's machine through an `~/.ssh/config`
  hop over the 2222 link (`RemoteCommand ssh ALIAS`), documented in `docs/mesh.md`.
- **Remote desktop loads this build.** `rd.html` still asked for the alpha.28 `rd.js`,
  `rd.css` and `i18n.js`; its `?v=` now follows the version, and a test checks every
  `?v=` in `index.html` and `rd.html` against `package.json`.
- **Docs:** `docs/cli.md` covers `terminals places` and `terminals create --agent ssh --host`.

Verified on the real PC: after the service restart, `ctl terminals places` listed both machines,
and `ctl terminals create --agent ssh` opened the work VM (through the notebook) and the
Hostinger VM, each answering `hostname` in the session. From a terminal, each computer
reached the other one's VM through its hop alias. `npm test`
(357, 1 skip) passes, with new cases for the allowlist, the config and the Home and Dev
choice.

On the notebook, after the update, `ctl terminals places` listed both machines, and from
the PC `ctl terminals create --agent ssh --host ALIAS --node notebook-omarchy` opened the
Hostinger VM through the notebook's hop and answered `hostname`.

At release: `npm test` (359, 1 skip) and the desktop CLI tests (120) pass. On both nodes
`ctl terminals places` lists the two machines.

The alpha.28 item left open is now verified: Ponte Remoto was opened on the notebook
itself at 19:49 and has shown the PC since. The PC logged one remote desktop session of
188,455 frames at 56.6 fps (about 4.6 Mbps) that ended only when the service restarted
for this version, and the notebook reconnected by itself right after.

Not yet verified: the SSH choice on the real phone (in use during the first round, off the
tailnet at release time).

## 0.1.0-alpha.28 (2026-09-28)

The other computer is one click away: **Ponte Remoto** in the app menu opens its screen. The APK does not change (still versionCode 21).

- **Ponte Remoto in the app menu.** `./ponte rd --install` adds a per-user menu entry
  (no autostart) that opens the remote-desktop window on the first paired device that
  is online. The bar's picker switches to any other device. `./ponte rd` with no device
  does the same (it used to open this machine, which is `./ponte rd self` now), and falls
  back to this machine when nothing is paired. The menu entry passes `--notify`, so a
  failure shows as a desktop notification instead of vanishing. `./ponte rd --uninstall`
  removes the entry, and an entry the owner wrote under the same name is never replaced.
- **`ponte doctor` on a mesh node without an APK** stopped warning about the missing
  `.work/Ponte.apk`. The warning stays for a node whose config has an `android` block;
  any other node gets an `[info]` line, which is not a problem.

Verified on the real PC: the menu entry, launched in an agent bench, opened the
notebook's screen live (eDP-1 1920x1200, 30 fps while idle, RTT 4.6 ms), and the owner
found it in the Omarchy launcher and used it. On the notebook, the same entry resolves to
the PC's node. `desktop-file-validate` accepts the entry on both. `npm test` (356, 1 skip)
and the desktop CLI tests (36) pass.

Not yet verified: the notebook's entry opened on the notebook's own screen (only the URL
it builds was checked), and a device list with more than one other computer.

## 0.1.0-alpha.27 (2026-09-28)

The mesh on real hardware: this PC drives the notebook (and back) by agent API and by remote desktop, and the two computers reach each other over SSH with no browser check. The APK does not change (still versionCode 21).

- **`ponte ctl --node NAME|ID`.** Any `ctl` command except `health` goes to a paired
  device through the home node, with the home node's own key. A name is looked up in
  `/api/mesh` among paired devices (without case); a 16-hex id is used as is. A device
  on the tailnet that is not paired gets `MESH_PEER_NOT_PAIRED` with the pair command
  to run. `--dry-run` shows the relayed path for an id, offline.
- **The input helper opens its uinput devices write-only.** python-evdev read each new
  device back through `/dev/input/event*` and retried for two seconds when it could
  not open it, which is the case for a service started before its user joined the
  `input` group. On the notebook the first keys of a session arrived about 4 s late
  and all at once; the helper is now ready in ~130 ms.
- **`ponte mesh --json pair`** printed nothing. It prints the server answer (pending
  with its code under `--no-wait`, or paired), with the code on stderr while waiting.
- **`ponte doctor`** reported `[fail] auto-pairing denied (403)` on every computer
  since alpha.25, where the refusal is the intended answer. It now expects it and
  names the tailnet owner the phone's pairing depends on.
- **Docs:** agents through `--node` in the CLI guide and in `docs/mesh.md`, and the
  key-only OpenSSH on port 2222 between the owner's computers (tailnet only), which
  avoids Tailscale SSH's browser check.

Verified with `npm test` (355, 1 skip), including a two-node test where `ctl --node`
reads B's state and runs an action on B only, by name and by id.

Measured on the real pair, the PC (NVIDIA, 3 monitors) driving the notebook (Radeon
680M, eDP-1 1920x1200 at scale 1.5, Hyprland 0.56, br layout under fcitx5) through
the PC's own node, Tailscale direct on the LAN (2 ms ping):
- **Agent API:** `state`, `windows`, `volume` and `terminals list` with `--node` from
  the PC to the notebook, by name and by id; `state --node` from the notebook to the PC.
- **Video:** VAAPI H.264 (`avc1.640c32`) at 60 fps. First keyframe 0.47 s after the
  hello. Frame age from the notebook's send to arrival here (two NTP clocks):
  - idle screen: p50 3 ms, p99 22 ms, ~1.2 Mbps;
  - a terminal pattern redrawn every frame over half the screen: p50 4 ms, p99 17 ms,
    ~12.5 Mbps (the bitrate ceiling).
  Round trip over the WebSocket: 3 ms p50.
- **Key to pixels:** 14 letters typed into a test terminal on the notebook, the H.264
  that came back decoded with ffmpeg and diffed: 44 to 62 ms from the key leaving this
  PC to the frame with the letter arriving (p50 52 ms, one clock). Browser decode and
  display are not included.
- **Keys:** evdev timestamps on the notebook 2 to 4 ms after each send (one at 30 ms),
  in order. Super+8 and Super+9 switched workspaces, Hyprland's socket2 reporting
  the switch 3 to 4 ms after the key.
  The text `ola ponte ç á A / @ / ẽ`, AltGr and dead keys included, arrived through
  the br layout and fcitx5 as typed.
- **Pointer:** absolute positions (0.25, 0.25), (0.75, 0.25), (0.75, 0.75), (0.1, 0.9)
  and (0.5, 0.5) landed on the exact logical pixel (1280x800 at scale 1.5).
- **Clipboard:** text went both ways in one session, PC to notebook and notebook to PC.
- **SSH:** `ssh notebook` and `ssh pc` log in by key on 2222 with no prompt; 2222 is
  closed on both LAN addresses.
- **The real client:** `rd.html` in Chromium (an agent bench, X11, software decode)
  driving the notebook through the PC's node: 60 fps, 0 drops, frame latency (send to
  draw) ~5 ms mean. The page's input-to-photon probe (pointer moved 2 px, timed to the
  first drawn frame that shows it) gave 44.6 to 59.8 ms, 46 ms median, over 10 rounds.
  A click and typed text reached the test terminal, and the clipboard went both ways
  through the page (after the browser's clipboard permission).

Not yet verified: a slow or relayed (DERP) link, Keyboard Lock in full screen on a
Hyprland session (the bench is X11), and the client on the notebook driving the PC.

## 0.1.0-alpha.26 (2026-09-28)

A remote-desktop client for computers: real keyboard and mouse on another Omarchy machine, with low-latency video, instead of the phone's streamed snapshots. The APK does not change (still versionCode 21).

- **`./ponte rd [device]`** opens `rd.html` in a Chromium `--app` window with its own
  profile (`$XDG_STATE_HOME/ponte/rd-chromium`), never the owner's browser. The same
  page works in any Chromium, Windows included.
- **Video.** The node captures one monitor with `gpu-screen-recorder` (KMS capture,
  hardware H.264: NVENC here, VAAPI where that is the GPU, 60 fps CBR, one keyframe a
  second) and sends access units over a dependency-free WebSocket (`/api/rd`). The page
  decodes them with WebCodecs on a low-latency canvas. Late deltas are dropped to the
  next keyframe; lasting congestion lowers bitrate and fps, calm raises them back.
  Monitors can be switched from the bar.
- **Input.** Keys go as `KeyboardEvent.code` to a persistent uinput helper
  (python-evdev) as evdev keycodes, so the target's own layout (br/intl, fcitx5)
  applies and no keymap is uploaded (no wtype). In full screen the page takes Keyboard
  Lock, so Super, Alt+Tab, Ctrl+W and the like go to the target. The mouse is absolute
  by default, through an absolute uinput device mapped onto the Hyprland layout.
  Pointer Lock gives relative mode for games and 3D. Buttons 0 to 4 and the
  high-resolution wheel are supported. Everything held is released when the window
  loses focus, the session ends, or input goes quiet for 2 s while something is
  pressed.
- **Release** with Ctrl+Alt+Shift alone or Esc held for 2 s. **Clipboard** (text, up
  to 1 MiB) goes both ways. One controlling session per machine: a new one takes over
  and the old tab says so.
- **Through the mesh.** `/api/rd?node=<paired device>` goes through the home node,
  which checks the owner key and opens its own connection to that node with the peer
  token and pinned CA. The two are joined only after the far node answers:
  - a revoked link becomes `PEER_REVOKED` and is forgotten;
  - a peer is never relayed onward.
  The target shows a desktop notice when a paired node takes its screen.
- `state.capabilities.rd` says whether this node can serve a session (gsr,
  python-evdev, writable `/dev/uinput`).

Verified with `npm test` (351, 1 skip). The tests cover:
- the WebSocket framing, including limits, fragmentation, close and the Node 26 client;
- the MPEG-TS demux on an ffmpeg fixture;
- the full key map and the absolute mapping over a three-monitor layout;
- sessions, takeover and release;
- a two-node test where the owner on A drives B through the relay (and the refusals);
- DOM tests for the client.

Measured:
- **The lab (synthetic 1080p60 with a time band), in a bench browser:** 60 fps and
  glass-to-glass (capture to draw) p95 ~4 ms. Keys, clicks, wheel, clipboard, takeover
  and the release chord arrived at the dry-run input log. In full screen with Keyboard
  Lock, Super and Alt+Tab reached the page (an X11 bench: this proves the client side,
  not yet Hyprland's shortcut inhibitor).
- **The real PC:**
  - Capture of the 3440x1440 monitor: 60 fps at ~11 Mbps, about 0.2 ms from the
    encoder's output to the socket.
  - Passive (input off) in a bench browser with software decode: 60 fps, 0 drops, and
    frame latency (server send to draw) of ~5 ms on average, p95 ~8.5 ms.
  - The absolute uinput device, checked harmlessly (the pointer sent to where it was,
    then 2 px and back), landed on the exact pixel across the three-monitor layout.

Not yet verified:
- keys on a real Hyprland session (layout and fcitx5 through uinput, Super, AltGr);
- capture-to-encode time;
- a slow link;
- the real notebook, whose Tailscale SSH still needs the owner's browser check.

## 0.1.0-alpha.25 (2026-09-28)

Ponte becomes a mesh: every Omarchy machine runs the same node, and one node controls another only after being approved on it. The APK does not change (still versionCode 21); the page reloads with the new version.

- **Nodes and discovery.** Each node keeps an identity (`node.json`: id and tailnet
  name). It finds other nodes among the online, untagged tailnet devices of the same
  owner by asking `GET /api/mesh/hello` on their tailnet listener (cached 30 s).
- **Explicit pairing.** A asks B (`./ponte mesh pair <B>` or Home → Devices → Ask for
  access) and both show a 6-digit code. Only B's owner approves, on B (`./ponte mesh
  approve <code>` or B's own Devices card). A then gets a peer token that B stores as a
  hash, bound to A's node id and tailnet address; A pins B's CA on first contact.
  Revoking on either side cuts the link. A peer token controls like the owner but
  cannot approve pairings, read the owner key or relay onward, and only works from
  that node's address over the tailnet listener.
- **Control any paired device.** Any `/api/*` call with `?node=<id>` is relayed by the
  home node to that peer, streaming included (live view, long-polls). On the phone a
  **Control which device** selector and a name badge on the Screen switch the whole app
  (screen, terminals, Dev, agents) to the chosen device, with no new APK: the device
  list rides in `/api/state` and pairing goes through `/api/action`.
- **Key-free pairing is now for the phone only.** `/api/pair` used to hand the owner
  key to any device of the owner on the tailnet, so another computer could take over
  without approval. It now requires the device to be an Android or iOS phone; other
  computers pair explicitly.
- **One-command node install:** `tools/node-install.sh` checks dependencies (printing
  the `pacman` line), clones or updates the checkout, runs setup and install, and says
  how to pair. `docs/mesh.md` explains the model; `tools/lab/mesh.mjs` runs two nodes in
  one process.

Verified with `npm test` (294, 1 skip): two real nodes with separate CAs in one test
process prove pairing, relayed state, actions and MJPEG, and every refusal (wrong
address, owner-only routes, chains, loopback, revoked, offline, swapped CA, denied,
tagged or foreign device, limits and expiry). In a mobile-viewport bench with the
two-node lab, a device was discovered, asked for, approved on the other node, selected,
and its screen, taps and typing went through the relay. Not yet on the real notebook:
its Tailscale SSH needs the owner's browser check.

## 0.1.0-alpha.24 (2026-09-28)

Alerts with the app closed, a reload that recovers on its own, and browser pairing through Tailscale Serve. Needs the new APK (versionCode 21) for the alert service and the reload fix, and a server restart for the new route.

- **Agent alerts with the app closed.** The Android app keeps a small foreground
  service ("Ponte is watching your agents") that holds one long-poll to the PC's new
  `/api/agents/events` route over the app's pinned TLS. When an agent goes from
  working to waiting for you or to finished, the phone shows a notification ("<title>
  needs you" / "<title> finished"), one per agent, and tapping it opens that
  conversation. The lock screen only says that an agent needs you. The PC scans agents
  every 5 s only while the phone is listening. The phone holds no wakelock or timer:
  with the screen off it waits on the open connection, backs off from 5 s to 5 min on
  errors and waits for the network when there is none. The same **Agent alerts**
  switch turns it on and off and asks for Android's notification permission. If that
  is denied, the page says how to allow it and the in-app alert keeps working. The
  notification's **Turn off** also turns the switch off. Nothing is posted while Ponte
  is on screen, where the in-app banner already shows it.
- **A load cut by the lock screen reloads.** `ponte phone app` on a running instance
  now brings it above the keyguard. A main-frame load reset while the app was paused
  (ERR_CONNECTION_RESET) reloads on resume instead of sticking. While the PC does not
  answer, Ponte says so and keeps retrying (1.5 s doubling to 15 s), checking
  `/api/health` before reloading, until the service is back.
- **Browser pairing through Tailscale Serve.** With `./ponte serve`, a browser on any
  of the owner's tailnet devices opens `https://<pc>.<tailnet>.ts.net` and is paired
  with no key. Serve stamps `Tailscale-User-Login` and strips any client copy, and
  Funnel never sets it. Ponte accepts it only when the login is the PC owner's and the
  loopback connection comes from a root-owned socket (tailscaled) in `/proc/net/tcp`,
  so a local process cannot forge it.
- **Lab.** `tools/lab/fake-agent.sh` makes one fake Claude session go waiting or ready
  on demand, with no model call.

Verified with `npm test`, `android/test.sh` (proxy 193 checks, alerts 49) and the APK
check for the six permissions and the private `specialUse` service. The long-poll was
exercised end to end in the lab with the fake agent. On the phone: the reload
reproduced (lock-screen reset) and recovered after the fix, and recovered by itself
after the service was stopped and started again. The alert service and a notification
from a fake agent with the phone locked were checked after install.

## 0.1.0-alpha.23 (2026-09-28)

The owner's calls on the Dev tab and the agents list. No new routes; the APK (versionCode 20) only carries the version.

- **Dev tab.** The key row puts the 1/2/3 permission-menu answers right after Esc.
  "Open on the PC" asks only the first time for each session. Claude Code's ⏵ ⏸ ⏺ ⎿
  symbols, which no font on the phone has, are drawn as one-cell look-alikes
  (▸ ‖ ● └), so the footer no longer shows empty boxes and columns stay aligned.
- **Agents tell you when they need you.** An idle Claude that already did work in its
  session now shows as **Ready** in a softer amber. One that was just opened and never
  asked anything stays **Idle**. The list is ordered waiting, working, ready, idle,
  terminal.
- **Automated agents hidden.** `codex exec` and `claude -p` are hidden by default
  behind **Show automated (N)**, which keeps counting them.
- **Agent alerts.** With the app open on any tab, the phone reads the agent list every
  10 s; this pauses when the app is in the background. When an agent goes from working
  to waiting for you, or to ready, a banner says "<title> needs you" or "<title>
  finished". The phone buzzes and the Terminals tab gets a dot; tapping the banner
  opens the conversation. It never fires on the first read, for automated agents, or
  right after you replied from the phone. **Agent alerts** turns it off.
- Maestri agents stay read-only: the Maestri CLI refuses to run outside its own
  terminals, and the hint now says so.

Verified with `npm test`, including fixture tests for the ready rule and UI tests for
the filter, the alerts, the per-session confirmation and the symbol mapping. The glyph
coverage was checked against the fonts pulled from the phone. On the phone itself, the
Dev tab and the agents list were checked after install.

## 0.1.0-alpha.22 (2026-09-28)

A Dev tab for developing from the phone: an agent terminal on the PC that reads and types like the real thing. Needs the new APK (versionCode 19) only for "Open on the PC"; the rest reloads with the page.

- **Dev tab.** A sixth button opens one Ponte tmux session full screen, running Claude,
  Codex or a shell in a `~/Projects` folder. It shows colours and the cursor (SGR
  16/256/truecolor). The session is sized to the phone's character grid instead of
  40×24; A−/A+ changes the font and the badge shows columns×rows. A key row carries
  what Claude Code needs: Esc, ⇧Tab, arrows, Enter, ^C, 1/2/3, /, @, !, PgUp/PgDn,
  ^O/^R/^D/^L, with a single character sent as a key so permission menus answer.
  The composer grows to five lines and has Send, Paste, dictation and image attach.
  A request of several lines goes as one bracketed paste only when the pane is
  waiting for pasted text; a busy shell refuses it and nothing is typed. Reads poll
  every 350 ms right after input, slow down to 3 s when nothing changes, and stop
  outside the tab. Large reads are gzipped (1000 coloured lines ≈ 100 KiB → 3.5 KiB).
- **Open on the PC.** It attaches a terminal window on the desktop to the same session
  through Omarchy's own launcher (`uwsm-app` + `xdg-terminal-exec`). It is refused
  while the PC is locked. The PC window then sets the size; the phone takes it back
  on its own layout changes or a tap on "PC 120×40 · fit", never on a read.
- New sessions from Home and Terminals also start at the measured size.
- **Lab.** A fake Claude Code TUI (colours, a 1/2/3 permission menu, ⇧Tab modes,
  bracketed paste). Fake `uwsm-app`, `omarchy-shell` and `omarchy-system-lock` mean a
  lab session never opens windows on, reads or changes the real PC's lock.

Verified with `npm test` (256 pass, 1 skip), `android/test.sh` (proxy 193 checks) and
a mobile-viewport browser against the lab's fake Claude in portrait, landscape and
with the keyboard open. That run answered the permission menu from the key row,
cycled modes with ⇧Tab, sent a three-line request as one paste and showed a busy
shell refusing one. The real phone was checked after install.

## 0.1.0-alpha.21 (2026-09-28)

A round built from the owner's six-point mission: see and answer every agent from the phone, start agent work from Home, scroll with the phone, a reliable Smart sleep, and screenshots from the phone to the PC. Plus a lighter app. Needs the new APK (versionCode 18) for agents, images and compression; everything else reloads with the page.

- **Agents and terminals.** The Terminals page is now one list of everything open:
  Claude, Codex and other agents in foot windows, on the Maestri canvas, inside apps
  or headless, terminal windows and Ponte sessions. Each card says whether the agent
  is working, waiting for you or idle, where it runs, its folder and since when.
  Claude's state comes from `~/.claude/sessions/<pid>.json`, checked against pid
  reuse; other agents use CPU and recent transcript writes. Tapping opens the
  conversation in readable type. "Reply on PC" focuses the window, confirms the focus
  and only then types the text and Enter; a Ponte session is typed into without
  moving focus; a locked PC refuses. The `/proc` scan takes ~43 ms (median), cached 1.5 s.
- **Start working from Home.** A card opens a text session already running Claude,
  Codex or a shell, in a recent `~/Projects` folder, with a typed or dictated request,
  and jumps to it. The request reaches the agent as a process argument, never as shell
  text; when the agent exits the session falls back to a shell.
- **Scrolling from the phone.** Hold one finger still and drag another to scroll the
  PC under the resting finger, zoomed or not, without ever clicking or dragging. Scroll
  gestures follow the finger like a phone, and every phone scroll first places the PC
  pointer at the gesture, so the wheel reaches the window under your fingers (before,
  it scrolled wherever the pointer was). Up/down buttons on the Screen repeat while
  held. The Terminals reader keeps the 1000-line history and your place.
- **Reliable Smart sleep.** The Magma lights controller sent RAM, GPU, keyboard and
  board in one OpenRGB call; when the Logitech keyboard was asleep OpenRGB 1.0rc3
  aborted the whole call and only the fans went dark. The controller now makes one
  call per group with the MSI board last, skips an absent keyboard and reports each
  device (`controller.py sleep --json`). Ponte logs each light's result, tries the
  lights even if Hyprland fails, names on the phone the lights that stayed on, and
  answers within 11 s (the Android proxy gives up at 15 s) with the outcome arriving
  through the state. The lab no longer drives the real lights controller.
- **Screenshots to the PC.** Share an image to Ponte from Android's Share menu or pick
  one from Home: a sheet previews it and uploads only when you choose Copy to PC
  (`wl-copy --type`, paste with Ctrl+V, including into Claude Code), Paste path into a
  Ponte session (no Enter) or Just save. Images live in `<dataDir>/inbox` (0600,
  newest 30 / 200 MiB).
- **Lighter app.** Static files are compressed (br/gzip) and revalidated by ETag: a
  cold load goes from 292 KB to ~70 KB, a reload to ~3 KB. `/api/state` caches
  capabilities (60 s) and the lock flag (5 s): median poll 30.5 → 9.4 ms. Viewers of the
  same picture share one capture loop (half the capture CPU for two). Sharp streams at
  JPEG quality 40. An idle terminal costs 29 tmux spawns and 29 KB a minute instead of
  219 spawns and 4.4 MB; typed input no longer waits behind output polling. The page
  stops polling while the Android app is paused.
- Verified: 233 Node tests (1 optional systemd test skipped), 188 native proxy checks and the rest of `android/test.sh`, CDP
  multi-touch and emulator runs against the lab for each feature, and on this PC a real
  Smart sleep and restore through the new controller (every light reported ok, 18 s and
  8 s). Physical confirmation of the lights and a human pick inside Android's file
  picker are still pending.

## 0.1.0-alpha.20 (2026-09-27)

Ponte now works in both directions: the phone still drives the PC, and the PC can open and control an authorized Android phone. Agents get a JSON CLI over the running server. The Android shell did not change: phones on the alpha.19 APK need no reinstall.

- Added **Ponte Desktop** for Linux: `./ponte desktop` opens a native PySide6
  manager for authorized Android devices, with connection/pairing, explicit
  selection, quality profiles, read-only mode, navigation and private screenshots.
  Video and mouse/keyboard control run in a managed, separate scrcpy window.
- Added a stdlib-only `ponte desktop` JSON CLI, offline help/schema, stdin-only
  pairing codes and per-user menu installation. No new server, autostart, APK
  permission or implicit device fallback. Audio and clipboard autosync are opt-in.
- Verified live Android 11 video and input in an isolated emulator: a mouse drag
  opened notifications, the native Back button restored Home, read-only blocked
  input, the screenshot dialog saved a private PNG, and stopping/closing the app
  ended only its viewer. Tests cover the bridge, CLI, Qt widgets and process
  lifecycle. Physical USB and wireless pairing were not live-tested in this round.
  See `docs/desktop.md` and `docs/desktop-acceptance.md` for setup and evidence.
- Added `./ponte ctl`: 59 discoverable commands covering the running server's
  public control API, including all 32 desktop actions and five legacy aliases,
  state/capability queries, terminal sessions, audio, dictation and bounded
  JPEG/MJPEG captures. Installation, phone and direct `pc` commands stay compatible.
- Added offline help/schema and redacted dry runs, a versioned JSON result/error
  envelope, stable exit codes, stdin-only unlock passwords and explicit
  confirmation for shutdown, reboot, suspend and terminal removal. Terminal
  dictation does not press Enter unless requested.
- The dependency-free client reuses private config/token files, verifies HTTPS
  certificates, refuses redirects/retries and output overwrites, bounds transfers
  and cleans up its incomplete files. Timeouts warn that a mutation may already
  have happened.
- Documented commands, limits, client-only UI boundaries and isolated testing in
  `docs/cli.md`, with an audit and coverage matrix in `docs/cli-plan.md`.
- Verified through real CLI subprocesses and the HTTP router with synthetic
  effects, local HTTP/HTTPS transport tests, the Node suite and native Android
  checks. The installed server's health endpoint was checked without restarting
  services, injecting desktop input, capturing the user's display or installing
  an APK.
- Release: version bumped to 0.1.0-alpha.20 in `package.json`, the UI constant and
  cache-busting query. The Android manifest stays at 0.1.0-alpha.19 (`versionCode 17`)
  because the native shell is unchanged. Validated with 181 Node tests (1 opt-in
  skipped), 120 desktop Python tests (Qt offscreen), 270 native checks and 7
  configuration tests. A running alpha.19 server keeps serving the phone; it reports
  the new version after its next restart.

## 0.1.0-alpha.19 — 2026-09-18

Second round on the Redmi, this time with the WebView inspectable (a debuggable dogfooding build, `PONTE_ANDROID_DEBUGGABLE=1`), so the keyboard complaints could be measured instead of guessed.

- **The keyboard opened with no field behind it.** Asking the shell for the IME (`requestFocusFromTouch`) moved the page focus from the typing field to the screen preview: keys went nowhere, `+`/`-` zoomed the monitor, and because the layout only counted the keyboard as open when a field was focused, the bar was positioned for "no keyboard" (off-screen in landscape, with the navigation tabs wedged between bar and keyboard in portrait). The shell now only re-requests focus when the WebView really lacks it, the page puts the focus back as the keyboard settles, and the viewport shrinking is the keyboard signal on its own. Measured: field focused, tabs hidden, bar directly above the keyboard, monitor visible above the bar.
- **Text is sent as one line, not as keystrokes.** Forwarding every edit live turned a Gboard correction over a Tailscale relay into a burst of backspaces that arrived garbled or not at all. The line now stays on the phone until Send, which types it and presses Enter in a single server action (`keyboard.text` with `enter`); the bar closes after a successful send, a failed send keeps the draft, and "Send without Enter" pastes. `wtype` was checked on the desktop with accented text: exact.
- **Long-press drag moves windows.** The gesture now holds Super for the duration, which is how Hyprland moves floating windows and swaps tiled ones; the workspace shelf remains the drop target for another workspace. A plain one-finger drag still drags inside the window's contents.
- **Workspaces on the screen.** A row of Omarchy workspaces sits over the monitor: the one the streamed monitor shows is lit, a dot marks the ones with windows, a tap is Super+N. A workspace living on another monitor pulls the stream to that monitor first; a new workspace opens on the streamed monitor (the pointer is placed there before the dispatch).
- **The phone is reachable over Tailscale alone.** `./ponte phone ensure` keeps adb on the phone's Tailscale address (fixed TCP port 5555; when the listener is gone after a reboot it is re-enabled through whatever transport is up and the link comes back over Tailscale), `phone install` installs the built APK that way, `phone app` brings Ponte to the front with the screen on and above the lock screen (an agent session that finishes itself when it leaves the foreground; HyperOS's "show on lock screen" op is granted over adb), `phone wake` handles the lock screen when the rest of the phone is needed, `phone timer on` keeps the link alive every two minutes, and `doctor` reports the Tailscale adb link. The shell retries a failed first load a few times quietly (a cold start right after the screen turns on can race the VPN) and reloads on its own after a load that failed while the activity was being paused. Measured end to end through the phone's Tailscale address (the phone on 5G, through the DERP relay): install, launch over the lock screen, live stream, screenshot and tap.
- Verified by 133 Node tests, 270 native checks and the synthetic APK build (`versionCode 17`); layout, focus and IME dismissal measured on the Redmi over CDP, the drag sequence in the lab.

## 0.1.0-alpha.18 — 2026-09-18

A dogfooding round on the Redmi about the thing that matters most in a remote control: does the click land where the finger says. It did not, and the reason was on the PC, not on the phone.

- **Every absolute pointer placement landed at twice the requested pixel.** `ydotool mousemove --absolute` is not absolute: it jumps to the top-left corner and then moves relatively, and Hyprland's default adaptive acceleration scales that second leg (measured: (1000,700) became (2000,1400) on every monitor). ydotool's own help says to turn acceleration off. The server now sets its virtual pointer to a flat profile through Hyprland's per-device configuration (Lua on 0.56+, keywords before), verifies each placement against `hyprctl cursorpos`, re-applies the profile when a restarted `ydotoold` shows up as a new device, and closes any remaining gap with scale-aware relative moves. A miss that jitter cannot explain surfaces as a warning in the app. Measured after the fix: pixel-exact on all three monitors, from the API and from the phone.
- **A pinch survives the auto quality profile.** Each rung of Auto streams a different frame resolution, and the screen treated that as a new monitor and threw the zoom away seconds after the user pinched. Only a different aspect ratio (another monitor) resets now. Zoom always reaches at least 4x, even on the light profile: blurry is fine when the point is to hit a small target, and the frame sharpens in place as the profile climbs.
- **The stream no longer gives up.** After five failed attempts (a PC restart, a mobile hand-over) the screen used to freeze on a still frame with "tap play", and there was no play. It keeps trying at a gentle pace while the screen is open, and a tap on a still frame reconnects instead of clicking on whatever the desktop shows now. A brief ring marks where each tap became a click.
- **Keyboard.** A row of keys the phone keyboard cannot type sits above the typing bar: Esc, Tab, arrows, Del, Home, End, Ctrl+C/V/Z/A, Alt+Tab, Super. The native shell keeps the screen on (the phone locked itself mid-session before) and lowers the IME when the typing bar closes, so an open keyboard never types into nothing; the keyboard button brings the keyboard back when the bar is open without it instead of closing the bar.
- **`tools/lab/`: a real Ponte server with fake desktop tools.** `hyprctl`, `ydotool`, `wtype` and `grim` are replaced by scripts that log every call and draw a synthetic monitor (grid, targets, cursor, clicks, typed text), so a phone or emulator can be exercised end to end without touching a live desktop. `tap-test.py` taps at known fractions of the streamed image and checks the cursor; `cdp.mjs` drives a debuggable Chrome for real pinches and exact layout readings. Client-side mapping measured exact (0 px) at 1x and 4x.
- Verified by 127 Node tests, 270 native checks and the synthetic APK build (`versionCode 16`).

## 0.1.0-alpha.17 — 2026-09-18

Diagnosed on the real Redmi after the app spent a morning saying "Your PC has not responded" while Tailscale was fine. Two independent causes were found and both classes of failure are closed, plus the tooling to see the next one in a minute.

- **The app pins the installation CA, not the one-year server certificate.** A `./ponte setup` on 2026-09-17 had regenerated TLS; the phone's older APK pinned the previous leaf and its loopback proxy rejected every handshake, which the WebView showed as an unreachable PC. The same failure would have returned on its own when the leaf expired. The Android proxy now trusts the CA created at setup and requires the PC's certificate to be issued directly by it (IP SAN and hostname checks unchanged). `./ponte renew-cert` reissues the server certificate under that CA and restarts the service; the phone keeps working. Only a new CA needs a new APK.
- **A certificate the app does not trust is a certificate error.** The proxy reports `proxy_certificate` in the status line and body; the native shell shows "Your PC's certificate changed" with the rebuild instruction instead of the generic Tailscale advice.
- **Auto-pairing no longer latches off when the service starts before Tailscale.** The owner lookup (`tailscale whois` on the PC's own address) ran once at startup; at login the daemon was still coming up, so the lookup failed and every `/api/pair` was denied until a restart. A failed lookup is now retried on the next request (throttled to one attempt per 5 s); only a real answer is final.
- **`./ponte doctor`** checks configuration, certificate expiry, Tailscale address and connectivity (including how the phone is reached: direct or relay), both services, `ydotoold`, the TLS listener, auto-pairing from the PC itself, whether `.work/Ponte.apk` pins the current CA, and the installed app version over `adb`.
- **Auto stream quality.** Measured on a 1440p monitor: Sharp ~49 Mbit/s, Balanced ~7, Light ~2, which is why Sharp never worked over mobile data. The new default *Auto* profile starts light, climbs one rung after two consecutive on-time windows (3 s each) and drops a rung as soon as fewer than 60% of the requested frames arrive, holding 20 s (doubling after each fall, up to 2 min) before climbing again. A stream that breaks steps down immediately; a window stretched by a pause is discarded rather than judged.
- Verified by 123 Node tests, 270 native checks, the synthetic APK build, and on the Redmi over 5G (relay through DERP São Paulo): auto-pair, live screen, background/resume and cold start. MJPEG remains the transport; a video codec (H.264 via ffmpeg or WebRTC) is the next step for mobile use and is not in this release.

## 0.1.0-alpha.16 — 2026-09-13

- Fixed ordinary finger taps disappearing when normal contact wobble crossed the old 12 CSS px threshold; the direct-touch gesture now tolerates 24 CSS px before changing intent.
- A deliberate one-finger move at fitted 1× now becomes a real held-left-button drag, so desktop text, list rows, sliders and draggable items can be selected directly. One-finger movement while zoomed continues to pan the phone view.
- Long-press still provides right-click, and long-press plus drag keeps the semantic workspace shelf. The regression test covers both jittery taps and direct mouse-style selection drags.

## 0.1.0-alpha.15 — 2026-09-13

- Fixed Android text-field taps that could do nothing when fcitx published the new input context after the app's single focus check.
- The screen now retries text-focus detection for a short bounded window after a tap, without injecting speculative keys into the PC.
- Added a guarded native WebView bridge and a MIUI-friendly IME retry so the phone keyboard opens reliably once a PC text field is confirmed.

## 0.1.0-alpha.14 — 2026-09-13

The screen now understands two intents that raw mouse emulation could not express cleanly on a phone.

- **Move a window between workspaces in one gesture.** Long-press a window and start moving it; a workspace shelf appears over the bottom of the monitor. Drop on a number to move the exact window captured at the start of the gesture. The backend uses Hyprland's exact address selector with `follow = false`, so the window moves without pulling the current view to the destination. Dropping elsewhere remains an ordinary desktop drag, and starting on wallpaper can never reuse the previously active window by mistake.
- **A field tap raises the Android keyboard.** The fcitx5 focus probe still decides whether the PC target accepts text, but the native shell can now raise the IME after that asynchronous answer. The typing bar opens automatically in the Android app; tapping away closes bars opened this way. Browser users keep the highlighted keyboard button as the explicit fallback.
- **Kept narrow and reversible.** No Android permission was added. Pointer coordinates, window addresses and workspace IDs remain validated; held input is released before the semantic move. The release was verified by 112 Node tests, 267 native checks, and a fully compiled synthetic APK (`versionCode 11`).

## 0.1.0-alpha.13 — 2026-09-11

The screen keyboard was rebuilt as a real keyboard, the live stream stopped dropping, pairing lost its last password, and a full pass of adversarial review (a second model reading the diff) hardened the input path. Verified on an Android 11 emulator against an isolated recording server, so keystrokes, taps, drags and terminal input could be checked without touching a live desktop.

### Type on the screen
- **A typing bar instead of an invisible field.** Tapping the keyboard button opens a thin bar and focuses its text field inside the same tap, which is the only way Android raises the soft keyboard. Every edit is sent to the PC's focused window as it is typed; Enter presses Enter. The bar shrinks the monitor to the space above it so nothing is covered, and the floating switch-monitor and rotate buttons step aside while it is open. A tap on a PC text field lights the keyboard button (fcitx focus) as a cue rather than trying to open the keyboard on its own.
- **Safer input.** The bar never saves what you type — it goes to arbitrary fields, passwords included, so there is no history there (the terminal composer keeps its own command history). IME composition is respected: keys are held until the candidate commits, and confirming a candidate no longer sends a stray Enter. Deletion counts whole characters, so an emoji is one backspace and surrogate pairs are never split. A keystroke that fails to reach the PC resets the bar instead of letting a later edit delete unrelated text, and the bar only opens when the PC can actually accept typing.

### Live view stability
- **No more "reconnecting" every few seconds.** A slow frame is given far longer to drain and the stream self-throttles to the phone's real bandwidth instead of being killed. Stream slots are shared fairly: a device reopening its screen replaces only its own stream, a preview on the PC yields to a remote phone, and no single device can take every slot, so two devices never knock each other off.
- **Smoother rendering.** Per-frame DOM work is down to the image swap; labels, geometry and status only change when they actually change, and only the visible page is re-rendered each poll.
- **Tap to start.** With no toolbar, tapping the idle screen begins streaming — the way back if a monitor was unplugged or the stream stopped.

### No password
- **Pairing has no key to type.** A device on your Tailscale account connects automatically; the typed-key fallback screen is gone. If the PC can't be reached the app says so and offers to try again, never a password box.

## 0.1.0-alpha.7 — 2026-09-11

- **A terminal command composer.** Build a command with the full phone keyboard, then Send types it and runs it in one atomic operation (paste-buffer then Enter), fixing a race where a busy client dropped the Enter. Sent commands join a reusable, on-device history shown as chips; Paste-only sends the text without running it. Terminal dictation drops its transcript into the composer to review before sending.

## 0.1.0-alpha.6 — 2026-09-11

- **Auto-pairing on your tailnet.** A phone on the same Tailscale account no longer types a key. `GET /api/pair`, served only over the native TLS listener, asks `tailscale whois` who owns the connecting peer and returns the pairing token when it is the same user that owns this PC. Machines shared with you by someone else, and tagged devices, still fall back to the typed key. The app tries this on boot when it has no saved key and enters straight away. Verified end to end on the emulator (cleared data → opened straight into the screen) and by unit tests for the identity logic and the route.
- **A stale phone reloads itself** when the PC serves a newer interface: the app carries a version constant, `/api/health` and `/api/state` report the server's, and a mismatch triggers one guarded reload. The service-worker cache name is bumped so its network-first cache drops old files.

## 0.1.0-alpha.5 — 2026-09-11

The screen page was rebuilt around one idea: the phone shows the monitor and you touch it like a phone. No control modes, no toolbar. Voice dictation, RGB and session control, and an SSH-friendly CLI arrived in the same cycle. Everything below was dogfooded on an Android 11 emulator (WebView 83) and installed on a Redmi Note 13 Pro+ (Android 14).

### Screen
- **One direct-touch mode.** Tap clicks at that monitor pixel. Long-press then lift right-clicks. Long-press then move drags with the button held (windows, text selection). Pinch zooms. One finger pans while zoomed. Two fingers together scroll the PC. The Trackpad, Direct touch, Touchpad and Keyboard tabs, the pause, freeze, 1:1 and fullscreen buttons and the touchpad panel were removed from the code, not hidden.
- **Zoom like Chrome Remote Desktop.** The whole native frame is streamed and the pinch is a continuous CSS transform on the client. The previous design re-cropped on the server mid-pinch, which reconnected the stream (jumpy) and showed the stale frame stretched (blurry). It is gone; `viewRegion` and the `x/y/w/h` stream parameters are no longer sent.
- **Sharper, faster profiles.** `scale` may now be 1 and `fps` up to 20, with a `q` JPEG quality parameter (30–90). The default *Sharp* profile streams native pixels at 15 fps. `grim` scales on the CPU, so a full-size frame at lower quality is both faster (~10 ms vs ~60 ms) and crisper than a downscaled one.
- **The phone keyboard rises when you tap a text field on the PC.** After a tap-click the app asks `GET /api/textinput`, which reads fcitx5's input contexts over DBus (`focus:1` only while an enabled text field has focus; a button-only dialog reports none). A hidden input takes focus, Android shows its keyboard, and every edit is forwarded live as keystrokes, including autocorrect revisions and Backspace. The send key presses Enter. The keyboard closes when the field loses focus on the PC.
- **Floating buttons** beside the mic: switch to the next monitor, and force landscape (immersive, edge to edge) or release it. Orientation is requested through a bridge-free `ponte://orientation/...` navigation that the Activity intercepts; rotation no longer recreates the Activity.
- Monitor and quality selectors moved to a *Screen* card on Início. Android Back returns from the screen to Início instead of quitting the app.

### Voice dictation
- **Speak into a terminal.** *Speak to terminal* records, transcribes on the PC and types the text into the selected session, then presses Enter (a checkbox turns Enter off). A mic on the screen page does the same into whatever field has focus on the PC.
- Transcription prefers the Sussurro IPC socket (faster-whisper on the GPU, ~280 ms) and falls back to any OpenAI-compatible endpoint such as OmniVoice Studio (`PONTE_STT_URL`). Audio is transcribed and discarded; nothing is stored. New routes: `POST /api/dictate` and `POST /api/terminals/<id>/dictate?enter=1`.

### Power, lights and session
- **Monitor on/off now works on current Hyprland.** `hyprctl dispatch dpms off HDMI-A-1` stopped working when Hyprland moved dispatch to Lua; only `focus` had been migrated. The Lua `dpms` dispatcher also ignores the on/off word and merely toggles, so Ponte reads `dpmsStatus` and toggles only when the monitor is not already in the requested state. Per-monitor toggles, *All on* / *All off*, smart sleep and wake use this path. Verified live and idempotent.
- **RGB lights** through the Magma controller: six presets (lava, brasa, oceano, aurora, floresta, lua), lights off/restore/reapply, and the water-cooler screen on/off. State (`preset`, `sleeping`) is exposed in `/api/state`.
- **Session:** lock (`omarchy-system-lock`), unlock (types the password through uinput only while the Omarchy lock is up; the password is never stored on the phone), suspend and restart with confirmation dialogs. `/api/state` reports `session.locked`.
- Wake-on-LAN reports whether it is enabled on the network card.

### SSH over Tailscale
- New `./ponte pc <lock|unlock|sleep|wake|suspend|reboot|off|monitors on|off [NAME]|lights NAME>` (`bin/ponte-pc.mjs`) reuses the same validated desktop actions from a shell, so `ssh user@<tailscale-ip> ponte pc suspend` works without the HTTP server. `unlock` reads the password from stdin, never from `argv`.

### Fixes
- Every `dvh` rule now has a `vh` fallback; WebViews older than Chromium 108 dropped those declarations, which let the terminal output grow without bound and left a gap under the keyboard.
- `backdrop-filter` was removed from the navigation bar and screen overlays: on WebView 83 it blanked the entire page whenever it shared the screen with a live frame. CSS `inset` was replaced with explicit offsets for the same WebView.
- Terminal output keeps a fixed height with internal scrolling, so buttons stop moving while text arrives.
- Recording names are no longer generated in UTC.

### Tests and docs
- 103 tests (`npm test`): new coverage for the transcriber (Sussurro and HTTP providers, validation, cleanup), dictation routes, `mouse.moveTo`, the text-input probe, lights and session actions, the read-then-toggle DPMS logic, the direct-touch gesture mapping, keystroke forwarding, monitor cycling and forced landscape, and the `ponte pc` CLI.

### Known limits
- *Lights off* (`lights.sleep`) fails intermittently when OpenRGB cannot enumerate the Logitech keyboard; Ponte reports the failure. Presets, restore and the cooler screen are reliable.
- Unlock was unit-tested but not exercised on a live locked session in this cycle.
- The Android keyboard raise depends on fcitx5 running on the PC. Without it, tapping a field does nothing and the terminal page's *Type text* field remains the fallback.

## Earlier alphas

- **0.1.0-alpha.4** — native 1:1 crops, Direct touch cues, emulator after-shots (PR #10, #11).
- **0.1.0-alpha.2 / alpha.3** — immersive screen page, terminals over a private tmux socket, power superbuttons and Wake-on-LAN metadata.
- **0.1.0-alpha.1** — first public alpha: pairing, touchpad, keyboard, windows, live MJPEG monitor view, voice recordings, personalized Android build with certificate pinning.

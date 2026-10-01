# ADR 0002: one device model, served by the home node, drawn by every surface

- Status: accepted (2026-10-01); slices 1 to 3 released in alpha.34, slice 4 implemented and lab-validated, awaiting integration; slice 5 (rd.html) deferred
- Vocabulary: [CONTEXT.md](../../CONTEXT.md); the UI term is **aparelho**, the code term is `device`

## Context

The owner wants Ponte to feel like one network with an interface: the phone app, the notebook and the PC each control and read the others, so each should show the same "my devices" with the same words and the same actions. Today there is no such thing. There are four sources of "who is on the network", each read by a different surface:

| Source | Code | Read by |
|---|---|---|
| Ponte mesh (paired nodes) | `backend/mesh.mjs:357-394` (`peerList`, `view`, `list`) | phone header selector and Devices card (`public/app.js:149-182`), `rd.html` picker (`public/rd.js:800-831`), `./ponte mesh`, `./ponte rd`, `ponte ctl --node` |
| Fleet (tailnet + `~/.ssh/config` + mesh) | `backend/fleet.mjs:186-229` (`assemble`), `:347-357` (`health`) | phone card "Máquinas e conexões" (`app.js:300-328`), `./ponte fleet` |
| SSH hosts of the private config | `backend/terminals.mjs:144` | the SSH choice of Home and Dev (`app.js:3242-3310`, `:3466-3610`) |
| adb | `./ponte phone` (`ponte:273-701`), `desktop/bridge.py` | the CLI and the GTK app only; nothing in the server |

Measured on the two-node lab (`tools/lab/mesh.mjs`, synthetic tailnet), right after pairing pc-teste with notebook-teste, the phone's Home shows the same notebook as "Paired · online" in one card and "No connection · SSH: DNS" in the next. `/api/fleet` already carries `mesh: {paired: true, online: true}` for it, but `health()` only looks at SSH and the fleet card offers no action. Other symptoms:

- Two id formats for one device: the mesh's 16 hex (`?node=`, `--node`) and the fleet's `self` / `ssh:ALIAS` / `tail:KEY` (handoff `--from`). The fleet joins a mesh node to its machine by name only (`fleet.mjs:211-214`) although the mesh knows the peer's tailnet address (`mesh.mjs:153`).
- Five names for one concept in the UI and docs: aparelho/device, máquina/machine, nó/node, peer, host; "this device" is written three ways (`i18n.js:408`, `:409`, `:712`).
- The selection lives in memory on the phone (`app.js:55-64`) and in the URL in `rd.html` (`rd.js:206`); the rd picker loads once and disables offline devices, the phone keeps them selectable.

Two constraints shape any answer:

- The Android shell only forwards a fixed list of routes and static files (`android/src/app/ponte/omarchy/LoopbackProxy.java:23-25`, `:382-386`). `/api/mesh*` and `/api/fleet*` are already refused there, which is why the phone reaches them through `POST /api/action` (`server.mjs:496-505`). A new route or a new static file would be refused by every installed APK until it is rebuilt.
- Pairing, the pinned CA, the relay and the peer token rules are proven and stay as they are.

## Decision

1. **One entity, built on the home node.** A new `backend/devices.mjs` composes what `mesh.list()`, `fleet.overview()` and (read-only) `adb devices -l` already return into a list of devices: `id`, `ids`, `name`, `kind` (`pc | notebook | phone | server | other`), `self`, `status` (`online | offline | unknown`), `routes[]` (`ponte`, `tailscale`, `ssh`, `adb`, each with its own state) and `can` (`screen`, `control`, `terminal`, `agents`, `sessions`, `info`, `files`, `wake`, `pair`, `revoke`, `mirror`), each `{ok, via}` or `{ok: false, why}`. It adds no discovery, pairing or transport.
2. **The server decides, the surface draws.** Status, the preferred route and what can be done (and why not) are computed once in `devices.mjs`, with fixture tests. Surfaces only lay out. Words live in `public/i18n.js`, which every surface (and every APK) already loads.
3. **One answer, three doors.** `POST /api/action {type: 'devices.list'}` for the phone (the only door old APKs allow), `GET /api/devices` for browsers, `rd.html` and the CLI, and `./ponte devices` / `ponte ctl devices`. Same body, versioned with `v: 1`. Owner only, home node only (a peer gets `MESH_OWNER_ONLY`, `?node=` is refused), fast from caches by default and `deep` on request, like `fleet.list`.
4. **Canonical id.** A device that runs Ponte and is in the mesh is identified by its mesh id (what `?node=` and `--node` already take); otherwise by its fleet id. `ids` lists every older id for it, and a single resolver accepts any of them, or the name, in `?node=`, `ctl --node`, `./ponte rd` and `fleet --from`, before each route's own format check. The mesh–tailnet join moves from name to tailnet address, name as fallback.
5. **Status is the union of routes.** A device is online if any route says so; the SSH result becomes a detail of the SSH route. This removes the contradiction above.
6. **Nothing old changes shape.** `/api/mesh`, `/api/fleet`, `state.mesh`, `mesh.*`, `fleet.*` and their CLI commands keep their formats; `/api/state` does not grow (it is polled every few seconds and the old header selector depends on `state.mesh`).
7. **The hub's phone code lives in `app.js`.** No new static file until an APK that allows it has been out long enough.

Vocabulary, everywhere: **aparelho** (device), **este aparelho** (self), **controlando {nome}**; kinds PC, Notebook, Celular, Servidor; states online, offline, sem conferir; routes Ponte, Tailscale, SSH, ADB; Ponte route states pareado, disponível, aguardando aprovação; actions Ver tela, Controlar, Terminal, Agentes, Sessões, Continuar aqui, Pedir acesso, Aprovar, Negar, Revogar, Acordar, Espelhar no PC, Informações. "Emparelhado" becomes "pareado" (the error copy already says so); "máquina" leaves the UI.

## Migration, in slices that ship alone

Each slice keeps mesh, fleet and pairing working, passes `npm test`, and is checked on the two-node lab before the real devices.

1. **Model and API, no UI.** `backend/devices.mjs` with fixture tests (paired + online over Ponte but SSH down; SSH-only server; phone on the tailnet; old remote node without `kind`; offline device). `mesh` exposes the peer address to the backend only. `GET /api/devices`, the `devices.list` action, `./ponte devices`, `ponte ctl devices`. The lab gains a synthetic tailnet and SSH config so the fleet never reads the real ones. Optional `kind` in `node.json`/config and in the mesh hello (battery heuristic), ignored by old nodes. Vocabulary entry in `CONTEXT.md`.
2. **One resolver.** `?node=`, `ctl --node`, `./ponte rd DEVICE` and `fleet --from/--to` accept any id in `ids` or the name. Old ids keep working; tests for each door.
3. **Words.** The i18n keys of the vocabulary above; the three "this device" variants become one. No layout change.
4. **Phone and browser Home.** One card "Seus aparelhos" replaces the Devices card and the machine list of "Máquinas e conexões" (agent sessions stay a card of their own); pending requests on top; the header selector takes its options from the same list (`can.control`). Works with APK alpha.24 because it only uses `/api/action` and `app.js`. Checked on the emulator and with a read-only screenshot on the owner's phone.
5. **Notebook (`rd.html`).** The picker becomes a devices popover fed by `GET /api/devices`, refreshed while open, offline devices shown with their reason, Terminal/Agents opening the ordinary page on that device.
6. **PC-only actions.** The `adb` route and `mirror` (open `ponte desktop` / scrcpy for a phone on the PC's own monitor), offered only on the node that has adb. Wake-on-LAN stays where it works (the APK) until the server can send it.
7. **Cleanup.** After one release with both, remove the old card renderers (`renderMesh` card part, the machine part of `renderFleet`) and the stale comment at `rd.js:798`.

## Consequences

- One place to answer "what can I do with this device", tested once; three surfaces that differ only in layout.
- The fleet's SSH checks still cost what they cost; the list stays fast because the default view never waits on the network, like `mesh.view()`.
- A device's id is stable only as long as its mesh id is (`dataDir/node.json`); reinstalling a node gives it a new id, as today.
- Each home node shows what it reaches; there is no merged view across homes, and a peer still cannot read another node's list.
- `files` is reserved and stays `ok: false` until a feature exists; adding a capability is a new `can` key, not a new endpoint.

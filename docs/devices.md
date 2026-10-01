# Devices: one list of everything this node reaches

Every Ponte surface (the phone app, a browser, the remote desktop, the CLI) asks the node it holds for the same list: each computer or phone on the mesh, the tailnet, `~/.ssh/config` and this node's adb, with its kind, status, routes and what can be done with it. The decision and the migration are in [ADR 0002](adr/0002-one-device-model.md); the words in [CONTEXT.md](../CONTEXT.md#devices-adr-0002).

```sh
./ponte devices            # the list
./ponte devices --check    # check every SSH route and probe each machine now
./ponte devices --json     # the server answer
./ponte ctl devices [--deep] [--fresh]
```

The same answer comes from `GET /api/devices[?discover=1|deep=1|fresh=1]` and, for the phone (whose proxy allows no new route), `POST /api/action {"type":"devices.list","deep":true}`. `discover` asks the mesh again (what `/api/mesh` does) without checking SSH. Owner only and never relayed: a peer token gets `MESH_OWNER_ONLY`, `?node=` gets `MESH_INVALID_REQUEST`. Without `deep` the list comes from caches (mesh discovery 30 s, fleet inventory 15 s, SSH checks 45 s, adb 15 s) and never waits on the network.

## A device

```jsonc
{
  "id": "16a620cbf5b0cdad",       // the mesh id for a Ponte node, else ssh:ALIAS, tail:NAME or adb:SERIAL
  "ids": ["16a620cbf5b0cdad", "ssh:notebook", "tail:notebook"],   // every id that names it
  "name": "notebook", "kind": "notebook", "self": false, "os": "linux",
  "ponte": { "version": "0.1.0-alpha.33" },   // null when it does not run Ponte
  "status": "online",                          // online | offline | unknown
  "lastSeen": "2026-10-01T09:00:00Z",
  "routes": [
    { "via": "ponte", "state": "paired", "online": true, "controlsMe": false },
    { "via": "tailscale", "ip": "100.x.y.z", "online": true, "link": "direct", "relay": null, "lastSeen": "…" },
    { "via": "ssh", "alias": "notebook", "kind": "key", "configured": true, "check": { "ok": false, "ms": null, "code": "DNS", "checkedAt": 0 } },
    { "via": "adb", "serial": "100.x.y.z:5555", "state": "device" }
  ],
  "can": { "control": { "ok": true, "via": "ponte" }, "sessions": { "ok": false, "why": "SSH_UNREACHABLE" }, "…": {} },
  "pairing": null,                             // {status, code} while this node asks for access
  "summary": { "agents": 2, "tools": ["claude", "codex"] }   // from the fleet probe, when it ran
}
```

The answer is `{v: 1, home: {id, name}, devices, requests, tailnet: {state}, checkedAt}`; `requests` are the nodes asking to control this one (approve with `./ponte mesh approve CODE`). Fields are only added within `v: 1`.

**Kind.** `pc`, `notebook` or `server` from the node's own hello (`node.kind` in the private config, else a system battery means `notebook`); `phone` for an Android or iOS tailnet device or an adb device; `pc` for a Ponte node too old to say; `server` for a Linux machine without Ponte; `other` otherwise.

**Status.** Online when any route answered (the mesh, the tailnet, an SSH check, adb); offline when the tailnet says so and nothing else answered, or a paired node is gone; unknown otherwise. An SSH failure is a detail of its route, not of the device.

**Joining.** A mesh node is matched to its tailnet machine by tailnet address, then by name; an adb device by its serial's address.

## Capabilities

| `can.*` | ok when | `via` | then |
|---|---|---|---|
| `screen`, `control`, `agents` | this device, or a paired Ponte node that is online | `ponte` | `?node=<id>` on the usual routes |
| `terminal` | as above; else an alias listed in `ssh.hosts` whose check did not fail (`host` names it) | `ponte` / `ssh` | `POST /api/terminals` (`?node=`, or `{agent:'ssh', host}`) |
| `sessions` | the fleet probe of the machine answered (`machine` names it) | `ssh` | `fleet handoff --from <machine>` |
| `info` | always | the best route | this object, or `/api/state?node=` |
| `pair` | an online Ponte node that is not paired or waiting | `ponte` | `mesh pair <id>` |
| `revoke` | a paired node or one that controls this one | `ponte` | `mesh revoke <id>` |
| `mirror` | this node's adb sees the phone as `device` | `adb` | `ponte desktop` / `ponte phone view` (from the surface in a later slice) |
| `files`, `wake` | not yet | — | `why: NOT_AVAILABLE` |

Reasons (`why`): `SELF`, `NO_PONTE`, `NOT_PAIRED`, `PAIRING_PENDING`, `ALREADY_PAIRED`, `OFFLINE`, `NO_ROUTE`, `NO_SSH`, `SSH_UNREACHABLE`, `UNCHECKED`, `PROBE_FAILED`, `NO_ADB`, `NOT_AVAILABLE`.

adb is read only and only when an adb server already runs on this node (`adb devices -l`; asking would start one). `PONTE_ADB=0` turns it off, `PONTE_ADB_BIN` and `ANDROID_ADB_SERVER_PORT` move it.

## One resolver

Every door that names another device takes any id in its `ids`, or its name without case (ADR 0002, slice 2):

| Door | Takes | Becomes |
|---|---|---|
| `?node=` on any `/api/*` route, `/api/rd?node=` | name, any id, `self` | the mesh id of a paired Ponte node; this node for itself |
| `ponte ctl --node` | the same | the same, resolved by the CLI through `/api/devices?discover=1` |
| `./ponte rd DEVICE` | the same | the same |
| `fleet --from/--to`, `fleet probe`, `fleet.check` | the same | `self` or the machine's `ssh:ALIAS` |

Old ids keep their old path: a 16-hex mesh id and `self`/`ssh:ALIAS` for the fleet are passed on without a lookup and fail as they always did. Anything else is looked up in the cached list first; a refusal there gets one more look with the mesh asked again, so a node discovered a second ago is not refused. A CLI talking to a server without `/api/devices` falls back to the names of `/api/mesh`.

| Error | When |
|---|---|
| `MESH_PEER_NOT_FOUND` (404) | no device has that name or id |
| `MESH_PEER_AMBIGUOUS` (409) | two devices share the name and no id matched: use an id |
| `MESH_PEER_NOT_PAIRED` (409) | it runs Ponte but is not paired with this node: `./ponte mesh pair NAME`, approve there |
| `DEVICE_NOT_PONTE` (409) | it is reachable only by SSH: use a terminal (`--agent ssh --host ALIAS`), not `?node=` |
| `FLEET_MACHINE_NOT_FOUND` (404) | the fleet has no SSH machine for it |

## Words

Surfaces never show a code. `public/i18n.js` maps each one to the vocabulary of [CONTEXT.md](../CONTEXT.md#devices-adr-0002): `PonteI18n.deviceWord(group, code)` with the groups `kind`, `status`, `route`, `ponte` (route states), `adb`, `action` (the `can` keys plus `approve`, `deny`, `continue`) and `why`; an unknown code gives an empty string. `PonteI18n.deviceWords` is the table itself.

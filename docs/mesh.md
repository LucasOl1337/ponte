# Ponte mesh: controlling one Omarchy node from another

Every Omarchy machine runs the same Ponte server (a *node*). The node you hold is your *home node*: the PC for the phone app, `127.0.0.1:8787` for a browser on a desktop. It keeps the links to the other nodes and relays your requests to them, so the phone app and the browser never need another node's certificate or key, and the Android app does not change.

## Install a node (notebook, second PC)

On that machine, as its user, with Tailscale connected:

```sh
curl -fsSL https://raw.githubusercontent.com/LucasOl1337/ponte/main/tools/node-install.sh | bash
```

It clones or updates `~/Projects/ponte`, checks the dependencies (printing the `pacman` line for anything missing: Node 22+, tailscale, grim, ydotool, gpu-screen-recorder, python-evdev, tmux, wtype, and the `input` group), runs `./ponte setup` on the machine's Tailscale IPv4, `./ponte install`, and prints how to pair. `tools/node-install.sh --dry-run` only lists what it would do.

## Pair (A controls B)

1. On A, open **Home → Devices** and tap **Ask for access** next to B, or run `./ponte mesh pair <B>`. A shows a 6-digit code.
2. On **B itself**, approve it: the Devices card on B (a browser on B or a phone whose home node is B), or `./ponte mesh approve <code>` on B. Nothing approves itself and A can never approve on B.
3. A picks up the peer token on its own. B now appears in A's **Control which device** selector; picking it moves the whole app (screen, input, terminals, agents, actions) to B.

`./ponte mesh list` shows this node, the Ponte nodes on the tailnet, requests waiting here and who controls this node. `./ponte mesh revoke <name>` cuts a link at once, in either direction. A request expires after 10 minutes; at most 5 wait at a time.

Only online, untagged tailnet devices of the same owner as this node can be found or can ask (the same `tailscale whois` rule as the phone's automatic pairing). Discovery asks each of them for `GET /api/mesh/hello` on port 8788 and caches the answer for 30 s.

## What a peer token can do

B keeps only a hash of the token, bound to A's node id and A's tailnet address. With it A can do on B what B's owner can: screen, input, terminals, agents and actions. It cannot:

- approve, deny or revoke pairings, or read B's device list (`/api/mesh`, `mesh.*` actions);
- make B relay to a third node (no chains A → B → C);
- work from any address other than A's, or on B's loopback listener.

A pins B's CA the first time it asks (trust on first use over the tailnet, where WireGuard already vouches that the 100.x address is B) and checks every later connection against it.

## Files

- `dataDir/node.json`: this node's `id` (16 hex) and `name` (the tailnet host name).
- `dataDir/mesh.json` (0600): `peers` this node controls (id, name, address, port, pinned CA, token) and `grants` of nodes that control it (token hash, address, node id, name, approval time, last seen).

## For integrators

- Any `/api/*` call with `?node=<id>` is relayed by the home node, streaming both ways (MJPEG and long-poll included). Errors: `PEER_OFFLINE` (502), `PEER_REVOKED` (403, the link is then forgotten), `PEER_UNTRUSTED` (502, certificate does not match the pinned CA).
- A relayed `/api/state` carries the home node's `version` and `mesh`, the target in `node`, and no MAC address (the phone keeps the first MAC it sees as the PC to wake).
- `app.authenticate(token, req)` returns `{kind:'owner'}` or `{kind:'peer', peer}`; `req.ponteCaller` holds the same for every `/api/*` request. `app.mesh.connection(peerId)` gives `{host, port, ca, token}` for relaying a WebSocket.

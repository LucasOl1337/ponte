# ADR 0001: remote desktop over an internet link, paced by acks over the same TCP WebSocket

- Status: accepted (2026-09-29)
- Vocabulary: [CONTEXT.md](../../CONTEXT.md)

## Context

The remote desktop (`/api/rd`, `public/rd.js`, `./ponte rd`) was built for the LAN: gpu-screen-recorder at 60 fps, 12 Mbps, a keyframe every second, over one WebSocket (TLS through the mesh relay). From the notebook away from home (direct Tailscale, 22–60 ms, 1.2–29 Mbps depending on the hour) the picture lagged and froze.

Measured before the change on a simulated link (`tools/lab/rd-link.sh`, desktop scene, the alpha.29 page):

| Scenario | capture → arrival p95 | frames > 500 ms | freezes > 250 ms | encoder restarts |
|---|---|---|---|---|
| M0 LAN | 4 ms, 60 fps | 0% | 0 | 0 |
| M1 2.5 Mbps, 24 ms, 1% loss | 466 ms | 3.4% | 53 in 55 s | 9 |
| M2 20 → 2 → 20 Mbps | 505 ms, 25 s to recover | 5.1% | 43 | 8 |
| M3 2.5 Mbps, 50 ms, 3% loss | 1206 ms | 41% | 52 | 7 |

Why:

- **Keyframes every second.** At 2 Mbps a gsr keyframe is 110 KB, 50–60% of the bitrate, and takes ~350 ms to cross a 2.5 Mbps link: a stall every second.
- **The server was blind to the real queue.** With `tcp_notsent_lowat` unlimited the kernel takes everything, so Node's `bufferedAmount` stays at 0 while ~200 KB wait in the socket.
- **A sawtooth.** Climbing 25% after 10 s calm overfilled the link, the latency grew for ~8 s before the step down, and it repeated.
- **Changing anything restarts the encoder.** gpu-screen-recorder has no runtime bitrate, frame-rate or IDR control: every change costs ~450 ms without a frame plus a keyframe.

## Decision

Keep H.264 from gpu-screen-recorder over the same WebSocket and pace it from the server:

1. **Open by round trip.** Three WebSocket pings before the first frame (answered by every browser and by the relaying node). Under 15 ms the session keeps the LAN encoder; otherwise it opens on step W3 of a six-step WAN ladder (15–30 fps, 600–6000 kbps, width capped at 1920 or 1280 and at the page's stage). A LAN session whose round trip or queue grows moves to the steps; never back.
2. **Per-frame acks from the page** (`{t:'ack', seq}` on arrival, at most every 50 ms, announced by `caps.ack` in the hello). On the server's clock: the queue is the acked frame's age minus its 10 s floor, the delivered rate is the acked bytes, and in-flight bytes are the unacked ones. Over 150 ms for half a second and not draining from its peak → one restart straight to the highest step that 80% of the delivered rate carries. In flight for over a second → the same, without waiting for an ack. On the floor, frames are shed until the queue drains.
3. **Rationed restarts.** Up one step after 30 s calm, at most once a minute; a keyframe burst measures the link's capacity, and a fresh sample (≤ 2 min) may skip steps. A climb that fails within 20 s doubles the wait for that step (1, 2, 4, up to 8 min), cleared after 10 min one step below or by a sample with 1.5× room.
4. **Keyframes on request, not by the clock.** Outside the LAN the interval is 300 s for a page that sends `{t:'keyframe'}` when its decoder drops a delta (`caps.key`), 60 s for one that cannot. Requests within 2 s are one restart; more than three a minute step down. A server-side drop asks for a new run too.
5. **Older pages keep working.** Without acks the server uses the stats every page already sends once a second: the round trip of its pings minus its floor (the pong waits behind the video), its p95 as a second vote, its kbps as the delivered rate, and dropped frames as an implicit keyframe request. Older servers ignore `caps`, `view`, `ack` and `keyframe`.

## Results

Same lab, same scenarios, 60 s each, on the code of this round (`33a48de`):

| Scenario | page | capture → arrival p95 | frames > 500 ms | freezes > 250 ms | restarts | recovery after the 2 Mbps dip |
|---|---|---|---|---|---|---|
| M0 LAN (30 s) | acks | 4 ms, 60 fps | 0% | 0 | 0 | |
| M0 LAN (30 s) | alpha.29 | 4 ms, 60 fps | 0% | 0 | 0 | |
| M1 | acks | 110 ms | 0% | 0 | 1 | |
| M1 | alpha.29 | 165 ms | 0% | 0 | 1 | |
| M2 | acks | 121 ms | 0% | 0 | 1 | 2–3 s (was 25 s) |
| M2 | alpha.29 | 252 ms | 1.6% | 0 | 1 | 4–5 s |
| M3 | acks | 219 ms | 1.7% | 1 | 2 | |
| M3 | alpha.29 | 196 ms | 0% | 2 | 2 | |

- With an alpha.29 page the signal comes once a second and the rule asks for two bad reports, so the dip costs 4–5 s: the limit of that page's signal, accepted for this round.
- M3 on the floor varies between runs (one alpha.29 run had a 2.6 s stretch over 500 ms): TCP retransmits in order and a 1 Hz signal reacts late.
- M0 five times: the base code froze for ~1 s in 2 of 5 runs (a 340 KB LAN keyframe dropped over the 150 KB delta ceiling), this code in 0 of 5.
- `tcp_notsent_lowat=131072` inside the lab namespace repeats M0 but makes M1 worse (p95 175–200 ms, 2 freezes): not recommended.
- In Chromium through the mesh relay (2.5 Mbps, 24 ms): p95 at the glass ~110 ms with acks and the picture in the 2nd second; an alpha.29 page drops its first frames while its decoder configures and gets the picture in the 4th (the 5th before `33a48de`).

## Consequences

- A step change still costs ~450 ms without a frame and a keyframe. The ladder, the 30 s calm and the backoff exist to make that rare.
- Quality is lower on a slow link by design: delay first, then legibility (width), then motion (fps).
- TCP still retransmits every lost packet in order, so 3% loss on a 50 ms link keeps a p95 of a few hundred ms even on the floor.
- An alpha.29 page on the notebook gets the steps and the fallback signals as soon as the PC is updated; acks and `{t:'keyframe'}` come when the notebook's node is updated too.

## Later

- **WebRTC** (UDP, per-frame loss handling, congestion control in the browser, no head-of-line blocking) is the way past TCP's limits on lossy links. It means a media stack on the target (e.g. GStreamer or a WebRTC library feeding NVENC) and signalling through the mesh; not in this round.
- **Tailscale's `CurAddr`** (direct vs DERP, and the peer's endpoint) could tell LAN from WAN before the first ping, and a DERP relay from a direct path.
- **`tcp_notsent_lowat`** moves the queue from the kernel to Node, where old frames can still be dropped. Measured, it did not help: with acks the server already sees the queue.
- **BBR** as the target's congestion control (with the `fq` qdisc) backs off on delay rather than on loss and should suit lossy links; not measured here (the module is not loaded on the lab machine).

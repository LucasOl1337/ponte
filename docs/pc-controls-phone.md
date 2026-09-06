# PC controls phone (vice-versa)

Status: Option A CLI is implemented (`ponte phone`). Options B and C remain
specification. This document describes how the PC controls the already-paired
Android phone over the same Tailscale network, mirroring what Ponte does today
in the opposite direction.

## Goal

A PC-side companion to Ponte: from the Omarchy desktop, see the paired phone's
screen and operate it (tap, type, go back, answer a notification) without
picking the phone up. Same trust model as today: private Tailscale network,
explicit pairing, no cloud service, no analytics.

Non-goals: controlling a phone that was never paired, controlling iOS, remote
access over the public internet, and any feature that needs a Google account or
a third-party cloud relay.

## How Ponte works today (ground to reuse)

- Pairing is a random 32–128 character base64url token stored outside the repo
  (`$XDG_STATE_HOME/ponte/`, `docs/setup.md:33-40`). Every `/api/` call must
  present it as a `Bearer` token compared in constant time (`server.mjs:205`).
  The Android app keeps its copy in private WebView storage and consumes an
  optional one-time `pair_token` intent extra (`MainActivity.java:54-68,165-167`).
- Transport is two listeners on the PC: plain HTTP on loopback `127.0.0.1:8787`
  and HTTPS with a dedicated leaf certificate on the PC's Tailscale IPv4
  (`server.mjs:267-280,325-338`; the bind must be inside `100.64.0.0/10`,
  `backend/config.mjs:6-10,45-54`). The app pins the exact server leaf, not the
  CA, and refuses redirects (`android/README.md:49-53`).
- The app never talks to the PC directly. A native loopback proxy on
  `http://127.0.0.1:18987` forwards an allowlist of methods and paths upstream
  (`MainActivity.java:44,156`, `LoopbackProxy.java:13` and its path allowlist).
  There is no JavaScript bridge, no external navigation and no WebView backup
  (`android/README.md:55-63`).
- The PC API is a small explicit list: `health`, `state`, `action`,
  `screenshot`, `stream` (authenticated MJPEG, max 10 fps), `audio` and, on this
  branch, `terminals` (`server.mjs:202-244`). Desktop effects run through
  bounded subprocess calls to `hyprctl`, `ydotool`/`ydotoold`, `wtype`, `grim`,
  `wpctl`, `ffmpeg`/`ffprobe` and `ffplay` (`docs/setup.md:9-21`,
  `backend/desktop.mjs`).
- The APK declares only `INTERNET`, `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`
  (`android/AndroidManifest.xml:4-6`).

## Option A — scrcpy / wireless ADB over Tailscale

Run the standard open-source screen-copy tool over the existing tailnet: the PC
runs `adb` + `scrcpy`, the phone exposes wireless debugging, and video/input
flows over TCP to the phone's stable Tailscale IPv4 address. No APK change.

Pros:

- Full control on day one: live screen, taps, typing, back/home, clipboard and
  (Android 11+) audio forwarding, all maintained upstream by scrcpy.
- Zero new Android permissions and zero background battery cost: nothing new
  runs on the phone; the existing Ponte APK is untouched.
- Fully reversible: turn wireless debugging off and the path disappears.

Cons:

- Requires Developer options and wireless debugging on a personal phone, plus a
  manual `adb pair` step; the debugging port can change and must be re-entered.
- ADB is a full shell, far broader than Ponte's explicit action list, so a
  compromised PC user account means full phone access while debugging is on.
- Extra PC dependencies (`android-tools`, `scrcpy`) and H.264/H.265 encode load
  on the phone during mirroring.

Android permissions needed: none in the manifest. On the device: enable
Developer options, turn on Wireless debugging, pair with code. The wireless
debugging session must stay on for the whole control session.

What it reuses: the Tailscale identity and `trustedHosts` concept
(`backend/config.mjs`, `server.mjs:62-83`); the `ponte` CLI setup/install/pair
flow patterns (`ponte`, `docs/setup.md:46-59`); the MJPEG viewer and live
profile UX in `public/` as reference for embedding the scrcpy window; the
synthetic-adapter test discipline for any wrapper (`tests/`, `CONTRIBUTING.md`).

## Option B — AccessibilityService inside the Ponte app + on-device HTTP API

Extend the Ponte Android app with an accessibility service and a small
phone-side HTTP server that mirrors the PC's API shape (`/api/phone/state`,
`/api/phone/action`, screen frames). The PC becomes the client; the phone
authenticates it with the same pairing token over the tailnet.

Pros:

- Product-coherent: one pairing, one trust model, no Developer options, works
  with the APK the user already trusts.
- Scoped actions: the API exposes exactly what Ponte allows (tap, swipe, type,
  back, launch app), unlike ADB's full shell.
- Reuses Ponte's auth, pinning and UI patterns almost one-to-one.

Cons:

- Largest build: foreground service with persistent notification, on-device TLS
  server, `MediaProjection` capture, accessibility node actions, all with
  lifecycle edge cases like the microphone gate in `MainActivity.java:125-141`.
- Accessibility access is a sensitive grant; users and reviewers rightly
  scrutinize it, and the service costs battery while running.
- Screen capture needs runtime `MediaProjection` consent on every start unless
  carefully retained; background starts are restricted on recent Android.

Android permissions needed: `BIND_ACCESSIBILITY_SERVICE` (service declaration +
user opt-in in Settings), `FOREGROUND_SERVICE` + runtime `POST_NOTIFICATIONS`
for the persistent service, media projection consent at runtime for frames.
`INTERNET` already exists; a phone-side server socket needs no new manifest
permission but does need the foreground service to stay alive, which requires
asking the user to disable battery optimization for Ponte.

What it reuses: `Bearer` token auth, request guard, rate limits and body caps
(`server.mjs:61-135,199-214`); the `schemaVersion: 1` config contract
(`backend/config.mjs`, `ponte`); exact-leaf pinning in reverse (phone presents
a pinned cert, `LoopbackProxy.java:61-72` as the model); the Activity
permission/lifecycle patterns (`MainActivity.java`); the `public/` live-view
and action UX.

## Option C — notifications / clipboard mirroring only

No screen, no taps. The app forwards notifications (and optionally clipboard)
to the PC over the existing TLS channel; the PC shows them and offers the few
remote-input actions Android allows (notification replies, mark as read).

Pros:

- Smallest change and smallest risk: two well-understood APIs, no Developer
  options, no accessibility, no video encode.
- Always-on friendly: cheap enough to run continuously, unlike video.

Cons:

- Not phone control: cannot tap, type, navigate or see the screen, so it does
  not satisfy the stated goal on its own.
- Notification access exposes message content to the PC process; clipboard
  sync can leak passwords if not scoped and logged carefully.

Android permissions needed: `BIND_NOTIFICATION_LISTENER_SERVICE` (user opt-in
in Settings) for notifications; clipboard access in the foreground service for
clipboard sync. No manifest-dangerous additions beyond the listener service
declaration.

What it reuses: the existing authenticated TLS upload pattern (`/api/audio`
POST, `server.mjs:239-243`); the pairing token and leaf pinning unchanged; the
`getState` aggregation shape for a `phone-state` payload (`server.mjs:205-207`,
`backend/desktop.mjs:74-101`).

## Comparison

|  | A: scrcpy/ADB | B: in-app service | C: notifications only |
| --- | --- | --- | --- |
| Full screen + input | yes | yes | no |
| APK change | none | large | small |
| Phone-side grant | wireless debugging | accessibility + projection | notification access |
| Privilege breadth | full shell (broad) | scoped actions (narrow) | read + replies (narrowest) |
| Battery when idle | zero | service cost | negligible |
| Time to first demo | one evening | weeks | days |

## Recommendation

Ship **Option A (scrcpy / wireless ADB over Tailscale)** as the supported path.

It is the only option that delivers the goal — see and operate the phone from
the PC — without changing the released APK, adding permissions, or spending
battery when idle. The phone keeps the exact attack surface it has today, and
the whole path is reversible from the phone's Settings. Option B is the right
long-term product if Lucas later wants control without Developer options, and
Option C is a useful always-on complement, but neither should gate the first
working version.

## Control the phone from the PC

This is Option A in practice. The PC talks to the Redmi (`redmi-note-13-pro-5g-1`)
at Tailscale IPv4 `100.111.221.82`. After a successful wireless-debugging
session Android usually listens on port **5555**, which is the Ponte default.
The pairing port (we have seen 33841 and 44875) is only needed when the phone
shows a pairing code.

ADB is a full shell. Leave Wireless debugging off when you are not using it.

### One-time on the phone

1. Enable Developer options (tap Build number seven times).
2. Turn on **Wireless debugging**.
3. Keep Tailscale connected on the phone.

If the PC has never been accepted, open Wireless debugging → **Pair device with
pairing code**. Note the pairing IP:port and the 6-digit code.

### On the PC

```sh
./ponte phone status
```

Checks that `adb` and `scrcpy` are installed, whether `100.111.221.82` is online
on the tailnet, and whether ADB already lists the phone as `device`.

If status says you need a pairing code:

```sh
./ponte phone pair 100.111.221.82:37123 123456
```

Use the pairing IP:port and code from the phone, not 5555.

Connect (defaults to `100.111.221.82:5555`, or the last address you saved):

```sh
./ponte phone connect
./ponte phone connect 100.111.221.82:5555
```

Open the scrcpy window (title `Ponte`, stay awake, H.264, no audio). Optional
`--screen-off` turns the phone display off while you use the PC:

```sh
./ponte phone view
./ponte phone view --screen-off
```

When the debugging port rotates, `connect` fails instead of hanging. Read the
new port on the phone and run `./ponte phone connect IP:PORT` again. Close the
scrcpy window to end the session. Turn Wireless debugging off to cut access.

Install tools on this Omarchy PC with `pacman -S android-tools scrcpy` if
`status` says they are missing.

## First minimal slice

A `ponte phone` CLI wrapper plus docs, no APK or server changes:

1. `ponte phone --check` verifies `adb` and `scrcpy` exist and prints the exact
   phone steps (Developer options, Wireless debugging, pair code, Tailscale on).
2. `ponte phone` connects `adb` to the phone's Tailscale IPv4 address and port,
   then opens `scrcpy` with a sane default (video codec H.264, no audio until
   the user opts in, window titled with the phone name).
3. `docs/` gains a one-page guide: enable, pair, connect, disconnect, and what
   to do when the debugging port rotates.

Acceptance: on the Redmi Note 13 Pro+ (Android 14) over Tailscale, Lucas opens a
phone window from the PC, taps, types a sentence into an app, goes back, and
closes the session; turning wireless debugging off ends all access. Validation
is a real-device check plus `npm test` staying green; the wrapper itself is
tested with a fake `adb`/`scrcpy` on PATH, following the synthetic-adapter rule
(`CONTRIBUTING.md:5-7`).

## Risks

- Wireless debugging reachability over the Tailscale interface is unverified on
  the Redmi; Android may bind it to the Wi-Fi interface only.
- The debugging port can rotate, which breaks reconnects until the user reads
  the new port; the wrapper must surface this instead of failing silently.
- ADB grants a full shell, so this path must never be enabled unattended and
  must be documented as stronger than Ponte's normal action list.
- Video encode heats the phone and drains battery; default to modest bitrate
  and let the user raise it.
- `scrcpy` and `adb` versions drift across distros; pin the known-good versions
  in the guide once measured.

## Decisions only Lucas can make

- Enable Developer options and wireless debugging on his personal phone (yes/no).
- Accept ADB-strength access for phone control, or require scoped actions only
  (which means Option B instead).
- Whether the phone's Tailscale address may be used for ADB, or control must be
  home-Wi-Fi only.
- Whether phone control may run while the PC screen is locked, and whether it
  must stop when the PC sleeps.
- Whether to pursue Option B later (no dev-mode UX) and/or Option C (always-on
  notifications) after Option A lands.

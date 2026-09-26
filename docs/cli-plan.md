# Agent CLI plan and coverage

## Audit, 2026-09-25

The existing `ponte` executable handles installation, private configuration,
certificates, user services, pairing, diagnostics and the phone's ADB lifecycle.
`ponte pc` exposes only session, power, monitor and RGB actions. The app already
has an authenticated HTTP API, but no supported shell client for most of it.
The backend and UI have no production npm dependencies. Preserve that property.

## Implementation decisions

1. Keep existing `ponte`, `ponte pc` and `ponte phone` commands compatible.
2. Add `ponte ctl` as a small Node client of the running server. Reuse the same
   authentication, serialized actions, validation and service-owned resources as
   the app. Do not spawn a second desktop controller or tmux registry.
3. Use a declarative, offline command catalog for help, JSON discovery, parameter
   validation and action coverage tests. Include a validated generic action path.
4. Return a versioned JSON envelope, stable error codes and nonzero exit statuses.
   Support bounded requests, stdin text/passwords, private binary output,
   dry runs and explicit confirmation for power-off/reboot/suspend/session removal.
5. Use existing private config/token by default. Remote access requires HTTPS,
   verified TLS and an explicitly selected token file when operating elsewhere.
   Never retry mutations or follow redirects. Never expose tokens in diagnostics.
6. Validate through real CLI subprocesses and the actual HTTP server with injected
   desktop/audio/transcription adapters. Keep the human desktop and phone untouched.
7. Publish a command guide and cross-links from the repository entry points.

## Coverage matrix

| Application surface | Agent entry point | Verification |
| --- | --- | --- |
| Health, full state and available capabilities | `ctl health/state/capabilities` | HTTP subprocess integration |
| Windows, workspaces, monitors, session, lights, volume, power, text focus | read-only `ctl` queries | selection and endpoint tests |
| Pointer, click, scroll, drag, keyboard text and shortcuts | named commands and `ctl action` | every action mapped, fixtures only |
| Workspace/window focus and exact-window movement | `ctl workspace/window` | body validation and server integration |
| Volume, media, app launch | `ctl volume/media/app` | catalog + API tests |
| DPMS, sleep/wake, suspend/reboot/off | `ctl monitors/power` | confirmation, alias, no-action dry-run tests |
| RGB and cooler screen | `ctl lights` | every backend action discoverable |
| Session lock/unlock | `ctl session` | stdin-only password, redaction tests |
| Terminal create/list/read/input/key/resize/remove | `ctl terminals` | HTTP lifecycle and error tests |
| Dictation, including terminal target | `ctl dictate/terminals dictate` | upload, MIME, no implicit Enter |
| Voice list/upload/download/play/stop | `ctl audio` | upload/download, file safety, server errors |
| Screenshot and bounded MJPEG stream | `ctl screenshot/stream` | binary files, deadline and cleanup |
| Pairing and service lifecycle | existing `ponte` commands | existing CLI/service tests |
| Android build, install, launch, connect, timer and diagnostics | existing scripts and `ponte phone` | existing CLI/native tests |
| Client-only UI preferences: language, zoom, orientation, recording UI | UI or Android bridge, not server state | documented boundary, not invented endpoints |
| Wake-on-LAN from a sleeping PC | phone native bridge, status via `ctl power` | documented boundary: server cannot run asleep |

## Acceptance checks

- Existing test suite stays green.
- Every desktop action type, including aliases, has a catalog mapping.
- Help/schema/version/dry-run work without a running service or private config.
- Mutating commands never run on help, malformed input or missing confirmation.
- Authentication, remote TLS policy, bounded I/O, binary output ownership and
  cancellation have dedicated tests.
- Real subprocesses can query state and exercise representative complete API
  flows against an isolated real server, without injecting desktop input.
- No production dependency, service restart, phone installation or credential
  rotation is needed for this delivery.

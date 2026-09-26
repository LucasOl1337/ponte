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

## Delivered and verified, 2026-09-25

- `ponte ctl` contains 59 named commands, all 32 canonical desktop actions and
  five aliases. A source-to-catalog test compares every backend action case.
- `npm test`: 179 tests, 178 passed, zero failures, one opt-in systemd lifecycle
  test skipped. Existing administration/phone CLI fixture tests remain green.
- New suites contain 18 CLI workflow tests and 27 transport tests. They cover
  every named action, aliases, queries, uploads/downloads, transcription,
  confirmations, offline help/schema/dry-run, private configuration redaction,
  malformed inputs, timeout ambiguity, TLS trust/hostname and cleanup.
- The CLI also completed a real private tmux workflow: create, send a Unicode
  command, observe its distinct output, resize, remove and verify an empty
  registry. It used its own HOME, socket and shell, not the user's tmux or GUI.
- `./android/test.sh`: 129 proxy checks, 17 microphone permission checks,
  124 Wake-on-LAN checks and seven Python configuration tests passed. No phone
  or customized APK was needed.
- `./ponte ctl health --timeout 3000` succeeded against the installed service,
  returning its version. No installed service was restarted and no real display
  was captured or controlled.
- Ten process-start measurements on this PC: offline `schema` median 70 ms
  (68-81 ms), `version` median 71 ms (69-74 ms). These include the Python entry
  point and Node startup, not just an in-process function benchmark.
- Review fixed generic action help/schema, confirmation and password-source
  checks before input reads, contradictory DPMS parameters, invalid output
  paths, missing selected fields and configuration error redaction. A stream
  cancellation race in an intermediate implementation was fixed using an exact
  duration-stop sentinel. Thirty repeated focused transport/real-router checks
  then passed, followed by the complete suite.

Scope remains explicit: server actions are available through the CLI, existing
administration/Android tools are preserved, and phone-only zoom/orientation/
preferences and Wake-on-LAN packet delivery are not invented as server APIs.
Desktop/power effects were tested with synthetic adapters rather than executed
on the owner's running session. See `docs/cli.md` for all commands and limits.

## Post-push acceptance observation

The delivered commit `cafb3fc` was exercised again, not just inspected. To
establish the improvement, the original Python entry point from `99f93cf` was
executed from Git in a separate process with its original repository path. The
same `ctl schema` request was then run against the delivered entry point, both
with an explicitly nonexistent private configuration.

| Requirement | Executed observation | Result |
| --- | --- | --- |
| Discover app controls without UI or setup | Original entry point: `ctl schema` exits 2, invalid command. Delivered entry point: exits 0 and returns 59 command descriptors from the nonexistent-config environment | A previously unavailable agent workflow now works offline |
| Cover all public desktop actions | CLI suite sends every one of the 32 named actions through the real router and checks all five aliases against the backend cases | No uncovered backend action, requests match expected payloads |
| Complete an autonomous workflow, not just issue requests | Real private tmux: CLI creates a session, types and executes a split Unicode sentinel, reads the assembled output, resizes to 100x30, removes it and confirms empty sessions/registry | Output proves actual shell execution rather than input echo, with no GUI interaction |
| Easy, deterministic safety checks | Generic `power.poweroff --dry-run` exits 0 and reports confirmation needed. Without confirmation, the same action with a nonexistent input file exits 2 with `CONFIRMATION_REQUIRED`, before file/config reads | Dry-run and confirmation work for aliases without effects or prompts |
| Work with the existing app | Delivered `ctl health --timeout 3000` returns `Ponte`, version `0.1.0-alpha.19`, exit 0 from the installed server | No restart, installation or server change required |
| Stay lightweight and fast | No production npm dependencies. Twenty fresh `ctl schema` processes: median 57 ms, p95 61 ms, max 62 ms, including Python, Node and JSON serialization | Measured startup remains short; numbers are local measurements, not a cross-machine guarantee |
| Make repository tests available to agents | Executed the documented `npm run test:cli` after push: 65 passed, 0 failures, 0 skipped in 12.4 seconds | Administration regressions, new client transport and CLI acceptance workflows all pass through one documented command |

These observations close the engineering acceptance loop for the requested CLI.
They do not claim a new physical-phone deployment or live power/input exercise:
those effects deliberately remain isolated, and phone-only preferences remain
outside the server's control contract.

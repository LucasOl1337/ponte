# Evidence and tested scope

Recorded on September 5, 2026. This report separates physical-device observations from automated tests and PC-side measurements.

## Physical Android device

The development build ran on a Redmi Note 13 Pro+ 5G with Android 14 and a current Android System WebView. Its transport was the app's native loopback proxy and TLS over Tailscale. It did not depend on ADB reverse or a development web server exposed on the LAN.

| Observation | Result |
| --- | --- |
| App installed and opened from the home screen | Verified |
| Pairing accepted by the PC | Verified |
| Pairing survived force-stop and reopening the actual home-screen icon | Verified |
| Monitor DP-2 delivered changing live frames | Verified at 13:39:38, 13:39:49 and 13:40:47 local time |
| Fullscreen live view | Verified |
| Android recording | Initial build failed because Chromium required MODIFY_AUDIO_SETTINGS. The manifest fix passed packaging tests. A physical-device retest is pending |
| Cellular or geographically remote network | Not measured |

Original screenshots: [touchpad](assets/redmi-control.png), [live monitor](assets/redmi-live.png), [fullscreen](assets/redmi-fullscreen.png), [voice interface](assets/redmi-voice.png). All are original captures, not rendered mockups. The voice image is idle. No screenshot alone proves a throughput measurement.

The monitor was playing the [Lex Fridman Podcast interview with DHH](https://www.youtube.com/watch?v=NYFGCESmikA). Its appearance documents what the app received. It does not imply affiliation or endorsement.

## PC-side live capture measurement

A 4.54-second sample requested three simultaneous streams from the real desktop. The profile requested 10 fps at 0.5 scale. Capture used the implementation's concurrency limit. No monitor frames from the benchmark were retained.

| Monitor | Observed fps | First frame | Throughput |
| --- | ---: | ---: | ---: |
| HDMI-A-1 | 7.33 | 78 ms | 2.76 Mbit/s |
| DP-1 | 7.33 | 120 ms | 3.35 Mbit/s |
| DP-2 | 7.11 | 177 ms | 6.84 Mbit/s |

The measurement consumed 8.51 CPU-seconds in 4.54 wall-seconds. It is a short local capture sample, not an Android frame-rate test, a battery test, or a WAN benchmark. Content and monitor resolution affect bandwidth and throughput.

## Browser and transport checks

Authenticated browser integration exercised all three monitors, quality switching, fullscreen, zoom and pause on leaving the live tab. The layout check used a 390-pixel viewport. A separate Java loopback proxy test connected to the real TLS backend and received changing JPEG frames for all three monitors.

The public-source suites cover authentication failures, request validation, stream cancellation, bounded frame parsing, audio storage limits, exact certificate pinning, hostname errors and Android permission lifecycle. They use temporary configuration, synthetic TLS servers and stub desktop commands.

Run the current tests as documented in [the README](../README.md#development). Their output describes the source under test. Earlier physical screenshots document the personal development build, not a fresh installation of every public commit.

## Known limits

MJPEG profiles top out at 10 fps and carry no system audio. Recording verification on Android remains incomplete. The first installation requires building an APK and manually entering a pairing key. Leaf certificate renewal requires rebuilding that APK. iOS, multi-user access and internet-exposed deployment are outside this alpha's tested scope.

## Global interface

The global release defaults to English and offers a persistent Portuguese preference. Browser previews use a separate local review instance connected to the PC, with desktop actions disabled for the review. They document the actual interface at a 390-pixel mobile viewport. They are not Android device captures.

Original English browser captures: [touchpad](assets/app-en-control.png), [monitor controls](assets/app-en-screen.png), [voice interface](assets/app-en-voice.png). The original physical Redmi captures above remain unedited in Portuguese.

## Next alpha: direct screen access and text terminals

The [new screen and terminal guide](screen-and-terminals.md) records this revision separately. Its Chromium captures use a synthetic monitor and a real shell on a temporary private tmux socket. They demonstrate the running interface without using a person's desktop or terminal.

The source passed 67 Node tests. The native adapter passed 98 proxy checks, 17 microphone lifecycle checks and seven configuration tests. These automated microphone checks do not complete the pending physical recording test. The updated personal APK compiled and passed package, signature, certificate and permission checks; it has not yet been installed on the Redmi.

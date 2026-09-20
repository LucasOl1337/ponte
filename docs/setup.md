# Setup and operation

Ponte controls the current Hyprland graphical session. Start it as your normal desktop user. An installation in a headless SSH session may not have the display, Wayland or D-Bus environment needed for desktop actions.

## Requirements

The server requires Linux, Node.js 22+, Python 3.12+ and OpenSSL 3. A configured Tailscale connection on both devices is required for the native Android transport. Complete Tailscale authentication yourself before setup.

Desktop actions use these commands:

| Command | Feature |
| --- | --- |
| `hyprctl` | Monitors, windows and workspaces |
| `ydotool` and `ydotoold` | Pointer and keyboard shortcuts |
| `wtype` | Unicode text input |
| `grim` | Monitor capture |
| `tmux` | Optional phone terminal sessions |
| `wpctl` | PipeWire volume |
| `ffmpeg` and `ffprobe` | Image/audio processing and validation |
| `ffplay` | Audio playback on the PC |

The user needs existing `/dev/uinput` access for the private input daemon. Ponte does not run its server as root or automatically change global input permissions. Missing capabilities appear in the interface. A session with no writable input socket cannot move the mouse or send shortcuts.

## Configure

From your checkout, run:

```sh
./ponte setup
```

This detects the current Tailscale IPv4 address and creates a private config file, a random pairing token, a local CA and a server certificate with the matching IP SAN. It does not start services. `./ponte setup --tailscale-ip 100.64.0.10` can explicitly select an address. That example is synthetic and must be replaced with your own address.

| Path | Purpose |
| --- | --- |
| `$XDG_CONFIG_HOME/ponte/config.json` | Server and Android build configuration |
| `$XDG_CONFIG_HOME/ponte/tls/` | Per-installation TLS material |
| `$XDG_STATE_HOME/ponte/` | Pairing token and local audio data |
| `$XDG_CONFIG_HOME/systemd/user/ponte-remote.service` | Main user service |
| `$XDG_CONFIG_HOME/systemd/user/ponte-input.service` | Private input daemon |
| `$XDG_DATA_HOME/ponte/android-signing/` | Local Android signing key and password |

The usual XDG fallbacks are `~/.config`, `~/.local/state` and `~/.local/share`. `PONTE_CONFIG` selects an alternative absolute config path. Do not put private state inside the source checkout. Keep configuration at mode 0600 and its containing directory private.

Existing configuration is preserved on a repeated setup. `--local-only` creates an HTTP development configuration without TLS. Repeating setup afterward does not silently upgrade that configuration. Use a separate `PONTE_CONFIG` and private XDG state directory to create a different installation, or back up and deliberately replace your old configuration.

## Start and pair

```sh
./ponte install
./ponte status
./android/build.sh
./ponte pair
```

`install` writes user service units and explicitly enables and starts Ponte for the graphical session. It refuses to overwrite differing service definitions. Keep the checkout at its current path because those units reference it.

Before starting the server, systemd checks the configuration and TLS certificate/key. Missing or invalid files skip startup without automatic retries. Restore those files or correct their configured paths, then run `./ponte start`. The check never generates replacement keys or disables TLS.

Server restarts leave the input daemon running, so a server failure does not repeatedly disconnect the desktop's virtual keyboard. Both services stop with the graphical session; `./ponte stop` explicitly stops both. Other failures are limited to three starts within 60 seconds. After repairing a failure that reached this limit, run `systemctl --user reset-failed ponte-remote.service ponte-input.service` before starting again.

Install `.work/Ponte.apk` on your own Android phone. Open it and paste or type the pairing key into the connection form once. Later launches remember the connection. The APK is personalized for your PC and must not be shared as a generic release.

The Android build pins the exact public leaf certificate and reads no server private key. See [Android setup](../android/README.md) for toolchain requirements, build overrides and lifecycle details.

## Daily commands

```sh
./ponte stop
./ponte start
./ponte restart
./ponte logs
./ponte phone status
./ponte phone ensure
./ponte phone app
./ponte phone install [Ponte.apk]
./ponte phone wake
./ponte phone view
./ponte phone timer on|off
./ponte pc lock|unlock|sleep|wake|suspend|reboot|off
./ponte pc monitors on|off [NAME]
./ponte pc lights lava|brasa|oceano|aurora|floresta|lua|sleep|restore|reapply
```

`phone` reaches the Redmi over Tailscale alone, with adb on a fixed TCP port: no USB cable and no shared Wi-Fi. The default address is `100.111.221.82:5555`. See [PC controls phone](pc-controls-phone.md) and [Phone over Tailscale](#phone-over-tailscale-no-cable-no-wi-fi) below.

`pc` runs the same validated desktop actions the phone uses, from a local shell or over Tailscale SSH (`ssh user@<tailscale-ip> ./ponte pc suspend`). It needs no HTTP server or pairing. `unlock` reads the password from stdin (`echo -n 'pw' | ./ponte pc unlock`) and only types it while the Omarchy lock is up. Dictation and the keyboard raise are optional: set `PONTE_STT_URL` / `PONTE_SUSSURRO_SOCKET` to `''` to disable a provider, and note that the phone keyboard only rises automatically when fcitx5 runs on the PC.

A stopped service is unavailable to the phone. Your PC must be awake, connected to Tailscale and running the graphical session. Returning to the Android app does not automatically restart a live stream that was paused when it went into the background.

`./ponte serve` is an optional, explicit Tailscale Serve operation for the browser interface. It requires a configured Tailscale DNS name in `trustedHosts`; the native Android app does not require Serve. Check your existing Serve configuration before using that command.

## Phone over Tailscale (no cable, no Wi-Fi)

An agent or a script on this PC can install, launch and drive the Android app while the phone is anywhere with Tailscale up, on mobile data included. adb on the phone listens on TCP port 5555 on every interface, Tailscale's among them, and this PC's adb connects to `100.111.221.82:5555`.

```sh
./ponte phone ensure          # reachable over Tailscale, or fix it through any transport that is up
./ponte phone install         # adb install -r .work/Ponte.apk, then the version the phone reports
./ponte phone app             # Ponte to the front: screen on, above the lock screen, live stream
./ponte phone timer on        # user timer: ensure every 2 min, so the link survives network changes
adb -s 100.111.221.82:5555 exec-out screencap -p > shot.png
adb -s 100.111.221.82:5555 shell input tap 610 1106
```

What each piece does and where it stops:

- **`ensure`** connects to the saved address and checks that a shell answers. If the phone is not listening (adbd forgets the TCP port on every reboot), it looks for any other adb transport that is up right now (the USB cable, or a Wireless-debugging session on Wi-Fi), runs `adb tcpip 5555` through it, and reconnects over Tailscale. With nothing up it prints the one manual step: plug the phone in once, or on Wi-Fi turn on Wireless debugging and `./ponte phone connect IP:PORT` (pairing is remembered); after that `ensure` needs nothing again until the next reboot.
- **`app`** starts the activity with the agent extra. The app then shows above the lock screen and turns the screen on, so the phone stays locked for everything else, and it finishes itself the moment it leaves the foreground: a locked phone never keeps PC control one power-button press away. HyperOS gates "show on lock screen" behind its own app op; `app` grants it over adb (`appops set app.ponte.omarchy 10020 allow`) and dismisses the "do not cover the earpiece" guide with Volume Up. The app keeps the screen on while it is in front.
- **`wake`** wakes the phone with the power key and, if `phone-unlock` (mode 0600, in the state directory) holds the PIN, types it after a swipe. This is only needed to reach the rest of the phone; the Ponte app itself needs no unlock.
- **`timer on`** installs `ponte-phone.timer` for this user, which runs `ensure --quiet` every two minutes, so `adb devices` already lists the phone when something needs it and the link re-forms after the phone changes networks. `timer off` removes it.
- **`doctor`** reports whether the Tailscale adb link is up and which app version the phone runs through it.

Security: adbd on TCP accepts only keys the phone has authorized (this PC's), and the port is reachable from other networks only where the phone's network allows inbound connections (mobile carriers do not; a public Wi-Fi might, and any connection attempt from an unknown key prompts on the phone). Turn it off with `adb -s 100.111.221.82:5555 usb` when the phone leaves your hands. A build with `PONTE_ANDROID_DEBUGGABLE=1` makes the WebView inspectable over adb (`tools/lab/cdp.mjs`) for measuring gestures on the real device; keep the ordinary build for daily use.

## Power management and smart sleep

Ponte provides power controls directly from your phone's home dashboard:

- **Per-monitor DPMS toggles:** Turn individual screens off and on using `hyprctl dispatch dpms off/on <monitor>`.
- **Smart sleep (`power.sleep`):** Turns off all monitors via DPMS and switches off all RGB lights using the Magma Lights controller (`python /home/lol/.local/share/magma-lights/controller.py sleep`). **This is not suspend or shutdown**: the PC remains powered on, background agents and processes continue running uninterrupted, and the machine stays reachable over Tailscale.
- **Wake (`power.wake`):** Turns on all monitors via DPMS and restores RGB lighting profiles (`controller.py restore`).
- **Power off (`power.poweroff`):** Shuts down the machine (`systemctl poweroff`) with explicit double confirmation in the UI.

### Wake-on-LAN (WoL) prerequisites and Android magic packet

Because a powered-off machine stops running Ponte and disconnects from Tailscale, turning the PC back on remotely requires a Wake-on-LAN Magic Packet sent over your local Ethernet network.

Ponte exposes your primary Ethernet MAC address (`d8:43:ae:8b:e8:a8`) and interface (`enp12s0`) in the `/api/state` and `/api/power` responses, and the Android app automatically remembers this MAC address.

1. **Motherboard BIOS/UEFI:** Enable "Power On By PCI-E/PCI" or "Wake on LAN" in ACPI/APM power management configuration.
2. **NetworkManager / interface setup:** Ensure Wake-on-LAN is active on the Ethernet interface using `sudo ethtool -s <iface> wol g`. To persist this with NetworkManager, run `nmcli connection modify <connection-name> 802-3-ethernet.wake-on-lan magic` (or configure via `systemd.link` with `[Link] WakeOnLan=magic`). Check status with `ethtool <iface> | grep Wake-on`, which should report `Wake-on: g`.
3. **Android "Turn on PC" button:** When the PC is off and Ponte is unreachable, the Android app displays a "Turn on PC" ("Ligar PC") button on the connection screen. Pressing it broadcasts 3 magic packets via UDP port 9 to `255.255.255.255` and the local Wi-Fi subnet broadcast addresses.
4. **Tailscale limitation:** WoL magic packets are local Ethernet/Wi-Fi broadcasts. **They cannot cross the Tailscale VPN tunnel** because Tailscale operates at Layer 3 (IP unicast routing) and does not bridge broadcast traffic. Your phone must be connected to the same local Wi-Fi network (home LAN) as the PC's Ethernet interface when waking the PC.

## Update

Keep your configuration, token and Android signing directory. Stop the service before updating source, run the relevant tests, then start it again. If a new CLI generates different unit definitions, review them and use `./ponte uninstall` followed by `./ponte install` rather than overwriting an unrelated service.

To update Android, increment `android.versionCode` in your private config and rebuild with the same signing key. Install the update over the existing app. Do not uninstall the app if you want to keep its pairing data. The app pins the installation CA, so `./ponte renew-cert` (the server certificate lasts one year) needs no new APK; only a new CA from a fresh `./ponte setup` does.

## Check the whole link

```sh
./ponte doctor
```

Doctor walks every link between this PC and the phone in the order they can fail: configuration, certificate validity, Tailscale address and connectivity, both services, the TLS listener, auto-pairing (the same request the phone makes), and whether the built APK still pins the current CA. With `adb` and a phone attached it also compares the installed app version. It exits non-zero when something needs attention and says what to run.

## Remove

```sh
./ponte uninstall
```

Removal stops the managed services and removes their units. It keeps configuration, certificates, pairing token and recordings. It refuses to remove an unmanaged service with a conflicting name. Delete private data yourself only when you intend to lose it, including any signing material needed for future Android updates.

## Current troubleshooting

- Start with `./ponte doctor`. It tells the difference between a PC that is off, a service that started before Tailscale (auto-pairing now retries on its own), an expired certificate and an APK built for another installation.
- If the app says the PC certificate changed, the phone runs an APK from a different `./ponte setup`. Rebuild with `./android/build.sh` and install it with the original signing key. A renewed certificate (`./ponte renew-cert`) never triggers this.
- If text works but the touchpad does not, inspect `ponte-input.service` and your user's `/dev/uinput` access.
- On the original Android test device, Chromium required both `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. The source includes both permissions. The updated app's physical recording test is still pending.

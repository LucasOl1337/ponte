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

Install `.work/Ponte.apk` on your own Android phone. Open it and paste or type the pairing key into the connection form once. Later launches remember the connection. The APK is personalized for your PC and must not be shared as a generic release.

The Android build pins the exact public leaf certificate and reads no server private key. See [Android setup](../android/README.md) for toolchain requirements, build overrides and lifecycle details.

## Daily commands

```sh
./ponte stop
./ponte start
./ponte restart
./ponte logs
```

A stopped service is unavailable to the phone. Your PC must be awake, connected to Tailscale and running the graphical session. Returning to the Android app does not automatically restart a live stream that was paused when it went into the background.

`./ponte serve` is an optional, explicit Tailscale Serve operation for the browser interface. It requires a configured Tailscale DNS name in `trustedHosts`; the native Android app does not require Serve. Check your existing Serve configuration before using that command.

## Update

Keep your configuration, token and Android signing directory. Stop the service before updating source, run the relevant tests, then start it again. If a new CLI generates different unit definitions, review them and use `./ponte uninstall` followed by `./ponte install` rather than overwriting an unrelated service.

To update Android, increment `android.versionCode` in your private config and rebuild with the same signing key. Install the update over the existing app. Do not uninstall the app if you want to keep its pairing data. A renewed or replaced server certificate also requires a new APK because the app pins the exact leaf.

## Remove

```sh
./ponte uninstall
```

Removal stops the managed services and removes their units. It keeps configuration, certificates, pairing token and recordings. It refuses to remove an unmanaged service with a conflicting name. Delete private data yourself only when you intend to lose it, including any signing material needed for future Android updates.

## Current troubleshooting

- If pairing fails, confirm Tailscale connectivity, an awake PC and an active service. The setup address, certificate and APK must belong to the same installation.
- If Android cannot connect after certificate renewal, rebuild the APK and install it with the original signing key.
- If text works but the touchpad does not, inspect `ponte-input.service` and your user's `/dev/uinput` access.
- On the original Android test device, Chromium required both `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. The source includes both permissions. The updated app's physical recording test is still pending.

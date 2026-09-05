# Ponte for Android

Build a personal Android app for your own Ponte server. The repository contains no server address, certificate, pairing token or signing key. Each local build embeds your Tailscale address and the public certificate of your server.

The app requires Android 8 or later, a current Android System WebView and Tailscale connectivity to the PC. The interface defaults to English. Its language selector offers Portuguese and remembers your choice. Native connection-error screens remember the language after a page loads; Android system permission dialogs follow the device language.

## Build

Complete the repository's `./ponte setup` first, with native TLS enabled. Then run from the repository root:

```sh
./android/build.sh
```

The default configuration is `$XDG_CONFIG_HOME/ponte/config.json`, or `~/.config/ponte/config.json`. Set `PONTE_CONFIG` to use another local configuration file. A missing configuration stops the build; there is no default server address.

The build requires Linux x86_64, Python 3.12 or later and OpenSSL 3. It downloads pinned official Android Build Tools 35.0.0, Android platform 35 and Amazon Corretto 17.0.20.10.1 into `.work/android-build`, verifying the archive checksums. It does not install tools globally.

The output is `.work/Ponte.apk`. Its package ID is `app.ponte.omarchy`. Keep this customized APK out of public releases: it identifies your own server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PONTE_CONFIG` | XDG config directory, `ponte/config.json` | Local setup configuration |
| `PONTE_ANDROID_BUILD` | `.work/android-build` | Tool downloads and intermediate files |
| `PONTE_ANDROID_APK` | `.work/Ponte.apk` | APK output path |
| `PONTE_ANDROID_KEYS` | XDG data directory, `ponte/android-signing` | Private signing key and password |
| `PONTE_JDK` | Downloaded Corretto directory | Existing JDK override |
| `PONTE_ANDROID_TOOLS` | Downloaded build tools directory | Existing Android build tools override |
| `PONTE_ANDROID_PLATFORM` | Downloaded `android.jar` | Existing Android platform jar override |

Preserve the signing directory for later updates. Android accepts an update over the existing app when its package and signing key match. Increasing `android.versionCode` in the local configuration creates a newer update without changing pairing or app data. Never commit the signing directory or distribute its password.

## Local configuration contract

The Android build reads the configuration produced by the CLI:

```json
{
  "schemaVersion": 1,
  "nativeTls": {
    "host": "100.64.0.10",
    "port": 8788,
    "certFile": "/absolute/local/path/server.crt",
    "caFile": "/absolute/local/path/ca.crt"
  }
}
```

The address above is a synthetic example. The build accepts only canonical IPv4 addresses in the Tailscale range `100.64.0.0/10` and a valid TCP port. It checks certificate validity, the issuing CA, server purpose and the matching IP SAN before generating Java constants, the release manifest and a single public certificate asset.

The complete CLI configuration may also contain `keyFile`, data paths and other settings. The Android build does not open a private key file, read the pairing token from server storage or copy the configuration into the APK. It reads only the public `certFile` and `caFile`. Optional version overrides are an `android` object with `versionCode` and `versionName`; otherwise it uses the source manifest version.

The app pins the exact **server leaf certificate**, not the CA. A different certificate issued by the same CA is rejected during the TLS handshake before Authorization can be sent. Replacing or renewing the server certificate requires rebuilding and installing the Android update. The CA file is used to validate the certificate during the build and is not packaged.

## Pairing and lifecycle

Open the app and enter the pairing key shown by your local Ponte installation. The app stores it in private WebView storage. The first launch can alternatively receive a `pair_token` intent extra containing 32–128 base64url characters. The app removes the extra immediately and removes its temporary native copy once the page consumes it. This initial provisioning entry does not authenticate its caller. Subsequent intents cannot silently replace an existing pairing or reload the app.

The WebView uses `http://127.0.0.1:18987`, a loopback origin suitable for microphone capture. A native proxy forwards approved methods and paths to the configured HTTPS server. It never injects a pairing key, strips browser Origin/Referer upstream, preserves the platform hostname verifier and refuses redirects. It fails if the loopback port is occupied. There is no JavaScript bridge, external navigation, file access, content access, backup or debug WebView in the distributed app.

Leaving the app cancels live video and microphone access. The Android microphone permission dialog can pause the Activity; that temporary pause preserves the pending permission request. A real background transition cancels it, and a late grant cannot revive an older request. TLS cancellation runs outside the UI thread. Returning to the app does not automatically resume live video.

The packaged permissions are `INTERNET`, `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. The latter is a normal Android permission required by Chromium to select a recording device. The microphone still requires the user-facing Android runtime recording permission and the app's explicit record action.

## Tests

```sh
./android/test.sh
python3 android/tests/build_fixture_test.py
```

The first command checks the proxy against local synthetic HTTPS servers, exercises microphone lifecycle state and validates the local build configuration. It covers exact leaf pinning, a CA-issued leaf, hostname mismatch, redirects, request limits, streaming cancellation and late permission callbacks.

The second command compiles a signed synthetic APK using temporary certificates, a temporary signing key and a nonexistent server private-key path. It inspects the resulting APK for the expected public leaf and absence of the fixture pairing token, private keys and configuration. Its output is `.work/Ponte-fixture.apk`, which is only a test artifact and does not point to a working server.

Every normal build verifies the APK signature, alignment, package/version, launcher Activity, exact permissions, public certificate asset and compiled endpoint. These checks do not use the phone, capture a real microphone, or control a desktop. A real-device test remains necessary for WebView and device-specific behavior.

## References

- [Android: accessing a local server in WebView](https://developer.android.com/develop/ui/views/layout/webapps/access-local-server).
- [Android: Activity lifecycle during permission requests](https://developer.android.com/reference/android/app/Activity#requestPermissions(java.lang.String[],%20int)).
- [Android: MODIFY_AUDIO_SETTINGS](https://developer.android.com/reference/android/Manifest.permission#MODIFY_AUDIO_SETTINGS).
- [Chromium: audio device permission requirements](https://chromium.googlesource.com/chromium/src/+/c0d72b08f6a98e9b2fd489760fae2b0562efd3e5/media/base/android/java/src/org/chromium/media/AudioManagerAndroid.java).
- [OpenSSL: certificate verification options](https://docs.openssl.org/3.0/man1/openssl-verification-options/).

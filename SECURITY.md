# Security

Ponte is an experimental remote-control application. A paired device can control the logged-in desktop, inspect window titles, capture monitors and play uploaded audio. Use it only with devices and Tailscale peers you trust.

## Boundaries

- Plain HTTP binds only to loopback. Native TLS binds a configured Tailscale IPv4 address.
- The native Android app pins the exact leaf certificate during the TLS handshake. It never accepts an arbitrary certificate, redirects or hostname mismatch. Renewing that certificate requires a new APK signed with the same Android key.
- Protected endpoints require a pairing token. Host and Origin validation add request checks, but do not replace authentication.
- Desktop actions use an explicit action list and argument arrays without a shell. This still grants substantial desktop access. A keyboard command can type into a terminal that the user has open.
- Terminal sessions run shells as the desktop user. They are not a sandbox. A private tmux socket and exact pane IDs prevent input from reaching an unrelated terminal; they do not restrict what an authenticated shell command can do. Input uses stdin with a separate Enter action, and terminal output is rendered as plain text.
- Audio uploads have format, size, duration and storage limits. Files stay on the PC until explicitly deleted.
- Android keeps pairing in its private WebView storage. A compromised or unlocked phone may expose that access. There is no hardware-backed token vault in this alpha.
- Tailscale encryption, peer enrollment and ACLs belong to your Tailscale configuration. Binding an address in its IP range is not proof of peer identity.

## Local data

Keep the XDG configuration/state directories, TLS private keys, Android signing directory, pairing tokens and customized APKs private. The repository ignores common credential and build artifacts. Ignore rules cannot protect secrets that were already committed.

To revoke a phone immediately, stop the service with `./ponte stop`. Stop the service before removing the `token` file from your configured `dataDir`; the next start creates a new random token. Every previously paired client must then pair again. Unpairing on one phone only clears that client's saved access.

## Reporting

Use GitHub's private vulnerability reporting form in this repository's Security tab. Do not post tokens, keys, recordings, personal window titles or usable exploit credentials in a public issue. Include the version, a minimal reproduction using synthetic data and the effect you observed.

No independent security audit has been commissioned for this alpha.

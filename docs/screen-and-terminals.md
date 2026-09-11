# Screen and terminals

Screen is the first page after pairing or reopening Ponte. It has one mode: the monitor fills the phone and you touch it like a phone. Terminals, Windows, Voice and Home each keep a bottom navigation button; Android's Back returns from Screen to Home.

## Read and control a monitor

Choose the monitor and quality once on Home (the *Screen* card); Ponte remembers both. Live view starts while Screen is visible and stops when you leave or background the app. The *Sharp* profile (default) streams native pixels at up to 15 fps; *Balanced* and *Light* downscale to save bandwidth.

Gestures on the image:

| Gesture | What happens on the PC |
| --- | --- |
| Tap | Left click at that monitor pixel |
| Long-press, then lift | Right click |
| Long-press, then move | Drag with the left button held (move a window, select text); lifting releases |
| Pinch | Zoom, continuous and centred on your fingers |
| One finger while zoomed | Pan the view |
| Two fingers together | Scroll the PC (mouse wheel) |

Zoom is a CSS transform on the phone, like Chrome Remote Desktop. The whole frame is always streamed and never re-cropped mid-gesture, so pinching is smooth and the *Sharp* profile stays crisp up to one monitor pixel per screen pixel. There is no pause, freeze, 1:1 or fullscreen button anymore; the floating buttons beside the mic are **switch monitor** (cycles the monitors in `/api/state`) and **rotate** (forces landscape, hides the system and app bars so the monitor runs edge to edge; tap again to release).

### The phone keyboard

Tap a text field on the PC and the phone keyboard rises by itself. After each tap-click the app asks `GET /api/textinput`; the server reads fcitx5's input contexts over DBus and answers `focused: true` only while an enabled text field has focus (a terminal counts; a dialog with only buttons does not). A hidden input then takes focus, Android shows its keyboard, and every edit is forwarded live: typed characters as `keyboard.text`, deletions and autocorrect revisions as Backspace plus the replacement, the send key as Enter. Tapping elsewhere on the screen keeps the keyboard open; it closes on Back, or when the PC field loses focus. While the keyboard is open the monitor fills the area above it and the app navigation steps aside.

This depends on fcitx5 running on the PC. Without it, `/api/textinput` reports `available: false` and the keyboard does not rise; the Terminals page's text field remains the way to type.

### Dictation

The mic button records until you tap it again, sends the audio to the PC, and types the transcript into whatever field has focus there, then presses Enter. On Terminals, **Speak to terminal** does the same into the selected session, with a *Run with Enter* checkbox. Audio is transcribed and discarded. The server prefers the Sussurro IPC socket (`$XDG_RUNTIME_DIR/sussurro.sock`, faster-whisper on the GPU) and falls back to an OpenAI-compatible endpoint (`PONTE_STT_URL`, OmniVoice Studio's `/v1/audio/transcriptions` by default). `PONTE_STT_LANGUAGE` sets the language hint (default `pt`).

<p><img src="assets/screen-single-mode.png" width="24%" alt="Screen page in portrait"> <img src="assets/screen-keyboard.png" width="24%" alt="Screen page with the phone keyboard raised"> <img src="assets/screen-landscape.png" width="48%" alt="Forced landscape"></p>

These are Android 11 emulator captures with the streamed desktop pixelated. Browser checks cover tap-to-pixel mapping under zoom and pan, taps versus drags versus holds, keystroke forwarding (insert, delete, autocorrect replacement, Enter), monitor cycling, forced landscape release when leaving the page, and the continuous zoom never touching the stream. Backend tests cover `mouse.moveTo`, the text-input probe and the dictation routes.

## Work in a terminal

Install `tmux` on the PC, open Terminals and choose **New session**. Merely opening this page does not start a shell. Ponte manages up to four sessions using its own private tmux socket.

1. Type into the phone's text field and choose **Type text** to send it to the selected session.
2. Review it in the terminal output. Use the arrow keys and Backspace to edit the shell line.
3. Press **Enter** to execute. Ctrl+C interrupts the selected session's foreground command.

Or skip typing: **Speak to terminal** records, transcribes on the PC and types the result into this session, pressing Enter unless *Run with Enter* is unchecked.

<img src="assets/terminal-dictation.png" width="300" alt="Terminals page with Speak to terminal and Run with Enter">

The terminal starts at 40 columns for phone readability. Choose 80 or 120 columns for wider output and scroll sideways when needed. Pause output while selecting or reading text. Unsent phone drafts remain when you switch sessions or pages during this app visit; they are not saved across a WebView reload.

To use the same shell on the PC, expand **Open this same session on the PC** and run the displayed attachment command in a local terminal. Both devices then share the same session. Ponte does not run that attachment command or change your desktop focus for you.

The output view is plain text, updated while Terminals is visible. It includes recent history with a 64 KiB response limit. It is not a full browser terminal emulator: colors, terminal mouse input, interactive cursor rendering and arbitrary terminal escape sequences are not implemented. Commands and text interfaces can receive the listed keys, but full-screen editors are not this view's primary use.

Closing the phone app leaves sessions available. Stopping or restarting the Ponte service, logging out of Linux, or restarting the PC may end them. **Close session** asks for confirmation and terminates that session and its processes. If a PC client enters tmux copy mode, exit that mode on the PC before sending more input from the phone.

## Existing terminal windows

The bottom of Terminals lists terminal windows already open on the PC. **Focus and view on monitor** explicitly focuses that window and opens its monitor in Screen. It does not import its shell into Ponte's text sessions.

The phone keyboard on Screen types into the PC's currently focused window. Dedicated terminal input uses an exact session and pane, independent of desktop focus.

## Verification for this revision

The preview below uses a synthetic monitor with no personal desktop content. It is an actual capture of Ponte in its own Chromium test session. The terminal preview connects to a real tmux shell on a separate temporary socket.

<p><img src="assets/viewer-screen-preview.png" width="31%" alt="New Screen entry with direct live view"> <img src="assets/viewer-terminal-preview.png" width="31%" alt="Terminal output, text entry and explicit execution controls"></p>

![Landscape fullscreen viewer with a synthetic monitor](assets/viewer-landscape-preview.png)

Browser checks cover initial live entry, manual pause during polling, return to Screen, saved monitor/quality/pairing, native-size snapshot and pan, landscape fullscreen, real terminal input without implicit execution, resizing, language changes without losing drafts, explicit window focus, and closing the selected test session.

The backend suite covers private storage and socket ownership, exact targets, input validation, copy-mode races, interrupted creation cleanup, resource limits and HTTP authentication. Android proxy tests use real local synthetic HTTPS servers to check each terminal method/path, token forwarding, exact certificate pinning and request rejection. The personalized Android update compiles with the existing signing key.

The personalized alpha.2 update (Android version code5) was installed over the previous app on the physical Redmi with its existing signing key. Pairing survived, reopening went directly to live Screen, landscape fullscreen displayed the real monitor, and terminal text was observed before pressing Enter and then executing. The Android soft keyboard opened, but its complete layout and input flow were not verified before the phone returned to other use. Physical microphone recording is still pending.

Activity recreation exposed a loopback port-reuse failure during this test. A regression reproduced it before the fix; the updated proxy can immediately reopen its closed port while rejecting a second live listener. All 101 native proxy checks pass. Personal monitor captures remain private; the public previews above are synthetic.

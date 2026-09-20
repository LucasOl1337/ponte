# Manual test checklist (Redmi)

Test on the Redmi Note 13 Pro+ (Android 14) with Tailscale on and the PC awake. Follow the steps in order; each step says what to do, then what to expect.

## 1. Install the update

- Do: install the newest `.work/Ponte.apk` over the existing app (same signing key, do not uninstall).
- Expect: pairing is kept; the app opens without asking for the pairing key.

## 2. Open Screen

- Do: open Ponte and tap Screen.
- Expect: the PC monitor appears live and keeps updating while the page is visible.

## 3. Touch and zoom

- Do: tap a window's close button with normal finger wobble; at 1×, drag across desktop text and move a slider. Pinch into small text, pan with one finger while zoomed, then zoom back out. Scroll a page with two fingers together.
- Expect: the window closes from the tap, 1× dragging selects text and moves the slider like a held left mouse button, pinch stays smooth and centred under the fingers, one finger moves only the zoomed view, and two fingers scroll the PC when not pinching.

## 4. Move a window to another workspace

- Do: long-press a window's title bar, start moving, drag onto a workspace number in the shelf that appears, and lift. Repeat a normal drag and lift away from the shelf.
- Expect: the first window moves to that workspace without switching the current view. The second remains an ordinary PC drag. Long-pressing wallpaper and dropping on a workspace moves no previously focused window.

## 5. Tap a PC text field

- Do: tap a text field on the streamed PC screen, type a short phrase, press Enter, then tap a non-text target.
- Expect: the Android keyboard and thin typing bar rise automatically; text and Enter reach the focused PC field. Tapping away closes a bar opened automatically. The app requests no new Android permission.

## 6. Power card (one monitor only)

- Do: in PC Power, turn ONE monitor Off, then back On.
- Expect: only that screen goes dark and returns; feedback reads "Monitor turned off/on".

- Do: tap Smart sleep, wait, then tap Wake up.
- Expect: all monitors and RGB lights go off ("Smart sleep..."), then come back ("PC awake..."); the PC stays reachable over Tailscale throughout.

## 7. Terminals

- Do: open Terminals, start New session, Type text `echo ok`, then press Enter.
- Expect: the output shows `ok`; Ctrl+C interrupts; the same session can attach on the PC.

Done: note anything that differed and report it with the step number.

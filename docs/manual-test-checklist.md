# Manual test checklist (Redmi)

Test on the Redmi Note 13 Pro+ (Android 14) with Tailscale on and the PC awake. Follow the steps in order; each step says what to do, then what to expect.

## 1. Install the update

- Do: install the newest `.work/Ponte.apk` over the existing app (same signing key, do not uninstall).
- Expect: pairing is kept; the app opens without asking for the pairing key.

## 2. Open Screen

- Do: open Ponte and tap Screen.
- Expect: the PC monitor appears live and keeps updating while the page is visible.

## 3. Region zoom

- Do: pinch to zoom into small text, drag to read another area, then zoom back out.
- Expect: the zoomed crop stays sharp (captured at full resolution, not stretched); zooming out returns to the whole monitor.

## 4. Direct touch

- Do: switch to Direct touch, tap an icon, long-press for right click, drag with one finger, pinch with two.
- Expect: tap left-clicks at that pixel, long press right-clicks, one finger pans the image, two fingers pinch; the PC pointer moves only under Direct touch.

## 5. Power card (one monitor only)

- Do: in PC Power, turn ONE monitor Off, then back On.
- Expect: only that screen goes dark and returns; feedback reads "Monitor turned off/on".

- Do: tap Smart sleep, wait, then tap Wake up.
- Expect: all monitors and RGB lights go off ("Smart sleep..."), then come back ("PC awake..."); the PC stays reachable over Tailscale throughout.

## 6. Terminals

- Do: open Terminals, start New session, Type text `echo ok`, then press Enter.
- Expect: the output shows `ok`; Ctrl+C interrupts; the same session can attach on the PC.

Done: note anything that differed and report it with the step number.

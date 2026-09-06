# Asset credits

`assets/hero.png` is AI-generated concept art created with OpenAI image generation for this project. It is a decorative illustration and does not depict a functioning application screen.

The `app-en-*.png` images are unedited browser screenshots of the running English interface connected to a separate local review instance. That instance reads PC state but blocks desktop actions during review. These images are browser previews, not physical-device captures.

The `redmi-*.png` images are original device screenshots from the September 5, 2026 development session. The live monitor and fullscreen captures include a frame of the Lex Fridman interview with DHH, https://www.youtube.com/watch?v=NYFGCESmikA. That interview imagery remains the property of its respective rights holders and is outside the project's software license. Its use here documents the monitor stream and does not imply endorsement.

`screen-1to1-before.png` and `screen-direct-touch-before.png` are emulator captures (Android 11, `emulator-5554`) of the 1:1 letterboxing bug and Direct touch without a visible mode cue. `screen-1to1-after.png` and `screen-direct-touch-after.png` are matching shots on the same emulator after the fix, with a native-pixel 1:1 crop and Direct touch badge, help text and first-time toast.

Ponte's code and UI assets are MIT licensed. Android build tools, Amazon Corretto, system packages and their respective licenses remain with their publishers. Build scripts download those tools separately with pinned checksums.

## Cover generation

Mode: new image, no reference image, no editing of evidence screenshots.

Prompt:

> Use case: stylized-concept. Asset type: wide 16:9 hero artwork for Ponte, an open-source Android remote control for the Omarchy Linux desktop. Create a refined editorial 3D illustration, not a screenshot: an elegant thin curved bridge of luminous pale lime glass spans a quiet charcoal-black space, linking a small upright phone-shaped slab on one end with three restrained monitor-shaped slabs at the other. Their faces show only abstract soft light, no interface, no text. The bridge should feel architectural and physically grounded, with subtle shadows, matte graphite surfaces and a hint of finely grained paper. Place the scene in the right two thirds so the left third is calm dark negative space for a real wordmark added elsewhere. Camera is an elevated three-quarter perspective, composition broad and spacious, premium industrial design with clear silhouette and no clutter. Palette tied to existing Ponte app: almost black #151714, muted olive, warm off-white, luminous lime #D5F888. No blue or purple, no cyberpunk skyline, no glowing network web, no people, no company logos, no words, no badges. This is openly illustrative cover art, not evidence of an application screen.

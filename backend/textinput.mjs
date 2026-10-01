// fcitx5 DebugInfo parsing and the "did this tap focus a text field" decision.
//
// fcitx5 owns the compositor's input-method seat. DebugInfo lists every input
// context (IC) per frontend group, each with a stable id, the owning program,
// its capability flags (hex) and focus:0/1. A window that keeps a text area
// focused internally (Electron apps such as Maestri keep the terminal's hidden
// textarea focused; foot keeps its IC focused while the window is active)
// reports focus:1 for as long as the window is active, whatever was tapped.
// So "some IC is focused" says nothing about the tap; the transition does.

// fcitx5 CapabilityFlag bits (fcitx-utils/capabilityflags.h, fcitx5 5.1).
// Disable/NoOnScreenKeyboard mean "not a field to type into" (quickshell's
// launcher IC reports Disable while focused).
const CAP_PASSWORD = 1n << 3n;
const CAP_NO_ON_SCREEN_KEYBOARD = 1n << 15n;
const CAP_SENSITIVE = 1n << 36n;
const CAP_DISABLE = 1n << 40n;

function parseCap(text) {
  if (typeof text !== 'string' || !/^[0-9a-f]{1,16}$/iu.test(text)) return null;
  try { return BigInt(`0x${text}`); } catch { return null; }
}

export function parseFcitxDebugInfo(raw) {
  const contexts = [];
  let group = '';
  for (const line of String(raw || '').replace(/\\n/gu, '\n').split('\n')) {
    const header = line.match(/Group \[([^\]]*)\]/u);
    if (header) { group = header[1]; continue; }
    if (/Input Context without group/u.test(line)) { group = ''; continue; }
    const ic = line.match(/IC \[([^\]]+)\]\s+program:(\S*)\s+frontend:(\S+)\s+cap:([0-9a-fA-F]+)\s+focus:([01])\b/u);
    if (!ic) continue;
    const cap = parseCap(ic[4]);
    contexts.push({ id: ic[1], program: ic[2], frontend: ic[3], group, cap: ic[4], focus: ic[5] === '1', capValue: cap });
  }
  return { contexts };
}

// The focused IC that could take typing, or null. A focused IC flagged Disable
// or NoOnScreenKeyboard is not a field the phone keyboard should open for.
export function focusedContext(parsed) {
  for (const ic of parsed?.contexts || []) {
    if (!ic.focus) continue;
    const cap = ic.capValue;
    const disabled = cap != null && ((cap & CAP_DISABLE) !== 0n || (cap & CAP_NO_ON_SCREEN_KEYBOARD) !== 0n);
    return { id: ic.id, program: ic.program, cap: ic.cap, typeable: !disabled, password: cap != null && ((cap & (CAP_PASSWORD | CAP_SENSITIVE)) !== 0n) };
  }
  return null;
}

// Public shape of /api/textinput. `focused` keeps its old meaning (some typeable
// IC has focus) so older phone UIs still work; `context` lets a newer UI compare
// the IC before and after its tap.
export function textInputState(raw) {
  const ic = focusedContext(parseFcitxDebugInfo(raw));
  return { available: true, focused: Boolean(ic && ic.typeable), context: ic ? { id: ic.id, program: ic.program, cap: ic.cap, typeable: ic.typeable } : null };
}

// Decide whether a tap should raise the phone keyboard. `before` is the focused
// IC sampled right before the click (null = none, undefined = unknown), `after`
// the one sampled now. Only a tap that *caused* focus counts: none -> some, or
// a different IC than before. The same IC that was already focused (terminal,
// Maestri canvas, a browser field focused elsewhere) is not a reason to open.
// The IC id is per window (Chromium, Electron), so a different cap on the same
// id is a different kind of field (address bar -> page field) and counts too.
export function tapFocusedText(before, after) {
  if (!after || after.typeable === false) return false;
  if (before === undefined) return false; // no baseline: never guess
  if (!before) return true;
  return before.id !== after.id || before.cap !== after.cap;
}

// Rate control of a remote-desktop session over an internet link (Modo WAN).
// A new encoder run is the only way to change what gpu-screen-recorder makes,
// and each one leaves ~450 ms without a picture plus a keyframe burst, so the
// encoder moves on a short ladder of steps (Degraus) and restarts are rationed:
// down at once and in one go when the link's queue grows, up one step at a
// time after a long calm, with a growing wait for a step that failed.
//
// Signals: the round trip of the client's own pings (the pong waits behind the
// video in the same queue, so rtt − its floor is the queue, on one clock) and
// the p95 of its send → arrival latencies, from the stats every page sends once
// a second; the kbps it received is what the link delivers.
// A LAN answers in 1-10 ms; the notebook away from home was 22-28 ms at best.
export const LAN_RTT_MS = 15;
// fps falls before the width: reading text matters more than motion.
export const WAN_STEPS = [
  { fps: 15, kbps: 600, width: 1280 },
  { fps: 15, kbps: 1000, width: 1920 },
  { fps: 20, kbps: 1600, width: 1920 },
  { fps: 30, kbps: 2500, width: 1920 },
  { fps: 30, kbps: 4000, width: null },
  { fps: 30, kbps: 6000, width: null },
];
export const INITIAL_STEP = 3;
// Keyframe interval (s) outside the LAN. TCP loses nothing, so a keyframe is
// only needed after a restart or when the client asks; the periodic one is a
// safety net. A page that cannot ask gets it more often.
export const WAN_KEYINT = { asks: 300, silent: 60 };

const QUEUE_BAD_MS = 150, QUEUE_CALM_MS = 50, QUEUE_EMERGENCY_MS = 1000, QUEUE_SHED_MS = 500;
const BASE_WINDOW_MS = 5 * 60000;
const SETTLE_MS = 3000;          // after a restart: reports may still carry the old queue
const P95_WINDOW_MS = 5000;      // the page's latency window
const UP_CALM_MS = 30000, UP_EVERY_MS = 60000, DOWN_QUIET_MS = 60000;
const FAILED_UP_MS = 20000, BACKOFF_MAX_MS = 8 * 60000, BACKOFF_RESET_MS = 10 * 60000;
const KEY_COALESCE_MS = 2000, IMPLICIT_KEY_GRACE_MS = 3000, KEYS_PER_MINUTE = 3;

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

// The -s box for a width limit: the monitor's aspect, even sizes, null when
// the monitor already fits.
export function scaleBox(monitor, maxWidth) {
  if (!maxWidth || !monitor?.width || monitor.width <= maxWidth) return null;
  const width = Math.floor(maxWidth / 2) * 2;
  return { width, height: Math.max(2, Math.round(monitor.height * width / monitor.width / 2) * 2) };
}

// caps: what the page's hello announced ({ key }); view: its stage in device
// pixels. Every method returns null or a decision { reason, params } that the
// session applies with one encoder restart ('shed' instead means: stop sending
// until the queue drains). params() is null in the LAN, where the session's
// own adaptation keeps the encoder as before.
export function createRateControl({ maxFps = 60, caps = {}, view = null, now = () => performance.now() } = {}) {
  let mode = 'lan', step = INITIAL_STEP, shedding = false;
  let openedAt = now(), openRtt = null;
  let lastRestartAt = -Infinity, lastDownAt = -Infinity, lastUpAt = -Infinity, upTo = null, atStepSince = now();
  let lastUncalmAt = now(), lastReportAt = -Infinity, badStreak = 0;
  let lastKey = null;
  const rtts = [], p95s = [], delivered = [], keyRestarts = [];
  const backoff = new Map(); // step → { failures, retryAt }

  const widthLimit = () => {
    const limits = [WAN_STEPS[step].width, finite(view?.width)].filter(Boolean);
    return limits.length ? Math.min(...limits) : null;
  };
  const params = () => mode === 'lan' ? null : {
    fps: Math.min(maxFps, WAN_STEPS[step].fps), kbps: WAN_STEPS[step].kbps,
    keyint: caps.key ? WAN_KEYINT.asks : WAN_KEYINT.silent, maxWidth: widthLimit(),
  };
  const deliveredKbps = () => delivered.length ? delivered.reduce((sum, value) => sum + value, 0) / delivered.length : null;
  // The highest step that 80% of the delivered rate carries, below the current one.
  const fitting = (below = step) => {
    const rate = deliveredKbps();
    const fit = rate === null ? below - 1 : WAN_STEPS.findLastIndex(s => s.kbps <= 0.8 * rate);
    return Math.max(0, Math.min(below - 1, fit));
  };
  const floor = (samples, t) => {
    while (samples.length && samples[0].at < t - BASE_WINDOW_MS) samples.shift();
    const values = samples.map(s => s.value);
    if (openRtt !== null && t - openedAt < BASE_WINDOW_MS && samples === rtts) values.push(openRtt);
    return values.length ? Math.min(...values) : null;
  };
  // A keyframe takes bytes ÷ rate to cross the link: the queue it makes then is expected.
  const keyframeExcuse = t => {
    if (!lastKey) return false;
    const rate = deliveredKbps() || WAN_STEPS[step].kbps;
    return t - lastKey.at < lastKey.bytes * 8 / Math.max(300, rate) + 1000;
  };

  function fail(target, t) {
    const entry = backoff.get(target) || { failures: 0, retryAt: 0 };
    entry.failures++;
    entry.retryAt = t + Math.min(BACKOFF_MAX_MS, UP_EVERY_MS * 2 ** entry.failures);
    backoff.set(target, entry);
  }

  function change(reason, next) {
    const t = now();
    if (reason === 'down' && upTo !== null && step === upTo && t - lastUpAt <= FAILED_UP_MS) fail(upTo, t);
    if (reason === 'down' || reason === 'wan') lastDownAt = t;
    if (reason === 'up') { lastUpAt = t; upTo = next; }
    if (reason === 'key') keyRestarts.push(t);
    if (next !== step || reason === 'wan') atStepSince = t;
    step = next; lastRestartAt = t; badStreak = 0; shedding = false; lastUncalmAt = t;
    return { reason, params: params() };
  }

  function keyRequest() {
    if (mode !== 'wan') return null;
    const t = now();
    if (t - lastRestartAt < KEY_COALESCE_MS) return null;
    while (keyRestarts.length && keyRestarts[0] < t - 60000) keyRestarts.shift();
    // Keyframes asked for again and again: the page cannot keep up with this step.
    if (keyRestarts.length >= KEYS_PER_MINUTE && step > 0) return change('down', step - 1);
    return change('key', step);
  }

  return {
    get mode() { return mode; },
    get step() { return step; },
    get shedding() { return shedding; },
    params,
    // The round trip measured before the first frame, on an empty queue.
    open(rtt) {
      const t = now();
      openedAt = t; openRtt = finite(rtt); lastUncalmAt = t; lastRestartAt = t; atStepSince = t;
      mode = openRtt !== null && openRtt < LAN_RTT_MS ? 'lan' : 'wan';
      step = INITIAL_STEP;
      return params();
    },
    // Every unit that left, so keyframe bursts are known.
    sent(bytes, keyframe) { if (keyframe) lastKey = { at: now(), bytes }; },
    stats(report = {}) {
      const t = now();
      lastReportAt = t;
      const kbps = finite(report.kbps);
      if (kbps !== null && kbps > 0) { delivered.push(kbps); if (delivered.length > 3) delivered.shift(); }
      const rtt = finite(report.rtt), p95 = finite(report.p95);
      if (rtt !== null && rtt >= 0) rtts.push({ at: t, value: rtt });
      if (p95 !== null) p95s.push({ at: t, value: p95 });
      const rttBase = floor(rtts, t), p95Base = floor(p95s, t);
      const rttQueue = rtt !== null && rttBase !== null ? rtt - rttBase : null;
      // The p95 covers the page's last 5 s: it still holds a restart or a keyframe burst for that long.
      const p95Fresh = t - lastRestartAt > P95_WINDOW_MS && !(lastKey && t - lastKey.at < P95_WINDOW_MS + 1000);
      const p95Queue = p95Fresh && p95 !== null && p95Base !== null ? p95 - p95Base : null;
      const excused = keyframeExcuse(t);
      const bad = !excused && ((rttQueue ?? 0) > QUEUE_BAD_MS || (p95Queue ?? 0) > QUEUE_BAD_MS);
      badStreak = bad ? badStreak + 1 : 0;
      if (rttQueue === null || rttQueue >= QUEUE_CALM_MS || bad) lastUncalmAt = t;

      if (mode === 'lan') {
        const recent = rtts.filter(s => s.at > t - 5000);
        const far = recent.length >= 4 && recent.every(s => s.value > LAN_RTT_MS);
        if (!far && badStreak < 2) return null;
        mode = 'wan';
        return change('wan', Math.min(INITIAL_STEP, fitting(WAN_STEPS.length)));
      }
      // A page that cannot ask for a keyframe drops deltas and says so in its stats.
      if (!caps.key && Number(report.drops) > 0 && t - lastRestartAt > IMPLICIT_KEY_GRACE_MS) return keyRequest();
      const queue = Math.max(rttQueue ?? 0, p95Queue ?? 0);
      const emergency = !excused && queue > QUEUE_EMERGENCY_MS;
      if (t - lastRestartAt < SETTLE_MS && !emergency) return null;
      if (step === 0) {
        // Even the floor is too much: stop feeding the queue, and start again
        // with a keyframe once it has drained.
        if (!shedding && (emergency || (badStreak >= 2 && queue > QUEUE_SHED_MS))) { shedding = true; return { reason: 'shed', params: params() }; }
        if (shedding && rttQueue !== null && rttQueue < QUEUE_BAD_MS) return change('key', 0);
        return null;
      }
      if (emergency || badStreak >= 2) return change('down', fitting());
      return null;
    },
    // Called about once a second.
    tick() {
      if (mode !== 'wan' || shedding) return null;
      const t = now();
      for (const [target] of backoff) if (step === target - 1 && t - atStepSince >= BACKOFF_RESET_MS) backoff.delete(target);
      if (step >= WAN_STEPS.length - 1 || t - lastReportAt > 2500) return null;
      if (t - lastUncalmAt < UP_CALM_MS || t - lastRestartAt < UP_CALM_MS) return null;
      if (t - lastDownAt < DOWN_QUIET_MS || t - lastUpAt < UP_EVERY_MS) return null;
      const target = step + 1;
      if ((backoff.get(target)?.retryAt ?? 0) > t) return null;
      return change('up', target);
    },
    key: keyRequest,
    // The session dropped a delta because its own buffer is over the ceiling.
    drop() {
      if (mode !== 'wan' || now() - lastRestartAt < KEY_COALESCE_MS) return null;
      return step > 0 ? change('down', fitting()) : change('key', 0);
    },
  };
}

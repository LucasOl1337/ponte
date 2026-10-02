// Rate control of a remote-desktop session over an internet link (Modo WAN).
// A new encoder run is the only way to change what gpu-screen-recorder makes,
// and each one leaves ~450 ms without a picture plus a keyframe burst, so the
// encoder moves on a short ladder of steps (Degraus) and restarts are rationed:
// down at once and in one go when the link's queue grows, up one step at a
// time after a long calm, with a growing wait for a step that failed.
//
// Signals. A page that acks (hello caps.ack) says which frame arrived last, at
// most every 50 ms: on the server's own clock, the age of that frame minus the
// smallest age in 10 s is the queue, the acked bytes are what the link
// delivers, and the unacked ones are in flight. A keyframe burst crossing the
// link also measures its capacity, which lets a climb skip steps. An older page
// only has its stats, once a second: the round trip of its own pings (the pong
// waits behind the video, so rtt − its floor is the queue) and the p95 of its
// send → arrival latencies; the kbps it received is what the link delivers.
// A LAN answers in 1-10 ms; the notebook away from home was 22-28 ms at best.
export const LAN_RTT_MS = 15;
// fps falls before the width: reading text matters more than motion.
//
// `width` is a ceiling in pixels and `floor` the least of the monitor that may
// survive it. A fixed ceiling alone breaks that promise on a wide screen: 1920
// of a 3440 px monitor is 56% of the picture, and text at 56% is mush however
// many frames per second arrive. The step's limit is therefore the larger of
// the two, so a 1080p monitor sees the ceilings it always saw and a wide one
// keeps enough pixels to be read.
export const WAN_STEPS = [
  { fps: 15, kbps: 600, width: 1280, floor: 0.5 },
  { fps: 15, kbps: 1000, width: 1920, floor: 0.75 },
  { fps: 20, kbps: 1600, width: 1920, floor: 1 },
  { fps: 30, kbps: 2500, width: 1920, floor: 1 },
  { fps: 30, kbps: 4000, width: null, floor: 1 },
  { fps: 30, kbps: 6000, width: null, floor: 1 },
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
const KEY_COALESCE_MS = 2000, IMPLICIT_KEY_GRACE_MS = 2000, KEYS_PER_MINUTE = 3;
// Acks.
const ACK_WINDOW_MS = 10000, ACK_HISTORY_MAX = 4096, DELIVERED_WINDOW_MS = 2000;
// A queue counts as draining only when it fell by more than the spread of one
// burst of frames arriving together (the ack names the youngest).
const BAD_SUSTAIN_MS = 500, DRAINING_MS = 75, IN_FLIGHT_EMERGENCY_MS = 1000;
const SAMPLE_FRESH_MS = 2 * 60000, SAMPLE_HEADROOM = 1.25, SAMPLE_CLEARS_BACKOFF = 1.5, SAMPLE_MIN_BYTES = 20000, SAMPLE_MIN_MS = 50;
// Opening. W3 is 1920 px: on a 3440 monitor the text a phone zooms into is as
// soft as its Balanced JPEG, and a home Tailscale link (over 15 ms, plenty of
// room) waited 30 s of calm before the first climb. In the first 20 s of a run
// on the steps, before any fall, a keyframe that crossed with twice the room a
// higher step needs, 2 s without a queue, climbs there at once.
const OPEN_WINDOW_MS = 20000, OPEN_CALM_MS = 2000, OPEN_HEADROOM = 2;
// After a fall, calm only proves the current step fits. Its old keyframe
// cannot tell whether the link recovered. Refresh it within the same restart
// budget before climbing, and require the same headroom as the fast opening.
const RECOVERY_SAMPLE_MS = SAMPLE_FRESH_MS;
const PROBE_BACKOFF_MAX_MS = 10 * 60000;

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
export function createRateControl({ maxFps = 60, caps = {}, view = null, screen = null, now = () => performance.now() } = {}) {
  let mode = 'lan', step = INITIAL_STEP, shedding = false;
  let openedAt = now(), openRtt = null;
  let lastRestartAt = -Infinity, lastDownAt = -Infinity, lastUpAt = -Infinity, upTo = null, atStepSince = now();
  let lastUncalmAt = now(), uncalmSince = null, lastReportAt = -Infinity, badStreak = 0;
  let lastKey = null, opening = false;
  let probeAt = null, probeFailures = 0, probeRetryAt = -Infinity;
  let stage = view, screenWidth = finite(screen);
  const rtts = [], p95s = [], delivered = [], keyRestarts = [];
  const backoff = new Map(); // step → { failures, retryAt }
  // Ack path: frames sent and not acked yet, ages of the acked ones, acked bytes.
  let acking = false, firstAckAt = null, sentSeq = 0, ackedSeq = 0, keySeq = 0, badSince = null, farSince = null, judgeFrom = now(), sample = null;
  const inFlight = [], ages = [], acked = [];

  // The step's own limit, never below what the monitor needs to stay readable.
  // The page's stage still caps it: showing a 3440 px picture in a 1500 px
  // window costs bytes nobody can see.
  const stepWidth = () => {
    const { width, floor } = WAN_STEPS[step];
    if (!screenWidth) return width;
    const readable = Math.ceil(screenWidth * floor);
    return width ? Math.max(width, readable) : null;
  };
  const widthLimit = () => {
    const limits = [stepWidth(), finite(stage?.width)].filter(Boolean);
    return limits.length ? Math.min(...limits) : null;
  };
  const params = () => mode === 'lan' ? null : {
    fps: Math.min(maxFps, WAN_STEPS[step].fps), kbps: WAN_STEPS[step].kbps,
    keyint: caps.key ? WAN_KEYINT.asks : WAN_KEYINT.silent, maxWidth: widthLimit(),
  };
  // With a queue standing since `since`, the link was busy all along: what
  // it delivered from then on is its capacity, not what the encoder made.
  const deliveredKbps = (since = null) => {
    if (!acking) return delivered.length ? delivered.reduce((sum, value) => sum + value, 0) / delivered.length : null;
    const t = now();
    while (acked.length && acked[0].at < t - DELIVERED_WINDOW_MS) acked.shift();
    const from = since !== null && t - since >= 300 ? Math.max(since, t - DELIVERED_WINDOW_MS) : Math.max(firstAckAt, t - DELIVERED_WINDOW_MS);
    if (t - from < 300) return null;
    return acked.reduce((sum, item) => sum + (item.at > from ? item.bytes : 0), 0) * 8 / (t - from);
  };
  // The highest step that 80% of the link's capacity carries, below the current
  // one. What was delivered is the capacity only while a queue stood (since):
  // otherwise it is what the encoder made, a few hundred kbps on a still
  // desktop, and trusting it sent a single fall to the floor for good. Without
  // a standing queue a fresh keyframe burst measures it, or it is one step.
  const fitting = (below = step, since = null) => {
    const fresh = sample && now() - sample.at <= SAMPLE_FRESH_MS ? sample.kbps : null;
    const rate = since !== null ? deliveredKbps(since) : fresh;
    const fit = rate === null ? below - 1 : WAN_STEPS.findLastIndex(s => s.kbps <= 0.8 * rate);
    return Math.max(0, Math.min(below - 1, fit));
  };
  const floor = (samples, t) => {
    while (samples.length && samples[0].at < t - BASE_WINDOW_MS) samples.shift();
    const values = samples.map(s => s.value);
    if (openRtt !== null && t - openedAt < BASE_WINDOW_MS && samples === rtts) values.push(openRtt);
    return values.length ? Math.min(...values) : null;
  };
  // A keyframe takes bytes ÷ rate to cross the link: the queue it makes then
  // is expected, plus the time the signal takes to show it.
  const keyframeTime = () => lastKey ? lastKey.bytes * 8 / Math.max(300, deliveredKbps() || WAN_STEPS[step].kbps) : 0;
  const keyframeExcuse = (t, lag = 1000) => !!lastKey && t - lastKey.at < keyframeTime() + lag;
  const ackBase = () => ages.length ? Math.min(...ages.map(item => item.value)) : (openRtt ?? 0);

  function fail(target, t) {
    const entry = backoff.get(target) || { failures: 0, retryAt: 0 };
    entry.failures++;
    entry.retryAt = t + Math.min(BACKOFF_MAX_MS, UP_EVERY_MS * 2 ** entry.failures);
    backoff.set(target, entry);
  }

  function change(reason, next) {
    const t = now();
    if (reason === 'up' || reason === 'down') { probeAt = null; probeFailures = 0; probeRetryAt = -Infinity; }
    if (reason === 'probe') probeAt = t;
    if (reason === 'down' && upTo !== null && step === upTo && t - lastUpAt <= FAILED_UP_MS) fail(upTo, t);
    if (reason === 'down' || reason === 'wan') lastDownAt = t;
    if (reason === 'down') opening = false;
    if (reason === 'up') { lastUpAt = t; upTo = next; }
    if (reason === 'key') keyRestarts.push(t);
    if (next !== step || reason === 'wan') atStepSince = t;
    step = next; lastRestartAt = t; badStreak = 0; shedding = false; lastUncalmAt = t;
    // Frames of the old run still queued say nothing about the new one, nor
    // do the ones sent behind them: judge again once they have drained.
    badSince = null; uncalmSince = null; judgeFrom = inFlight.length ? Infinity : t;
    return { reason, params: params() };
  }

  // Too much queued (or in flight for too long): a step down at once, all
  // the way to what the link delivers; on the floor, stop sending instead.
  function congested(queue, emergency) {
    if (step > 0) return change('down', fitting(step, badSince?.at ?? null));
    if (!shedding && (emergency || queue > QUEUE_SHED_MS)) { shedding = true; opening = false; return { reason: 'shed', params: params() }; }
    return null;
  }

  // Over 150 ms for half a second and not shrinking from its peak: a queue
  // that drains means the step already fits (a burst or the step before left
  // it behind).
  function queued(queue, t) {
    if (queue <= QUEUE_BAD_MS) { badSince = null; return false; }
    if (!badSince) { badSince = { at: t, peak: queue }; return false; }
    if (queue < badSince.peak - DRAINING_MS) { badSince = { at: t, peak: queue }; return false; }
    badSince.peak = Math.max(badSince.peak, queue);
    return t - badSince.at >= BAD_SUSTAIN_MS;
  }

  function drained(t) {
    if (judgeFrom === Infinity && !inFlight.some(frame => frame.at < lastRestartAt)) judgeFrom = t;
  }

  // In flight for over a second (beyond a keyframe's own time), or more than
  // a second of the step's bytes: the link stalled or shrank a lot.
  function emergency(t) {
    if (!acking || mode !== 'wan' || shedding || !inFlight.length) return null;
    const oldest = inFlight[0], base = ackBase();
    const late = t - oldest.at - base - (lastKey && lastKey.at >= lastRestartAt ? keyframeTime() : 0);
    // An old run's frames get a settling time to drain before they count.
    if (oldest.at < lastRestartAt && t - lastRestartAt < SETTLE_MS) return null;
    let bytes = 0;
    for (const frame of inFlight) if (frame.at >= lastRestartAt) bytes += frame.bytes;
    const allowance = WAN_STEPS[step].kbps * 125 + (lastKey && lastKey.at >= lastRestartAt ? lastKey.bytes : 0);
    if (late > IN_FLIGHT_EMERGENCY_MS || bytes > allowance) return congested(late, true);
    return null;
  }

  // The last restart's keyframe reached the page: it acked it, or (a page
  // that does not ack) it left long enough ago to have crossed the link.
  const keyLanded = t => !!lastKey && lastKey.at >= lastRestartAt
    && (acking ? keySeq > 0 && ackedSeq >= keySeq : t - lastKey.at > keyframeTime() + 500);

  function keyRequest() {
    if (mode !== 'wan') return null;
    const t = now();
    // Merged into the last restart while its keyframe may still be on the way.
    if (t - lastRestartAt < KEY_COALESCE_MS && !keyLanded(t)) return null;
    while (keyRestarts.length && keyRestarts[0] < t - 60000) keyRestarts.shift();
    // Keyframes asked for again and again: the page cannot keep up with this step.
    if (keyRestarts.length >= KEYS_PER_MINUTE && step > 0) return change('down', step - 1);
    return change('key', step);
  }

  return {
    get mode() { return mode; },
    get step() { return step; },
    get shedding() { return shedding; },
    get acking() { return acking; },
    params,
    // The round trip measured before the first frame, on an empty queue.
    open(rtt) {
      const t = now();
      openedAt = t; openRtt = finite(rtt); lastUncalmAt = t; lastRestartAt = t; atStepSince = t;
      mode = openRtt !== null && openRtt < LAN_RTT_MS ? 'lan' : 'wan';
      step = INITIAL_STEP; opening = mode === 'wan';
      return params();
    },
    // Every unit that left (seq as in its header), so keyframe bursts are
    // known and acks can be matched.
    sent(bytes, keyframe, seq) {
      const t = now();
      if (keyframe) lastKey = { at: t, bytes };
      if (!caps.ack || !Number.isInteger(seq) || seq <= sentSeq) return null;
      sentSeq = seq;
      if (keyframe) keySeq = seq;
      inFlight.push({ seq, at: t, bytes, keyframe });
      // Never acked within 10 s: the page stopped acking; forget them.
      while (inFlight.length > ACK_HISTORY_MAX || (inFlight.length && inFlight[0].at < t - ACK_WINDOW_MS)) inFlight.shift();
      drained(t);
      return emergency(t);
    },
    // The page received every frame up to `seq`.
    ack(seq) {
      if (!caps.ack || !Number.isInteger(seq) || seq <= ackedSeq || seq > sentSeq || !inFlight.length) return null;
      const index = seq - inFlight[0].seq;
      if (index < 0 || index >= inFlight.length || inFlight[index].seq !== seq) return null;
      const t = now();
      if (!acking) { acking = true; firstAckAt = t; }
      ackedSeq = seq; lastReportAt = t;
      const arrived = inFlight.splice(0, index + 1);
      for (const frame of arrived) acked.push({ at: t, bytes: frame.bytes });
      const frame = arrived.at(-1), age = t - frame.at;
      while (ages.length && (ages[0].at < t - ACK_WINDOW_MS || ages.length >= 1000)) ages.shift();
      // The round trip the burst is measured against excludes its own age: on
      // the first ack of a session that age was the base, the crossing came
      // out as nothing and a 2.7 Mbps link measured 17.6.
      const before = ackBase();
      ages.push({ at: t, value: age });
      const base = ackBase(), queue = age - base;
      // A keyframe that crossed the link in one burst measured its capacity.
      const burst = arrived.find(item => item.keyframe && item.bytes >= SAMPLE_MIN_BYTES);
      if (burst) {
        sample = { at: t, sentAt: burst.at, kbps: burst.bytes * 8 / Math.max(SAMPLE_MIN_MS, t - burst.at - before) };
        // No extra pauses every two minutes on a link that has not improved.
        // Count each probe only once, when its measured keyframe lands. A
        // useful sample keeps the existing recovery timing untouched.
        if (probeAt !== null && burst.at >= probeAt) {
          const next = WAN_STEPS[step + 1];
          if (next && sample.kbps < OPEN_HEADROOM * next.kbps) {
            probeFailures++;
            probeRetryAt = t + Math.min(PROBE_BACKOFF_MAX_MS, RECOVERY_SAMPLE_MS * 2 ** (probeFailures - 1));
          }
          probeAt = null;
        }
        for (const [target] of backoff) if (sample.kbps >= SAMPLE_CLEARS_BACKOFF * WAN_STEPS[target].kbps) backoff.delete(target);
      }
      drained(t);
      if (mode === 'lan') {
        // Far (the smallest age stays over the LAN round trip) or queued.
        farSince = base > LAN_RTT_MS ? farSince ?? t : null;
        const piling = frame.at >= judgeFrom && !keyframeExcuse(t, 100) && queued(queue, t);
        if ((farSince === null || t - farSince < 5000) && !piling) return null;
        mode = 'wan';
        // Only far, not queued: the link carried the LAN rate, so it may open fast too.
        opening = !piling;
        return change('wan', Math.min(INITIAL_STEP, fitting(WAN_STEPS.length, piling ? badSince.at : null)));
      }
      if (shedding) return queue < QUEUE_BAD_MS || !inFlight.length ? change('key', 0) : null;
      if (frame.at < judgeFrom) { lastUncalmAt = t; return null; }
      if (keyframeExcuse(t, 100)) return null;
      // Acks wait up to 50 ms on the page. Isolated phase/jitter spikes are
      // not a standing queue and must not restart the whole 30 s calm.
      if (queue >= QUEUE_CALM_MS) {
        uncalmSince ??= t;
        if (queue > QUEUE_BAD_MS || t - uncalmSince >= BAD_SUSTAIN_MS) lastUncalmAt = t;
      } else uncalmSince = null;
      if (queue > QUEUE_EMERGENCY_MS || queued(queue, t)) return congested(queue, queue > QUEUE_EMERGENCY_MS);
      return emergency(t);
    },
    stats(report = {}) {
      // A page that acks already said all of this, sooner.
      if (acking) return null;
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
        return change('wan', Math.min(INITIAL_STEP, fitting(WAN_STEPS.length, badStreak >= 2 ? t : null)));
      }
      // A page that cannot ask for a keyframe drops deltas and says so in its stats.
      if (!caps.key && Number(report.drops) > 0 && (t - lastRestartAt > IMPLICIT_KEY_GRACE_MS || keyLanded(t))) return keyRequest();
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
      // Two reports with a queue: what the page received meanwhile was the link's capacity.
      if (emergency || badStreak >= 2) return change('down', fitting(step, t));
      return null;
    },
    // Called about once a second.
    tick() {
      const t = now();
      if (mode === 'wan' && shedding && acking && !inFlight.length) return change('key', 0);
      if (mode !== 'wan' || shedding) return null;
      const stalled = emergency(t);
      if (stalled) return stalled;
      for (const [target] of backoff) if (step === target - 1 && t - atStepSince >= BACKOFF_RESET_MS) backoff.delete(target);
      if (step >= WAN_STEPS.length - 1 || t - lastReportAt > 2500) return null;
      if (opening && t - atStepSince > OPEN_WINDOW_MS) opening = false;
      if (opening && sample && sample.at >= lastRestartAt && t - lastRestartAt >= SETTLE_MS && t - lastUncalmAt >= OPEN_CALM_MS) {
        let target = WAN_STEPS.findLastIndex(s => s.kbps <= sample.kbps / OPEN_HEADROOM);
        while (target > step && (backoff.get(target)?.retryAt ?? 0) > t) target--;
        if (target > step) { opening = false; return change('up', target); }
      }
      if (t - lastUncalmAt < UP_CALM_MS || t - lastRestartAt < UP_CALM_MS) return null;
      if (t - lastDownAt < DOWN_QUIET_MS || t - lastUpAt < UP_EVERY_MS) return null;
      if (acking && lastDownAt > -Infinity) {
        if (uncalmSince !== null || t - lastRestartAt < UP_EVERY_MS) return null;
        // A still terminal can make a keyframe below the sampling threshold.
        // Once that fresh key landed, retain the ADR's one-step trial instead
        // of probing the same unmeasurable picture forever. No jump, and the
        // failed-step backoff still applies.
        if (lastKey && lastKey.bytes < SAMPLE_MIN_BYTES && keyLanded(t)
          && lastKey.at >= lastDownAt + DOWN_QUIET_MS && t - lastKey.at <= RECOVERY_SAMPLE_MS) {
          const target = step + 1;
          return (backoff.get(target)?.retryAt ?? 0) <= t ? change('up', target) : null;
        }
        // One same-step keyframe, never more than once a minute. Unlike a
        // blind climb it measures room without increasing the delta rate.
        if (!sample || sample.sentAt < lastDownAt + DOWN_QUIET_MS || t - sample.at > RECOVERY_SAMPLE_MS) {
          if (t < probeRetryAt) return null;
          return change('probe', step);
        }
        let target = WAN_STEPS.findLastIndex(s => s.kbps <= sample.kbps / OPEN_HEADROOM);
        while (target > step && (backoff.get(target)?.retryAt ?? 0) > t) target--;
        return target > step ? change('up', target) : null;
      }
      // A fresh capacity sample may skip steps; a step that failed waits its backoff.
      const fit = sample && t - sample.at <= SAMPLE_FRESH_MS ? WAN_STEPS.findLastIndex(s => s.kbps <= sample.kbps / SAMPLE_HEADROOM) : -1;
      let target = Math.max(step + 1, fit);
      while (target > step && (backoff.get(target)?.retryAt ?? 0) > t) target--;
      if (target <= step) return null;
      return change('up', target);
    },
    key: keyRequest,
    // The page's stage changed size: a new width limit is a new run.
    view(next) {
      const before = widthLimit();
      stage = next;
      if (mode !== 'wan' || widthLimit() === before) return null;
      return change('view', step);
    },
    // Which monitor is being shown: its width sets the readable floor. The
    // session restarts the encoder for the switch anyway, so this never asks
    // for one of its own.
    screen(width) { screenWidth = finite(width); },
    // The session dropped a delta because its own buffer is over the ceiling.
    drop() {
      if (mode !== 'wan' || now() - lastRestartAt < KEY_COALESCE_MS) return null;
      // Over a second buffered here: the link is busy, what it delivers is its capacity.
      return step > 0 ? change('down', fitting(step, now())) : change('key', 0);
    },
  };
}

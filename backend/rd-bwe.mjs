// Google's delay-gradient congestion control: the estimator, not the transport.
//
// A WebRTC link measures capacity without ever filling it, by watching the
// gradient of the one-way delay. Frames leave at T(i) and arrive at t(i). While
// the link keeps up, (t(i) - t(i-1)) - (T(i) - T(i-1)) hovers around zero
// however fast we send. The moment we ask for more than it carries, a queue
// starts building and that difference turns positive, long before a byte is
// lost or the queue grows big enough to see. The rising trend is the signal.
//
// This is what the ladder was missing, and it already had the data: the video
// header carries the send time and the ack carries the arrival. It just read
// the delay as a threshold (over 150 ms for half a second is a queue, under 50
// ms is calm). A threshold can only say that we already went too far, never
// that there is room, so climbing was a stopwatch: 30 s of calm, one step a
// minute. The capacity itself came from timing a keyframe burst, which
// saturates at the burst's own size (a 110 KB key measured 17 Mbps on a link
// that carries 28, and a 15 KB key measured nothing at all).
//
// Names and constants follow draft-ietf-rmcat-gcc-02 and libwebrtc's
// TrendlineEstimator / AimdRateControl, so they can be checked against them.

// Trendline filter over the smoothed accumulated delay. libwebrtc fits 20
// points because it gets feedback per packet, hundreds a second, so 20 points
// is a tenth of a second. Our feedback is one ack per 50 ms, and on a link
// carrying half of what we send the arrivals stretch to 100 ms apart, so 20
// points would be two seconds and the queue would already be past a second
// before the filter said anything. 16 points, fitted from 5, is about 800 ms
// of window: wide enough to be steady under the 25 ms of jitter this link
// really has, narrow enough to answer in a few hundred ms.
//
// The smoothing coefficient is the same story. libwebrtc's 0.9 is a ten sample
// time constant, which at hundreds of packets a second is around 50 ms. At one
// ack per 50 ms it would be half a second of lag before the trend even shows,
// and half a second is most of the time we are trying to save. 0.7 is three
// samples, so about 165 ms.
const WINDOW = 16, MIN_POINTS = 5, SMOOTHING = 0.7, THRESHOLD_GAIN = 4, DELTA_COUNTER_MAX = 60;
// Adaptive threshold: it follows |T| slowly down (so a quiet link grows
// suspicious of smaller and smaller trends) and fast up (so a link that is
// simply jittery does not read as congested forever).
const K_DOWN = 0.039, K_UP = 0.0087, THRESHOLD_START = 12.5, THRESHOLD_MIN = 6, THRESHOLD_MAX = 600;
// libwebrtc's k values are per millisecond and are tuned for feedback that
// arrives every few ms, where k_down gives a gain of about 0.2 per update: a
// stable exponential approach. It caps the elapsed time at 100 ms as a safety
// net for gaps. Our feedback is one ack per 50 ms and we would sit in that cap
// permanently, at a gain of 1.95, which does not converge on the trend, it
// oscillates around it. So the gain itself is capped instead of the time.
const MAX_TIME_DELTA_MS = 100, MAX_ADAPT_GAIN = 0.5;
// A spike far above the threshold is a capacity drop, not the normal trend it
// should adapt to.
const MAX_ADAPT_OFFSET = 15;
// An overuse has to persist: 10 ms of trend above the threshold and two
// samples in a row, or every jitter spike would be a congestion event.
const OVERUSE_TIME_MS = 10, OVERUSE_COUNT = 2;
// AIMD. Down to 85% of what the link is actually delivering, up 8% a second,
// and never further than 1.5x the delivered rate: the estimate is allowed to
// explore, not to fantasise. The 8% ramp is slow on purpose in WebRTC, where
// the encoder follows the estimate continuously; here the ladder picks the
// rate, so the climb is driven by `calm` below and the target is the bound,
// not the throttle.
const BETA = 0.85, INCREASE_PER_S = 1.08, DELIVERED_CAP = 1.5, DELIVERED_MARGIN_KBPS = 10;
const DECREASE_EVERY_MS = 300;
// Near a capacity that already broke once, creep additively instead of by 8%:
// three standard deviations is libwebrtc's "we have been here before".
const CAPACITY_SIGMAS = 3, ADDITIVE_KBPS = 24;
const MIN_TARGET_KBPS = 100;

// Slope of the least-squares line through (x, y). Null when x never moves.
function slope(points) {
  let sumX = 0, sumY = 0;
  for (const point of points) { sumX += point.x; sumY += point.y; }
  const avgX = sumX / points.length, avgY = sumY / points.length;
  let num = 0, den = 0;
  for (const point of points) {
    num += (point.x - avgX) * (point.y - avgY);
    den += (point.x - avgX) ** 2;
  }
  return den > 0 ? num / den : null;
}

export function createBwe({ startKbps = 1000, now = () => performance.now() } = {}) {
  // The filter.
  let accumulated = 0, smoothed = 0, firstArrival = null, deltas = 0, trend = 0;
  let threshold = THRESHOLD_START, thresholdAt = null;
  const history = [];
  // The detector.
  let overusing = null, overuseCount = 0, signal = 'normal', normalSince = null, risingSince = null;
  // The controller.
  let target = startKbps, state = 'increase', lastChangeAt = null, lastDecreaseAt = -Infinity;
  // The delivered rate at the moment the link last broke, as a running mean
  // and variance, so "we have been here before" has a width.
  let capacity = null, capacityVar = 0;
  let previous = null;

  const near = rate => capacity !== null
    && Math.abs(rate - capacity) <= CAPACITY_SIGMAS * Math.sqrt(capacityVar);

  function detect(t) {
    if (deltas < OVERUSE_COUNT) return 'normal';
    const was = signal;
    const T = Math.min(deltas, DELTA_COUNTER_MAX) * trend * THRESHOLD_GAIN;
    let next = signal;
    if (T > threshold) {
      overusing ??= t;
      overuseCount++;
      if (t - overusing >= OVERUSE_TIME_MS && overuseCount >= OVERUSE_COUNT && trend >= 0) {
        overusing = t; overuseCount = 0; next = 'overuse';
      }
    } else {
      overusing = null; overuseCount = 0;
      next = T < -threshold ? 'underuse' : 'normal';
    }
    // The threshold itself adapts, but only while the trend is plausible: a
    // spike must not drag it up and blind the detector for minutes.
    if (Math.abs(T) <= threshold + MAX_ADAPT_OFFSET) {
      const k = Math.abs(T) < threshold ? K_DOWN : K_UP;
      const elapsed = thresholdAt === null ? 0 : Math.min(t - thresholdAt, MAX_TIME_DELTA_MS);
      const gain = Math.min(MAX_ADAPT_GAIN, k * elapsed);
      threshold += gain * (Math.abs(T) - threshold);
      threshold = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, threshold));
    }
    thresholdAt = t;
    signal = next;
    if (next !== 'normal') { normalSince = null; risingSince ??= t; }
    else { if (was !== 'normal' || normalSince === null) normalSince = t; risingSince = null; }
    return next;
  }

  // Where the estimate goes, given the signal and what the link is delivering.
  function control(verdict, delivered, t) {
    const seconds = lastChangeAt === null ? 0 : (t - lastChangeAt) / 1000;
    lastChangeAt = t;
    if (verdict === 'overuse') {
      // Two acks in the same spike must not halve the target twice.
      if (t - lastDecreaseAt >= DECREASE_EVERY_MS && delivered !== null) {
        const sample = delivered;
        if (capacity === null) { capacity = sample; capacityVar = (sample * 0.1) ** 2 || 1; }
        else {
          const diff = sample - capacity;
          capacity += 0.05 * diff;
          capacityVar = Math.max(1, 0.95 * capacityVar + 0.05 * diff * diff);
        }
        target = Math.max(MIN_TARGET_KBPS, BETA * sample);
        lastDecreaseAt = t;
      }
      state = 'hold';
      return;
    }
    // A draining queue is not room to grow: wait for it to finish draining.
    if (verdict === 'underuse') { state = 'hold'; return; }
    state = 'increase';
    target = near(target)
      ? target + ADDITIVE_KBPS * Math.min(1, seconds)
      : target * INCREASE_PER_S ** Math.min(1, seconds);
    if (delivered !== null) target = Math.min(target, DELIVERED_CAP * delivered + DELIVERED_MARGIN_KBPS);
    target = Math.max(MIN_TARGET_KBPS, target);
  }

  return {
    // kbps the link is believed to carry. Null until the filter is full: a
    // caller must not steer on half a window.
    get target() { return history.length >= MIN_POINTS ? target : null; },
    // How long the gradient has been flat, in ms, or null when it is not.
    // This is the ladder's permission to climb: the old one was a stopwatch
    // (30 s of no complaint, one step a minute) because a threshold cannot
    // tell room from luck. A flat gradient at the rate we are already sending
    // is the link saying it is not even trying.
    get calm() { return normalSince === null || history.length < WINDOW ? null : now() - normalSince; },
    // When the gradient last stopped being flat. What the link delivered since
    // then is what it carries now, which is the number to step down to: a link
    // that just narrowed is still handing over the old rate out of its buffers,
    // so a longer window would measure a capacity that is already gone.
    get risingSince() { return risingSince; },
    get state() { return state; },
    get signal() { return signal; },
    get trend() { return trend; },
    get threshold() { return threshold; },
    get samples() { return deltas; },
    get capacity() { return capacity; },

    // One ack. The frame it named left at `sentAt` and arrived at `rx`, both in
    // the server's clock (epoch ms; a constant offset error cancels in the
    // deltas, which is the whole reason this works across two clocks).
    // `deliveredKbps` is what the link is carrying right now. Returns the
    // verdict, or null when the sample could not be used.
    ack(sentAt, rx, deliveredKbps = null) {
      if (![sentAt, rx].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
      const t = now();
      const last = previous;
      previous = { sentAt, rx };
      if (!last) { firstArrival ??= rx; return null; }
      const sendDelta = sentAt - last.sentAt, recvDelta = rx - last.rx;
      // Out of order, or two frames of the same instant: no gradient in it.
      if (sendDelta <= 0) return null;
      accumulated += recvDelta - sendDelta;
      smoothed = SMOOTHING * smoothed + (1 - SMOOTHING) * accumulated;
      deltas = Math.min(DELTA_COUNTER_MAX, deltas + 1);
      history.push({ x: rx - firstArrival, y: smoothed });
      if (history.length > WINDOW) history.shift();
      if (history.length >= MIN_POINTS) trend = slope(history) ?? trend;
      const verdict = detect(t);
      const delivered = typeof deliveredKbps === 'number' && Number.isFinite(deliveredKbps) && deliveredKbps > 0
        ? deliveredKbps : null;
      if (history.length >= MIN_POINTS) control(verdict, delivered, t);
      return verdict;
    },

    // The ladder stepped down for a reason the gradient did not raise (a queue
    // past a threshold, a stall, frames piling up in flight). It has just
    // decided the link carries about this much, and an estimate that goes on
    // claiming the old capacity would walk the ladder down one step at a time
    // through a link that narrowed all at once.
    fell(kbps) {
      if (typeof kbps !== 'number' || !Number.isFinite(kbps) || kbps <= 0) return;
      target = Math.max(MIN_TARGET_KBPS, Math.min(target, kbps));
      if (capacity !== null) capacity = Math.min(capacity, kbps);
    },

    // A break in the chain: the next ack has nothing to be compared against.
    // Used around a keyframe, whose own bytes take far longer to cross than a
    // delta's and would enter the filter as a queue that is not congestion.
    gap() { previous = null; },

    // A new encoder run. The gradient does not care what bitrate we send at,
    // so the target and the known capacity survive; the accumulated delay does
    // not, because the 450 ms with no picture would enter the filter as a
    // queue that never existed.
    restart() {
      accumulated = 0; smoothed = 0; firstArrival = null; deltas = 0; trend = 0;
      history.length = 0; previous = null;
      overusing = null; overuseCount = 0; signal = 'normal'; normalSince = null; risingSince = null;
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateControl, scaleBox, WAN_STEPS, INITIAL_STEP, LAN_RTT_MS } from '../backend/rd-rate.mjs';

// A control on a fake clock; `report` sends one stats message a second later.
function control(options = {}) {
  let clock = 0;
  const c = createRateControl({ now: () => clock, ...options });
  const at = ms => { clock = ms; };
  const pass = ms => { clock += ms; };
  const report = (fields = {}) => { clock += 1000; return c.stats({ fps: 30, kbps: 2000, rtt: 30, queue: 0, drops: 0, ...fields }); };
  return { c, at, pass, report, get clock() { return clock; } };
}

test('opening: a round trip under 15 ms is the LAN (params null), anything else opens on the WAN initial step', () => {
  assert.equal(LAN_RTT_MS, 15);
  const lan = control();
  assert.equal(lan.c.open(4), null);
  assert.equal(lan.c.mode, 'lan');
  const wan = control();
  assert.deepEqual(wan.c.open(22), { fps: 30, kbps: 2500, keyint: 60, maxWidth: 1920 });
  assert.equal(wan.c.step, INITIAL_STEP);
  assert.equal(control().c.open(null)?.kbps, 2500, 'no answer in time: the WAN');
  // A page that can ask for keyframes gets the long interval; its stage caps the width.
  assert.deepEqual(control({ caps: { key: true }, view: { width: 1600, height: 900 }, maxFps: 24 }).c.open(40), { fps: 24, kbps: 2500, keyint: 300, maxWidth: 1600 });
});

test('scaleBox keeps the aspect and even sizes, and is null when the monitor already fits', () => {
  assert.deepEqual(scaleBox({ width: 3440, height: 1440 }, 1920), { width: 1920, height: 804 });
  assert.deepEqual(scaleBox({ width: 2560, height: 1440 }, 1280), { width: 1280, height: 720 });
  assert.equal(scaleBox({ width: 1920, height: 1080 }, 1920), null);
  assert.equal(scaleBox({ width: 1920, height: 1080 }, null), null);
});

test('old page: a queue in two reports in a row steps down at once to what the delivered rate carries', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 5; i++) assert.equal(t.report(), null);
  assert.equal(t.report({ rtt: 300, kbps: 1500 }), null, 'one report is not a trend');
  const down = t.report({ rtt: 320, kbps: 1500 });
  // 80% of ~1667 kbps delivered carries W1 (1000 kbps), two steps down, one restart.
  assert.equal(down.reason, 'down');
  assert.equal(t.c.step, 1);
  assert.deepEqual(down.params, { fps: 15, kbps: 1000, keyint: 60, maxWidth: 1920 });
  // Right after a restart the old queue may still show: no second step for 3 s.
  assert.equal(t.report({ rtt: 400, kbps: 900 }), null);
});

test('old page: a queue over a second steps down without waiting for a second report', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 4; i++) t.report();
  assert.equal(t.report({ rtt: 1500, kbps: 1200 })?.reason, 'down');
});

test('a keyframe crossing the link is not congestion: its bytes ÷ the delivered rate are excused, the p95 for its whole window', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 6; i++) t.report({ kbps: 2400, p95: 60 });
  t.c.sent(110000, true); // ~370 ms at 2.4 Mbps
  assert.equal(t.report({ rtt: 380, kbps: 2400, p95: 400 }), null);
  assert.equal(t.report({ rtt: 30, kbps: 2400, p95: 400 }), null);
  assert.equal(t.report({ rtt: 30, kbps: 2400, p95: 350 }), null);
  assert.equal(t.c.step, INITIAL_STEP);
});

test('up: one step after 30 s calm, never within 60 s of the last change, and only with reports coming', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 4; i++) t.report();
  t.report({ rtt: 400, kbps: 1500 }); t.report({ rtt: 400, kbps: 1500 });
  assert.equal(t.c.step, 1);
  for (let i = 0; i < 59; i++) { t.report({ kbps: 900 }); assert.equal(t.c.tick(), null, `second ${i}`); }
  t.report({ kbps: 900 });
  const up = t.c.tick();
  assert.equal(up.reason, 'up');
  assert.equal(t.c.step, 2);
  t.pass(61000);
  assert.equal(t.c.tick(), null, 'no reports for a minute: no climbing blind');
  // Not calm: a report with a queue over 50 ms restarts the 30 s.
  for (let i = 0; i < 40; i++) t.report({ rtt: i === 35 ? 100 : 30 });
  assert.equal(t.c.tick(), null);
});

test('backoff: on a steady 2.5 Mbps link a step that fails is retried after 1, 2, 4 and then 8 minutes, never more often', () => {
  // The link carries W2 (1600) but W3 (2500) builds a queue after a few seconds.
  const t = control();
  t.c.open(25);
  const events = [];
  let atStep = 0;
  for (let second = 0; second < 40 * 60; second++) {
    const over = WAN_STEPS[t.c.step].kbps > 2000 && second - atStep > 4;
    const decision = t.report({ rtt: over ? 400 : 30, kbps: Math.min(WAN_STEPS[t.c.step].kbps * 0.7, 2200) }) || t.c.tick();
    if (decision) { events.push({ second, reason: decision.reason, step: t.c.step }); atStep = second; }
  }
  const ups = events.filter(e => e.reason === 'up' && e.step === 3);
  const failed = ups.filter(up => events.some(e => e.reason === 'down' && e.second > up.second && e.second - up.second <= 20));
  assert.equal(failed.length, ups.length, 'every climb to W3 fails on this link');
  const gaps = failed.slice(1).map((up, i) => up.second - failed[i].second);
  assert.ok(gaps.every((gap, i) => gap >= 60 * Math.min(8, 2 ** (i + 1))), `gaps ${gaps}`);
  // In the regime (after the first 16 minutes) at most one failed climb per 8 minutes.
  const late = failed.filter(up => up.second >= 16 * 60);
  for (let i = 1; i < late.length; i++) assert.ok(late[i].second - late[i - 1].second >= 8 * 60);
  assert.ok(late.length <= 3, `${late.length} failed climbs in 24 minutes`);
});

test('backoff resets after 10 minutes steady one step below: the next failure waits 2 minutes again, not 8', () => {
  const t = control();
  t.c.open(25);
  const climbAndFail = () => {
    let up = null;
    for (let i = 0; i < 20 * 60 && !up; i++) { t.report({ kbps: 5000 }); up = t.c.tick(); }
    assert.equal(up?.reason, 'up');
    const upAt = t.clock;
    t.report({ rtt: 500, kbps: 3200 }); t.report({ rtt: 500, kbps: 3200 });
    assert.equal(t.report({ rtt: 500, kbps: 3200 })?.reason, 'down');
    return upAt;
  };
  const first = climbAndFail(), second = climbAndFail(), third = climbAndFail();
  assert.ok(second - first >= 120000 && third - second >= 240000, `${second - first} ${third - second}`);
  // Ten minutes at W3 with a small queue every 20 s (never 30 s calm, never congested): no climbing, and the backoff for W4 clears.
  for (let i = 0; i < 601; i++) { t.report({ rtt: i % 20 ? 30 : 90, kbps: 2400 }); assert.equal(t.c.tick(), null); }
  const fourth = climbAndFail(), fifth = climbAndFail();
  assert.ok(fifth - fourth < 180000, `after the reset the wait is back to 2 minutes, got ${fifth - fourth}`);
});

test('keyframes on request: explicit or, for a page that cannot ask, its dropped frames; merged within 2 s; four a minute step down', () => {
  const silent = control();
  silent.c.open(25);
  for (let i = 0; i < 4; i++) silent.report();
  assert.equal(silent.report({ drops: 3 })?.reason, 'key');
  assert.equal(silent.report({ drops: 5 }), null, 'the page counts drops until the keyframe comes: merged');
  silent.pass(2000);
  assert.equal(silent.report({ drops: 2 })?.reason, 'key');
  silent.pass(3000);
  assert.equal(silent.report({ drops: 2 })?.reason, 'key');
  silent.pass(3000);
  const fourth = silent.report({ drops: 2 });
  assert.equal(fourth.reason, 'down', 'a decoder that keeps losing frames needs less');
  assert.equal(silent.c.step, INITIAL_STEP - 1);

  const asks = control({ caps: { key: true } });
  asks.c.open(25);
  for (let i = 0; i < 4; i++) asks.report();
  assert.equal(asks.report({ drops: 9 }), null, 'a page that asks is not guessed for');
  assert.equal(asks.c.key()?.reason, 'key');
  asks.pass(1500);
  assert.equal(asks.c.key(), null);
  asks.pass(600);
  assert.equal(asks.c.key()?.reason, 'key', 'always honoured, outside the climbing budget');

  const lan = control();
  lan.c.open(3);
  assert.equal(lan.report({ drops: 4 }), null, 'the LAN has a keyframe every second');
  assert.equal(lan.c.key(), null);
});

test('a delta the session drops for its own buffer asks for a new run on the WAN, a step lower; merged within 2 s; a key on the floor', () => {
  const t = control();
  t.c.open(25);
  for (let i = 0; i < 4; i++) t.report({ kbps: 2100 });
  assert.equal(t.c.drop().reason, 'down');
  assert.equal(t.c.step, 2, '80% of 2.1 Mbps carries W2');
  t.pass(1000);
  assert.equal(t.c.drop(), null);
  const lan = control();
  lan.c.open(2);
  assert.equal(lan.c.drop(), null);
  const bottom = control();
  bottom.c.open(25);
  for (let i = 0; i < 4; i++) bottom.report({ kbps: 300 });
  bottom.c.drop();
  assert.equal(bottom.c.step, 0);
  bottom.pass(2500);
  assert.equal(bottom.c.drop().reason, 'key');
});

test('LAN → WAN: a round trip over 15 ms for 5 s, or a queue, moves the session to the steps (at most the initial one); never back', () => {
  const far = control();
  far.c.open(4);
  for (let i = 0; i < 3; i++) assert.equal(far.report({ rtt: 30, kbps: 11000 }), null);
  const moved = far.report({ rtt: 31, kbps: 11000 });
  assert.equal(moved.reason, 'wan');
  assert.equal(far.c.mode, 'wan');
  assert.equal(far.c.step, INITIAL_STEP, 'a fast link still starts at the initial step');
  for (let i = 0; i < 20; i++) far.report({ rtt: 2, kbps: 2000 });
  assert.equal(far.c.mode, 'wan');

  const queued = control();
  queued.c.open(8);
  queued.report({ rtt: 8, kbps: 3000 });
  queued.report({ rtt: 400, kbps: 2800 });
  const move = queued.report({ rtt: 450, kbps: 2800 });
  assert.equal(move.reason, 'wan');
  assert.equal(queued.c.step, 2, '80% of 2.8 Mbps carries W2');
});

test('on the floor, a queue that keeps growing sheds frames until it drains, then restarts with a keyframe', () => {
  const t = control();
  t.c.open(60);
  for (let i = 0; i < 4; i++) t.report({ rtt: 60, kbps: 400 });
  t.report({ rtt: 400, kbps: 400 }); t.report({ rtt: 400, kbps: 400 });
  assert.equal(t.c.step, 0);
  for (let i = 0; i < 2; i++) assert.equal(t.report({ rtt: 700, kbps: 400 }), null, 'settling after the restart');
  assert.equal(t.report({ rtt: 800, kbps: 400 })?.reason, 'shed');
  assert.equal(t.c.shedding, true);
  assert.equal(t.c.tick(), null, 'no climbing while shedding');
  assert.equal(t.report({ rtt: 300 }), null);
  assert.equal(t.report({ rtt: 70 })?.reason, 'key');
  assert.equal(t.c.shedding, false);
});

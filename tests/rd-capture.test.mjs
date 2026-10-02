import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TsDemuxer, nalUnits, stripFiller, parseSps, captureCommand, captureVendor, createCapture, readBand, BAND, CAPPED_CQ, WAN_QUALITY } from '../backend/rd-capture.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ffmpeg = (args, input) => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
};
// 30 frames of H.264 in MPEG-TS, a keyframe every 10, as libavformat writes it
// (the same muxer gpu-screen-recorder uses).
const fixture = hasFfmpeg ? ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-bf', '0', '-f', 'mpegts', 'pipe:1']) : null;

function demux(bytes, chunk = 4096) {
  const units = [];
  const demuxer = new TsDemuxer(unit => units.push(unit));
  for (let i = 0; i < bytes.length; i += chunk) demuxer.push(bytes.subarray(i, i + chunk));
  demuxer.end();
  return { units, stats: demuxer.stats };
}

test('the TS demuxer yields one Annex B access unit per frame, keyframes flagged, SPS parsed into the WebCodecs codec', { skip: !hasFfmpeg }, () => {
  const { units, stats } = demux(fixture);
  assert.equal(units.length, 30);
  assert.deepEqual(units.map((u, i) => u.keyframe ? i : -1).filter(i => i >= 0), [0, 10, 20]);
  for (const unit of units) assert.ok(unit.data.indexOf(Buffer.from([0, 0, 1])) <= 1, 'starts with a start code');
  const sps = units[0].sps;
  assert.equal(sps.width, 320); assert.equal(sps.height, 240);
  assert.match(sps.codec, /^avc1\.[0-9a-f]{6}$/);
  assert.equal(sps.codec.slice(5, 7), '42'); // x264 ultrafast: Constrained Baseline
  // The end-of-PES stuffing lets most units leave without waiting for the next frame.
  assert.ok(stats.early >= 28, `early ${stats.early}`);
  // What goes on the wire decodes back to the same 30 frames.
  const decoded = ffmpeg(['-f', 'h264', '-i', 'pipe:0', '-f', 'framecrc', 'pipe:1'], Buffer.concat(units.map(u => u.data)));
  assert.equal(decoded.toString().split('\n').filter(line => /^0,/.test(line)).length, 30);
});

test('chunk boundaries do not matter, and garbage before the stream (gsr prints its output path) is skipped', { skip: !hasFfmpeg }, () => {
  const reference = demux(fixture).units.map(u => u.data.toString('hex'));
  for (const size of [1, 7, 188, 1000, 65536]) assert.deepEqual(demux(fixture, size).units.map(u => u.data.toString('hex')), reference, `chunk ${size}`);
  const noisy = demux(Buffer.concat([Buffer.from('/dev/stdout\n'), fixture]), 333);
  assert.deepEqual(noisy.units.map(u => u.data.toString('hex')), reference);
  assert.ok(noisy.stats.resyncs >= 1);
});

test('filler NAL units (CBR padding) are stripped, everything else kept', () => {
  const sc = Buffer.from([0, 0, 0, 1]);
  const au = Buffer.concat([sc, Buffer.from([0x09, 0xf0]), sc, Buffer.from([0x65, 1, 2, 3]), sc, Buffer.from([0x0c, 0xff, 0xff, 0xff, 0x80]), Buffer.from([0, 0, 1]), Buffer.from([0x41, 9])]);
  assert.deepEqual(nalUnits(au).map(u => u.type), [9, 5, 12, 1]);
  const out = stripFiller(au);
  assert.deepEqual(nalUnits(out).map(u => u.type), [9, 5, 1]);
  assert.equal(out.toString('hex'), '0000000109f0' + '0000000165010203' + '000000014109');
  const plain = Buffer.concat([sc, Buffer.from([0x65, 1])]);
  assert.equal(stripFiller(plain), plain, 'no copy without filler');
});

test('SPS parsing: frame cropping gives 1080 lines, and the measured NVENC SPS is avc1.640034', { skip: !hasFfmpeg }, () => {
  const ts = ffmpeg(['-f', 'lavfi', '-i', 'color=black:size=1920x1080:rate=1', '-frames:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mpegts', 'pipe:1']);
  const { sps } = demux(ts).units[0];
  assert.equal(sps.width, 1920); assert.equal(sps.height, 1080);
  // The SPS NVENC wrote through gpu-screen-recorder for a 3440x1440 monitor at 60 fps.
  const nvenc = parseSps(Buffer.from('67640034ac2b2006b816b602d404040500000303e80001d4c0e000001e84800003d0906ef288f8e15240', 'hex'));
  assert.deepEqual(nvenc, { profile: 100, constraints: 0, level: 52, width: 3440, height: 1440, codec: 'avc1.640034' });
});

test('capture command lines: gsr takes the monitor by name with the design flags; lab uses x264 zerolatency in the same mpegts', () => {
  const [command, args] = captureCommand({ monitor: 'DP-3', fps: 60, kbps: 8000, keyint: 1 });
  assert.equal(command, 'gpu-screen-recorder');
  assert.deepEqual(args, ['-w', 'DP-3', '-c', 'mpegts', '-k', 'h264', '-f', '60', '-fm', 'cfr', '-bm', 'cbr', '-q', '8000', '-tune', 'performance', '-keyint', '1', '-cursor', 'yes', '-v', 'no']);
  assert.throws(() => captureCommand({ monitor: 'DP-3; rm -rf ~' }));
  const [lab, labArgs] = captureCommand({ mode: 'lab', width: 1920, height: 1080, fps: 30, kbps: 3000 });
  assert.equal(lab, 'ffmpeg');
  const joined = labArgs.join(' ');
  for (const part of ['testsrc2=size=1920x1080:rate=30', 'libx264', '-tune zerolatency', '-g 30', '-f mpegts', 'RTCTIME', `crop=${BAND.bits * BAND.cell}:${BAND.cell}`]) assert.ok(joined.includes(part), part);
});

test('the lab capture paints the wall-clock capture time into the top band', { skip: !hasFfmpeg }, async () => {
  const [command, args] = captureCommand({ mode: 'lab', width: 704, height: 64, fps: 30, kbps: 800 });
  const started = Date.now();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const units = [];
  const demuxer = new TsDemuxer(unit => units.push(unit));
  child.stdout.on('data', chunk => demuxer.push(chunk));
  while (units.length < 15) await new Promise(r => setTimeout(r, 50));
  child.kill('SIGKILL');
  const gray = ffmpeg(['-f', 'h264', '-i', 'pipe:0', '-vf', `crop=${BAND.bits * BAND.cell}:${BAND.cell}:0:0,format=gray`, '-f', 'rawvideo', 'pipe:1'], Buffer.concat(units.map(u => u.data)));
  const size = BAND.bits * BAND.cell * BAND.cell;
  const stamps = [];
  for (let i = 0; i + size <= gray.length; i += size) stamps.push(readBand(gray.subarray(i, i + size), BAND.bits * BAND.cell));
  assert.ok(stamps.length >= 10);
  for (const stamp of stamps) assert.ok(stamp >= started - 50 && stamp <= Date.now(), `${stamp} vs ${started}`);
  const steps = stamps.slice(1).map((s, i) => s - stamps[i]);
  assert.ok(steps.every(step => step > 15 && step < 60), `frame steps ${steps}`); // 30 fps ≈ 33 ms apart
});

const hasDrawtext = hasFfmpeg && spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout.toString().includes(' drawtext ');

test('the lab desktop scene: a screenshot, a scrolling terminal and a cursor, with a VBV that lets keyframes grow like the real encoder', () => {
  const [, args] = captureCommand({ mode: 'lab', scene: 'desktop', width: 1920, height: 1080, fps: 30, kbps: 2000 });
  const joined = args.join(' ');
  for (const part of ['desktop-control.png', 'drawtext=', 'expansion=none', 'drawbox=', '-bufsize 4000k', 'RTCTIME', `crop=${BAND.bits * BAND.cell}:${BAND.cell}`]) assert.ok(joined.includes(part), part);
  assert.ok(!joined.includes('testsrc2'));
  assert.throws(() => captureCommand({ mode: 'lab', scene: 'desktop', text: "/tmp/it's" }));
});

test('the lab desktop scene carries the capture-time band too, also shrunk for a WAN step', { skip: !hasDrawtext }, async () => {
  for (const scale of [null, { width: 800, height: 450 }]) await desktopBand(scale);
});

async function desktopBand(scale) {
  const [command, args] = captureCommand({ mode: 'lab', scene: 'desktop', width: scale ? 1280 : 704, height: scale ? 720 : 400, fps: 30, kbps: 800, scale });
  const started = Date.now();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const units = [];
  const demuxer = new TsDemuxer(unit => units.push(unit));
  child.stdout.on('data', chunk => demuxer.push(chunk));
  while (units.length < 10) await new Promise(r => setTimeout(r, 50));
  child.kill('SIGKILL');
  const gray = ffmpeg(['-f', 'h264', '-i', 'pipe:0', '-fps_mode', 'passthrough', '-vf', `crop=${BAND.bits * BAND.cell}:${BAND.cell}:0:0,format=gray`, '-f', 'rawvideo', 'pipe:1'], Buffer.concat(units.map(u => u.data)));
  const size = BAND.bits * BAND.cell * BAND.cell;
  const stamps = [];
  for (let i = 0; i + size <= gray.length; i += size) stamps.push(readBand(gray.subarray(i, i + size), BAND.bits * BAND.cell));
  assert.ok(stamps.length >= 8);
  for (const stamp of stamps) assert.ok(stamp >= started - 50 && stamp <= Date.now(), `${stamp} vs ${started} (scale ${JSON.stringify(scale)})`);
}

test('createCapture runs the lab encoder, restarts it with new parameters and opens each run with a keyframe', { skip: !hasFfmpeg }, async () => {
  const units = [];
  const capture = createCapture({ mode: 'lab', onUnit: unit => units.push(unit), log: { error() {} } });
  capture.start({ width: 704, height: 64, fps: 30, kbps: 500 });
  while (units.length < 3) await new Promise(r => setTimeout(r, 20));
  capture.restart({ fps: 15, kbps: 300 });
  const mark = units.length;
  while (units.length < mark + 3) await new Promise(r => setTimeout(r, 20));
  capture.stop();
  const second = units.slice(mark);
  assert.equal(second[0].params.fps, 15);
  assert.equal(second[0].keyframe, true);
  assert.ok(units[0].keyframe);
  assert.equal(capture.running, false);
});

// The step of the ladder becomes a ceiling on the peak instead of a target, so
// the encoder spends what the picture needs and the keyframe stops being the
// frame the rate control starves. The keys belong to the encoder, not to
// gpu-screen-recorder, and they differ between vendors.
test('capped CQ: each vendor gets its own rate-control keys, and an unknown one stays on CBR', () => {
  const opts = args => {
    const at = args.indexOf('-ffmpeg-video-opts');
    return at < 0 ? null : args[at + 1];
  };
  const of = extra => opts(captureCommand({ monitor: 'DP-2', kbps: 2500, ...extra })[1]);

  assert.equal(of({ quality: 23, vendor: 'nvidia' }), 'rc=vbr;cq=23;b=0;maxrate=2500k;bufsize=2500k');
  // VAAPI refuses b=0 and does not know rc/cq; QVBR is its capped CQ.
  assert.equal(of({ quality: 23, vendor: 'amd' }), 'rc_mode=QVBR;qp=23;maxrate=2500k;bufsize=2500k');
  assert.equal(of({ quality: 23, vendor: 'intel' }), of({ quality: 23, vendor: 'amd' }));

  assert.equal(of({}), null, 'no quality: CBR as before');
  assert.equal(of({ quality: 23 }), null, 'no vendor: CBR as before');
  assert.equal(of({ quality: 23, vendor: 'matrox' }), null, 'a vendor with no recipe: CBR as before');

  // The ceiling in -q is still the step's, and the peak follows it.
  const high = captureCommand({ monitor: 'DP-2', kbps: 6000, quality: WAN_QUALITY, vendor: 'nvidia' })[1];
  assert.equal(high[high.indexOf('-q') + 1], '6000');
  assert.match(opts(high), /maxrate=6000k;bufsize=6000k/);
  assert.match(opts(high), new RegExp(`cq=${WAN_QUALITY}\\b`));
  assert.ok(Object.keys(CAPPED_CQ).includes('nvidia'));
});

test('captureVendor reads the encoder gpu-screen-recorder reports, once, and ignores one with no recipe', () => {
  let calls = 0;
  const fake = out => (command, args) => {
    calls++;
    assert.equal(command, 'gpu-screen-recorder');
    assert.deepEqual(args, ['--info']);
    return { stdout: out };
  };
  assert.equal(captureVendor({ spawn: fake('display_server|wayland\nvendor|nvidia\nsection=video_codecs\n'), reset: true }), 'nvidia');
  assert.equal(calls, 1);
  assert.equal(captureVendor({ spawn: fake('vendor|amd\n') }), 'nvidia', 'cached: the program runs once');
  assert.equal(calls, 1);

  assert.equal(captureVendor({ spawn: fake('vendor|amd\n'), reset: true }), 'amd');
  assert.equal(captureVendor({ spawn: fake('vendor|matrox\n'), reset: true }), null, 'no recipe, no capped CQ');
  assert.equal(captureVendor({ spawn: fake('nothing useful\n'), reset: true }), null);
  assert.equal(captureVendor({ spawn: () => { throw new Error('no such program'); }, reset: true }), null);
});

// A wrong key does not degrade the picture, it stops the encoder from opening
// at all ("Could not open video codec: Invalid argument"), so a session would
// show nothing. A softer keyframe beats no picture.
test('createCapture drops constant quality after a run that died without a frame, and keeps it off', async () => {
  const runs = [];
  const errors = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    runs.push({ command, capped: args.includes('-ffmpeg-video-opts') });
    child.kill = () => {};
    // Dies at once without ever producing a unit, like a refused codec.
    setTimeout(() => { child.stderr.emit('data', 'gsr error: Could not open video codec: Invalid argument\n'); child.emit('close', 1, null); }, 5);
    return child;
  };
  const capture = createCapture({ spawn, onUnit: () => {}, log: { error: message => errors.push(message) } });
  capture.start({ monitor: 'DP-2', kbps: 2500, fps: 30, keyint: 2, quality: 23, vendor: 'nvidia' });
  while (runs.length < 2) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 30));

  assert.equal(runs[0].capped, true, 'the first run asked for constant quality');
  assert.equal(runs[1].capped, false, 'the retry is plain CBR');
  assert.equal(capture.cappedOff, true);
  assert.ok(errors.some(message => /refused constant quality/.test(message)), errors.join(' | '));

  // And it stays off for later runs, instead of failing again every restart.
  const before = runs.length;
  capture.restart({ kbps: 6000 });
  while (runs.length <= before) await new Promise(r => setTimeout(r, 10));
  assert.equal(runs.at(-1).capped, false);
  capture.stop();
});

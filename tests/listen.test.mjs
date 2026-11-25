// Tests for js/listen.js — everything goes through listener.feed(), the same path the mic uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createListener, HitDetector, DrumClassifier, estimateLoopbackLatency, FEATURE_DIM } from '../js/listen.js';
import { voices, thwack, place, addNoise, rng } from './dsp-synth.mjs';

const CLOCK = 100;      // pretend audioContext.currentTime started well away from zero

/** Render events [{t, make, g}] to audio and feed it in `chunk`-sized blocks. Returns hits with time relative to the render start. */
function play(listener, sr, events, { noise = 0.001, chunk = 256, seed = 1, tailSec = 1 } = {}) {
  const rand = rng(seed);
  const out = new Float32Array(Math.round((Math.max(...events.map((e) => e.t)) + tailSec) * sr));
  for (const e of events) place(out, e.make(rand), Math.round(e.t * sr), e.g ?? 1);
  addNoise(out, rand, noise);
  const hits = [];
  const off = listener.onHit((h) => hits.push({ ...h, time: h.time - CLOCK }));
  for (let i = 0; i < out.length; i += chunk) listener.feed(out.subarray(i, Math.min(out.length, i + chunk)), CLOCK + i / sr);
  off();
  return hits;
}

const drum = (sr, lane) => (rand) => voices[lane](sr, rand, rand() * 2 - 1);

function train(listener, sr, lane, make, { count = 6, gap = 0.5, seed = 11, noise = 0.001 } = {}) {
  const rand = rng(seed);
  listener.startTraining(lane);
  const events = [];
  for (let k = 0; k < count; k++) events.push({ t: 0.4 + k * gap, make, g: 0.45 + 0.55 * rand() });
  const hits = play(listener, sr, events, { seed: seed + 1, noise });
  return { result: listener.stopTraining(), hits };
}

function trainKit(listener, sr, lanes) {
  lanes.forEach((lane, i) => train(listener, sr, lane, drum(sr, lane), { gap: lane === 'crash' ? 1.6 : 0.5, seed: 20 + i }));
}

const KIT = ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'crash'];

for (const sr of [44100, 48000]) {
  test(`timing-only mode when untrained: every hit found once, within 10 ms (${sr} Hz)`, () => {
    const L = createListener({ sampleRate: sr, currentTime: 0 });
    const rand = rng(5);
    const events = [];
    let t = 0.5;
    for (const lane of ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'floor', 'ride', 'crash']) {
      for (let k = 0; k < 5; k++) {
        events.push({ t: t + rand() * 0.02, make: drum(sr, lane), g: 0.25 + 0.75 * rand(), lane });
        t += lane === 'crash' ? 1.5 : 0.35;
      }
    }
    for (const chunk of [128, 256, 1024, 1000]) {
      const hits = play(L, sr, events, { chunk, seed: chunk });
      assert.equal(hits.length, events.length, `chunk ${chunk}: one hit per stroke, no double triggers`);
      let worst = 0;
      events.forEach((e, i) => { worst = Math.max(worst, Math.abs(hits[i].time - e.t)); });
      assert.ok(worst < 0.010, `chunk ${chunk}: worst timing error ${(worst * 1000).toFixed(2)} ms`);
      assert.ok(worst < 0.003, `chunk ${chunk}: expected ~1 ms on clean audio, got ${(worst * 1000).toFixed(2)} ms`);
      assert.ok(hits.every((h) => h.lane === null), 'untrained listener reports lane null');
      assert.ok(hits.every((h) => h.strength >= 0 && h.strength <= 1));
    }
  });

  test(`after training, clean drums land in the right lane (${sr} Hz)`, () => {
    const L = createListener({ sampleRate: sr, currentTime: 0 });
    assert.deepEqual(L.trainedLanes(), []);
    trainKit(L, sr, KIT);
    assert.deepEqual([...L.trainedLanes()].sort(), [...KIT].sort());
    const rand = rng(77);
    const events = [];
    let t = 0.5;
    for (let round = 0; round < 6; round++) {
      for (const lane of KIT) {
        events.push({ t, make: drum(sr, lane), g: 0.35 + 0.65 * rand(), lane });
        t += lane === 'crash' ? 1.6 : 0.4;
      }
    }
    const hits = play(L, sr, events, { seed: 78 });
    assert.equal(hits.length, events.length);
    let correct = 0, worst = 0, minConf = 1;
    events.forEach((e, i) => {
      if (hits[i].lane === e.lane) correct++;
      worst = Math.max(worst, Math.abs(hits[i].time - e.t));
      minConf = Math.min(minConf, hits[i].confidence);
    });
    assert.equal(correct, events.length, `lane accuracy ${correct}/${events.length}`);
    assert.ok(worst < 0.010, `worst timing error ${(worst * 1000).toFixed(2)} ms`);
    assert.ok(minConf > 0.5, `lowest confidence on clean drums was ${minConf.toFixed(2)}`);
    assert.equal(L.getTrainingQuality().confusable.length, 0);
  });
}

test('training: hits are collected, reported with the training lane, and counted', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  const { result, hits } = train(L, sr, 'snare', drum(sr, 'snare'));
  assert.deepEqual({ lane: result.lane, count: result.count }, { lane: 'snare', count: 6 });
  assert.equal(hits.length, 6);
  assert.ok(hits.every((h) => h.lane === 'snare' && h.training === true));
  // One trained lane is not enough to classify: still timing-only.
  assert.deepEqual(L.trainedLanes(), ['snare']);
  const after = play(L, sr, [{ t: 0.5, make: drum(sr, 'snare') }, { t: 1.0, make: drum(sr, 'kick') }]);
  assert.deepEqual(after.map((h) => h.lane), [null, null]);
  L.clearTraining('snare');
  assert.deepEqual(L.trainedLanes(), []);
  assert.throws(() => L.startTraining('cowbell'));
});

test('simultaneous kick + hi-hat (and kick + crash, kick + snare) give both lanes at one time', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  trainKit(L, sr, KIT);
  const rand = rng(31);
  for (const [a, b] of [['kick', 'hihat'], ['kick', 'crash'], ['kick', 'snare']]) {
    const events = [];
    for (let k = 0; k < 8; k++) {
      const t = 0.5 + k * (b === 'crash' ? 1.6 : 0.6);
      events.push({ t, make: drum(sr, a), g: 0.5 + 0.5 * rand() });
      events.push({ t: t + rand() * 0.004, make: drum(sr, b), g: 0.4 + 0.4 * rand() });
    }
    const hits = play(L, sr, events, { seed: 32 });
    assert.equal(hits.length, 16, `${a}+${b}: two hits per stroke, got ${hits.length}`);
    for (let k = 0; k < 8; k++) {
      const pair = hits.slice(2 * k, 2 * k + 2);
      assert.deepEqual(pair.map((h) => h.lane).sort(), [a, b].sort(), `${a}+${b} stroke ${k}`);
      assert.equal(pair[0].time, pair[1].time, 'both lanes share one timestamp');
      assert.ok(Math.abs(pair[0].time - events[2 * k].t) < 0.010);
    }
  }
  // A single drum must never be split into two lanes.
  const singles = KIT.map((lane, i) => ({ t: 0.5 + i * 1.6, make: drum(sr, lane) }));
  assert.equal(play(L, sr, singles, { seed: 33 }).length, singles.length);
});

test('a rock groove: hits over ringing drums keep their lane, and nothing is invented', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  trainKit(L, sr, KIT);
  // Eighth notes at 150 bpm (200 ms apart): kick+hat, hat, snare, hat.
  const rand = rng(40);
  const events = [], want = [];
  for (let k = 0; k < 12; k++) {
    const t = 0.5 + k * 0.8;
    events.push({ t, make: drum(sr, 'kick'), g: 0.7 + 0.3 * rand() }, { t, make: drum(sr, 'hihat'), g: 0.7 });
    events.push({ t: t + 0.2, make: drum(sr, 'hihat'), g: 0.5 });
    events.push({ t: t + 0.4, make: drum(sr, 'snare'), g: 0.7 });
    events.push({ t: t + 0.6, make: drum(sr, 'hihat'), g: 0.5 });
    want.push([t, 'kick'], [t, 'hihat'], [t + 0.2, 'hihat'], [t + 0.4, 'snare'], [t + 0.6, 'hihat']);
  }
  const hits = play(L, sr, events, { seed: 41 });
  let found = 0;
  for (const [t, lane] of want) if (hits.some((h) => h.lane === lane && Math.abs(h.time - t) < 0.010)) found++;
  const invented = hits.filter((h) => h.lane !== null && !want.some(([t, lane]) => lane === h.lane && Math.abs(h.time - t) < 0.010));
  assert.equal(invented.length, 0, `invented: ${invented.map((h) => `${h.lane}@${h.time.toFixed(3)}`)}`);
  assert.ok(found >= want.length - 3, `${found}/${want.length} notes heard in the right lane`);

  // Tighter still (hi-hat 125 ms after a kick, then a snare, then a hi-hat): every stroke is still
  // timed; a hat buried in the snare's tail may come back unclassified, but never as the wrong drum.
  const tight = [];
  for (let k = 0; k < 6; k++) {
    tight.push({ t: 0.5 + k, make: drum(sr, 'kick') }, { t: 0.625 + k, make: drum(sr, 'hihat'), g: 0.5 });
    tight.push({ t: 0.75 + k, make: drum(sr, 'snare'), g: 0.7 }, { t: 0.875 + k, make: drum(sr, 'hihat'), g: 0.5 });
  }
  const order = ['kick', 'hihat', 'snare', 'hihat'];
  const tightHits = play(L, sr, tight, { seed: 42 });
  assert.equal(tightHits.length, tight.length);
  tightHits.forEach((h, i) => {
    assert.ok(Math.abs(h.time - tight[i].t) < 0.010);
    assert.ok(h.lane === null || h.lane === order[i % 4], `stroke ${i}: ${h.lane}`);
  });
  assert.ok(tightHits.filter((h) => h.lane !== null).length >= 18);
});

test('near-identical pad thwacks: low confidence, reported as lane null rather than guessed', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  // Three rubber pads of the same type (centres within a few percent) and a kick tower that thumps lower.
  const pads = {
    snare: (rand) => thwack(sr, rand, 600, 160),
    tom1: (rand) => thwack(sr, rand, 615, 163),
    tom2: (rand) => thwack(sr, rand, 590, 158),
    kick: (rand) => thwack(sr, rand, 180, 70),
  };
  Object.keys(pads).forEach((lane, i) => {
    const { result } = train(L, sr, lane, pads[lane], { seed: 50 + i, noise: 0.002 });
    assert.equal(result.count, 6, 'quiet thwacks are still detected in training');
  });
  const quality = L.getTrainingQuality();
  const confusable = quality.confusable.map((p) => p.slice().sort().join('+')).sort();
  assert.deepEqual(confusable, ['snare+tom1', 'snare+tom2', 'tom1+tom2']);

  const rand = rng(60);
  let wrongConfident = 0, nullCount = 0, total = 0, maxGuess = 0;
  for (const lane of ['snare', 'tom1', 'tom2']) {
    const events = [];
    for (let k = 0; k < 15; k++) events.push({ t: 0.4 + k * 0.4, make: pads[lane], g: 0.5 + 0.5 * rand() });
    const hits = play(L, sr, events, { seed: 61, noise: 0.002 });
    assert.equal(hits.length, events.length, 'every thwack is still detected (timing works)');
    for (const h of hits) {
      total++;
      if (h.lane === null) { nullCount++; maxGuess = Math.max(maxGuess, h.guessConfidence); }
      else if (h.lane !== lane) wrongConfident++;
      assert.ok(h.confidence < 0.4, `confidence ${h.confidence.toFixed(2)} should be low for look-alike pads`);
    }
  }
  assert.equal(wrongConfident, 0);
  assert.equal(nullCount, total, 'all look-alike thwacks degrade to timing-only');
  assert.ok(maxGuess < 0.2, `best-guess confidence stays low (${maxGuess.toFixed(2)})`);

  // The kick tower sounds different, so it is still recognised.
  const kicks = [];
  for (let k = 0; k < 10; k++) kicks.push({ t: 0.4 + k * 0.4, make: pads.kick, g: 0.5 + 0.5 * rand() });
  const kickHits = play(L, sr, kicks, { seed: 62, noise: 0.002 });
  assert.equal(kickHits.filter((h) => h.lane === 'kick').length, kicks.length);
});

test('an unfamiliar sound is not forced into a trained lane', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  trainKit(L, sr, ['kick', 'snare']);
  const hits = play(L, sr, [0, 1, 2, 3].map((k) => ({ t: 0.5 + k * 0.5, make: drum(sr, 'ride') })));
  assert.equal(hits.length, 4);
  assert.ok(hits.every((h) => h.lane === null), `got ${hits.map((h) => h.lane)}`);
});

test('no double triggers on long, ringing or noisy sounds', () => {
  const sr = 44100;
  const L = createListener({ sampleRate: sr });
  L.setSensitivity(1);
  const events = [];
  let t = 0.5;
  for (let k = 0; k < 6; k++) { events.push({ t, make: drum(sr, 'crash') }); t += 1.7; }
  for (let k = 0; k < 6; k++) { events.push({ t, make: drum(sr, 'floor') }); t += 0.7; }
  for (let k = 0; k < 6; k++) { events.push({ t, make: drum(sr, 'snare') }); t += 0.4; }
  const hits = play(L, sr, events, { noise: 0.004, seed: 70 });
  assert.equal(hits.length, events.length);
  // Steady hiss alone triggers nothing.
  const quiet = createListener({ sampleRate: sr });
  quiet.setSensitivity(1);
  const hiss = addNoise(new Float32Array(sr * 3), rng(71), 0.02);
  let count = 0;
  quiet.onHit(() => count++);
  quiet.feed(hiss, 0);
  assert.equal(count, 0);
});

test('fast playing: 16th notes at 120 bpm (125 ms apart) are all separate hits', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  const events = [];
  for (let k = 0; k < 32; k++) events.push({ t: 0.5 + k * 0.125, make: drum(sr, k % 2 ? 'snare' : 'hihat'), g: k % 4 ? 0.5 : 0.9 });
  const hits = play(L, sr, events, { seed: 80 });
  assert.equal(hits.length, events.length);
});

test('sensitivity: soft taps need a high setting; hard hits always register', () => {
  const sr = 48000;
  const soft = [0, 1, 2, 3].map((k) => ({ t: 0.5 + k * 0.5, make: (rand) => thwack(sr, rand), g: 0.05 }));
  const hard = [0, 1, 2, 3].map((k) => ({ t: 0.5 + k * 0.5, make: drum(sr, 'snare'), g: 0.9 }));
  const low = createListener({ sampleRate: sr });
  low.setSensitivity(0);
  assert.equal(play(low, sr, soft).length, 0);
  assert.equal(play(low, sr, hard).length, 4);
  const high = createListener({ sampleRate: sr });
  high.setSensitivity(1);
  assert.equal(play(high, sr, soft).length, 4);
});

test('latency is subtracted from hit times', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  L.setLatencySec(0.085);
  assert.equal(L.getLatencySec(), 0.085);
  const hits = play(L, sr, [{ t: 1.0, make: drum(sr, 'snare') }]);
  assert.equal(hits.length, 1);
  assert.ok(Math.abs(hits[0].time - (1.0 - 0.085)) < 0.003);
});

test('reference gate raises the bar while a backing-track hit is expected', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  L.setLatencySec(0.05);
  // Quiet bleed of a backing snare at t=1.0 and t=2.0; the player hits hard at t=1.5.
  const events = [
    { t: 1.0, make: drum(sr, 'snare'), g: 0.03 },
    { t: 1.5, make: drum(sr, 'snare'), g: 0.9 },
    { t: 2.0, make: drum(sr, 'snare'), g: 0.03 },
  ];
  assert.equal(play(L, sr, events).length, 3, 'without the gate the bleed is heard as hits');
  // The game schedules those backing hits at 0.95 and 1.95 on its clock (they arrive 50 ms later).
  const seen = [];
  L.setReferenceGate((time) => { seen.push(time); return [0.95, 1.95].some((x) => Math.abs(time - CLOCK - x) < 0.03); });
  const gated = play(L, sr, events);
  assert.equal(gated.length, 1);
  assert.ok(Math.abs(gated[0].time - 1.45) < 0.005);
  assert.ok(seen.length > 100);
  // A hard hit during the gate still gets through.
  const loud = play(L, sr, [{ t: 1.0, make: drum(sr, 'snare'), g: 0.9 }]);
  assert.equal(loud.length, 1);
  L.setReferenceGate(null);
  assert.equal(play(L, sr, events).length, 3);
});

test('profile is JSON-serialisable and restores the trained kit on a new listener', () => {
  const sr = 48000;
  const A = createListener({ sampleRate: sr });
  trainKit(A, sr, ['kick', 'snare', 'hihat']);
  A.setLatencySec(0.07);
  A.setSensitivity(0.8);
  const json = JSON.stringify(A.getProfile());
  const profile = JSON.parse(json);
  assert.equal(profile.latencySec, 0.07);
  assert.equal(profile.sensitivity, 0.8);
  assert.equal(profile.lanes.snare.examples[0].length, FEATURE_DIM);
  assert.ok(Array.isArray(profile.noiseFloorDb));
  assert.ok(json.length < 20000, `profile is small (${json.length} bytes)`);

  const B = createListener({ sampleRate: sr });
  B.setProfile(profile);
  assert.equal(B.getLatencySec(), 0.07);
  assert.deepEqual(B.trainedLanes(), A.trainedLanes());
  const events = ['kick', 'snare', 'hihat', 'snare', 'kick'].map((lane, i) => ({ t: 0.5 + i * 0.4, make: drum(sr, lane), lane }));
  const hits = play(B, sr, events);
  assert.deepEqual(hits.map((h) => h.lane), events.map((e) => e.lane));
  assert.ok(hits.every((h) => Math.abs(h.time + 0.07 - events[hits.indexOf(h)].t) < 0.005));

  // Garbage must not throw or wipe anything.
  for (const bad of [null, 42, 'x', {}, { lanes: { snare: { examples: [[1, 2]] } } }, { version: 99, lanes: profile.lanes }]) {
    const C = createListener({ sampleRate: sr });
    assert.doesNotThrow(() => C.setProfile(bad));
    assert.deepEqual(C.trainedLanes(), []);
  }
});

test('level meter: about 20 callbacks per second with a sane RMS', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  const levels = [];
  const off = L.onLevel((v) => levels.push(v));
  const x = new Float32Array(sr * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  for (let i = 0; i < x.length; i += 128) L.feed(x.subarray(i, i + 128), i / sr);
  off();
  assert.ok(levels.length >= 38 && levels.length <= 41, `${levels.length} level callbacks in 2 s`);
  assert.ok(levels.every((v) => Math.abs(v - 0.3536) < 0.01));
  L.feed(x.subarray(0, 4800), 2);
  assert.equal(levels.length <= 41, true, 'unsubscribed');
});

test('loopback latency: clicks delayed by a known amount are measured within 2 ms', () => {
  const sr = 48000;
  const D = new HitDetector(sr);
  D.setSensitivity(0.8);
  D.muted = true;
  const trueLatency = 0.137;
  const clickTimes = [0, 0.31, 0.57, 0.9, 1.19, 1.53].map((g) => CLOCK + 0.35 + g);
  const out = addNoise(new Float32Array(sr * 3), rng(90), 0.002);
  for (const t of clickTimes) {
    const at = Math.round((t - CLOCK + trueLatency) * sr);
    for (let i = 0; i < 192; i++) out[at + i] += 0.2 * Math.sin((2 * Math.PI * 2500 * i) / sr) * Math.exp(-i / (sr * 0.001));
  }
  const onsets = [];
  let hits = 0;
  D.onRawOnset = (o) => onsets.push(o.time);
  D.onHit = () => hits++;
  for (let i = 0; i < out.length; i += 256) D.process(out.subarray(i, i + 256), CLOCK + i / sr);
  assert.equal(hits, 0, 'calibration clicks are not reported as drum hits');
  const r = estimateLoopbackLatency(clickTimes, onsets);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.latencySec - trueLatency) < 0.002, `measured ${(r.latencySec * 1000).toFixed(1)} ms`);

  // Too few clicks heard, or inconsistent delays -> not ok.
  assert.equal(estimateLoopbackLatency(clickTimes, onsets.slice(0, 2)).ok, false);
  assert.equal(estimateLoopbackLatency(clickTimes, []).ok, false);
  const scattered = clickTimes.map((t, i) => t + 0.05 + i * 0.04);
  assert.equal(estimateLoopbackLatency(clickTimes, scattered).ok, false);
});

test('listener without a browser: start() rejects with a clear Error, nothing throws at import', async () => {
  const L = createListener({ sampleRate: 48000, currentTime: 0 });
  assert.equal(L.isRunning(), false);
  await assert.rejects(() => L.start(), /microphone/i);
  assert.doesNotThrow(() => L.stop());
  const r = await L.measureLatencyLoopback();
  assert.equal(r.ok, false);
  assert.equal(typeof createListener(null).feed, 'function');
});

test('classifier maths: identical templates are confusable, distinct ones are not', () => {
  const C = new DrumClassifier();
  const rand = rng(3);
  const base = Array.from({ length: FEATURE_DIM }, (_, i) => -3 + Math.sin(i));
  const other = base.map((v, i) => v + (i < 7 ? 3 : -3));
  const jitter = (v) => v.map((x) => x + (rand() - 0.5) * 0.4);
  for (let k = 0; k < 6; k++) { C.addExample('snare', jitter(base)); C.addExample('tom1', jitter(base)); C.addExample('kick', jitter(other)); }
  assert.ok(C.templateDistance('snare', 'tom1') < 1);
  assert.ok(C.templateDistance('snare', 'kick') > 6);
  assert.deepEqual(C.classify(jitter(base)).lanes, []);
  const k = C.classify(jitter(other));
  assert.equal(k.lanes.length, 1);
  assert.equal(k.lanes[0].lane, 'kick');
  assert.ok(k.lanes[0].confidence > 0.7);
});

test('real-time cost: 10 s of audio is processed far faster than real time', () => {
  const sr = 48000;
  const L = createListener({ sampleRate: sr });
  trainKit(L, sr, ['kick', 'snare', 'hihat']);
  const events = [];
  for (let k = 0; k < 40; k++) events.push({ t: 0.5 + k * 0.23, make: drum(sr, ['kick', 'hihat', 'snare', 'hihat'][k % 4]) });
  const rand = rng(1);
  const out = new Float32Array(sr * 10);
  for (const e of events) place(out, e.make(rand), Math.round(e.t * sr));
  const t0 = performance.now();
  for (let i = 0; i < out.length; i += 256) L.feed(out.subarray(i, i + 256), i / sr);
  const ms = performance.now() - t0;
  assert.ok(ms < 2500, `took ${ms.toFixed(0)} ms for 10 s of audio`);
});

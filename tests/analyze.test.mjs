// Tests for js/analyze.js on synthesised drum loops with known tempo and note times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, detectTempo } from '../js/analyze.js';
import { drumLoop, rng, addNoise } from './dsp-synth.mjs';

const LANES = ['kick', 'snare', 'hihat', 'crash'];

/** Greedy one-to-one matching of notes within `tol` seconds, per lane. */
function score(truth, got, tol = 0.035) {
  const out = {};
  for (const lane of LANES) {
    const T = truth.filter((n) => n.lane === lane).map((n) => n.t);
    const G = got.filter((n) => n.lane === lane).map((n) => n.t);
    const used = new Set();
    let tp = 0;
    for (const t of T) {
      let best = -1, bestDist = tol;
      G.forEach((g, i) => { if (!used.has(i) && Math.abs(g - t) <= bestDist) { bestDist = Math.abs(g - t); best = i; } });
      if (best >= 0) { used.add(best); tp++; }
    }
    out[lane] = { truth: T.length, got: G.length, recall: T.length ? tp / T.length : 1, precision: G.length ? tp / G.length : 1 };
  }
  return out;
}

/** Distance from x to the nearest multiple of `period` after removing `origin`. */
function phaseError(x, origin, period) {
  const d = (((x - origin) % period) + period) % period;
  return Math.min(d, period - d);
}

const describe = (s) => LANES.map((l) => `${l} R${s[l].recall.toFixed(2)} P${s[l].precision.toFixed(2)}`).join(', ');

for (const bpm of [70, 96, 120, 140]) {
  test(`detectTempo: ${bpm} bpm loop -> tempo within 2%, beat phase and bar start right`, async () => {
    const offsetSec = 0.3 + bpm / 1000;
    const loop = drumLoop(44100, { bpm, bars: 12, offsetSec, seed: bpm });
    const r = await detectTempo(loop);
    assert.ok(Math.abs(r.bpm / bpm - 1) < 0.02, `bpm ${r.bpm}`);
    assert.ok(Math.abs(r.bpm / bpm - 1) < 0.003, `expected a much closer tempo on a steady loop, got ${r.bpm}`);
    const beat = 60 / bpm;
    assert.ok(r.beats.length >= 40, `${r.beats.length} beats`);
    const worstBeat = Math.max(...r.beats.slice(0, 44).map((b) => phaseError(b, offsetSec, beat)));
    assert.ok(worstBeat < 0.025, `beats are on the beat (worst ${(worstBeat * 1000).toFixed(1)} ms)`);
    assert.ok(phaseError(r.offsetSec, offsetSec, 4 * beat) < 0.025, `offsetSec ${r.offsetSec} is a bar start (true ${offsetSec})`);
    assert.ok(r.offsetSec >= 0 && r.offsetSec < 4 * beat + 0.03);
    assert.ok(r.confidence > 0.6 && r.confidence <= 1, `confidence ${r.confidence}`);
    for (let i = 1; i < r.beats.length; i++) assert.ok(r.beats[i] > r.beats[i - 1]);
  });
}

for (const [sampleRate, bpm, bed] of [[44100, 96, false], [44100, 96, true], [48000, 120, false], [48000, 120, true], [44100, 140, true], [48000, 70, true]]) {
  test(`analyzeAudio: ${bpm} bpm at ${sampleRate} Hz ${bed ? 'with bass + pad bed' : 'drums only'}`, async () => {
    const offsetSec = 0.42;
    const loop = drumLoop(sampleRate, { bpm, bars: 16, offsetSec, bed, seed: bpm + (bed ? 1 : 0) });
    const r = await analyzeAudio(loop);
    assert.ok(Math.abs(r.bpm / bpm - 1) < 0.02, `bpm ${r.bpm}`);
    assert.equal(r.beatsPerBar, 4);
    assert.ok(phaseError(r.offsetSec, offsetSec, (4 * 60) / bpm) < 0.025, `offsetSec ${r.offsetSec}`);
    const s = score(loop.notes, r.notes);
    const msg = describe(s);
    assert.ok(s.kick.recall >= 0.9 && s.kick.precision >= 0.9, msg);
    assert.ok(s.snare.recall >= 0.9 && s.snare.precision >= 0.9, msg);
    assert.ok(s.hihat.recall >= 0.8 && s.hihat.precision >= 0.9, msg);
    assert.ok(s.crash.recall >= 0.75 && s.crash.precision >= 0.75, msg);
    assert.ok(r.confidence >= 0.6 && r.confidence <= 1, `confidence ${r.confidence}`);

    // Shape of the result: only the four lanes, sorted, velocities in range, on the 16th grid.
    assert.ok(r.notes.every((n) => LANES.includes(n.lane) && n.vel > 0 && n.vel <= 1 && n.t >= 0));
    for (let i = 1; i < r.notes.length; i++) assert.ok(r.notes[i].t >= r.notes[i - 1].t);
    const step = 60 / r.bpm / 4;
    const offGrid = r.notes.filter((n) => phaseError(n.t, r.offsetSec, step) > 0.02).length;
    assert.ok(offGrid <= r.notes.length * 0.02, `${offGrid} notes off the 16th grid`);
  });
}

test('a loud bass + pad bed costs recall, not precision, and lowers the confidence', async () => {
  const clean = await analyzeAudio(drumLoop(44100, { bpm: 96, bars: 16, offsetSec: 0.42, seed: 96 }));
  for (const bedGain of [2, 4, 8]) {
    // bedGain 2: bass about 8 dB under the kick. bedGain 8: bass louder than the kick, pad as loud as the snare.
    const loop = drumLoop(44100, { bpm: 96, bars: 16, offsetSec: 0.42, bed: true, bedGain, seed: 96 });
    const r = await analyzeAudio(loop);
    assert.ok(Math.abs(r.bpm / 96 - 1) < 0.02, `bpm ${r.bpm}`);
    const s = score(loop.notes, r.notes);
    assert.ok(s.kick.precision >= 0.85, `bed x${bedGain}: ${describe(s)}`);
    assert.ok(s.kick.recall >= 0.5, `bed x${bedGain}: ${describe(s)}`);
    assert.ok(s.hihat.precision >= 0.9, `bed x${bedGain}: ${describe(s)}`);
    assert.ok(r.confidence < clean.confidence, `bed x${bedGain}: confidence ${r.confidence} vs clean ${clean.confidence}`);
    if (bedGain === 8) assert.ok(r.confidence < 0.6 && s.snare.got === 0, `confidence ${r.confidence} when the snare cannot be found`);
  }
});

test('analyzeAudio follows a drummer who speeds up (100 -> 108 bpm)', async () => {
  // The loop helper is fixed-tempo, so stitch bars of increasing tempo together.
  const sr = 44100, bars = 24;
  const parts = [], truth = [];
  let t = 0.5, total = Math.round(0.5 * sr);
  for (let bar = 0; bar < bars; bar++) {
    const bpm = 100 + (8 * bar) / bars;
    const one = drumLoop(sr, { bpm, bars: 1, offsetSec: 0, seed: 200 + bar });
    const len = Math.round(((4 * 60) / bpm) * sr);
    parts.push({ at: total, data: one.channelData });
    for (const n of one.notes) if (n.lane !== 'crash') truth.push({ t: total / sr + n.t, lane: n.lane });
    else truth.push({ t: total / sr + n.t, lane: 'crash' });
    total += len; t += (4 * 60) / bpm;
  }
  const channelData = new Float32Array(total + sr);
  for (const p of parts) for (let i = 0; i < p.data.length && p.at + i < channelData.length; i++) channelData[p.at + i] += p.data[i];
  const r = await analyzeAudio({ channelData, sampleRate: sr });
  assert.ok(r.bpm > 98 && r.bpm < 110, `bpm ${r.bpm}`);
  const s = score(truth, r.notes, 0.04);
  assert.ok(s.kick.recall >= 0.85 && s.kick.precision >= 0.85, describe(s));
  assert.ok(s.snare.recall >= 0.85 && s.snare.precision >= 0.85, describe(s));
});

test('non-drum audio: few or no notes and a low confidence', async () => {
  const sr = 44100, n = sr * 20;
  const pad = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    pad[i] = 0.1 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.2 * t));
  }
  const a = await analyzeAudio({ channelData: pad, sampleRate: sr });
  assert.ok(a.notes.length <= 4, `${a.notes.length} notes from a pad`);
  assert.ok(a.confidence < 0.4, `confidence ${a.confidence}`);

  const hiss = addNoise(new Float32Array(n), rng(2), 0.1);
  const b = await analyzeAudio({ channelData: hiss, sampleRate: sr });
  assert.ok(b.confidence < 0.4, `confidence ${b.confidence} on noise`);

  const silent = await analyzeAudio({ channelData: new Float32Array(n), sampleRate: sr });
  assert.deepEqual(silent.notes, []);
  assert.equal(silent.confidence, 0);
  assert.ok(silent.bpm >= 60 && silent.bpm <= 180);

  for (const input of [{ channelData: new Float32Array(0), sampleRate: sr }, { channelData: new Float32Array(500), sampleRate: sr }]) {
    const r = await analyzeAudio(input);
    assert.deepEqual(r.notes, []);
    assert.ok(Number.isFinite(r.bpm) && Number.isFinite(r.offsetSec));
    const t = await detectTempo(input);
    assert.ok(Number.isFinite(t.bpm) && Array.isArray(t.beats));
  }
});

test('a four-minute song: reports progress, keeps yielding, finishes quickly', async () => {
  const sr = 48000;
  const loop = drumLoop(sr, { bpm: 104, bars: 104, offsetSec: 1.2, bed: true, seed: 9 });
  assert.ok(loop.channelData.length / sr > 235);
  const progress = [];
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);       // only fires if the analysis yields
  const t0 = performance.now();
  const r = await analyzeAudio(loop, { onProgress: (p) => progress.push(p) });
  const ms = performance.now() - t0;
  clearInterval(timer);
  assert.ok(Math.abs(r.bpm / 104 - 1) < 0.005, `bpm ${r.bpm}`);
  const s = score(loop.notes, r.notes);
  assert.ok(s.kick.recall >= 0.9 && s.kick.precision >= 0.9 && s.snare.recall >= 0.9 && s.snare.precision >= 0.9, describe(s));
  assert.ok(progress.length >= 5, `${progress.length} progress calls`);
  assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1])), 'progress is monotonic in 0..1');
  assert.equal(progress[progress.length - 1], 1);
  assert.ok(ticks >= 5, `event loop got ${ticks} turns during the analysis`);
  assert.ok(ms < 20000, `took ${ms.toFixed(0)} ms`);
});

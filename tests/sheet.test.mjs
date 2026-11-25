import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSheetReadingAvailable, sheetPhotosToChart, sheetJsonToChart, validateSheetJson, extractJson, buildSheetPrompt, normaliseLane,
} from '../js/sheet.js';
import { validateChart } from '../js/charts.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const hadWindow = 'window' in globalThis;
const origWindow = globalThis.window;
afterEach(() => { if (hadWindow) globalThis.window = origWindow; else delete globalThis.window; });

const GOOD = {
  bpm: 100, beatsPerBar: 4, confidence: 0.9,
  bars: [
    { notes: [{ beat: 1, lane: 'kick' }, { beat: 1, lane: 'hihat' }, { beat: 2, lane: 'snare' }, { beat: 2.5, lane: 'hihat' }] },
    { notes: [{ beat: 1, lane: 'crash' }, { beat: 3, lane: 'kick' }] },
  ],
};
const blob = () => new Blob(['x'], { type: 'image/jpeg' });
const mockClaude = (sample) => { globalThis.window = { claude: { use: async (k) => (k === 'sample' ? sample : null) } }; };

test('prompt describes notation and demands JSON', () => {
  const p = buildSheetPrompt();
  for (const w of ['kick', 'snare', 'hihat', 'crash', 'ride', 'tom1', 'floor', 'BOTTOM space', 'THIRD space', 'JSON', 'beatsPerBar']) {
    assert.ok(p.includes(w), w);
  }
  assert.ok(buildSheetPrompt({ retry: true }).length > p.length);
});

test('sheetJsonToChart converts beats to seconds', () => {
  const c = sheetJsonToChart(GOOD, { title: 'Page 1' });
  assert.equal(c.source, 'sheet');
  assert.equal(c.title, 'Page 1');
  assert.equal(c.bpm, 100); // taken from the sheet when not supplied
  assert.equal(c.beatsPerBar, 4);
  assert.equal(c.offsetSec, 0);
  assert.equal(c.audioId, null);
  close(c.durationSec, 8 * 0.6);
  const find = (lane, i = 0) => c.notes.filter((n) => n.lane === lane)[i].t;
  close(find('snare'), 0.6);
  close(find('hihat', 1), 0.9); // beat 2.5
  close(find('crash'), 2.4); // bar 2 beat 1
  close(find('kick', 1), 2.4 + 1.2);
  assert.equal(c.meta.confidence, 0.9);
  assert.deepEqual(validateChart(c), { ok: true, errors: [] });
});

test('explicit bpm option wins, default 80', () => {
  assert.equal(sheetJsonToChart(GOOD, { bpm: 70 }).bpm, 70);
  const noBpm = { ...GOOD, bpm: undefined };
  assert.equal(sheetJsonToChart(noBpm).bpm, 80);
  assert.equal(sheetJsonToChart(noBpm).title, 'Sheet music');
});

test('repair: aliases, unknown lanes, clamping, duplicates, trailing empty bars, string numbers', () => {
  const messy = {
    beatsPerBar: '3', bpm: 'fast',
    bars: [
      { notes: [{ beat: '1', lane: 'Bass Drum' }, { beat: 0, lane: 'HH' }, { beat: 9, lane: 'snare' }, { beat: 2, lane: 'cowbell' },
        { beat: 'x', lane: 'kick' }, { beat: 1, lane: 'kick' }, null, { beat: 2, lane: 'Floor-Tom' }] },
      [{ beat: 2, lane: 'ride' }],
      { notes: [] },
      {},
    ],
  };
  const v = validateSheetJson(messy);
  assert.equal(v.beatsPerBar, 3);
  assert.equal(v.bpm, null);
  assert.equal(v.bars.length, 2);
  const lanes = v.bars[0].notes.map((n) => `${n.beat}:${n.lane}`);
  assert.deepEqual(lanes, ['1:hihat', '1:kick', '2:floor', `${3 + 1 - 1 / 48 > 0 ? Math.round((4 - 1 / 48) * 1000) / 1000 : 0}:snare`]);
  assert.ok(v.warnings.length >= 2);
  assert.deepEqual(v.bars[1].notes, [{ beat: 2, lane: 'ride' }]);
  const c = sheetJsonToChart(messy, { bpm: 60 });
  assert.equal(c.beatsPerBar, 3);
  assert.deepEqual(validateChart(c), { ok: true, errors: [] });
  assert.ok(c.notes.every((n) => n.t < c.durationSec));
});

test('repair: bad beatsPerBar falls back to 4; bars as bare array; JSON text with fences', () => {
  assert.equal(validateSheetJson({ beatsPerBar: 99, bars: GOOD.bars }).beatsPerBar, 4);
  assert.equal(validateSheetJson(GOOD.bars).bars.length, 2);
  const fenced = 'Sure! Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```\nHope that helps';
  assert.equal(sheetJsonToChart(fenced).notes.length, 6);
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.throws(() => extractJson('no json here'), /not valid JSON/);
  assert.throws(() => extractJson(undefined), /nothing readable/);
});

test('unusable content is rejected with clear messages', () => {
  assert.throws(() => sheetJsonToChart({ error: 'This is a photo of a cat' }), /cat/);
  assert.throws(() => sheetJsonToChart({ bars: [] }), /any drum notes/);
  assert.throws(() => sheetJsonToChart({ bars: [{ notes: [{ beat: 1, lane: 'kazoo' }] }] }), /any drum notes/);
  assert.throws(() => sheetJsonToChart({ hello: 1 }), /no bars/);
  assert.throws(() => sheetJsonToChart('[[[ broken'), /valid JSON/);
});

test('normaliseLane', () => {
  assert.equal(normaliseLane('Closed Hi-Hat'), 'hihat');
  assert.equal(normaliseLane('KICK'), 'kick');
  assert.equal(normaliseLane('high tom'), 'tom1');
  assert.equal(normaliseLane(5), null);
  assert.equal(normaliseLane('guiro'), null);
});

test('unavailable: no window, no claude, use returns null, limits.images falsy', async () => {
  delete globalThis.window;
  assert.equal(await isSheetReadingAvailable(), false);
  await assert.rejects(sheetPhotosToChart([blob()]), /not available/);

  globalThis.window = {};
  assert.equal(await isSheetReadingAvailable(), false);
  globalThis.window = { claude: {} };
  assert.equal(await isSheetReadingAvailable(), false);
  globalThis.window = { claude: { use: async () => null } };
  assert.equal(await isSheetReadingAvailable(), false);
  globalThis.window = { claude: { use: async () => { throw new Error('boom'); } } };
  assert.equal(await isSheetReadingAvailable(), false);
  await assert.rejects(sheetPhotosToChart([blob()]), /not available/);

  let called = 0;
  mockClaude({ limits: async () => ({ images: 0 }), json: async () => { called++; return GOOD; } });
  assert.equal(await isSheetReadingAvailable(), false);
  await assert.rejects(sheetPhotosToChart([blob()]), /not available/);
  assert.equal(called, 0);
});

test('available path: calls sample.json with prompt, images and modelTier; reports progress', async () => {
  const calls = [];
  mockClaude({ limits: async () => ({ images: 5 }), json: async (prompt, opts) => { calls.push({ prompt, opts }); return GOOD; } });
  assert.equal(await isSheetReadingAvailable(), true);
  const blobs = [blob(), blob()];
  const prog = [];
  const chart = await sheetPhotosToChart(blobs, { title: 'Lesson', bpm: 90, onProgress: (x) => prog.push(x) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.modelTier, 'complex');
  assert.deepEqual(calls[0].opts.images, blobs);
  assert.ok(/JSON/.test(calls[0].prompt));
  assert.equal(chart.title, 'Lesson');
  assert.equal(chart.bpm, 90);
  assert.equal(chart.source, 'sheet');
  assert.equal(prog[0], 0);
  assert.equal(prog.at(-1), 1);
  assert.deepEqual([...prog].sort((a, b) => a - b), prog);
});

test('input validation and photo limits', async () => {
  mockClaude({ limits: async () => ({ images: 2 }), json: async () => GOOD });
  await assert.rejects(sheetPhotosToChart([]), /at least one photo/);
  await assert.rejects(sheetPhotosToChart(null), /at least one photo/);
  await assert.rejects(sheetPhotosToChart([new Blob([])]), /empty/);
  await assert.rejects(sheetPhotosToChart([blob(), blob(), blob()]), /at most 2/);
});

test('malformed responses: retried once, then a clear error', async () => {
  let n = 0;
  mockClaude({ limits: async () => ({ images: true }), json: async () => { n++; return 'I could not do that, sorry'; } });
  await assert.rejects(sheetPhotosToChart([blob()]), /valid JSON/);
  assert.equal(n, 2);

  n = 0;
  mockClaude({ limits: async () => ({ images: true }), json: async () => { n++; return n === 1 ? { nonsense: true } : GOOD; } });
  const c = await sheetPhotosToChart([blob()]);
  assert.equal(n, 2);
  assert.equal(c.notes.length, 6);

  n = 0;
  mockClaude({ limits: async () => ({ images: true }), json: async () => { n++; return { error: 'blurry' }; } });
  await assert.rejects(sheetPhotosToChart([blob()]), /blurry/);
  assert.equal(n, 1); // unreadable photo: no pointless retry

  mockClaude({ limits: async () => ({ images: true }), json: async () => ({ bars: [{ notes: [{ beat: 1, lane: 'banjo' }] }] }) });
  await assert.rejects(sheetPhotosToChart([blob()]), /any drum notes/);
});

test('sample.json throwing becomes a friendly error', async () => {
  mockClaude({ limits: async () => ({ images: true }), json: async () => { throw new Error('network down'); } });
  await assert.rejects(sheetPhotosToChart([blob()]), /could not look at the photo.*network down/);
});

test('onProgress that throws does not break the import', async () => {
  mockClaude({ limits: async () => ({ images: true }), json: async () => GOOD });
  const c = await sheetPhotosToChart([blob()], { onProgress: () => { throw new Error('ui'); } });
  assert.equal(c.source, 'sheet');
});

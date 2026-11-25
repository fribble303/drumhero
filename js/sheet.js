// sheet.js - turn photos of drum sheet music into a Chart using the host page's AI helper.
// Pure helpers (prompt, JSON repair, conversion) are exported so they can be tested in Node.
// Never touches window/navigator at import time.

import { LANES, uuid } from './charts.js';

const LANE_INDEX = new Map(LANES.map((l, i) => [l, i]));

const LANE_ALIASES = (() => {
  const m = {};
  const add = (lane, names) => names.forEach((n) => { m[n] = lane; });
  add('kick', ['kick', 'bass', 'bassdrum', 'bd', 'kickdrum', 'bassdrum1']);
  add('snare', ['snare', 'sd', 'snaredrum', 'sidestick', 'crossstick', 'rimshot', 'rim']);
  add('hihat', ['hihat', 'hh', 'hat', 'hats', 'hihatclosed', 'closedhihat', 'hihatopen', 'openhihat', 'pedalhihat', 'hihatpedal', 'hihatfoot']);
  add('crash', ['crash', 'crashcymbal', 'cc', 'crash1', 'crash2']);
  add('ride', ['ride', 'ridecymbal', 'ridebell']);
  add('tom1', ['tom1', 'hightom', 'tomhigh', 'hitom', 'tom']);
  add('tom2', ['tom2', 'midtom', 'tommid', 'lowmidtom', 'lowtom', 'tomlow']);
  add('floor', ['floor', 'floortom', 'ft', 'lowfloortom']);
  return m;
})();

export function normaliseLane(x) {
  if (typeof x !== 'string') return null;
  const k = x.toLowerCase().replace(/[^a-z0-9]/g, '');
  return LANE_ALIASES[k] ?? null;
}

/** The prompt sent to the AI helper along with the photos. */
export function buildSheetPrompt({ retry = false } = {}) {
  return `You are reading a photo of DRUM SHEET MUSIC (percussion clef, five-line staff). Transcribe every drum note you can see, bar by bar, into strict JSON.

How standard drum notation maps to drums. Lines are numbered 1 (bottom) to 5 (top); spaces 1 (bottom) to 4 (top):
- "kick" (bass drum): note head in the BOTTOM space (space 1), stem usually pointing down.
- "floor" (floor tom): note head in space 2.
- "snare": note head in the THIRD space (space 3). A snare with a slash or "ghost" parentheses is still "snare".
- "tom2" (mid/low rack tom): note head ON line 4.
- "tom1" (high tom): note head in the TOP space (space 4).
- "hihat": an X note head in the space just ABOVE the top line (also "o" or "+" marks on those X's = open/closed hi-hat; still "hihat"). A hi-hat played with the foot is an X below the staff: also "hihat".
- "ride": an X note head ON the top line (line 5).
- "crash": an X note head on a short ledger line well ABOVE the staff, often with an accent or a bigger mark.
Round (non-X) heads are drums; X heads are cymbals/hi-hat. Stems up are usually hands, stems down are feet, and they can sit on the same beat (play together).

Timing rules:
- Use quarter-note beats. "beat" is a 1-based number: the first beat of a bar is 1, an 8th note after it is 1.5, 16ths are 1.25 / 1.5 / 1.75, triplet 8ths are 1, 1.3333, 1.6667.
- "beatsPerBar" is the number of QUARTER-note beats in a bar, as a whole number (4/4 -> 4, 3/4 -> 3, 6/8 -> 3, 2/4 -> 2). Look for the time signature; assume 4 if there is none.
- Read bars left to right, top system to bottom system, and across all photos in the order given. Write out repeats in full (maximum 64 bars). Ignore rests, lyrics, chord symbols and dynamics.
- If a tempo marking such as "q = 96" is printed, include it as "bpm"; otherwise leave "bpm" out.
- Notes that happen at the same time are separate objects with the same "beat".
- An empty bar is {"notes": []}.

Allowed lane values (use exactly these strings): "kick", "snare", "hihat", "crash", "ride", "tom1", "tom2", "floor".

Reply with ONLY one JSON object. No markdown, no code fences, no commentary. Shape:
{"bpm": 96, "beatsPerBar": 4, "confidence": 0.8, "bars": [ {"notes": [ {"beat": 1, "lane": "kick"}, {"beat": 1, "lane": "hihat"}, {"beat": 1.5, "lane": "hihat"}, {"beat": 2, "lane": "snare"} ]} ]}
"confidence" is your honest 0 to 1 estimate of how sure you are. If the picture is not drum notation or is unreadable, reply instead with {"error": "short reason a child's parent can understand"}.${retry ? '\n\nYour previous reply could not be used. Reply with ONLY the JSON object described above, nothing else.' : ''}`;
}

/** Pull a JSON value out of a model reply (object already, bare JSON, fenced JSON, or JSON buried in text). */
export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new Error('The AI helper sent back nothing readable.');
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try { return JSON.parse(text.slice(a, b + 1)); } catch { /* try next */ }
    }
  }
  throw new Error('The AI helper sent back something that was not valid JSON.');
}

const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : NaN;
  if (typeof x === 'string' && x.trim() !== '') return Number(x);
  return NaN;
};

const MAX_BARS = 200;
const MAX_NOTES = 6000;

/**
 * Validate and repair the model's JSON. Returns { bpm|null, beatsPerBar, bars:[{notes:[{beat,lane}]}],
 * confidence|null, warnings:[string] }. Throws Error (UI-friendly) if nothing usable.
 * Repairs: lane aliases, unknown lanes dropped, beats clamped into the bar, duplicates removed,
 * trailing empty bars trimmed, bad beatsPerBar -> 4.
 */
export function validateSheetJson(raw) {
  const data = extractJson(raw);
  const warnings = [];
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.error === 'string' && data.error.trim()) {
    const err = new Error(`Could not read that sheet music: ${data.error.trim()}`);
    err.unreadable = true; // the model looked and said no: retrying will not help
    throw err;
  }
  let barsIn;
  if (Array.isArray(data)) barsIn = data;
  else if (data && Array.isArray(data.bars)) barsIn = data.bars;
  else if (data && Array.isArray(data.measures)) barsIn = data.measures;
  else throw new Error('Could not read that sheet music: the answer had no bars in it.');

  let beatsPerBar = 4;
  const bpbRaw = Array.isArray(data) ? NaN : num(data.beatsPerBar);
  if (Number.isFinite(bpbRaw) && bpbRaw >= 1 && bpbRaw <= 12) beatsPerBar = Math.round(bpbRaw);
  else if (!Array.isArray(data) && data.beatsPerBar !== undefined) warnings.push('Time signature unclear, assumed 4 beats per bar.');

  const bpmRaw = Array.isArray(data) ? NaN : num(data.bpm);
  const bpm = Number.isFinite(bpmRaw) && bpmRaw >= 30 && bpmRaw <= 300 ? bpmRaw : null;
  const confRaw = Array.isArray(data) ? NaN : num(data.confidence);
  const confidence = Number.isFinite(confRaw) && confRaw >= 0 && confRaw <= 1 ? confRaw : null;

  if (barsIn.length > MAX_BARS) {
    warnings.push(`Only the first ${MAX_BARS} bars were used.`);
    barsIn = barsIn.slice(0, MAX_BARS);
  }
  const maxBeat = beatsPerBar + 1 - 1 / 48;
  let dropped = 0;
  let clamped = 0;
  let total = 0;
  const bars = barsIn.map((bar) => {
    const list = Array.isArray(bar) ? bar : bar && Array.isArray(bar.notes) ? bar.notes : [];
    const seen = new Set();
    const notes = [];
    for (const n of list) {
      const lane = normaliseLane(n && n.lane);
      let beat = num(n && n.beat);
      if (!lane || !Number.isFinite(beat) || total >= MAX_NOTES) { dropped++; continue; }
      if (beat < 1 || beat > maxBeat) { clamped++; beat = Math.min(maxBeat, Math.max(1, beat)); }
      beat = Math.round(beat * 1000) / 1000;
      const key = `${lane}@${beat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push({ beat, lane });
      total++;
    }
    notes.sort((a, b) => a.beat - b.beat || LANE_INDEX.get(a.lane) - LANE_INDEX.get(b.lane));
    return { notes };
  });
  while (bars.length && !bars[bars.length - 1].notes.length) bars.pop();
  if (dropped) warnings.push(`${dropped} unreadable note${dropped === 1 ? '' : 's'} skipped.`);
  if (clamped) warnings.push(`${clamped} note${clamped === 1 ? '' : 's'} moved back inside their bar.`);
  if (!total) throw new Error('Could not find any drum notes in that photo. Try a closer, brighter, straight-on picture.');
  return { bpm, beatsPerBar, bars, confidence, warnings };
}

/** Pure: model JSON (object or text) -> Chart (source 'sheet'). Throws Error on unusable input. */
export function sheetJsonToChart(raw, { title, bpm } = {}) {
  const v = validateSheetJson(raw);
  const useBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : v.bpm ?? 80;
  const beatSec = 60 / useBpm;
  const notes = [];
  v.bars.forEach((bar, i) => {
    for (const n of bar.notes) {
      notes.push({
        t: Math.round((i * v.beatsPerBar + (n.beat - 1)) * beatSec * 1e6) / 1e6,
        lane: n.lane,
        vel: n.lane === 'crash' ? 1 : n.lane === 'hihat' || n.lane === 'ride' ? 0.7 : 0.85,
      });
    }
  });
  notes.sort((a, b) => a.t - b.t || LANE_INDEX.get(a.lane) - LANE_INDEX.get(b.lane));
  const confidence = v.confidence ?? Math.max(0.3, 0.7 - 0.1 * v.warnings.length);
  const noteText = `Read ${v.bars.length} bar${v.bars.length === 1 ? '' : 's'} from a photo.${v.warnings.length ? ` ${v.warnings.join(' ')}` : ''} Please check it looks right.`;
  return {
    id: uuid(),
    title: title || 'Sheet music',
    source: 'sheet',
    bpm: useBpm,
    beatsPerBar: v.beatsPerBar,
    offsetSec: 0,
    durationSec: Math.round(v.bars.length * v.beatsPerBar * beatSec * 1e6) / 1e6,
    audioId: null,
    notes,
    meta: { confidence, notes: noteText },
  };
}

async function getSample() {
  try {
    const w = globalThis.window;
    if (!w || !w.claude || typeof w.claude.use !== 'function') return null;
    const sample = await w.claude.use('sample');
    return sample && typeof sample.json === 'function' ? sample : null;
  } catch {
    return null;
  }
}

async function imagesLimit(sample) {
  try {
    if (typeof sample.limits !== 'function') return null;
    const lim = await sample.limits();
    return lim && lim.images ? lim.images : null;
  } catch {
    return null;
  }
}

/** True when the host page's AI helper can read images. Never throws. */
export async function isSheetReadingAvailable() {
  const sample = await getSample();
  if (!sample) return false;
  return !!(await imagesLimit(sample));
}

const UNAVAILABLE = 'Reading sheet music from photos is not available here. You can still add songs using audio or a MIDI file.';

/**
 * Photos of sheet music -> Chart. Rejects with an Error whose message is safe to show the user.
 * bpm: if given it wins; otherwise a tempo printed on the sheet; otherwise 80.
 */
export async function sheetPhotosToChart(blobs, { title, bpm, onProgress } = {}) {
  const progress = (x) => { try { if (typeof onProgress === 'function') onProgress(x); } catch { /* ignore UI errors */ } };
  if (!Array.isArray(blobs) || !blobs.length || blobs.some((b) => !b)) {
    throw new Error('Please add at least one photo of the sheet music.');
  }
  if (blobs.some((b) => b.size === 0)) throw new Error('One of the photos is empty. Please try taking it again.');
  progress(0);
  const sample = await getSample();
  if (!sample) throw new Error(UNAVAILABLE);
  const images = await imagesLimit(sample);
  if (!images) throw new Error(UNAVAILABLE);
  if (typeof images === 'number' && blobs.length > images) {
    throw new Error(`Please use at most ${images} photo${images === 1 ? '' : 's'} at a time.`);
  }
  progress(0.1);

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await sample.json(buildSheetPrompt({ retry: attempt > 0 }), { images: blobs, modelTier: 'complex' });
    } catch (e) {
      throw new Error(`The AI helper could not look at the photo${e && e.message ? ` (${e.message})` : ''}. Please try again.`);
    }
    progress(attempt === 0 ? 0.8 : 0.95);
    try {
      const chart = sheetJsonToChart(result, { title, bpm });
      progress(1);
      return chart;
    } catch (e) {
      lastErr = e;
      // The photo itself was judged unreadable: retrying won't help.
      if (e.unreadable) break;
    }
  }
  throw lastErr || new Error('Could not read that sheet music.');
}

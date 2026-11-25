// charts.js - chart data model, groove pattern library, difficulty simplification and built-in lessons.
// Pure ES module, no DOM, no dependencies. Importable in Node 20+.

/** Lane order, top of screen to bottom (cymbals high, kick low). */
export const LANES = ['crash', 'ride', 'hihat', 'tom1', 'snare', 'tom2', 'floor', 'kick'];

const LANE_INDEX = new Map(LANES.map((l, i) => [l, i]));
const SOURCES = ['builtin', 'pattern', 'midi', 'audio', 'sheet'];
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** RFC4122-ish v4 uuid. Uses crypto.randomUUID when available. */
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Pattern library
// ---------------------------------------------------------------------------
// steps: lane -> step indices within ONE bar. With grid 16 (default) a 4/4 bar has 16 steps (16th notes).
// With grid 12 a 4/4 bar has 12 steps (triplet 8ths, 3 per beat). Generally stepsPerBar = grid * beatsPerBar / 4.
// `fill: true` marks one-bar fills (used by buildPatternChart's fillEveryBars).

function pat(id, name, level, steps, extra = {}) {
  return { id, name, level, beatsPerBar: 4, grid: 16, fill: false, ...extra, steps };
}

const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14];

export const PATTERNS = [
  pat('kick-snare-quarters', 'Bass drum and snare (quarter notes)', 1, {
    kick: [0, 8], snare: [4, 12],
  }),
  pat('quarter-rock', 'Quarter-note rock', 1, {
    hihat: [0, 4, 8, 12], kick: [0, 8], snare: [4, 12],
  }),
  pat('eighth-rock', '8th-note rock', 2, {
    hihat: EIGHTHS, kick: [0, 8], snare: [4, 12],
  }),
  pat('four-on-the-floor', 'Four on the floor', 2, {
    hihat: [2, 6, 10, 14], kick: [0, 4, 8, 12], snare: [4, 12],
  }),
  pat('half-time', 'Half-time groove', 2, {
    hihat: EIGHTHS, kick: [0], snare: [8],
  }),
  pat('rock-kick-variation', 'Rock with a bouncy bass drum', 2, {
    hihat: EIGHTHS, kick: [0, 6, 8], snare: [4, 12],
  }),
  pat('sixteenth-hat-rock', '16th-note hi-hat rock', 3, {
    hihat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], kick: [0, 8], snare: [4, 12],
  }),
  pat('shuffle', 'Shuffle (triplet feel)', 3, {
    hihat: [0, 2, 3, 5, 6, 8, 9, 11], kick: [0, 6], snare: [3, 9],
  }, { grid: 12 }),
  pat('ride-groove', 'Ride cymbal groove', 3, {
    ride: EIGHTHS, kick: [0, 8], snare: [4, 12],
  }),
  // Fills (one bar each, groove for the first beat or two, then the fill).
  pat('fill-snare', 'Simple snare fill', 2, {
    hihat: [0, 2, 4, 6], kick: [0], snare: [4, 8, 10, 12, 14],
  }, { fill: true }),
  pat('fill-tom-eighths', 'Tom fill (8th notes)', 3, {
    hihat: [0, 2, 4, 6], kick: [0], snare: [4, 8], tom1: [10], tom2: [12], floor: [14],
  }, { fill: true }),
  pat('fill-tom-down', 'Tom roll down (16th notes)', 3, {
    hihat: [0, 2, 4, 6], kick: [0], snare: [4, 8, 9], tom1: [10, 11], tom2: [12, 13], floor: [14, 15],
  }, { fill: true }),
];

const PATTERN_BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));

function stepsPerBar(p) {
  return (p.grid * p.beatsPerBar) / 4;
}

function noteVel(lane, step, p) {
  if (lane === 'crash') return 1;
  if (lane === 'kick' || lane === 'snare') return 0.9;
  if (lane === 'hihat' || lane === 'ride') return step % (p.grid / 4) === 0 ? 0.8 : 0.6;
  return 0.85;
}

function sortNotes(notes) {
  return notes.sort((a, b) => a.t - b.t || LANE_INDEX.get(a.lane) - LANE_INDEX.get(b.lane));
}

/**
 * Render a plan of bars to notes. plan: [{ pattern, crash }] (pattern = pattern object).
 * Each bar spans pattern.beatsPerBar beats; all patterns in a plan must share beatsPerBar.
 */
function renderPlan(plan, { bpm, offsetSec, beatsPerBar }) {
  const barSec = (beatsPerBar * 60) / bpm;
  const notes = [];
  plan.forEach((bar, i) => {
    const start = offsetSec + i * barSec;
    const p = bar.pattern;
    const spb = stepsPerBar(p);
    const stepSec = barSec / spb;
    for (const lane of LANES) {
      const steps = p.steps[lane];
      if (!steps) continue;
      for (const s of steps) {
        notes.push({ t: round6(start + s * stepSec), lane, vel: noteVel(lane, s, p) });
      }
    }
    if (bar.crash) {
      notes.push({ t: round6(start), lane: 'crash', vel: 1 });
    }
  });
  return sortNotes(notes);
}

/**
 * Build a chart from a groove pattern.
 * fillEveryBars: every Nth bar (N, 2N, ...) is replaced by a fill and the bar after gets a crash on beat 1.
 * fillPatternId: which fill to use (default 'fill-snare').
 */
export function buildPatternChart({
  title, bpm, offsetSec = 0, durationSec, patternId, fillEveryBars = 0, audioId = null,
  fillPatternId = 'fill-snare',
}) {
  const p = PATTERN_BY_ID.get(patternId);
  if (!p) throw new Error(`Unknown pattern: ${patternId}`);
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('bpm must be a positive number');
  const fill = PATTERN_BY_ID.get(fillPatternId);
  const useFill = fillEveryBars > 0 && fill && fill.beatsPerBar === p.beatsPerBar;
  const barSec = (p.beatsPerBar * 60) / bpm;
  const hasDur = Number.isFinite(durationSec) && durationSec > 0;
  const bars = hasDur ? Math.max(1, Math.ceil((durationSec - offsetSec) / barSec - 1e-9)) : 16;

  const plan = [];
  for (let b = 1; b <= bars; b++) {
    const isFill = useFill && b % fillEveryBars === 0;
    const afterFill = useFill && b > 1 && (b - 1) % fillEveryBars === 0;
    plan.push({ pattern: isFill ? fill : p, crash: afterFill });
  }
  let notes = renderPlan(plan, { bpm, offsetSec, beatsPerBar: p.beatsPerBar });
  const dur = hasDur ? durationSec : round6(offsetSec + bars * barSec);
  if (hasDur) notes = notes.filter((n) => n.t < dur - 1e-9);
  return {
    id: uuid(),
    title: title || p.name,
    source: 'pattern',
    bpm,
    beatsPerBar: p.beatsPerBar,
    offsetSec,
    durationSec: dur,
    audioId,
    notes,
    meta: { notes: `Pattern: ${p.name}${useFill ? `, fill every ${fillEveryBars} bars` : ''}` },
  };
}

// ---------------------------------------------------------------------------
// Simplify / quantize / validate
// ---------------------------------------------------------------------------

const TOMS = new Set(['tom1', 'tom2', 'floor']);

function dedupeNotes(notes) {
  const best = new Map();
  for (const n of notes) {
    const key = `${n.lane}@${Math.round(n.t * 1000)}`;
    const prev = best.get(key);
    if (!prev || n.vel > prev.vel) best.set(key, n);
  }
  return sortNotes([...best.values()]);
}

/**
 * Reduce a chart to a difficulty level. Never mutates the input; returns a new chart (same id).
 *  1 "Starter": kick, snare, hihat only; hihat thinned to quarter notes; no fills (toms and crash dropped,
 *     and in any bar that contains tom hits only notes on the beat are kept so snare-roll fills disappear).
 *  2 "Groove":  kick, snare, hihat (as written), crash; toms -> snare; ride -> hihat.
 *  3 "Full":    everything as written.
 */
export function simplifyChart(chart, level) {
  if (![1, 2, 3].includes(level)) throw new Error('level must be 1, 2 or 3');
  const beatSec = 60 / chart.bpm;
  const bpb = chart.beatsPerBar || 4;
  const off = chart.offsetSec || 0;
  const beatPos = (t) => (t - off) / beatSec;
  const onBeat = (t) => {
    const x = beatPos(t);
    return Math.abs(x - Math.round(x)) < 0.08;
  };
  let out = chart.notes.map((n) => ({ t: n.t, lane: n.lane, vel: n.vel }));

  if (level === 2) {
    out = out.map((n) => (TOMS.has(n.lane) ? { ...n, lane: 'snare' } : n.lane === 'ride' ? { ...n, lane: 'hihat' } : n));
    out = dedupeNotes(out);
  } else if (level === 1) {
    const fillBars = new Set();
    for (const n of out) if (TOMS.has(n.lane)) fillBars.add(Math.floor(beatPos(n.t) / bpb + 1e-6));
    out = out
      .map((n) => (n.lane === 'ride' ? { ...n, lane: 'hihat' } : n))
      .filter((n) => n.lane === 'kick' || n.lane === 'snare' || n.lane === 'hihat')
      .filter((n) => {
        if (n.lane === 'hihat') return onBeat(n.t);
        if (fillBars.has(Math.floor(beatPos(n.t) / bpb + 1e-6))) return onBeat(n.t);
        return true;
      });
    out = dedupeNotes(out);
  }
  return { ...chart, notes: out, meta: { ...(chart.meta || {}), level } };
}

/** Snap notes to a grid of `division` notes per whole note (16 = sixteenths, 12 = triplet eighths, 8 = eighths). */
export function quantizeChart(chart, division = 16) {
  if (!Number.isFinite(division) || division <= 0) throw new Error('division must be positive');
  const step = (60 / chart.bpm) * (4 / division);
  const off = chart.offsetSec || 0;
  const snapped = chart.notes.map((n) => {
    const t = Math.max(0, round6(off + Math.round((n.t - off) / step) * step));
    return { t, lane: n.lane, vel: n.vel };
  });
  return { ...chart, notes: dedupeNotes(snapped), meta: { ...(chart.meta || {}) } };
}

/** Structural validation. Returns { ok, errors }. */
export function validateChart(chart) {
  const errors = [];
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  if (!chart || typeof chart !== 'object') return { ok: false, errors: ['chart is not an object'] };
  if (typeof chart.id !== 'string' || !chart.id) errors.push('id must be a non-empty string');
  if (typeof chart.title !== 'string') errors.push('title must be a string');
  if (!SOURCES.includes(chart.source)) errors.push(`source must be one of ${SOURCES.join(', ')}`);
  if (!isNum(chart.bpm) || chart.bpm <= 0 || chart.bpm > 1000) errors.push('bpm must be a number > 0');
  if (!isNum(chart.beatsPerBar) || chart.beatsPerBar <= 0) errors.push('beatsPerBar must be a number > 0');
  if (!isNum(chart.offsetSec)) errors.push('offsetSec must be a finite number');
  if (!isNum(chart.durationSec) || chart.durationSec < 0) errors.push('durationSec must be a number >= 0');
  if (chart.audioId !== null && typeof chart.audioId !== 'string') errors.push('audioId must be a string or null');
  if (chart.meta !== undefined && (chart.meta === null || typeof chart.meta !== 'object')) errors.push('meta must be an object');
  if (!Array.isArray(chart.notes)) {
    errors.push('notes must be an array');
  } else {
    let prev = -Infinity;
    let noteErrors = 0;
    chart.notes.forEach((n, i) => {
      const bad = (msg) => { if (noteErrors++ < 10) errors.push(`notes[${i}]: ${msg}`); };
      if (!n || typeof n !== 'object') return bad('not an object');
      if (!isNum(n.t) || n.t < 0) bad('t must be a number >= 0');
      else if (n.t < prev) bad('notes are not sorted by t');
      else prev = n.t;
      if (!LANE_INDEX.has(n.lane)) bad(`unknown lane "${n.lane}"`);
      if (!isNum(n.vel) || n.vel < 0 || n.vel > 1) bad('vel must be between 0 and 1');
    });
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Built-in lessons
// ---------------------------------------------------------------------------

function makeLesson({ n, title, bpm, desc, bar }) {
  // bar(b) -> { groove: patternId, fill?: patternId } for 1-based bar number b; crash follows each fill.
  const BARS = 16;
  const plan = [];
  let prevFill = false;
  for (let b = 1; b <= BARS; b++) {
    const spec = bar(b);
    const p = PATTERN_BY_ID.get(spec.fill || spec.groove);
    plan.push({ pattern: p, crash: prevFill });
    prevFill = !!spec.fill;
  }
  const beatsPerBar = 4;
  return {
    id: `builtin-lesson-${n}`,
    title,
    source: 'builtin',
    bpm,
    beatsPerBar,
    offsetSec: 0,
    durationSec: round6((BARS * beatsPerBar * 60) / bpm),
    audioId: null,
    notes: renderPlan(plan, { bpm, offsetSec: 0, beatsPerBar }),
    meta: { notes: desc },
  };
}

const same = (groove) => () => ({ groove });
const withFill = (groove, every, fill) => (b) => (b % every === 0 ? { groove, fill } : { groove });

export const BUILTIN_LESSONS = [
  { n: 1, title: 'Boom Tick Starter', bpm: 60, desc: 'Just bass drum on 1 and 3, snare on 2 and 4.', bar: same('kick-snare-quarters') },
  { n: 2, title: 'Hat Walk', bpm: 66, desc: 'Add the hi-hat on every beat.', bar: same('quarter-rock') },
  { n: 3, title: 'Eight Is Great', bpm: 70, desc: 'Hi-hat on every 8th note: the classic rock beat.', bar: same('eighth-rock') },
  { n: 4, title: 'Pump It Up', bpm: 76, desc: 'Bass drum on every beat, hi-hat in between.', bar: same('four-on-the-floor') },
  { n: 5, title: 'Big Slow Stomp', bpm: 80, desc: 'Half-time: the snare waits until beat 3.', bar: same('half-time') },
  { n: 6, title: 'Bouncy Bass Drum', bpm: 84, desc: 'Rock beat with an extra bass drum before beat 3.', bar: same('rock-kick-variation') },
  { n: 7, title: 'Skippy Shuffle', bpm: 88, desc: 'Triplet feel: long-short, long-short.', bar: same('shuffle') },
  { n: 8, title: 'Speedy Hats', bpm: 80, desc: 'Hi-hat on every 16th note.', bar: same('sixteenth-hat-rock') },
  {
    n: 9, title: 'Rock and Fill', bpm: 90,
    desc: '8th-note rock with a snare fill every 4 bars, then a crash.',
    bar: withFill('eighth-rock', 4, 'fill-snare'),
  },
  {
    n: 10, title: 'Grand Finale', bpm: 100,
    desc: 'Rock grooves with snare and tom fills, crash after every fill.',
    bar: (b) => {
      const groove = Math.floor((b - 1) / 4) % 2 === 0 ? 'eighth-rock' : 'rock-kick-variation';
      if (b % 4 !== 0) return { groove };
      return { groove, fill: b % 8 === 0 ? 'fill-tom-down' : 'fill-tom-eighths' };
    },
  },
].map(makeLesson);

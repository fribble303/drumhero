// Synthetic drum sounds for the DSP tests (not a test file itself; imported by listen/analyze tests).

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ biquad, type 'lp' | 'hp' | 'bp'. Returns a new filtered array. */
export function biquad(x, sr, type, freq, q = 0.707) {
  const w = (2 * Math.PI * freq) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function noise(n, rand) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

function sweep(n, sr, f0, f1, tau, decay) {
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / tau);
    phase += (2 * Math.PI * f) / sr;
    x[i] = Math.sin(phase) * Math.exp(-t / decay);
  }
  return x;
}

function shaped(x, sr, decay, attackSec = 0) {
  const a = Math.round(attackSec * sr);
  for (let i = 0; i < x.length; i++) {
    let g = Math.exp(-i / sr / decay);
    if (i < a) g *= i / a;
    x[i] *= g;
  }
  return x;
}

function mix(...parts) {
  const n = Math.max(...parts.map((p) => p.length));
  const y = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) y[i] += p[i];
  return y;
}

function scale(x, g) {
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Fade the last 40 ms so a truncated tail does not end in a click (which would be a real onset). */
function tail(x, sr) {
  const n = Math.min(x.length >> 1, Math.round(sr * 0.04));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

/** Drum voices. Each returns a Float32Array starting exactly at the stick time. `v` jitters the voice a little. */
const rawVoices = {
  kick(sr, rand, v = 0) {
    const n = Math.round(sr * 0.4);
    const body = sweep(n, sr, 150 * (1 + 0.03 * v), 50, 0.03, 0.12);
    const click = scale(shaped(biquad(noise(Math.round(sr * 0.01), rand), sr, 'bp', 2500, 1), sr, 0.002), 0.25);
    return mix(body, click);
  },
  snare(sr, rand, v = 0) {
    const n = Math.round(sr * 0.3);
    const rattle = scale(shaped(biquad(noise(n, rand), sr, 'hp', 1200), sr, 0.06), 0.7);
    const tone = scale(sweep(n, sr, 200 * (1 + 0.02 * v), 185, 0.02, 0.08), 0.6);
    return mix(rattle, tone);
  },
  hihat(sr, rand) {
    const n = Math.round(sr * 0.12);
    return scale(shaped(biquad(biquad(noise(n, rand), sr, 'hp', 7000), sr, 'hp', 7000), sr, 0.02), 0.8);
  },
  crash(sr, rand) {
    const n = Math.round(sr * 1.6);
    return scale(shaped(biquad(noise(n, rand), sr, 'hp', 4000), sr, 0.4), 0.8);
  },
  ride(sr, rand) {
    const n = Math.round(sr * 0.6);
    const wash = scale(shaped(biquad(noise(n, rand), sr, 'bp', 5200, 3), sr, 0.2), 0.5);
    const ping = scale(sweep(n, sr, 3400, 3400, 1, 0.15), 0.3);
    return mix(wash, ping);
  },
  tom1(sr, rand, v = 0) {
    const n = Math.round(sr * 0.4);
    return mix(scale(sweep(n, sr, 260 * (1 + 0.02 * v), 200, 0.04, 0.15), 0.9),
      scale(shaped(biquad(noise(Math.round(sr * 0.02), rand), sr, 'bp', 1500, 1), sr, 0.004), 0.2));
  },
  tom2(sr, rand, v = 0) {
    const n = Math.round(sr * 0.45);
    return mix(scale(sweep(n, sr, 180 * (1 + 0.02 * v), 135, 0.04, 0.18), 0.9),
      scale(shaped(biquad(noise(Math.round(sr * 0.02), rand), sr, 'bp', 1200, 1), sr, 0.004), 0.2));
  },
  floor(sr, rand, v = 0) {
    const n = Math.round(sr * 0.5);
    return mix(scale(sweep(n, sr, 120 * (1 + 0.02 * v), 85, 0.05, 0.22), 0.9),
      scale(shaped(biquad(noise(Math.round(sr * 0.02), rand), sr, 'bp', 900, 1), sr, 0.004), 0.2));
  },
};

export const voices = {};
for (const name of Object.keys(rawVoices)) voices[name] = (sr, rand, v) => tail(rawVoices[name](sr, rand, v), sr);

/**
 * A dull rubber-pad "thwack": band-limited noise knock plus a short low thump. `centre` (Hz) is the
 * only thing that differs between two pads of the same type, so two thwacks with centres a few
 * percent apart are meant to be near identical.
 */
export function thwack(sr, rand, centre = 600, thumpHz = 160) {
  const n = Math.round(sr * 0.08);
  const knock = scale(shaped(biquad(noise(n, rand), sr, 'bp', centre, 0.8), sr, 0.012), 1.2);
  const thump = scale(sweep(n, sr, thumpHz * 1.2, thumpHz, 0.01, 0.015), 0.5);
  return tail(scale(mix(knock, thump), 0.25), sr);
}

/** Add `sound` into `out` starting at sample `at` with gain `g`. */
export function place(out, sound, at, g = 1) {
  for (let i = 0; i < sound.length && at + i < out.length; i++) if (at + i >= 0) out[at + i] += sound[i] * g;
}

export function addNoise(out, rand, level) {
  for (let i = 0; i < out.length; i++) out[i] += (rand() * 2 - 1) * level;
  return out;
}

/**
 * A rock loop with known note times.
 * Per bar (16th steps): kick 0, 8, 10 · snare 4, 12 · hi-hat on every 8th · crash on the downbeat of every 4th bar.
 * options: { bpm, bars, offsetSec, bed (bass + pad), bedGain (1 = normal mix level), seed }
 * Returns { channelData, sampleRate, notes: [{t, lane}], bpm, offsetSec }.
 */
export function drumLoop(sr, { bpm = 120, bars = 16, offsetSec = 0.5, bed = false, bedGain = 1, seed = 1 } = {}) {
  const rand = rng(seed);
  const beat = 60 / bpm, step = beat / 4;
  const total = Math.round((offsetSec + bars * 4 * beat + 1.0) * sr);
  const out = new Float32Array(total);
  const notes = [];
  const hit = (lane, t, g) => {
    place(out, voices[lane](sr, rand, rand() * 2 - 1), Math.round(t * sr), g * (0.85 + 0.3 * rand()));
    notes.push({ t, lane });
  };
  for (let bar = 0; bar < bars; bar++) {
    const t0 = offsetSec + bar * 4 * beat;
    for (const s of [0, 8, 10]) hit('kick', t0 + s * step, 0.8);
    for (const s of [4, 12]) hit('snare', t0 + s * step, 0.7);
    const crashBar = bar % 4 === 0;
    for (let s = 0; s < 16; s += 2) {
      if (crashBar && s === 0) hit('crash', t0, 0.6);
      else hit('hihat', t0 + s * step, s % 4 === 0 ? 0.4 : 0.3);
    }
  }
  if (bed) {
    // Bass: an eighth-note line (roots change each bar) with a soft pluck; pad: sustained chord.
    const roots = [55, 65.4, 49, 73.4];
    for (let bar = 0; bar < bars; bar++) {
      const f = roots[bar % roots.length];
      const t0 = offsetSec + bar * 4 * beat;
      for (let e = 0; e < 8; e++) {
        const n = Math.round(beat * 0.5 * sr * 0.95);
        const start = Math.round((t0 + e * beat * 0.5) * sr);
        for (let i = 0; i < n && start + i < total; i++) {
          const t = i / sr;
          const env = Math.min(1, t / 0.012) * Math.exp(-t / 0.35) * Math.min(1, (n - i) / (0.01 * sr));
          out[start + i] += 0.16 * bedGain * env * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * 2 * f * t));
        }
      }
      const n = Math.round(4 * beat * sr);
      const start = Math.round(t0 * sr);
      for (let i = 0; i < n && start + i < total; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.08) * Math.min(1, (n - i) / (0.08 * sr));
        let s = 0;
        for (const m of [4, 5, 6, 8]) s += Math.sin(2 * Math.PI * f * m * t) + 0.3 * Math.sin(2 * Math.PI * f * m * 2 * t);
        out[start + i] += 0.022 * bedGain * env * s;
      }
    }
  }
  addNoise(out, rand, 0.001);
  notes.sort((a, b) => a.t - b.t);
  return { channelData: out, sampleRate: sr, notes, bpm, offsetSec };
}

// dsp-util.js — tiny shared DSP helpers for listen.js and analyze.js (private to the DSP modules).
// Pure JS, no DOM, runs in Node and browsers.

/** In-place iterative radix-2 FFT for a fixed power-of-two size. */
export class FFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    let bits = 0;
    while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** Forward transform of complex data held in re/im (length n), in place. */
  transform(re, im) {
    const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k, b = a + half;
          const wr = cos[t], wi = -sin[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /**
   * Power spectrum |X[k]|^2 for k = 0..n/2 of a real frame (length n, already windowed).
   * `out` must have length >= n/2 + 1.
   */
  power(frame, out) {
    const n = this.n, re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { re[i] = frame[i]; im[i] = 0; }
    this.transform(re, im);
    const h = n >> 1;
    for (let k = 0; k <= h; k++) out[k] = re[k] * re[k] + im[k] * im[k];
    return out;
  }
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
  return w;
}

export function nextPow2(x) {
  let n = 1;
  while (n < x) n <<= 1;
  return n;
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function median(values) {
  if (!values.length) return 0;
  const a = Array.from(values).sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/** q in 0..1; linear-interpolated percentile of an array-like. */
export function percentile(values, q) {
  if (!values.length) return 0;
  const a = Array.from(values).sort((p, r) => p - r);
  const pos = clamp(q, 0, 1) * (a.length - 1);
  const i = Math.floor(pos), f = pos - i;
  return i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

/** Bin ranges [lo, hi) for band edges in Hz on an FFT of `size` at `sampleRate`; each band gets >= 1 bin. */
export function bandBins(edgesHz, size, sampleRate) {
  const half = size >> 1;
  const out = [];
  for (let b = 0; b + 1 < edgesHz.length; b++) {
    let lo = Math.ceil((edgesHz[b] * size) / sampleRate);
    let hi = Math.ceil((edgesHz[b + 1] * size) / sampleRate);
    lo = clamp(lo, 1, half);
    hi = clamp(hi, lo + 1, half + 1);
    out.push([lo, hi]);
  }
  return out;
}

/** Cooperative yield so long analyses do not freeze the UI. */
export function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

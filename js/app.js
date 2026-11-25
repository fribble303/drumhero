// Drum Hero - UI: screens, import flows, calibration, play, results.
import * as store from './store.js';
import { LANES, LANE_INFO, KEY_LANES, LEVELS, Game, Highway, lanesForLevel, filterNotesForLevel } from './game.js';
import { BUILTIN_LESSONS, PATTERNS, buildPatternChart, simplifyChart, uuid } from './charts.js';

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function lsGet(k, d) { try { const v = localStorage.getItem('dh.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
const NO_PREF = Symbol('no-pref');
function lsSet(k, v) { try { localStorage.setItem('dh.' + k, JSON.stringify(v)); } catch { /* ignore */ } }

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function busy(text, frac) {
  const b = $('#busy');
  if (text == null) { b.hidden = true; return; }
  b.hidden = false;
  $('#busy-text').textContent = text;
  $('#busy-bar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const stars = (n, max = 5) => h('span', { class: 'stars', 'aria-label': `${n} of ${max} stars` }, '★'.repeat(n), h('span', { class: 'off' }, '★'.repeat(max - n)));
const laneChip = (l) => h('span', { class: 'chip', style: `background:${LANE_INFO[l].color}` }, LANE_INFO[l].label);

// ---------- app state ----------
const S = {
  songs: [],
  best: {},          // songId -> best record at any level
  selected: lsGet('selected', null),
  level: lsGet('level', 1),
  speed: lsGet('speed', 1),
  mic: lsGet('mic', false),
  click: lsGet('click', false),
  ctx: null,
  listener: null,
  listenerError: null,
  profileLoaded: false,
  game: null,
  audioCache: new Map(),
};

const screens = ['home', 'add', 'calibrate', 'play', 'results'];
function show(name) {
  for (const s of screens) $('#' + s).hidden = s !== name;
  S.screen = name;
}

// ---------- audio context / listener ----------
function ensureCtx() {
  if (!S.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser has no Web Audio.');
    S.ctx = new AC({ latencyHint: 'interactive' });
  }
  if (S.ctx.state === 'suspended') S.ctx.resume().catch(() => {});
  return S.ctx;
}

async function ensureListener() {
  if (S.listener) return S.listener;
  try {
    const mod = await import('./listen.js');
    const L = mod.createListener(ensureCtx());
    const prof = await store.getProfile();
    if (prof) { try { L.setProfile(prof); } catch { /* bad profile */ } }
    S.listener = L;
    return L;
  } catch (e) {
    S.listenerError = e;
    return null;
  }
}

function micMessage(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || /denied|permission/i.test(e?.message || '')) {
    return 'The microphone is blocked. You can allow it in your browser settings, or play with taps and the keyboard.';
  }
  if (n === 'NotFoundError') return 'No microphone found. You can still play with taps and the keyboard.';
  return `Could not start the microphone (${e?.message || 'unknown error'}). You can still play with taps.`;
}

/** Start the mic. Returns the listener, or null (and shows a message) on failure. */
async function startMic(quiet) {
  try {
    ensureCtx();
    const L = await ensureListener();
    if (!L) throw new Error('The listening module is not available.');
    if (!L.isRunning()) await L.start();
    return L;
  } catch (e) {
    if (!quiet) toast(micMessage(e), 6000);
    return null;
  }
}

// ---------- wake lock ----------
let wake = null;
async function lockScreen() {
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* optional */ }
}
function unlockScreen() { try { wake?.release(); } catch { /* ignore */ } wake = null; }

// ---------- songs ----------
async function refreshSongs() {
  try { S.songs = await store.listSongs(); } catch { S.songs = []; }
  const all = [...BUILTIN_LESSONS, ...S.songs];
  S.best = {};
  await Promise.all(all.map(async (c) => {
    try { const sc = await store.getScores(c.id); if (sc.length) S.best[c.id] = sc[0]; } catch { /* ignore */ }
  }));
  if (!all.find((c) => c.id === S.selected)) S.selected = all[0]?.id ?? null;
}
const allSongs = () => [...BUILTIN_LESSONS, ...S.songs];
const selectedChart = () => allSongs().find((c) => c.id === S.selected) || null;

function prepareChart(chart, level) {
  let c = chart;
  try { c = simplifyChart(chart, level) || chart; } catch { c = chart; }
  return { ...c, notes: filterNotesForLevel(c.notes, level) };
}

function describe(c) {
  const bars = c.bpm && c.durationSec ? Math.round((c.durationSec * c.bpm) / 60 / (c.beatsPerBar || 4)) : null;
  const src = { builtin: 'Lesson', pattern: 'Song + beat', midi: 'MIDI', audio: 'Song', sheet: 'Sheet music' }[c.source] || '';
  return `${Math.round(c.bpm)} BPM${bars ? ` · ${bars} bars` : ''}${src ? ` · ${src}` : ''}`;
}

// ---------- HOME ----------
let homeScroll = 0;
function renderHome() {
  const root = $('#home');
  const prev = $('.scroll', root);
  if (prev) homeScroll = prev.scrollTop;
  root.replaceChildren();

  const list = h('div', { class: 'scroll col', style: 'flex:1.15;padding-right:4px' });
  list.append(h('div', { class: 'sep-title' }, 'Lessons'));
  for (const c of BUILTIN_LESSONS) list.append(songCard(c, false));
  list.append(h('div', { class: 'sep-title' }, 'My songs'));
  if (!S.songs.length) list.append(h('p', { class: 'muted small-text', style: 'margin:0 2px 10px' }, 'No songs yet. A grown-up can add one with the Add song button.'));
  for (const c of S.songs) list.append(songCard(c, true));

  const panel = h('div', { class: 'panel col', id: 'home-panel', style: 'flex:1;overflow:hidden;min-height:0' });
  root.append(
    h('div', { class: 'head' },
      h('div', { class: 'logo' }, h('span', { class: 'dot' }), h('h1', null, 'DRUM ', h('b', null, 'HERO'))),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small ghost', onclick: () => { ensureCtx(); openCalibrate(); } }, 'Set up mic'),
      h('button', { class: 'btn small cyan', onclick: () => openAdd() }, '+ Add song')),
    h('div', { class: 'body' }, list, panel));
  list.scrollTop = homeScroll;
  renderHomePanel();
}

function songCard(c, deletable) {
  const best = S.best[c.id];
  const card = h('button', { class: 'song' + (c.id === S.selected ? ' sel' : ''), 'data-id': c.id, onclick: () => selectSong(c.id) },
    h('div', { class: 't' }, h('b', null, c.title), h('span', null, describe(c))),
    best ? stars(best.stars) : h('span', { class: 'badge' }, 'new'));
  if (!deletable) return card;
  const wrap = h('div', { style: 'position:relative' }, card);
  const del = h('button', {
    class: 'btn small ghost', style: 'position:absolute;right:6px;bottom:14px;min-height:34px;min-width:34px;padding:2px 8px;font-size:12px;box-shadow:none',
    'aria-label': `Delete ${c.title}`,
    onclick: async (ev) => {
      ev.stopPropagation();
      if (del.dataset.arm !== '1') { del.dataset.arm = '1'; del.textContent = 'Delete?'; setTimeout(() => { del.dataset.arm = ''; del.textContent = '✕'; }, 2500); return; }
      await store.deleteSong(c.id);
      await refreshSongs();
      renderHome();
    },
  }, '✕');
  wrap.append(del);
  return wrap;
}

function selectSong(id) {
  S.selected = id;
  lsSet('selected', id);
  for (const el of document.querySelectorAll('#home .song')) el.classList.toggle('sel', el.dataset.id === id);
  renderHomePanel();
}

function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([val, label, sub]) =>
    h('button', { class: val === current ? 'sel' : '', onclick: () => onPick(val) }, label, sub ? h('small', null, sub) : null)));
}

function renderHomePanel() {
  const p = $('#home-panel');
  if (!p) return;
  p.replaceChildren();
  const c = selectedChart();
  if (!c) { p.append(h('p', null, 'Pick a song!')); return; }
  const lanes = lanesForLevel(S.level, prepareChart(c, S.level).notes);
  const content = h('div', { class: 'col scroll', style: 'flex:1' });
  p.append(content);
  content.append(
    h('div', null, h('h2', null, c.title), h('p', { class: 'muted small-text' }, describe(c) + (c.audioId ? ' · plays the song' : ' · click track'))),
    h('button', { class: 'btn small ' + (S.mic ? 'on' : (S.hasProfile ? '' : 'ghost')), 'aria-pressed': String(!!S.mic), onclick: () => { S.mic = !S.mic; lsSet('mic', S.mic); renderHomePanel(); } }, S.mic ? '\u{1F3A4} Mic ON: listening to drums' : '\u{1F3A4} Mic OFF: taps only'),
    h('div', null, h('div', { class: 'label' }, 'Level'), seg(Object.entries(LEVELS).map(([k, v]) => [Number(k), v.name, v.blurb]), S.level, (v) => { S.level = v; lsSet('level', v); renderHomePanel(); })),
    h('div', { class: 'lane-chips' }, lanes.map(laneChip)),
    h('div', null, h('div', { class: 'label' }, 'Speed'), seg([[0.5, '50%', 'slow'], [0.75, '75%', 'medium'], [1, '100%', 'full']], S.speed, (v) => { S.speed = v; lsSet('speed', v); renderHomePanel(); })),
    c.audioId ? h('div', { class: 'row' },
      h('button', { class: 'btn small ' + (S.click ? 'on' : 'ghost'), onclick: () => { S.click = !S.click; lsSet('click', S.click); renderHomePanel(); } }, S.click ? 'Click: on' : 'Click: off')) : null,
    S.best[c.id] ? h('p', { class: 'small-text muted' }, `Best: ${S.best[c.id].score} points, `, stars(S.best[c.id].stars)) : null);
  p.append(h('button', { class: 'btn big green', style: 'flex:none', onclick: () => startPlay() }, 'PLAY'));
}

// ---------- ADD SONG ----------
let draft = null;
let sheetAvailable = null;

async function openAdd() {
  show('add');
  renderAddChoices();
  if (sheetAvailable == null) {
    sheetAvailable = false;
    try { const m = await import('./sheet.js'); sheetAvailable = !!(await m.isSheetReadingAvailable()); } catch { sheetAvailable = false; }
    if (S.screen === 'add' && !draft && !$('#add').dataset.route) renderAddChoices();
  }
}

function addShell(title, body, back) {
  const root = $('#add');
  root.replaceChildren(
    h('div', { class: 'head' },
      h('button', { class: 'btn small ghost', onclick: back || (() => goHome()) }, '← Back'),
      h('h2', { class: 'grow' }, title)),
    h('div', { class: 'body' }, body));
}

function renderAddChoices() {
  delete $('#add').dataset.route;
  draft = null;
  const card = (ico, title, text, route, disabled) =>
    h('button', { class: 'card', disabled, onclick: () => { ensureCtx(); routes[route](); } }, h('div', { class: 'ico' }, ico), h('b', null, title), h('span', null, text));
  addShell('Add a song', h('div', { class: 'col', style: 'flex:1' },
    h('p', { class: 'muted' }, 'Ask a grown-up to pick how to add a song.'),
    h('div', { class: 'cards' },
      card('🎵', 'Song (find the drums)', 'Pick an audio file. We listen and work out the drum part. Best with clear drums.', 'audio'),
      card('🥁', 'Song + a beat', 'Pick an audio file, then choose an easy beat to play along with it.', 'beat'),
      card('🎹', 'MIDI file', 'A drum MIDI file gives an exact drum part. Backing song is optional.', 'midi'),
      card('📷', 'Photo of sheet music', sheetAvailable ? 'Take or pick photos of drum notation.' : 'Not available here right now. Try another way to add a song.', 'sheet', sheetAvailable === false))));
}

function filePicker(label, accept, onFiles, { multiple = false, capture = false, cls = 'btn big cyan' } = {}) {
  const input = h('input', { type: 'file', accept, multiple, capture: capture ? 'environment' : false });
  input.addEventListener('change', () => { const f = [...input.files]; input.value = ''; if (f.length) onFiles(f); });
  return h('label', { class: cls + ' file-btn' }, label, input);
}

async function decodeFile(file) {
  const ctx = ensureCtx();
  const buf = await file.arrayBuffer();
  const audio = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(buf.slice(0), res, rej);
    if (p && p.catch) p.catch(rej);
  });
  const ch = audio.numberOfChannels, n = audio.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  return { mono, sampleRate: audio.sampleRate, duration: audio.duration };
}

const baseName = (f) => (f?.name || 'My song').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'My song';

const routes = {
  audio() {
    $('#add').dataset.route = 'audio';
    addShell('Song: find the drums', h('div', { class: 'col', style: 'flex:1' },
      h('p', null, 'Choose an audio file (mp3, m4a, wav). It works best when the drums are easy to hear.'),
      h('p', { class: 'muted small-text' }, 'Working it out can take a little while for long songs. Keep this screen open.'),
      filePicker('Choose audio file', 'audio/*,.mp3,.m4a,.wav,.ogg,.flac', async ([file]) => {
        try {
          busy('Opening the song...', 0.02);
          const dec = await decodeFile(file);
          const { analyzeAudio } = await import('./analyze.js');
          busy('Listening for drums...', 0.05);
          const r = await analyzeAudio({ channelData: dec.mono, sampleRate: dec.sampleRate }, { onProgress: (f) => busy('Listening for drums...', 0.05 + f * 0.95) });
          busy(null);
          const id = uuid();
          const chart = { id, title: baseName(file), source: 'audio', bpm: r.bpm, beatsPerBar: r.beatsPerBar || 4, offsetSec: r.offsetSec || 0, durationSec: dec.duration, audioId: id, notes: r.notes, meta: { confidence: r.confidence } };
          openPreview({ kind: 'audio', chart, blob: file, confidence: r.confidence });
        } catch (e) { busy(null); toast(`That did not work: ${e.message || e}`, 6000); }
      })), () => renderAddChoices());
  },

  beat() {
    $('#add').dataset.route = 'beat';
    addShell('Song + a beat', h('div', { class: 'col', style: 'flex:1' },
      h('p', null, 'Choose an audio file. We find the tempo and you pick the drum beat to play along.'),
      filePicker('Choose audio file', 'audio/*,.mp3,.m4a,.wav,.ogg,.flac', async ([file]) => {
        try {
          busy('Opening the song...', 0.05);
          const dec = await decodeFile(file);
          const { detectTempo } = await import('./analyze.js');
          busy('Finding the tempo...', 0.5);
          const t = await detectTempo({ channelData: dec.mono, sampleRate: dec.sampleRate });
          busy(null);
          openPreview({ kind: 'pattern', blob: file, title: baseName(file), bpm: Math.round(t.bpm * 10) / 10, offsetSec: t.offsetSec || 0, durationSec: dec.duration, patternId: PATTERNS[0]?.id, fillEvery: 0, confidence: t.confidence });
        } catch (e) { busy(null); toast(`That did not work: ${e.message || e}`, 6000); }
      })), () => renderAddChoices());
  },

  midi() {
    $('#add').dataset.route = 'midi';
    let midiFile = null, audioFile = null;
    const status = h('p', { class: 'muted' }, 'No MIDI file chosen yet.');
    const audioStatus = h('p', { class: 'muted small-text' }, 'No backing song (a click track will play).');
    const go = h('button', { class: 'btn big green', disabled: true, onclick: async () => {
      try {
        busy('Reading the MIDI file...', 0.3);
        const { parseMidiToChart } = await import('./midi.js');
        const chart = parseMidiToChart(await midiFile.arrayBuffer(), { title: baseName(midiFile) });
        chart.id = uuid();
        chart.title = baseName(midiFile);
        if (audioFile) { chart.audioId = chart.id; try { const d = await decodeFile(audioFile); chart.durationSec = Math.max(chart.durationSec || 0, d.duration); } catch { /* keep midi duration */ } }
        else chart.audioId = null;
        busy(null);
        if (!chart.notes?.length) throw new Error('No drum notes found in that MIDI file.');
        openPreview({ kind: 'midi', chart, blob: audioFile || null });
      } catch (e) { busy(null); toast(`That did not work: ${e.message || e}`, 6000); }
    } }, 'Read it');
    addShell('MIDI drum file', h('div', { class: 'col', style: 'flex:1' },
      h('div', { class: 'row gap' },
        filePicker('Choose MIDI file', '.mid,.midi,audio/midi,audio/x-midi', ([f]) => { midiFile = f; status.textContent = `MIDI: ${f.name}`; go.disabled = false; }),
        filePicker('Add backing song (optional)', 'audio/*,.mp3,.m4a,.wav,.ogg', ([f]) => { audioFile = f; audioStatus.textContent = `Backing song: ${f.name}`; }, { cls: 'btn big ghost' })),
      status, audioStatus, go), () => renderAddChoices());
  },

  sheet() {
    $('#add').dataset.route = 'sheet';
    let files = [];
    const status = h('p', { class: 'muted' }, 'No photos yet.');
    const bpm = h('input', { type: 'number', min: 40, max: 220, value: 80, inputmode: 'numeric' });
    const err = h('div', { class: 'note bad', hidden: true });
    const go = h('button', { class: 'btn big green', disabled: true, onclick: async () => {
      err.hidden = true;
      try {
        const m = await import('./sheet.js');
        busy('Reading the music...', 0.1);
        const chart = await m.sheetPhotosToChart(files, { title: 'Sheet music', bpm: Number(bpm.value) || 80, onProgress: (f) => busy('Reading the music...', 0.1 + 0.9 * (f || 0)) });
        busy(null);
        chart.id = uuid();
        chart.audioId = null;
        openPreview({ kind: 'sheet', chart, blob: null });
      } catch (e) { busy(null); err.textContent = e.message || String(e); err.hidden = false; }
    } }, 'Read the music');
    addShell('Photo of sheet music', h('div', { class: 'col scroll', style: 'flex:1' },
      h('p', null, 'Take a clear, flat photo of drum notation. Several photos are fine, in order.'),
      h('div', { class: 'row gap' },
        filePicker('Take / choose photos', 'image/*', (f) => { files = f; status.textContent = `${f.length} photo${f.length > 1 ? 's' : ''} ready`; go.disabled = false; }, { multiple: true, capture: true }),
        h('div', { class: 'field', style: 'width:150px' }, h('label', { class: 'label' }, 'Tempo (BPM)'), bpm)),
      status, err, go), () => renderAddChoices());
  },
};

// ---------- preview / edit ----------
function openPreview(d) {
  draft = { nudge: 0, level: 1, tapTimes: [], ...d };
  if (d.kind === 'pattern') draft.baseOffset = d.offsetSec;
  else draft.baseOffset = d.chart.offsetSec || 0;
  if (d.chart) draft.title = d.chart.title, draft.bpm = d.chart.bpm;
  renderPreview();
}

function draftChart() {
  const d = draft;
  if (d.kind === 'pattern') {
    const c = buildPatternChart({ title: d.title, bpm: d.bpm, offsetSec: d.baseOffset + d.nudge, durationSec: d.durationSec, patternId: d.patternId, fillEveryBars: d.fillEvery, audioId: null });
    return { ...c, id: d.id || (d.id = uuid()), source: 'pattern', audioId: d.id };
  }
  const base = d.chart;
  return { ...base, title: d.title, bpm: d.bpm, offsetSec: d.baseOffset + d.nudge, notes: base.notes.map((n) => ({ ...n, t: Math.max(0, n.t + d.nudge) })) };
}

function renderPreview() {
  const d = draft;
  show('add');
  const title = h('input', { type: 'text', value: d.title, maxlength: 60, 'aria-label': 'Title', oninput: (e) => { d.title = e.target.value; } });
  const bpmOut = h('output', null, `${d.bpm}`);
  const nudgeOut = h('output', null, '0 ms');
  const info = h('p', { class: 'small-text' });
  const canvas = h('canvas', { class: 'preview' });
  const levels = h('div');

  const redraw = () => {
    bpmOut.textContent = `${Math.round(d.bpm * 10) / 10}`;
    nudgeOut.textContent = `${d.nudge > 0 ? '+' : ''}${Math.round(d.nudge * 1000)} ms`;
    let chart;
    try { chart = draftChart(); } catch (e) { info.textContent = `Problem: ${e.message}`; return; }
    d.current = chart;
    const pc = prepareChart(chart, d.level);
    const lanes = lanesForLevel(d.level, pc.notes);
    info.textContent = `${chart.notes.length} notes in total · Level ${d.level} shows ${pc.notes.length} notes on ${lanes.length} lanes`;
    levels.replaceChildren(seg(Object.entries(LEVELS).map(([k, v]) => [Number(k), v.name, `${prepareChart(chart, Number(k)).notes.length} notes`]), d.level, (v) => { d.level = v; redraw(); }));
    drawPreview(canvas, pc, lanes);
  };

  const step = (what, delta) => () => {
    if (what === 'bpm') d.bpm = Math.max(40, Math.min(220, Math.round((d.bpm + delta) * 10) / 10));
    else if (what === 'mul') d.bpm = Math.max(40, Math.min(220, Math.round(d.bpm * delta * 10) / 10));
    else d.nudge = Math.round((d.nudge + delta) * 1000) / 1000;
    redraw();
  };

  const tap = h('button', { class: 'btn small ghost', onclick: () => {
    const now = performance.now();
    if (d.tapTimes.length && now - d.tapTimes[d.tapTimes.length - 1] > 2000) d.tapTimes = [];
    d.tapTimes.push(now);
    d.tapTimes = d.tapTimes.slice(-7);
    if (d.tapTimes.length >= 3) {
      const iv = (d.tapTimes[d.tapTimes.length - 1] - d.tapTimes[0]) / (d.tapTimes.length - 1);
      d.bpm = Math.max(40, Math.min(220, Math.round((60000 / iv) * 10) / 10));
      redraw();
    }
  } }, 'Tap tempo');

  const bpmRow = h('div', { class: 'field' }, h('label', { class: 'label' }, 'Tempo (BPM)'),
    h('div', { class: 'row' },
      h('div', { class: 'stepper' }, h('button', { class: 'btn small ghost', onclick: step('bpm', -1), 'aria-label': 'Slower' }, '−'), bpmOut, h('button', { class: 'btn small ghost', onclick: step('bpm', 1), 'aria-label': 'Faster' }, '+')),
      h('button', { class: 'btn small ghost', onclick: step('mul', 0.5) }, '÷2'),
      h('button', { class: 'btn small ghost', onclick: step('mul', 2) }, '×2'),
      tap));

  const nudgeRow = h('div', { class: 'field' }, h('label', { class: 'label' }, 'Nudge the notes'),
    h('div', { class: 'stepper' }, h('button', { class: 'btn small ghost', onclick: step('nudge', -0.01), 'aria-label': 'Earlier 10 milliseconds' }, '−10'), nudgeOut, h('button', { class: 'btn small ghost', onclick: step('nudge', 0.01), 'aria-label': 'Later 10 milliseconds' }, '+10')));

  let patternRow = null;
  if (d.kind === 'pattern') {
    const sel = h('select', { 'aria-label': 'Beat', onchange: (e) => { d.patternId = e.target.value; redraw(); } },
      PATTERNS.filter((p) => !p.fill).map((p) => h('option', { value: p.id, selected: p.id === d.patternId }, `${p.name}${p.level ? ` (level ${p.level})` : ''}`)));
    const fill = h('select', { 'aria-label': 'Fills', onchange: (e) => { d.fillEvery = Number(e.target.value); redraw(); } },
      [[0, 'No fills'], [4, 'Fill every 4 bars'], [8, 'Fill every 8 bars']].map(([v, l]) => h('option', { value: v, selected: v === d.fillEvery }, l)));
    patternRow = h('div', { class: 'row' }, h('div', { class: 'field', style: 'flex:1;min-width:180px' }, h('label', { class: 'label' }, 'Beat'), sel), h('div', { class: 'field', style: 'flex:1;min-width:150px' }, h('label', { class: 'label' }, 'Fills'), fill));
  }

  const warn = d.confidence != null && d.confidence < 0.5
    ? h('div', { class: 'note warn' }, 'We are not very sure about this one. Check the preview, nudge it, or try "Song + a beat" instead.')
    : (d.kind === 'audio' ? h('div', { class: 'note' }, 'Tempo is shown on the beat lines. If the lines look wrong, fix the tempo with the buttons.') : null);

  const save = h('button', { class: 'btn big green', onclick: async () => {
    save.disabled = true;
    try {
      const chart = draftChart();
      chart.title = (d.title || '').trim() || 'My song';
      if (d.blob) { chart.audioId = chart.id; await store.saveAudio(chart.id, d.blob); } else chart.audioId = null;
      S.audioCache.delete(chart.id);
      await store.saveSong(chart);
      S.selected = chart.id; lsSet('selected', chart.id);
      await refreshSongs();
      toast('Song saved!');
      goHome();
    } catch (e) { save.disabled = false; toast(`Could not save: ${e.message || e}`, 6000); }
  } }, 'Save song');

  const left = h('div', { class: 'col scroll', style: 'flex:1.1;padding-right:4px' },
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'Song name'), title), bpmRow, nudgeRow, patternRow, warn);
  const right = h('div', { class: 'col', style: 'flex:1' }, h('div', { class: 'label' }, 'Preview'), canvas, levels, info, save);

  const root = $('#add');
  root.replaceChildren(
    h('div', { class: 'head' }, h('button', { class: 'btn small ghost', onclick: () => { draft = null; renderAddChoices(); } }, '← Back'), h('h2', { class: 'grow' }, 'Check your song')),
    h('div', { class: 'body' }, left, right));
  requestAnimationFrame(redraw);
}

function drawPreview(canvas, chart, lanes) {
  if (!canvas.clientWidth) return;
  const notes = chart.notes.map((n) => ({ ...n, state: 'pending' }));
  const hw = new Highway(canvas);
  hw.resize();
  hw.setSong(notes, lanes, chart);
  const first = notes.length ? notes[0].t : 0;
  hw.draw(Math.max(0, first - 0.5), null);
}

// ---------- CALIBRATE ----------
const cal = { step: 0, lane: 0, done: {}, unsubs: [], latency: null };
function calCleanup() { for (const u of cal.unsubs) { try { u(); } catch { /* ignore */ } } cal.unsubs = []; }

function openCalibrate() {
  calCleanup();
  cal.step = 0; cal.lane = 0; cal.done = {};
  show('calibrate');
  renderCalibrate();
}

function micReady() { return !!(S.listener && S.listener.isRunning()); }

function renderCalibrate() {
  calCleanup();
  const root = $('#calibrate');
  const names = ['1 Mic', '2 Timing', '3 Teach', '4 Test'];
  const kitLanes = LANES;
  const body = h('div', { class: 'col', style: 'flex:1;min-height:0' });
  const needMic = () => h('div', { class: 'note warn' }, 'The microphone is off, so this step does nothing. You can still play with taps and the keyboard. ', h('button', { class: 'btn small', onclick: () => { cal.step = 0; renderCalibrate(); } }, 'Turn on mic'));
  const next = (label = 'Next') => h('button', { class: 'btn big green', onclick: () => { cal.step++; renderCalibrate(); } }, label);
  const finish = async () => {
    if (S.listener) { S.mic = true; lsSet('mic', true); S.hasProfile = true; }
    try { if (S.listener) await store.saveProfile(S.listener.getProfile()); toast('Saved!'); } catch { toast('Could not save your setup, but it works for now.'); }
    goHome();
  };

  if (cal.step === 0) {
    const meter = h('div', { class: 'meter' }, h('i'));
    const status = h('p', { class: 'muted' }, micReady() ? 'Microphone is on. Bang a drum and watch the bar.' : 'Drum Hero listens to your drum kit with the phone microphone.');
    const hookMeter = () => { cal.unsubs.push(S.listener.onLevel((v) => { meter.firstChild.style.transform = `scaleX(${Math.min(1, Math.sqrt(v) * 1.6)})`; })); };
    if (micReady()) hookMeter();
    const skip = h('button', { class: 'btn big ghost', onclick: () => { cal.step = micReady() ? 1 : 3; renderCalibrate(); } }, micReady() ? 'Next' : 'Skip: use taps');
    const on = h('button', { class: 'btn big cyan', onclick: async () => {
      on.disabled = true;
      const L = await startMic(true);
      if (!L) { on.disabled = false; status.textContent = 'The mic did not start. Allow the microphone for this page, or skip and play with taps.'; toast(micMessage(S.listenerError || { name: 'NotAllowedError' }), 5000); return; }
      S.mic = true; lsSet('mic', true);
      status.textContent = 'Microphone is on. Bang a drum and watch the bar.';
      calCleanup(); hookMeter();
      on.textContent = 'Mic is on'; on.disabled = true;
      skip.textContent = 'Next';
    } }, micReady() ? 'Mic is on' : 'Turn on microphone');
    if (micReady()) on.disabled = true;
    body.append(h('div', { class: 'col scroll', style: 'flex:1' },
      h('div', { class: 'panel' }, h('h3', null, 'Tips for the grown-up'),
        h('ul', { class: 'tips' },
          h('li', null, 'Make the kit loud enough to hear in the room (use its amp or a speaker). That is how Drum Hero tells the drums apart.'),
          h('li', null, 'With headphones only, the mic just hears pad thwacks, so Drum Hero scores timing only.'),
          h('li', null, 'Play the backing song through headphones, or keep the phone volume moderate so it does not drown out the kit.'))),
      status, meter,
      h('div', { class: 'row gap' }, on, skip)));
  } else if (cal.step === 1) {
    const out = h('p', { class: 'bigcount', style: 'font-size:40px' }, S.listener ? `${Math.round((S.listener.getLatencySec() || 0) * 1000)} ms` : '-');
    const msg = h('p', { class: 'muted' }, 'Latency is how long the sound takes to reach the app. Getting it right makes your Perfects count.');
    const setLat = (sec) => { S.listener.setLatencySec(Math.max(0, Math.min(0.5, sec))); out.textContent = `${Math.round(S.listener.getLatencySec() * 1000)} ms`; };
    let busyNow = false;
    const auto = h('button', { class: 'btn big cyan', onclick: async () => {
      if (busyNow) return; busyNow = true; auto.disabled = true; msg.textContent = 'Listen... the phone is playing clicks.';
      try {
        const r = await S.listener.measureLatencyLoopback();
        if (r && r.ok) { setLat(r.latencySec); msg.textContent = 'Measured! You can nudge it if the game feels early or late.'; }
        else msg.textContent = 'Could not hear the clicks. Turn the phone volume up, or use Tap along.';
      } catch (e) { msg.textContent = `That did not work (${e.message}). Try Tap along.`; }
      busyNow = false; auto.disabled = false;
    } }, 'Measure automatically');
    const tapAlong = h('button', { class: 'btn big pink', onclick: async () => {
      if (busyNow) return; busyNow = true; tapAlong.disabled = true;
      try {
        const ctx = ensureCtx();
        const hits = [];
        const un = S.listener.onHit((hh) => hits.push(hh.time));
        const t0 = ctx.currentTime + 1.2, iv = 0.6, clicks = [];
        for (let i = 0; i < 8; i++) {
          const when = t0 + i * iv; clicks.push(when);
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = i % 4 ? 1100 : 1600; o.type = 'square';
          g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(0.3, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
          o.connect(g); g.connect(ctx.destination); o.start(when); o.stop(when + 0.06);
        }
        msg.textContent = 'Hit any drum along with the 8 clicks...';
        await new Promise((r) => setTimeout(r, (t0 + 8 * iv - ctx.currentTime + 0.5) * 1000));
        un();
        const lat0 = S.listener.getLatencySec() || 0;
        const deltas = [];
        for (const c of clicks) {
          let best = null;
          for (const t of hits) { const d = t + lat0 - c; if (Math.abs(d) < 0.3 && (best == null || Math.abs(d) < Math.abs(best))) best = d; }
          if (best != null) deltas.push(best);
        }
        if (deltas.length < 4) msg.textContent = 'We only heard a few hits. Make the kit louder or try again.';
        else { deltas.sort((a, b) => a - b); setLat(deltas[Math.floor(deltas.length / 2)]); msg.textContent = `Heard ${deltas.length} of 8. Latency set.`; }
      } catch (e) { msg.textContent = `That did not work (${e.message}).`; }
      busyNow = false; tapAlong.disabled = false;
    } }, 'Tap along');
    body.append(h('div', { class: 'col scroll', style: 'flex:1' },
      micReady() ? null : needMic(), msg, out,
      h('div', { class: 'row gap' }, auto, tapAlong),
      h('div', { class: 'stepper' }, h('button', { class: 'btn small ghost', 'aria-label': 'Less latency', onclick: () => micReady() && setLat(S.listener.getLatencySec() - 0.01) }, '−10 ms'), h('span', { class: 'muted small-text' }, 'fine tune'), h('button', { class: 'btn small ghost', 'aria-label': 'More latency', onclick: () => micReady() && setLat(S.listener.getLatencySec() + 0.01) }, '+10 ms')),
      next()));
  } else if (cal.step === 2) {
    const lane = kitLanes[cal.lane];
    const need = 6;
    let count = 0, training = false, lastT = -1;
    const counter = h('div', { class: 'bigcount' }, `0 / ${need}`);
    const pick = h('div', { class: 'lane-pick' }, kitLanes.map((l, i) => h('button', {
      class: (i === cal.lane ? 'cur ' : '') + (cal.done[l] ? 'done' : ''), style: `background:${LANE_INFO[l].color}`,
      onclick: () => { try { S.listener?.stopTraining(); } catch { /* ignore */ } cal.lane = i; renderCalibrate(); },
    }, LANE_INFO[l].label + (cal.done[l] ? ' ✓' : ''))));
    const goNext = () => { if (cal.lane < kitLanes.length - 1) { cal.lane++; renderCalibrate(); } else { cal.step = 3; renderCalibrate(); } };
    const startBtn = h('button', { class: 'btn big', style: `background:${LANE_INFO[lane].color}`, disabled: !micReady(), onclick: () => {
      try {
        S.listener.clearTraining(lane);
        S.listener.startTraining(lane);
        training = true; count = 0; lastT = -1;
        startBtn.textContent = 'Listening... hit it!'; startBtn.disabled = true;
        cal.unsubs.push(S.listener.onHit((hh) => {
          if (!training || hh.time - lastT < 0.05) return;
          lastT = hh.time; count++;
          counter.textContent = `${Math.min(count, need)} / ${need}`;
          if (count >= need) {
            training = false;
            try { S.listener.stopTraining(); } catch { /* ignore */ }
            cal.done[lane] = true;
            setTimeout(goNext, 450);
          }
        }));
      } catch (e) { toast(`Could not teach this drum: ${e.message}`); }
    } }, `Teach me the ${LANE_INFO[lane].label}`);
    body.append(h('div', { class: 'col scroll', style: 'flex:1' },
      micReady() ? null : needMic(),
      pick,
      h('div', { class: 'panel center col', style: 'align-items:center' }, h('h2', null, `Hit the ${LANE_INFO[lane].label} ${need} times`), counter, startBtn),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost', onclick: () => { try { S.listener?.stopTraining(); } catch { /* ignore */ } goNext(); } }, 'Skip this drum'),
        h('button', { class: 'btn ghost', onclick: () => { try { S.listener?.clearTraining(); } catch { /* ignore */ } cal.done = {}; toast('Forgot the kit. Start again.'); renderCalibrate(); } }, 'Forget my kit'),
        h('button', { class: 'btn', onclick: () => { cal.step = 3; renderCalibrate(); } }, 'Done teaching'))));
  } else {
    const trained = micReady() ? (S.listener.trainedLanes?.() || []) : [];
    const heard = h('p', { class: 'bigcount', style: 'font-size:34px' }, micReady() ? 'Hit a drum!' : 'No mic: taps only');
    const pick = h('div', { class: 'lane-pick' }, kitLanes.map((l) => h('button', { 'data-lane': l, class: trained.includes(l) ? 'done' : '', style: `background:${LANE_INFO[l].color}`, onclick: () => flash(l) }, LANE_INFO[l].label)));
    const flash = (l) => { const b = pick.querySelector(`[data-lane="${l}"]`); if (!b) return; b.classList.add('lit'); setTimeout(() => b.classList.remove('lit'), 250); };
    if (micReady()) {
      cal.unsubs.push(S.listener.onHit((hh) => {
        if (hh.lane) { flash(hh.lane); heard.textContent = `${LANE_INFO[hh.lane].label}!`; heard.style.color = LANE_INFO[hh.lane].color; }
        else { heard.textContent = 'Heard a hit (timing only)'; heard.style.color = '#fff'; }
      }));
    }
    body.append(h('div', { class: 'col scroll', style: 'flex:1' },
      micReady() ? null : needMic(),
      trained.length < 2 && micReady() ? h('div', { class: 'note warn' }, 'Fewer than 2 drums taught, so Drum Hero will score timing only (any hit counts for the nearest note). That is fine for headphones.') : null,
      h('p', { class: 'muted' }, 'Quick test: hit your drums and see which one lights up.'), heard, pick,
      h('div', { class: 'row gap' }, h('button', { class: 'btn big green', onclick: finish }, 'Save & finish'), h('button', { class: 'btn ghost', onclick: () => { cal.step = 2; renderCalibrate(); } }, 'Teach more'))));
  }

  root.replaceChildren(
    h('div', { class: 'head' }, h('button', { class: 'btn small ghost', onclick: () => { try { S.listener?.stopTraining(); } catch { /* ignore */ } calCleanup(); goHome(); } }, '← Home'), h('h2', { class: 'grow' }, 'Set up the mic')),
    h('div', { class: 'steps' }, names.map((n, i) => h('span', { class: i === cal.step ? 'on' : i < cal.step ? 'done' : '' }, n))),
    h('div', { class: 'body' }, body));
}

// ---------- PLAY ----------
const canvasEl = () => $('#stage');
let lastPlay = null;

async function loadBuffer(chart) {
  if (!chart.audioId) return null;
  if (S.audioCache.has(chart.audioId)) return S.audioCache.get(chart.audioId);
  const blob = await store.getAudio(chart.audioId);
  if (!blob) throw new Error('The song audio is missing. Add the song again.');
  const ctx = ensureCtx();
  const ab = await blob.arrayBuffer();
  const buf = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
  S.audioCache.set(chart.audioId, buf);
  return buf;
}

async function startPlay() {
  const chart = selectedChart();
  if (!chart) return;
  try {
    ensureCtx(); // inside the tap, so iOS allows audio
    busy('Getting ready...', 0.3);
    let buffer = null;
    try { buffer = await loadBuffer(chart); } catch (e) { toast(e.message, 5000); if (chart.audioId) { busy(null); return; } }
    let listener = null;
    if (S.mic) {
      listener = await startMic(false);
      if (!listener) { S.mic = false; lsSet('mic', false); }
    }
    busy(null);
    lastPlay = { chart, listener, buffer };
    beginGame();
  } catch (e) { busy(null); toast(`Could not start: ${e.message || e}`, 6000); }
}

function beginGame() {
  const { chart, listener, buffer } = lastPlay;
  if (S.game) S.game.stop();
  show('play');
  $('#pause-menu').hidden = true;
  const prepared = prepareChart(chart, S.level);
  S.game = new Game({
    canvas: canvasEl(), audioCtx: S.ctx, chart: prepared, level: S.level, speed: S.speed, buffer,
    metronome: buffer ? S.click : true, listener,
    onEnd: (res) => finishGame(chart, res),
  });
  if (S.ctx.state !== 'running') S.ctx.resume().catch(() => {});
  S.game.start();
  lockScreen();
}

async function finishGame(chart, res) {
  unlockScreen();
  S.game = null;
  const prevBest = S.best[chart.id];
  const rec = { score: res.score, stars: res.stars, accuracy: res.accuracy, level: res.level, speed: res.speed, maxCombo: res.maxCombo };
  const isBest = !prevBest || rec.score > prevBest.score;
  try { await store.saveScore(chart.id, rec); } catch { /* ignore */ }
  if (isBest) S.best[chart.id] = rec;
  renderResults(chart, res, isBest && res.total > 0);
}

function pauseGame() {
  const g = S.game;
  if (!g || g.state !== 'playing') return;
  g.pause();
  $('#pause-menu').hidden = false;
}
async function resumeGame() { $('#pause-menu').hidden = true; await S.game?.resume(); }
function quitGame() { S.game?.stop(); S.game = null; unlockScreen(); $('#pause-menu').hidden = true; try { S.ctx?.resume(); } catch { /* ignore */ } goHome(); }

function wirePlay() {
  const cv = canvasEl();
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const g = S.game;
    if (!g || g.state !== 'playing') return;
    const r = cv.getBoundingClientRect();
    const lane = g.view.laneAt(e.clientY - r.top);
    if (lane) { g.view.flash(lane, 'good'); g.tap(lane); }
  });
  $('#pause-btn').addEventListener('click', pauseGame);
  $('#resume-btn').addEventListener('click', resumeGame);
  $('#restart-btn').addEventListener('click', async () => { $('#pause-menu').hidden = true; S.game?.stop(); try { await S.ctx.resume(); } catch { /* ignore */ } beginGame(); });
  $('#quit-btn').addEventListener('click', quitGame);
  window.addEventListener('resize', () => S.game?.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => S.game?.resize(), 250));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseGame();
    else if (S.game && S.game.state === 'playing') lockScreen();
  });
  const portrait = window.matchMedia('(orientation: portrait) and (max-width: 820px)');
  const onOrient = () => { if (portrait.matches) pauseGame(); };
  portrait.addEventListener?.('change', onOrient);
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (S.screen === 'play' && S.game) {
      if (e.key === 'Escape') { S.game.state === 'paused' ? resumeGame() : pauseGame(); return; }
      const lane = KEY_LANES[e.key.toLowerCase()];
      if (lane) { e.preventDefault(); S.game.view.flash(lane, 'good'); S.game.tap(lane); }
    }
  });
}

// ---------- RESULTS ----------
function renderResults(chart, res, isBest) {
  show('results');
  const root = $('#results');
  const m = res.meanErrMs;
  let tend = 'Right on the beat!';
  if (res.total && res.counts.perfect + res.counts.good + res.counts.ok === 0) tend = 'No hits landed this time.';
  else if (m > 12) tend = `You tend to hit a little late (${Math.round(m)} ms).`;
  else if (m < -12) tend = `You tend to hit a little early (${Math.round(-m)} ms).`;
  const pos = 50 + Math.max(-1, Math.min(1, m / 100)) * 50;
  const lanesUsed = LANES.filter((l) => res.perLane[l]);
  const msg = res.stars >= 5 ? 'Amazing drumming!' : res.stars >= 4 ? 'Great job!' : res.stars >= 3 ? 'Nice playing!' : res.stars >= 2 ? 'Good try, go again!' : 'Keep practising, you can do it!';

  root.replaceChildren(
    h('div', { class: 'head' }, h('h2', { class: 'grow' }, chart.title), isBest ? h('span', { class: 'badge', style: 'background:var(--pink);color:#fff;font-size:14px;padding:4px 12px' }, 'New best!') : null),
    h('div', { class: 'body' },
      h('div', { class: 'col center', style: 'flex:1' },
        h('div', { class: 'bigstars', 'aria-label': `${res.stars} of 5 stars` }, '★'.repeat(res.stars), h('span', { class: 'off' }, '★'.repeat(5 - res.stars))),
        h('h2', null, msg),
        h('div', { class: 'stats', style: 'width:100%' },
          h('div', { class: 'stat' }, h('b', null, res.score), h('span', null, 'Score')),
          h('div', { class: 'stat' }, h('b', null, `${Math.round(res.accuracy)}%`), h('span', null, 'Accuracy')),
          h('div', { class: 'stat' }, h('b', null, res.maxCombo), h('span', null, 'Best combo')),
          h('div', { class: 'stat' }, h('b', null, `${res.counts.perfect}`), h('span', null, 'Perfect'))),
        h('p', { class: 'small-text muted' }, `Good ${res.counts.good} · OK ${res.counts.ok} · Missed ${res.counts.miss}`),
        h('div', { style: 'width:100%' }, h('div', { class: 'tend' }, h('i', { style: `left:${pos}%` })),
          h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'small-text muted' }, 'early'), h('span', { class: 'small-text' }, tend), h('span', { class: 'small-text muted' }, 'late'))),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn big green', onclick: () => beginGame() }, 'Play again'),
          h('button', { class: 'btn big ghost', onclick: () => goHome() }, 'Home'))),
      h('div', { class: 'panel scroll', style: 'flex:.8' }, h('div', { class: 'label' }, 'Each drum'),
        lanesUsed.map((l) => {
          const p = res.perLane[l];
          return h('div', { class: 'lane-row' }, h('span', { style: `color:${LANE_INFO[l].color}` }, LANE_INFO[l].label),
            h('div', { class: 'b' }, h('i', { style: `width:${p.total ? (p.hit / p.total) * 100 : 0}%;background:${LANE_INFO[l].color}` })),
            h('span', null, `${p.hit}/${p.total}`));
        }))));
}

// ---------- navigation ----------
async function goHome() {
  calCleanup();
  await refreshSongs();
  show('home');
  renderHome();
}

// ---------- boot ----------
async function boot() {
  wirePlay();
  // Paint first, never wait on mic or storage.
  show('home');
  renderHome();
  await refreshSongs();
  if (S.screen === 'home') renderHome();
  try {
    const prof = await store.getProfile();
    if (prof) {
      S.hasProfile = true;
      // No stored preference at all + a saved calibration: default the mic on. An explicit stored false is respected.
      if (lsGet('mic', NO_PREF) === NO_PREF) { S.mic = true; }
      if (S.screen === 'home') renderHomePanel();
    }
  } catch { /* storage unavailable */ }
}
window.__drumHero = S; // debug/test hook
boot();

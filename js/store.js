// Drum Hero storage: IndexedDB with an in-memory fallback (the app still runs if storage is blocked).

const DB_NAME = 'drumhero';
const DB_VERSION = 1;

const mem = { songs: new Map(), audio: new Map(), kv: new Map(), scores: [] };
let dbPromise = null;
let mode = 'unknown'; // 'indexeddb' | 'memory'

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const idb = globalThis.indexedDB;
      if (!idb) { mode = 'memory'; return resolve(null); }
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('songs', { keyPath: 'id' });
        db.createObjectStore('audio', { keyPath: 'id' });
        db.createObjectStore('kv', { keyPath: 'key' });
        db.createObjectStore('scores', { keyPath: 'key', autoIncrement: true });
      };
      req.onsuccess = () => { mode = 'indexeddb'; resolve(req.result); };
      req.onerror = () => { mode = 'memory'; resolve(null); };
      req.onblocked = () => { mode = 'memory'; resolve(null); };
    } catch {
      mode = 'memory';
      resolve(null);
    }
  });
  return dbPromise;
}

/** Run fn(objectStore) in a transaction; resolves to the request result. Rejects on any failure. */
async function idb(storeName, rw, fn) {
  const db = await openDb();
  if (!db) throw new Error('no-idb');
  return new Promise((resolve, reject) => {
    let req;
    try {
      const t = db.transaction(storeName, rw);
      req = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error || new Error('tx-error'));
      t.onabort = () => reject(t.error || new Error('tx-abort'));
    } catch (e) { reject(e); }
  });
}

export function storageMode() { return mode; }

export async function listSongs() {
  let out = [];
  try { out = (await idb('songs', 'readonly', (s) => s.getAll())) || []; } catch { /* fall through to memory */ }
  const seen = new Set(out.map((s) => s.id));
  for (const s of mem.songs.values()) if (!seen.has(s.id)) out.push(s);
  return out.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

export async function saveSong(chart) {
  const song = { ...chart, addedAt: chart.addedAt || Date.now() };
  try { await idb('songs', 'readwrite', (s) => s.put(song)); mem.songs.delete(song.id); }
  catch { mem.songs.set(song.id, song); }
  return song;
}

export async function deleteSong(id) {
  mem.songs.delete(id);
  mem.audio.delete(id);
  mem.scores = mem.scores.filter((s) => s.songId !== id);
  try { await idb('songs', 'readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
  try { await idb('audio', 'readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
  try {
    const all = (await idb('scores', 'readonly', (s) => s.getAll())) || [];
    for (const r of all) if (r.songId === id) await idb('scores', 'readwrite', (s) => s.delete(r.key));
  } catch { /* ignore */ }
}

export async function saveAudio(id, blob) {
  try { await idb('audio', 'readwrite', (s) => s.put({ id, blob })); mem.audio.delete(id); }
  catch { mem.audio.set(id, blob); }
}

export async function getAudio(id) {
  if (!id) return null;
  if (mem.audio.has(id)) return mem.audio.get(id);
  try { return (await idb('audio', 'readonly', (s) => s.get(id)))?.blob || null; } catch { return null; }
}

export async function getProfile() {
  try {
    const r = await idb('kv', 'readonly', (s) => s.get('profile'));
    if (r) return r.value;
  } catch { /* ignore */ }
  return mem.kv.get('profile') || null;
}

export async function saveProfile(obj) {
  try { await idb('kv', 'readwrite', (s) => s.put({ key: 'profile', value: obj })); mem.kv.delete('profile'); }
  catch { mem.kv.set('profile', obj); }
}

export async function getScores(songId) {
  let out = [];
  try { out = ((await idb('scores', 'readonly', (s) => s.getAll())) || []).filter((r) => r.songId === songId); } catch { /* ignore */ }
  out = out.concat(mem.scores.filter((r) => r.songId === songId));
  return out.sort((a, b) => b.score - a.score);
}

export async function saveScore(songId, score) {
  const rec = { ...score, songId, date: score.date || Date.now() };
  try { await idb('scores', 'readwrite', (s) => s.add(rec)); }
  catch { mem.scores.push(rec); }
  return rec;
}

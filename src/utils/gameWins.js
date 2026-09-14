// Win capture + best-time helpers (Slice 04).
// Backend POST is best-effort; localStorage always mirrors for offline/dev.

const BEST_TIMES_KEY = 'surfcad.game.bestTimes';
const WINS_MIRROR_KEY = 'surfcad.game.winsMirror';
const CLIENT_ID_KEY = 'surfcad.game.clientId';
const MIRROR_MAX = 50;

function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function getClientId() {
  if (typeof localStorage === 'undefined') return 'unknown';
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      localStorage.setItem(CLIENT_ID_KEY, id);
    } catch {
      /* ignore quota */
    }
  }
  return id;
}

function getBuildId() {
  try {
    return import.meta.env?.VITE_BUILD_ID
      || import.meta.env?.MODE
      || 'dev';
  } catch {
    return 'dev';
  }
}

/** @returns {Record<string, number>} puzzleId → best timeMs */
export function loadBestTimes() {
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(BEST_TIMES_KEY);
  const parsed = safeParse(raw, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** @returns {number|null} */
export function getBestTimeMs(puzzleId) {
  if (!puzzleId) return null;
  const t = loadBestTimes()[puzzleId];
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

/**
 * Update best time if this run is better. Returns the new best (or previous).
 * @returns {number}
 */
export function updateBestTime(puzzleId, timeMs) {
  const ms = Math.max(0, Number(timeMs) || 0);
  // Guard: never write empty/falsy keys (callers should pass 'unknown').
  if (!puzzleId || typeof puzzleId !== 'string') return ms;
  const map = loadBestTimes();
  const prev = map[puzzleId];
  if (typeof prev !== 'number' || ms < prev) {
    map[puzzleId] = ms;
    try {
      localStorage.setItem(BEST_TIMES_KEY, JSON.stringify(map));
    } catch (err) {
      console.warn('[gameWins] Failed to persist best time:', err);
    }
    return ms;
  }
  return prev;
}

function mirrorWinLocally(record) {
  if (typeof localStorage === 'undefined') return;
  try {
    const list = safeParse(localStorage.getItem(WINS_MIRROR_KEY), []);
    const arr = Array.isArray(list) ? list : [];
    arr.push(record);
    while (arr.length > MIRROR_MAX) arr.shift();
    localStorage.setItem(WINS_MIRROR_KEY, JSON.stringify(arr));
  } catch (err) {
    console.warn('[gameWins] localStorage mirror failed:', err);
  }
}

/**
 * Persist a win: update best time, mirror to localStorage, POST to backend.
 * Never throws — match UX must keep working if capture fails.
 *
 * @param {{ puzzleId: string, script: string, timeMs: number }} opts
 * @returns {Promise<{ bestTimeMs: number, posted: boolean }>}
 */
export async function recordWin({ puzzleId, script, timeMs }) {
  const timestamp = new Date().toISOString();
  const clientId = getClientId();
  const buildId = getBuildId();
  // Collapse empty/falsy ids so bestTimes never keys on "".
  const safePuzzleId = (typeof puzzleId === 'string' && puzzleId.trim())
    ? puzzleId.trim()
    : 'unknown';
  const record = {
    puzzleId: safePuzzleId,
    script: String(script ?? ''),
    timeMs: Math.max(0, Number(timeMs) || 0),
    timestamp,
    clientId,
    buildId,
  };

  const bestTimeMs = updateBestTime(record.puzzleId, record.timeMs);
  mirrorWinLocally(record);

  let posted = false;
  try {
    const res = await fetch('/api/wins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      console.warn('[gameWins] POST /api/wins failed:', res.status, await res.text().catch(() => ''));
    } else {
      posted = true;
    }
  } catch (err) {
    // Backend down / offline — non-blocking
    console.warn('[gameWins] POST /api/wins error (non-blocking):', err?.message || err);
  }

  return { bestTimeMs, posted };
}

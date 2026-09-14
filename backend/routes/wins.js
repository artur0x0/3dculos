// Append-only win capture for match-the-part puzzles (Slice 04).
// Writes one JSON line per POST to backend/data/wins.jsonl.
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GAME_PUZZLES } from '../../src/utils/gamePuzzles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const WINS_PATH = path.join(DATA_DIR, 'wins.jsonl');

/** Keep scripts small — puzzle solutions are short CAD snippets. */
const MAX_SCRIPT_CHARS = 10_000;
const MAX_CLIENT_ID_CHARS = 128;
const MAX_BUILD_ID_CHARS = 64;
/** Cap absurd / malicious times (24h). */
const MAX_TIME_MS = 24 * 60 * 60 * 1000;
/** Daily append quota for wins.jsonl (bytes). */
const MAX_BYTES_PER_DAY = 2 * 1024 * 1024;
/** Per-IP token bucket: max bursts of wins. */
const RATE_LIMIT_CAPACITY = 30;
const RATE_LIMIT_REFILL_PER_SEC = 0.5;

const KNOWN_PUZZLE_IDS = new Set(GAME_PUZZLES.map((p) => p.id));

/** @type {Map<string, { tokens: number, last: number }>} */
const ipBuckets = new Map();
let dayKey = '';
let dayBytes = 0;

const router = Router();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function refreshDayQuota() {
  const key = todayKey();
  if (key !== dayKey) {
    dayKey = key;
    dayBytes = 0;
    try {
      if (fs.existsSync(WINS_PATH)) {
        const st = fs.statSync(WINS_PATH);
        // Approximate: if file mtime is today, count full size toward quota.
        const mtimeDay = new Date(st.mtimeMs).toISOString().slice(0, 10);
        if (mtimeDay === key) dayBytes = st.size;
      }
    } catch {
      /* ignore */
    }
  }
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim().slice(0, 64);
  return (req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

function takeToken(ip) {
  const now = Date.now() / 1000;
  let bucket = ipBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, last: now };
    ipBuckets.set(ip, bucket);
  }
  const elapsed = Math.max(0, now - bucket.last);
  bucket.tokens = Math.min(
    RATE_LIMIT_CAPACITY,
    bucket.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC,
  );
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function normalizeTimestamp(raw) {
  if (typeof raw === 'string' && raw.length > 0 && !Number.isNaN(Date.parse(raw))) {
    return raw;
  }
  return new Date().toISOString();
}

router.post('/', (req, res) => {
  try {
    const body = req.body || {};
    const puzzleId = typeof body.puzzleId === 'string' ? body.puzzleId.trim() : '';
    const script = typeof body.script === 'string' ? body.script : '';
    const timeMs = Number(body.timeMs);

    if (!puzzleId || !KNOWN_PUZZLE_IDS.has(puzzleId)) {
      return res.status(400).json({ error: 'puzzleId must be a known pack id' });
    }
    if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS) {
      return res.status(400).json({ error: `timeMs must be in [0, ${MAX_TIME_MS}]` });
    }
    if (script.length > MAX_SCRIPT_CHARS) {
      return res.status(400).json({ error: `script exceeds ${MAX_SCRIPT_CHARS} chars` });
    }

    const ip = clientIp(req);
    if (!takeToken(ip)) {
      return res.status(429).json({ error: 'rate limit exceeded' });
    }

    refreshDayQuota();
    const record = {
      puzzleId,
      script,
      timeMs,
      timestamp: normalizeTimestamp(body.timestamp),
      clientId: typeof body.clientId === 'string'
        ? body.clientId.slice(0, MAX_CLIENT_ID_CHARS)
        : undefined,
      buildId: typeof body.buildId === 'string'
        ? body.buildId.slice(0, MAX_BUILD_ID_CHARS)
        : undefined,
      receivedAt: new Date().toISOString(),
    };
    const line = `${JSON.stringify(record)}\n`;
    if (dayBytes + line.length > MAX_BYTES_PER_DAY) {
      return res.status(429).json({ error: 'daily wins quota exceeded' });
    }

    ensureDataDir();
    fs.appendFileSync(WINS_PATH, line, 'utf8');
    dayBytes += line.length;
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[wins] Failed to append win:', err);
    return res.status(500).json({ error: 'Failed to store win' });
  }
});

export default router;

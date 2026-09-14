// Append-only win capture for match-the-part puzzles (Slice 04).
// Writes one JSON line per POST to backend/data/wins.jsonl.
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const WINS_PATH = path.join(DATA_DIR, 'wins.jsonl');
const MAX_SCRIPT_CHARS = 100_000;

const router = Router();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

router.post('/', (req, res) => {
  try {
    const body = req.body || {};
    const puzzleId = typeof body.puzzleId === 'string' ? body.puzzleId.trim() : '';
    const script = typeof body.script === 'string' ? body.script : '';
    const timeMs = Number(body.timeMs);

    if (!puzzleId) {
      return res.status(400).json({ error: 'puzzleId required' });
    }
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      return res.status(400).json({ error: 'timeMs must be a non-negative number' });
    }
    if (script.length > MAX_SCRIPT_CHARS) {
      return res.status(400).json({ error: `script exceeds ${MAX_SCRIPT_CHARS} chars` });
    }

    const record = {
      puzzleId,
      script,
      timeMs,
      timestamp: typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString(),
      clientId: typeof body.clientId === 'string' ? body.clientId.slice(0, 128) : undefined,
      buildId: typeof body.buildId === 'string' ? body.buildId.slice(0, 64) : undefined,
      receivedAt: new Date().toISOString(),
    };

    ensureDataDir();
    fs.appendFileSync(WINS_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[wins] Failed to append win:', err);
    return res.status(500).json({ error: 'Failed to store win' });
  }
});

export default router;

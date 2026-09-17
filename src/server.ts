import 'dotenv/config';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { listReservations, openDb, seed } from './booking/db.js';
import { inventoryState } from './booking/availability.js';
import { isoOf } from './booking/dates.js';
import { makeDriver, Session, type Inbound } from './pipeline.js';
import { MetricsWriter } from './voice/metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? resolve(root, 'data/booking.db');
const NOW = process.env.NOW_OVERRIDE ?? isoOf(new Date());

const db = openDb(DB_PATH);
// Reseed on boot so a demo always starts from the state in the README.
if (process.env.NO_RESEED !== '1') seed(db);

const app = express();
app.use(express.json());
app.use(express.static(resolve(here, 'web')));

/** The on-screen panel reads this, never anything the model said. */
app.get('/api/state', (_req, res) => {
  res.json({
    now: NOW,
    inventory: inventoryState(db, NOW),
    reservations: listReservations(db),
  });
});

app.post('/api/reset', (_req, res) => {
  seed(db);
  res.json({ ok: true, inventory: inventoryState(db, NOW), reservations: listReservations(db) });
});

// ------------------------------------------- fixture recording (local only)

const AUDIO_DIR = resolve(root, 'tests/fixtures/audio');
const MANIFEST = resolve(AUDIO_DIR, 'manifest.json');

app.use('/fixture-audio', express.static(AUDIO_DIR));

app.get('/api/fixture-clips', (_req, res) => {
  if (!existsSync(MANIFEST)) {
    res.status(404).json({ error: 'no manifest - run npm run fixtures:audio' });
    return;
  }
  res.json(JSON.parse(readFileSync(MANIFEST, 'utf8')));
});

/** Overwrites one clip with a recording. Only names already in the manifest. */
app.post(
  '/api/fixture-audio/:file',
  express.raw({ type: 'audio/wav', limit: '25mb' }),
  (req, res) => {
    if (!existsSync(MANIFEST)) {
      res.status(404).send('no manifest');
      return;
    }
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      clips: Array<{ file: string }>;
    };
    const known = manifest.clips.some((c) => c.file === req.params.file);
    if (!known) {
      res.status(400).send('unknown clip name');
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 64) {
      res.status(400).send('empty recording');
      return;
    }
    writeFileSync(resolve(AUDIO_DIR, req.params.file), req.body);
    res.json({ ok: true, bytes: req.body.length });
  },
);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const metrics = new MetricsWriter(resolve(root, 'metrics/turns.jsonl'));

wss.on('connection', (ws) => {
  const session = new Session((msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)), {
    db,
    now: NOW,
    driver: makeDriver(),
    holdSecret: process.env.HOLD_TOKEN_SECRET,
    metrics,
    vadSilenceMs: Number(process.env.VAD_SILENCE_MS ?? 600),
  });
  session.start();

  ws.on('message', async (raw) => {
    let msg: Inbound;
    try {
      msg = JSON.parse(String(raw)) as Inbound;
    } catch {
      return;
    }
    try {
      await session.handle(msg);
    } catch (err) {
      console.error('session error', err);
    }
  });
});

server.listen(PORT, () => {
  const driver = makeDriver();
  console.log(`voice-booking listening on http://localhost:${PORT}`);
  console.log(`  database  ${DB_PATH}`);
  console.log(`  today     ${NOW}`);
  console.log(`  driver    ${driver.name} (${driver.model})`);
  if (driver.name === 'deterministic-planner') {
    console.log('  note      no ANTHROPIC_API_KEY set - running the deterministic planner');
  }
});

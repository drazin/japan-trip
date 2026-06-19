const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Storage: Postgres in production (survives redeploys), JSON file for local dev ---

let pool = null;
const EMPTY = { actions: {}, manual: [] };

async function initDb() {
  if (!DATABASE_URL) {
    console.log('No DATABASE_URL set — using local file storage (dev mode)');
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated TIMESTAMPTZ DEFAULT now()
    )
  `);
  console.log('Connected to Postgres');
}

const DATA_FILE = path.join(__dirname, 'shared-actions.json');

async function readActions() {
  if (pool) {
    const { rows } = await pool.query('SELECT data, updated FROM app_state WHERE id = 1');
    if (!rows.length) return EMPTY;
    return { ...rows[0].data, updated: rows[0].updated };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return EMPTY;
  }
}

async function writeActions(data) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_state (id, data, updated) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated = now()`,
      [JSON.stringify(data)]
    );
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify({ ...data, updated: new Date().toISOString() }, null, 2));
}

app.get('/api/state', async (req, res) => {
  try {
    res.json(await readActions());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read state' });
  }
});

app.post('/api/state', async (req, res) => {
  const { actions, manual } = req.body;
  if (!actions) return res.status(400).json({ error: 'Missing actions' });
  try {
    await writeActions({ actions, manual: manual || [] });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to write state' });
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Japan trip dashboard on port ${PORT}`)))
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway provisions a Postgres database and injects DATABASE_URL.
// When it's present we persist shared state in Postgres; otherwise we fall
// back to a local JSON file so `npm start` works for local development.
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_FILE = path.join(__dirname, 'shared-actions.json');
const DEFAULT_STATE = { actions: {}, manual: [] };

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

let store;

// --- Postgres-backed store -------------------------------------------------
function createPgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    // Railway's internal connection string does not use SSL. Set PGSSL=true
    // if connecting over the public proxy.
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id   TEXT PRIMARY KEY,
        data JSONB NOT NULL
      )
    `);
  }

  async function read() {
    const { rows } = await pool.query(
      `SELECT data FROM app_state WHERE id = 'singleton'`
    );
    return rows.length ? rows[0].data : { ...DEFAULT_STATE };
  }

  async function write(data) {
    await pool.query(
      `INSERT INTO app_state (id, data) VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [data]
    );
  }

  return { init, read, write };
}

// --- File-backed store (local dev fallback) --------------------------------
function createFileStore() {
  async function init() {}

  async function read() {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  async function write(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }

  return { init, read, write };
}

app.get('/api/state', async (req, res) => {
  try {
    res.json(await store.read());
  } catch (err) {
    console.error('Failed to read state:', err);
    res.status(500).json({ error: 'Failed to read state' });
  }
});

app.post('/api/state', async (req, res) => {
  const { actions, manual } = req.body;
  if (!actions) return res.status(400).json({ error: 'Missing actions' });
  try {
    await store.write({
      actions,
      manual: manual || [],
      updated: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to write state:', err);
    res.status(500).json({ error: 'Failed to write state' });
  }
});

async function start() {
  store = DATABASE_URL ? createPgStore() : createFileStore();
  await store.init();
  app.listen(PORT, () =>
    console.log(
      `Japan trip dashboard on port ${PORT} ` +
        `(${DATABASE_URL ? 'postgres' : 'file'} storage)`
    )
  );
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

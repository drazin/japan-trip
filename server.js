const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS captures (
      id SERIAL PRIMARY KEY,
      source_url TEXT,
      caption TEXT,
      category TEXT,
      place JSONB,
      status TEXT DEFAULT 'pending',
      needs_caption BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      start_date  DATE,
      end_date    DATE,
      segments    JSONB DEFAULT '[]',
      hotels      JSONB DEFAULT '[]',
      base_places JSONB DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE app_state ADD COLUMN IF NOT EXISTS trip_id TEXT`);
  await pool.query(`ALTER TABLE captures ADD COLUMN IF NOT EXISTS trip_id TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS app_state_trip_uidx ON app_state(trip_id)`);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS app_state_id_seq`);
  await pool.query(`SELECT setval('app_state_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM app_state), 1))`);
  await pool.query(`ALTER TABLE app_state ALTER COLUMN id SET DEFAULT nextval('app_state_id_seq')`);
  console.log('Connected to Postgres');
}

const DATA_FILE = path.join(__dirname, 'shared-actions.json');

async function readActions(tripId) {
  const tid = tripId || 'japan-2026';
  if (pool) {
    const { rows } = await pool.query('SELECT data, updated FROM app_state WHERE trip_id = $1', [tid]);
    if (!rows.length) return EMPTY;
    return { ...rows[0].data, updated: rows[0].updated };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return EMPTY;
  }
}

async function writeActions(tripId, data) {
  const tid = tripId || 'japan-2026';
  if (pool) {
    await pool.query(
      `INSERT INTO app_state (trip_id, data, updated) VALUES ($1, $2, now())
       ON CONFLICT (trip_id) DO UPDATE SET data = $2, updated = now()`,
      [tid, JSON.stringify(data)]
    );
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify({ ...data, updated: new Date().toISOString() }, null, 2));
}

app.get('/api/state', async (req, res) => {
  try {
    res.json(await readActions(req.query.trip));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read state' });
  }
});

app.post('/api/state', async (req, res) => {
  const { actions, manual, dayPlans, tripId } = req.body;
  if (!actions) return res.status(400).json({ error: 'Missing actions' });
  try {
    await writeActions(tripId, { actions, manual: manual || [], dayPlans: dayPlans || {} });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to write state' });
  }
});

// --- Instagram capture ---------------------------------------------------

const CITY_COORDS = {
  Tokyo: [35.68, 139.77], Kyoto: [35.01, 135.77], Osaka: [34.69, 135.50],
  Kanazawa: [36.56, 136.66], Hakone: [35.23, 139.06], Nara: [34.69, 135.80],
  Hiroshima: [34.39, 132.46], Nikko: [36.75, 139.61], Yokohama: [35.44, 139.64],
};
const CATEGORIES = ['Food', 'Experience', 'Attraction', 'Shopping', 'Temple/Shrine'];
const CAPTION_MAX = 12000;

// Deterministic jitter so map pins don't stack exactly. Avoids Math.random for testability.
let jitterSeed = 1;
function cityLatLng(city) {
  const base = CITY_COORDS[city] || CITY_COORDS.Tokyo;
  jitterSeed = (jitterSeed * 9301 + 49297) % 233280;
  const r = jitterSeed / 233280;
  return [base[0] + (r - 0.5) * 0.02, base[1] + (r - 0.5) * 0.02];
}

// Simple in-memory per-IP rate limit: max N requests per window.
const rl = new Map();
function rateLimited(ip, max = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (rl.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  rl.set(ip, hits);
  return hits.length > max;
}

async function fetchCaption(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TripBot/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const html = await res.text();
    const m = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
    if (!m) return '';
    return m[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim();
  } catch {
    return '';
  }
}

function toPlace(raw, sourceUrl, categoryOverride) {
  const city = (raw.city || 'Tokyo').trim();
  const [lat, lng] = cityLatLng(city);
  let category = categoryOverride || raw.category || 'Experience';
  if (!CATEGORIES.includes(category)) category = 'Experience';
  return {
    name: (raw.name || 'Unknown').trim(),
    city,
    neighborhood: (raw.neighborhood || '').trim(),
    category,
    why: (raw.why || '').trim(),
    family_fit: (raw.family_fit || '').trim(),
    booking: (raw.booking || '').trim(),
    priority: Number.isInteger(raw.priority) ? raw.priority : 3,
    heat: (raw.heat || 'Indoor').trim(),
    days: '',
    source: 'Instagram',
    lat, lng,
    url: sourceUrl || '',
  };
}

async function enrich(caption) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2000,
    tool_choice: { type: 'tool', name: 'record_places' },
    tools: [{
      name: 'record_places',
      description: 'Record every distinct real-world place (restaurant, shop, attraction, temple, experience) mentioned in an Instagram caption about Japan travel.',
      input_schema: {
        type: 'object',
        properties: {
          places: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Place name' },
                city: { type: 'string', description: 'Japanese city, e.g. Tokyo, Kyoto, Osaka. Best guess.' },
                neighborhood: { type: 'string' },
                category: { type: 'string', enum: CATEGORIES },
                why: { type: 'string', description: 'One short sentence on why it is worth visiting.' },
                family_fit: { type: 'string', description: 'Short note on suitability for a family with kids/teens.' },
                booking: { type: 'string', description: 'Reservation needs if mentioned, else empty.' },
                heat: { type: 'string', description: 'Indoor, Outdoor, or Evening.' },
                priority: { type: 'integer', minimum: 1, maximum: 5 },
              },
              required: ['name', 'city', 'category', 'why'],
            },
          },
        },
        required: ['places'],
      },
    }],
    messages: [{
      role: 'user',
      content: `Extract every distinct place from this Instagram caption. If it mentions no real place, return an empty list. Caption:\n\n${caption}`,
    }],
  });
  const tool = msg.content.find(c => c.type === 'tool_use');
  return (tool && tool.input && Array.isArray(tool.input.places)) ? tool.input.places : [];
}

app.post('/api/capture', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (rateLimited(String(ip).split(',')[0].trim())) {
    return res.status(429).json({ ok: false, code: 'rate_limited', message: 'Too many captures — try again in a few minutes.' });
  }
  let { url, caption, category } = req.body || {};
  url = (url || '').trim();
  caption = (caption || '').trim();
  category = (category || '').trim() || null;
  if (!url) return res.status(400).json({ ok: false, code: 'no_url', message: 'A URL is required.' });
  if (category && !CATEGORIES.includes(category)) category = null;
  if (caption.length > CAPTION_MAX) caption = caption.slice(0, CAPTION_MAX);

  if (!ANTHROPIC_API_KEY) {
    return res.json({ ok: false, code: 'no_api_key', message: 'Enrichment not configured yet — add ANTHROPIC_API_KEY to enable AI capture.' });
  }
  if (!pool) {
    return res.json({ ok: false, code: 'no_db', message: 'Database not available.' });
  }

  try {
    if (!caption) caption = await fetchCaption(url);
    if (!caption) {
      await pool.query(
        `INSERT INTO captures (source_url, caption, category, place, needs_caption) VALUES ($1, '', $2, NULL, true)`,
        [url, category]
      );
      return res.json({ ok: true, code: 'needs_caption', count: 0, message: "Couldn't read the caption — paste it in the Pending panel to finish." });
    }
    const raw = await enrich(caption);
    if (!raw.length) {
      return res.json({ ok: true, code: 'no_places', count: 0, message: 'No places found in that post.' });
    }
    for (const r of raw) {
      const place = toPlace(r, url, category);
      await pool.query(
        `INSERT INTO captures (source_url, caption, category, place) VALUES ($1, $2, $3, $4)`,
        [url, caption, category, JSON.stringify(place)]
      );
    }
    res.json({ ok: true, code: 'ok', count: raw.length, message: `${raw.length} place${raw.length === 1 ? '' : 's'} found — review in Pending.` });
  } catch (err) {
    console.error('capture failed', err);
    res.status(500).json({ ok: false, code: 'error', message: 'Capture failed: ' + (err.message || 'unknown error') });
  }
});

app.get('/api/pending', async (req, res) => {
  if (!pool) return res.json({ pending: [] });
  try {
    const { rows } = await pool.query(
      `SELECT id, source_url, place, needs_caption, created_at FROM captures WHERE status = 'pending' ORDER BY created_at DESC, id DESC`
    );
    res.json({ pending: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read pending' });
  }
});

app.post('/api/pending/approve', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'No database' });
  const ids = (req.body && req.body.ids) || [];
  const edits = (req.body && req.body.edits) || {};
  if (!ids.length) return res.json({ ok: true, places: [] });
  try {
    const { rows } = await pool.query(
      `SELECT id, place FROM captures WHERE id = ANY($1) AND status = 'pending' AND place IS NOT NULL`, [ids]
    );
    const places = rows.map(r => ({ ...r.place, ...(edits[r.id] || {}) }));
    await pool.query(`UPDATE captures SET status = 'approved' WHERE id = ANY($1)`, [ids]);
    res.json({ ok: true, places });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve' });
  }
});

app.post('/api/pending/reject', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'No database' });
  const ids = (req.body && req.body.ids) || [];
  if (!ids.length) return res.json({ ok: true });
  try {
    await pool.query(`UPDATE captures SET status = 'rejected' WHERE id = ANY($1)`, [ids]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject' });
  }
});

app.post('/api/pending/enrich', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'No database' });
  if (!ANTHROPIC_API_KEY) return res.json({ ok: false, code: 'no_api_key', message: 'Add ANTHROPIC_API_KEY to enable enrichment.' });
  const id = req.body && req.body.id;
  let caption = ((req.body && req.body.caption) || '').trim();
  if (!id || !caption) return res.status(400).json({ ok: false, message: 'id and caption required' });
  if (caption.length > CAPTION_MAX) caption = caption.slice(0, CAPTION_MAX);
  try {
    const { rows } = await pool.query(`SELECT source_url, category FROM captures WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Capture not found' });
    const { source_url, category } = rows[0];
    const raw = await enrich(caption);
    await pool.query(`DELETE FROM captures WHERE id = $1`, [id]);
    for (const r of raw) {
      const place = toPlace(r, source_url, category);
      await pool.query(
        `INSERT INTO captures (source_url, caption, category, place) VALUES ($1, $2, $3, $4)`,
        [source_url, caption, category, JSON.stringify(place)]
      );
    }
    res.json({ ok: true, count: raw.length, message: raw.length ? `${raw.length} place(s) found.` : 'No places found.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Enrich failed: ' + (err.message || 'error') });
  }
});

app.post('/api/plan-day', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.json({ ok: false, code: 'no_api_key', message: 'Add ANTHROPIC_API_KEY to enable AI planning.' });
  }
  const { city, theme, date, slots, candidates } = req.body || {};
  if (!Array.isArray(candidates) || !candidates.length) {
    return res.json({ ok: false, message: 'No candidate places to plan from.' });
  }
  try {
    const allowed = new Set(candidates.map(c => c.name));
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const slotList = (slots && slots.length) ? slots : [{ time: 'All day', hood: '' }];
    const candText = candidates.slice(0, 60).map(c =>
      `- ${c.name} | ${c.category || '?'} | ${c.neighborhood || '?'} | ~${c.distanceKm}km from focus | ${(c.why || '').slice(0, 80)}`
    ).join('\n');
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1600,
      tool_choice: { type: 'tool', name: 'day_plan' },
      tools: [{
        name: 'day_plan',
        description: 'Produce an ordered, geographically sensible day itinerary using ONLY the candidate places provided.',
        input_schema: {
          type: 'object',
          properties: {
            slots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  time: { type: 'string' },
                  picks: {
                    type: 'array',
                    items: { type: 'object', properties: { name: { type: 'string' }, note: { type: 'string' } }, required: ['name'] },
                  },
                  flow: { type: 'string', description: 'One short sentence on the flow/logic of this slot.' },
                },
                required: ['time', 'picks'],
              },
            },
          },
          required: ['slots'],
        },
      }],
      messages: [{
        role: 'user',
        content: `Plan ${date || ''} in ${city} (day theme: ${theme || 'n/a'}).\n\nTime slots and their focus neighborhoods:\n${slotList.map(s => `- ${s.time}: ${s.hood || '(no focus set)'}`).join('\n')}\n\nFor each slot pick a realistic, geographically sensible set of 2-4 stops, ordered logically, using ONLY the candidate places below (distances from each slot's focus are listed). Prefer closer places and higher-interest spots; don't overload a slot. Give each pick a short note and each slot a one-line 'flow' note. Candidate places:\n${candText}`,
      }],
    });
    const tool = msg.content.find(c => c.type === 'tool_use');
    const raw = (tool && tool.input && Array.isArray(tool.input.slots)) ? tool.input.slots : [];
    const plan = {
      slots: raw.map(s => ({
        time: s.time || '',
        flow: s.flow || '',
        picks: (s.picks || []).filter(p => p && allowed.has(p.name)).map(p => ({ name: p.name, note: p.note || '' })),
      })),
    };
    res.json({ ok: true, plan });
  } catch (err) {
    console.error('plan-day failed', err);
    res.status(500).json({ ok: false, message: 'Plan failed: ' + (err.message || 'error') });
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Japan trip dashboard on port ${PORT}`)))
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });

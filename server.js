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
function jitterAround(base) {
  jitterSeed = (jitterSeed * 9301 + 49297) % 233280;
  const r = jitterSeed / 233280;
  return [base[0] + (r - 0.5) * 0.02, base[1] + (r - 0.5) * 0.02];
}
function cityLatLng(city) {
  return jitterAround(CITY_COORDS[city] || CITY_COORDS.Tokyo);
}

// Trip location context (cities + a fallback coordinate) so capture/enrich isn't Japan-specific.
async function tripContext(tripId) {
  const empty = { cities: [], region: '', fallback: null };
  if (!pool || !tripId) return empty;
  try {
    const { rows } = await pool.query('SELECT segments, hotels FROM trips WHERE id = $1', [tripId]);
    if (!rows.length) return empty;
    const segs = rows[0].segments || [], hotels = rows[0].hotels || [];
    const cities = [...new Set(segs.map(s => s && s.city).filter(Boolean))];
    const h = hotels.find(x => typeof x.lat === 'number');
    return { cities, region: cities.join(', '), fallback: h ? [h.lat, h.lng] : null };
  } catch (e) { return empty; }
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

function toPlace(raw, sourceUrl, categoryOverride, ctx) {
  const defaultCity = (ctx && ctx.cities && ctx.cities[0]) || 'Tokyo';
  const city = (raw.city || defaultCity).trim();
  const [lat, lng] = (ctx && ctx.fallback) ? jitterAround(ctx.fallback) : cityLatLng(city);
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

async function enrich(caption, ctx) {
  const region = (ctx && ctx.region) ? ctx.region : '';
  const cities = (ctx && ctx.cities && ctx.cities.length) ? ctx.cities.join(', ') : '';
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2000,
    tool_choice: { type: 'tool', name: 'record_places' },
    tools: [{
      name: 'record_places',
      description: 'Record every distinct real-world place (restaurant, bar, cafe, shop, attraction, experience) mentioned in an Instagram caption about a trip' + (region ? ' to the ' + region + ' area' : '') + '.',
      input_schema: {
        type: 'object',
        properties: {
          places: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Place name' },
                city: { type: 'string', description: 'City/town the place is in.' + (cities ? ' Likely one of: ' + cities + '.' : '') + ' Best guess.' },
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
      content: `Extract every distinct place from this Instagram caption.` + (region ? ` This is for a trip to the ${region} area, so place the spots in that region.` : '') + ` If it mentions no real place, return an empty list. Caption:\n\n${caption}`,
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
  let { url, caption, category, tripId } = req.body || {};
  url = (url || '').trim();
  caption = (caption || '').trim();
  category = (category || '').trim() || null;
  tripId = (tripId || '').trim() || 'japan-2026';
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
        `INSERT INTO captures (source_url, caption, category, place, needs_caption, trip_id) VALUES ($1, '', $2, NULL, true, $3)`,
        [url, category, tripId]
      );
      return res.json({ ok: true, code: 'needs_caption', count: 0, message: "Couldn't read the caption — paste it in the Pending panel to finish." });
    }
    const ctx = await tripContext(tripId);
    const raw = await enrich(caption, ctx);
    if (!raw.length) {
      return res.json({ ok: true, code: 'no_places', count: 0, message: 'No places found in that post.' });
    }
    for (const r of raw) {
      const place = toPlace(r, url, category, ctx);
      const g = await geocodeQuery(place.name + ', ' + place.city);
      if (g.lat) { place.lat = g.lat; place.lng = g.lng; }
      await pool.query(
        `INSERT INTO captures (source_url, caption, category, place, trip_id) VALUES ($1, $2, $3, $4, $5)`,
        [url, caption, category, JSON.stringify(place), tripId]
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
    const tid = req.query.trip || 'japan-2026';
    const { rows } = await pool.query(
      `SELECT id, source_url, place, needs_caption, created_at FROM captures WHERE status = 'pending' AND trip_id = $1 ORDER BY created_at DESC, id DESC`,
      [tid]
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
    const { rows } = await pool.query(`SELECT source_url, category, trip_id FROM captures WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Capture not found' });
    const { source_url, category, trip_id } = rows[0];
    const ctx = await tripContext(trip_id);
    const raw = await enrich(caption, ctx);
    await pool.query(`DELETE FROM captures WHERE id = $1`, [id]);
    for (const r of raw) {
      const place = toPlace(r, source_url, category, ctx);
      const g = await geocodeQuery(place.name + ', ' + place.city);
      if (g.lat) { place.lat = g.lat; place.lng = g.lng; }
      await pool.query(
        `INSERT INTO captures (source_url, caption, category, place, trip_id) VALUES ($1, $2, $3, $4, $5)`,
        [source_url, caption, category, JSON.stringify(place), trip_id]
      );
    }
    res.json({ ok: true, count: raw.length, message: raw.length ? `${raw.length} place(s) found.` : 'No places found.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Enrich failed: ' + (err.message || 'error') });
  }
});

app.post('/api/place-info', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ ok: false, code: 'no_api_key', message: 'Add ANTHROPIC_API_KEY to enable AI lookup.' });
  const name = ((req.body && req.body.name) || '').trim();
  const city = ((req.body && req.body.city) || '').trim();
  if (!name) return res.status(400).json({ ok: false, message: 'name required' });
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      tool_choice: { type: 'tool', name: 'place_info' },
      tools: [{
        name: 'place_info',
        description: 'Best-guess typical visitor details for a real place. These are ESTIMATES from general knowledge, not live data — the user will verify. If unsure of a field, leave it empty rather than guessing wildly.',
        input_schema: {
          type: 'object',
          properties: {
            hours: { type: 'string', description: 'Typical opening hours, concise, e.g. "11am–9pm, closed Mon". Empty if unknown.' },
            cost: { type: 'string', description: 'Rough price level / ticket cost, e.g. "$$ ~$30pp", "Free", "¥2000". Empty if unknown.' },
            lead: { type: 'string', description: 'Reservation lead time / how to book, e.g. "Reserve 2–4 weeks ahead", "Walk-in only". Empty if unknown.' },
          },
          required: [],
        },
      }],
      messages: [{ role: 'user', content: `Give typical visitor details for: ${name}${city ? ', ' + city : ''}.` }],
    });
    const tool = msg.content.find(c => c.type === 'tool_use');
    const info = (tool && tool.input) || {};
    res.json({ ok: true, info: { hours: info.hours || '', cost: info.cost || '', lead: info.lead || '' } });
  } catch (err) {
    console.error('place-info failed', err);
    res.status(500).json({ ok: false, message: 'Lookup failed: ' + (err.message || 'error') });
  }
});

app.post('/api/plan-day', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.json({ ok: false, code: 'no_api_key', message: 'Add ANTHROPIC_API_KEY to enable AI planning.' });
  }
  const { city, theme, date, slots, candidates, context } = req.body || {};
  if (!Array.isArray(candidates) || !candidates.length) {
    return res.json({ ok: false, message: 'No candidate places to plan from.' });
  }
  const ctx = context || {};
  try {
    const allowed = new Set(candidates.map(c => c.name));
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const slotList = (slots && slots.length) ? slots : [{ time: 'All day', hood: '' }];
    const anyFocus = slotList.some(s => s.hood);
    const candText = candidates.slice(0, 60).map(c =>
      `- ${c.name} | ${c.category || '?'} | ${c.neighborhood || '?'} | ~${c.distanceKm}km${c.hours ? ' | hours: ' + c.hours : ''}${c.cost ? ' | ' + c.cost : ''} | ${(c.why || '').slice(0, 70)}`
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
        content: `Plan ${date || ''} in ${city} (day theme: ${theme || 'n/a'}).\n`
          + (ctx.travelers ? `Travelers: ${JSON.stringify(ctx.travelers)} — pace it for the kids and pick kid-friendly options.\n` : '')
          + (ctx.hotel ? `Home base today: ${ctx.hotel.name}${ctx.hotel.neighborhood ? ' (' + ctx.hotel.neighborhood + ')' : ''}. Start the day from here, keep travel reasonable, and group stops to minimize backtracking. Candidate distances below are from this home base.\n` : '')
          + (ctx.logistics ? `Logistics note: ${ctx.logistics} — keep this day lighter / account for transit time.\n` : '')
          + (Array.isArray(ctx.booked) && ctx.booked.length
              ? `FIXED for this day — build the day AROUND these, do NOT move, change, or duplicate them; schedule other stops before/after at sensible times:\n${ctx.booked.map(b => `- ${b.name}${b.time ? ' @ ' + b.time : ''}${b.status === 'booked' ? ' (BOOKED)' : ''}${b.neighborhood ? ' — ' + b.neighborhood : ''}`).join('\n')}\nThis is a FILL-THE-GAPS task: keep the fixed items exactly as-is and add complementary nearby stops around them.\n`
              : '')
          + (Array.isArray(ctx.alreadyPlanned) && ctx.alreadyPlanned.length ? `Also already planned (don't duplicate): ${ctx.alreadyPlanned.join('; ')}.\n` : '')
          + `\nTime slots${anyFocus ? ' and their focus neighborhoods' : ''}:\n${slotList.map(s => `- ${s.time}${s.hood ? ': ' + s.hood : ''}`).join('\n')}\n\n`
          + (anyFocus ? '' : 'No specific focus area was set, so plan a sensible full day starting from the home base using the nearest candidates. ')
          + `For each slot pick a realistic, geographically sensible set of 2-4 stops, ordered logically, using ONLY the candidate places below. Prefer closer places and higher-interest spots; don't overload a slot. Where hours are listed, don't schedule a place at a time it's closed. Add a short note per pick, and a one-line 'flow' note per slot that mentions how to get between stops (e.g. walk / quick drive). Candidate places (distance from home base in km):\n${candText}`,
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

// --- Trips (multi-trip support) -----------------------------------------

app.get('/api/trips', async (req, res) => {
  try {
    if (!pool) return res.json({ trips: [] });
    const { rows } = await pool.query('SELECT id, name, start_date, end_date FROM trips ORDER BY start_date NULLS LAST, created_at');
    res.json({ trips: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list trips' });
  }
});

app.get('/api/trips/:id', async (req, res) => {
  try {
    if (!pool) return res.status(404).json({ error: 'no db' });
    const { rows } = await pool.query('SELECT id, name, start_date, end_date, segments, hotels, base_places FROM trips WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read trip' });
  }
});

app.post('/api/trips', async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ error: 'no db' });
    const { id, name, startDate, endDate, hotels, segments, basePlaces } = req.body || {};
    if (!id || typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || !name || typeof name !== 'string') {
      return res.status(400).json({ error: 'id (slug) and name required' });
    }
    await pool.query(
      `INSERT INTO trips (id, name, start_date, end_date, segments, hotels, base_places)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, start_date=$3, end_date=$4, segments=$5, hotels=$6, base_places=$7`,
      [id, name, startDate || null, endDate || null,
       JSON.stringify(segments || []), JSON.stringify(hotels || []), JSON.stringify(basePlaces || [])]
    );
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

app.put('/api/trips/:id', async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ error: 'no db' });
    const body = req.body || {};
    const COLS = {
      name: { col: 'name', json: false },
      startDate: { col: 'start_date', json: false },
      endDate: { col: 'end_date', json: false },
      hotels: { col: 'hotels', json: true },
      segments: { col: 'segments', json: true },
      basePlaces: { col: 'base_places', json: true },
    };
    const sets = [];
    const vals = [];
    for (const [key, meta] of Object.entries(COLS)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        vals.push(meta.json ? JSON.stringify(body[key] || []) : (body[key] || null));
        sets.push(`${meta.col} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    const { rowCount } = await pool.query(
      `UPDATE trips SET ${sets.join(', ')} WHERE id = $${vals.length}`,
      vals
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update trip' });
  }
});

// --- Geocoding proxy (free OpenStreetMap Nominatim) ---------------------

const geoCache = new Map();
async function geocodeQuery(q) {
  q = (q || '').trim();
  if (!q) return {};
  if (geoCache.has(q)) return geoCache.get(q);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q),
      { headers: { 'User-Agent': 'DrazinFamilyTripPlanner/1.0 (personal trip planner)' } });
    if (!r.ok) return {};
    const arr = await r.json();
    const out = (Array.isArray(arr) && arr.length) ? { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), display_name: arr[0].display_name } : {};
    if (out.lat) geoCache.set(q, out);
    return out;
  } catch (e) { return {}; }
}
app.get('/api/geocode', async (req, res) => {
  res.json(await geocodeQuery(req.query.q));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Japan trip dashboard on port ${PORT}`)))
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });

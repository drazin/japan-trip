// One-off: enrich the 63 "Portland ideas" Instagram saves into the portland-maine-chol
// trip. Mirrors the server capture pipeline (Claude extract -> geocode -> place),
// dedupes, writes to base_places. Also geocodes the hotel. Run: node scripts/import-portland-ig.js
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const API = 'https://japan-trip-production-3cf4.up.railway.app';
const TRIP = 'portland-maine-chol';
const KEY = fs.readFileSync('/tmp/portland/.key', 'utf8').trim();
const items = JSON.parse(fs.readFileSync('/tmp/portland/items.json', 'utf8'));
const client = new Anthropic({ apiKey: KEY });
const CATS = ['Food', 'Experience', 'Attraction', 'Shopping'];
const PORTLAND = [43.6591, -70.2568];
const sleep = ms => new Promise(r => setTimeout(r, ms));

let jseed = 11;
function jitter() { jseed = (jseed * 9301 + 49297) % 233280; return (jseed / 233280 - 0.5) * 0.012; }

const geoCache = new Map();
async function geocode(q) {
  if (geoCache.has(q)) return geoCache.get(q);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q),
      { headers: { 'User-Agent': 'DrazinFamilyTripPlanner/1.0 (personal)' } });
    const a = r.ok ? await r.json() : [];
    const out = (Array.isArray(a) && a.length) ? { lat: parseFloat(a[0].lat), lng: parseFloat(a[0].lon) } : null;
    if (out) geoCache.set(q, out);
    return out;
  } catch (e) { return null; }
}

async function enrich(caption) {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1500,
    tool_choice: { type: 'tool', name: 'record_places' },
    tools: [{
      name: 'record_places',
      description: 'Record every distinct real-world place (restaurant, bar, cafe, shop, attraction, activity) in the Portland, Maine area mentioned in an Instagram caption. If no real named place, return an empty list.',
      input_schema: {
        type: 'object',
        properties: { places: { type: 'array', items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            city: { type: 'string', description: 'Town/city in the Portland Maine area, e.g. Portland, South Portland, Cape Elizabeth, Freeport. Default Portland.' },
            neighborhood: { type: 'string', description: 'Neighborhood/street if mentioned (e.g. Old Port).' },
            category: { type: 'string', enum: CATS },
            why: { type: 'string', description: 'One short sentence on why it is worth visiting.' },
            family_fit: { type: 'string' },
            booking: { type: 'string', description: 'Reservation note if mentioned, else empty.' },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
          },
          required: ['name', 'city', 'category', 'why'],
        } } },
        required: ['places'],
      },
    }],
    messages: [{ role: 'user', content: `Extract Portland, Maine area places from this Instagram caption:\n\n${caption.slice(0, 8000)}` }],
  });
  const t = msg.content.find(c => c.type === 'tool_use');
  return (t && t.input && Array.isArray(t.input.places)) ? t.input.places : [];
}

(async () => {
  const trip = await (await fetch(`${API}/api/trips/${TRIP}`)).json();
  const existing = new Set((trip.base_places || []).map(p => (p.name || '').toLowerCase().trim()));

  // Geocode the hotel if missing
  const hotels = trip.hotels || [];
  for (const h of hotels) {
    if (typeof h.lat !== 'number') {
      const g = await geocode(`${h.name}, Portland, Maine`); await sleep(1200);
      if (g) { h.lat = g.lat; h.lng = g.lng; console.log(`hotel geocoded: ${h.name} -> ${g.lat},${g.lng}`); }
    }
  }

  const added = [];
  let i = 0;
  for (const it of items) {
    i++;
    let raw = [];
    try { raw = await enrich(it.caption); }
    catch (e) { console.log(`  [${i}/63] enrich error: ${e.message.slice(0,50)}`); continue; }
    if (!raw.length) { console.log(`  [${i}/63] no place`); continue; }
    for (const r of raw) {
      const name = (r.name || '').trim();
      if (!name || existing.has(name.toLowerCase())) { continue; }
      existing.add(name.toLowerCase());
      const city = (r.city || 'Portland').trim();
      let g = await geocode(`${name}, ${city}, Maine`); await sleep(1200);
      let lat, lng;
      if (g) { lat = g.lat; lng = g.lng; } else { lat = PORTLAND[0] + jitter(); lng = PORTLAND[1] + jitter(); }
      const cat = CATS.includes(r.category) ? r.category : 'Experience';
      added.push({ name, city, neighborhood: (r.neighborhood || '').trim(), category: cat,
        why: (r.why || '').trim(), family_fit: (r.family_fit || '').trim(), booking: (r.booking || '').trim(),
        priority: Number.isInteger(r.priority) ? r.priority : 3, heat: 'Indoor', days: '',
        source: 'Instagram', lat, lng, url: it.url });
      console.log(`  [${i}/63] + ${name} (${city}) ${g ? 'geo' : 'fallback'}`);
    }
  }

  console.log(`\nEnriched ${items.length} posts -> ${added.length} new places.`);
  const merged = [...(trip.base_places || []), ...added];
  const res = await fetch(`${API}/api/trips/${TRIP}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ basePlaces: merged, hotels }) });
  console.log(`PUT (${merged.length} places, hotels geocoded): ${res.status} ${await res.text()}`);
})();

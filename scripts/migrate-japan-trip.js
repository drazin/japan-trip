#!/usr/bin/env node
// One-time, IDEMPOTENT migration: seed the existing Japan trip into the `trips`
// table as id `japan-2026`, and tag existing app_state + captures rows with that
// trip_id (only where trip_id IS NULL). Safe to run multiple times.
//
// Usage:
//   DATABASE_URL="<prod DATABASE_PUBLIC_URL>" node scripts/migrate-japan-trip.js

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TRIP_ID = 'japan-2026';
const ROOT = path.resolve(__dirname, '..');

function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), 'utf8'));
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  // 2. Load input files.
  const places = loadJson('scripts/japan-places.json'); // base_places (282)
  const days = loadJson('scripts/japan-days.json');      // segments source (14)
  const trip = loadJson('trip.json');                    // hotels + days

  // 3. Build maps from trip.json days.
  const dayHotel = {};
  const dateByDay = {};
  for (const d of trip.days) {
    dayHotel[d.day] = d.hotel || null;
    dateByDay[d.day] = d.date || null;
  }
  // Default day 14's hotel to the final Tokyo hotel if missing.
  if (!dayHotel[14]) {
    dayHotel[14] = 'hotel-tokyo-final';
  }

  // 4. Build segments from japan-days.json.
  const segments = days.map((dy) => ({
    n: dy.n,
    dateLabel: dy.d,
    date: dateByDay[dy.n] || null,
    city: dy.c,
    theme: dy.t,
    hotelId: dayHotel[dy.n] || null,
  }));

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // 5. Upsert the trips row (idempotent).
    const upsertSql = `
      INSERT INTO trips (id, name, start_date, end_date, segments, hotels, base_places)
      VALUES ('japan-2026', 'Japan — Aug 2026', '2026-08-17', '2026-08-30', $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, start_date=EXCLUDED.start_date,
        end_date=EXCLUDED.end_date, segments=EXCLUDED.segments, hotels=EXCLUDED.hotels, base_places=EXCLUDED.base_places;
    `;
    await client.query(upsertSql, [
      JSON.stringify(segments),
      JSON.stringify(trip.hotels),
      JSON.stringify(places),
    ]);

    // 6. Tag existing rows ONLY where not already set (never overwrites).
    const appStateRes = await client.query(
      `UPDATE app_state SET trip_id='japan-2026' WHERE trip_id IS NULL;`
    );
    const capturesRes = await client.query(
      `UPDATE captures SET trip_id='japan-2026' WHERE trip_id IS NULL;`
    );

    // 7. Summary.
    const verify = await client.query(
      `SELECT jsonb_array_length(base_places) AS places,
              jsonb_array_length(hotels) AS hotels,
              jsonb_array_length(segments) AS segs
       FROM trips WHERE id = $1;`,
      [TRIP_ID]
    );
    const appStateTagged = await client.query(
      `SELECT count(*)::int AS c FROM app_state WHERE trip_id = $1;`,
      [TRIP_ID]
    );
    const capturesTagged = await client.query(
      `SELECT count(*)::int AS c FROM captures WHERE trip_id = $1;`,
      [TRIP_ID]
    );

    const v = verify.rows[0] || {};
    console.log('--- Migration summary ---');
    console.log(`trips row '${TRIP_ID}': base_places=${v.places}, hotels=${v.hotels}, segments=${v.segs}`);
    console.log(`app_state rows newly tagged this run: ${appStateRes.rowCount} (total tagged: ${appStateTagged.rows[0].c})`);
    console.log(`captures rows newly tagged this run: ${capturesRes.rowCount} (total tagged: ${capturesTagged.rows[0].c})`);
    console.log('Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

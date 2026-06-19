# Multi-Trip "Family Vacation Planner" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the hardcoded single Japan dashboard into a multi-trip personal planner: pick/create trips (name, dates, hotels, cities), ingest IG places, and plan per trip — with the existing capture + hotel-anchored day planner working for any trip. Japan becomes "Trip 1"; Portland Maine (Jul 2–5) is the first new trip / test.

**Architecture:** A `trips` table holds each trip's meta (name, dates, segments, hotels with geocoded coords, base places, day themes). The mutable per-trip state (`app_state`, `captures`) is scoped by `trip_id`, with the existing Japan data migrated to trip 1 so nothing is lost. The client loads the *active* trip from the server into the existing globals (`DATA`, `DAYS`, `TRIP`) instead of hardcoded literals; a trip switcher + "New Trip" onboarding create/select trips. Arbitrary hotels/places are geocoded via free OSM Nominatim (server-side proxy) with a paste-coords fallback.

**Tech Stack:** Node/Express, Postgres (`pg`), Anthropic SDK (already wired), vanilla JS single-file front end, OSM Nominatim for geocoding. No test framework exists; verification = `node --check`, local boot + `curl`, and manual browser checks.

**Process:** Work on a `multi-trip` git branch (NOT main) so the live Japan dashboard keeps running; merge → deploy only after the Japan migration is verified intact. Commit after each task.

---

## Phase 0 — Branch & safety net

### Task 0: Create branch and back up live state
**Step 1:** `git checkout -b multi-trip`
**Step 2:** Back up the live DB state (so migration is reversible):
`railway variables --service Postgres --json` → get `DATABASE_PUBLIC_URL`, then
`pg_dump "$DBURL" -t app_state -t captures > backups/state-pre-multitrip.sql`
**Verify:** backup file is non-empty.
**Step 3:** Commit the (empty) branch marker / this plan.

---

## Phase 1 — Data model & migration (Postgres)

### Task 1: `trips` table + `trip_id` columns
**Files:** Modify `server.js` `initDb()`.
**Step 1:** Add to `initDb()`:
```sql
CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_date  DATE,
  end_date    DATE,
  segments    JSONB DEFAULT '[]',   -- [{date, city, hotelId, theme}] per day
  hotels      JSONB DEFAULT '[]',   -- [{id,name,address,neighborhood,city,lat,lng,dates}]
  base_places JSONB DEFAULT '[]',   -- curated/seed places (Japan has 282; new trips []）
  created_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS trip_id TEXT;
ALTER TABLE captures  ADD COLUMN IF NOT EXISTS trip_id TEXT;
```
**Verify:** boot server locally against the prod `DATABASE_PUBLIC_URL` (read-only check) or a local pg; `\d trips` shows columns. `node --check server.js`.

### Task 2: One-time migration script — seed Trip 1 (Japan)
**Files:** Create `scripts/migrate-japan-trip.js`.
**Behavior:** Idempotent. Reads the inline `DATA` (extracted to `scripts/japan-places.json` in Task 6), `DAYS`, and `trip.json` hotels; upserts a `trips` row `id='japan-2026'` with name "Japan — Aug 2026", dates 2026-08-17..30, `hotels` (from trip.json, already geocoded), `base_places` (the 282), `segments` (one per day: {date, city, hotelId, theme} from DAYS + day→hotel). Then `UPDATE app_state SET trip_id='japan-2026' WHERE trip_id IS NULL; UPDATE captures SET trip_id='japan-2026' WHERE trip_id IS NULL;`
**Verify:** run against prod DB; `SELECT id,name,jsonb_array_length(base_places),jsonb_array_length(hotels) FROM trips;` → japan-2026, 282, 5. `SELECT count(*) FROM app_state WHERE trip_id='japan-2026';` → 1.

### Task 3: Scope state storage by trip_id
**Files:** Modify `server.js` `readActions`/`writeActions` + `/api/state`.
**Behavior:** `readActions(tripId)` / `writeActions(tripId, data)` operate on `app_state WHERE trip_id=$1` (composite key trip_id). `/api/state` reads `?trip=<id>` (GET) and `req.body.tripId` (POST), default `'japan-2026'`. Keep merge-safety.
**Verify:** `curl '/api/state?trip=japan-2026'` returns existing actions/manual; posting with another trip id writes a separate row.

---

## Phase 2 — Server: trips API + geocoding + scoping

### Task 4: Trips CRUD endpoints
**Files:** Modify `server.js`.
- `GET /api/trips` → list `{id,name,start_date,end_date}`.
- `GET /api/trips/:id` → full row (meta, hotels, base_places, segments).
- `POST /api/trips` `{name,startDate,endDate,hotels,segments}` → insert (id = slug of name + short rand suffix passed from client, since `Math.random` is fine in browser).
- `PUT /api/trips/:id` → update meta/hotels/segments (for onboarding edits).
**Verify:** create a throwaway trip via curl, GET it back, delete it.

### Task 5: Geocoding proxy + scope capture/plan-day by trip
**Files:** Modify `server.js`.
- `GET /api/geocode?q=...` → server-side fetch to `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=...` with a `User-Agent`, return `{lat,lng,display_name}` or `{}`. Cache in-memory by query. Rate-limit (Nominatim asks ≤1/s).
- `/api/capture`, `/api/pending*`, `/api/plan-day`: accept `tripId`, store/read `captures.trip_id`, and in `toPlace` use **geocoding** (Task 9) instead of the Japan-only `CITY_COORDS`.
**Verify:** `curl '/api/geocode?q=Press Hotel Portland Maine'` returns plausible Maine coords (~43.65,-70.26).

---

## Phase 3 — Client: load active trip instead of hardcoded data

### Task 6: Extract inline DATA → DB seed; make `DATA` dynamic
**Files:** Modify `index.html`; create `scripts/japan-places.json`.
**Step 1:** Extract the line-10 `const DATA = [...]` literal into `scripts/japan-places.json` (used by Task 2 migration).
**Step 2:** Replace `const DATA = [...]` with `let DATA = [];` and `let DAYS = [];`.
**Step 3:** Add `loadActiveTrip()`: read active trip id from `localStorage('active-trip')` (default `'japan-2026'`), `fetch('/api/trips/'+id)`, then populate `DATA = trip.base_places.slice()`, build `DAYS` from `trip.segments` (`{n,d,c,t}`), and `TRIP` (hotels/dayHotel/logistics) from `trip.hotels`+`segments`. Call it first in `init()` (before loadActions, which then loads that trip's state).
**Verify:** Japan trip renders identically (place count 282, 14 days, hotels) — diff against current behavior. `node --check`.

### Task 7: Trip switcher + active-trip plumbing
**Files:** Modify `index.html` (header).
- Header dropdown listing trips (from `/api/trips`) + "➕ New trip". Selecting sets `localStorage('active-trip')` and reloads data (re-run loadActiveTrip + loadActions + renderAll).
- All state reads/writes (`/api/state`, capture, plan-day) pass the active trip id.
**Verify:** switch between Japan and a test trip; state stays separate.

---

## Phase 4 — New Trip onboarding

### Task 8: "New Trip" flow
**Files:** Modify `index.html`.
**Behavior:** A modal/form: trip name, start & end date, and one-or-more hotels (name + address → "Find" button calls `/api/geocode`, shows resolved location, with manual lat/lng fallback). Optional per-segment city. On save: build `segments` (one entry per date in range, each {date, city, hotelId, theme:''}), POST `/api/trips`, switch to it. Days auto-generate from the date range.
**Verify:** create "Portland Maine — Jul 2026" (Jul 2–5, The/your hotel), confirm 4 days generate and the hotel geocodes.

---

## Phase 5 — Generalized geocoding for places

### Task 9: Enrich captured places with real coords
**Files:** Modify `server.js` `toPlace`/capture + `index.html` manual-add.
**Behavior:** When a captured/manual place is created, geocode `"<name>, <city>"` via the Nominatim proxy; on success use those coords, else fall back to the trip's hotel/city centroid. Keep `days:''`, `source:'Instagram'`, etc.
**Verify:** capture a Portland place (e.g. "Eventide Oyster Co, Portland Maine") → coords land in Portland (~43.66,-70.25), shows on map + distance from hotel.

---

## Phase 6 — End-to-end verification & cutover

### Task 10: Verify both trips, then merge to main
**Steps:**
- Japan trip: 282 places, 14 days, existing actions/manual/dayPlans all intact (compare to backup).
- Portland trip: created, hotel geocoded, capture a couple IG places, set a focus, run "Plan day with AI", get directions.
- `node --check` both files; local boot smoke test of all endpoints.
- Merge `multi-trip` → `main` (triggers deploy). Re-verify live. Keep `backups/state-pre-multitrip.sql` until confident.

---

## Out of scope (YAGNI)
Multi-user/auth, public sharing, billing, deleting trips UI (can do via DB), non-trip destinations, importing the old guide content for new trips. Productization stays parked.

# Instagram Capture — Design

_2026-06-18_

## Goal

Capture Instagram reels/posts into the trip dashboard as enriched "place"
entries, matching the existing item schema. First slice: **paste a URL on the
site** (works from the IG app via Share → Copy link). A bookmarklet is a later
slice.

## Flow

paste URL (+ optional caption, optional category) → server enriches via Claude
→ places land in a **Pending** review queue → user approves keepers → they join
the dashboard's `manual` list and render like every other place.

## Item schema (must match exactly)

Approved captures become the dashboard's 14-field shape:

```
name, city, neighborhood, category, why, family_fit, booking,
priority, heat, days, source, lat, lng, url
```

- `days` is a **string** (e.g. `""`, `"1-5"`, `"7,8,9"`). Never an array.
- `source` = `"Instagram"`; the reel permalink goes in `url`.
- `lat`/`lng` assigned from a city-centroid lookup + jitter (same `cityCoords`
  the manual-add uses: Tokyo/Kyoto/Osaka/Kanazawa/Hakone, default Tokyo).
- `category` ∈ {Food, Experience, Attraction, Shopping, Temple/Shrine}.
- defaults: `priority: 3`, `booking`/`family_fit` filled if obvious else `""`.

## Server

New Postgres table:

```sql
captures(
  id serial primary key,
  source_url text,
  caption text,
  category text,                 -- user override, or null = auto-detect
  place jsonb,                    -- complete enriched place, or null if needs_caption
  status text default 'pending',  -- pending | approved | rejected
  needs_caption boolean default false,
  created_at timestamptz default now()
)
```

Endpoints:

- `POST /api/capture {url, caption?, category?}` — if `caption` blank, best-effort
  fetch `og:description` from the URL. Enrich via Claude (`claude-haiku-4-5`,
  forced-tool JSON). Insert one pending row per extracted place (complete with
  lat/lng). If no caption obtainable → one `needs_caption` row. If no API key →
  `{ok:false, code:'no_api_key'}` clear message (nothing stored).
- `GET /api/pending` — rows where `status='pending'`.
- `POST /api/pending/approve {ids}` — mark approved, return the place objects.
- `POST /api/pending/reject {ids}` — mark rejected.
- `POST /api/pending/enrich {id, caption}` — enrich a `needs_caption` row: delete
  placeholder, insert place rows.

Guards (public URL, spends API money): caption length cap; simple in-memory
per-IP rate limit. If abused later, add a password gate.

## Dashboard (index.html)

- **Capture box**: URL (required) · Caption (optional) · Category (optional,
  default Auto-detect) · Capture button. Shows result ("3 places found / no
  places / needs caption / add API key").
- **📥 Pending (N) panel**: places grouped by source reel; per place a keep
  checkbox + inline-editable name/city/why/days + reject; **Approve selected**
  adds keepers to the `manual` list (existing path: dedup by name → saveActions).

## Out of scope (later)

Bookmarklet capturer; server-side caption fetch via Meta oEmbed token; per-user
separation.

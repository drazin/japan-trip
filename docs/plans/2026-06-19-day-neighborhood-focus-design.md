# Day View — Neighborhood Focus & AI Planning

_2026-06-19_

## Goal

On the **By Day** view, stop showing every place that "could fit." Let the user
set a **neighborhood focus** per day (optionally split into Morning/Afternoon/
Evening), and show a curated subset of places that are **accessible** to that
focus, guided by **distance** (we have lat/lng for all 282 places) with optional
**AI** curation/ordering.

## Decisions

- **Relevance engine:** hybrid — instant client-side distance ranking + an
  on-demand "✨ Plan day with AI" button.
- **Day structure:** up to 3 time slots (Morning / Afternoon / Evening); default
  one "All day" focus.
- **Candidate pool:** all non-skipped places in that day's city, ranked by
  distance to the slot's focus + priority.

## Anchors & distance

- Build **anchor areas per city** by computing the centroid (avg lat/lng) of the
  places sharing each `neighborhood` label; merge obvious duplicates
  (e.g. Kyoto "Central"/"Central Kyoto"). Dropdown shows these clean anchors.
- `haversine(aLat,aLng,bLat,bLng)` → km. `rankByDistance(places, anchor)` sorts
  by a blend of distance + priority.
- Badges: ≤1.2 km 🚶 walkable · ≤4 km 🚇 short ride · beyond → "farther afield".

## Persisted state

New `dayPlans` key in the shared (Postgres-backed) state, threaded through
`/api/state` save/load with the same merge-safety as `actions`/`manual`:

```
dayPlans[dayNumber] = {
  slots: [ { time: 'All day'|'Morning'|'Afternoon'|'Evening', hood: <anchor name> } ],
  ai:    { slots: [ { time, picks: [ {name, note} ], flow } ] } | null
}
```

## UI (per day column)

- Focus row: neighborhood dropdown + "+ split" toggle (→ Morning/Afternoon/
  Evening rows, each its own dropdown).
- With a focus set, the "could fit" list is replaced by per-slot recommendation
  groups (nearest first, distance badges). "Assigned" section stays on top.
- No focus set → current behavior (unchanged), so nothing breaks.
- **✨ Plan day with AI**: `POST /api/plan-day` with city/theme/date, slots, and
  candidate places *with precomputed distances*. Claude returns an ordered
  itinerary per slot + one-line flow note, picking **only** from the candidates
  sent. Renders inline, saves to `dayPlans[day].ai`, dismissable. No key →
  graceful message; distance ranking still works.

## Build order

1. State plumbing for `dayPlans` (save/load merge-safe).
2. Anchors + `haversine`/`rankByDistance` helpers.
3. Day-view UI (focus dropdown, split, per-slot groups).
4. AI `POST /api/plan-day` + inline render/save.

## Testing

- Haversine sanity (Shibuya→Asakusa ≈ 6–7 km); "Shibuya" focus ranks
  Shibuya/Harajuku above Asakusa.
- `dayPlans` round-trips through Postgres and survives reload; merge doesn't wipe.
- AI endpoint returns only candidate places; clean no-key path; one live call.
- Regression: no-focus days render as today; syntax check; live deploy verify.

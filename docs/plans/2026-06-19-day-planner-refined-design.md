# Day Planner — Refined, Context-Aware Design

_2026-06-19_

Supersedes the relevant parts of `2026-06-19-day-neighborhood-focus-design.md`.
Scope: build for Matt's own trip. Productization is parked (see memory
`product-direction`).

## Concept

Make the By Day view smart and context-aware using everything in `trip.json`
(hotels, day→hotel, planned activities, logistics, travelers) plus the place
DATA. Master→detail navigation; hotel-anchored distances; two-mode directions;
context-aware AI planning; gap prompts.

## 1. Context layer

Client fetches `/trip.json` on load and builds a `TRIP` object:
- `hotels` (now geocoded: lat/lng added to the 5 booked hotels).
- `dayHotel[dayN]` → hotel (from trip.json `days[].hotel`; day 14 → New Otani).
- `plannedActivities[dayN]` → trip.json `days[].activities`.
- `logistics[dayN]` → travel/arrival/transfer/checkout flags (derived from
  activities of type `travel` + day 1 arrival / day 14 departure).
- `openDecisions` (for gap prompts, several are day-tagged e.g. Warner Bros Day 5).
- `travelers` (2 adults + kids 9 & 13) → passed to AI.

## 2. Hotel-anchored distances

- Neighborhood focus still selects *which area* to explore per slot (ranking).
- The distance **badge** shown on each rec = haversine from that night's hotel
  (`dayHotel`), with mode hint: ≤1.2km 🚶 walkable · ≤4km 🚇 short ride · else 🚉.
- e.g. "Meiji Shrine · 🚇 2.1 km from Keio Plaza".

## 3. Overview → single-day navigation

- **Overview**: compact row/grid of 14 day cards — day#/date/city/theme, hotel
  chip, status dots (#assigned, ✨ AI plan exists, 🎯 focus set, ⚠️ needs
  attention, ✈️ travel day). Scannable, details collapsed.
- **Single-day view** (click a card): full builder — header (hotel, check-in/out,
  logistics banner), focus slots + split, hotel-anchored recs + Get Directions,
  ✨ Plan day with AI + plan, assigned list, that day's gap prompts. Back + prev/next.

## 4. Two-mode directions

- **Scanning**: distance/mode hint always visible (no clutter).
- **Traversing**: "Get Directions" → one tap → Google Maps directions deep link.
  Origin = **current location** via `navigator.geolocation` (default when out),
  **hotel** as fallback, with a toggle. Destination = place (coords or name).
- AI transit narrative lives in the AI day plan, NOT on the directions tap.

## 5. Context-aware AI plan

`POST /api/plan-day` payload gains: travelers, the night's hotel + coords,
logistics flags, and what's already planned/assigned (build around it, no dupes).
Output: ordered, kid-paced itinerary with rough timing, meals, and transit hops;
lighter on travel/arrival days.

## 6. Gaps & prompts

Per-day + overview "needs attention": open days (no focus/plan), unbooked
must-dos (from `openDecisions`, day-tagged where possible), missing dinner near
hotel. Each prompt has a one-tap action (set focus / plan / find).

## Build order

1. Context layer (trip.json load, hotel coords, dayHotel/logistics maps).
2. Hotel-anchored distance badges.
3. Overview ↔ single-day navigation.
4. Two-mode directions (geolocation + Maps deep link).
5. Context-aware AI plan payload.
6. Gap detection + prompts.

## Testing

- Hotel distances sane (Keio Plaza→Shibuya ≈ 3-4km; →Asakusa larger).
- dayHotel maps correctly incl. day 14.
- Overview shows correct status dots; drill-in renders one day.
- Directions deep link opens Maps with right origin/dest; geolocation fallback.
- AI plan respects logistics (lighter on days 1,6,7,11,13) and avoids planned dupes.
- Regression: persistence, capture, no-focus fallback all intact.

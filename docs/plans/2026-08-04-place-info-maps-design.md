# Place info & maps — design (2026-08-04)

## Goal
Every saved place should show its full info when opened — including a street
address — and offer "View on map" (in-app) and "Open in Google Maps" links.
Search stays scoped to saved places: the existing search box already matches
all place fields, so once `address` is on the data, searching finds it and the
detail sheet shows everything.

## Data: `address` back-fill
One-time script (scripts/backfill-addresses.py pattern, run against the live
API) adds `address` to each of the 554 places in `japan-2026.base_places`:

1. Forward-geocode `"<name>, <city>, Japan"` on Nominatim. Accept the hit only
   if it lands within 3 km of the stored coords (guards against same-name
   places elsewhere).
2. Otherwise reverse-geocode the stored coords and mark `addressApprox: true`
   (some older entries have jittered/rough coords, so the address is
   block-level, not door-level).
3. `", Japan"` suffix trimmed for display brevity. 1.1 s between requests per
   Nominatim usage policy.

New manual adds store `address` from the geocode call the add-flow already
makes (`display_name` was previously discarded).

## UI (index.html, mirrored to dashboard.html)
- **Action sheet**: context block under the title — category · neighborhood ·
  city, the "why" line, 📍 address ("approx" tag when `addressApprox`), and
  two links: 🗺 View on map, ↗ Google Maps.
- **`gmapsUrl(d)`**: `google.com/maps/search/?api=1&query=` +
  `name, address` (falls back to `name, city`) — lands on the real Google
  listing with hours/reviews rather than a bare coordinate pin.
- **`viewOnMap(name)`**: closes the sheet, switches to the Map tab, centers on
  the place and opens its marker popup; if current filters hide the marker, a
  standalone popup opens at the coords instead.
- **Map popups**: gain an "Open in Google Maps ↗" link.

## Out of scope
Looking up places not in the saved list (user chose saved-places-only), and
showing addresses in table rows / day cards (sheet only, to avoid clutter).

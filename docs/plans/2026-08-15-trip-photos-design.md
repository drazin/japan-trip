# Trip photos — design (2026-08-15)

Upload photos as the trip happens; they appear in the read-only itinerary the
family already has a link to.

## Decisions
- **Attach to both** a day (general shots) and a place (that restaurant, that view).
- **Family view-only.** The share link renders photos but no upload/delete UI.
- **Shrink in the browser, store in Postgres.** No new service or account.

## Storage
New `photos` table: `id, trip_id, day, place, mime, data BYTEA, thumb BYTEA,
caption, created_at`. Two renditions are stored per photo:

| rendition | size | used for |
|---|---|---|
| `data` | max 1600px long edge, JPEG q0.82 | lightbox / full view |
| `thumb` | max 420px, JPEG q0.7 | every grid on every screen |

A 3000×2000 phone photo lands around 250–400KB stored, ~15KB thumb, so a
trip's worth of photos stays well inside the existing database. Re-encoding
through a canvas also **strips EXIF, including GPS**, before anything leaves
the phone. Originals stay in the camera roll — this is a viewing copy.

## API
- `POST /api/photos` — `{tripId, day, place, dataUrl, thumbUrl, caption}`; 8MB cap.
- `GET /api/photos?trip=` — metadata only (no bytes), so the client can group cheaply.
- `GET /api/photos/:id[?size=thumb]` — bytes, `Cache-Control: immutable` (ids never change).
- `PATCH /api/photos/:id` — caption. `DELETE /api/photos/:id`.
- No DB in dev → in-memory array, so the endpoints still work locally.

## UI
- **Day detail** gets a 📷 PHOTOS bucket: "Add photos" + thumbnail grid.
- **Place sheet** gets a photos row; the photo inherits the place's assigned day.
- **Day cards** show a 📷 n chip so you can see which days have shots.
- **Itinerary** shows a day strip plus per-place thumbnails, in share mode too.
- **Lightbox**: full image, prev/next within the same day/place, caption editing
  and delete for you, caption display only for the family.

## Known limits
- The share link is unguessable but unauthenticated: anyone with it sees the
  photos. Same exposure the itinerary already had.
- Upload is sequential with a simple "n of m" status; no retry queue. On bad
  hotel wifi a failed photo is reported and simply re-picked.
- HEIC decoding relies on the browser (fine on iOS Safari, may fail on desktop
  Chrome); failures are counted and reported rather than silently dropped.

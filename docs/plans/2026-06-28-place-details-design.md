# Place details (hours / cost / reservation lead + hotel check-in)

Capture per-place facts so the itinerary + AI planner are smarter. Fields stored
in itemActions (per-place, synced): hours, cost, lead, infoEstimated. Hotel
check-in/out on the hotel record.

- AI lookup: POST /api/place-info {name, city} -> Claude best-guess
  {hours, cost, lead}, marked infoEstimated (⚠ verify) until edited/confirmed.
- Manual edit: action sheet fields; typing clears infoEstimated.
- Surfaced in Itinerary (priority), built cards, action sheet.
- AI day planner candidates include hours/cost (avoid closed places, note cost);
  hotel check-in informs arrival-day pacing.

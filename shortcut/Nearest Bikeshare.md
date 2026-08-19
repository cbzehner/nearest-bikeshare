# Rebuild the Shortcut

End users should add the live Shortcut from [https://nearest-bikeshare.hooks.workers.dev/](https://nearest-bikeshare.hooks.workers.dev/). Use this page only to rebuild it.

Deploy the Worker first. In the URL below, replace `WORKER_URL` with the deployed origin and no trailing slash.

The live copy uses `https://nearest-bikeshare.hooks.workers.dev`.

## What the Shortcut must do

1. Get the current location once.
2. `POST WORKER_URL/nearest` as JSON: `{ "version": 1, "lat", "lon", "type": "any", "units": "imperial", "maps": "apple" }`.
3. Speak `spokenMessage`.
4. Open `mapPreviewUrl` only when that field has a value.

Do not call **Get Current Location** twice. Do not open `providerRentalUrl`.

A 200 body with an empty `mapPreviewUrl` is a normal no-map result (no bikes, outside the Bay Area, rate limit, or a Bay Wheels outage). Speak the message. Do not open Maps.

## Icon

Use the built-in bicycle symbol and dark blue. [nearest-bikeshare.svg](nearest-bikeshare.svg) is reference art for the public page. The Shortcut does not embed that image.

## Actions

1. **Get Current Location** once.
2. **Get Details of Locations** → `Latitude`, input = that location.
3. **Get Details of Locations** → `Longitude`, same location.
4. **Get Contents of URL**.
   - URL: `WORKER_URL/nearest` (no query string).
   - Method: `POST`.
   - Request body: **JSON**.
   - Fields: `version` = `1` (Number), `lat` = Latitude, `lon` = Longitude, `type` = `any`, `units` = `imperial`, `maps` = `apple`.

   Both location tokens must point at the **Get Current Location** action. If a token says “Variable not available,” the Worker gets empty coordinates.

   Change `units` to `metric` for meters and kilometers. Change `maps` to `google` for Google Maps. Keep those values in the request. Do not ask for them on each run.

5. **Get Dictionary Value** `spokenMessage`.
6. **Speak Text** that value.
7. **Get Dictionary Value** `mapPreviewUrl`.
8. **If** that value **has any value** → **Open URLs**.

If **Get Contents of URL** reports a network error, run the Shortcut again.

## Publish a new share link

1. Confirm the Shortcut works on an iPhone.
2. Share → **Copy iCloud Link**.
3. Put that URL in `SHORTCUT_SHARE_URL` in `wrangler.jsonc`.
4. Deploy the Worker.

The public page then points **Add Shortcut** at the new link.

# Nearest Bikeshare

Nearest Bikeshare is a small personal tool. It finds an available Bay Wheels bike through Siri.

At run time, a Cloudflare Worker reads the official Bay Wheels General Bikeshare Feed Specification (GBFS) 2.3 discovery feed. The Worker validates each linked feed before it uses that feed. It caches each valid response for the feed's `ttl` value.

The project does not use a database, user account, Lyft login, web scraping, analytics, or a large language model (LLM).

The Worker uses OpenRouteService to compare walking distances for up to ten nearby candidates when `OPENROUTESERVICE_API_KEY` is set. If the key is missing or the route service fails, it uses a straight-line distance instead. The response marks that result as approximate. The Shortcut can open an Apple Maps or Google Maps preview. The response also includes walking links and the official provider rental URL when Bay Wheels supplies one.

## Local setup

You need Node.js 20 or newer. You also need a Cloudflare account to deploy the Worker.

Install the project and run the checks:

```sh
npm install
npm run format
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

For local walking routes, copy `.env.example` to `.env` and add your OpenRouteService key. The `.env` file is ignored by Git.

Start the local Worker in one terminal:

```sh
npm run dev -- --port 8787
```

Test the Worker from a second terminal:

```sh
curl 'http://localhost:8787/nearest?lat=37.7600&lon=-122.4200&type=any'
curl 'http://localhost:8787/nearest?lat=37.7600&lon=-122.4200&type=any&units=metric'
curl -i 'http://localhost:8787/nearest?lat=91&lon=-122.42&type=any'
```

The first two requests should return HTTP 200 with JSON. The request with invalid coordinates should return HTTP 400. Press `Ctrl-C` to stop the local Worker.

### Query values

Set `type` to `electric`, `classic`, or `any`. The default is `any`. The Shortcut always sends `type=any`.

Set `units` to `imperial` or `metric`. The default is `imperial`. Imperial speech uses feet through 1,000 feet and miles above 1,000 feet. Metric speech uses meters through 1,000 meters and kilometers above 1,000 meters. The API always returns `distanceMeters` in meters.

Set `maps` to `apple` or `google`. The default is `apple`. This setting controls the map preview and walking link in `mapPreviewUrl` and `mapWalkingUrl`.

The requested bike type is a preference. If that type is not available, the Worker can return the other type. It then sets `confidence` to `low`. It never calls a classic bike an e-bike.

For `type=any`, distance has the most weight. The number of available bikes breaks close ties. For example, one bike 30 meters away ranks above a station with several bikes 800 meters away.

When walking routes are available, the Worker ranks the ten closest candidates by walking distance. When they are not available, it ranks all candidates by straight-line distance.

OpenRouteService ranks the candidates. Apple Maps or Google Maps may choose a different walking path when it opens.

## Deploy

Sign in to Cloudflare and deploy the Worker:

```sh
npx wrangler login
npx wrangler secret put OPENROUTESERVICE_API_KEY
npx wrangler deploy
```

Paste the OpenRouteService key when Wrangler asks for it. Keep the key in a secret. Do not put it in `wrangler.jsonc` or commit it to Git.

Wrangler prints the deployed URL. Test that URL:

```sh
curl 'https://YOUR-WORKER.workers.dev/nearest?lat=37.7600&lon=-122.4200&type=any'
```

Replace `YOUR-WORKER.workers.dev` with the URL from Wrangler. The request should return HTTP 200 with JSON. The JSON includes `selected`, `spokenMessage`, `units`, `topCandidates`, `feedFreshness`, and `confidence`. It also includes the selected map provider, walking distance data, Apple Maps and Google Maps URLs, and `providerRentalUrl` when the provider supplies one.

Use `https://YOUR-WORKER.workers.dev/nearest` as the deployed URL in the Shortcut.

## Shortcut

Follow the action guide in [shortcut/Nearest Bikeshare.md](shortcut/Nearest%20Bikeshare.md). Build the Shortcut once. Then say, “Siri, nearest bikeshare.”

The Shortcut gets your current location once. It requests any available bike and speaks the result. It uses “ee bike” so Siri does not pronounce e-bike as “eh-bike.”

The Shortcut uses imperial units by default. Change `units=imperial` to `units=metric` in its URL to use meters and kilometers.

When the Worker finds a result, the Shortcut opens the selected map app at the bike or station. When no bike is available, it speaks the no-results message and does not open Maps. Change `maps=apple` to `maps=google` in the Shortcut URL to use Google Maps.

The Shortcut does not open `providerRentalUrl`. The live feed usually supplies a general scan link, not a link to one bike.

## Provider deep links

The official Bay Wheels `free_bike_status` feed includes `rental_uris.ios`. In our sample of live bikes, the feed returned the same URL for every bike:

```text
https://sfo.lft.to/lastmile_qr_scan
```

This URL opens the general Bay Wheels or Lyft scan flow. It does not identify the selected `bike_id`. Bay Wheels tells riders to use the Lyft app to scan the QR code on the bike. The GBFS specification says a vehicle rental URI should identify one vehicle when the provider supplies such a link.

The Worker returns the iOS rental URI from the feed without changes. It does not add `bike_id` or make an undocumented Lyft URL. If Bay Wheels later supplies a bike-specific `rental_uris.ios`, the Worker will return it without a code change.

Until then, use the map preview to find the selected bike or station. Treat `providerRentalUrl` as a general scan and unlock link.

## API responses

A successful result includes:

- `selected`
- the selected `name`, `latitude`, `longitude`, `bikeType`, `availableCount`, and `distanceMeters` at the top level
- `distanceSource` and `walkingTimeSeconds`
- `spokenMessage`, `units`, and `mapProvider`
- `mapPreviewUrl` and `mapWalkingUrl`
- `providerRentalUrl`
- Apple Maps and Google Maps preview and walking URLs
- `feedFreshness`, `confidence`, and `approximate`
- up to five ordered entries in `topCandidates`

A response with no result has `selected: null` and returns HTTP 200. Invalid input returns HTTP 400. A required feed failure returns HTTP 503. A failure in the optional free-floating bike feed does not remove station results. `distanceSource` is `walking` when OpenRouteService returns a route and `straight_line` when the Worker uses its fallback. `routingProvider` names the route service when walking data is available.

## Feed handling

This version supports Bay Wheels GBFS 2.3. It maps the GBFS type `human` to `classic`. It maps `electric_assist` and `electric` to `electric`.

The Worker uses `vehicle_types_available` for station counts when that field is present. It leaves a free bike out of the free-floating list when the bike has a `station_id`. This prevents the Worker from counting a docked bike twice.

## Validation

Run all local checks:

```sh
npm run format
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

The tests use saved GBFS and routing data. They cover bike-type preference, station counts by bike type, free-floating bikes, walking-distance ranking, straight-line fallback, stale data, no availability, reserved and disabled bikes, duplicate prevention, malformed required feeds, optional feed failure, provider failure, and invalid requests.

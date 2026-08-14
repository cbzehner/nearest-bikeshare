# Nearest Bikeshare

Small personal prototype for finding an available Bay Wheels bike from Siri.

The Cloudflare Worker reads the official Bay Wheels GBFS 2.3 discovery feed at runtime. It follows only validated linked feeds, caches validated responses using each feed's `ttl`, and uses no database, account, Lyft login, scraping, analytics, or LLM.

The distance is a straight-line Haversine distance. The response always marks it as approximate because this prototype does not call a walking-routing service. The Shortcut opens an Apple Maps preview for the exact selected coordinates. The response also includes Google Maps preview and walking links.

## Local setup

Requirements: Node.js 20 or newer and a Cloudflare account for deployment.

```sh
npm install
npm run format
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

Start the local Worker in one terminal:

```sh
npm run dev -- --port 8787
```

Test it from a second terminal:

```sh
curl 'http://localhost:8787/nearest?lat=37.7600&lon=-122.4200&type=any'
curl -i 'http://localhost:8787/nearest?lat=91&lon=-122.42&type=any'
```

The first two requests should return HTTP 200 JSON. The invalid-coordinate request should return HTTP 400. Stop the local Worker with `Ctrl-C`.

The `type` query value is `electric`, `classic`, or `any`. If it is omitted, the Worker uses `any`. The Shortcut always sends `type=any`.

The requested type is a preference. If no bike of that type is available, the Worker may return the other bike type and lowers `confidence` to `low`. A request never claims that a classic bike is an e-bike.

## Deploy

```sh
npx wrangler login
npx wrangler deploy
```

Wrangler prints the deployed URL. Test it with:

```sh
curl 'https://YOUR-WORKER.workers.dev/nearest?lat=37.7600&lon=-122.4200&type=any'
```

Replace `YOUR-WORKER.workers.dev` with the URL printed by Wrangler. The deployed request should return HTTP 200 JSON with `selected`, `spokenMessage`, `topCandidates`, `feedFreshness`, `confidence`, Apple Maps preview and walking URLs, and Google Maps preview and walking URLs. The Shortcut uses the deployed URL as `https://YOUR-WORKER.workers.dev/nearest`.

## Shortcut

The exact action recipe is in [shortcut/Nearest Bikeshare.md](shortcut/Nearest%20Bikeshare.md). Build it once in the Shortcuts app, then say “Siri, nearest bikeshare”.

The recipe gets the current location, always asks the Worker for any available bike, speaks the Worker-generated result with a feet unit, and always opens an Apple Maps preview at the selected bike or station. To use Google Maps instead, read `googleMapsPreviewUrl` and open that URL.

## Response shape

Successful responses include `selected`, the duplicated selected fields (`name`, `latitude`, `longitude`, `bikeType`, `availableCount`, `distanceMeters`), `spokenMessage`, `providerRentalUrl`, Apple Maps preview and walking URLs, Google Maps preview and walking URLs, `feedFreshness`, `confidence`, `approximate`, and the ordered `topCandidates` array with at most five entries. A no-result response has `selected: null` and HTTP 200. Invalid input returns HTTP 400. Required-feed failures return HTTP 503; a failed optional free-bike feed does not suppress station results.

## Feed choices

This version supports Bay Wheels GBFS 2.3. It maps `human` to `classic` and `electric_assist` or `electric` to `electric`. Station counts use `vehicle_types_available` when present. Free bikes with a `station_id` are omitted from the free-floating list so a docked vehicle is not counted twice.

## Validation

Run the full local validation with:

```sh
npm run format
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

The test suite uses saved GBFS fixtures. It covers type preference, type-specific station availability, free-floating bikes, stale data, no availability, reserved and disabled bikes, duplicate prevention, malformed required feeds, optional-feed failure, provider failure, and invalid requests.

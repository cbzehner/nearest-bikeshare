# Nearest Bikeshare

A Siri Shortcut and Cloudflare Worker that find a nearby Bay Wheels bike.

**Try it:** [https://nearest-bikeshare.hooks.workers.dev/](https://nearest-bikeshare.hooks.workers.dev/)

On iPhone, tap **Add Shortcut**, then say “Siri, nearest bikeshare.”

|          |                                                                                           |
| -------- | ----------------------------------------------------------------------------------------- |
| Area     | San Francisco Bay Area (Bay Wheels only)                                                  |
| Account  | None                                                                                      |
| Location | Used to rank bikes. Not kept in a database. Walking estimates may go to OpenRouteService. |
| Maps     | Apple Maps by default. Google Maps is optional.                                           |

## How it works

```text
iPhone Shortcut  →  POST /nearest { version, lat, lon }  →  Worker
     ↑                                               |
     speak + open Maps                         GBFS + optional walking routes
```

1. The Shortcut reads the current location once and POSTs it as JSON. The coordinates are not put in the URL.
2. The Worker loads official Bay Wheels GBFS 2.3 feeds (stations and free bikes).
3. It drops stale, reserved, disabled, and empty candidates.
4. If an OpenRouteService key is set, it ranks up to ten unique nearby places by walking distance. Otherwise it ranks by straight-line distance.
5. It returns JSON. The Shortcut speaks `spokenMessage` and opens `mapPreviewUrl` when that field has a value.

There is no database, user account, Lyft login, scraper, analytics, or LLM.

## Review the code

| Path                                                               | Role                                     |
| ------------------------------------------------------------------ | ---------------------------------------- |
| [`src/index.ts`](src/index.ts)                                     | `GET /` landing page and `POST /nearest` |
| [`src/gbfs.ts`](src/gbfs.ts)                                       | Feed discovery, validation, cache        |
| [`src/ranking.ts`](src/ranking.ts)                                 | Filter and rank candidates               |
| [`src/routing.ts`](src/routing.ts)                                 | Optional OpenRouteService walking matrix |
| [`tests/nearest.test.ts`](tests/nearest.test.ts)                   | Fixture-based Worker tests               |
| [`shortcut/Nearest Bikeshare.md`](shortcut/Nearest%20Bikeshare.md) | How to rebuild the Shortcut              |

Need Node.js 20 or newer.

```sh
npm install
npm test
npm run typecheck
npm run format
```

`npm test` uses saved GBFS and routing fixtures. It does not call live Bay Wheels or OpenRouteService.

To run the Worker locally:

```sh
npm run dev -- --port 8787
```

```sh
curl -sS -X POST 'http://localhost:8787/nearest' \
  -H 'content-type: application/json' \
  -d '{"version":1,"lat":37.7600,"lon":-122.4200,"type":"any"}'
```

A Mission District coordinate should return HTTP 200 JSON. A New York coordinate should return a Bay Area-only spoken message. Invalid `lat` should return HTTP 400.

Walking routes need a local key. Copy [`.env.example`](.env.example) to `.env` and set `OPENROUTESERVICE_API_KEY`. Git ignores `.env`.

## API

`POST /nearest` with `Content-Type: application/json`:

```json
{
  "version": 1,
  "lat": 37.76,
  "lon": -122.42,
  "type": "any",
  "units": "imperial",
  "maps": "apple"
}
```

| Field        | Values                       | Default    |
| ------------ | ---------------------------- | ---------- |
| `version`    | `1`                          | —          |
| `lat`, `lon` | Required numbers             | —          |
| `type`       | `any`, `electric`, `classic` | `any`      |
| `units`      | `imperial`, `metric`         | `imperial` |
| `maps`       | `apple`, `google`            | `apple`    |

The live Shortcut sends `version=1`, `type=any`, `units=imperial`, and `maps=apple`. A GET to `/nearest`, or a POST without `version: 1`, does not look up a bike. It tells the user to add the current Shortcut.

A successful body includes `selected`, `spokenMessage`, `mapPreviewUrl`, `distanceSource`, `topCandidates` (up to five), and feed freshness. `distanceMeters` is always meters. Speech uses feet or miles (imperial) and meters or kilometers (metric), with a switch at 1,000 of the smaller unit.

| Case                                                  | HTTP | What the Shortcut does                                                  |
| ----------------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| Bike found                                            | 200  | Speaks the result. Opens Maps.                                          |
| No bike, out of area, rate limit, or Bay Wheels down  | 200  | Speaks `spokenMessage`. `mapPreviewUrl` is empty, so Maps stays closed. |
| Outdated Shortcut (GET, or POST without `version: 1`) | 200  | Speaks the update message. Maps stays closed.                           |
| Bad body                                              | 400  | Shortcut sees a request error.                                          |

`POST /nearest` allows 10 requests per 60 seconds per client IP. Walking-route calls also have a global cap of 40 per 60 seconds. `/` is not rate-limited.

`type` is a preference. If that type is missing, the Worker may return the other type and set `confidence` to `low`. It never calls a classic bike an e-bike. For `type=any`, distance wins; availability breaks close ties.

## Shortcut contract

The frontend is an iOS Shortcut, not a native app. Rebuild steps are in [`shortcut/Nearest Bikeshare.md`](shortcut/Nearest%20Bikeshare.md).

It reads only two fields:

- `spokenMessage` — Siri says this. Electric bikes are spoken as “ee bike.”
- `mapPreviewUrl` — opened only when it has a value.

Do not open `providerRentalUrl`. The live Bay Wheels feed usually returns the same scan link for every bike (`https://sfo.lft.to/lastmile_qr_scan`). That link does not identify one `bike_id`. Use the map pin to find the bike.

After you rebuild the Shortcut, use Share → Copy iCloud Link, put that URL in `SHORTCUT_SHARE_URL` in `wrangler.jsonc`, and deploy.

## Deploy

```sh
npx wrangler login
npx wrangler secret put OPENROUTESERVICE_API_KEY
npx wrangler deploy
```

Keep the OpenRouteService key in a Worker secret. Do not put it in `wrangler.jsonc` or commit it.

## License

[MIT](LICENSE)

import { DEFAULT_STALE_AFTER_SECONDS, FeedError, loadSnapshot } from "./gbfs";
import {
  aggregateFreshness,
  buildCandidates,
  confidenceFor,
  rankCandidates,
  toCandidateResponse,
} from "./ranking";
import { addWalkingDistances } from "./routing";
import type {
  AppDependencies,
  ErrorResponse,
  Env,
  MapProvider,
  NearestResponse,
  Query,
  RequestedBikeType,
  DistanceUnits,
} from "./types";

const SERVICE_LATITUDE_MIN = 37.2;
const SERVICE_LATITUDE_MAX = 38.05;
const SERVICE_LONGITUDE_MIN = -122.65;
const SERVICE_LONGITUDE_MAX = -121.7;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const RATE_LIMIT_SPOKEN_MESSAGE = "Too many requests. Try again in a minute.";
const PROVIDER_UNAVAILABLE_SPOKEN_MESSAGE =
  "Bay Wheels data is temporarily unavailable. Try again later.";
const OUT_OF_AREA_SPOKEN_MESSAGE =
  "Nearest Bikeshare only covers Bay Wheels in the San Francisco Bay Area.";
const OUT_OF_AREA_NOTE =
  "This tool only covers Bay Wheels in the San Francisco Bay Area.";
const SUPPORTED_REQUEST_VERSION = 1;
const OUTDATED_CLIENT_SPOKEN_MESSAGE =
  "This Shortcut is out of date. Open nearest-bikeshare.hooks.workers.dev and add it again.";
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorResponse(
  error: string,
  message: string,
  status: number,
): Response {
  const body: ErrorResponse = { error, message };
  return jsonResponse(body, status);
}

function readCoordinate(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return undefined;
}

function readRequestVersion(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

async function parseNearestBody(
  request: Request,
): Promise<Query | ErrorResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    return {
      error: "invalid_body",
      message: "Send a JSON object with lat and lon.",
    };
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return {
      error: "invalid_body",
      message: "Send a JSON object with lat and lon.",
    };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return {
      error: "invalid_body",
      message: "Send a JSON object with lat and lon.",
    };
  }
  const record = payload as Record<string, unknown>;
  if (readRequestVersion(record.version) !== SUPPORTED_REQUEST_VERSION) {
    return {
      error: "outdated_client",
      message: "Use the current Shortcut.",
    };
  }
  const latitude = readCoordinate(record.lat);
  const longitude = readCoordinate(record.lon);
  const type = readText(record.type, "any");
  const units = readText(record.units, "imperial");
  const maps = readText(record.maps, "apple");
  if (
    latitude === undefined ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    return {
      error: "invalid_latitude",
      message: "lat must be a number from -90 to 90.",
    };
  }
  if (
    longitude === undefined ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return {
      error: "invalid_longitude",
      message: "lon must be a number from -180 to 180.",
    };
  }
  if (type !== "electric" && type !== "classic" && type !== "any") {
    return {
      error: "invalid_type",
      message: "type must be electric, classic, or any.",
    };
  }
  if (units !== "imperial" && units !== "metric") {
    return {
      error: "invalid_units",
      message: "units must be imperial or metric.",
    };
  }
  if (maps !== "apple" && maps !== "google") {
    return {
      error: "invalid_maps",
      message: "maps must be apple or google.",
    };
  }
  return {
    latitude,
    longitude,
    requestedType: type,
    units: units as DistanceUnits,
    mapProvider: maps as MapProvider,
  };
}

function isErrorResponse(value: Query | ErrorResponse): value is ErrorResponse {
  return "error" in value;
}

function isInServiceArea(latitude: number, longitude: number): boolean {
  return (
    latitude >= SERVICE_LATITUDE_MIN &&
    latitude <= SERVICE_LATITUDE_MAX &&
    longitude >= SERVICE_LONGITUDE_MIN &&
    longitude <= SERVICE_LONGITUDE_MAX
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortcutShareHref(shareUrl: string | undefined): string {
  if (!shareUrl) return "";
  let parsed: URL;
  try {
    parsed = new URL(shareUrl.trim());
  } catch {
    return "";
  }
  const host =
    parsed.hostname === "icloud.com" ? "www.icloud.com" : parsed.hostname;
  if (host !== "www.icloud.com") return "";
  const match = parsed.pathname.match(/^\/shortcuts\/([A-Za-z0-9]+)\/?$/);
  if (!match) return "";
  return `https://www.icloud.com/shortcuts/${match[1]}`;
}

const LANDING_CSS = `:root {
  --bg: #f4f7fb;
  --ink: #10213a;
  --muted: #4a5a70;
  --cta-bg: #0a3578;
  --cta-fg: #ffffff;
  --surface-notice: #f8eaea;
  --ink-notice: #6b1c1c;
  --focus: #0a3578;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #071526;
    --ink: #f4f7fb;
    --muted: #a8b6c8;
    --cta-bg: #4d8cff;
    --cta-fg: #071526;
    --surface-notice: #3a1a1a;
    --ink-notice: #f0c4c4;
    --focus: #4d8cff;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100dvh;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 1rem;
  line-height: 1.5;
  padding-top: calc(2rem + env(safe-area-inset-top, 0px));
  padding-right: calc(1.25rem + env(safe-area-inset-right, 0px));
  padding-bottom: calc(3rem + env(safe-area-inset-bottom, 0px));
  padding-left: calc(1.25rem + env(safe-area-inset-left, 0px));
}
main { max-width: 22.5rem; margin: 0 auto; }
header { text-align: center; }
.mark { width: 72px; height: 72px; margin: 0 auto 1rem; }
.mark svg { display: block; }
h1 {
  margin: 0 0 0.5rem;
  font-size: 2rem;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
}
.lede { margin: 0; font-size: 1.125rem; line-height: 1.4; color: var(--muted); }
.platform { margin: 0.25rem 0 0; font-size: 0.9375rem; color: var(--muted); }
.actions { margin: 1.75rem 0 0; }
.button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 3.25rem;
  padding: 0.75rem 1.25rem;
  border-radius: 0.875rem;
  background: var(--cta-bg);
  color: var(--cta-fg);
  font-size: 1.0625rem;
  font-weight: 600;
  text-decoration: none;
}
.button:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 3px;
}
.notice {
  margin: 1.75rem 0 0;
  padding: 0.875rem 1rem;
  border-radius: 0.75rem;
  background: var(--surface-notice);
  color: var(--ink-notice);
}
section { margin-top: 2.25rem; }
h2 { margin: 0 0 0.75rem; font-size: 1rem; font-weight: 650; }
ol { margin: 0; padding-left: 1.25rem; }
li + li { margin-top: 0.6rem; }
footer { margin-top: 1.75rem; color: var(--muted); font-size: 0.9375rem; }
footer p { margin: 0 0 0.75rem; }
footer p:last-child { margin-bottom: 0; }`;

function landingMarkup(actionHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#0A3578">
  <meta name="description" content="Ask Siri for the nearest available Bay Wheels bike.">
  <meta property="og:title" content="Nearest Bikeshare">
  <meta property="og:description" content="Ask Siri for the nearest available Bay Wheels bike.">
  <title>Nearest Bikeshare</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E%3Crect width='1024' height='1024' rx='228' fill='%230A3578'/%3E%3C/svg%3E">
  <style>${LANDING_CSS}</style>
</head>
<body>
  <main>
    <header>
      <div class="mark" aria-hidden="true">
        <!-- keep in sync with shortcut/nearest-bikeshare.svg -->
        <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 1024 1024">
          <rect width="1024" height="1024" rx="228" fill="#0A3578"/>
          <path fill="#FFFFFF" d="M512 176C374 176 264 286 264 424C264 532 376 676 512 848C648 676 760 532 760 424C760 286 650 176 512 176Z"/>
          <g fill="none" stroke="#00E05A" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="440" cy="418" r="44"/>
            <circle cx="584" cy="418" r="44"/>
            <path d="M440 418H478L458 338H568L584 418M478 418L458 338M478 418L568 338"/>
            <path d="M436 328H480"/>
            <path d="M568 338V314M546 314H598"/>
          </g>
          <circle cx="440" cy="418" r="7" fill="#00E05A"/>
          <circle cx="584" cy="418" r="7" fill="#00E05A"/>
        </svg>
      </div>
      <h1>Nearest Bikeshare</h1>
      <p class="lede">Ask Siri for the nearest available Bay Wheels bike.</p>
      <p class="platform">Works on iPhone.</p>
    </header>
    ${actionHtml}
    <section aria-labelledby="how-heading">
      <h2 id="how-heading">How it works</h2>
      <ol>
        <li>Add the Shortcut to your iPhone.</li>
        <li>Say "Siri, nearest bikeshare."</li>
        <li>Siri speaks the nearest available bike and opens Maps.</li>
      </ol>
    </section>
    <footer>
      <p>This tool covers Bay Wheels in the San Francisco Bay Area. There is no account.</p>
      <p>The Worker uses your current location to find a nearby bike. It does not keep a location database. Walking estimates may be sent to OpenRouteService.</p>
    </footer>
  </main>
</body>
</html>`;
}

function landingPage(shareUrl: string | undefined): Response {
  const configured = Boolean(shareUrl?.trim());
  const href = shortcutShareHref(shareUrl);
  if (configured && !href) {
    console.error("SHORTCUT_SHARE_URL is not a valid iCloud Shortcut link.");
  }
  const actionHtml = href
    ? `<p class="actions"><a class="button" href="${escapeHtml(href)}">Add Shortcut</a></p>`
    : configured
      ? `<p class="notice" role="status">The Shortcut link is not configured correctly.</p>`
      : "";
  return new Response(landingMarkup(actionHtml), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...SECURITY_HEADERS,
    },
  });
}

function outdatedClientResponse(
  nowSeconds: number,
  error: string,
  message: string,
): Response {
  return jsonResponse({
    ...emptyResponse(fallbackQuery(), unusedFreshness(nowSeconds)),
    spokenMessage: OUTDATED_CLIENT_SPOKEN_MESSAGE,
    error,
    message,
  });
}

function unusedFreshness(
  nowSeconds: number,
): ReturnType<typeof aggregateFreshness> {
  return {
    lastUpdated: new Date(nowSeconds * 1000).toISOString(),
    ageSeconds: 0,
    ttlSeconds: 0,
    stale: false,
    feeds: [],
  };
}

function fallbackQuery(): Query {
  return {
    latitude: 0,
    longitude: 0,
    requestedType: "any",
    units: "imperial",
    mapProvider: "apple",
  };
}

function spokenMessage(
  candidate: ReturnType<typeof toCandidateResponse> | null,
  units: DistanceUnits,
): string {
  if (!candidate) {
    return "No available bikes were found nearby. Try again later.";
  }
  const bikeLabel =
    candidate.bikeType === "electric" ? "ee bike" : "classic bike";
  const distance = formatDistance(candidate.distanceMeters, units);
  const bikeWord = candidate.availableCount === 1 ? "bike is" : "bikes are";
  const locationPhrase =
    candidate.entityType === "station" ? ` at ${candidate.name}` : "";
  return `The nearest available ${bikeLabel} is approximately ${distance.value} ${distance.unit} away${locationPhrase}. ${candidate.availableCount} ${bikeWord} available.`;
}

function mapUrls(
  candidate: ReturnType<typeof toCandidateResponse>,
  mapProvider: MapProvider,
): { previewUrl: string; walkingUrl: string } {
  return mapProvider === "apple"
    ? {
        previewUrl: candidate.appleMapsPreviewUrl,
        walkingUrl: candidate.appleMapsWalkingUrl,
      }
    : {
        previewUrl: candidate.googleMapsPreviewUrl,
        walkingUrl: candidate.googleMapsWalkingUrl,
      };
}

function approximationNote(
  candidate: ReturnType<typeof toCandidateResponse> | null,
): string {
  if (!candidate || candidate.distanceSource === "straight_line") {
    return "Walking route was not available. Distance is straight-line.";
  }
  if (candidate.walkingTimeSeconds === null) {
    return "Walking distance is from OpenRouteService. Walking time is not available.";
  }
  return "Walking distance and time are estimated by OpenRouteService.";
}

export function formatDistance(
  distanceMeters: number,
  units: DistanceUnits,
): { value: string; unit: string } {
  const baseValue =
    units === "metric" ? distanceMeters : distanceMeters * 3.28084;
  const threshold = 1000;
  if (baseValue > threshold) {
    const largeUnitValue =
      units === "metric" ? baseValue / 1000 : baseValue / 5280;
    const roundedValue = Number(largeUnitValue.toFixed(1));
    const unit =
      units === "metric"
        ? roundedValue === 1
          ? "kilometer"
          : "kilometers"
        : roundedValue === 1
          ? "mile"
          : "miles";
    return { value: String(roundedValue), unit };
  }
  const roundedValue = Math.max(0, Math.round(baseValue));
  const unit =
    units === "metric"
      ? roundedValue === 1
        ? "meter"
        : "meters"
      : roundedValue === 1
        ? "foot"
        : "feet";
  return { value: String(roundedValue), unit };
}

function emptyResponse(
  query: Query,
  freshness: ReturnType<typeof aggregateFreshness>,
): NearestResponse {
  return {
    selected: null,
    spokenMessage: spokenMessage(null, query.units),
    units: query.units,
    name: null,
    latitude: null,
    longitude: null,
    bikeType: null,
    availableCount: null,
    distanceMeters: null,
    distanceSource: null,
    walkingTimeSeconds: null,
    providerRentalUrl: null,
    mapProvider: query.mapProvider,
    mapPreviewUrl: null,
    mapWalkingUrl: null,
    routingProvider: null,
    appleMapsPreviewUrl: null,
    appleMapsWalkingUrl: null,
    googleMapsPreviewUrl: null,
    googleMapsWalkingUrl: null,
    feedFreshness: freshness,
    confidence: "low",
    approximate: true,
    approximationNote: approximationNote(null),
    requestedType: query.requestedType,
    topCandidates: [],
  };
}

export async function handleRequest(
  request: Request,
  dependencies: AppDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    if (request.method !== "GET")
      return errorResponse("method_not_allowed", "Use GET /.", 405);
    return landingPage(dependencies.shortcutShareUrl);
  }
  if (url.pathname !== "/nearest")
    return errorResponse("not_found", "Use GET / or POST /nearest.", 404);
  if (request.method === "GET") {
    const now = (
      dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
    )();
    return outdatedClientResponse(
      now,
      "method_not_allowed",
      "Use POST /nearest with a JSON body.",
    );
  }
  if (request.method !== "POST")
    return errorResponse("method_not_allowed", "Use POST /nearest.", 405);

  const nowSeconds = (
    dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  )();
  let allowWalkingRoutes = true;
  if (dependencies.rateLimiter) {
    try {
      const { success } = await dependencies.rateLimiter.limit({
        key: dependencies.clientIp ?? "unknown",
      });
      if (!success) {
        return jsonResponse(
          {
            ...emptyResponse(fallbackQuery(), unusedFreshness(nowSeconds)),
            spokenMessage: RATE_LIMIT_SPOKEN_MESSAGE,
            error: "rate_limited",
            message: RATE_LIMIT_SPOKEN_MESSAGE,
          },
          200,
          { "retry-after": String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
        );
      }
    } catch {
      allowWalkingRoutes = false;
    }
  }

  const parsedQuery = await parseNearestBody(request);
  if (isErrorResponse(parsedQuery)) {
    if (parsedQuery.error === "outdated_client") {
      return outdatedClientResponse(
        nowSeconds,
        parsedQuery.error,
        parsedQuery.message,
      );
    }
    return jsonResponse(parsedQuery, 400);
  }
  if (!isInServiceArea(parsedQuery.latitude, parsedQuery.longitude)) {
    return jsonResponse({
      ...emptyResponse(parsedQuery, unusedFreshness(nowSeconds)),
      spokenMessage: OUT_OF_AREA_SPOKEN_MESSAGE,
      approximationNote: OUT_OF_AREA_NOTE,
    });
  }

  if (allowWalkingRoutes && dependencies.routingRateLimiter) {
    try {
      const { success } = await dependencies.routingRateLimiter.limit({
        key: "openrouteservice",
      });
      if (!success) allowWalkingRoutes = false;
    } catch {
      allowWalkingRoutes = false;
    }
  }

  const staleAfterSeconds =
    dependencies.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  try {
    const snapshot = await loadSnapshot({
      ...dependencies,
      nowSeconds: () => nowSeconds,
    });
    const freshness = aggregateFreshness(
      snapshot.sources,
      nowSeconds,
      staleAfterSeconds,
    );
    const candidates = buildCandidates(
      parsedQuery,
      snapshot,
      nowSeconds,
      staleAfterSeconds,
    );
    const initialRanked = rankCandidates(candidates, parsedQuery.requestedType);
    const routingResult = await addWalkingDistances(
      parsedQuery,
      initialRanked,
      {
        ...dependencies,
        openRouteServiceApiKey: allowWalkingRoutes
          ? dependencies.openRouteServiceApiKey
          : undefined,
      },
    );
    const ranked = rankCandidates(
      routingResult.candidates,
      parsedQuery.requestedType,
    );
    const selected = ranked[0];
    if (!selected) return jsonResponse(emptyResponse(parsedQuery, freshness));

    const selectedResponse = toCandidateResponse(selected);
    const selectedMapUrls = mapUrls(selectedResponse, parsedQuery.mapProvider);
    const body: NearestResponse = {
      selected: selectedResponse,
      spokenMessage: spokenMessage(selectedResponse, parsedQuery.units),
      units: parsedQuery.units,
      name: selectedResponse.name,
      latitude: selectedResponse.latitude,
      longitude: selectedResponse.longitude,
      bikeType: selectedResponse.bikeType,
      availableCount: selectedResponse.availableCount,
      distanceMeters: selectedResponse.distanceMeters,
      distanceSource: selectedResponse.distanceSource,
      walkingTimeSeconds: selectedResponse.walkingTimeSeconds,
      providerRentalUrl: selectedResponse.providerRentalUrl,
      mapProvider: parsedQuery.mapProvider,
      mapPreviewUrl: selectedMapUrls.previewUrl,
      mapWalkingUrl: selectedMapUrls.walkingUrl,
      routingProvider:
        selectedResponse.distanceSource === "walking"
          ? "openrouteservice"
          : null,
      appleMapsPreviewUrl: selectedResponse.appleMapsPreviewUrl,
      appleMapsWalkingUrl: selectedResponse.appleMapsWalkingUrl,
      googleMapsPreviewUrl: selectedResponse.googleMapsPreviewUrl,
      googleMapsWalkingUrl: selectedResponse.googleMapsWalkingUrl,
      feedFreshness: freshness,
      confidence: confidenceFor(selected, parsedQuery.requestedType),
      approximate:
        selectedResponse.distanceSource === "straight_line" ||
        selectedResponse.walkingTimeSeconds === null,
      approximationNote: approximationNote(selectedResponse),
      requestedType: parsedQuery.requestedType,
      topCandidates: ranked.slice(0, 5).map(toCandidateResponse),
    };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof FeedError) {
      return jsonResponse({
        ...emptyResponse(parsedQuery, unusedFreshness(nowSeconds)),
        spokenMessage: PROVIDER_UNAVAILABLE_SPOKEN_MESSAGE,
        error: "provider_unavailable",
        message: "Bay Wheels data is temporarily unavailable.",
      });
    }
    return errorResponse(
      "internal_error",
      "The Worker could not complete the request.",
      500,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      fetchImpl: (input, init) => fetch(input, init),
      cache: (
        caches as unknown as { default: NonNullable<AppDependencies["cache"]> }
      ).default,
      discoveryUrl: env.GBFS_DISCOVERY_URL,
      openRouteServiceApiKey: env.OPENROUTESERVICE_API_KEY,
      rateLimiter: env.NEAREST_RATE_LIMITER,
      routingRateLimiter: env.ROUTING_RATE_LIMITER,
      clientIp: request.headers.get("cf-connecting-ip") ?? "unknown",
      shortcutShareUrl: env.SHORTCUT_SHARE_URL,
    });
  },
};

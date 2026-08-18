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

function parseQuery(url: URL): Query | ErrorResponse {
  const latitudeParameter = url.searchParams.get("lat");
  const longitudeParameter = url.searchParams.get("lon");
  const latitude = Number(latitudeParameter);
  const longitude = Number(longitudeParameter);
  const type = url.searchParams.get("type") ?? "any";
  const units = url.searchParams.get("units") ?? "imperial";
  const maps = url.searchParams.get("maps") ?? "apple";
  if (
    !latitudeParameter ||
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
    !longitudeParameter ||
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
    .replaceAll('"', "&quot;");
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

function landingPage(shareUrl: string | undefined): Response {
  const configured = Boolean(shareUrl?.trim());
  const href = shortcutShareHref(shareUrl);
  if (configured && !href) {
    console.error("SHORTCUT_SHARE_URL is not a valid iCloud Shortcut link.");
  }
  const addShortcut = href
    ? `<p><a href="${escapeHtml(href)}">Add Shortcut</a></p>`
    : configured
      ? "<p>The Shortcut link is not configured correctly.</p>"
      : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nearest Bikeshare</title>
</head>
<body>
  <h1>Nearest Bikeshare</h1>
  <p>Ask Siri for the nearest available Bay Wheels bike.</p>
  ${addShortcut}
  <p>This tool covers Bay Wheels in the San Francisco Bay Area. There is no account.</p>
  <p>The Worker uses your current location to find a nearby bike. It does not store that location.</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
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
  if (request.method !== "GET")
    return errorResponse(
      "method_not_allowed",
      "Use GET / or GET /nearest.",
      405,
    );
  if (url.pathname === "/") return landingPage(dependencies.shortcutShareUrl);
  if (url.pathname !== "/nearest")
    return errorResponse("not_found", "Use GET / or GET /nearest.", 404);

  const nowSeconds = (
    dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  )();
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
    } catch {}
  }

  const parsedQuery = parseQuery(url);
  if (isErrorResponse(parsedQuery)) return jsonResponse(parsedQuery, 400);
  if (!isInServiceArea(parsedQuery.latitude, parsedQuery.longitude)) {
    return jsonResponse({
      ...emptyResponse(parsedQuery, unusedFreshness(nowSeconds)),
      spokenMessage: OUT_OF_AREA_SPOKEN_MESSAGE,
      approximationNote: OUT_OF_AREA_NOTE,
    });
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
      dependencies,
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
      clientIp: request.headers.get("cf-connecting-ip") ?? "unknown",
      shortcutShareUrl: env.SHORTCUT_SHARE_URL,
    });
  },
};

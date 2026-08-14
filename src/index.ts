import { DEFAULT_STALE_AFTER_SECONDS, FeedError, loadSnapshot } from "./gbfs";
import {
  aggregateFreshness,
  buildCandidates,
  confidenceFor,
  rankCandidates,
  toCandidateResponse,
} from "./ranking";
import type {
  AppDependencies,
  ErrorResponse,
  Env,
  NearestResponse,
  Query,
  RequestedBikeType,
  DistanceUnits,
} from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
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
  return {
    latitude,
    longitude,
    requestedType: type,
    units: units as DistanceUnits,
  };
}

function isErrorResponse(value: Query | ErrorResponse): value is ErrorResponse {
  return "error" in value;
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
    providerRentalUrl: null,
    appleMapsPreviewUrl: null,
    appleMapsWalkingUrl: null,
    googleMapsPreviewUrl: null,
    googleMapsWalkingUrl: null,
    feedFreshness: freshness,
    confidence: "low",
    approximate: true,
    approximationNote:
      "Distance is straight-line. Walking time is not available.",
    requestedType: query.requestedType,
    topCandidates: [],
    message: spokenMessage(null, query.units),
  };
}

export async function handleRequest(
  request: Request,
  dependencies: AppDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET")
    return errorResponse("method_not_allowed", "Use GET /nearest.", 405);
  if (url.pathname !== "/nearest")
    return errorResponse("not_found", "Use GET /nearest.", 404);

  const parsedQuery = parseQuery(url);
  if (isErrorResponse(parsedQuery)) return jsonResponse(parsedQuery, 400);

  const nowSeconds = (
    dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  )();
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
    const ranked = rankCandidates(candidates, parsedQuery.requestedType);
    const selected = ranked[0];
    if (!selected) return jsonResponse(emptyResponse(parsedQuery, freshness));

    const selectedResponse = toCandidateResponse(selected);
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
      providerRentalUrl: selectedResponse.providerRentalUrl,
      appleMapsPreviewUrl: selectedResponse.appleMapsPreviewUrl,
      appleMapsWalkingUrl: selectedResponse.appleMapsWalkingUrl,
      googleMapsPreviewUrl: selectedResponse.googleMapsPreviewUrl,
      googleMapsWalkingUrl: selectedResponse.googleMapsWalkingUrl,
      feedFreshness: freshness,
      confidence: confidenceFor(selected, parsedQuery.requestedType),
      approximate: true,
      approximationNote:
        "Distance is straight-line. Walking time is not available.",
      requestedType: parsedQuery.requestedType,
      topCandidates: ranked.slice(0, 5).map(toCandidateResponse),
    };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof FeedError) {
      return errorResponse(
        "provider_unavailable",
        "Bay Wheels data is temporarily unavailable.",
        503,
      );
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
    });
  },
};

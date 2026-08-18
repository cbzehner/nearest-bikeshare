import type { AppDependencies, Candidate, Query } from "./types";

export const OPENROUTESERVICE_MATRIX_URL =
  "https://api.openrouteservice.org/v2/matrix/foot-walking";
export const MAX_ROUTED_CANDIDATES = 10;

const ROUTING_TIMEOUT_MS = 5_000;

interface RouteMatrix {
  distances: Array<Array<number | null>>;
  durations: Array<Array<number | null>>;
}

export interface RoutingResult {
  candidates: Candidate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetricRow(value: unknown, field: string): Array<number | null> {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (entry === null) return null;
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new Error(`${field}[${index}] must be a non-negative number`);
    }
    return entry;
  });
}

function parseRouteMatrix(
  payload: unknown,
  destinationCount: number,
): RouteMatrix {
  if (!isRecord(payload)) throw new Error("route response must be an object");
  if (!Array.isArray(payload.distances) || !Array.isArray(payload.durations)) {
    throw new Error("route response must contain distances and durations");
  }
  if (payload.distances.length !== 1 || payload.durations.length !== 1) {
    throw new Error("route response must contain one source row");
  }
  const distances = [parseMetricRow(payload.distances[0], "distances")];
  const durations = [parseMetricRow(payload.durations[0], "durations")];
  if (
    distances[0].length !== destinationCount ||
    durations[0].length !== destinationCount
  ) {
    throw new Error("route response does not match the request");
  }
  return { distances, durations };
}

async function fetchRouteMatrix(
  query: Query,
  candidates: Candidate[],
  dependencies: AppDependencies,
): Promise<RouteMatrix> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTING_TIMEOUT_MS);
  const locations = [
    [query.longitude, query.latitude],
    ...candidates.map((candidate) => [candidate.longitude, candidate.latitude]),
  ];
  try {
    const response = await dependencies.fetchImpl(OPENROUTESERVICE_MATRIX_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: dependencies.openRouteServiceApiKey ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locations,
        sources: ["0"],
        destinations: candidates.map((_, index) => String(index + 1)),
        metrics: ["distance", "duration"],
      }),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`routing provider returned ${response.status}`);
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().includes("json")) {
      throw new Error("routing provider returned non-JSON data");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("routing provider returned malformed JSON");
    }
    return parseRouteMatrix(payload, candidates.length);
  } finally {
    clearTimeout(timeout);
  }
}

export async function addWalkingDistances(
  query: Query,
  candidates: Candidate[],
  dependencies: AppDependencies,
): Promise<RoutingResult> {
  if (!dependencies.openRouteServiceApiKey || candidates.length === 0) {
    return { candidates };
  }

  const routedCandidates = candidates.slice(0, MAX_ROUTED_CANDIDATES);
  try {
    const matrix = await fetchRouteMatrix(
      query,
      routedCandidates,
      dependencies,
    );
    const distances = matrix.distances[0];
    const durations = matrix.durations[0];
    if (distances.some((distance) => distance === null)) return { candidates };
    const routed = routedCandidates.map((candidate, index) => {
      return {
        ...candidate,
        distanceMeters: distances[index] ?? candidate.distanceMeters,
        distanceSource: "walking" as const,
        walkingTimeSeconds: durations[index],
      };
    });
    return { candidates: routed };
  } catch {
    return { candidates };
  }
}

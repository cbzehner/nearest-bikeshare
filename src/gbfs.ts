import type {
  AppDependencies,
  FeedMeta,
  FeedSource,
  FreeBike,
  GbfsSnapshot,
  JsonRecord,
  RentalUris,
  StationAvailabilityByType,
  StationInformation,
  StationStatus,
  VehicleType,
  BikeType,
} from "./types";

export const OFFICIAL_DISCOVERY_URL =
  "https://gbfs.baywheels.com/gbfs/2.3/gbfs.json";
export const SUPPORTED_FEED_VERSION = "2.3";
export const DEFAULT_STALE_AFTER_SECONDS = 300;

const DISCOVERY_FEED_VERSION = SUPPORTED_FEED_VERSION;
const MAX_FEED_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_FEED_HOSTS = new Set([
  "gbfs.baywheels.com",
  "gbfs.lyft.com",
  "gbfs.lyftbikes.com",
]);

export class FeedError extends Error {
  constructor(
    message: string,
    public readonly feedName: string,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

interface DiscoveredFeed {
  name: string;
  url: string;
}

interface DiscoveryDocument {
  meta: FeedMeta;
  feeds: DiscoveredFeed[];
}

interface LoadedFeed<T> {
  value: T;
  meta: FeedMeta;
  source: FeedSource;
}

type FeedParser<T> = (
  payload: unknown,
  feedName: string,
) => { value: T; meta: FeedMeta };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  feedName: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FeedError(`${field} must be a non-empty string`, feedName);
  }
  return value;
}

function requiredNumber(
  value: unknown,
  field: string,
  feedName: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FeedError(`${field} must be a finite number`, feedName);
  }
  return value;
}

function requiredNonNegativeInteger(
  value: unknown,
  field: string,
  feedName: string,
): number {
  const number = requiredNumber(value, field, feedName);
  if (!Number.isInteger(number) || number < 0) {
    throw new FeedError(`${field} must be a non-negative integer`, feedName);
  }
  return number;
}

function requiredCoordinate(
  value: unknown,
  field: string,
  feedName: string,
): number {
  const coordinate = requiredNumber(value, field, feedName);
  const limit = field === "lat" ? 90 : 180;
  if (coordinate < -limit || coordinate > limit) {
    throw new FeedError(`${field} is outside its valid range`, feedName);
  }
  return coordinate;
}

function requiredFlag(
  value: unknown,
  field: string,
  feedName: string,
): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new FeedError(`${field} must be a boolean or 0/1`, feedName);
}

function optionalTimestamp(
  value: unknown,
  field: string,
  feedName: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredNonNegativeInteger(value, field, feedName);
}

function parseMeta(
  payload: unknown,
  feedName: string,
  version: string,
): { data: JsonRecord; meta: FeedMeta } {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new FeedError("payload must contain an object data field", feedName);
  }

  const payloadVersion = requiredString(payload.version, "version", feedName);
  if (payloadVersion !== version) {
    throw new FeedError(`unsupported GBFS version ${payloadVersion}`, feedName);
  }

  const lastUpdated = requiredNonNegativeInteger(
    payload.last_updated,
    "last_updated",
    feedName,
  );
  const ttl = requiredNonNegativeInteger(payload.ttl, "ttl", feedName);
  return {
    data: payload.data,
    meta: { lastUpdated, ttl, version: payloadVersion },
  };
}

function parseRentalUris(
  value: unknown,
  feedName: string,
): RentalUris | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value))
    throw new FeedError("rental_uris must be an object", feedName);

  const result: RentalUris = {};
  for (const key of ["ios", "web"] as const) {
    const uri = value[key];
    if (uri !== undefined) {
      const parsed = requiredString(uri, `rental_uris.${key}`, feedName);
      if (!isAllowedRentalUri(parsed, key))
        throw new FeedError(`invalid rental_uris.${key}`, feedName);
      result[key] = parsed;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function isAllowedRentalUri(value: string, field: "ios" | "web"): boolean {
  try {
    const url = new URL(value);
    const allowedProtocols =
      field === "web"
        ? new Set(["http:", "https:"])
        : new Set(["http:", "https:", "lyft:", "baywheels:"]);
    return allowedProtocols.has(url.protocol);
  } catch {
    return false;
  }
}

function parseDiscovery(payload: unknown): DiscoveryDocument {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new FeedError("payload must contain an object data field", "gbfs");
  }
  const payloadVersion = requiredString(payload.version, "version", "gbfs");
  if (payloadVersion !== DISCOVERY_FEED_VERSION) {
    throw new FeedError(
      `unsupported discovery version ${payloadVersion}`,
      "gbfs",
    );
  }

  const lastUpdated = requiredNonNegativeInteger(
    payload.last_updated,
    "last_updated",
    "gbfs",
  );
  const ttl = requiredNonNegativeInteger(payload.ttl, "ttl", "gbfs");
  const localeData = isRecord(payload.data.en)
    ? payload.data.en
    : Object.values(payload.data).find((value): value is JsonRecord =>
        isRecord(value),
      );
  if (!localeData || !Array.isArray(localeData.feeds)) {
    throw new FeedError(
      "discovery data must contain a localized feeds array",
      "gbfs",
    );
  }

  const feeds = localeData.feeds.map((feed, index) => {
    if (!isRecord(feed))
      throw new FeedError(`feeds[${index}] must be an object`, "gbfs");
    const name = requiredString(feed.name, `feeds[${index}].name`, "gbfs");
    const url = requiredString(feed.url, `feeds[${index}].url`, "gbfs");
    if (!isAllowedFeedUrl(url))
      throw new FeedError(`feeds[${index}].url is not allowed`, "gbfs");
    return { name, url };
  });

  return { meta: { lastUpdated, ttl, version: payloadVersion }, feeds };
}

function parseStationInformation(
  payload: unknown,
  feedName: string,
): { value: StationInformation[]; meta: FeedMeta } {
  const { data, meta } = parseMeta(payload, feedName, SUPPORTED_FEED_VERSION);
  if (!Array.isArray(data.stations))
    throw new FeedError("stations must be an array", feedName);

  const stations = data.stations.map((station, index) => {
    if (!isRecord(station))
      throw new FeedError(`stations[${index}] must be an object`, feedName);
    return {
      stationId: requiredString(
        station.station_id,
        `stations[${index}].station_id`,
        feedName,
      ),
      name: requiredString(station.name, `stations[${index}].name`, feedName),
      latitude: requiredCoordinate(station.lat, "lat", feedName),
      longitude: requiredCoordinate(station.lon, "lon", feedName),
      rentalUris: parseRentalUris(station.rental_uris, feedName),
    };
  });
  return { value: stations, meta };
}

function parseStationStatus(
  payload: unknown,
  feedName: string,
): { value: StationStatus[]; meta: FeedMeta } {
  const { data, meta } = parseMeta(payload, feedName, SUPPORTED_FEED_VERSION);
  if (!Array.isArray(data.stations))
    throw new FeedError("stations must be an array", feedName);

  const stations = data.stations.map((station, index) => {
    if (!isRecord(station))
      throw new FeedError(`stations[${index}] must be an object`, feedName);
    const availabilityByType = station.vehicle_types_available;
    let parsedAvailability: StationAvailabilityByType[] | undefined;
    if (availabilityByType !== undefined) {
      if (!Array.isArray(availabilityByType)) {
        throw new FeedError(
          `stations[${index}].vehicle_types_available must be an array`,
          feedName,
        );
      }
      parsedAvailability = availabilityByType.map((entry, entryIndex) => {
        if (!isRecord(entry))
          throw new FeedError(
            `vehicle_types_available[${entryIndex}] must be an object`,
            feedName,
          );
        return {
          vehicleTypeId: requiredString(
            entry.vehicle_type_id,
            "vehicle_type_id",
            feedName,
          ),
          count: requiredNonNegativeInteger(entry.count, "count", feedName),
        };
      });
    }

    return {
      stationId: requiredString(
        station.station_id,
        `stations[${index}].station_id`,
        feedName,
      ),
      availableCount: requiredNonNegativeInteger(
        station.num_bikes_available,
        "num_bikes_available",
        feedName,
      ),
      isInstalled: requiredFlag(station.is_installed, "is_installed", feedName),
      isRenting: requiredFlag(station.is_renting, "is_renting", feedName),
      lastReported: optionalTimestamp(
        station.last_reported,
        "last_reported",
        feedName,
      ),
      availabilityByType: parsedAvailability,
    };
  });
  return { value: stations, meta };
}

function parseVehicleTypes(
  payload: unknown,
  feedName: string,
): { value: VehicleType[]; meta: FeedMeta } {
  const { data, meta } = parseMeta(payload, feedName, SUPPORTED_FEED_VERSION);
  if (!Array.isArray(data.vehicle_types))
    throw new FeedError("vehicle_types must be an array", feedName);

  const vehicleTypes = data.vehicle_types.flatMap((vehicleType, index) => {
    if (!isRecord(vehicleType))
      throw new FeedError(
        `vehicle_types[${index}] must be an object`,
        feedName,
      );
    const vehicleTypeId = requiredString(
      vehicleType.vehicle_type_id,
      "vehicle_type_id",
      feedName,
    );
    const formFactor = requiredString(
      vehicleType.form_factor,
      "form_factor",
      feedName,
    );
    const propulsionType = requiredString(
      vehicleType.propulsion_type,
      "propulsion_type",
      feedName,
    );
    if (formFactor !== "bicycle") return [];
    let bikeType: BikeType | undefined;
    if (propulsionType === "human") bikeType = "classic";
    if (propulsionType === "electric_assist" || propulsionType === "electric")
      bikeType = "electric";
    return bikeType ? [{ vehicleTypeId, bikeType }] : [];
  });
  return { value: vehicleTypes, meta };
}

function parseFreeBikes(
  payload: unknown,
  feedName: string,
): { value: FreeBike[]; meta: FeedMeta } {
  const { data, meta } = parseMeta(payload, feedName, SUPPORTED_FEED_VERSION);
  if (!Array.isArray(data.bikes))
    throw new FeedError("bikes must be an array", feedName);

  const bikes = data.bikes.map((bike, index) => {
    if (!isRecord(bike))
      throw new FeedError(`bikes[${index}] must be an object`, feedName);
    const stationId =
      bike.station_id === undefined
        ? undefined
        : requiredString(bike.station_id, "station_id", feedName);
    const latitude =
      bike.lat === undefined
        ? undefined
        : requiredCoordinate(bike.lat, "lat", feedName);
    const longitude =
      bike.lon === undefined
        ? undefined
        : requiredCoordinate(bike.lon, "lon", feedName);
    if (!stationId && (latitude === undefined || longitude === undefined)) {
      throw new FeedError(
        `bikes[${index}] needs lat/lon when station_id is absent`,
        feedName,
      );
    }
    return {
      bikeId: requiredString(bike.bike_id, `bikes[${index}].bike_id`, feedName),
      latitude,
      longitude,
      isReserved: requiredFlag(bike.is_reserved, "is_reserved", feedName),
      isDisabled: requiredFlag(bike.is_disabled, "is_disabled", feedName),
      vehicleTypeId:
        bike.vehicle_type_id === undefined
          ? undefined
          : requiredString(bike.vehicle_type_id, "vehicle_type_id", feedName),
      stationId,
      lastReported: optionalTimestamp(
        bike.last_reported,
        "last_reported",
        feedName,
      ),
      rentalUris: parseRentalUris(bike.rental_uris, feedName),
    };
  });
  return { value: bikes, meta };
}

function isAllowedFeedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_FEED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function cacheRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

async function fetchPayload(
  url: string,
  feedName: string,
  dependencies: AppDependencies,
): Promise<{ payload: unknown; fromCache: boolean }> {
  const request = cacheRequest(url);
  if (dependencies.cache) {
    const cached = await dependencies.cache.match(request);
    if (cached) {
      try {
        return { payload: await cached.json(), fromCache: true };
      } catch {
        // Ignore invalid cached data. Get fresh data from the provider.
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await dependencies.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new FeedError(
      `request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      feedName,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok)
    throw new FeedError(`provider returned HTTP ${response.status}`, feedName);
  const finalUrl = response.url || url;
  if (!isAllowedFeedUrl(finalUrl))
    throw new FeedError("provider redirected to an untrusted host", feedName);
  const contentType = response.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().includes("json")) {
    throw new FeedError("provider returned a non-JSON content type", feedName);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_FEED_BYTES) {
    throw new FeedError("provider response is too large", feedName);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new FeedError("provider returned malformed JSON", feedName);
  }
  return { payload, fromCache: false };
}

async function loadFeed<T>(
  name: string,
  url: string,
  parser: FeedParser<T>,
  dependencies: AppDependencies,
): Promise<LoadedFeed<T>> {
  const loaded = await fetchPayload(url, name, dependencies);
  const parsed = parser(loaded.payload, name);

  if (!loaded.fromCache && parsed.meta.ttl > 0 && dependencies.cache) {
    const response = new Response(JSON.stringify(loaded.payload), {
      headers: {
        "Cache-Control": `public, max-age=${parsed.meta.ttl}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    await dependencies.cache.put(cacheRequest(url), response);
  }

  return {
    value: parsed.value,
    meta: parsed.meta,
    source: {
      name,
      lastUpdated: parsed.meta.lastUpdated,
      ttl: parsed.meta.ttl,
      fromCache: loaded.fromCache,
    },
  };
}

function feedMap(feeds: DiscoveredFeed[]): Map<string, DiscoveredFeed> {
  return new Map(feeds.map((feed) => [feed.name, feed]));
}

export async function loadSnapshot(
  dependencies: AppDependencies,
): Promise<GbfsSnapshot> {
  const discoveryUrl = dependencies.discoveryUrl ?? OFFICIAL_DISCOVERY_URL;
  if (!isAllowedFeedUrl(discoveryUrl))
    throw new FeedError("discovery URL is not allowed", "gbfs");
  const discovery = await loadFeed(
    "gbfs",
    discoveryUrl,
    (payload) => {
      const parsed = parseDiscovery(payload);
      return { value: parsed, meta: parsed.meta };
    },
    dependencies,
  );
  const discovered = feedMap(discovery.value.feeds);

  const stationInformationUrl = discovered.get("station_information")?.url;
  const stationStatusUrl = discovered.get("station_status")?.url;
  if (!stationInformationUrl || !stationStatusUrl) {
    throw new FeedError(
      "required station feeds are missing from discovery",
      "gbfs",
    );
  }

  const stationInformation = await loadFeed(
    "station_information",
    stationInformationUrl,
    parseStationInformation,
    dependencies,
  );
  const stationStatus = await loadFeed(
    "station_status",
    stationStatusUrl,
    parseStationStatus,
    dependencies,
  );

  const vehicleTypesFeed = discovered.get("vehicle_types");
  const vehicleTypes = vehicleTypesFeed
    ? await loadFeed(
        "vehicle_types",
        vehicleTypesFeed.url,
        parseVehicleTypes,
        dependencies,
      )
    : { value: [], meta: undefined, source: undefined };

  const freeBikesFeed = discovered.get("free_bike_status");
  let freeBikes: LoadedFeed<FreeBike[]> | undefined;
  if (freeBikesFeed) {
    try {
      freeBikes = await loadFeed(
        "free_bike_status",
        freeBikesFeed.url,
        parseFreeBikes,
        dependencies,
      );
    } catch {
      // Free-floating bike data is optional. Keep station results if this feed fails.
    }
  }

  return {
    stationInformation: stationInformation.value,
    stationStatus: stationStatus.value,
    vehicleTypes: vehicleTypes.value,
    freeBikes: freeBikes?.value ?? [],
    sources: [
      discovery.source,
      stationInformation.source,
      stationStatus.source,
      ...(vehicleTypes.source ? [vehicleTypes.source] : []),
      ...(freeBikes?.source ? [freeBikes.source] : []),
    ],
  };
}

export function isStale(
  timestamp: number | undefined,
  nowSeconds: number,
  staleAfterSeconds: number,
): boolean {
  return timestamp !== undefined && nowSeconds - timestamp > staleAfterSeconds;
}

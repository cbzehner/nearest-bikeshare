import { readFileSync } from "node:fs";
import { formatDistance, handleRequest } from "../src/index";
import { OPENROUTESERVICE_MATRIX_URL } from "../src/routing";
import type { CacheLike, JsonRecord, RateLimiter } from "../src/types";

const DISCOVERY_URL = "https://gbfs.baywheels.com/fixtures/gbfs.json";
const FIXTURE_URLS: Record<string, string> = {
  "https://gbfs.baywheels.com/fixtures/gbfs.json": "gbfs.json",
  "https://gbfs.lyft.com/fixtures/station_information.json":
    "station_information.json",
  "https://gbfs.lyft.com/fixtures/station_status.json": "station_status.json",
  "https://gbfs.lyft.com/fixtures/vehicle_types.json": "vehicle_types.json",
  "https://gbfs.lyft.com/fixtures/free_bike_status.json":
    "free_bike_status.json",
};
const NOW_SECONDS = 1700000100;

function fixture(name: string): JsonRecord {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as JsonRecord;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class TestCache implements CacheLike {
  private readonly responses = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.responses.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.responses.set(request.url, response.clone());
  }
}

interface FixtureOptions {
  overrides?: Record<string, unknown>;
  failingFeed?: string;
  rawFeed?: string;
  routingResponse?: JsonRecord;
  routingFailure?: boolean;
  rateLimiter?: RateLimiter;
  routingRateLimiter?: RateLimiter;
  shortcutShareUrl?: string;
}

function dependencies(options: FixtureOptions = {}) {
  const cache = new TestCache();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === OPENROUTESERVICE_MATRIX_URL) {
      if (options.routingFailure) throw new Error("routing provider failure");
      if (!options.routingResponse)
        return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(options.routingResponse), {
        headers: { "content-type": "application/json" },
      });
    }
    const fixtureName = FIXTURE_URLS[url];
    if (!fixtureName) return new Response("not found", { status: 404 });
    if (options.failingFeed === fixtureName)
      throw new Error("fixture provider failure");
    if (options.rawFeed && fixtureName === options.rawFeed)
      return new Response(options.rawFeed);
    const payload = clone(fixture(fixtureName));
    const override = options.overrides?.[fixtureName];
    if (override) {
      Object.assign(payload, override);
    }
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetchImpl,
    cache,
    discoveryUrl: DISCOVERY_URL,
    nowSeconds: () => NOW_SECONDS,
    openRouteServiceApiKey:
      options.routingResponse || options.routingFailure
        ? "test-key"
        : undefined,
    rateLimiter: options.rateLimiter,
    routingRateLimiter: options.routingRateLimiter,
    clientIp: "203.0.113.10",
    shortcutShareUrl: options.shortcutShareUrl,
  };
}

function nearestRequest(fields: Record<string, unknown> = {}): Request {
  return new Request("https://worker.test/nearest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lat: 37.76,
      lon: -122.42,
      type: "electric",
      ...fields,
    }),
  });
}

async function responseJson(fields: Record<string, unknown> = {}) {
  const response = await handleRequest(nearestRequest(fields), dependencies());
  return { response, body: (await response.json()) as JsonRecord };
}

describe("nearest bikeshare endpoint", () => {
  it("prefers the requested electric type and returns station availability", async () => {
    const { response, body } = await responseJson();

    expect(response.status).toBe(200);
    expect(body.selected).toMatchObject({
      entityType: "station",
      name: "18th Street",
      bikeType: "electric",
      availableCount: 2,
    });
    expect(body.distanceMeters).toBe(0);
    expect(body.spokenMessage).toContain("feet");
    expect(body.spokenMessage).toContain("ee bike");
    expect(body.spokenMessage).toContain("available");
    expect(body.units).toBe("imperial");
    expect(body.providerRentalUrl).toContain("sfo.lft.to/lastmile_qr_scan");
    expect(body.appleMapsPreviewUrl).toContain("maps.apple.com");
    expect(body.googleMapsPreviewUrl).toContain("google.com/maps");
    expect(body.mapProvider).toBe("apple");
    expect(body.mapPreviewUrl).toContain("maps.apple.com");
    expect(body.distanceSource).toBe("straight_line");
    expect(body.walkingTimeSeconds).toBeNull();
    expect(body.approximate).toBe(true);
    expect((body.topCandidates as unknown[]).length).toBe(5);
  });

  it("uses metric units and switches to kilometers over one thousand meters", async () => {
    const { body } = await responseJson({
      lat: 37.78,
      lon: -122.42,
      type: "any",
      units: "metric",
    });

    expect(body.units).toBe("metric");
    expect(body.spokenMessage).toContain("kilometers");
    expect(body.spokenMessage).not.toContain("feet");
  });

  it("selects the configured Google Maps URLs", async () => {
    const { body } = await responseJson({
      type: "any",
      maps: "google",
    });

    expect(body.mapProvider).toBe("google");
    expect(body.mapPreviewUrl).toContain("google.com/maps");
    expect(body.mapWalkingUrl).toContain("google.com/maps");
  });

  it("keeps exactly one thousand base units in the smaller unit", () => {
    expect(formatDistance(304.7999, "imperial")).toEqual({
      value: "1000",
      unit: "feet",
    });
    expect(formatDistance(304.8001, "imperial").unit).toBe("miles");
    expect(formatDistance(1000, "metric")).toEqual({
      value: "1000",
      unit: "meters",
    });
    expect(formatDistance(1000.1, "metric").unit).toBe("kilometer");
  });

  it("prefers the requested type before geometric distance", async () => {
    const emptyBikes = clone(fixture("free_bike_status.json"));
    (emptyBikes.data as JsonRecord).bikes = [];
    const { body } = await handleRequestWithOverrides(
      { "free_bike_status.json": emptyBikes },
      { lat: 37.7605, lon: -122.42, type: "electric" },
    );

    expect(body.bikeType).toBe("electric");
    expect(body.name).toBe("18th Street");
  });

  it("supports classic preference and free-floating bikes", async () => {
    const emptyStatus = clone(fixture("station_status.json"));
    const stations = (emptyStatus.data as JsonRecord).stations as JsonRecord[];
    for (const station of stations) {
      station.num_bikes_available = 0;
      station.vehicle_types_available = [];
    }
    const { body } = await handleRequestWithOverrides(
      { "station_status.json": emptyStatus },
      { lat: 37.759, lon: -122.42, type: "classic" },
    );

    expect(body.bikeType).toBe("classic");
    expect(body.selected).toMatchObject({
      entityType: "bike",
      name: "Available classic bike",
      availableCount: 1,
    });
  });

  it("does not speak the provider placeholder name for a free-floating e-bike", async () => {
    const emptyStatus = clone(fixture("station_status.json"));
    const stations = (emptyStatus.data as JsonRecord).stations as JsonRecord[];
    for (const station of stations) {
      station.num_bikes_available = 0;
      station.vehicle_types_available = [];
    }
    const { body } = await handleRequestWithOverrides(
      { "station_status.json": emptyStatus },
      { lat: 37.7605, lon: -122.42, type: "electric" },
    );

    expect(body.name).toBe("Available e-bike");
    expect(body.spokenMessage).toContain("ee bike");
    expect(body.spokenMessage).not.toContain("e-bike");
    expect(body.spokenMessage).not.toContain("at Available");
  });

  it("uses type-specific counts for a mixed station", async () => {
    const { body } = await responseJson({
      lat: 37.761,
      lon: -122.421,
      type: "electric",
    });
    const mixedCandidate = (body.topCandidates as JsonRecord[]).find(
      (candidate) => candidate.name === "Mixed Station",
    );

    expect(mixedCandidate).toMatchObject({
      bikeType: "electric",
      availableCount: 1,
    });
  });

  it("filters reserved and disabled bikes and avoids docked duplicates", async () => {
    const { body } = await responseJson({ type: "any" });
    const ids = (body.topCandidates as JsonRecord[]).map(
      (candidate) => candidate.id,
    );

    expect(ids).not.toContain("reserved-electric");
    expect(ids).not.toContain("disabled-electric");
    expect(ids).not.toContain("docked-electric");
  });

  it("returns a useful 200 no-results response when nothing is available", async () => {
    const statusFixture = fixture("station_status.json");
    const emptyStatus = clone(statusFixture);
    const stations = (emptyStatus.data as JsonRecord).stations as JsonRecord[];
    for (const station of stations) {
      station.num_bikes_available = 0;
      station.vehicle_types_available = [];
    }
    const emptyBikes = clone(fixture("free_bike_status.json"));
    (emptyBikes.data as JsonRecord).bikes = [];
    const { response, body } = await handleRequestWithOverrides({
      "station_status.json": emptyStatus,
      "free_bike_status.json": emptyBikes,
    });

    expect(response.status).toBe(200);
    expect(body.selected).toBeNull();
    expect(body.spokenMessage).toContain("No available bikes");
    expect(body.appleMapsPreviewUrl).toBeNull();
    expect(body.googleMapsPreviewUrl).toBeNull();
  });

  it("prefers a nearby single bike over a farther station with multiple bikes", async () => {
    const stationInformation = clone(fixture("station_information.json"));
    (stationInformation.data as JsonRecord).stations = [
      {
        station_id: "station-electric",
        name: "Far Station",
        lat: 37.7672,
        lon: -122.42,
      },
    ];
    const stationStatus = clone(fixture("station_status.json"));
    (stationStatus.data as JsonRecord).stations = [
      {
        station_id: "station-electric",
        num_bikes_available: 2,
        is_installed: 1,
        is_renting: 1,
        last_reported: 1700000000,
        vehicle_types_available: [{ vehicle_type_id: "2", count: 2 }],
      },
    ];
    const freeBikes = clone(fixture("free_bike_status.json"));
    (freeBikes.data as JsonRecord).bikes = [
      {
        bike_id: "nearby-electric",
        lat: 37.76027,
        lon: -122.42,
        is_reserved: 0,
        is_disabled: 0,
        vehicle_type_id: "2",
        last_reported: 1700000000,
      },
    ];

    const { body } = await handleRequestWithOverrides(
      {
        "station_information.json": stationInformation,
        "station_status.json": stationStatus,
        "free_bike_status.json": freeBikes,
      },
      { type: "any" },
    );

    expect(body.selected).toMatchObject({
      entityType: "bike",
      id: "nearby-electric",
      availableCount: 1,
    });
    expect(body.distanceMeters).toBeLessThan(50);
  });

  it("uses walking distance to rank the closest routed candidate", async () => {
    const stationInformation = clone(fixture("station_information.json"));
    (stationInformation.data as JsonRecord).stations = [
      {
        station_id: "station-electric",
        name: "Far Station",
        lat: 37.7672,
        lon: -122.42,
      },
    ];
    const stationStatus = clone(fixture("station_status.json"));
    (stationStatus.data as JsonRecord).stations = [
      {
        station_id: "station-electric",
        num_bikes_available: 2,
        is_installed: 1,
        is_renting: 1,
        last_reported: 1700000000,
        vehicle_types_available: [{ vehicle_type_id: "2", count: 2 }],
      },
    ];
    const freeBikes = clone(fixture("free_bike_status.json"));
    (freeBikes.data as JsonRecord).bikes = [
      {
        bike_id: "nearby-electric",
        lat: 37.76027,
        lon: -122.42,
        is_reserved: 0,
        is_disabled: 0,
        vehicle_type_id: "2",
        last_reported: 1700000000,
      },
    ];

    const { body } = await handleRequestWithOptions(
      {
        overrides: {
          "station_information.json": stationInformation,
          "station_status.json": stationStatus,
          "free_bike_status.json": freeBikes,
        },
        routingResponse: fixture("openrouteservice_matrix.json"),
      },
      { type: "any" },
    );

    expect(body.selected).toMatchObject({
      entityType: "station",
      name: "Far Station",
      availableCount: 2,
      distanceMeters: 100,
      distanceSource: "walking",
      walkingTimeSeconds: 80,
    });
    expect(body.routingProvider).toBe("openrouteservice");
    expect(body.approximate).toBe(false);
  });

  it("falls back to straight-line distance when the route response is invalid", async () => {
    const { body } = await handleRequestWithOptions({
      routingResponse: { distances: "invalid", durations: [] },
    });

    expect(body.distanceSource).toBe("straight_line");
    expect(body.routingProvider).toBeNull();
    expect(body.approximate).toBe(true);
  });

  it("keeps walking metrics when one destination is unroutable", async () => {
    const stationInformation = clone(fixture("station_information.json"));
    (stationInformation.data as JsonRecord).stations = [
      {
        station_id: "station-electric",
        name: "Far Station",
        lat: 37.7672,
        lon: -122.42,
      },
    ];
    const stationStatus = clone(fixture("station_status.json"));
    (stationStatus.data as JsonRecord).stations = [
      {
        station_id: "station-electric",
        num_bikes_available: 2,
        is_installed: 1,
        is_renting: 1,
        last_reported: 1700000000,
        vehicle_types_available: [{ vehicle_type_id: "2", count: 2 }],
      },
    ];
    const freeBikes = clone(fixture("free_bike_status.json"));
    (freeBikes.data as JsonRecord).bikes = [
      {
        bike_id: "nearby-electric",
        lat: 37.76027,
        lon: -122.42,
        is_reserved: 0,
        is_disabled: 0,
        vehicle_type_id: "2",
        last_reported: 1700000000,
      },
    ];

    const { body } = await handleRequestWithOptions(
      {
        overrides: {
          "station_information.json": stationInformation,
          "station_status.json": stationStatus,
          "free_bike_status.json": freeBikes,
        },
        routingResponse: {
          distances: [[300, null]],
          durations: [[240, null]],
        },
      },
      { type: "any" },
    );

    expect(body.selected).toMatchObject({
      entityType: "bike",
      id: "nearby-electric",
      distanceMeters: 300,
      distanceSource: "walking",
      walkingTimeSeconds: 240,
    });
    expect(body.routingProvider).toBe("openrouteservice");
  });

  it("routes ten unique places when mixed stations fill more than ten rows", async () => {
    const stations = Array.from({ length: 6 }, (_, index) => ({
      station_id: `mixed-${index + 1}`,
      name: `Mixed ${index + 1}`,
      lat: 37.761 + index * 0.001,
      lon: -122.42,
    }));
    const stationInformation = clone(fixture("station_information.json"));
    (stationInformation.data as JsonRecord).stations = stations;
    const stationStatus = clone(fixture("station_status.json"));
    (stationStatus.data as JsonRecord).stations = stations.map((station) => ({
      station_id: station.station_id,
      num_bikes_available: 2,
      is_installed: 1,
      is_renting: 1,
      last_reported: 1700000000,
      vehicle_types_available: [
        { vehicle_type_id: "1", count: 1 },
        { vehicle_type_id: "2", count: 1 },
      ],
    }));
    const freeBikes = clone(fixture("free_bike_status.json"));
    (freeBikes.data as JsonRecord).bikes = [];

    const { body } = await handleRequestWithOptions(
      {
        overrides: {
          "station_information.json": stationInformation,
          "station_status.json": stationStatus,
          "free_bike_status.json": freeBikes,
        },
        routingResponse: {
          distances: [[500, 500, 500, 500, 500, 80]],
          durations: [[400, 400, 400, 400, 400, 60]],
        },
      },
      { type: "any" },
    );

    expect(body.selected).toMatchObject({
      name: "Mixed 6",
      distanceMeters: 80,
      distanceSource: "walking",
      walkingTimeSeconds: 60,
    });
  });

  it("rejects stale live data", async () => {
    const staleDependencies = {
      ...dependencies(),
      nowSeconds: () => NOW_SECONDS + 301,
    };
    const response = await handleRequest(
      nearestRequest({ type: "any" }),
      staleDependencies,
    );
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.selected).toBeNull();
    expect((body.feedFreshness as JsonRecord).stale).toBe(true);
  });

  it("keeps station results when optional free-bike data fails", async () => {
    const options = { failingFeed: "free_bike_status.json" };
    const { response, body } = await handleRequestWithOptions(options);

    expect(response.status).toBe(200);
    expect(body.selected).not.toBeNull();
    expect(body.selected).toMatchObject({ entityType: "station" });
  });

  it("speaks a provider outage when a required feed is malformed", async () => {
    const { response, body } = await handleRequestWithOptions({
      rawFeed: "station_status.json",
    });

    expect(response.status).toBe(200);
    expect(body.selected).toBeNull();
    expect(body.mapPreviewUrl).toBeNull();
    expect(body.error).toBe("provider_unavailable");
    expect(body.spokenMessage).toContain("temporarily unavailable");
  });

  it("speaks a provider outage when a required feed fails", async () => {
    const { response, body } = await handleRequestWithOptions({
      failingFeed: "station_status.json",
    });

    expect(response.status).toBe(200);
    expect(body.selected).toBeNull();
    expect(body.spokenMessage).toContain("temporarily unavailable");
  });

  it("returns 400 for invalid coordinates and type", async () => {
    const response = await handleRequest(
      nearestRequest({ lat: 91, lon: -122, type: "scooter" }),
      dependencies(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_latitude",
      message: "lat must be a number from -90 to 90.",
    });
  });

  it("rejects an invalid distance unit", async () => {
    const response = await handleRequest(
      nearestRequest({ type: "any", units: "feet" }),
      dependencies(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_units",
      message: "units must be imperial or metric.",
    });
  });

  it("rejects an invalid map provider", async () => {
    const response = await handleRequest(
      nearestRequest({ type: "any", maps: "bing" }),
      dependencies(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_maps",
      message: "maps must be apple or google.",
    });
  });

  it("speaks a retry message when the rate limiter denies the request", async () => {
    const response = await handleRequest(
      nearestRequest({ lat: 91, type: "any" }),
      dependencies({
        rateLimiter: {
          async limit() {
            return { success: false };
          },
        },
      }),
    );
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(body.selected).toBeNull();
    expect(body.mapPreviewUrl).toBeNull();
    expect(body.error).toBe("rate_limited");
    expect(body.spokenMessage).toContain("Try again in a minute");
  });

  it("keeps a successful path when the rate limiter allows the request", async () => {
    const { response, body } = await handleRequestWithOptions({
      rateLimiter: {
        async limit() {
          return { success: true };
        },
      },
    });

    expect(response.status).toBe(200);
    expect(body.selected).not.toBeNull();
  });

  it("returns a Bay Area message without fetching feeds for an out-of-area point", async () => {
    const { response, body } = await handleRequestWithOptions(
      { failingFeed: "station_status.json" },
      { lat: 40.71, lon: -74.01, type: "any" },
    );

    expect(response.status).toBe(200);
    expect(body.selected).toBeNull();
    expect(body.mapPreviewUrl).toBeNull();
    expect(body.spokenMessage).toContain("San Francisco Bay Area");
    expect(body.approximationNote).toContain("San Francisco Bay Area");
    expect((body.feedFreshness as JsonRecord).feeds).toEqual([]);
    expect((body.feedFreshness as JsonRecord).lastUpdated).not.toContain(
      "1970-01-01",
    );
  });

  it("serves a landing page with the Shortcut share link", async () => {
    const shareUrl = "https://www.icloud.com/shortcuts/abc123";
    const response = await handleRequest(
      new Request("https://worker.test/"),
      dependencies({ shortcutShareUrl: shareUrl }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Nearest Bikeshare");
    expect(html).toContain(shareUrl);
    expect(html).toContain("does not keep a location database");
  });

  it("accepts an iCloud share URL with a trailing slash or query string", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/"),
      dependencies({
        shortcutShareUrl: "https://icloud.com/shortcuts/abc123/?foo=1",
      }),
    );
    const html = await response.text();

    expect(html).toContain("https://www.icloud.com/shortcuts/abc123");
    expect(html).toContain('href="https://www.icloud.com/shortcuts/abc123"');
    expect(html).toContain("Add Shortcut");
    expect(html).not.toContain("foo=1");
  });

  it("sends cacheable HTML headers on the landing page", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/"),
      dependencies(),
    );

    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("shows a config error when the Shortcut share URL is invalid", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/"),
      dependencies({ shortcutShareUrl: "https://example.com/nope" }),
    );
    const html = await response.text();

    expect(html).toContain("The Shortcut link is not configured correctly.");
    expect(html).not.toContain("Add Shortcut");
    expect(html).not.toContain("icloud.com/shortcuts");
  });

  it("includes the required public copy and no script", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/"),
      dependencies(),
    );
    const html = await response.text();

    expect(html).toContain("Bay Wheels");
    expect(html).toContain("San Francisco Bay Area");
    expect(html).toContain("There is no account.");
    expect(html).toContain(
      "The Worker uses your current location to find a nearby bike.",
    );
    expect(html).not.toContain("<script");
  });

  it("omits the add link when no Shortcut share URL is set", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/"),
      dependencies(),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Nearest Bikeshare");
    expect(html).not.toContain("Add Shortcut");
    expect(html).not.toContain("icloud.com/shortcuts");
  });

  it("tells an old GET Shortcut to update", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/nearest?lat=37.76&lon=-122.42"),
      dependencies(),
    );
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(200);
    expect(body.selected).toBeNull();
    expect(body.mapPreviewUrl).toBeNull();
    expect(body.spokenMessage).toContain("out of date");
  });

  it("rejects a non-POST lookup", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/nearest", { method: "PUT" }),
      dependencies(),
    );

    expect(response.status).toBe(405);
  });

  it("skips walking routes when the request limiter throws", async () => {
    const { body } = await handleRequestWithOptions({
      routingResponse: fixture("openrouteservice_matrix.json"),
      rateLimiter: {
        async limit() {
          throw new Error("limiter unavailable");
        },
      },
    });

    expect(body.distanceSource).toBe("straight_line");
    expect(body.routingProvider).toBeNull();
    expect(body.selected).not.toBeNull();
  });

  it("skips walking routes when the routing budget is spent", async () => {
    const { body } = await handleRequestWithOptions({
      routingResponse: fixture("openrouteservice_matrix.json"),
      routingRateLimiter: {
        async limit() {
          return { success: false };
        },
      },
    });

    expect(body.distanceSource).toBe("straight_line");
    expect(body.routingProvider).toBeNull();
    expect(body.selected).not.toBeNull();
  });

  it("sends security headers on HTML and JSON", async () => {
    const page = await handleRequest(
      new Request("https://worker.test/"),
      dependencies(),
    );
    const json = await handleRequest(nearestRequest(), dependencies());

    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(json.headers.get("x-content-type-options")).toBe("nosniff");
    expect(json.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });

  it("returns 404 for an unknown path", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/shortcut"),
      dependencies(),
    );

    expect(response.status).toBe(404);
  });
});

async function handleRequestWithOptions(
  options: FixtureOptions,
  fields: Record<string, unknown> = {},
) {
  const response = await handleRequest(
    nearestRequest({ type: "electric", ...fields }),
    {
      ...dependencies(options),
    },
  );
  return { response, body: (await response.clone().json()) as JsonRecord };
}

async function handleRequestWithOverrides(
  overrides: Record<string, unknown>,
  fields: Record<string, unknown> = {},
) {
  const response = await handleRequest(
    nearestRequest({ type: "any", ...fields }),
    dependencies({ overrides }),
  );
  return { response, body: (await response.clone().json()) as JsonRecord };
}

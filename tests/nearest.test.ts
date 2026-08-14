import { readFileSync } from "node:fs";
import { formatDistance, handleRequest } from "../src/index";
import type { CacheLike, JsonRecord } from "../src/types";

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
}

function dependencies(options: FixtureOptions = {}) {
  const cache = new TestCache();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
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
  };
}

async function responseJson(
  requestUrl = "https://worker.test/nearest?lat=37.76&lon=-122.42&type=electric",
) {
  const response = await handleRequest(new Request(requestUrl), dependencies());
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
    expect(body.providerRentalUrl).toContain(
      "example.test/rent/station-electric",
    );
    expect(body.appleMapsPreviewUrl).toContain("maps.apple.com");
    expect(body.googleMapsPreviewUrl).toContain("google.com/maps");
    expect(body.approximate).toBe(true);
    expect((body.topCandidates as unknown[]).length).toBe(5);
  });

  it("uses metric units and switches to kilometers over one thousand meters", async () => {
    const { body } = await responseJson(
      "https://worker.test/nearest?lat=37.78&lon=-122.42&type=any&units=metric",
    );

    expect(body.units).toBe("metric");
    expect(body.spokenMessage).toContain("kilometers");
    expect(body.spokenMessage).not.toContain("feet");
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
      "https://worker.test/nearest?lat=37.7605&lon=-122.42&type=electric",
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
      "https://worker.test/nearest?lat=37.759&lon=-122.42&type=classic",
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
      "https://worker.test/nearest?lat=37.7605&lon=-122.42&type=electric",
    );

    expect(body.name).toBe("Available e-bike");
    expect(body.spokenMessage).toContain("ee bike");
    expect(body.spokenMessage).not.toContain("e-bike");
    expect(body.spokenMessage).not.toContain("at Available");
  });

  it("uses type-specific counts for a mixed station", async () => {
    const { body } = await responseJson(
      "https://worker.test/nearest?lat=37.761&lon=-122.421&type=electric",
    );
    const mixedCandidate = (body.topCandidates as JsonRecord[]).find(
      (candidate) => candidate.name === "Mixed Station",
    );

    expect(mixedCandidate).toMatchObject({
      bikeType: "electric",
      availableCount: 1,
    });
  });

  it("filters reserved and disabled bikes and avoids docked duplicates", async () => {
    const { body } = await responseJson(
      "https://worker.test/nearest?lat=37.76&lon=-122.42&type=any",
    );
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
    expect(body.message).toContain("No available bikes");
    expect(body.spokenMessage).toContain("No available bikes");
  });

  it("rejects stale live data", async () => {
    const staleDependencies = {
      ...dependencies(),
      nowSeconds: () => NOW_SECONDS + 301,
    };
    const response = await handleRequest(
      new Request("https://worker.test/nearest?lat=37.76&lon=-122.42&type=any"),
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

  it("returns 503 for a malformed required feed", async () => {
    const { response } = await handleRequestWithOptions({
      rawFeed: "station_status.json",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "provider_unavailable",
      message: "Bay Wheels data is temporarily unavailable.",
    });
  });

  it("returns 503 when a required provider feed fails", async () => {
    const { response } = await handleRequestWithOptions({
      failingFeed: "station_status.json",
    });

    expect(response.status).toBe(503);
  });

  it("returns 400 for invalid coordinates and type", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/nearest?lat=91&lon=-122&type=scooter"),
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
      new Request(
        "https://worker.test/nearest?lat=37.76&lon=-122.42&type=any&units=feet",
      ),
      dependencies(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_units",
      message: "units must be imperial or metric.",
    });
  });
});

async function handleRequestWithOptions(options: FixtureOptions) {
  const response = await handleRequest(
    new Request(
      "https://worker.test/nearest?lat=37.76&lon=-122.42&type=electric",
    ),
    { ...dependencies(options) },
  );
  return { response, body: (await response.clone().json()) as JsonRecord };
}

async function handleRequestWithOverrides(
  overrides: Record<string, unknown>,
  requestUrl = "https://worker.test/nearest?lat=37.76&lon=-122.42&type=any",
) {
  const response = await handleRequest(
    new Request(requestUrl),
    dependencies({ overrides }),
  );
  return { response, body: (await response.clone().json()) as JsonRecord };
}

import type {
  BikeType,
  Candidate,
  CandidateResponse,
  FeedFreshness,
  FeedSource,
  GbfsSnapshot,
  Query,
  RequestedBikeType,
} from "./types";
import { isStale } from "./gbfs";

const EARTH_RADIUS_METERS = 6_371_000;

export function haversineDistanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function rentalUrl(
  rentalUris: { ios?: string; web?: string } | undefined,
): string | null {
  return rentalUris?.ios ?? rentalUris?.web ?? null;
}

function mapsWalkingUrl(latitude: number, longitude: number): string {
  const url = new URL("https://maps.apple.com/");
  url.searchParams.set("daddr", `${latitude},${longitude}`);
  url.searchParams.set("dirflg", "w");
  return url.toString();
}

function appleMapsPreviewUrl(
  latitude: number,
  longitude: number,
  name: string,
): string {
  const url = new URL("https://maps.apple.com/");
  url.searchParams.set("ll", `${latitude},${longitude}`);
  url.searchParams.set("q", name);
  return url.toString();
}

function googleMapsPreviewUrl(latitude: number, longitude: number): string {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", `${latitude},${longitude}`);
  return url.toString();
}

function googleMapsWalkingUrl(latitude: number, longitude: number): string {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${latitude},${longitude}`);
  url.searchParams.set("travelmode", "walking");
  return url.toString();
}

function freshnessAgeSeconds(
  source: FeedSource,
  itemTimestamp: number | undefined,
  nowSeconds: number,
): number {
  const feedAge = Math.max(0, nowSeconds - source.lastUpdated);
  const itemAge =
    itemTimestamp === undefined ? 0 : Math.max(0, nowSeconds - itemTimestamp);
  return Math.max(feedAge, itemAge);
}

function freshnessPenaltyMeters(
  ageSeconds: number,
  ttlSeconds: number,
): number {
  return Math.max(0, ageSeconds - ttlSeconds) * 2;
}

function candidate(
  query: Query,
  source: FeedSource,
  id: string,
  entityType: Candidate["entityType"],
  name: string,
  latitude: number,
  longitude: number,
  bikeType: BikeType,
  availableCount: number,
  rentalUris: { ios?: string; web?: string } | undefined,
  itemTimestamp: number | undefined,
  nowSeconds: number,
): Candidate {
  const ageSeconds = freshnessAgeSeconds(source, itemTimestamp, nowSeconds);
  return {
    id,
    entityType,
    name,
    latitude,
    longitude,
    bikeType,
    availableCount,
    distanceMeters: haversineDistanceMeters(
      query.latitude,
      query.longitude,
      latitude,
      longitude,
    ),
    distanceSource: "straight_line",
    walkingTimeSeconds: null,
    providerRentalUrl: rentalUrl(rentalUris),
    appleMapsPreviewUrl: appleMapsPreviewUrl(latitude, longitude, name),
    appleMapsWalkingUrl: mapsWalkingUrl(latitude, longitude),
    googleMapsPreviewUrl: googleMapsPreviewUrl(latitude, longitude),
    googleMapsWalkingUrl: googleMapsWalkingUrl(latitude, longitude),
    freshnessAgeSeconds: ageSeconds,
    freshnessPenaltyMeters: freshnessPenaltyMeters(ageSeconds, source.ttl),
  };
}

function sourceByName(
  sources: FeedSource[],
  name: string,
): FeedSource | undefined {
  return sources.find((source) => source.name === name);
}

export function buildCandidates(
  query: Query,
  snapshot: GbfsSnapshot,
  nowSeconds: number,
  staleAfterSeconds: number,
): Candidate[] {
  const stationInfoById = new Map(
    snapshot.stationInformation.map((station) => [station.stationId, station]),
  );
  const vehicleTypeById = new Map(
    snapshot.vehicleTypes.map((vehicleType) => [
      vehicleType.vehicleTypeId,
      vehicleType.bikeType,
    ]),
  );
  const stationSource = sourceByName(snapshot.sources, "station_status");
  const bikeSource = sourceByName(snapshot.sources, "free_bike_status");
  const hasVehicleTypeFeed =
    sourceByName(snapshot.sources, "vehicle_types") !== undefined;
  if (!stationSource) return [];

  const stationCandidates = snapshot.stationStatus.flatMap((status) => {
    const station = stationInfoById.get(status.stationId);
    if (
      !station ||
      !status.isInstalled ||
      !status.isRenting ||
      status.availableCount === 0
    )
      return [];
    if (
      isStale(status.lastReported, nowSeconds, staleAfterSeconds) ||
      isStale(stationSource.lastUpdated, nowSeconds, staleAfterSeconds)
    )
      return [];

    if (status.availabilityByType && status.availabilityByType.length > 0) {
      const countsByBikeType = new Map<BikeType, number>();
      for (const availability of status.availabilityByType) {
        const bikeType = vehicleTypeById.get(availability.vehicleTypeId);
        if (bikeType && availability.count > 0) {
          countsByBikeType.set(
            bikeType,
            (countsByBikeType.get(bikeType) ?? 0) + availability.count,
          );
        }
      }
      return [...countsByBikeType.entries()].map(([bikeType, availableCount]) =>
        candidate(
          query,
          stationSource,
          `${status.stationId}:${bikeType}`,
          "station",
          station.name,
          station.latitude,
          station.longitude,
          bikeType,
          availableCount,
          station.rentalUris,
          status.lastReported,
          nowSeconds,
        ),
      );
    }

    if (hasVehicleTypeFeed) return [];
    return [
      candidate(
        query,
        stationSource,
        status.stationId,
        "station",
        station.name,
        station.latitude,
        station.longitude,
        "classic",
        status.availableCount,
        station.rentalUris,
        status.lastReported,
        nowSeconds,
      ),
    ];
  });

  const freeBikeCandidates = bikeSource
    ? snapshot.freeBikes.flatMap((bike) => {
        if (bike.stationId || bike.isReserved || bike.isDisabled) return [];
        if (bike.latitude === undefined || bike.longitude === undefined)
          return [];
        if (
          isStale(bike.lastReported, nowSeconds, staleAfterSeconds) ||
          isStale(bikeSource.lastUpdated, nowSeconds, staleAfterSeconds)
        )
          return [];
        const bikeType = bike.vehicleTypeId
          ? vehicleTypeById.get(bike.vehicleTypeId)
          : hasVehicleTypeFeed
            ? undefined
            : "classic";
        if (!bikeType) return [];
        return [
          candidate(
            query,
            bikeSource,
            bike.bikeId,
            "bike",
            bikeType === "electric"
              ? "Available e-bike"
              : "Available classic bike",
            bike.latitude,
            bike.longitude,
            bikeType,
            1,
            bike.rentalUris,
            bike.lastReported,
            nowSeconds,
          ),
        ];
      })
    : [];

  return [...stationCandidates, ...freeBikeCandidates];
}

function requestedTypeRank(
  requestedType: RequestedBikeType,
  bikeType: BikeType,
): number {
  return requestedType === "any" || requestedType === bikeType ? 0 : 1;
}

export function rankCandidates(
  candidates: Candidate[],
  requestedType: RequestedBikeType,
): Candidate[] {
  return [...candidates].sort((left, right) => {
    const typeDifference =
      requestedTypeRank(requestedType, left.bikeType) -
      requestedTypeRank(requestedType, right.bikeType);
    if (typeDifference !== 0) return typeDifference;

    const leftEffectiveDistance =
      left.distanceMeters + left.freshnessPenaltyMeters;
    const rightEffectiveDistance =
      right.distanceMeters + right.freshnessPenaltyMeters;
    const distanceDifference = leftEffectiveDistance - rightEffectiveDistance;
    if (Math.abs(distanceDifference) > 0.001) return distanceDifference;

    const rawDistanceDifference = left.distanceMeters - right.distanceMeters;
    if (Math.abs(rawDistanceDifference) > 0.001) return rawDistanceDifference;

    const availabilityDifference =
      (left.availableCount > 1 ? 0 : 1) - (right.availableCount > 1 ? 0 : 1);
    if (availabilityDifference !== 0) return availabilityDifference;
    return `${left.entityType}:${left.id}`.localeCompare(
      `${right.entityType}:${right.id}`,
    );
  });
}

export function toCandidateResponse(candidate: Candidate): CandidateResponse {
  return {
    id: candidate.id,
    entityType: candidate.entityType,
    name: candidate.name,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    bikeType: candidate.bikeType,
    availableCount: candidate.availableCount,
    distanceMeters: Math.round(candidate.distanceMeters),
    distanceSource: candidate.distanceSource,
    walkingTimeSeconds: candidate.walkingTimeSeconds,
    providerRentalUrl: candidate.providerRentalUrl,
    appleMapsPreviewUrl: candidate.appleMapsPreviewUrl,
    appleMapsWalkingUrl: candidate.appleMapsWalkingUrl,
    googleMapsPreviewUrl: candidate.googleMapsPreviewUrl,
    googleMapsWalkingUrl: candidate.googleMapsWalkingUrl,
  };
}

export function aggregateFreshness(
  sources: FeedSource[],
  nowSeconds: number,
  staleAfterSeconds: number,
): FeedFreshness {
  const liveSources = sources.filter(
    (source) =>
      source.name === "station_status" || source.name === "free_bike_status",
  );
  const relevantSources = liveSources.length > 0 ? liveSources : sources;
  const oldest = relevantSources.reduce((oldestSource, source) =>
    source.lastUpdated < oldestSource.lastUpdated ? source : oldestSource,
  );
  const ageSeconds = Math.max(0, nowSeconds - oldest.lastUpdated);
  return {
    lastUpdated: new Date(oldest.lastUpdated * 1000).toISOString(),
    ageSeconds,
    ttlSeconds: oldest.ttl,
    stale: ageSeconds > staleAfterSeconds,
    feeds: relevantSources.map((source) => source.name),
  };
}

export function confidenceFor(
  candidate: Candidate | undefined,
  requestedType: RequestedBikeType,
): "high" | "medium" | "low" {
  if (!candidate) return "low";
  const exactType =
    requestedType === "any" || candidate.bikeType === requestedType;
  if (
    exactType &&
    candidate.availableCount > 1 &&
    candidate.freshnessPenaltyMeters === 0
  )
    return "high";
  if (exactType) return "medium";
  return "low";
}

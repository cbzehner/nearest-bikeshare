export type RequestedBikeType = "electric" | "classic" | "any";
export type DistanceUnits = "imperial" | "metric";
export type BikeType = Exclude<RequestedBikeType, "any">;
export type EntityType = "station" | "bike";
export type Confidence = "high" | "medium" | "low";
export type MapProvider = "apple" | "google";
export type DistanceSource = "walking" | "straight_line";

export type JsonRecord = Record<string, unknown>;

export interface FeedMeta {
  lastUpdated: number;
  ttl: number;
  version: string;
}

export interface RentalUris {
  ios?: string;
  web?: string;
}

export interface StationInformation {
  stationId: string;
  name: string;
  latitude: number;
  longitude: number;
  rentalUris?: RentalUris;
}

export interface StationAvailabilityByType {
  vehicleTypeId: string;
  count: number;
}

export interface StationStatus {
  stationId: string;
  availableCount: number;
  isInstalled: boolean;
  isRenting: boolean;
  lastReported?: number;
  availabilityByType?: StationAvailabilityByType[];
}

export interface VehicleType {
  vehicleTypeId: string;
  bikeType: BikeType;
}

export interface FreeBike {
  bikeId: string;
  latitude?: number;
  longitude?: number;
  isReserved: boolean;
  isDisabled: boolean;
  vehicleTypeId?: string;
  stationId?: string;
  lastReported?: number;
  rentalUris?: RentalUris;
}

export interface FeedSource {
  name: string;
  lastUpdated: number;
  ttl: number;
  fromCache: boolean;
}

export interface GbfsSnapshot {
  stationInformation: StationInformation[];
  stationStatus: StationStatus[];
  vehicleTypes: VehicleType[];
  freeBikes: FreeBike[];
  sources: FeedSource[];
}

export interface Query {
  latitude: number;
  longitude: number;
  requestedType: RequestedBikeType;
  units: DistanceUnits;
  mapProvider: MapProvider;
}

export interface Candidate {
  id: string;
  entityType: EntityType;
  name: string;
  latitude: number;
  longitude: number;
  bikeType: BikeType;
  availableCount: number;
  distanceMeters: number;
  distanceSource: DistanceSource;
  walkingTimeSeconds: number | null;
  providerRentalUrl: string | null;
  appleMapsPreviewUrl: string;
  appleMapsWalkingUrl: string;
  googleMapsPreviewUrl: string;
  googleMapsWalkingUrl: string;
  freshnessAgeSeconds: number;
  freshnessPenaltyMeters: number;
}

export interface CandidateResponse {
  id: string;
  entityType: EntityType;
  name: string;
  latitude: number;
  longitude: number;
  bikeType: BikeType;
  availableCount: number;
  distanceMeters: number;
  distanceSource: DistanceSource;
  walkingTimeSeconds: number | null;
  providerRentalUrl: string | null;
  appleMapsPreviewUrl: string;
  appleMapsWalkingUrl: string;
  googleMapsPreviewUrl: string;
  googleMapsWalkingUrl: string;
}

export interface FeedFreshness {
  lastUpdated: string;
  ageSeconds: number;
  ttlSeconds: number;
  stale: boolean;
  feeds: string[];
}

export interface NearestResponse {
  selected: CandidateResponse | null;
  spokenMessage: string;
  units: DistanceUnits;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  bikeType: BikeType | null;
  availableCount: number | null;
  distanceMeters: number | null;
  distanceSource: DistanceSource | null;
  walkingTimeSeconds: number | null;
  providerRentalUrl: string | null;
  mapProvider: MapProvider;
  mapPreviewUrl: string | null;
  mapWalkingUrl: string | null;
  routingProvider: "openrouteservice" | null;
  appleMapsPreviewUrl: string | null;
  appleMapsWalkingUrl: string | null;
  googleMapsPreviewUrl: string | null;
  googleMapsWalkingUrl: string | null;
  feedFreshness: FeedFreshness;
  confidence: Confidence;
  approximate: boolean;
  approximationNote: string;
  requestedType: RequestedBikeType;
  topCandidates: CandidateResponse[];
}

export interface ErrorResponse {
  error: string;
  message: string;
}

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface AppDependencies {
  fetchImpl: typeof fetch;
  cache?: CacheLike;
  nowSeconds?: () => number;
  discoveryUrl?: string;
  staleAfterSeconds?: number;
  openRouteServiceApiKey?: string;
}

export interface Env {
  GBFS_DISCOVERY_URL?: string;
  OPENROUTESERVICE_API_KEY?: string;
}

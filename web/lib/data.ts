import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Point, Polygon } from "geojson";
import { toMinutes } from "./time";

export type Corners = [[number, number], [number, number], [number, number], [number, number]];

export interface Weather {
  time: string;
  temp_c: number;
  rh: number;
  wind_kmh: number;
  wind_from: number;
  gust_kmh: number;
  rain_mm: number;
  cloud: number;
}

export interface Incident {
  meta: {
    name: string;
    id: string;
    location: string;
    start: string;
    end: string;
    first_reported: string;
    area_ha: number;
    cause: string;
    status: string;
    reported_areas: { source: string; date: string; ha: number }[];
  };
  places: { name: string; lat: number; lon: number }[];
  events: { time: string; kind: string; title: string; source: string }[];
  weather: Weather[];
  sentinel: {
    final_area_ha: number;
    severity_ha: Record<string, number>;
    progression: { date: string; seen_burned_ha: number; clear_pct: number }[];
    pre_date: string;
    overlays: { burn_severity: Corners; s2_falsecolour: Corners };
  };
  fuels: { code: number; name: string; base_ros: number; colour: [number, number, number] }[];
  fuels_corners: Corners;
  hotspots: { count: number; first: string | null; available: boolean };
  sim: {
    params: Record<string, number>;
    score: number;
    score_detail: Record<string, number>;
    constraints: [string, number][];
    ignitions: { lat: number; lon: number; t: string }[];
    ignition_basis: string;
    model_only?: { score: number; detail: Record<string, number> };
    assimilated?: { score: number; detail: Record<string, number>; detections: number } | null;
    uses_assimilation?: boolean;
    final_ha: number;
    series: { t: string; burned_ha: number; growth_ha_h: number }[];
    path: { t: string; lat: number; lon: number; ha: number }[];
    arrival_corners: Corners;
  };
}

export interface Drone {
  id: string;
  name: string;
  aircraft: string;
  mission: string;
  task: string;
  sensor: string;
  agl: number;
  speed_kmh: number;
  radius?: number;
}

export interface DroneData {
  step_min: number;
  start: string;
  deploy: [string, string];
  fleet: Drone[];
  /** [minute, lon, lat, alt_m, heading] */
  tracks: Record<string, [number, number, number, number, number][]>;
}

export type BandProps = { h: number; t: string; ha: number };
export type HotspotProps = {
  t: string;
  m: number;
  sensor: string;
  product: string;
  frp: number;
  conf: string;
  bt_k: number;
  pixel_m: number;
  day: boolean;
  this_fire: boolean;
};
export type ObservedProps = { kind: "seen_burned_by" | "final_perimeter"; date?: string; area_ha: number; clear_pct?: number; m?: number };

export interface FireData {
  incident: Incident;
  bands: FeatureCollection<Polygon | MultiPolygon, BandProps>;
  isochrones: FeatureCollection<LineString | MultiLineString, { h: number; t: string; label?: string }>;
  observed: FeatureCollection<Polygon | MultiPolygon, ObservedProps>;
  hotspots: FeatureCollection<Point, HotspotProps>;
  drones: DroneData;
}

const S2_OVERPASS = "10:40";

async function get<T>(name: string): Promise<T | null> {
  const r = await fetch(`/data/${name}`);
  return r.ok ? ((await r.json()) as T) : null;
}

/** Load every data product and add replay minutes ("m") to time-stamped features. */
export async function loadFireData(): Promise<FireData> {
  const [incident, bands, isochrones, observed, hotspots, drones] = await Promise.all([
    get<Incident>("incident.json"),
    get<FireData["bands"]>("sim_bands.geojson"),
    get<FireData["isochrones"]>("sim_isochrones.geojson"),
    get<FireData["observed"]>("observed_perimeters.geojson"),
    get<FireData["hotspots"]>("hotspots.geojson"),
    get<DroneData>("drones.json"),
  ]);
  if (!incident || !bands || !isochrones || !observed || !drones) {
    throw new Error("Data missing: run `uv run python build.py` in pipeline/");
  }
  const start = incident.meta.start;
  for (const f of observed.features) {
    if (f.properties.date) f.properties.m = toMinutes(`${f.properties.date}T${S2_OVERPASS}`, start);
  }
  const hs = hotspots ?? { type: "FeatureCollection", features: [] };
  for (const f of hs.features) f.properties.m = toMinutes(f.properties.t, start);
  return { incident, bands, isochrones, observed, hotspots: hs as FireData["hotspots"], drones };
}

export function weatherAt(incident: Incident, minutes: number): Weather | undefined {
  const i = Math.min(Math.max(Math.floor(minutes / 60), 0), incident.weather.length - 1);
  return incident.weather[i];
}

export function burnedAt(incident: Incident, minutes: number): number {
  const s = incident.sim.series;
  const i = Math.min(Math.max(Math.floor(minutes / 60), 0), s.length - 1);
  return s[i]?.burned_ha ?? 0;
}

export type { Feature };

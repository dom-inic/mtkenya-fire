import type { MultiPolygon, Polygon } from "geojson";
import type { Drone, FireData } from "./data";

export interface DroneState {
  lon: number;
  lat: number;
  alt: number;
  heading: number;
  speedKmh: number;
  battery: number;
  airborne: boolean;
  flightMin: number;
}

/** Endurance per airframe; batteries are swapped at the launch point. */
const ENDURANCE_MIN: Record<string, number> = { "Fixed-wing VTOL": 90, "Fixed-wing": 120 };

export function droneState(data: FireData, drone: Drone, minute: number): DroneState | null {
  const track = data.drones.tracks[drone.id];
  if (!track?.length || minute < track[0][0] || minute > track[track.length - 1][0]) return null;
  const step = data.drones.step_min;
  const i = Math.min(Math.floor((minute - track[0][0]) / step), track.length - 2);
  const a = track[i];
  const b = track[i + 1] ?? a;
  const f = Math.min(Math.max((minute - a[0]) / step, 0), 1);
  const endurance = ENDURANCE_MIN[drone.aircraft] ?? 40;
  // Stagger battery swaps across the fleet so they don't all land at once
  const stagger = (Number(drone.id.slice(-2)) * 13) % endurance;
  const flightMin = (minute - track[0][0] + stagger) % endurance;
  return {
    lon: a[1] + (b[1] - a[1]) * f,
    lat: a[2] + (b[2] - a[2]) * f,
    alt: a[3] + (b[3] - a[3]) * f,
    heading: b[4],
    speedKmh: drone.speed_kmh,
    battery: Math.round(100 - (flightMin / endurance) * 78),
    airborne: true,
    flightMin,
  };
}

export interface Detection {
  droneId: string;
  lon: number;
  lat: number;
  tempC: number;
  distanceM: number;
}

const M_PER_DEG = 111_320;

function distM(lon1: number, lat1: number, lon2: number, lat2: number) {
  const dx = (lon2 - lon1) * M_PER_DEG * Math.cos((lat1 * Math.PI) / 180);
  const dy = (lat2 - lat1) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

/**
 * What a drone's thermal camera would pick up: the nearest point of ground
 * the model has burning right now (burned in the last 90 minutes) within
 * range. Fresher fire reads hotter.
 */
export function detect(data: FireData, droneId: string, s: DroneState, minute: number, rangeM = 900): Detection | null {
  const hour = minute / 60;
  let best: Detection | null = null;
  for (const f of data.bands.features) {
    const age = hour - f.properties.h;
    if (age < 0 || age > 1.5) continue;
    const g = f.geometry as Polygon | MultiPolygon;
    const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        const d = distM(s.lon, s.lat, lon, lat);
        if (d < rangeM && (!best || d < best.distanceM)) {
          best = { droneId, lon, lat, distanceM: Math.round(d), tempC: Math.round(980 - age * 380) };
        }
      }
    }
  }
  return best;
}

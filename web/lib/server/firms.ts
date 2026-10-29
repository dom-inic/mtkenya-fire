import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFirmsCsv, type Detection } from "../hotspots";

/** The whole Mount Kenya forest ring (same box as the 3D world). */
export const RING_BBOX = "36.95,-0.50,37.80,0.30";
const SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT", "MODIS_NRT"];
const TTL_MS = 10 * 60_000;

let cache: { at: number; days: number; detections: Detection[] } | null = null;

/** Near-real-time detections over the ring for the last `days` (1-5), cached for 10 minutes. */
export async function recentDetections(days = 2): Promise<{ checked: string; detections: Detection[]; error?: string }> {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return { checked: new Date().toISOString(), detections: [], error: "FIRMS_MAP_KEY is not set" };
  if (cache && cache.days === days && Date.now() - cache.at < TTL_MS) {
    return { checked: new Date(cache.at).toISOString(), detections: cache.detections };
  }
  const all: Detection[] = [];
  for (const src of SOURCES) {
    const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${src}/${RING_BBOX}/${days}`, { cache: "no-store" });
    if (!r.ok) return { checked: new Date().toISOString(), detections: [], error: `FIRMS ${src}: HTTP ${r.status}` };
    all.push(...parseFirmsCsv(await r.text(), src));
  }
  const seen = new Set<string>();
  const detections = all.filter((d) => {
    const k = `${d.lon},${d.lat},${d.t},${d.sensor}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  detections.sort((a, b) => a.t.localeCompare(b.t));
  cache = { at: Date.now(), days, detections };
  return { checked: new Date().toISOString(), detections };
}

/** Drill: the September 2026 detections, as they would have been seen by `now` (EAT). */
export async function drillDetections(now: string, hours = 48): Promise<Detection[]> {
  const file = path.join(process.cwd(), "public", "data", "hotspots.geojson");
  const fc = JSON.parse(await fs.readFile(file, "utf8")) as { features: { geometry: { coordinates: [number, number] }; properties: { t: string; sensor: string; frp: number; conf: Detection["conf"]; day: boolean } }[] };
  const from = new Date(Date.parse(`${now}Z`) - hours * 3600_000).toISOString().slice(0, 16);
  return fc.features
    .filter((f) => f.properties.t <= now && f.properties.t >= from)
    .map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], t: f.properties.t, sensor: f.properties.sensor, frp: f.properties.frp, conf: f.properties.conf, day: f.properties.day }));
}

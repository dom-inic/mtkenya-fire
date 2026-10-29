/**
 * Satellite hotspots for live mode: parsing NASA FIRMS, grouping detections
 * into incidents, and judging which ones matter.
 */

export interface Detection {
  lon: number;
  lat: number;
  t: string; // EAT, "YYYY-MM-DDTHH:MM"
  sensor: string;
  frp: number; // fire radiative power, MW
  conf: "low" | "nominal" | "high";
  day: boolean;
}

export interface Incident {
  id: string;
  detections: Detection[];
  first: string;
  last: string;
  lon: number;
  lat: number;
  maxFrp: number;
  priority: "high" | "low";
  setting: string;
  near: { name: string; km: number } | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** UTC date + "HHMM" from FIRMS to an EAT (UTC+3) timestamp string. */
function toEat(date: string, hhmm: string) {
  const d = new Date(`${date}T${hhmm.padStart(4, "0").slice(0, 2)}:${hhmm.padStart(4, "0").slice(2)}:00Z`);
  const e = new Date(d.getTime() + 3 * 3600_000);
  return `${e.getUTCFullYear()}-${pad(e.getUTCMonth() + 1)}-${pad(e.getUTCDate())}T${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())}`;
}

export function parseFirmsCsv(text: string, source: string): Detection[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2 || !lines[0].startsWith("latitude")) return [];
  const head = lines[0].split(",");
  const col = (name: string) => head.indexOf(name);
  const viirs = source.startsWith("VIIRS");
  return lines.slice(1).map((line) => {
    const v = line.split(",");
    const raw = v[col("confidence")];
    const conf = viirs ? ({ l: "low", n: "nominal", h: "high" } as const)[raw as "l" | "n" | "h"] ?? "nominal" : Number(raw) >= 80 ? "high" : Number(raw) >= 30 ? "nominal" : "low";
    return {
      lon: Number(v[col("longitude")]),
      lat: Number(v[col("latitude")]),
      t: toEat(v[col("acq_date")], v[col("acq_time")]),
      sensor: source.replace(/_NRT|_SP/, ""),
      frp: Number(v[col("frp")]),
      conf,
      day: v[col("daynight")] === "D",
    };
  });
}

export function minutesBetween(a: string, b: string) {
  return (Date.parse(`${b}Z`) - Date.parse(`${a}Z`)) / 60000;
}

const KM_PER_DEG = 111.32;
export function distKm(lon1: number, lat1: number, lon2: number, lat2: number) {
  return Math.hypot((lon2 - lon1) * KM_PER_DEG * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * KM_PER_DEG);
}

const FUEL_SETTING: Record<number, string> = {
  0: "rock / water",
  1: "alpine grassland",
  2: "heath moorland",
  3: "Erica heath forest",
  4: "montane & bamboo forest",
  5: "farmland",
  6: "grass & shrub below the forest",
};

/**
 * Group detections into incidents: within 1.5 km and 24 h of each other
 * (single linkage). High priority if any detection is in moorland or forest
 * fuels; fires in farmland are most likely crop or land-clearing burns.
 */
export function clusterIncidents(
  dets: Detection[],
  fuelAt: (lon: number, lat: number) => number,
  places: { name: string; lon: number; lat: number }[],
): Incident[] {
  const n = dets.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distKm(dets[i].lon, dets[i].lat, dets[j].lon, dets[j].lat) <= 1.5 && Math.abs(minutesBetween(dets[i].t, dets[j].t)) <= 24 * 60) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, Detection[]>();
  dets.forEach((d, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(d));
  return [...groups.values()]
    .map((ds) => {
      ds.sort((a, b) => a.t.localeCompare(b.t));
      const lon = ds.reduce((s, d) => s + d.lon, 0) / ds.length;
      const lat = ds.reduce((s, d) => s + d.lat, 0) / ds.length;
      const fuels = ds.map((d) => fuelAt(d.lon, d.lat));
      const wild = fuels.filter((f) => f >= 1 && f <= 4);
      const main = (wild.length ? wild : fuels).sort((a, b) => fuels.filter((f) => f === b).length - fuels.filter((f) => f === a).length)[0];
      let near: Incident["near"] = null;
      for (const p of places) {
        const km = distKm(lon, lat, p.lon, p.lat);
        if (!near || km < near.km) near = { name: p.name, km: Math.round(km * 10) / 10 };
      }
      return {
        id: `${ds[0].t}_${ds[0].lat.toFixed(3)}_${ds[0].lon.toFixed(3)}`,
        detections: ds,
        first: ds[0].t,
        last: ds[ds.length - 1].t,
        lon,
        lat,
        maxFrp: Math.max(...ds.map((d) => d.frp)),
        priority: wild.length ? ("high" as const) : ("low" as const),
        setting: FUEL_SETTING[main] ?? "unknown",
        near,
      };
    })
    .sort((a, b) => (a.priority === b.priority ? b.last.localeCompare(a.last) : a.priority === "high" ? -1 : 1));
}

/**
 * How well the last forecast did: of the detections made after it was issued,
 * how many fell where (and roughly when) it said the fire would be.
 */
export function forecastSkill(
  issued: string,
  newDets: Detection[],
  arrivalAt: (lon: number, lat: number) => number, // minutes after `issued`, Infinity if not reached
) {
  let hits = 0;
  let total = 0;
  for (const d of newDets) {
    const dt = minutesBetween(issued, d.t);
    if (dt <= 0) continue;
    total++;
    // Allow a pixel of slack: VIIRS pixels are 375 m
    if (arrivalAt(d.lon, d.lat) <= dt + 120) hits++;
  }
  return { hits, total };
}

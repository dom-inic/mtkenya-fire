/**
 * Fire-spread engine for what-if runs in the browser (a port of
 * pipeline/mkfire/simulate.py, same physics and calibrated parameters).
 *
 * Runs on a 60 m lon/lat grid around the ignition, built from the world
 * rasters. Arrival times come from a time-dependent Dijkstra search over 16
 * directions; rates change every hour with the weather. Also computes crew
 * travel times from staging points and a suggested control line.
 */

import type { BBox, Raster } from "./world";

export interface FireParams {
  k: number;
  wind_a: number;
  wind_mult: number;
  rh_ref: number;
  rh_scale: number;
  rain_mm: number;
  elev_scale: number;
}

export interface HourWeather {
  wind_kmh: number;
  wind_from: number;
  rh: number;
  rain_mm: number;
  temp_c?: number;
}

export interface EngineWorld {
  world: BBox;
  inner: BBox;
  heightsOuter: Raster<Float32Array>;
  heightsInner: Raster<Float32Array>;
  fuelOuter: Raster<Uint8Array>;
  fuelInner: Raster<Uint8Array>;
  baseRos: number[]; // m/min by fuel code
  roads: { kind: string; line: [number, number][] }[];
  lakes: [number, number][][];
}

export interface Scenario {
  ignition: { lon: number; lat: number };
  hours: number;
  weather: HourWeather[]; // hour 0 = ignition hour
  params: FireParams;
  breaks: [number, number][][]; // lon/lat polylines
  breakCells: [number, number][]; // single cells (lon/lat), e.g. an applied control line
  bases: { name: string; lon: number; lat: number }[];
  mobiliseMin: number;
  ensemble: boolean;
  sizeKm?: number;
}

export interface GridSpec {
  west: number;
  north: number;
  dLon: number;
  dLat: number;
  w: number;
  h: number;
  res: number;
}

export interface ControlLine {
  hour: number;
  lengthKm: number;
  feasiblePct: number;
  cells: [number, number, number][]; // lon, lat, 1 = crews get there first
}

export interface EngineResult {
  grid: GridSpec;
  arrival: Float32Array; // minutes after ignition, Infinity = not reached
  prob: Uint8Array | null; // 0-255 share of ensemble runs that burn the cell
  eta: Float32Array; // crew arrival minutes
  series: { hour: number; ha: number }[];
  firsts: { forest: number | null; bamboo: number | null };
  control: { initial: ControlLine | null; pinch: ControlLine | null };
  runs: number;
  ms: number;
}

const M_PER_DEG_LAT = 110_574;
const RES = 60;

// 16 directions: 8 neighbours plus knight moves for smoother fire shapes
const OFFSETS: [number, number][] = [
  [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
  [-2, 1], [-1, 2], [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1],
];
const AZ = OFFSETS.map(([dr, dc]) => Math.atan2(dc, -dr));
const AZ_DEG = AZ.map((a) => ((a * 180) / Math.PI + 360) % 360);
const STEP = OFFSETS.map(([dr, dc]) => Math.hypot(dr, dc));

function sample(r: Raster<ArrayLike<number>>, lon: number, lat: number) {
  const fx = ((lon - r.bbox.west) / (r.bbox.east - r.bbox.west)) * r.w - 0.5;
  const fy = ((r.bbox.north - lat) / (r.bbox.north - r.bbox.south)) * r.h - 0.5;
  const x0 = Math.min(Math.max(Math.floor(fx), 0), r.w - 2);
  const y0 = Math.min(Math.max(Math.floor(fy), 0), r.h - 2);
  const tx = Math.min(Math.max(fx - x0, 0), 1);
  const ty = Math.min(Math.max(fy - y0, 0), 1);
  const d = r.data;
  const i = y0 * r.w + x0;
  return (d[i] * (1 - tx) + d[i + 1] * tx) * (1 - ty) + (d[i + r.w] * (1 - tx) + d[i + r.w + 1] * tx) * ty;
}

function nearest(r: Raster<ArrayLike<number>>, lon: number, lat: number) {
  const x = Math.min(Math.max(Math.floor(((lon - r.bbox.west) / (r.bbox.east - r.bbox.west)) * r.w), 0), r.w - 1);
  const y = Math.min(Math.max(Math.floor(((r.bbox.north - lat) / (r.bbox.north - r.bbox.south)) * r.h), 0), r.h - 1);
  return r.data[y * r.w + x];
}

const within = (b: BBox, lon: number, lat: number) => lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;

/** Min-heap of (time, cell) in parallel typed arrays. */
class Heap {
  t = new Float64Array(1 << 16);
  v = new Int32Array(1 << 16);
  n = 0;
  push(t: number, v: number) {
    if (this.n === this.t.length) {
      const t2 = new Float64Array(this.n * 2);
      const v2 = new Int32Array(this.n * 2);
      t2.set(this.t);
      v2.set(this.v);
      this.t = t2;
      this.v = v2;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.t[p] <= t) break;
      this.t[i] = this.t[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.t[i] = t;
    this.v[i] = v;
  }
  pop(): number {
    const top = this.v[0];
    const lastT = this.t[--this.n];
    const lastV = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.t[c + 1] < this.t[c]) c++;
      if (this.t[c] >= lastT) break;
      this.t[i] = this.t[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.t[i] = lastT;
    this.v[i] = lastV;
    return top;
  }
  get topT() {
    return this.t[0];
  }
}

interface Terrain {
  g: GridSpec;
  fuel: Uint8Array;
  height: Float32Array;
  slope: Float32Array; // degrees
  upslope: Float32Array; // radians, azimuth of steepest ascent
  base: Float32Array; // m/min before wind/moisture
  water: Uint8Array;
  road: Float32Array; // km/h, 0 = no road
}

/** Supercover rasterisation: every cell a segment touches (4-connected). */
function traceSegment(g: GridSpec, a: [number, number], b: [number, number], mark: (i: number) => void) {
  const toXY = ([lon, lat]: [number, number]) => [(lon - g.west) / g.dLon, (g.north - lat) / g.dLat];
  const [x0, y0] = toXY(a);
  const [x1, y1] = toXY(b);
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
  let px = 0;
  let py = 0;
  for (let s = 0; s <= n; s++) {
    const x = Math.floor(x0 + ((x1 - x0) * s) / n);
    const y = Math.floor(y0 + ((y1 - y0) * s) / n);
    // Diagonal step: also fill the corner cell so the line stays 4-connected
    if (s > 0 && x !== px && y !== py && px >= 0 && px < g.w && y >= 0 && y < g.h) mark(y * g.w + px);
    if (x >= 0 && x < g.w && y >= 0 && y < g.h) mark(y * g.w + x);
    px = x;
    py = y;
  }
}

const ROAD_KMH: Record<string, number> = { trunk: 60, primary: 50, secondary: 40, tertiary: 35, unclassified: 25, track: 14, path: 4 };

function buildTerrain(w: EngineWorld, s: Scenario): Terrain {
  const sizeKm = s.sizeKm ?? 32;
  const mx = M_PER_DEG_LAT * 1.00336 * Math.cos((s.ignition.lat * Math.PI) / 180);
  const dLon = RES / mx;
  const dLat = RES / M_PER_DEG_LAT;
  const half = (sizeKm * 1000) / 2;
  let west = s.ignition.lon - half / mx;
  let north = s.ignition.lat + half / M_PER_DEG_LAT;
  west = Math.max(west, w.world.west);
  north = Math.min(north, w.world.north);
  const east = Math.min(s.ignition.lon + half / mx, w.world.east);
  const south = Math.max(s.ignition.lat - half / M_PER_DEG_LAT, w.world.south);
  const g: GridSpec = { west, north, dLon, dLat, w: Math.floor((east - west) / dLon), h: Math.floor((north - south) / dLat), res: RES };
  const n = g.w * g.h;
  const fuel = new Uint8Array(n);
  const height = new Float32Array(n);
  for (let y = 0; y < g.h; y++) {
    const lat = north - (y + 0.5) * dLat;
    for (let x = 0; x < g.w; x++) {
      const lon = west + (x + 0.5) * dLon;
      const i = y * g.w + x;
      const inner = within(w.inner, lon, lat);
      fuel[i] = nearest(inner ? w.fuelInner : w.fuelOuter, lon, lat);
      height[i] = sample(inner ? w.heightsInner : w.heightsOuter, lon, lat);
    }
  }
  const slope = new Float32Array(n);
  const upslope = new Float32Array(n);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const xl = Math.max(x - 1, 0);
      const xr = Math.min(x + 1, g.w - 1);
      const yu = Math.max(y - 1, 0);
      const yd = Math.min(y + 1, g.h - 1);
      const dzdx = (height[y * g.w + xr] - height[y * g.w + xl]) / ((xr - xl) * RES); // east
      const dzdy = (height[yd * g.w + x] - height[yu * g.w + x]) / ((yd - yu) * RES); // south
      const i = y * g.w + x;
      slope[i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      upslope[i] = Math.atan2(dzdx, -dzdy);
    }
  }
  const base = new Float32Array(n);
  const p = s.params;
  for (let i = 0; i < n; i++) {
    let b = w.baseRos[fuel[i]] ?? 0;
    if (p.elev_scale) b *= Math.exp(-Math.max(height[i] - 3200, 0) / p.elev_scale);
    base[i] = b;
  }

  // Lakes: no fire, no walking
  const water = new Uint8Array(n);
  for (const ring of w.lakes) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [lon, lat] of ring) {
      minX = Math.min(minX, (lon - west) / dLon);
      maxX = Math.max(maxX, (lon - west) / dLon);
      minY = Math.min(minY, (north - lat) / dLat);
      maxY = Math.max(maxY, (north - lat) / dLat);
    }
    if (maxX < 0 || maxY < 0 || minX > g.w || minY > g.h) continue;
    for (let y = Math.max(Math.floor(minY), 0); y <= Math.min(Math.ceil(maxY), g.h - 1); y++) {
      for (let x = Math.max(Math.floor(minX), 0); x <= Math.min(Math.ceil(maxX), g.w - 1); x++) {
        const lon = west + (x + 0.5) * dLon;
        const lat = north - (y + 0.5) * dLat;
        if (pointInRing(lon, lat, ring)) {
          water[y * g.w + x] = 1;
          base[y * g.w + x] = 0;
        }
      }
    }
  }

  // Firebreaks
  for (const line of s.breaks) for (let i = 1; i < line.length; i++) traceSegment(g, line[i - 1], line[i], (c) => (base[c] = 0));
  for (const [lon, lat] of s.breakCells) {
    const x = Math.floor((lon - west) / dLon);
    const y = Math.floor((north - lat) / dLat);
    if (x >= 0 && y >= 0 && x < g.w && y < g.h) base[y * g.w + x] = 0;
  }

  // Roads: fastest road through each cell
  const road = new Float32Array(n);
  for (const r of w.roads) {
    const kmh = ROAD_KMH[r.kind] ?? 0;
    if (!kmh) continue;
    for (let i = 1; i < r.line.length; i++) {
      traceSegment(g, r.line[i - 1], r.line[i], (c) => {
        if (road[c] < kmh) road[c] = kmh;
      });
    }
  }
  return { g, fuel, height, slope, upslope, base, water, road };
}

function pointInRing(x: number, y: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Everything in the rate of spread except fuel and slope, per hour and direction. */
function hourlyFactors(weather: HourWeather[], hours: number, p: FireParams, dirShift = 0, speedMult = 1) {
  const f: Float64Array[] = [];
  for (let h = 0; h < hours; h++) {
    const w = weather[Math.min(h, weather.length - 1)];
    const u = w.wind_kmh * p.wind_mult * speedMult;
    const to = (w.wind_from + dirShift + 180) % 360;
    const head = 1 + p.wind_a * Math.pow(u, 1.4);
    const lb = 1 + 8.729 * Math.pow(1 - Math.exp(-0.03 * u), 2.155);
    const e = Math.sqrt(1 - 1 / (lb * lb));
    const moist = w.rain_mm >= p.rain_mm ? 0 : Math.min(Math.max(Math.exp(-(w.rh - p.rh_ref) / p.rh_scale), 0.05), 2.5);
    const row = new Float64Array(16);
    for (let d = 0; d < 16; d++) row[d] = (p.k * head * (1 - e)) / (1 - e * Math.cos(((AZ_DEG[d] - to) * Math.PI) / 180)) * moist;
    f.push(row);
  }
  return f;
}

function spread(t: Terrain, s: Scenario, dirShift = 0, speedMult = 1): Float32Array {
  const { g, base, slope, upslope } = t;
  const hours = s.hours;
  const factors = hourlyFactors(s.weather, hours, s.params, dirShift, speedMult);
  // Cumulative spread potential per direction at hour boundaries
  const cum: Float64Array[] = [];
  for (let d = 0; d < 16; d++) {
    const row = new Float64Array(hours + 1);
    for (let h = 0; h < hours; h++) row[h + 1] = row[h] + factors[h][d] * 60;
    cum.push(row);
  }
  const tEnd = hours * 60;
  const arrive = (d: number, t0: number, need: number) => {
    const c = cum[d];
    const h0 = Math.min(Math.floor(t0 / 60), hours - 1);
    const target = c[h0] + factors[h0][d] * (t0 - 60 * h0) + need;
    if (target > c[hours]) return Infinity;
    let lo = h0;
    let hi = hours;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (c[m + 1] < target) lo = m + 1;
      else hi = m;
    }
    return 60 * lo + (target - c[lo]) / factors[lo][d];
  };

  const n = g.w * g.h;
  const arrival = new Float64Array(n).fill(Infinity);
  const heap = new Heap();
  const ix = Math.floor((s.ignition.lon - g.west) / g.dLon);
  const iy = Math.floor((g.north - s.ignition.lat) / g.dLat);
  if (ix < 0 || iy < 0 || ix >= g.w || iy >= g.h) return Float32Array.from(arrival);
  const start = iy * g.w + ix;
  arrival[start] = 0;
  heap.push(0, start);
  const exp = Math.exp;
  while (heap.n) {
    const tt = heap.topT;
    const i = heap.pop();
    if (tt > arrival[i] || tt > tEnd) continue;
    const r = (i / g.w) | 0;
    const c = i - r * g.w;
    for (let d = 0; d < 16; d++) {
      const dr = OFFSETS[d][0];
      const dc = OFFSETS[d][1];
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= g.h || nc >= g.w) continue;
      const j = nr * g.w + nc;
      const b = base[j];
      if (b === 0) continue;
      // Don't let diagonal or knight moves jump across a barrier
      if (d < 8 && dr !== 0 && dc !== 0) {
        if (base[r * g.w + nc] === 0 && base[nr * g.w + c] === 0) continue;
      } else if (d >= 8) {
        const sr = Math.sign(dr);
        const sc = Math.sign(dc);
        const m1 = Math.abs(dr) === 2 ? (r + sr) * g.w + c : r * g.w + c + sc;
        const m2 = Math.abs(dr) === 2 ? (r + sr) * g.w + c + dc : (r + dr) * g.w + c + sc;
        if (base[m1] === 0 || base[m2] === 0) continue;
      }
      const sDir = slope[j] * Math.cos(AZ[d] - upslope[j]);
      const rate = b * Math.min(Math.max(exp(0.0693 * sDir), 0.25), 8);
      const t1 = arrive(d, tt, (STEP[d] * g.res) / rate);
      if (t1 < arrival[j] && t1 <= tEnd) {
        arrival[j] = t1;
        heap.push(t1, j);
      }
    }
  }
  return Float32Array.from(arrival);
}

/**
 * Crew travel time (minutes) from staging points: drive on roads and tracks,
 * walk elsewhere (Tobler's hiking function, slower with altitude and in dense
 * vegetation), no crossing lakes.
 */
function crewTimes(t: Terrain, s: Scenario): Float32Array {
  const { g, road, water, height, fuel } = t;
  const n = g.w * g.h;
  // Float64 while searching: float32 rounding against float64 heap keys makes
  // Dijkstra re-expand settled cells over and over
  const eta = new Float64Array(n).fill(Infinity);
  const heap = new Heap();
  const seed = (i: number, m: number) => {
    if (m < eta[i]) {
      eta[i] = m;
      heap.push(m, i);
    }
  };
  for (const b of s.bases) {
    const x = Math.floor((b.lon - g.west) / g.dLon);
    const y = Math.floor((g.north - b.lat) / g.dLat);
    if (x >= 0 && y >= 0 && x < g.w && y < g.h) seed(y * g.w + x, s.mobiliseMin);
  }
  // Crews from outside the window come in on the main roads
  for (let x = 0; x < g.w; x++) {
    for (const y of [0, g.h - 1]) if (road[y * g.w + x] >= 25) seed(y * g.w + x, s.mobiliseMin + 60);
  }
  for (let y = 0; y < g.h; y++) {
    for (const x of [0, g.w - 1]) if (road[y * g.w + x] >= 25) seed(y * g.w + x, s.mobiliseMin + 60);
  }
  const vegFactor = [0.8, 0.9, 0.55, 0.45, 0.4, 0.9, 0.8];
  while (heap.n) {
    const tt = heap.topT;
    const i = heap.pop();
    if (tt > eta[i]) continue;
    const r = (i / g.w) | 0;
    const c = i - r * g.w;
    for (let d = 0; d < 8; d++) {
      const nr = r + OFFSETS[d][0];
      const nc = c + OFFSETS[d][1];
      if (nr < 0 || nc < 0 || nr >= g.h || nc >= g.w) continue;
      const j = nr * g.w + nc;
      if (water[j]) continue;
      const dist = STEP[d] * g.res;
      let kmh: number;
      if (road[i] && road[j]) kmh = Math.min(road[i], road[j]);
      else {
        const grade = (height[j] - height[i]) / dist;
        kmh = 6 * Math.exp(-3.5 * Math.abs(grade + 0.05)) * (vegFactor[fuel[j]] ?? 0.7) * (height[j] > 3000 ? 0.8 : 1);
      }
      const m = tt + dist / ((kmh * 1000) / 60);
      if (m < eta[j]) {
        eta[j] = m;
        heap.push(m, j);
      }
    }
  }
  return Float32Array.from(eta);
}

/**
 * Where a line would go at hour h: unburned cells next to the burned area
 * that the fire will cross within the next 12 hours (edges against lakes,
 * rock, slow forest or fuel it won't reach soon hold by themselves). A cell
 * is feasible if crews reach it with an hour to cut line before the fire.
 */
function activeEdge(t: Terrain, arrival: Float32Array, eta: Float32Array, h: number): ControlLine | null {
  const { g, base } = t;
  const now = h * 60;
  const soon = now + 12 * 60;
  const cells: [number, number, number][] = [];
  let ok = 0;
  for (let j = 0; j < arrival.length; j++) {
    const a = arrival[j];
    if (!(a > now && a <= soon) || base[j] === 0) continue;
    const r = (j / g.w) | 0;
    const c = j - r * g.w;
    let edge = false;
    for (let d = 0; d < 8 && !edge; d++) {
      const nr = r + OFFSETS[d][0];
      const nc = c + OFFSETS[d][1];
      if (nr >= 0 && nc >= 0 && nr < g.h && nc < g.w && arrival[nr * g.w + nc] <= now) edge = true;
    }
    if (!edge) continue;
    const feasible = eta[j] + 60 < a ? 1 : 0;
    ok += feasible;
    cells.push([g.west + (c + 0.5) * g.dLon, g.north - (r + 0.5) * g.dLat, feasible]);
  }
  if (cells.length < 4) return null;
  return { hour: h, lengthKm: (cells.length * g.res) / 1000, feasiblePct: Math.round((100 * ok) / cells.length), cells };
}

/**
 * Two suggested control lines along the fire's predicted active edge:
 *  - initial attack: the first hour crews can reach most (>= 80%) of the edge
 *  - pinch point: once the fire has outgrown initial attack, the shortest edge
 *    crews can mostly reach, where terrain and fuels squeeze the fire
 */
function controlLines(t: Terrain, arrival: Float32Array, eta: Float32Array, hours: number, series: { hour: number; ha: number }[]) {
  const edges: ControlLine[] = [];
  for (let h = 1; h < hours; h++) {
    const e = activeEdge(t, arrival, eta, h);
    if (e) edges.push(e);
  }
  const initial = edges.find((e) => e.feasiblePct >= 80) ?? null;
  // The pinch point is the fallback if initial attack fails: only once the fire has grown
  const grownHa = Math.max(50, 3 * (initial ? series[initial.hour].ha : 0));
  const later = edges.filter((e) => e.hour >= 6 && series[e.hour].ha >= grownHa && e.feasiblePct >= 60);
  const pinch = later.reduce<ControlLine | null>((best, e) => (!best || e.lengthKm < best.lengthKm ? e : best), null);
  return { initial, pinch };
}

export function runScenario(w: EngineWorld, s: Scenario, progress?: (done: number, total: number) => void): EngineResult {
  const t0 = performance.now();
  const terrain = buildTerrain(w, s);
  const { g } = terrain;
  const arrival = spread(terrain, s);
  const runs: [number, number][] = s.ensemble
    ? [[-30, 1], [-15, 1], [15, 1], [30, 1], [0, 0.75], [0, 1.25], [-15, 1.25], [15, 1.25], [-15, 0.8], [15, 0.8]]
    : [];
  const total = runs.length + 1;
  progress?.(1, total);
  let prob: Uint8Array | null = null;
  if (runs.length) {
    const count = new Uint8Array(arrival.length);
    for (let i = 0; i < arrival.length; i++) if (arrival[i] < Infinity) count[i] = 1;
    runs.forEach(([shift, mult], k) => {
      const a = spread(terrain, s, shift, mult);
      for (let i = 0; i < a.length; i++) if (a[i] < Infinity) count[i]++;
      progress?.(k + 2, total);
    });
    prob = new Uint8Array(arrival.length);
    for (let i = 0; i < count.length; i++) prob[i] = Math.round((count[i] / total) * 255);
  }
  const eta = crewTimes(terrain, s);

  const cellHa = (g.res * g.res) / 1e4;
  const series: { hour: number; ha: number }[] = [];
  const counts = new Float64Array(s.hours + 1);
  let forest: number | null = null;
  let bamboo: number | null = null;
  for (let i = 0; i < arrival.length; i++) {
    const a = arrival[i];
    if (a === Infinity) continue;
    counts[Math.min(Math.ceil(a / 60), s.hours)]++;
    if (terrain.fuel[i] === 4) {
      const h = terrain.height[i];
      if (h > 2450 && h < 3050) bamboo = bamboo === null ? a : Math.min(bamboo, a);
      else forest = forest === null ? a : Math.min(forest, a);
    }
  }
  let acc = 0;
  for (let h = 0; h <= s.hours; h++) {
    acc += counts[h];
    series.push({ hour: h, ha: Math.round(acc * cellHa) });
  }
  return {
    grid: g,
    arrival,
    prob,
    eta,
    series,
    firsts: { forest, bamboo },
    control: controlLines(terrain, arrival, eta, s.hours, series),
    runs: total,
    ms: Math.round(performance.now() - t0),
  };
}

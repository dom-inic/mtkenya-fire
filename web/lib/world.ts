/**
 * The 3D world: data loading and coordinates.
 *
 * World units are metres. x runs east, z runs south, y is height above sea
 * level times VEXAG. The origin is the centre of the world bounding box;
 * near the equator a plain equirectangular projection is accurate to well
 * under 0.1%, so every lon/lat grid maps onto the terrain with linear UVs.
 */

export const VEXAG = 1.25;
const M_PER_DEG_LAT = 110_574;

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface WorldMeta {
  world: BBox;
  inner: BBox;
  heights: { outer: [number, number]; inner: [number, number]; scale: number };
  fuel: { outer: [number, number]; inner: [number, number] };
  fire: { grid: [number, number]; units: string };
  imagery: { outer: string; inner: string; source: string };
  elevation: { min: number; max: number };
}

export interface WorldFeatures {
  roads: { kind: string; name?: string | null; line: [number, number][] }[];
  lakes: { name?: string | null; ring: [number, number][] }[];
  runways: { name?: string | null; line: [number, number][] }[];
  pois: { name: string; kind: string; lon: number; lat: number }[];
}

export interface Raster<T extends ArrayLike<number>> {
  w: number;
  h: number;
  bbox: BBox;
  data: T;
}

export interface WorldData {
  meta: WorldMeta;
  features: WorldFeatures;
  heightsOuter: Raster<Float32Array>;
  heightsInner: Raster<Float32Array>;
  fuelOuter: Raster<Uint8Array>;
  fuelInner: Raster<Uint8Array>;
  fire: Raster<Float32Array> | null;
}

const BASE = "/data/world";

async function bin(name: string): Promise<ArrayBuffer | null> {
  const r = await fetch(`${BASE}/${name}`);
  return r.ok ? r.arrayBuffer() : null;
}

function toFloat(u16: Uint16Array, scale: number, nodata?: number): Float32Array {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = nodata !== undefined && u16[i] === nodata ? Infinity : u16[i] * scale;
  return out;
}

export async function loadWorld(): Promise<WorldData> {
  const [meta, features] = await Promise.all([
    fetch(`${BASE}/world.json`).then((r) => r.json() as Promise<WorldMeta>),
    fetch(`${BASE}/features.json`).then((r) => r.json() as Promise<WorldFeatures>),
  ]);
  const [ho, hi, fo, fi, fa] = await Promise.all([
    bin("heights_outer.u16"),
    bin("heights_inner.u16"),
    bin("fuel_outer.u8"),
    bin("fuel_inner.u8"),
    bin("fire_arrival_inner.u16"),
  ]);
  if (!ho || !hi || !fo || !fi) throw new Error("World data missing: run `uv run python build.py --world-only`");
  const s = meta.heights.scale;
  return {
    meta,
    features,
    heightsOuter: { w: meta.heights.outer[0], h: meta.heights.outer[1], bbox: meta.world, data: toFloat(new Uint16Array(ho), s) },
    heightsInner: { w: meta.heights.inner[0], h: meta.heights.inner[1], bbox: meta.inner, data: toFloat(new Uint16Array(hi), s) },
    fuelOuter: { w: meta.fuel.outer[0], h: meta.fuel.outer[1], bbox: meta.world, data: new Uint8Array(fo) },
    fuelInner: { w: meta.fuel.inner[0], h: meta.fuel.inner[1], bbox: meta.inner, data: new Uint8Array(fi) },
    fire: fa ? { w: meta.fire.grid[0], h: meta.fire.grid[1], bbox: meta.inner, data: toFloat(new Uint16Array(fa), 1, 65535) } : null,
  };
}

/** lon/lat <-> world metres around the centre of the world box */
export class Projection {
  lon0: number;
  lat0: number;
  mx: number;
  constructor(world: BBox) {
    this.lon0 = (world.west + world.east) / 2;
    this.lat0 = (world.south + world.north) / 2;
    this.mx = M_PER_DEG_LAT * 1.00336 * Math.cos((this.lat0 * Math.PI) / 180);
  }
  x(lon: number) {
    return (lon - this.lon0) * this.mx;
  }
  z(lat: number) {
    return -(lat - this.lat0) * M_PER_DEG_LAT;
  }
  lon(x: number) {
    return this.lon0 + x / this.mx;
  }
  lat(z: number) {
    return this.lat0 - z / M_PER_DEG_LAT;
  }
}

export function inside(b: BBox, lon: number, lat: number) {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

/** Bilinear sample of a raster at lon/lat (cell centres at half steps). */
export function sample(r: Raster<ArrayLike<number>>, lon: number, lat: number): number {
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

export function nearest(r: Raster<ArrayLike<number>>, lon: number, lat: number): number {
  const x = Math.floor(((lon - r.bbox.west) / (r.bbox.east - r.bbox.west)) * r.w);
  const y = Math.floor(((r.bbox.north - lat) / (r.bbox.north - r.bbox.south)) * r.h);
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return NaN;
  return r.data[y * r.w + x];
}

/** Ground height (m above sea level), preferring the 30 m inner grid. */
export function groundHeight(w: WorldData, lon: number, lat: number): number {
  return inside(w.meta.inner, lon, lat) ? sample(w.heightsInner, lon, lat) : sample(w.heightsOuter, lon, lat);
}

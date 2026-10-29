import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineWorld, FireParams } from "../engine";

const DATA = path.join(process.cwd(), "public", "data");

let loaded: Promise<ServerWorld> | null = null;

export interface ServerWorld {
  engine: EngineWorld;
  params: FireParams;
  places: { name: string; kind: string; lon: number; lat: number }[];
  fuelAt: (lon: number, lat: number) => number;
  /** ERA5 hourly weather for 1–9 Sep 2026, for drills */
  septWeather: { time: string; wind_kmh: number; wind_from: number; rh: number; rain_mm: number; temp_c: number }[];
}

async function bin(name: string) {
  const b = await fs.readFile(path.join(DATA, "world", name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}

/** The 3D world's rasters, read once per server process, for server-side forecasts. */
export function serverWorld(): Promise<ServerWorld> {
  loaded ??= (async () => {
    const meta = JSON.parse(await fs.readFile(path.join(DATA, "world", "world.json"), "utf8"));
    const feats = JSON.parse(await fs.readFile(path.join(DATA, "world", "features.json"), "utf8"));
    const inc = JSON.parse(await fs.readFile(path.join(DATA, "incident.json"), "utf8"));
    const f32 = (b: ArrayBuffer) => Float32Array.from(new Uint16Array(b), (v) => v * meta.heights.scale);
    const engine: EngineWorld = {
      world: meta.world,
      inner: meta.inner,
      heightsOuter: { w: meta.heights.outer[0], h: meta.heights.outer[1], bbox: meta.world, data: f32(await bin("heights_outer.u16")) },
      heightsInner: { w: meta.heights.inner[0], h: meta.heights.inner[1], bbox: meta.inner, data: f32(await bin("heights_inner.u16")) },
      fuelOuter: { w: meta.fuel.outer[0], h: meta.fuel.outer[1], bbox: meta.world, data: new Uint8Array(await bin("fuel_outer.u8")) },
      fuelInner: { w: meta.fuel.inner[0], h: meta.fuel.inner[1], bbox: meta.inner, data: new Uint8Array(await bin("fuel_inner.u8")) },
      baseRos: inc.fuels.map((f: { base_ros: number }) => f.base_ros),
      roads: feats.roads,
      lakes: feats.lakes.map((l: { ring: [number, number][] }) => l.ring),
    };
    const fuelAt = (lon: number, lat: number) => {
      const b = engine.inner;
      const r = lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north ? engine.fuelInner : engine.fuelOuter;
      const x = Math.floor(((lon - r.bbox.west) / (r.bbox.east - r.bbox.west)) * r.w);
      const y = Math.floor(((r.bbox.north - lat) / (r.bbox.north - r.bbox.south)) * r.h);
      return x < 0 || y < 0 || x >= r.w || y >= r.h ? -1 : r.data[y * r.w + x];
    };
    const places = [
      ...inc.places.map((p: { name: string; lon: number; lat: number }) => ({ ...p, kind: "place" })),
      ...feats.pois.filter((p: { kind: string }) => ["gate", "station", "alpine_hut", "wilderness_hut", "camp_site", "airstrip", "town", "village"].includes(p.kind)),
    ];
    return { engine, params: inc.sim.params, places, fuelAt, septWeather: inc.weather };
  })();
  return loaded;
}

/**
 * Firefighting response: helicopters, an air tanker and ground crews working
 * against the forecast fire. Every hour each unit acts on the fire as it now
 * stands (including what everyone has done so far), then the fire is re-run.
 *
 * Aircraft numbers are indicative, not operator specifications: payload falls
 * with density altitude (elevation corrected for temperature), and every type
 * has a density altitude above which it can't carry a useful load.
 */

import { cellOf, lonLatOf, spread, travel, type Block, type HourWeather, type Scenario, type Terrain } from "./engine";

export type HeliType = "as350" | "bell205" | "mi17";

export const HELI_TYPES: Record<HeliType, { name: string; bucketL: number; fullDA: number; ceilingDA: number; cruiseKmh: number; enduranceMin: number }> = {
  as350: { name: "AS350 B3 (light, high-altitude)", bucketL: 800, fullDA: 2500, ceilingDA: 6000, cruiseKmh: 170, enduranceMin: 150 },
  bell205: { name: "Bell 205 / UH-1 (medium)", bucketL: 1100, fullDA: 1500, ceilingDA: 4600, cruiseKmh: 150, enduranceMin: 140 },
  mi17: { name: "Mi-17 type (heavy)", bucketL: 3000, fullDA: 1500, ceilingDA: 5200, cruiseKmh: 180, enduranceMin: 180 },
};

export const TANKER = { name: "Air tanker, AT-802 type (illustrative)", loadL: 3000, cruiseKmh: 300, reloadMin: 15, holdMin: 8 * 60 };

const WATER_HOLD_MIN = 150; // a bucket drop keeps heath from burning ~2.5 h before it dries
const FILL_MIN = 1.5;
const DROP_MIN = 0.5;
const REFUEL_MIN = 20;
const DAY_START = 6.5;
const DAY_END = 18.5;

export interface Place {
  name: string;
  lon: number;
  lat: number;
}

export interface Resources {
  helis: { id: string; type: HeliType; base: Place }[];
  tankers: { id: string; base: Place }[];
  crews: { id: string; base: Place; size: number }[];
  dispatchMin: number; // aircraft airborne this long after ignition
  airstrips: Place[]; // where helicopters can refuel
  startHourOfDay: number; // local hour at ignition
}

export interface Leg {
  unit: string;
  t0: number;
  t1: number;
  from: [number, number];
  to: [number, number];
  phase: "ferry" | "loaded" | "empty" | "fill" | "refuel";
}

export interface Drop {
  unit: string;
  t: number;
  cells: [number, number][];
  litres: number;
  kind: "water" | "retardant";
}

export interface UnitStats {
  id: string;
  kind: "heli" | "tanker" | "crew";
  name: string;
  base: string;
  source?: string;
  payloadL?: number;
  cycleMin?: number;
  drops: number;
  litres: number;
  lineKm: number;
  arrives?: number | null;
}

export interface ResponseResult {
  arrival: Float32Array;
  block: { from: Float32Array; until: Float32Array; kind: Uint8Array }; // kind: 1 water, 2 retardant, 3 line
  legs: Leg[];
  drops: Drop[];
  crewTracks: { unit: string; points: [number, number, number][] }[]; // t, lon, lat
  lineCells: { unit: string; t: number; lon: number; lat: number }[];
  units: UnitStats[];
  series: { hour: number; ha: number }[];
}

const KM_PER_DEG = 111.32;
function distKm(a: [number, number], b: [number, number]) {
  const dx = (b[0] - a[0]) * KM_PER_DEG * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * KM_PER_DEG;
  return Math.hypot(dx, dy);
}

function isDay(startHour: number, minute: number) {
  const h = (((startHour * 60 + minute) / 60) % 24 + 24) % 24;
  return h >= DAY_START && h < DAY_END;
}

/** Minutes until the next daylight start (0 if it's day now). */
function untilDay(startHour: number, minute: number) {
  if (isDay(startHour, minute)) return 0;
  const h = (((startHour * 60 + minute) / 60) % 24 + 24) % 24;
  return ((DAY_START - h + 24) % 24) * 60;
}

/** Payload a helicopter can lift at a density altitude. */
export function payloadAt(type: HeliType, densityAltitude: number) {
  const h = HELI_TYPES[type];
  const f = (h.ceilingDA - densityAltitude) / (h.ceilingDA - h.fullDA);
  return Math.round(h.bucketL * Math.min(Math.max(f, 0), 1));
}

function densityAltitude(elevation: number, tempC: number) {
  const isa = 15 - 0.0065 * elevation;
  return elevation + 36.6 * (tempC - isa);
}

/** Lakes big enough to dip a bucket in (> 2 ha), as centroid + elevation. */
function waterSources(lakes: [number, number][][]) {
  const out: { lon: number; lat: number; ha: number }[] = [];
  for (const ring of lakes) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f;
      cx += (ring[j][0] + ring[i][0]) * f;
      cy += (ring[j][1] + ring[i][1]) * f;
    }
    const ha = (Math.abs(a / 2) * (KM_PER_DEG * 1000) ** 2) / 1e4;
    if (ha < 2 || a === 0) continue;
    out.push({ lon: cx / (3 * a), lat: cy / (3 * a), ha });
  }
  return out;
}

export function respond(
  terrain: Terrain,
  s: Scenario,
  res: Resources,
  lakes: [number, number][][],
  progress?: (done: number, total: number) => void,
): ResponseResult {
  const { g, base, fuel, slope, height } = terrain;
  const n = g.w * g.h;
  const block: Block = { from: new Float32Array(n).fill(Infinity), until: new Float32Array(n) };
  const kind = new Uint8Array(n);
  const tEnd = s.hours * 60;
  const weatherAt = (m: number): HourWeather => s.weather[Math.min(Math.floor(m / 60), s.weather.length - 1)];
  const ign: [number, number] = [s.ignition.lon, s.ignition.lat];

  const legs: Leg[] = [];
  const drops: Drop[] = [];
  const lineCells: ResponseResult["lineCells"] = [];
  const crewTracks: ResponseResult["crewTracks"] = [];
  const stats = new Map<string, UnitStats>();

  const hold = (i: number, from: number, until: number, k: number) => {
    block.from[i] = Math.min(block.from[i], from);
    block.until[i] = Math.max(block.until[i], until);
    kind[i] = Math.max(kind[i], k);
  };

  // Lakes near the fire, nearest first
  const sources = waterSources(lakes).sort((a, b) => distKm([a.lon, a.lat], ign) - distKm([b.lon, b.lat], ign));

  // --- Aircraft state ---------------------------------------------------------
  interface Air {
    id: string;
    heli: boolean;
    type?: HeliType;
    base: Place;
    source?: { lon: number; lat: number };
    at: [number, number];
    free: number; // minute it's free to act
    fuel: number; // minutes of flight left
    started: boolean;
    last?: [number, number];
  }
  const air: Air[] = [
    ...res.helis.map((h) => ({ id: h.id, heli: true, type: h.type, base: h.base, source: sources[0], at: [h.base.lon, h.base.lat] as [number, number], free: res.dispatchMin, fuel: HELI_TYPES[h.type].enduranceMin, started: false })),
    ...res.tankers.map((tk) => ({ id: tk.id, heli: false, base: tk.base, at: [tk.base.lon, tk.base.lat] as [number, number], free: res.dispatchMin, fuel: Infinity, started: false })),
  ];
  for (const a of air) {
    const ht = a.type ? HELI_TYPES[a.type] : null;
    stats.set(a.id, {
      id: a.id,
      kind: a.heli ? "heli" : "tanker",
      name: ht ? ht.name : TANKER.name,
      base: a.base.name,
      source: a.heli && a.source ? `lake ${distKm([a.source.lon, a.source.lat], ign).toFixed(1)} km from the ignition` : undefined,
      drops: 0,
      litres: 0,
      lineKm: 0,
    });
  }

  // --- Crew state -------------------------------------------------------------
  interface Crew {
    id: string;
    base: Place;
    size: number;
    eta: Float32Array;
    pred: Int32Array;
    pos: number; // cell
    time: number; // minute the crew is at pos and free
    deployed: boolean;
    track: [number, number, number][];
  }
  const crews: Crew[] = res.crews.map((c) => {
    const pred = new Int32Array(n);
    const eta = travel(terrain, [[cellOf(g, c.base.lon, c.base.lat), s.mobiliseMin]], pred);
    stats.set(c.id, { id: c.id, kind: "crew", name: `Hand crew, ${c.size} people`, base: c.base.name, drops: 0, litres: 0, lineKm: 0, arrives: null });
    return { id: c.id, base: c.base, size: c.size, eta, pred, pos: -1, time: 0, deployed: false, track: [] };
  });

  /** Cells about to burn: unburned at `t` and reached by the fire within `ahead` minutes, most imminent first. */
  const imminent = (arr: Float32Array, t: number, ahead: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = arr[i];
      if (a > t && a <= t + ahead && base[i] > 0 && !(block.from[i] <= t && block.until[i] > t)) out.push(i);
    }
    return out.sort((x, y) => arr[x] - arr[y]);
  };

  /** Pick a drop target near the last one (work along the head), among the most imminent cells. */
  const pickTarget = (cands: number[], arr: Float32Array, t: number, near?: [number, number]) => {
    let best = -1;
    let bestScore = Infinity;
    let seen = 0;
    for (const i of cands) {
      if (arr[i] <= t + 3 || (block.from[i] <= t && block.until[i] > t)) continue;
      const p = lonLatOf(g, i);
      const score = (arr[i] - t) + (near ? distKm(p, near) * 20 : 0); // 1 km off = 20 min less urgent
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
      if (++seen > 60) break;
    }
    return best;
  };

  /** Once crews are on the line, aircraft cool the edge next to them (one crew per aircraft, round-robin). */
  const supportPoint = (a: Air): [number, number] | undefined => {
    const onLine = crews.filter((c) => c.deployed && c.pos >= 0);
    if (!onLine.length) return undefined;
    const c = onLine[air.indexOf(a) % onLine.length];
    return lonLatOf(g, c.pos);
  };

  const fly = (a: Air, to: [number, number], phase: Leg["phase"], kmh: number) => {
    const mins = (distKm(a.at, to) / kmh) * 60;
    legs.push({ unit: a.id, t0: a.free, t1: a.free + mins, from: a.at, to, phase });
    a.free += mins;
    a.fuel -= mins;
    a.at = to;
    return mins;
  };

  const steps = Math.ceil(tEnd / 60);
  let arr = spread(terrain, s, 0, 1, block);

  for (let h = 0; h < steps; h++) {
    const T0 = h * 60;
    const T1 = T0 + 60;
    const cands = imminent(arr, T0, 120);

    // Aircraft: fly cycles until the end of this hour
    for (const a of air) {
      let guard = 0;
      while (a.free < T1 && guard++ < 60) {
        const wait = untilDay(res.startHourOfDay, a.free);
        if (wait > 0) {
          // Night: park at base, back out at first light
          if (a.started) {
            fly(a, [a.base.lon, a.base.lat], "ferry", a.heli ? HELI_TYPES[a.type!].cruiseKmh : TANKER.cruiseKmh);
            a.fuel = a.heli ? HELI_TYPES[a.type!].enduranceMin : Infinity;
          }
          a.free += untilDay(res.startHourOfDay, a.free);
          a.started = false;
          continue;
        }
        if (a.heli) {
          const ht = HELI_TYPES[a.type!];
          const src = a.source;
          if (!src) break;
          const lake: [number, number] = [src.lon, src.lat];
          if (!a.started) {
            fly(a, lake, "ferry", ht.cruiseKmh);
            a.started = true;
            continue;
          }
          // Fill, then pick where the fire will be when we get there
          const fillAt = a.free;
          const target = pickTarget(cands, arr, fillAt + FILL_MIN + (distKm(lake, a.last ?? ign) / ht.cruiseKmh) * 60, supportPoint(a) ?? a.last);
          if (target < 0) {
            a.free = T1; // nothing to hit this hour
            break;
          }
          const tp = lonLatOf(g, target);
          const cycle = FILL_MIN + DROP_MIN + ((2 * distKm(lake, tp)) / ht.cruiseKmh) * 60;
          // Refuel at the nearest airstrip when the next cycle would run the tank too low
          const strip = res.airstrips.reduce((b, p) => (distKm([p.lon, p.lat], lake) < distKm([b.lon, b.lat], lake) ? p : b), res.airstrips[0] ?? a.base);
          const toStrip = (distKm(lake, [strip.lon, strip.lat]) / ht.cruiseKmh) * 60;
          if (a.fuel < cycle + toStrip + 10) {
            fly(a, [strip.lon, strip.lat], "refuel", ht.cruiseKmh);
            legs.push({ unit: a.id, t0: a.free, t1: a.free + REFUEL_MIN, from: a.at, to: a.at, phase: "refuel" });
            a.free += REFUEL_MIN;
            a.fuel = ht.enduranceMin;
            fly(a, lake, "ferry", ht.cruiseKmh);
            continue;
          }
          const w = weatherAt(fillAt);
          const elev = Math.max(height[target], height[cellOf(g, lake[0], lake[1])] || height[target]);
          const litres = payloadAt(a.type!, densityAltitude(elev + 150, w.temp_c ?? 8));
          legs.push({ unit: a.id, t0: a.free, t1: a.free + FILL_MIN, from: lake, to: lake, phase: "fill" });
          a.free += FILL_MIN;
          a.fuel -= FILL_MIN;
          if (litres < 150) {
            a.free = T1; // too thin to lift a useful load
            break;
          }
          fly(a, tp, "loaded", ht.cruiseKmh);
          const tDrop = a.free;
          // Bigger loads wet longer; a drop only counts on ground the fire hasn't reached
          if (arr[target] > tDrop) hold(target, tDrop, tDrop + WATER_HOLD_MIN * Math.min(litres / 1000, 1.5), 1);
          drops.push({ unit: a.id, t: tDrop, cells: [tp], litres, kind: "water" });
          const st = stats.get(a.id)!;
          st.drops++;
          st.litres += litres;
          st.payloadL = litres;
          st.cycleMin = Math.round(cycle);
          a.free += DROP_MIN;
          a.last = tp;
          fly(a, lake, "empty", ht.cruiseKmh);
        } else {
          // Air tanker: load at base, drop a line of retardant across the head, return
          const baseP: [number, number] = [a.base.lon, a.base.lat];
          a.free += a.started ? TANKER.reloadMin : 0;
          a.started = true;
          const eta = a.free + (distKm(baseP, ign) / TANKER.cruiseKmh) * 60;
          const target = pickTarget(cands, arr, eta + 10, supportPoint(a) ?? a.last);
          if (target < 0) {
            a.free = T1;
            break;
          }
          const tp = lonLatOf(g, target);
          fly(a, tp, "loaded", TANKER.cruiseKmh);
          const tDrop = a.free;
          // ~4 cells of retardant along the imminent edge next to the target
          const line = [target, ...cands.filter((i) => i !== target && distKm(lonLatOf(g, i), tp) < 0.2 && arr[i] > tDrop).slice(0, 3)];
          for (const i of line) hold(i, tDrop, tDrop + TANKER.holdMin, 2);
          drops.push({ unit: a.id, t: tDrop, cells: line.map((i) => lonLatOf(g, i)), litres: TANKER.loadL, kind: "retardant" });
          const st = stats.get(a.id)!;
          st.drops++;
          st.litres += TANKER.loadL;
          st.cycleMin = Math.round(TANKER.reloadMin + ((2 * distKm(baseP, tp)) / TANKER.cruiseKmh) * 60);
          a.last = tp;
          fly(a, baseP, "empty", TANKER.cruiseKmh);
        }
      }
    }

    // Ground crews: travel to an anchor point ahead of the fire, then cut line along its edge
    for (const c of crews) {
      if (!c.deployed) {
        // Nearest cell (by travel time) the fire reaches 30 min to 4 h after the crew could
        let best = -1;
        for (let i = 0; i < n; i++) {
          const e = c.eta[i];
          const a = arr[i];
          if (e < T1 && a > e + 30 && a < e + 240 && (best < 0 || e < c.eta[best])) best = i;
        }
        if (best < 0) continue;
        const path: number[] = [];
        for (let i = best; i >= 0 && path.length < 5000; i = c.pred[i]) path.push(i);
        path.reverse();
        c.track = path.filter((_, k) => k % 3 === 0 || k === path.length - 1).map((i) => [c.eta[i], ...lonLatOf(g, i)] as [number, number, number]);
        c.pos = best;
        c.time = c.eta[best];
        c.deployed = true;
        stats.get(c.id)!.arrives = Math.round(c.time);
      }
      // Cut line until the end of the hour
      let guard = 0;
      while (c.time < T1 && guard++ < 400) {
        const r0 = (c.pos / g.w) | 0;
        const c0 = c.pos - r0 * g.w;
        let next = -1;
        for (const rad of [3, 8]) {
          let bestA = Infinity;
          for (let dy = -rad; dy <= rad; dy++) {
            for (let dx = -rad; dx <= rad; dx++) {
              const y = r0 + dy;
              const x = c0 + dx;
              if (y < 0 || x < 0 || y >= g.h || x >= g.w) continue;
              const i = y * g.w + x;
              const a = arr[i];
              // Unburned fuel the fire reaches within 3 h, not yet held, that we can finish first
              // (walk + cut a 60 m section takes ~20-40 min)
              if (base[i] === 0 || kind[i] === 3 || !(a > c.time + 40 && a < c.time + 180)) continue;
              if (a < bestA) {
                bestA = a;
                next = i;
              }
            }
          }
          if (next >= 0) break;
        }
        if (next < 0) {
          // The fire moved on: walk to the nearest stretch of edge we can reach before it
          const here = lonLatOf(g, c.pos);
          let best = -1;
          let bestWalk = Infinity;
          for (const i of cands) {
            const walk = (distKm(here, lonLatOf(g, i)) / 3) * 60;
            if (walk < bestWalk && arr[i] > c.time + walk + 30 && kind[i] !== 3) {
              bestWalk = walk;
              best = i;
            }
          }
          if (best < 0 || bestWalk > 120) {
            c.time = T1; // nothing reachable this hour
            break;
          }
          c.time += bestWalk;
          c.pos = best;
          c.track.push([c.time, ...lonLatOf(g, best)]);
          continue;
        }
        // Hand line rates for a 20-person crew (m/h): grass 400, heath 220, Erica 120, forest 100
        const rate = [0, 400, 220, 120, 100, 0, 300][fuel[next]] * (c.size / 20) * (isDay(res.startHourOfDay, c.time) ? 1 : 0.7) * (slope[next] > 25 ? 0.5 : 1);
        if (rate <= 0) break;
        const walk = (distKm(lonLatOf(g, c.pos), lonLatOf(g, next)) / 3) * 60;
        c.time += walk + (g.res / rate) * 60;
        if (arr[next] <= c.time) continue; // the fire got there first
        hold(next, c.time, Infinity, 3);
        const [lon, lat] = lonLatOf(g, next);
        lineCells.push({ unit: c.id, t: c.time, lon, lat });
        c.track.push([c.time, lon, lat]);
        c.pos = next;
        stats.get(c.id)!.lineKm += g.res / 1000;
      }
    }

    arr = spread(terrain, s, 0, 1, block);
    progress?.(h + 1, steps);
  }

  for (const c of crews) crewTracks.push({ unit: c.id, points: c.track });
  const cellHa = (g.res * g.res) / 1e4;
  const series = Array.from({ length: s.hours + 1 }, (_, hr) => {
    let k = 0;
    for (let i = 0; i < n; i++) if (arr[i] <= hr * 60) k++;
    return { hour: hr, ha: Math.round(k * cellHa) };
  });
  return { arrival: arr, block: { from: block.from, until: block.until, kind }, legs, drops, crewTracks, lineCells, units: [...stats.values()], series };
}

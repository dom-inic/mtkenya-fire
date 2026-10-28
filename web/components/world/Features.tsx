"use client";

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { groundHeight, inside, Projection, VEXAG, type WorldData } from "@/lib/world";

/** Lakes as flat water at the lowest shore height. */
export function Lakes({ world, proj }: { world: WorldData; proj: Projection }) {
  const mesh = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    for (const lake of world.features.lakes) {
      if (lake.ring.length < 4) continue;
      const shape = new THREE.Shape(lake.ring.map(([lon, lat]) => new THREE.Vector2(proj.x(lon), -proj.z(lat))));
      const level = Math.min(...lake.ring.map(([lon, lat]) => groundHeight(world, lon, lat)));
      geos.push(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, level * VEXAG + 1.5, 0));
    }
    const merged = geos.length ? mergeAll(geos) : new THREE.BufferGeometry();
    const mat = new THREE.MeshStandardMaterial({ color: "#2f5d73", roughness: 0.15, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    return new THREE.Mesh(merged, mat);
  }, [world, proj]);
  return <primitive object={mesh} />;
}

function mergeAll(geos: THREE.BufferGeometry[]) {
  const pos: number[] = [];
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    pos.push(...(ng.getAttribute("position").array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

const ROAD_STYLE: Record<string, { colour: string; lift: number }> = {
  trunk: { colour: "#f4d27a", lift: 8 },
  primary: { colour: "#f4d27a", lift: 8 },
  secondary: { colour: "#efd9a8", lift: 7 },
  tertiary: { colour: "#e9d3b0", lift: 6 },
  unclassified: { colour: "#d9c3a0", lift: 6 },
  track: { colour: "#c79a63", lift: 5 },
  path: { colour: "#b88a5c", lift: 4 },
  runway: { colour: "#f5f5f4", lift: 6 },
};

/** Roads and tracks draped on the terrain, one draw call per kind. */
export function Roads({ world, proj, kinds, night = 0 }: { world: WorldData; proj: Projection; kinds: string[]; night?: number }) {
  const groups = useMemo(() => {
    const byKind = new Map<string, number[]>();
    const lines = [...world.features.roads.map((r) => ({ kind: r.kind, line: r.line })), ...world.features.runways.map((r) => ({ kind: "runway", line: r.line }))];
    for (const { kind, line } of lines) {
      if (!kinds.includes(kind) && kind !== "runway") continue;
      const style = ROAD_STYLE[kind] ?? ROAD_STYLE.track;
      const arr = byKind.get(kind) ?? [];
      for (let i = 1; i < line.length; i++) {
        const [lon0, lat0] = line[i - 1];
        const [lon1, lat1] = line[i];
        // Ways that leave the world box would hang off its edge
        if (!inside(world.meta.world, lon0, lat0) || !inside(world.meta.world, lon1, lat1)) continue;
        const lenM = Math.hypot(proj.x(lon1) - proj.x(lon0), proj.z(lat1) - proj.z(lat0));
        const steps = Math.max(1, Math.ceil(lenM / 60)); // follow the ground every ~60 m
        for (let s = 0; s < steps; s++) {
          for (const t of [s / steps, (s + 1) / steps]) {
            const lon = lon0 + (lon1 - lon0) * t;
            const lat = lat0 + (lat1 - lat0) * t;
            arr.push(proj.x(lon), groundHeight(world, lon, lat) * VEXAG + style.lift, proj.z(lat));
          }
        }
      }
      byKind.set(kind, arr);
    }
    return [...byKind.entries()].map(([kind, arr]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({ color: (ROAD_STYLE[kind] ?? ROAD_STYLE.track).colour, transparent: true, opacity: kind === "path" ? 0.6 : 0.9 });
      return { kind, obj: new THREE.LineSegments(g, mat) };
    });
  }, [world, proj, kinds]);
  // Unlit lines would glow at night and read as fire: dim them after dark
  for (const g of groups) {
    const m = g.obj.material as THREE.LineBasicMaterial;
    m.opacity = (g.kind === "path" ? 0.6 : 0.9) * (1 - 0.75 * night);
  }
  return (
    <group>
      {groups.map((g) => (
        <primitive key={g.kind} object={g.obj} />
      ))}
    </group>
  );
}

const POI_STYLE: Record<string, { icon: string; colour: string }> = {
  airstrip: { icon: "✈", colour: "#0ea5e9" },
  airbase: { icon: "✈", colour: "#0369a1" },
  gate: { icon: "⛩", colour: "#16a34a" },
  station: { icon: "⌂", colour: "#15803d" },
  alpine_hut: { icon: "⌂", colour: "#a16207" },
  wilderness_hut: { icon: "⌂", colour: "#a16207" },
  camp_site: { icon: "▲", colour: "#a16207" },
  town: { icon: "●", colour: "#334155" },
  village: { icon: "•", colour: "#475569" },
  lake: { icon: "◆", colour: "#0e7490" },
  peak: { icon: "▲", colour: "#111827" },
  fire: { icon: "🔥", colour: "#ea580c" },
};

export interface Poi {
  name: string;
  kind: string;
  lon: number;
  lat: number;
}

/** How far away (m) each kind of label stays visible, so far views stay readable. */
const LABEL_RANGE: Record<string, number> = {
  town: 90_000,
  airstrip: 12_000,
  key_airstrip: 90_000,
  airbase: 90_000,
  peak: 90_000,
  fire: 90_000,
  lake: 30_000,
  gate: 30_000,
  station: 25_000,
  alpine_hut: 14_000,
  wilderness_hut: 14_000,
};

/** Airfields that matter for firefighting stay labelled from afar. */
const KEY_AIRFIELDS = /Nanyuki|Laikipia Air Base|Lewa|Rutundu/i;

/** Floating labels pinned to the ground, shown when the camera is near enough. */
export function Labels({ world, proj, pois }: { world: WorldData; proj: Projection; pois: Poi[] }) {
  const placed = useMemo(
    () =>
      pois.map((p) => ({
        p,
        pos: new THREE.Vector3(proj.x(p.lon), groundHeight(world, p.lon, p.lat) * VEXAG + 40, proj.z(p.lat)),
        range: LABEL_RANGE[KEY_AIRFIELDS.test(p.name) ? "key_airstrip" : p.kind] ?? 20_000,
      })),
    [pois, proj, world],
  );
  const els = useRef<(HTMLDivElement | null)[]>([]);
  useFrame(({ camera }) => {
    placed.forEach((l, i) => {
      const el = els.current[i];
      if (el) el.style.display = camera.position.distanceTo(l.pos) < l.range ? "flex" : "none";
    });
  });
  return (
    <group>
      {placed.map(({ p, pos }, i) => {
        const s = POI_STYLE[p.kind] ?? POI_STYLE.village;
        return (
          <Html key={`${i}-${p.name}`} position={pos} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
            <div ref={(el) => { els.current[i] = el; }} className="flex -translate-y-3 flex-col items-center whitespace-nowrap">
              <span className="rounded bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white shadow backdrop-blur-sm">
                <span style={{ color: s.colour === "#334155" ? "#e2e8f0" : s.colour }} className="mr-1">
                  {s.icon}
                </span>
                {p.name}
              </span>
              <span className="h-3 w-px bg-white/70" />
            </div>
          </Html>
        );
      })}
    </group>
  );
}

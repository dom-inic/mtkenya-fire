"use client";

import { Html, Line } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import type { ControlLine } from "@/lib/engine";
import { groundHeight, Projection, VEXAG, type WorldData } from "@/lib/world";

type LonLat = [number, number];

/** Points along a lon/lat polyline every ~40 m, lifted just off the ground. */
function drape(world: WorldData, proj: Projection, line: LonLat[], lift = 12): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < line.length; i++) {
    const [lon1, lat1] = line[i];
    if (i > 0) {
      const [lon0, lat0] = line[i - 1];
      const len = Math.hypot(proj.x(lon1) - proj.x(lon0), proj.z(lat1) - proj.z(lat0));
      const n = Math.max(1, Math.ceil(len / 40));
      for (let s = 1; s < n; s++) {
        const lon = lon0 + ((lon1 - lon0) * s) / n;
        const lat = lat0 + ((lat1 - lat0) * s) / n;
        out.push([proj.x(lon), groundHeight(world, lon, lat) * VEXAG + lift, proj.z(lat)]);
      }
    }
    out.push([proj.x(lon1), groundHeight(world, lon1, lat1) * VEXAG + lift, proj.z(lat1)]);
  }
  return out;
}

export function Ignition({ world, proj, at, label }: { world: WorldData; proj: Projection; at: LonLat; label: string }) {
  const y = groundHeight(world, at[0], at[1]) * VEXAG;
  return (
    <group position={[proj.x(at[0]), y, proj.z(at[1])]}>
      <mesh position={[0, 450, 0]}>
        <cylinderGeometry args={[6, 22, 900, 12, 1, true]} />
        <meshBasicMaterial color="#ff7a1a" transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 8, 0]}>
        <sphereGeometry args={[26, 16, 12]} />
        <meshBasicMaterial color="#ffb347" />
      </mesh>
      <Html position={[0, 950, 0]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
        <div className="whitespace-nowrap rounded bg-orange-600 px-2 py-0.5 text-[11px] font-semibold text-white shadow">🔥 {label}</div>
      </Html>
    </group>
  );
}

export function Firebreaks({ world, proj, lines, draft }: { world: WorldData; proj: Projection; lines: LonLat[][]; draft: LonLat[] }) {
  const draped = useMemo(() => lines.filter((l) => l.length > 1).map((l) => drape(world, proj, l)), [world, proj, lines]);
  const draftPts = useMemo(() => (draft.length ? drape(world, proj, draft) : []), [world, proj, draft]);
  return (
    <group>
      {draped.map((pts, i) => (
        <Line key={i} points={pts} color="#22d3ee" lineWidth={3.5} />
      ))}
      {draftPts.length > 1 && <Line points={draftPts} color="#a5f3fc" lineWidth={2.5} dashed dashSize={60} gapSize={40} />}
      {draft.map(([lon, lat], i) => (
        <mesh key={i} position={[proj.x(lon), groundHeight(world, lon, lat) * VEXAG + 12, proj.z(lat)]}>
          <sphereGeometry args={[18, 10, 8]} />
          <meshBasicMaterial color="#cffafe" />
        </mesh>
      ))}
    </group>
  );
}

/** Control-line cells as glowing dots: green = crews get there first, red = the fire does, cyan = built. */
export function ControlLineDots({ world, proj, line, built }: { world: WorldData; proj: Projection; line: Pick<ControlLine, "cells">; built?: boolean }) {
  const points = useMemo(() => {
    const pos = new Float32Array(line.cells.length * 3);
    const col = new Float32Array(line.cells.length * 3);
    const ok = new THREE.Color(built ? "#22d3ee" : "#4ade80");
    const late = new THREE.Color("#f43f5e");
    line.cells.forEach(([lon, lat, feasible], i) => {
      pos.set([proj.x(lon), groundHeight(world, lon, lat) * VEXAG + 15, proj.z(lat)], i * 3);
      const c = feasible ? ok : late;
      col.set([c.r, c.g, c.b], i * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 70, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false });
    return new THREE.Points(g, m);
  }, [world, proj, line, built]);
  return <primitive object={points} />;
}

"use client";

import { Html } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import { minutesBetween, type Detection } from "@/lib/hotspots";
import { groundHeight, Projection, VEXAG, type WorldData } from "@/lib/world";
import type { ReportItem } from "./LivePanel";

/**
 * Satellite detections as glowing columns: yellow when fresh, red within a
 * day, grey after; taller for more intense fires (fire radiative power).
 */
export function HotspotColumns({ world, proj, detections, now }: { world: WorldData; proj: Projection; detections: Detection[]; now: string }) {
  const mesh = useMemo(() => {
    const geo = new THREE.CylinderGeometry(35, 55, 1, 8, 1, true).translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const m = new THREE.InstancedMesh(geo, mat, Math.max(detections.length, 1));
    const o = new THREE.Object3D();
    const fresh = new THREE.Color("#ffe066");
    const day = new THREE.Color("#ff3b1f");
    const old = new THREE.Color("#8a8a8a");
    detections.forEach((d, i) => {
      const age = minutesBetween(d.t, now) / 60;
      o.position.set(proj.x(d.lon), groundHeight(world, d.lon, d.lat) * VEXAG, proj.z(d.lat));
      o.scale.set(1, 250 + Math.min(d.frp, 60) * 25, 1);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      m.setColorAt(i, age < 6 ? fresh.clone().lerp(day, age / 6) : age < 24 ? day : old);
    });
    m.count = detections.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false;
    return m;
  }, [world, proj, detections, now]);
  return <primitive object={mesh} />;
}

const ICON: Record<string, string> = { fire: "🔥", smoke: "💨", spot: "✳️", contained: "✅", crew: "👷", other: "📍" };

/** Field reports as pins with the reporter's note. */
export function ReportPins({ world, proj, reports }: { world: WorldData; proj: Projection; reports: ReportItem[] }) {
  return (
    <group>
      {reports.slice(0, 40).map((r) => (
        <Html key={r.id} position={[proj.x(r.lon), groundHeight(world, r.lon, r.lat) * VEXAG + 60, proj.z(r.lat)]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
          <div className="flex -translate-y-3 flex-col items-center">
            <span className="whitespace-nowrap rounded-full bg-white px-1.5 py-0.5 text-[11px] font-semibold text-ink shadow">
              {ICON[r.type] ?? "📍"} {r.type}
            </span>
            <span className="h-4 w-px bg-white" />
          </div>
        </Html>
      ))}
    </group>
  );
}

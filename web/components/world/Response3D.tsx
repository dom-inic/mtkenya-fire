"use client";

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { Drop, Leg } from "@/lib/suppression";
import { groundHeight, Projection, VEXAG, type WorldData } from "@/lib/world";

/** Aircraft and crews are drawn ~4x life size so they read from a few km away. */
const SCALE = 4;

type Unit = { id: string; kind: "heli" | "tanker"; model?: string };

function helicopter(colour: string) {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.5, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: "#1f2937", roughness: 0.6 });
  const cabin = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 10).scale(1.7, 1, 1), body);
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, 7, 6).rotateZ(Math.PI / 2).translate(-5, 0.4, 0), body);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.8, 0.9).translate(-8.4, 1.1, 0), body);
  const rotor = new THREE.Group();
  rotor.add(new THREE.Mesh(new THREE.BoxGeometry(13, 0.08, 0.5), dark), new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 13), dark));
  rotor.position.y = 1.9;
  rotor.name = "rotor";
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 6, 4).translate(0, -4.5, 0), dark);
  const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.6, 1.2, 10).translate(0, -8, 0), new THREE.MeshStandardMaterial({ color: "#f97316" }));
  g.add(cabin, tail, fin, rotor, line, bucket);
  g.scale.setScalar(SCALE);
  return g;
}

function plane() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: "#facc15", roughness: 0.45, metalness: 0.2 });
  g.add(
    new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.45, 11, 8).rotateZ(Math.PI / 2), paint),
    new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 18).translate(1, 0.2, 0), paint),
    new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.15, 5).translate(-5, 0.6, 0), paint),
    new THREE.Mesh(new THREE.BoxGeometry(1.2, 2, 0.15).translate(-5, 1.4, 0), paint),
  );
  g.scale.setScalar(SCALE);
  return g;
}

const HELI_COLOUR: Record<string, string> = { as350: "#dc2626", mi17: "#556b2f", bell205: "#6b7280" };

/** Position, height above ground and heading of a unit at `now` from its flight legs. */
export function poseAt(legs: Leg[], now: number) {
  if (!legs.length) return null;
  if (now < legs[0].t0) return { lonlat: legs[0].from, agl: 0, heading: 0, parked: true, phase: "ferry" as Leg["phase"] };
  let k = legs.findIndex((l) => now < l.t1);
  if (k < 0) k = legs.length - 1;
  const l = legs[k];
  const f = l.t1 > l.t0 ? Math.min(Math.max((now - l.t0) / (l.t1 - l.t0), 0), 1) : 1;
  const lonlat: [number, number] = [l.from[0] + (l.to[0] - l.from[0]) * f, l.from[1] + (l.to[1] - l.from[1]) * f];
  const heading = Math.atan2(l.to[0] - l.from[0], l.to[1] - l.from[1]);
  const moving = l.phase === "ferry" || l.phase === "loaded" || l.phase === "empty";
  const agl = moving ? 40 + 260 * Math.pow(Math.sin(Math.PI * f), 0.6) : l.phase === "fill" ? 25 : 0;
  return { lonlat, agl, heading, parked: now >= l.t1 && k === legs.length - 1, phase: l.phase };
}

export function Aircraft({ world, proj, units, legs, now }: { world: WorldData; proj: Projection; units: Unit[]; legs: Leg[]; now: number }) {
  const models = useMemo(() => units.map((u) => ({ u, obj: u.kind === "heli" ? helicopter(HELI_COLOUR[u.model ?? "as350"] ?? "#dc2626") : plane() })), [units]);
  const byUnit = useMemo(() => {
    const m = new Map<string, Leg[]>();
    for (const l of legs) (m.get(l.unit) ?? m.set(l.unit, []).get(l.unit)!).push(l);
    for (const v of m.values()) v.sort((a, b) => a.t0 - b.t0);
    return m;
  }, [legs]);
  const nowRef = useRef(now);
  nowRef.current = now;
  const labels = useRef<(HTMLDivElement | null)[]>([]);

  useFrame((_, dt) => {
    models.forEach(({ u, obj }, i) => {
      const p = poseAt(byUnit.get(u.id) ?? [], nowRef.current);
      const label = labels.current[i];
      if (!p) {
        obj.visible = false;
        if (label) label.style.display = "none";
        return;
      }
      obj.visible = true;
      if (label) label.style.display = "block";
      const [lon, lat] = p.lonlat;
      obj.position.set(proj.x(lon), groundHeight(world, lon, lat) * VEXAG + 8 + p.agl, proj.z(lat));
      obj.rotation.y = p.heading - Math.PI / 2;
      const rotor = obj.getObjectByName("rotor");
      if (rotor && !p.parked) rotor.rotation.y += dt * 40;
    });
  });

  return (
    <group>
      {models.map(({ u, obj }, i) => (
        <primitive key={u.id} object={obj}>
          <Html position={[0, 6, 0]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
            <div ref={(el) => { labels.current[i] = el; }} className="whitespace-nowrap rounded bg-sky-700/85 px-1 py-px text-[10px] font-semibold text-white">
              {u.id}
            </div>
          </Html>
        </primitive>
      ))}
    </group>
  );
}

/** Where a crew is at `now` along its track of [t, lon, lat] points. */
export function crewAt(pts: [number, number, number][], t: number): [number, number] | null {
  if (!pts.length) return null;
  let k = pts.findIndex((p) => p[0] > t);
  if (k < 0) k = pts.length;
  const a = pts[Math.max(k - 1, 0)];
  const b = pts[Math.min(k, pts.length - 1)];
  const f = b[0] > a[0] ? Math.min(Math.max((t - a[0]) / (b[0] - a[0]), 0), 1) : 0;
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Ground crews: a marker moving along each crew's route, then along the line it cuts. */
export function Crews({ world, proj, tracks, now }: { world: WorldData; proj: Projection; tracks: { unit: string; points: [number, number, number][] }[]; now: number }) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const nowRef = useRef(now);
  nowRef.current = now;
  useFrame(() => {
    tracks.forEach((tr, i) => {
      const g = refs.current[i];
      const pts = tr.points;
      if (!g || !pts.length) return;
      const t = nowRef.current;
      g.visible = t >= pts[0][0] - 1;
      const [lon, lat] = crewAt(pts, t)!;
      g.position.set(proj.x(lon), groundHeight(world, lon, lat) * VEXAG, proj.z(lat));
    });
  });
  return (
    <group>
      {tracks.map((tr, i) => (
        <group key={tr.unit} ref={(el) => { refs.current[i] = el; }} visible={false}>
          {[[-6, 0], [6, 0], [0, 7], [0, -7], [0, 0]].map(([x, z], k) => (
            <mesh key={k} position={[x * SCALE * 0.6, 4 * SCALE * 0.6, z * SCALE * 0.6]}>
              <capsuleGeometry args={[1.2 * SCALE * 0.6, 3 * SCALE * 0.6, 3, 6]} />
              <meshStandardMaterial color="#f59e0b" emissive="#b45309" emissiveIntensity={0.6} />
            </mesh>
          ))}
          <Html position={[0, 40, 0]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
            <div className="whitespace-nowrap rounded bg-amber-600/90 px-1 py-px text-[10px] font-semibold text-white">{tr.unit}</div>
          </Html>
        </group>
      ))}
    </group>
  );
}

const BURST = 70;
const MAX_BURSTS = 12;

const burstVert = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aLife; attribute vec3 aColour;
varying float vLife; varying vec3 vColour;
uniform float uScale;
void main() {
  vLife = aLife; vColour = aColour;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uScale * 26.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;
const burstFrag = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vLife; varying vec3 vColour;
void main() {
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5 || vLife <= 0.0) discard;
  gl_FragColor = vec4(vColour, smoothstep(0.5, 0.1, d) * min(vLife, 1.0) * 0.85);
}`;

/** Water (white-blue) and retardant (red) curtains when the replay passes a drop. */
export function DropBursts({ world, proj, drops, now }: { world: WorldData; proj: Projection; drops: Drop[]; now: number }) {
  const n = BURST * MAX_BURSTS;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aLife", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aColour", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return g;
  }, [n]);
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: burstVert, fragmentShader: burstFrag, uniforms: { uScale: { value: 900 } }, transparent: true, depthWrite: false }), []);
  const vel = useMemo(() => new Float32Array(n * 3), [n]);
  const prev = useRef(now);
  const slot = useRef(0);
  const sorted = useMemo(() => [...drops].sort((a, b) => a.t - b.t), [drops]);

  useFrame(({ size }, dt) => {
    mat.uniforms.uScale.value = size.height;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const life = geo.getAttribute("aLife") as THREE.BufferAttribute;
    const col = geo.getAttribute("aColour") as THREE.BufferAttribute;
    // Start a burst for drops the clock just passed (skip big jumps from scrubbing)
    const from = prev.current;
    const to = now;
    if (to > from && to - from < 30) {
      for (const d of sorted) {
        if (d.t <= from) continue;
        if (d.t > to) break;
        for (const [lon, lat] of d.cells) {
          const s0 = (slot.current++ % MAX_BURSTS) * BURST;
          const y = groundHeight(world, lon, lat) * VEXAG;
          const c = d.kind === "water" ? [0.82, 0.92, 1] : [0.86, 0.18, 0.22];
          for (let k = 0; k < BURST; k++) {
            const i = s0 + k;
            pos.setXYZ(i, proj.x(lon) + (Math.random() - 0.5) * 30, y + 60 + Math.random() * 20, proj.z(lat) + (Math.random() - 0.5) * 30);
            vel[i * 3] = (Math.random() - 0.5) * 30;
            vel[i * 3 + 1] = -25 - Math.random() * 30;
            vel[i * 3 + 2] = (Math.random() - 0.5) * 30;
            life.setX(i, 1.6);
            col.setXYZ(i, c[0], c[1], c[2]);
          }
        }
      }
    }
    prev.current = to;
    for (let i = 0; i < n; i++) {
      const l = life.getX(i);
      if (l <= 0) continue;
      life.setX(i, l - dt);
      pos.setXYZ(i, pos.getX(i) + vel[i * 3] * dt, pos.getY(i) + vel[i * 3 + 1] * dt, pos.getZ(i) + vel[i * 3 + 2] * dt);
    }
    pos.needsUpdate = true;
    life.needsUpdate = true;
    col.needsUpdate = true;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

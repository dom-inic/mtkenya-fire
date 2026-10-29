"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Weather } from "@/lib/data";
import type { HourWeather } from "@/lib/engine";
import { groundHeight, Projection, VEXAG, type Raster, type WorldData } from "@/lib/world";

/** Burned cells of the fire grid with their arrival minute, sorted by time. */
function fireCells(world: WorldData, proj: Projection, f: Raster<Float32Array> | null) {
  if (!f) return { t: new Float32Array(0), xyz: new Float32Array(0) };
  const t: number[] = [];
  const xyz: number[] = [];
  const dLon = (f.bbox.east - f.bbox.west) / f.w;
  const dLat = (f.bbox.north - f.bbox.south) / f.h;
  const order: number[] = [];
  for (let i = 0; i < f.data.length; i++) if (Number.isFinite(f.data[i])) order.push(i);
  order.sort((a, b) => f.data[a] - f.data[b]);
  for (const i of order) {
    const x = i % f.w;
    const y = Math.floor(i / f.w);
    const lon = f.bbox.west + (x + 0.5) * dLon;
    const lat = f.bbox.north - (y + 0.5) * dLat;
    t.push(f.data[i]);
    xyz.push(proj.x(lon), groundHeight(world, lon, lat) * VEXAG, proj.z(lat));
  }
  return { t: Float32Array.from(t), xyz: Float32Array.from(xyz) };
}

/** Index range of cells that caught fire in (from, to] minutes. */
function range(t: Float32Array, from: number, to: number): [number, number] {
  const lo = (v: number) => {
    let a = 0;
    let b = t.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (t[m] <= v) a = m + 1;
      else b = m;
    }
    return a;
  };
  return [lo(from), lo(to)];
}

const SMOKE = 2600;
const FLAMES = 1800;

// The scene uses a logarithmic depth buffer, so custom shaders must write it too
const smokeVert = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAge; attribute float aSeed;
uniform float uScale;
varying float vAge; varying float vSeed;
void main() {
  vAge = aAge; vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uScale * (90.0 + 900.0 * aAge) / -mv.z;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const smokeFrag = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uNight;
varying float vAge; varying float vSeed;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.05, d);
  float alpha = soft * smoothstep(0.0, 0.08, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge)) * 0.6;
  vec3 base = mix(vec3(0.36, 0.34, 0.33), vec3(0.58, 0.56, 0.54), vSeed);
  // Lit orange from below near the fire, darker at night
  vec3 col = mix(vec3(1.0, 0.5, 0.18), base, smoothstep(0.0, 0.25, vAge));
  col *= mix(1.0, 0.35, uNight);
  gl_FragColor = vec4(col, alpha);
}`;

const flameVert = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAge; attribute float aSeed;
uniform float uScale;
varying float vAge;
void main() {
  vAge = aAge;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uScale * (34.0 + 28.0 * aSeed) * (1.0 - aAge) / -mv.z;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const flameFrag = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vAge;
void main() {
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d) * (1.0 - vAge);
  vec3 col = mix(vec3(1.0, 0.62, 0.22), vec3(0.9, 0.2, 0.03), vAge);
  gl_FragColor = vec4(col, a * 0.8);
}`;

interface Particles {
  pos: Float32Array;
  vel: Float32Array;
  age: Float32Array;
  life: Float32Array;
  seed: Float32Array;
  geo: THREE.BufferGeometry;
}

function particles(n: number): Particles {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const age = new Float32Array(n).fill(2); // > 1: dead until spawned
  const seed = Float32Array.from({ length: n }, () => Math.random());
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aAge", new THREE.BufferAttribute(age, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  return { pos, vel: new Float32Array(n * 3), age, life: new Float32Array(n).fill(1), seed, geo };
}

export default function Smoke({
  world,
  proj,
  fire,
  minute,
  weather,
  night,
}: {
  world: WorldData;
  proj: Projection;
  fire: Raster<Float32Array> | null;
  minute: number;
  weather: Weather | HourWeather | undefined;
  night: number;
}) {
  const cells = useMemo(() => fireCells(world, proj, fire), [world, proj, fire]);
  const smoke = useMemo(() => particles(SMOKE), []);
  const flames = useMemo(() => particles(FLAMES), []);
  const state = useRef({ minute, weather, night });
  state.current = { minute, weather, night };
  // A different fire (or none): drop every particle from the old one
  useEffect(() => {
    smoke.age.fill(2);
    flames.age.fill(2);
  }, [cells, smoke, flames]);

  const smokeMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: smokeVert,
        fragmentShader: smokeFrag,
        uniforms: { uScale: { value: 900 }, uNight: { value: 0 } },
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  const flameMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: flameVert,
        fragmentShader: flameFrag,
        uniforms: { uScale: { value: 900 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useFrame(({ size }, dt) => {
    const { minute, weather, night } = state.current;
    smokeMat.uniforms.uScale.value = size.height;
    smokeMat.uniforms.uNight.value = night;
    flameMat.uniforms.uScale.value = size.height;
    // Real seconds (capped only for tab switches) so plumes age the same at any frame rate
    const step = Math.min(dt, 0.5);

    // Wind: where the smoke drifts (blowing toward = from + 180°), visual scale
    const speed = ((weather?.wind_kmh ?? 8) / 3.6) * 22;
    const toward = (((weather?.wind_from ?? 120) + 180) * Math.PI) / 180;
    const wx = Math.sin(toward) * speed;
    const wz = -Math.cos(toward) * speed;

    const [a0, a1] = range(cells.t, minute - 90, minute); // burning now
    const [b0, b1] = range(cells.t, minute - 25, minute); // the very front
    const active = a1 - a0;
    const front = b1 - b0 || active;
    const frontStart = b1 - b0 ? b0 : a0;

    const update = (p: Particles, n: number, spawn: (i: number) => boolean, rise: number) => {
      for (let i = 0; i < n; i++) {
        if (p.age[i] >= 1) {
          if (!spawn(i)) {
            p.pos[i * 3 + 1] = -1e6;
            continue;
          }
        } else {
          p.age[i] += step / p.life[i];
          p.pos[i * 3] += (p.vel[i * 3] + wx * p.age[i]) * step;
          p.pos[i * 3 + 1] += p.vel[i * 3 + 1] * step * rise;
          p.pos[i * 3 + 2] += (p.vel[i * 3 + 2] + wz * p.age[i]) * step;
        }
      }
      (p.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (p.geo.getAttribute("aAge") as THREE.BufferAttribute).needsUpdate = true;
    };

    const emit = (p: Particles, i: number, from: number, count: number, life: number, up: number, jitter: number) => {
      const c = from + Math.floor(Math.random() * count);
      p.pos[i * 3] = cells.xyz[c * 3] + (Math.random() - 0.5) * jitter;
      p.pos[i * 3 + 1] = cells.xyz[c * 3 + 1] + 5;
      p.pos[i * 3 + 2] = cells.xyz[c * 3 + 2] + (Math.random() - 0.5) * jitter;
      p.vel[i * 3] = (Math.random() - 0.5) * 30;
      p.vel[i * 3 + 1] = up * (0.6 + Math.random() * 0.8);
      p.vel[i * 3 + 2] = (Math.random() - 0.5) * 30;
      p.age[i] = 0;
      p.life[i] = life * (0.7 + Math.random() * 0.6);
      return true;
    };

    // Spawn a share each frame so the plume streams instead of pulsing
    const smokeRate = active ? Math.min(SMOKE / 4, 120 + active * 0.8) * step : 0;
    let smokeBudget = smokeRate;
    update(smoke, SMOKE, (i) => (smokeBudget-- > 0 && active ? emit(smoke, i, a0, active, 22, 140, 60) : false), 1);
    let flameBudget = active ? FLAMES * step * 1.5 : 0;
    update(flames, FLAMES, (i) => (flameBudget-- > 0 && front ? emit(flames, i, frontStart, front, 1.6, 60, 45) : false), 1);
  });

  return (
    <group>
      <points geometry={smoke.geo} material={smokeMat} frustumCulled={false} />
      <points geometry={flames.geo} material={flameMat} frustumCulled={false} />
    </group>
  );
}

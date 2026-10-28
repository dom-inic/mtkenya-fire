"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { groundHeight, inside, Projection, VEXAG, type Raster, type WorldData } from "@/lib/world";
import { NOISE_GLSL, type FireUniforms } from "./Terrain";

/** Plants are drawn larger than life so they read from a few kilometres up. */
const SIZE = 1.8;

type Kind = "tree" | "bamboo" | "erica" | "shrub" | "groundsel" | "lobelia";

function coloured(g: THREE.BufferGeometry, hex: string) {
  const c = new THREE.Color(hex);
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g.index ? g.toNonIndexed() : g;
}

/** Low-poly plant shapes, base at y = 0, metres. */
function shapes(): Record<Kind, THREE.BufferGeometry> {
  const trunk = (h: number, r: number) => coloured(new THREE.CylinderGeometry(r * 0.7, r, h, 5).translate(0, h / 2, 0), "#5b4330");
  const tree = mergeGeometries([trunk(5, 0.6), coloured(new THREE.ConeGeometry(4.5, 15, 7).translate(0, 12, 0), "#ffffff")]);
  const bamboo = mergeGeometries(
    [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i / 6) * Math.PI * 2;
      return coloured(new THREE.CylinderGeometry(0.18, 0.22, 11 + (i % 3), 4).translate(Math.cos(a) * 1.1, 5.8, Math.sin(a) * 1.1).rotateZ(((i % 3) - 1) * 0.06), "#ffffff");
    }),
  );
  const erica = mergeGeometries([trunk(2.5, 0.35), coloured(new THREE.IcosahedronGeometry(2.6, 0).scale(1, 1.6, 1).translate(0, 5.5, 0), "#ffffff")]);
  const shrub = coloured(new THREE.IcosahedronGeometry(1.4, 0).scale(1.2, 0.75, 1.2).translate(0, 0.8, 0), "#ffffff");
  const groundsel = mergeGeometries([
    trunk(4.5, 0.35),
    coloured(new THREE.ConeGeometry(1.5, 1.2, 8).rotateX(Math.PI).translate(0, 5.2, 0), "#ffffff"),
  ]);
  const lobelia = coloured(new THREE.CylinderGeometry(0.25, 0.45, 2.6, 6).translate(0, 1.3, 0), "#ffffff");
  return { tree, bamboo, erica, shrub, groundsel, lobelia };
}

const PALETTE: Record<Kind, string[]> = {
  tree: ["#2f5a34", "#35663a", "#284d2c", "#3b6b3c"],
  bamboo: ["#7d9a3f", "#8aa646", "#6f8c38"],
  erica: ["#5d6b3a", "#66733f", "#4f5d33"],
  shrub: ["#7f7a45", "#8a8148", "#6f6c3f", "#957f4a"],
  groundsel: ["#6f8a4d", "#7a955a"],
  lobelia: ["#5f7d52", "#6c8a5c"],
};

/** Mulberry32: deterministic so the forest looks the same on every load */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Placement {
  kind: Kind;
  lon: number;
  lat: number;
}

/**
 * Scatter plants by fuel class. Inner zone at 30 m cells, the rest of the
 * forest ring at ~90 m. Elevation splits forest into bamboo and trees, and
 * alpine ground into groundsels and lobelias.
 */
function place(world: WorldData, density: number): Placement[] {
  const out: Placement[] = [];
  const rand = rng(7);
  const scatter = (r: Raster<Uint8Array>, prob: (fuel: number, h: number) => [Kind, number] | null, skip?: (lon: number, lat: number) => boolean) => {
    const dLon = (r.bbox.east - r.bbox.west) / r.w;
    const dLat = (r.bbox.north - r.bbox.south) / r.h;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const lon = r.bbox.west + (x + rand()) * dLon;
        const lat = r.bbox.north - (y + rand()) * dLat;
        if (skip?.(lon, lat)) continue;
        const fuel = r.data[y * r.w + x];
        const h = groundHeight(world, lon, lat);
        const p = prob(fuel, h);
        if (p && rand() < p[1] * density) out.push({ kind: p[0], lon, lat });
      }
    }
  };
  const classify = (fuel: number, h: number, scale: number): [Kind, number] | null => {
    if (fuel === 4) return h > 2450 && h < 3050 ? ["bamboo", 0.16 * scale] : ["tree", 0.2 * scale];
    if (fuel === 3) return ["erica", 0.35 * scale];
    if (fuel === 2) return ["shrub", 0.11 * scale];
    if (fuel === 1) return h > 3900 ? ["groundsel", 0.06 * scale] : rand() < 0.5 ? ["groundsel", 0.05 * scale] : ["lobelia", 0.05 * scale];
    if (fuel === 6) return ["shrub", 0.025 * scale];
    return null;
  };
  scatter(world.fuelInner, (f, h) => classify(f, h, 1));
  scatter(world.fuelOuter, (f, h) => (f === 4 ? classify(f, h, 2.2) : f === 2 || f === 3 ? classify(f, h, 1.2) : null), (lon, lat) => inside(world.meta.inner, lon, lat));
  return out;
}

/** Plants inside the fire grid burn: glow at the front, then char and shrink. */
function burnablePlant(mat: THREE.MeshStandardMaterial, u: FireUniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uArrival; uniform float uNow; uniform float uShowFire; uniform vec4 uFireBox;
varying float vBurn; varying float vFlame; varying vec2 vFireUv;
${NOISE_GLSL}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vBurn = 0.0; vFlame = 0.0;
vec4 origin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
vec2 fuv = fireUv(origin.xz, uFireBox);
vFireUv = fuv;
if (uShowFire > 0.5 && fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0) {
  float arrival = textureLod(uArrival, fuv, 0.0).r;
  float age = (uNow - arrival) / 60.0;
  if (arrival < 1e8 && age > 0.0) {
    vBurn = smoothstep(0.0, 1.5, age);
    vFlame = 1.0 - smoothstep(0.0, 1.2, age);
    transformed.y *= mix(1.0, 0.35, vBurn); // burned to a stump
    transformed.xz *= mix(1.0, 0.55, vBurn);
  }
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uClock;
varying float vBurn; varying float vFlame; varying vec2 vFireUv;
float fireHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float flickerNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fireHash2(i), fireHash2(i + vec2(1, 0)), f.x), mix(fireHash2(i + vec2(0, 1)), fireHash2(i + vec2(1, 1)), f.x), f.y);
}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.04, 0.035), 0.9 * vBurn);
float flick = 0.5 + 0.5 * flickerNoise(vFireUv * 4000.0 + vec2(uClock * 3.0, uClock * -2.0));
totalEmissiveRadiance += vec3(1.0, 0.42, 0.08) * vFlame * flick * 3.0;`,
      );
  };
  mat.customProgramCacheKey = () => "burnable-plant";
}

export default function Vegetation({ world, proj, fire, density = 1 }: { world: WorldData; proj: Projection; fire: FireUniforms; density?: number }) {
  const meshes = useMemo(() => {
    const geos = shapes();
    const all = place(world, density);
    const rand = rng(11);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    return (Object.keys(geos) as Kind[]).map((kind) => {
      const items = all.filter((a) => a.kind === kind);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
      burnablePlant(mat, fire);
      const mesh = new THREE.InstancedMesh(geos[kind], mat, Math.max(items.length, 1));
      const colours = PALETTE[kind].map((c) => new THREE.Color(c));
      items.forEach((a, i) => {
        const scale = SIZE * (0.7 + rand() * 0.6);
        p.set(proj.x(a.lon), groundHeight(world, a.lon, a.lat) * VEXAG - 0.5, proj.z(a.lat));
        q.setFromAxisAngle(up, rand() * Math.PI * 2);
        s.set(scale, scale * (0.85 + rand() * 0.3), scale);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, colours[Math.floor(rand() * colours.length)]);
      });
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.castShadow = kind === "tree" || kind === "bamboo";
      return { kind, mesh, count: items.length };
    });
  }, [world, proj, fire, density]);

  return (
    <group>
      {meshes.map(({ kind, mesh }) => (
        <primitive key={kind} object={mesh} />
      ))}
    </group>
  );
}


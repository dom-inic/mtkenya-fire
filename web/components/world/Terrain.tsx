"use client";

import { useFrame, useLoader, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Projection, VEXAG, type BBox, type Raster, type WorldData } from "@/lib/world";

/**
 * A grid mesh over `r.bbox` with heights from `r`, every `stride` cells.
 * `sink` lowers vertices that fall inside another box (the inner zone) so the
 * sharper inner mesh draws on top without fighting it.
 */
function gridGeometry(r: Raster<Float32Array>, proj: Projection, stride: number, sink?: { box: BBox; margin: number }) {
  const cols = Math.floor((r.w - 1) / stride) + 1;
  const rows = Math.floor((r.h - 1) / stride) + 1;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  const { west, east, north, south } = r.bbox;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const gx = i * stride;
      const gy = j * stride;
      const u = (gx + 0.5) / r.w;
      const v = (gy + 0.5) / r.h;
      const lon = west + u * (east - west);
      const lat = north - v * (north - south);
      let h = r.data[gy * r.w + gx];
      if (sink) {
        const b = sink.box;
        const m = sink.margin;
        if (lon > b.west + m && lon < b.east - m && lat > b.south + m && lat < b.north - m) h -= 60;
      }
      const k = j * cols + i;
      pos[k * 3] = proj.x(lon);
      pos[k * 3 + 1] = h * VEXAG;
      pos[k * 3 + 2] = proj.z(lat);
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - v;
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      index.set([a, c, b, b, c, d], n);
      n += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

/** Rows are stored north first; textures want the south row first (v = 0). */
function flipRows<T extends Float32Array | Uint8Array>(src: T, w: number, h: number, channels = 1): T {
  const out = new (src.constructor as { new (n: number): T })(src.length);
  const row = w * channels;
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

/** Arrival minutes as a float texture (1e9 where the fire never got). */
function fireTexture(fire: Raster<Float32Array>) {
  const data = new Float32Array(fire.data.length);
  for (let i = 0; i < data.length; i++) data[i] = Number.isFinite(fire.data[i]) ? fire.data[i] : 1e9;
  const t = new THREE.DataTexture(flipRows(data, fire.w, fire.h), fire.w, fire.h, THREE.RedFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

function probTexture(prob: Raster<Uint8Array>) {
  const t = new THREE.DataTexture(flipRows(prob.data, prob.w, prob.h), prob.w, prob.h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Shared GLSL: hash noise for ragged fire edges and flicker. */
export const NOISE_GLSL = /* glsl */ `
float fireHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fireNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fireHash(i), fireHash(i + vec2(1, 0)), f.x), mix(fireHash(i + vec2(0, 1)), fireHash(i + vec2(1, 1)), f.x), f.y);
}
// UV of a world position inside the fire grid's box (x west..east, z north..south)
vec2 fireUv(vec2 xz, vec4 box) { return vec2((xz.x - box.x) / (box.z - box.x), (box.w - xz.y) / (box.w - box.y)); }`;

/** A fire on the world: arrival minutes on a lon/lat grid, plus optional burn chance. */
export interface FireLayer {
  arrival: Raster<Float32Array>;
  prob?: Raster<Uint8Array> | null;
  /** Response on the ground, same grid: held [from, until) and kind (1 water, 2 retardant, 3 cut line) */
  block?: { from: Float32Array; until: Float32Array; kind: Uint8Array } | null;
}

function blockTexture(b: NonNullable<FireLayer["block"]>, w: number, h: number) {
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < b.kind.length; i++) {
    if (!b.kind[i]) continue;
    data[i * 4] = b.from[i];
    data[i * 4 + 1] = Number.isFinite(b.until[i]) ? b.until[i] : 1e9;
    data[i * 4 + 2] = b.kind[i];
  }
  const t = new THREE.DataTexture(flipRows(data, w, h, 4), w, h, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export interface FireUniforms {
  uArrival: { value: THREE.Texture | null };
  uProb: { value: THREE.Texture | null };
  uFireBox: { value: THREE.Vector4 };
  uNow: { value: number };
  uClock: { value: number };
  uShowFire: { value: number };
  uShowProb: { value: number };
  uBlock: { value: THREE.Texture | null };
  uShowBlock: { value: number };
}

export function makeFireUniforms(): FireUniforms {
  return {
    uArrival: { value: null },
    uProb: { value: null },
    uFireBox: { value: new THREE.Vector4(0, 0, 1, 1) },
    uNow: { value: 0 },
    uClock: { value: 0 },
    uShowFire: { value: 0 },
    uShowProb: { value: 0 },
    uBlock: { value: null },
    uShowBlock: { value: 0 },
  };
}

/** Point the fire shaders at a new fire (or none). */
export function setFire(u: FireUniforms, layer: FireLayer | null, proj: Projection) {
  u.uArrival.value?.dispose();
  u.uProb.value?.dispose();
  u.uBlock.value?.dispose();
  u.uArrival.value = layer ? fireTexture(layer.arrival) : null;
  u.uProb.value = layer?.prob ? probTexture(layer.prob) : null;
  u.uBlock.value = layer?.block ? blockTexture(layer.block, layer.arrival.w, layer.arrival.h) : null;
  u.uShowBlock.value = layer?.block ? 1 : 0;
  if (layer) {
    const b = layer.arrival.bbox;
    u.uFireBox.value.set(proj.x(b.west), proj.z(b.north), proj.x(b.east), proj.z(b.south));
  }
  u.uShowFire.value = layer ? 1 : 0;
}

/** Patch a MeshStandardMaterial so ground burns: charred behind the front, glowing at it. */
function burnable(mat: THREE.MeshStandardMaterial, u: FireUniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFireXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFireXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uArrival; uniform sampler2D uProb; uniform sampler2D uBlock; uniform vec4 uFireBox;
uniform float uNow; uniform float uClock; uniform float uShowFire; uniform float uShowProb; uniform float uShowBlock;
varying vec2 vFireXZ;
${NOISE_GLSL}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
vec2 fuv = fireUv(vFireXZ, uFireBox);
if (uShowFire > 0.5 && fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0) {
  vec2 n = vFireXZ / 60.0; // noise in 60 m cells
  float arrival = texture2D(uArrival, fuv).r;
  // The response on the ground: wet (blue-grey), retardant (red), cut line (bare soil)
  if (uShowBlock > 0.5) {
    vec4 b = texture2D(uBlock, fuv);
    if (b.b > 0.5 && b.r <= uNow && uNow < b.g && uNow < arrival) {
      if (b.b < 1.5) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.45, 0.55, 0.75), 0.8);
      else if (b.b < 2.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.16, 0.2), 0.7);
      else diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.74, 0.52), 0.85);
    }
  }
  // Jitter the threshold so the front isn't a staircase of 60 m cells
  float jitter = (fireNoise(n * 2.3) - 0.5) * 70.0;
  float age = (uNow - arrival + jitter) / 60.0; // hours since burning
  if (arrival < 1e8 && age > 0.0) {
    float char = smoothstep(0.0, 2.0, age);
    // Burned ground: the real imagery darkened and cooled, a little mottled
    float mottle = 0.75 + 0.5 * fireNoise(n * 1.6);
    vec3 burnt = diffuseColor.rgb * vec3(0.24, 0.21, 0.19) * mottle + vec3(0.018, 0.014, 0.012);
    diffuseColor.rgb = mix(diffuseColor.rgb, burnt, char);
    float flame = 1.0 - smoothstep(0.0, 1.4, age);
    float flicker = 0.55 + 0.45 * fireNoise(n * 4.6 + vec2(uClock * 1.7, -uClock * 2.3));
    totalEmissiveRadiance += vec3(1.0, 0.32, 0.04) * flame * flicker * 1.8;
    // Smouldering embers for a few hours after
    float ember = (1.0 - smoothstep(1.0, 5.0, age)) * smoothstep(0.9, 0.97, fireNoise(n * 3.1 + uClock * 0.15));
    totalEmissiveRadiance += vec3(0.8, 0.18, 0.02) * ember * 0.6;
  } else if (uShowProb > 0.5) {
    // Chance of burning (ensemble) on ground not yet burned
    float p = texture2D(uProb, fuv).r;
    if (p > 0.02) {
      vec3 heat = mix(vec3(1.0, 0.85, 0.2), vec3(0.85, 0.05, 0.25), smoothstep(0.3, 1.0, p));
      diffuseColor.rgb = mix(diffuseColor.rgb, heat, 0.25 + 0.4 * p);
      totalEmissiveRadiance += heat * 0.12 * p;
    }
  }
}`,
      );
  };
  mat.customProgramCacheKey = () => "burnable";
}

export default function Terrain({
  world,
  proj,
  fire,
  view,
  onGround,
}: {
  world: WorldData;
  proj: Projection;
  fire: FireUniforms;
  view: "imagery" | "fuels";
  onGround?: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const [outerImg, innerImg] = useLoader(THREE.TextureLoader, [`/data/world/${world.meta.imagery.outer}`, `/data/world/${world.meta.imagery.inner}`]);
  for (const t of [outerImg, innerImg]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  }

  const fuelTex = useMemo(() => ({ outer: fuelTexture(world.fuelOuter), inner: fuelTexture(world.fuelInner) }), [world]);

  const outerGeo = useMemo(
    () => gridGeometry(world.heightsOuter, proj, 2, { box: world.meta.inner, margin: 0.004 }),
    [world, proj],
  );
  const innerGeo = useMemo(() => gridGeometry(world.heightsInner, proj, 2), [world, proj]);

  const outerMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    burnable(m, fire);
    return m;
  }, [fire]);
  const innerMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    burnable(m, fire);
    return m;
  }, [fire]);

  outerMat.map = view === "imagery" ? outerImg : fuelTex.outer;
  innerMat.map = view === "imagery" ? innerImg : fuelTex.inner;
  outerMat.needsUpdate = true;
  innerMat.needsUpdate = true;

  return (
    <group>
      <mesh geometry={outerGeo} material={outerMat} receiveShadow onClick={onGround} />
      <mesh geometry={innerGeo} material={innerMat} receiveShadow onClick={onGround} />
    </group>
  );
}

const FUEL_RGB: Record<number, [number, number, number]> = {
  0: [130, 128, 124],
  1: [212, 190, 92],
  2: [196, 132, 62],
  3: [140, 94, 52],
  4: [44, 104, 60],
  5: [196, 168, 204],
  6: [168, 190, 96],
};

function fuelTexture(r: Raster<Uint8Array>) {
  const data = new Uint8Array(r.w * r.h * 4);
  for (let i = 0; i < r.data.length; i++) {
    const c = FUEL_RGB[r.data[i]] ?? [0, 0, 0];
    data.set([c[0], c[1], c[2], 255], i * 4);
  }
  const t = new THREE.DataTexture(flipRows(data, r.w, r.h, 4), r.w, r.h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/** Advance the fire clock every frame. */
export function useFireClock(fire: FireUniforms, minute: number) {
  const clock = useRef(0);
  useFrame((_, dt) => {
    clock.current += dt;
    fire.uNow.value = minute;
    fire.uClock.value = clock.current;
  });
}


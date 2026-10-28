"use client";

import mapboxgl, { type ExpressionSpecification, type StyleSpecification } from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import { ELEVATION, GLYPHS, IMAGERY } from "@/lib/basemap";
import type { Drone, FireData } from "@/lib/data";
import type { Detection, DroneState } from "@/lib/drones";
import { fmtDayTime, fromMinutes } from "@/lib/time";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
type Mode = "eo" | "white" | "ironbow";
const M_PER_DEG = 111_320;

/** Ground colour and fire colour (by hours since burning) per sensor mode. */
const PALETTES: Record<Mode, { ground: Record<string, unknown>; fire: [number, string][]; sky: string; fog: string }> = {
  eo: { ground: {}, fire: [[0, "#fff1a8"], [1, "#ff9f1c"], [3, "#d9480f"], [12, "#3b1f17"]], sky: "#c8d6e5", fog: "#d9d4cc" },
  white: {
    ground: { "raster-saturation": -1, "raster-brightness-max": 0.32, "raster-contrast": 0.25 },
    fire: [[0, "#ffffff"], [1, "#e5e5e5"], [3, "#a3a3a3"], [12, "#5c5c5c"]],
    sky: "#101010",
    fog: "#2a2a2a",
  },
  ironbow: {
    ground: {
      "raster-color-mix": [0.2126, 0.7152, 0.0722, 0],
      "raster-color-range": [0, 1],
      "raster-color": ["interpolate", ["linear"], ["raster-value"], 0, "#09021a", 0.3, "#2b0b4f", 0.6, "#4c1470", 1, "#7a1e7a"],
    },
    fire: [[0, "#fffbd1"], [1, "#ffc21a"], [3, "#f05a22"], [12, "#8f2a6b"]],
    sky: "#0b0420",
    fog: "#2b0b4f",
  },
};
const GROUND_PROPS = [...new Set(Object.values(PALETTES).flatMap((p) => Object.keys(p.ground)))];

function fireColour(mode: Mode, h: number): ExpressionSpecification {
  const stops = PALETTES[mode].fire.flatMap(([a, c]) => [a, c]);
  return ["interpolate", ["linear"], ["-", h, ["get", "h"]], ...stops] as ExpressionSpecification;
}

function cameraStyle(data: FireData, mode: Mode, h: number): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      sat: IMAGERY,
      dem: ELEVATION,
      bands: { type: "geojson", data: data.bands },
    },
    terrain: { source: "dem", exaggeration: 1 },
    fog: { range: [4, 20], color: PALETTES[mode].fog, "horizon-blend": 0.15 },
    layers: [
      { id: "sky", type: "background", paint: { "background-color": PALETTES[mode].sky } },
      { id: "ground", type: "raster", source: "sat", paint: PALETTES[mode].ground as never },
      { id: "fire", type: "fill", source: "bands", filter: ["<=", ["get", "h"], h], paint: { "fill-antialias": false, "fill-color": fireColour(mode, h) } },
    ],
  };
}

export default function DroneCam({
  data,
  drone,
  state,
  detection,
  minute,
  onClose,
}: {
  data: FireData;
  drone: Drone;
  state: DroneState | null;
  detection: Detection | null;
  minute: number;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [mode, setMode] = useState<Mode>("ironbow");
  const [ready, setReady] = useState(false);

  const modeRef = useRef(mode);
  const minuteRef = useRef(minute);
  minuteRef.current = minute;

  // One camera map for the component's life; sensor modes restyle it in place
  useEffect(() => {
    if (!container.current || !TOKEN) return;
    const map = new mapboxgl.Map({ accessToken: TOKEN, container: container.current, style: cameraStyle(data, modeRef.current, minuteRef.current / 60), interactive: false, attributionControl: false, center: [37.46, -0.06], zoom: 14, pitch: 60 });
    mapRef.current = map;
    map.on("load", () => setReady(true));
    return () => {
      setReady(false);
      mapRef.current = null;
      map.remove();
    };
  }, [data]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || modeRef.current === mode) return;
    modeRef.current = mode;
    const p = PALETTES[mode];
    for (const prop of GROUND_PROPS) map.setPaintProperty("ground", prop as never, (p.ground[prop] ?? null) as never);
    map.setPaintProperty("sky", "background-color", p.sky);
    map.setFog({ range: [4, 20], color: p.fog, "horizon-blend": 0.15 });
  }, [mode, ready]);

  // Fire colours by age, and the camera pose
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !state) return;
    const h = minute / 60;
    map.setFilter("fire", ["<=", ["get", "h"], h]);
    map.setPaintProperty("fire", "fill-color", fireColour(mode, h));

    // Gimbal: point at the detection if there is one, else 600 m ahead
    let bearing = state.heading;
    let ground = 600;
    if (detection) {
      const dn = (detection.lat - state.lat) * M_PER_DEG;
      const de = (detection.lon - state.lon) * M_PER_DEG * Math.cos((state.lat * Math.PI) / 180);
      bearing = (Math.atan2(de, dn) * 180) / Math.PI;
      ground = Math.max(Math.hypot(dn, de), 150);
    }
    const down = (Math.atan2(drone.agl, ground) * 180) / Math.PI;
    const cam = map.getFreeCameraOptions();
    // Browsers that block Canvas2D readback (e.g. Brave fingerprinting
    // protection) get no terrain; then fly at height above a flat ground
    const altitude = map.getTerrain() ? state.alt : drone.agl;
    cam.position = mapboxgl.MercatorCoordinate.fromLngLat([state.lon, state.lat], altitude);
    cam.setPitchBearing(Math.min(Math.max(90 - down, 20), 80), bearing);
    map.setFreeCameraOptions(cam);
  }, [minute, ready, state, detection, mode, drone.agl]);

  const time = fmtDayTime(fromMinutes(minute, data.incident.meta.start));
  const hud = mode === "eo" ? "text-white" : "text-[#e9e3ff]";

  return (
    <div className="pointer-events-auto w-[420px] overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-black/40">
      <div className="relative aspect-[16/10]">
        {/* mapbox's CSS makes the map element position: relative, so size it from a wrapper */}
        <div className="absolute inset-0">
          <div ref={container} className="h-full w-full" />
        </div>
        {!state && <div className="absolute inset-0 grid place-items-center text-xs text-stone-400">On standby · deploys {data.drones.deploy[0].replace("T", " ")}</div>}
        {/* HUD */}
        <div className={`pointer-events-none absolute inset-0 font-mono text-[10px] leading-tight ${hud}`} style={{ textShadow: "0 0 3px #000" }}>
          <div className="absolute top-2 left-2">
            <span className="text-red-400">● REC</span> {drone.id} {drone.name.toUpperCase()}
            <br />
            {mode === "eo" ? "EO · DAY" : mode === "white" ? "IR · WHITE HOT" : "IR · IRONBOW"}
          </div>
          <div className="absolute top-2 right-2 text-right">
            {time} EAT
            <br />
            {drone.mission.toUpperCase()}
          </div>
          {state && (
            <>
              <div className="absolute bottom-2 left-2">
                ALT {Math.round(drone.agl * 3.281).toLocaleString()} FT AGL
                <br />
                GS {Math.round(state.speedKmh / 1.852)} KT · HDG {String(Math.round(state.heading)).padStart(3, "0")}°
              </div>
              <div className="absolute bottom-2 right-2 text-right">
                BAT {state.battery}%
                <br />
                {detection
                  ? `SPI ${Math.abs(detection.lat).toFixed(4)}S ${detection.lon.toFixed(4)}E · ${detection.tempC} °C`
                  : `${Math.abs(state.lat).toFixed(4)}S ${state.lon.toFixed(4)}E`}
              </div>
            </>
          )}
          <div className="absolute top-1/2 left-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2">
            <div className="absolute top-1/2 left-0 h-px w-full bg-current opacity-70" />
            <div className="absolute top-0 left-1/2 h-full w-px bg-current opacity-70" />
          </div>
          {detection && (
            <div className="absolute top-8 left-1/2 -translate-x-1/2 rounded bg-red-600/80 px-1.5 py-0.5 text-white">
              HOT SPOT {detection.tempC} °C · {detection.distanceM} m
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 border-t border-white/10 bg-stone-900 px-2 py-1.5 text-[11px] text-stone-300">
        <span className="mr-1 font-medium text-white">
          {drone.id} {drone.name}
        </span>
        {(["eo", "white", "ironbow"] as Mode[]).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={`rounded px-1.5 py-0.5 ${mode === m ? "bg-fire text-white" : "hover:bg-white/10"}`}>
            {m === "eo" ? "EO" : m === "white" ? "IR white-hot" : "IR ironbow"}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-stone-500">simulated feed</span>
        <button onClick={onClose} className="ml-1 rounded px-1.5 hover:bg-white/10" aria-label="Close camera">
          ✕
        </button>
      </div>
    </div>
  );
}

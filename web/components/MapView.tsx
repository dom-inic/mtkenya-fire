"use client";

import mapboxgl, { type ExpressionSpecification, type FilterSpecification, type GeoJSONSource } from "mapbox-gl";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { useEffect, useRef, useState } from "react";
import { satelliteStyle } from "@/lib/basemap";
import type { FireData } from "@/lib/data";
import { droneState } from "@/lib/drones";
import type { LayerId, LayerState } from "@/lib/layers";
import { fmtIso, fromMinutes, fmtDayTime, toMinutes } from "@/lib/time";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

/** Map layers belonging to each panel entry. */
const GROUPS: Record<LayerId, string[]> = {
  sim: ["sim-fill", "sim-front"],
  fronts: ["fronts-line", "fronts-label"],
  path: ["path-line", "path-dots", "path-label", "ignition-glow", "ignition-dot", "ignition-label"],
  observed: ["observed-line", "observed-label", "observed-final"],
  hotspots: ["hotspots-glow", "hotspots-dot"],
  severity: ["img-severity"],
  falsecolour: ["img-falsecolour"],
  arrival: ["img-arrival"],
  fuels: ["img-fuels"],
  drones: ["drone-trails", "drone-dots", "drone-labels"],
  places: ["places-dot", "places-label"],
};

const RASTERS: Partial<Record<LayerId, string>> = {
  severity: "img-severity",
  falsecolour: "img-falsecolour",
  arrival: "img-arrival",
  fuels: "img-fuels",
};

export interface Hover {
  x: number;
  y: number;
  lon: number;
  lat: number;
  elevation: number | null;
  burnedAt: string | null;
}

interface Props {
  data: FireData;
  minute: number;
  layers: LayerState;
  mode3d: boolean;
  selectedDrone: string | null;
  focus: { lon: number; lat: number; zoom?: number; key: number } | null;
}

function pathFeatures(data: FireData): FeatureCollection {
  const start = data.incident.meta.start;
  const pts = data.incident.sim.path;
  const features: Feature[] = [];
  pts.forEach((p, i) => {
    const m = toMinutes(p.t, start);
    if (i > 0) {
      const a = pts[i - 1];
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [p.lon, p.lat]] } as LineString,
        properties: { m, kind: "segment" },
      });
    }
    if (i > 0 && i % 2 === 0) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] } as Point,
        properties: { m, kind: "dot", label: fmtIso(p.t) },
      });
    }
  });
  return { type: "FeatureCollection", features };
}

/** Fire colour and opacity by hours since burning, at replay hour `h`. */
function simPaint(h: number, opacity: number) {
  const age: ExpressionSpecification = ["-", h, ["get", "h"]];
  return {
    color: ["interpolate", ["linear"], age, 0, "#fff3b0", 1, "#ffb703", 3, "#fb5607", 10, "#9d0208", 30, "#3d1f14"] as ExpressionSpecification,
    opacity: ["interpolate", ["linear"], age, 0, opacity, 30, opacity * 0.72] as ExpressionSpecification,
  };
}

function pointCollection(items: { lon: number; lat: number; [k: string]: unknown }[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map(({ lon, lat, ...props }) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: props,
    })),
  };
}

export default function MapView({ data, minute, layers, mode3d, selectedDrone, focus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const minuteRef = useRef(minute);
  minuteRef.current = minute;

  // Create the map once
  useEffect(() => {
    if (!container.current || !TOKEN) return;
    const { incident } = data;
    const map = new mapboxgl.Map({
      accessToken: TOKEN,
      container: container.current,
      style: satelliteStyle(),
      center: [37.452, -0.058],
      zoom: 12.4,
      pitch: 58,
      bearing: 232, // looking south-west from the fire toward the peaks
      maxPitch: 72, // steeper views pull in far more horizon tiles
      antialias: true,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-left");
    map.addControl(new mapboxgl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("style.load", () => {
      map.setTerrain({ source: "dem", exaggeration: 1.4 });
      map.setFog({ range: [0.8, 9], color: "#e9e4dc", "high-color": "#9fb7d6", "horizon-blend": 0.12, "space-color": "#c9d8ea", "star-intensity": 0 });

      // Raster overlays (Sentinel-2 + model rasters)
      const img = (id: string, file: string, coords: number[][]) => {
        map.addSource(id, { type: "image", url: `/data/${file}`, coordinates: coords as never });
        map.addLayer({ id: `img-${id}`, type: "raster", source: id, layout: { visibility: "none" }, paint: { "raster-opacity": 0.8, "raster-fade-duration": 0, "raster-resampling": "nearest" } });
      };
      img("fuels", "fuels.png", incident.fuels_corners);
      img("falsecolour", "s2_falsecolour_20260919.webp", incident.sentinel.overlays.s2_falsecolour);
      img("arrival", "sim_arrival.png", incident.sim.arrival_corners);
      img("severity", "burn_severity.png", incident.sentinel.overlays.burn_severity);

      // Modelled spread: hourly bands coloured by how long ago they burned
      map.addSource("bands", { type: "geojson", data: data.bands });
      // Created with the same data-driven expressions the replay updates, so the
      // paint never switches from constant to data-driven mid-render
      const initial = simPaint(minuteRef.current / 60, 0.9);
      map.addLayer({ id: "sim-fill", type: "fill", source: "bands", filter: ["<=", ["get", "h"], minuteRef.current / 60], paint: { "fill-color": initial.color, "fill-opacity": initial.opacity, "fill-emissive-strength": 1, "fill-antialias": false } });
      map.addLayer({ id: "sim-front", type: "line", source: "bands", paint: { "line-color": "#ffe08a", "line-width": 2.2, "line-blur": 1.5, "line-emissive-strength": 1 } });

      map.addSource("fronts", { type: "geojson", data: { ...data.isochrones, features: data.isochrones.features.map((f) => ({ ...f, properties: { ...f.properties, label: fmtIso(f.properties.t) } })) } });
      map.addLayer({ id: "fronts-line", type: "line", source: "fronts", paint: { "line-color": "#fde68a", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.85, "line-emissive-strength": 1 } });
      map.addLayer({ id: "fronts-label", type: "symbol", source: "fronts", layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 10.5, "symbol-spacing": 420 }, paint: { "text-color": "#fff7d6", "text-halo-color": "rgba(40,20,10,0.85)", "text-halo-width": 1.4, "text-emissive-strength": 1 } });

      // Sentinel-2: latest dated perimeter + final scar
      map.addSource("observed", { type: "geojson", data: data.observed });
      map.addLayer({ id: "observed-final", type: "line", source: "observed", filter: ["==", ["get", "kind"], "final_perimeter"], paint: { "line-color": "#bfdbfe", "line-width": 1, "line-dasharray": [1, 2], "line-opacity": 0.7, "line-emissive-strength": 1 } });
      map.addLayer({ id: "observed-line", type: "line", source: "observed", filter: ["==", ["get", "m"], -1], paint: { "line-color": "#60a5fa", "line-width": 2.2, "line-emissive-strength": 1 } });
      map.addLayer({ id: "observed-label", type: "symbol", source: "observed", filter: ["==", ["get", "m"], -1], layout: { "symbol-placement": "line", "text-field": ["concat", "Sentinel-2 · ", ["get", "date"]], "text-size": 10.5, "symbol-spacing": 600 }, paint: { "text-color": "#dbeafe", "text-halo-color": "rgba(10,20,50,0.85)", "text-halo-width": 1.4, "text-emissive-strength": 1 } });

      // FIRMS hotspots
      map.addSource("hotspots", { type: "geojson", data: data.hotspots });
      map.addLayer({ id: "hotspots-glow", type: "circle", source: "hotspots", paint: { "circle-opacity": ["interpolate", ["linear"], ["-", minuteRef.current, ["get", "m"]], 0, 0.7, 24 * 60, 0.05], "circle-color": "#ff3d00", "circle-radius": ["interpolate", ["linear"], ["get", "frp"], 0, 5, 100, 12], "circle-blur": 1, "circle-pitch-alignment": "map", "circle-emissive-strength": 1 } });
      map.addLayer({ id: "hotspots-dot", type: "circle", source: "hotspots", paint: { "circle-color": ["case", ["get", "this_fire"], "#fff1e6", "#d4d4d4"], "circle-radius": 3.5, "circle-stroke-color": "#dc2626", "circle-stroke-width": 1.5, "circle-pitch-alignment": "map", "circle-emissive-strength": 1 } });

      // Spread path + ignition
      map.addSource("path", { type: "geojson", data: pathFeatures(data) });
      map.addLayer({ id: "path-line", type: "line", source: "path", filter: ["==", ["get", "kind"], "segment"], paint: { "line-color": "#facc15", "line-width": 2.4, "line-dasharray": [1.5, 1.2], "line-emissive-strength": 1 } });
      map.addLayer({ id: "path-dots", type: "circle", source: "path", filter: ["==", ["get", "kind"], "dot"], paint: { "circle-color": "#facc15", "circle-radius": 4.5, "circle-stroke-color": "#713f12", "circle-stroke-width": 1.5, "circle-emissive-strength": 1 } });
      map.addLayer({ id: "path-label", type: "symbol", source: "path", filter: ["==", ["get", "kind"], "dot"], layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0.8, 0], "text-anchor": "left" }, paint: { "text-color": "#fffbeb", "text-halo-color": "rgba(60,30,0,0.9)", "text-halo-width": 1.5, "text-emissive-strength": 1 } });

      map.addSource("ignition", { type: "geojson", data: pointCollection(incident.sim.ignitions.map((i) => ({ lon: i.lon, lat: i.lat, m: toMinutes(i.t, incident.meta.start), label: `Ignition (est.)\n${fmtIso(i.t)}` }))) });
      map.addLayer({ id: "ignition-glow", type: "circle", source: "ignition", paint: { "circle-color": "#ffedd5", "circle-radius": 18, "circle-blur": 1, "circle-emissive-strength": 1 } });
      map.addLayer({ id: "ignition-dot", type: "circle", source: "ignition", paint: { "circle-color": "#ea580c", "circle-radius": 6, "circle-stroke-color": "#fff", "circle-stroke-width": 2, "circle-emissive-strength": 1 } });
      map.addLayer({ id: "ignition-label", type: "symbol", source: "ignition", layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [1, 0], "text-anchor": "left", "text-justify": "left" }, paint: { "text-color": "#fff", "text-halo-color": "rgba(80,30,0,0.9)", "text-halo-width": 1.6, "text-emissive-strength": 1 } });

      map.addSource("places", { type: "geojson", data: pointCollection(incident.places) });
      map.addLayer({ id: "places-dot", type: "circle", source: "places", paint: { "circle-color": "#fff", "circle-radius": 3, "circle-stroke-color": "#1f2937", "circle-stroke-width": 1, "circle-emissive-strength": 1 } });
      map.addLayer({ id: "places-label", type: "symbol", source: "places", layout: { "text-field": ["get", "name"], "text-size": 11.5, "text-offset": [0, 1.1], "text-anchor": "top" }, paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,0.75)", "text-halo-width": 1.3, "text-emissive-strength": 1 } });

      // Simulated drones (positions pushed in on every tick)
      map.addSource("drones", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("drone-trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "drone-trails", type: "line", source: "drone-trails", paint: { "line-color": "#67e8f9", "line-width": 1.4, "line-opacity": 0.75, "line-emissive-strength": 1 } });
      map.addLayer({ id: "drone-dots", type: "circle", source: "drones", paint: { "circle-color": ["case", ["get", "selected"], "#f97316", "#0e7490"], "circle-radius": ["case", ["get", "selected"], 7, 5], "circle-stroke-color": "#ecfeff", "circle-stroke-width": 2, "circle-emissive-strength": 1 } });
      map.addLayer({ id: "drone-labels", type: "symbol", source: "drones", layout: { "text-field": ["concat", ["get", "id"], " ", ["get", "name"]], "text-size": 10.5, "text-offset": [0, -1.3], "text-allow-overlap": true }, paint: { "text-color": "#ecfeff", "text-halo-color": "rgba(8,51,68,0.9)", "text-halo-width": 1.4, "text-emissive-strength": 1 } });

      setReady(true);
    });

    map.on("mousemove", (e) => {
      const feats = map.getLayer("sim-fill") ? map.queryRenderedFeatures(e.point, { layers: ["sim-fill"] }) : [];
      const t = feats[0]?.properties?.t as string | undefined;
      setHover({
        x: e.point.x,
        y: e.point.y,
        lon: e.lngLat.lng,
        lat: e.lngLat.lat,
        elevation: map.queryTerrainElevation(e.lngLat, { exaggerated: false }) ?? null,
        burnedAt: t ? fmtIso(t) : null,
      });
    });
    map.on("mouseout", () => setHover(null));
    return () => map.remove();
  }, [data]);

  // Time-dependent filters and colours
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const h = minute / 60;
    const opacity = layers.sim.opacity;
    const paint = simPaint(h, opacity);
    map.setFilter("sim-fill", ["<=", ["get", "h"], h]);
    map.setPaintProperty("sim-fill", "fill-color", paint.color);
    map.setPaintProperty("sim-fill", "fill-opacity", paint.opacity);
    map.setFilter("sim-front", ["all", ["<=", ["get", "h"], h], [">", ["get", "h"], h - 2]]);
    map.setFilter("fronts-line", ["<=", ["get", "h"], h]);
    map.setFilter("fronts-label", ["<=", ["get", "h"], h]);

    const latestObs = data.observed.features
      .map((f) => f.properties.m ?? Infinity)
      .filter((m) => m <= minute)
      .reduce((a, b) => Math.max(a, b), -1);
    const obsFilter: FilterSpecification = ["all", ["==", ["get", "kind"], "seen_burned_by"], ["==", ["get", "m"], latestObs]];
    map.setFilter("observed-line", obsFilter);
    map.setFilter("observed-label", obsFilter);

    const recent: FilterSpecification = ["all", ["<=", ["get", "m"], minute], [">", ["get", "m"], minute - 24 * 60]];
    map.setFilter("hotspots-glow", recent);
    map.setFilter("hotspots-dot", recent);
    map.setPaintProperty("hotspots-glow", "circle-opacity", ["interpolate", ["linear"], ["-", minute, ["get", "m"]], 0, 0.7, 24 * 60, 0.05]);

    map.setFilter("path-line", ["all", ["==", ["get", "kind"], "segment"], ["<=", ["get", "m"], minute]]);
    map.setFilter("path-dots", ["all", ["==", ["get", "kind"], "dot"], ["<=", ["get", "m"], minute]]);
    map.setFilter("path-label", ["all", ["==", ["get", "kind"], "dot"], ["<=", ["get", "m"], minute]]);
    for (const id of ["ignition-glow", "ignition-dot", "ignition-label"]) map.setFilter(id, ["<=", ["get", "m"], minute]);

    // Drones
    const dots: { lon: number; lat: number; [k: string]: unknown }[] = [];
    const trails: Feature[] = [];
    for (const d of data.drones.fleet) {
      const s = droneState(data, d, minute);
      if (!s) continue;
      dots.push({ lon: s.lon, lat: s.lat, id: d.id, name: d.name, selected: d.id === selectedDrone });
      // Last 30 minutes of track, broken where the mission target jumped
      let coords: number[][] = [];
      const flush = () => {
        if (coords.length > 1) trails.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
        coords = [];
      };
      for (let k = 30; k >= 0; k -= 3) {
        const p = droneState(data, d, minute - k);
        if (!p) continue;
        const prev = coords[coords.length - 1];
        if (prev && Math.hypot(p.lon - prev[0], p.lat - prev[1]) * 111_320 > 400) flush();
        coords.push([p.lon, p.lat]);
      }
      flush();
    }
    (map.getSource("drones") as GeoJSONSource).setData(pointCollection(dots));
    (map.getSource("drone-trails") as GeoJSONSource).setData({ type: "FeatureCollection", features: trails });
  }, [minute, ready, data, selectedDrone, layers.sim.opacity]);

  // Layer visibility and raster opacity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const [id, ids] of Object.entries(GROUPS) as [LayerId, string[]][]) {
      for (const l of ids) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", layers[id].on ? "visible" : "none");
      const raster = RASTERS[id];
      if (raster) map.setPaintProperty(raster, "raster-opacity", layers[id].opacity);
    }
  }, [layers, ready]);

  // 2D / 3D
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (mode3d) {
      map.setTerrain({ source: "dem", exaggeration: 1.4 });
      map.easeTo({ pitch: 58, duration: 800 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
  }, [mode3d, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focus) return;
    map.easeTo({ center: [focus.lon, focus.lat], zoom: focus.zoom ?? 14, duration: 1200 });
  }, [focus, ready]);

  if (!TOKEN) {
    return (
      <div className="flex h-full items-center justify-center bg-stone-800 p-8 text-center text-stone-200">
        <p>
          Add <code className="font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to <code className="font-mono">mtkenya-fire/.env</code> and restart the dev server.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md bg-stone-950/85 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-stone-100 shadow-lg"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          {hover.elevation != null && <div>{Math.round(hover.elevation).toLocaleString()} m</div>}
          {hover.burnedAt ? <div className="text-orange-300">Model: burned {hover.burnedAt}</div> : <div className="text-stone-400">Not burned (model) by {fmtDayTime(fromMinutes(minuteRef.current, data.incident.meta.start))}</div>}
          <div className="text-stone-400">
            {Math.abs(hover.lat).toFixed(4)}°{hover.lat < 0 ? "S" : "N"} {hover.lon.toFixed(4)}°E
          </div>
        </div>
      )}
    </div>
  );
}

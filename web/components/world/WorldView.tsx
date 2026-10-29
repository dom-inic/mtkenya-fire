"use client";

import { CameraControls, Sky } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { FireData, Weather } from "@/lib/data";
import { weatherAt } from "@/lib/data";
import type { EngineResult, FireParams, HourWeather } from "@/lib/engine";
import { clusterIncidents, forecastSkill, type Detection, type Incident } from "@/lib/hotspots";
import { custom, forecast, nowEat, september, septemberFrom, worstCase, type WeatherSeries } from "@/lib/scenario";
import { fmtDayTime, fromMinutes } from "@/lib/time";
import { groundHeight, inside, loadWorld, nearest, Projection, VEXAG, type Raster, type WorldData } from "@/lib/world";
import { HotspotColumns, ReportPins } from "./Live3D";
import LivePanel, { type AlertItem, type ReportItem } from "./LivePanel";
import { Labels, Lakes, Roads, type Poi } from "./Features";
import { ControlLineDots, Firebreaks, Ignition } from "./PlanOverlays";
import Planner, { HELI_BASE, TANKER_BASE, type PlannerState, type Threat } from "./Planner";
import { Aircraft, crewAt, Crews, DropBursts, poseAt } from "./Response3D";
import type { HeliType, Resources } from "@/lib/suppression";
import Smoke from "./Smoke";
import Terrain, { makeFireUniforms, setFire, useFireClock, type FireLayer, type FireUniforms } from "./Terrain";
import { useEngine } from "./useEngine";
import Vegetation from "./Vegetation";

type View = { name: string; from: [number, number, number]; to: [number, number, number] }; // [lon, lat, height m]
type Mode = "replay" | "whatif" | "live";
const DRILL_START = "2026-09-02T06:00";
const ROAD_KINDS = ["trunk", "primary", "secondary", "tertiary", "unclassified", "track", "path"];

const VIEWS: View[] = [
  { name: "Fire, NE moorlands", from: [37.53, -0.005, 7800], to: [37.45, -0.07, 3300] },
  { name: "Whole mountain", from: [37.62, -0.62, 42000], to: [37.33, -0.13, 3000] },
  { name: "From Nanyuki", from: [37.02, 0.07, 6500], to: [37.31, -0.15, 4400] },
  { name: "Lake Alice", from: [37.49, -0.055, 4800], to: [37.463, -0.077, 3500] },
  { name: "Chogoria approach", from: [37.6, -0.27, 5200], to: [37.44, -0.15, 3100] },
  { name: "Peaks", from: [37.36, -0.1, 6400], to: [37.309, -0.152, 4900] },
  { name: "Ground level", from: [37.488, -0.088, 3900], to: [37.468, -0.072, 3550] },
];

interface Layers {
  imagery: "imagery" | "fuels";
  vegetation: boolean;
  roads: boolean;
  labels: boolean;
  smoke: boolean;
  fire: boolean;
}

/** Sun direction and how dark it is, from minutes after a midnight (EAT, equator). */
function sunAt(clockMinute: number) {
  const hour = (((clockMinute / 60) % 24) + 24) % 24;
  const theta = (Math.PI * (hour - 6.5)) / 12.15; // 0 at sunrise, π at sunset
  const dir = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0.25).normalize();
  const night = 1 - THREE.MathUtils.smoothstep(dir.y, -0.08, 0.22);
  return { dir, night, hour };
}

function Lighting({ clock }: { clock: number }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const moon = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();
  useFrame(() => {
    const { dir, night } = sunAt(clock);
    const day = 1 - night;
    sun.current?.position.copy(dir).multiplyScalar(100000);
    if (sun.current) sun.current.intensity = 2.6 * day;
    if (hemi.current) hemi.current.intensity = 0.2 + 0.63 * day;
    if (moon.current) moon.current.intensity = 0.7 * night;
    const fog = new THREE.Color("#c8d2da").lerp(new THREE.Color("#0b1020"), night);
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(fog);
    scene.background = fog;
  });
  return (
    <>
      <directionalLight ref={sun} color="#fff4e0" />
      <hemisphereLight ref={hemi} args={["#e2ecf5", "#5a4a38", 0.8]} />
      <directionalLight ref={moon} color="#9db4ff" position={[-40000, 60000, 30000]} />
    </>
  );
}

function FireClock({ fire, now }: { fire: FireUniforms; now: number }) {
  useFireClock(fire, now);
  return null;
}

interface SceneProps {
  world: WorldData;
  data: FireData;
  layers: Layers;
  view: View;
  controls: React.RefObject<CameraControls | null>;
  fireLayer: FireLayer | null;
  now: number;
  clock: number;
  weather: Weather | HourWeather | undefined;
  showProb: boolean;
  plan: PlannerState | null;
  result: EngineResult | null;
  resources: Resources | null;
  follow: string | null;
  live: { detections: Detection[]; reports: ReportItem[]; now: string } | null;
  onGround: (lon: number, lat: number) => void;
}

/** Chase camera: ride along behind an aircraft, or watch a crew from above. */
function Follow({ world, proj, result, unit, now, controls }: { world: WorldData; proj: Projection; result: EngineResult; unit: string; now: number; controls: React.RefObject<CameraControls | null> }) {
  const legs = useMemo(() => (result.response?.legs ?? []).filter((l) => l.unit === unit).sort((a, b) => a.t0 - b.t0), [result, unit]);
  const track = useMemo(() => result.response?.crewTracks.find((c) => c.unit === unit)?.points ?? [], [result, unit]);
  const nowRef = useRef(now);
  nowRef.current = now;
  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    let lon: number, lat: number, agl: number, heading: number;
    if (legs.length) {
      const p = poseAt(legs, nowRef.current);
      if (!p) return;
      [lon, lat] = p.lonlat;
      agl = p.agl;
      heading = p.heading;
    } else {
      const p = crewAt(track, nowRef.current);
      if (!p) return;
      [lon, lat] = p;
      agl = 0;
      heading = Math.PI * 0.75;
    }
    const tx = proj.x(lon);
    const tz = proj.z(lat);
    const ty = groundHeight(world, lon, lat) * VEXAG + agl;
    const back = 700;
    c.setLookAt(tx - Math.sin(heading) * back, ty + 260, tz + Math.cos(heading) * back, tx, ty, tz, false);
  });
  return null;
}

function Scene({ world, data, layers, view, controls, fireLayer, now, clock, weather, showProb, plan, result, resources, follow, live, onGround }: SceneProps) {
  const proj = useMemo(() => new Projection(world.meta.world), [world]);
  const fire = useMemo(() => makeFireUniforms(), []);
  useEffect(() => setFire(fire, fireLayer, proj), [fire, fireLayer, proj]);
  fire.uShowFire.value = layers.fire && fireLayer ? 1 : 0;
  fire.uShowProb.value = showProb && fireLayer?.prob ? 1 : 0;
  const { night, dir } = sunAt(clock);

  const pois = useMemo<Poi[]>(() => {
    const keep = new Set(["airstrip", "airbase", "gate", "station", "alpine_hut", "wilderness_hut", "town"]);
    const seen = new Set<string>();
    const out: Poi[] = [];
    const add = (p: Poi) => {
      const key = p.name.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    };
    for (const p of data.incident.places) add({ name: p.name, lon: p.lon, lat: p.lat, kind: p.name.startsWith("Lake") ? "lake" : /Batian|Lenana/.test(p.name) ? "peak" : "station" });
    for (const p of world.features.pois) if (keep.has(p.kind)) add(p);
    if (!plan) {
      const ign = data.incident.sim.ignitions[0];
      add({ name: "Ignition (est.)", kind: "fire", lon: ign.lon, lat: ign.lat });
    }
    return out;
  }, [world, data, plan]);

  // Camera presets
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const p = (lon: number, lat: number, h: number) => [proj.x(lon), Math.max(h, groundHeight(world, lon, lat) + 300) * VEXAG, proj.z(lat)] as const;
    const [fx, fy, fz] = p(...view.from);
    const [tx, ty, tz] = p(view.to[0], view.to[1], view.to[2]);
    c.setLookAt(fx, fy, fz, tx, ty, tz, true);
  }, [view, proj, world, controls]);

  const handleGround = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > 6) return; // a drag to move the camera, not a click
      e.stopPropagation();
      onGround(proj.lon(e.point.x), proj.lat(e.point.z));
    },
    [proj, onGround],
  );

  const line = plan?.showLine && result ? result.control[plan.showLine] : null;
  const built = useMemo(() => (plan?.applied ?? []).map((a) => ({ kind: a.kind, line: { cells: a.cells.map(([lon, lat]) => [lon, lat, 1] as [number, number, number]) } })), [plan?.applied]);

  return (
    <>
      <fog attach="fog" args={["#c8d2da", 60000, 260000]} />
      <Sky distance={450000} sunPosition={dir.toArray()} turbidity={5} rayleigh={night > 0.5 ? 0.2 : 1.3} mieCoefficient={0.006} mieDirectionalG={0.85} />
      <Lighting clock={clock} />
      <FireClock fire={fire} now={now} />
      <Terrain world={world} proj={proj} fire={fire} view={layers.imagery} onGround={handleGround} />
      <Lakes world={world} proj={proj} />
      {layers.vegetation && <Vegetation world={world} proj={proj} fire={fire} />}
      {layers.roads && <Roads world={world} proj={proj} night={night} kinds={ROAD_KINDS} />}
      {layers.labels && <Labels world={world} proj={proj} pois={pois} />}
      {layers.smoke && layers.fire && <Smoke world={world} proj={proj} fire={fireLayer?.arrival ?? null} minute={now} weather={weather} night={night} />}
      {plan?.ignition && <Ignition world={world} proj={proj} at={plan.ignition} label="Ignition" />}
      {plan && <Firebreaks world={world} proj={proj} lines={plan.breaks} draft={plan.draft} />}
      {line && <ControlLineDots world={world} proj={proj} line={line} />}
      {resources && result?.response && (
        <>
          <Aircraft
            world={world}
            proj={proj}
            units={[...resources.helis.map((h) => ({ id: h.id, kind: "heli" as const, model: h.type })), ...resources.tankers.map((t) => ({ id: t.id, kind: "tanker" as const }))]}
            legs={result.response.legs}
            now={now}
          />
          <Crews world={world} proj={proj} tracks={result.response.crewTracks} now={now} />
          <DropBursts world={world} proj={proj} drops={result.response.drops} now={now} />
          {follow && <Follow world={world} proj={proj} result={result} unit={follow} now={now} controls={controls} />}
        </>
      )}
      {live && <HotspotColumns world={world} proj={proj} detections={live.detections} now={live.now} />}
      {live && <ReportPins world={world} proj={proj} reports={live.reports} />}
      {built.map((b) => (
        <ControlLineDots key={b.kind} world={world} proj={proj} built line={b.line} />
      ))}
      <CameraControls ref={controls} makeDefault minDistance={150} maxDistance={220000} maxPolarAngle={Math.PI * 0.48} dollySpeed={0.6} />
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

export default function WorldView({ data, minute, onModeChange }: { data: FireData; minute: number; onModeChange?: (m: Mode) => void }) {
  const [world, setWorld] = useState<WorldData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(VIEWS[0]);
  const [layers, setLayers] = useState<Layers>({ imagery: "imagery", vegetation: true, roads: true, labels: true, smoke: true, fire: true });
  const [mode, setModeState] = useState<Mode>("replay");
  const controls = useRef<CameraControls>(null);

  useEffect(() => {
    loadWorld().then(setWorld, (e: Error) => setError(e.message));
  }, []);

  const setMode = (m: Mode) => {
    setModeState(m);
    onModeChange?.(m);
    // Live mode owns the fire (from the satellites); what-if owns it from a click
    if (m !== mode && m !== "replay") {
      setPlan((s) => ({ ...s, ignition: null, seeds: [], applied: [], showLine: null, tool: m === "whatif" ? "ignite" : null, weatherMode: m === "live" ? s.weatherMode : s.weatherMode === "drill" ? "worst" : s.weatherMode }));
      setSelectedIncRef.current?.(null);
      clearEngineRef.current?.();
    }
  };
  // set below, once those hooks exist
  const setSelectedIncRef = useRef<((id: string | null) => void) | null>(null);
  const clearEngineRef = useRef<(() => void) | null>(null);

  // --- What-if planner -------------------------------------------------------
  const [plan, setPlan] = useState<PlannerState>({
    ignition: null,
    seeds: [],
    weatherMode: "worst",
    custom: { windKmh: 20, windFrom: 90, rh: 30 },
    startHour: 13,
    horizon: 24,
    ensemble: true,
    mobilise: 60,
    tool: "ignite",
    breaks: [],
    draft: [],
    applied: [],
    showLine: null,
    resp: { helis: { as350: 1, mi17: 0, bell205: 0 }, tankers: 0, crews: 2, dispatch: 60 },
  });
  const set = useCallback((p: Partial<PlannerState>) => setPlan((s) => ({ ...s, ...p })), []);
  const engine = useEngine(world, data);
  const runEngine = engine.run;
  const [series, setSeries] = useState<WeatherSeries | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [liveSource, setLiveSource] = useState<"live" | "drill">("live");
  const [drillNow, setDrillNow] = useState(DRILL_START);

  // Weather for the scenario
  useEffect(() => {
    if (mode === "replay") return;
    const hours = plan.horizon + 1;
    setWeatherError(null);
    if (plan.weatherMode === "forecast") {
      if (!plan.ignition || !world) {
        setSeries(null);
        return;
      }
      const [lon, lat] = plan.ignition;
      let stale = false;
      forecast(lat, lon, groundHeight(world, lon, lat), hours).then(
        (s) => !stale && setSeries(s),
        (e: Error) => !stale && setWeatherError(e.message),
      );
      return () => {
        stale = true;
      };
    }
    if (plan.weatherMode === "drill") setSeries(septemberFrom(data.incident.weather, drillNow, hours));
    else if (plan.weatherMode === "worst") setSeries(worstCase(plan.startHour, hours));
    else if (plan.weatherMode === "september") setSeries(september(data.incident.weather, plan.startHour, hours));
    else setSeries(custom(plan.custom, plan.startHour, hours));
  }, [mode, plan.weatherMode, plan.ignition, plan.horizon, plan.startHour, plan.custom, world, data, drillNow]);

  // The response: units at their real bases, crews from the staging points nearest the fire
  const resources = useMemo<Resources | null>(() => {
    if (!world || !plan.ignition) return null;
    const find = (name: string) => world.features.pois.find((p) => p.name === name);
    const [lon0, lat0] = plan.ignition;
    const d2 = (p: { lon: number; lat: number }) => (p.lon - lon0) ** 2 + (p.lat - lat0) ** 2;
    // Crews start from park gates and forest stations, or are flown into the airstrips that serve the park
    const staging = world.features.pois
      .filter((p) => p.kind === "gate" || p.kind === "station" || (p.kind === "airstrip" && /Rutundu|Lewa|Nanyuki/i.test(p.name)))
      .sort((a, b) => d2(a) - d2(b))
      .slice(0, 3);
    const helis: Resources["helis"] = [];
    (Object.keys(plan.resp.helis) as HeliType[]).forEach((type) => {
      const base = find(HELI_BASE[type]);
      for (let k = 0; k < plan.resp.helis[type] && base; k++) helis.push({ id: `H${helis.length + 1}`, type, base });
    });
    const tb = find(TANKER_BASE);
    const tankers = tb ? Array.from({ length: plan.resp.tankers }, (_, k) => ({ id: `T${k + 1}`, base: tb })) : [];
    const crews = staging.length ? Array.from({ length: plan.resp.crews }, (_, k) => ({ id: `C${k + 1}`, base: staging[k % staging.length], size: 20 })) : [];
    return {
      helis,
      tankers,
      crews,
      dispatchMin: plan.resp.dispatch,
      airstrips: world.features.pois.filter((p) => p.kind === "airstrip" || p.kind === "airbase"),
      startHourOfDay: series ? Number(series.start.slice(11, 13)) : plan.startHour,
    };
  }, [world, plan.ignition, plan.resp, plan.startHour, series]);

  // Run the forecast whenever the scenario changes
  useEffect(() => {
    if (mode === "replay" || !plan.ignition || !series || !world) return;
    const bases = world.features.pois.filter((p) => ["gate", "station", "airstrip", "airbase"].includes(p.kind));
    runEngine({
      ignition: { lon: plan.ignition[0], lat: plan.ignition[1] },
      seeds: plan.seeds,
      hours: plan.horizon,
      weather: series.hours,
      params: data.incident.sim.params as unknown as FireParams,
      breaks: plan.breaks,
      breakCells: plan.applied.flatMap((a) => a.cells),
      bases,
      mobiliseMin: plan.mobilise,
      ensemble: plan.ensemble,
      resources: resources ?? undefined,
    });
  }, [mode, plan.ignition, plan.seeds, plan.horizon, plan.ensemble, plan.mobilise, plan.breaks, plan.applied, series, world, data, runEngine, resources]);

  const [follow, setFollow] = useState<string | null>(null);
  clearEngineRef.current = engine.clear;

  // --- Live mode -------------------------------------------------------------
  const [clockNow, setClockNow] = useState(nowEat());
  const liveNow = liveSource === "drill" ? drillNow : clockNow;
  const [detections, setDetections] = useState<Detection[]>([]);
  const [liveStatus, setLiveStatus] = useState("Checking satellites…");
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [selectedInc, setSelectedInc] = useState<string | null>(null);
  setSelectedIncRef.current = setSelectedInc;
  const [checking, setChecking] = useState(false);
  const [skill, setSkill] = useState<{ hits: number; total: number; issued: string } | null>(null);
  const lastForecast = useRef<{ incident: string; issued: string; at: (lon: number, lat: number) => number } | null>(null);
  // Set when new detections start a forecast; only those forecasts are checked against later passes
  const pendingIssue = useRef<string | null>(null);
  const drill = liveSource === "drill";

  // Poll the satellites (live: every 10 min; drill: when the clock moves), field reports and alerts
  useEffect(() => {
    if (mode !== "live") return;
    let stale = false;
    const load = async () => {
      setClockNow(nowEat());
      try {
        const f = await fetch(drill ? `/api/firms?drill=${drillNow}` : "/api/firms?days=2").then((r) => r.json());
        if (stale) return;
        setDetections(f.detections ?? []);
        setLiveStatus(f.error ? `Satellites: ${f.error}` : `${(f.detections ?? []).length} detection${(f.detections ?? []).length === 1 ? "" : "s"} in the last 48 h · ${drill ? "drill clock" : `checked ${new Date(f.checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, next in 10 min`}`);
        const [rp, al] = await Promise.all([fetch("/api/reports").then((r) => r.json()), fetch(`/api/alerts${drill ? "?drill=1" : ""}`).then((r) => r.json())]);
        if (stale) return;
        setReports(drill ? [] : (rp.reports ?? []));
        setAlerts(al.alerts ?? []);
      } catch (e) {
        if (!stale) setLiveStatus(`Couldn't reach the server: ${(e as Error).message}`);
      }
    };
    load();
    const t = drill ? undefined : setInterval(load, 10 * 60_000);
    return () => {
      stale = true;
      if (t) clearInterval(t);
    };
  }, [mode, drill, drillNow]);

  const places = useMemo(() => {
    if (!world) return [];
    const kinds = new Set(["gate", "station", "alpine_hut", "wilderness_hut", "camp_site", "airstrip", "town", "village"]);
    return [...data.incident.places.map((p) => ({ name: p.name, lon: p.lon, lat: p.lat })), ...world.features.pois.filter((p) => kinds.has(p.kind))];
  }, [world, data]);

  // Satellite detections plus field reports of fire, grouped into incidents
  const incidents = useMemo<Incident[]>(() => {
    if (!world) return [];
    const fuelAt = (lon: number, lat: number) => {
      const r = inside(world.meta.inner, lon, lat) ? world.fuelInner : world.fuelOuter;
      return nearest(r, lon, lat);
    };
    const fromReports: Detection[] = reports
      .filter((r) => r.type === "fire" || r.type === "spot")
      .map((r) => ({ lon: r.lon, lat: r.lat, t: new Date(Date.parse(r.at) + 3 * 3600_000).toISOString().slice(0, 16), sensor: "Field report", frp: 0, conf: "high" as const, day: true }));
    return clusterIncidents([...detections, ...fromReports], fuelAt, places);
  }, [world, detections, reports, places]);

  // Forecast the selected incident from where the satellites last saw fire
  const incident = incidents.find((i) => i.id === selectedInc) ?? null;
  useEffect(() => {
    if (mode !== "live" || !incident) return;
    const prev = lastForecast.current;
    if (prev && prev.incident === incident.id) setSkill({ ...forecastSkill(prev.issued, incident.detections, prev.at), issued: prev.issued });
    pendingIssue.current = liveNow;
    const latest = incident.detections[incident.detections.length - 1];
    const burning = incident.detections.filter((d) => (Date.parse(`${liveNow}Z`) - Date.parse(`${d.t}Z`)) / 60000 <= 12 * 60);
    setPlan((s) => ({
      ...s,
      ignition: [latest.lon, latest.lat],
      seeds: burning.map((d) => ({ lon: d.lon, lat: d.lat, t: 0 })),
      weatherMode: drill ? "drill" : "forecast",
      tool: null,
      applied: [],
      showLine: null,
    }));
    setSimMinute(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, incident?.id, incident?.detections.length, drill]);

  // Remember each live forecast so the next satellite pass can be checked against it
  useEffect(() => {
    const r = engine.result;
    if (mode !== "live" || !r || !selectedInc || !pendingIssue.current) return;
    const g = r.grid;
    const issued = pendingIssue.current;
    pendingIssue.current = null;
    lastForecast.current = {
      incident: selectedInc,
      issued,
      at: (lon, lat) => {
        const x = Math.floor((lon - g.west) / g.dLon);
        const y = Math.floor((g.north - lat) / g.dLat);
        // nearest burned cell within ~375 m (a VIIRS pixel)
        let best = Infinity;
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && xx >= 0 && yy < g.h && xx < g.w) best = Math.min(best, r.arrival[yy * g.w + xx]);
        }
        return best;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.result]);

  const selectIncident = (id: string | null) => {
    setSelectedInc(id);
    setSkill(null);
    lastForecast.current = null;
    const inc = incidents.find((i) => i.id === id);
    if (inc) {
      setFollow(null);
      setView({ name: "incident", from: [inc.lon + 0.06, inc.lat - 0.07, 7500], to: [inc.lon, inc.lat, 3300] });
    } else {
      setPlan((s) => ({ ...s, ignition: null, seeds: [] }));
      engine.clear();
    }
  };

  const checkAlertsNow = async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(drill ? { drill: drillNow } : {}) }).then((x) => x.json());
      if (r.recent) setAlerts(r.recent);
      else if (r.error) setLiveStatus(`Alert check: ${r.error}`);
    } finally {
      setChecking(false);
    }
  };

  const advanceDrill = (h: number) => setDrillNow((t) => new Date(Date.parse(`${t}Z`) + h * 3600_000).toISOString().slice(0, 16));
  const resetDrill = async () => {
    await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resetDrill: true }) });
    setAlerts([]);
    setDrillNow(DRILL_START);
    selectIncident(null);
  };

  // Scenario clock (minutes after ignition)
  const [simMinute, setSimMinute] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | null = null;
    const tick = (t: number) => {
      const dt = last == null ? 0 : (t - last) / 1000;
      last = t;
      setSimMinute((m) => {
        const next = m + dt * speed * 60;
        if (next >= plan.horizon * 60) {
          setPlaying(false);
          return plan.horizon * 60;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, plan.horizon]);

  const onGround = useCallback(
    (lon: number, lat: number) => {
      if (mode !== "whatif") return;
      setPlan((s) => {
        if (s.tool === "ignite") {
          setSimMinute(0);
          setPlaying(true);
          return { ...s, ignition: [lon, lat], tool: null, applied: [], showLine: null };
        }
        if (s.tool === "break") return { ...s, draft: [...s.draft, [lon, lat]] };
        return s;
      });
    },
    [mode],
  );
  const finishBreak = () => setPlan((s) => ({ ...s, tool: null, draft: [], breaks: s.draft.length > 1 ? [...s.breaks, s.draft] : s.breaks }));

  // What the scene draws
  const whatifLayer = useMemo<FireLayer | null>(() => {
    const r = engine.result;
    if (!r) return null;
    const g = r.grid;
    const bbox = { west: g.west, north: g.north, east: g.west + g.w * g.dLon, south: g.north - g.h * g.dLat };
    const arrival: Raster<Float32Array> = { w: g.w, h: g.h, bbox, data: r.arrival };
    return { arrival, prob: r.prob ? { w: g.w, h: g.h, bbox, data: r.prob } : null, block: r.response?.block ?? null };
  }, [engine.result]);
  const replayLayer = useMemo<FireLayer | null>(() => (world?.fire ? { arrival: world.fire } : null), [world]);

  const startHourOfDay = series ? Number(series.start.slice(11, 13)) : plan.startHour;
  const whatif = mode === "whatif";
  const planning = mode !== "replay";
  const now = planning ? simMinute : minute;
  const clock = planning ? startHourOfDay * 60 + simMinute : minute;
  const hourWeather = planning ? series?.hours[Math.min(Math.floor(simMinute / 60), (series?.hours.length ?? 1) - 1)] : weatherAt(data.incident, minute);

  const threats = useMemo<Threat[]>(() => {
    const r = engine.result;
    if (!r || !world) return [];
    const g = r.grid;
    const kinds = new Set(["gate", "station", "alpine_hut", "wilderness_hut", "camp_site", "airstrip"]);
    const places = [...data.incident.places.map((p) => ({ name: p.name, lon: p.lon, lat: p.lat })), ...world.features.pois.filter((p) => kinds.has(p.kind))];
    const seen = new Set<string>();
    const out: Threat[] = [];
    for (const p of places) {
      const x = Math.floor((p.lon - g.west) / g.dLon);
      const y = Math.floor((g.north - p.lat) / g.dLat);
      if (x < 0 || y < 0 || x >= g.w || y >= g.h || seen.has(p.name)) continue;
      // Anything within ~150 m of the fire counts
      let a = Infinity;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && xx >= 0 && yy < g.h && xx < g.w) a = Math.min(a, r.arrival[yy * g.w + xx]);
      }
      if (a < Infinity) {
        seen.add(p.name);
        out.push({ name: p.name, hours: a / 60 });
      }
    }
    return out.sort((a, b) => a.hours - b.hours);
  }, [engine.result, world, data]);

  const crewEta = useMemo(() => {
    const r = engine.result;
    if (!r || !plan.ignition) return null;
    const g = r.grid;
    const x = Math.floor((plan.ignition[0] - g.west) / g.dLon);
    const y = Math.floor((g.north - plan.ignition[1]) / g.dLat);
    const v = r.eta[y * g.w + x];
    return Number.isFinite(v) ? v : null;
  }, [engine.result, plan.ignition]);

  const { night, hour } = sunAt(clock);
  const toggle = (k: Exclude<keyof Layers, "imagery">) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const simTime = series ? fmtDayTime(fromMinutes(simMinute, series.start)) : "";
  const weatherNote = weatherError ?? (plan.weatherMode === "forecast" && !plan.ignition ? "Start a fire to fetch the live forecast for that spot." : (series?.note ?? "…"));

  return (
    <div className={`relative h-full w-full bg-[#0b1020] ${whatif && (plan.tool === "ignite" || plan.tool === "break") ? "cursor-crosshair" : ""}`}>
      {error && <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-red-300">{error}</div>}
      {!world && !error && <div className="absolute inset-0 grid place-items-center text-sm text-stone-300">Building the world…</div>}
      {world && (
        <Canvas camera={{ fov: 45, near: 20, far: 600000, position: [0, 40000, 60000] }} gl={{ logarithmicDepthBuffer: true, antialias: true }} dpr={[1, 1.75]}>
          <Suspense fallback={null}>
            <Scene
              world={world}
              data={data}
              layers={layers}
              view={view}
              controls={controls}
              fireLayer={planning ? whatifLayer : replayLayer}
              now={now}
              clock={clock}
              weather={hourWeather}
              showProb={planning && plan.ensemble}
              plan={planning ? plan : null}
              result={planning ? engine.result : null}
              resources={planning ? resources : null}
              follow={planning ? follow : null}
              live={mode === "live" ? { detections, reports, now: liveNow } : null}
              onGround={onGround}
            />
          </Suspense>
        </Canvas>
      )}

      {/* Mode + camera presets */}
      <div className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-15rem)] flex-wrap items-center gap-1">
        <div className="mr-2 flex rounded-md bg-black/55 p-0.5 shadow backdrop-blur">
          {(["replay", "whatif", "live"] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded px-2.5 py-1 text-[11px] font-semibold ${mode === m ? "bg-white text-ink" : "text-white hover:bg-white/10"}`}>
              {m === "replay" ? "Replay Sept 2026" : m === "whatif" ? "What-if planner" : "Live"}
            </button>
          ))}
        </div>
        {VIEWS.map((v) => (
          <button
            key={v.name}
            onClick={() => {
              setFollow(null);
              setView({ ...v });
            }}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium shadow backdrop-blur ${view.name === v.name ? "bg-fire text-white" : "bg-black/45 text-white hover:bg-black/60"}`}
          >
            {v.name}
          </button>
        ))}
      </div>

      {(whatif || (mode === "live" && incident)) && (
        <div className="pointer-events-none absolute top-14 bottom-20 left-3 z-10 flex">
          <Planner
            s={plan}
            set={set}
            result={engine.result}
            progress={engine.progress}
            weatherNote={weatherNote}
            threats={threats}
            crewEta={crewEta}
            onFinishBreak={finishBreak}
            follow={follow}
            onFollow={setFollow}
            live={
              mode === "live" && incident
                ? {
                    title: `Forecast from ${drill ? "the drill clock" : "now"}`,
                    note: `Starts from the ${plan.seeds.length} place${plan.seeds.length === 1 ? "" : "s"} the satellites saw burning in the last 12 h${incident.near ? ` near ${incident.near.name}` : ""}. Updates when new detections arrive.`,
                  }
                : undefined
            }
          />
        </div>
      )}

      {mode === "live" && (
        <div className="pointer-events-none absolute top-[15.5rem] right-3 bottom-20 z-10 flex">
          <LivePanel
            source={liveSource}
            setSource={(src) => {
              setLiveSource(src);
              selectIncident(null);
            }}
            now={liveNow}
            drillAdvance={advanceDrill}
            drillReset={resetDrill}
            status={liveStatus}
            incidents={incidents}
            selected={selectedInc}
            onSelect={selectIncident}
            skill={skill}
            reports={reports}
            alerts={alerts}
            onCheckAlerts={checkAlertsNow}
            checking={checking}
          />
        </div>
      )}

      {/* Layers */}
      <div className="absolute top-3 right-3 z-10 w-48 rounded-lg bg-black/55 p-3 text-[11px] text-stone-100 shadow-lg backdrop-blur">
        <div className="mb-1.5 font-semibold tracking-wide text-white">World layers</div>
        <div className="mb-2 flex gap-1">
          {(["imagery", "fuels"] as const).map((v) => (
            <button key={v} onClick={() => setLayers((l) => ({ ...l, imagery: v }))} className={`flex-1 rounded px-1.5 py-0.5 ${layers.imagery === v ? "bg-white text-ink" : "bg-white/10 hover:bg-white/20"}`}>
              {v === "imagery" ? "Satellite" : "Fuels"}
            </button>
          ))}
        </div>
        {(
          [
            ["fire", whatif ? "Fire (what-if)" : mode === "live" ? "Fire (forecast)" : "Fire (Sept replay)"],
            ["smoke", "Smoke & flames"],
            ["vegetation", "Vegetation"],
            ["roads", "Roads & tracks"],
            ["labels", "Labels"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} className="h-3 w-3 accent-[var(--color-fire)]" />
            {label}
          </label>
        ))}
        {planning && plan.ensemble && plan.ignition && (
          <div className="mt-2 border-t border-white/10 pt-2">
            <div className="mb-1 text-stone-300">Chance of burning by T+{plan.horizon} h</div>
            <div className="h-2 rounded-sm" style={{ background: "linear-gradient(90deg,#ffd933,#e0303f)" }} />
            <div className="flex justify-between text-[10px] text-stone-400">
              <span>low</span>
              <span>certain</span>
            </div>
          </div>
        )}
      </div>

      {/* Clock (replay) or scenario scrubber (what-if) */}
      {mode === "replay" && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-lg bg-black/55 px-3 py-2 text-[11px] text-stone-200 shadow-lg backdrop-blur">
          <div className="font-mono text-[13px] font-semibold text-white">
            {fmtDayTime(fromMinutes(minute, data.incident.meta.start))} EAT {night > 0.5 ? "· night" : hour < 9 ? "· morning" : hour > 16 ? "· evening" : "· day"}
          </div>
          <div className="mt-1 text-stone-300">Mount Kenya forest ring · 94 × 89 km · heights ×{VEXAG}</div>
          <div className="mt-0.5 text-stone-400">Sentinel-2 Jul–Aug 2026 · Copernicus DEM · ESA WorldCover · © OpenStreetMap</div>
        </div>
      )}
      {planning && plan.ignition && (
        <div className="absolute right-3 bottom-3 left-[324px] z-10 flex items-center gap-3 rounded-lg bg-black/60 px-3 py-2 text-[11px] text-white shadow-lg backdrop-blur">
          <button onClick={() => setPlaying((p) => !p)} className="grid h-7 w-8 place-items-center rounded bg-white text-ink" aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <div className="w-28 font-mono leading-tight">
            <div className="font-semibold">T+{(simMinute / 60).toFixed(1)} h</div>
            <div className="text-stone-300">{simTime}</div>
          </div>
          <input type="range" min={0} max={plan.horizon * 60} step={5} value={simMinute} onChange={(e) => setSimMinute(Number(e.target.value))} className="thin flex-1" aria-label="Scenario time" />
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded bg-white/10 px-1 py-0.5" aria-label="Replay speed">
            {[0.5, 1, 2, 4, 8].map((s) => (
              <option key={s} value={s} className="text-ink">
                {s} h/s
              </option>
            ))}
          </select>
          <span className="hidden text-stone-300 xl:inline">{night > 0.5 ? "night" : `${pad(Math.floor(hour))}:00 local`}</span>
        </div>
      )}
    </div>
  );
}

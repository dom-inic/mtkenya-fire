"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Charts from "./Charts";
import DronePanel from "./DronePanel";
import SidePanel from "./SidePanel";
import Timeline from "./Timeline";
import About from "./About";
import { loadFireData, type FireData } from "@/lib/data";
import { detect, droneState } from "@/lib/drones";
import { initialLayerState, type LayerId, type LayerState } from "@/lib/layers";
import { fmtIso, toMinutes } from "@/lib/time";

const MapView = dynamic(() => import("./MapView"), { ssr: false });
const DroneCam = dynamic(() => import("./DroneCam"), { ssr: false });
const WorldView = dynamic(() => import("./world/WorldView"), { ssr: false });

type Tab = "incident" | "drones" | "simulator";
const TAB_LABEL: Record<Tab, string> = { incident: "Incident", drones: "Drones", simulator: "Simulator" };

export default function FireApp() {
  const [data, setData] = useState<FireData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadFireData().then(setData, (e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="grid h-screen place-items-center p-8 text-center text-sm text-red-700">{error}</div>;
  if (!data) return <div className="grid h-screen place-items-center text-sm text-muted">Loading fire data…</div>;
  return <Console data={data} />;
}

function Console({ data }: { data: FireData }) {
  const { incident } = data;
  const start = incident.meta.start;
  const total = toMinutes(incident.meta.end, start);
  const ignition = toMinutes(incident.sim.ignitions[0].t, start);

  const [minute, setMinute] = useState(() => Math.round(toMinutes("2026-09-04T14:00", start)));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [tab, setTab] = useState<Tab>("incident");
  const [mode3d, setMode3d] = useState(true);
  const [layers, setLayers] = useState<LayerState>(initialLayerState);
  const [selectedDrone, setSelectedDrone] = useState<string | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const [focus, setFocus] = useState<{ lon: number; lat: number; zoom?: number; key: number } | null>(null);
  const [about, setAbout] = useState(false);
  const [simMode, setSimMode] = useState<"replay" | "whatif">("replay");

  // Replay clock: `speed` replay-hours per real second
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = (now: number) => {
      const dt = last.current == null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setMinute((m) => {
        const next = m + dt * speed * 60;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, speed, total]);

  const play = useCallback(
    (p: boolean) => {
      if (p && minute >= total) setMinute(ignition - 60);
      setPlaying(p);
    },
    [minute, total, ignition],
  );

  // Space toggles play
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && (e.target as HTMLElement).tagName !== "INPUT") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const setLayer = (id: LayerId, v: Partial<{ on: boolean; opacity: number }>) => setLayers((l) => ({ ...l, [id]: { ...l[id], ...v } }));

  const selectDrone = (id: string) => {
    setSelectedDrone(id);
    setCamOpen(true);
    const d = data.drones.fleet.find((f) => f.id === id);
    const s = d && droneState(data, d, minute);
    if (s) setFocus({ lon: s.lon, lat: s.lat, zoom: 14, key: Date.now() });
  };

  const drone = data.drones.fleet.find((d) => d.id === selectedDrone) ?? null;
  const dState = drone ? droneState(data, drone, minute) : null;
  const dHit = drone && dState ? detect(data, drone.id, dState, minute) : null;

  const detections = useMemo(() => {
    if (tab !== "drones") return [];
    return data.drones.fleet
      .map((d) => {
        const s = droneState(data, d, minute);
        const hit = s && detect(data, d.id, s, minute);
        return hit ? { ...hit, name: d.name } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    // Recompute about once per replay minute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, data, Math.floor(minute)]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded bg-fire text-[13px] text-white">▲</span>
          <span className="text-sm font-semibold tracking-tight">Mount Kenya Fire Analysis</span>
        </div>
        <div className="hidden items-center gap-3 text-[12px] text-muted md:flex">
          <span className="text-ink">{incident.meta.name}</span>
          <span>NE moorlands, Mount Kenya NP</span>
          <span className="font-mono">1 – 9 Sep 2026</span>
        </div>
        <nav className="ml-auto flex items-center gap-1 rounded-md bg-paper p-0.5 text-[12px]">
          {(["incident", "drones", "simulator"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                if (t === "drones" && !selectedDrone) selectDrone("KE-02");
              }}
              className={`rounded px-3 py-1 ${tab === t ? "bg-white font-medium shadow-sm" : "text-muted hover:text-ink"}`}
            >
              {t === "drones" ? `Drones · ${data.drones.fleet.length}` : TAB_LABEL[t]}
            </button>
          ))}
        </nav>
        <div className={`flex items-center gap-0.5 rounded-md bg-paper p-0.5 text-[12px] ${tab === "simulator" ? "invisible" : ""}`}>
          {[false, true].map((v) => (
            <button key={String(v)} onClick={() => setMode3d(v)} className={`rounded px-2.5 py-1 ${mode3d === v ? "bg-ink text-white" : "text-muted"}`}>
              {v ? "3D" : "2D"}
            </button>
          ))}
        </div>
        <button onClick={() => setAbout(true)} className="text-[12px] text-muted hover:text-ink">
          About the data
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {tab === "simulator" ? (
              <WorldView data={data} minute={minute} onModeChange={setSimMode} />
            ) : (
              <>
                <MapView data={data} minute={minute} layers={layers} mode3d={mode3d} selectedDrone={tab === "drones" ? selectedDrone : null} focus={focus} />
                <SpreadLegend />
              </>
            )}
            {tab === "drones" && camOpen && drone && (
              <div className="absolute top-3 right-3 z-10">
                <DroneCam data={data} drone={drone} state={dState} detection={dHit} minute={minute} onClose={() => setCamOpen(false)} />
              </div>
            )}
          </div>

          <div className={`shrink-0 border-t border-line bg-paper px-3 pt-1 pb-2 ${tab === "simulator" && simMode === "whatif" ? "hidden" : ""}`}>
            <Timeline data={data} minute={minute} total={total} playing={playing} speed={speed} onSeek={(m) => setMinute(Math.min(Math.max(m, 0), total))} onPlay={play} onSpeed={setSpeed} />
            <div className={`flex gap-2 ${tab === "simulator" ? "hidden" : ""}`}>
              <div className="min-w-0 flex-1">
                <Charts data={data} minute={minute} total={total} />
              </div>
              <div className="h-[118px] w-[280px] shrink-0 overflow-y-auto rounded-lg border border-line bg-panel px-3 py-2">
                {tab === "incident" ? (
                  <>
                    <h3 className="mb-1 text-[11px] font-semibold">Reported events</h3>
                    <ul className="space-y-1">
                      {incident.events.map((e) => {
                        const m = toMinutes(e.time, start);
                        return (
                          <li key={e.time + e.title}>
                            <button onClick={() => setMinute(m)} className={`grid w-full grid-cols-[74px_1fr] gap-2 text-left text-[11px] leading-snug ${m <= minute ? "text-ink" : "text-stone-400"}`} title={e.source}>
                              <span className="whitespace-nowrap font-mono">{fmtIso(e.time).replace(", ", " ")}</span>
                              <span>{e.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : (
                  <>
                    <h3 className="mb-1 flex justify-between text-[11px] font-semibold">
                      Thermal detections <span className="font-normal text-muted">{detections.length}</span>
                    </h3>
                    {detections.length === 0 && <p className="text-[11px] text-muted">No drone has fire in view right now.</p>}
                    <ul className="space-y-1">
                      {detections.map((d) => (
                        <li key={d.droneId}>
                          <button onClick={() => selectDrone(d.droneId)} className="flex w-full items-center gap-2 text-left text-[11px]">
                            <span className="h-2 w-2 rounded-full bg-red-500" />
                            <span className="tabular font-medium">{d.tempC} °C</span>
                            <span className="text-muted">
                              {d.droneId} {d.name} · {d.distanceM} m
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </div>
        </main>

        {tab === "incident" && <SidePanel data={data} minute={minute} layers={layers} onLayer={setLayer} onAbout={() => setAbout(true)} />}
        {tab === "drones" && <DronePanel data={data} minute={minute} selected={selectedDrone} onSelect={selectDrone} />}
      </div>
      {about && <About data={data} onClose={() => setAbout(false)} />}
    </div>
  );
}

function SpreadLegend() {
  return (
    <div className="pointer-events-none absolute bottom-8 left-3 z-10 rounded-md bg-stone-950/75 px-2.5 py-2 text-[10px] text-stone-200 backdrop-blur">
      <div className="mb-1 font-medium text-white">Modelled fire, time since burning</div>
      <div className="h-2 w-44 rounded-sm" style={{ background: "linear-gradient(90deg,#fff3b0,#ffb703 4%,#fb5607 12%,#9d0208 35%,#3d1f14)" }} />
      <div className="mt-0.5 flex w-44 justify-between">
        <span>now</span>
        <span>3 h</span>
        <span>10 h</span>
        <span>30 h+</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="h-0.5 w-4 bg-[#60a5fa]" /> Sentinel-2 burned area (latest pass)
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full border border-red-600 bg-white" /> FIRMS hotspot, last 24 h
      </div>
    </div>
  );
}

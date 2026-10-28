"use client";

import type { ControlLine, EngineResult } from "@/lib/engine";
import type { Custom, WeatherMode } from "@/lib/scenario";

export type Tool = "ignite" | "break" | null;
export type LineKind = "initial" | "pinch";

export interface PlannerState {
  ignition: [number, number] | null;
  weatherMode: WeatherMode;
  custom: Custom;
  startHour: number;
  horizon: number;
  ensemble: boolean;
  mobilise: number;
  tool: Tool;
  breaks: [number, number][][];
  draft: [number, number][];
  applied: { kind: LineKind; cells: [number, number][]; beforeHa: number }[];
  showLine: LineKind | null;
}

export interface Threat {
  name: string;
  hours: number;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const fmtH = (min: number | null) => (min == null ? "—" : min < 60 ? `${Math.round(min)} min` : `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`);

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-0.5 rounded-md bg-white/10 p-0.5">
      {options.map(([v, label]) => (
        <button key={String(v)} onClick={() => onChange(v)} className={`flex-1 rounded px-1.5 py-1 text-[11px] ${value === v ? "bg-white font-medium text-ink" : "text-stone-200 hover:bg-white/10"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function LineCard({ title, line, kind, s, set, nowHa }: { title: string; line: ControlLine | null; kind: LineKind; s: PlannerState; set: (p: Partial<PlannerState>) => void; nowHa: number }) {
  const built = s.applied.find((a) => a.kind === kind);
  if (built)
    return (
      <div className="rounded-md bg-cyan-500/15 px-2.5 py-2 ring-1 ring-cyan-400/40">
        <div className="flex items-baseline justify-between">
          <span className="text-[11.5px] font-semibold text-white">{title} line built</span>
          <button onClick={() => set({ applied: s.applied.filter((a) => a.kind !== kind) })} className="text-[11px] text-cyan-200 hover:underline">
            Undo
          </button>
        </div>
        <div className="mt-0.5 text-[11px] text-stone-200">
          Fire held to <b className="text-white">{nowHa.toLocaleString()} ha</b> by T+{s.horizon} h, against <b className="text-white">{built.beforeHa.toLocaleString()} ha</b> without it.
        </div>
      </div>
    );
  if (!line) return <div className="rounded-md bg-white/5 px-2.5 py-2 text-[11px] text-stone-400">{title}: none needed in this horizon.</div>;
  const applied = false;
  return (
    <div className={`rounded-md px-2.5 py-2 ${s.showLine === kind ? "bg-emerald-500/15 ring-1 ring-emerald-400/50" : "bg-white/5"}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-[11.5px] font-semibold text-white">{title}</span>
        <span className="font-mono text-[11px] text-stone-300">by T+{line.hour} h</span>
      </div>
      <div className="mt-0.5 text-[11px] text-stone-300">
        {line.lengthKm.toFixed(1)} km of line · crews reach <b className={line.feasiblePct >= 80 ? "text-emerald-300" : "text-amber-300"}>{line.feasiblePct}%</b> of it in time
      </div>
      <div className="mt-1.5 flex gap-1">
        <button onClick={() => set({ showLine: s.showLine === kind ? null : kind })} className="rounded bg-white/10 px-2 py-0.5 text-[11px] hover:bg-white/20">
          {s.showLine === kind ? "Hide" : "Show"}
        </button>
        <button
          onClick={() =>
            set({
              applied: [...s.applied, { kind, cells: line.cells.map(([lon, lat]) => [lon, lat] as [number, number]), beforeHa: nowHa }],
              showLine: null,
            })
          }
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${applied ? "bg-emerald-500 text-white" : "bg-emerald-600/80 text-white hover:bg-emerald-500"}`}
        >
          {applied ? "✓ Built (undo)" : "Build this line"}
        </button>
      </div>
    </div>
  );
}

export default function Planner({
  s,
  set,
  result,
  progress,
  weatherNote,
  threats,
  crewEta,
  onFinishBreak,
}: {
  s: PlannerState;
  set: (p: Partial<PlannerState>) => void;
  result: EngineResult | null;
  progress: { done: number; total: number } | null;
  weatherNote: string;
  threats: Threat[];
  crewEta: number | null;
  onFinishBreak: () => void;
}) {
  const at = (h: number) => result?.series[Math.min(h, result.series.length - 1)]?.ha ?? 0;
  return (
    <div className="pointer-events-auto max-h-[calc(100%-4.5rem)] w-[300px] overflow-y-auto rounded-lg bg-black/60 p-3 text-[11px] text-stone-200 shadow-xl backdrop-blur-md">
      <div className="mb-2 text-[12.5px] font-semibold text-white">What-if planner</div>

      {/* Tools */}
      <div className="mb-2 flex gap-1">
        <button onClick={() => set({ tool: s.tool === "ignite" ? null : "ignite" })} className={`flex-1 rounded-md px-2 py-1.5 font-medium ${s.tool === "ignite" ? "bg-orange-600 text-white" : "bg-white/10 hover:bg-white/20"}`}>
          🔥 {s.ignition ? "Move fire" : "Start a fire"}
        </button>
        <button onClick={() => (s.tool === "break" ? onFinishBreak() : set({ tool: "break", draft: [] }))} className={`flex-1 rounded-md px-2 py-1.5 font-medium ${s.tool === "break" ? "bg-cyan-600 text-white" : "bg-white/10 hover:bg-white/20"}`}>
          {s.tool === "break" ? "✓ Finish line" : "✏ Firebreak"}
        </button>
      </div>
      {s.tool === "ignite" && <p className="mb-2 rounded bg-orange-500/15 px-2 py-1.5 text-orange-100">Click on the mountain where the fire starts.</p>}
      {s.tool === "break" && <p className="mb-2 rounded bg-cyan-500/15 px-2 py-1.5 text-cyan-100">Click points along the line, then Finish. Lakes, rock and tracks already help.</p>}
      {(s.breaks.length > 0 || s.applied.length > 0) && (
        <button onClick={() => set({ breaks: [], applied: [] })} className="mb-2 text-[11px] text-cyan-300 hover:underline">
          Clear {s.breaks.length + s.applied.length} firebreak{s.breaks.length + s.applied.length === 1 ? "" : "s"}
        </button>
      )}

      {/* Weather */}
      <div className="mb-1 mt-1 font-medium text-white">Weather</div>
      <Seg<WeatherMode>
        value={s.weatherMode}
        onChange={(weatherMode) => set({ weatherMode })}
        options={[
          ["forecast", "Live"],
          ["worst", "Worst"],
          ["september", "4 Sep"],
          ["custom", "Custom"],
        ]}
      />
      <p className="mt-1 text-[10.5px] leading-snug text-stone-400">{weatherNote}</p>
      {s.weatherMode !== "forecast" && (
        <label className="mt-1.5 flex items-center justify-between">
          <span>Fire starts at</span>
          <select value={s.startHour} onChange={(e) => set({ startHour: Number(e.target.value) })} className="rounded bg-white/10 px-1 py-0.5 text-white">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h} className="text-ink">
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </label>
      )}
      {s.weatherMode === "custom" && (
        <div className="mt-1.5 space-y-1">
          <label className="flex items-center gap-2">
            <span className="w-16">Wind</span>
            <input type="range" min={0} max={50} value={s.custom.windKmh} onChange={(e) => set({ custom: { ...s.custom, windKmh: Number(e.target.value) } })} className="thin flex-1" />
            <span className="w-12 text-right font-mono">{s.custom.windKmh} km/h</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-16">From</span>
            <select value={s.custom.windFrom} onChange={(e) => set({ custom: { ...s.custom, windFrom: Number(e.target.value) } })} className="flex-1 rounded bg-white/10 px-1 py-0.5 text-white">
              {COMPASS.map((c, i) => (
                <option key={c} value={i * 45} className="text-ink">
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-16">Humidity</span>
            <input type="range" min={10} max={90} value={s.custom.rh} onChange={(e) => set({ custom: { ...s.custom, rh: Number(e.target.value) } })} className="thin flex-1" />
            <span className="w-12 text-right font-mono">{s.custom.rh}%</span>
          </label>
        </div>
      )}

      {/* Run settings */}
      <div className="mt-2.5 mb-1 font-medium text-white">Forecast</div>
      <Seg<number> value={s.horizon} onChange={(horizon) => set({ horizon })} options={[[24, "24 h"], [48, "48 h"], [72, "72 h"]]} />
      <label className="mt-1.5 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={s.ensemble} onChange={(e) => set({ ensemble: e.target.checked })} className="h-3 w-3 accent-[var(--color-fire)]" />
        Chance of burning (11 runs, wind varied)
      </label>
      <label className="mt-1 flex items-center justify-between">
        <span>Crews ready to leave in</span>
        <select value={s.mobilise} onChange={(e) => set({ mobilise: Number(e.target.value) })} className="rounded bg-white/10 px-1 py-0.5 text-white">
          {[30, 60, 120, 240].map((m) => (
            <option key={m} value={m} className="text-ink">
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </option>
          ))}
        </select>
      </label>

      {/* Results */}
      {!s.ignition && <p className="mt-3 rounded bg-white/5 px-2 py-2 text-stone-300">Start a fire to see where it goes.</p>}
      {progress && (
        <div className="mt-3">
          <div className="mb-1 text-stone-300">
            Running forecast {progress.done}/{progress.total}…
          </div>
          <div className="h-1 overflow-hidden rounded bg-white/10">
            <div className="h-full bg-orange-500 transition-all" style={{ width: `${(100 * progress.done) / Math.max(progress.total, 1)}%` }} />
          </div>
        </div>
      )}
      {result && s.ignition && (
        <div className="mt-3 space-y-2">
          <div>
            <div className="mb-1 font-medium text-white">Burned area (model)</div>
            <div className="grid grid-cols-5 gap-1 text-center">
              {[1, 3, 6, 12, 24, 48, 72].filter((h) => h <= s.horizon).slice(-5).map((h) => (
                <div key={h} className="rounded bg-white/5 px-1 py-1">
                  <div className="text-[10px] text-stone-400">T+{h} h</div>
                  <div className="font-mono text-[11.5px] text-white">{at(h).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div className="mt-0.5 text-right text-[10px] text-stone-500">hectares · {result.runs} run{result.runs > 1 ? "s" : ""} in {(result.ms / 1000).toFixed(1)} s</div>
          </div>
          <div className="space-y-0.5">
            <div className="flex justify-between">
              <span>Nearest crew reaches the fire</span>
              <b className="font-mono text-white">{fmtH(crewEta)}</b>
            </div>
            <div className="flex justify-between">
              <span>Reaches bamboo belt</span>
              <b className="font-mono text-white">{fmtH(result.firsts.bamboo)}</b>
            </div>
            <div className="flex justify-between">
              <span>Reaches montane forest</span>
              <b className="font-mono text-white">{fmtH(result.firsts.forest)}</b>
            </div>
          </div>
          {threats.length > 0 && (
            <div>
              <div className="mb-0.5 font-medium text-white">Places in its path</div>
              {threats.slice(0, 6).map((t) => (
                <div key={t.name} className="flex justify-between">
                  <span className="truncate pr-2">{t.name}</span>
                  <span className="font-mono text-amber-200">T+{t.hours.toFixed(1)} h</span>
                </div>
              ))}
            </div>
          )}
          <div className="font-medium text-white">Suggested control lines</div>
          <LineCard title="Initial attack" line={result.control.initial} kind="initial" s={s} set={set} nowHa={at(s.horizon)} />
          <LineCard title="Pinch point" line={result.control.pinch} kind="pinch" s={s} set={set} nowHa={at(s.horizon)} />
          <p className="text-[10px] leading-snug text-stone-500">
            Lines follow the fire&apos;s predicted edge where crews (from gates, forest stations, airstrips and main roads) can arrive an hour ahead of it. Building one re-runs the forecast with that line in place.
          </p>
        </div>
      )}
    </div>
  );
}

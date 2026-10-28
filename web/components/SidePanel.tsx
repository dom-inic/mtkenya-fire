"use client";

import type { FireData } from "@/lib/data";
import { burnedAt, weatherAt } from "@/lib/data";
import { LAYERS, type LayerId, type LayerState } from "@/lib/layers";
import { fmtIso } from "@/lib/time";

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => COMPASS[Math.round(deg / 22.5) % 16];

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-0.5 text-[12px]">
      <dt className="text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}

export function LayerList({ layers, onChange }: { layers: LayerState; onChange: (id: LayerId, v: Partial<{ on: boolean; opacity: number }>) => void }) {
  const groups = ["Model", "Satellite", "Context"] as const;
  return (
    <div className="space-y-2.5">
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-stone-400">{g}</div>
          {LAYERS.filter((l) => l.group === g).map((l) => (
            <div key={l.id} className="group flex items-center gap-2 py-[3px]">
              <input
                id={`layer-${l.id}`}
                type="checkbox"
                checked={layers[l.id].on}
                onChange={(e) => onChange(l.id, { on: e.target.checked })}
                className="h-3.5 w-3.5 accent-[var(--color-fire)]"
              />
              <span className="h-3 w-5 shrink-0 rounded-sm ring-1 ring-black/10" style={{ background: l.swatch }} />
              <label htmlFor={`layer-${l.id}`} className="min-w-0 flex-1 cursor-pointer truncate text-[12px]" title={l.source}>
                {l.label}
              </label>
              {l.fades && (
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={layers[l.id].opacity}
                  onChange={(e) => onChange(l.id, { opacity: Number(e.target.value) })}
                  className="thin w-14"
                  aria-label={`${l.label} opacity`}
                  disabled={!layers[l.id].on}
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function SidePanel({
  data,
  minute,
  layers,
  onLayer,
  onAbout,
}: {
  data: FireData;
  minute: number;
  layers: LayerState;
  onLayer: (id: LayerId, v: Partial<{ on: boolean; opacity: number }>) => void;
  onAbout: () => void;
}) {
  const { incident } = data;
  const w = weatherAt(incident, minute);
  const ign = incident.sim.ignitions[0];

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      <Section title="Layers">
        <LayerList layers={layers} onChange={onLayer} />
      </Section>

      <Section title="Incident" aside={<span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">Contained</span>}>
        <dl>
          <Row k="Location" v={incident.meta.location} />
          <Row k="First reported" v="1 Sep 2026" />
          <Row k="Burned area" v={<><b className="tabular">{incident.meta.area_ha.toLocaleString()} ha</b> <span className="text-muted">(Sentinel-2)</span></>} />
          <Row
            k="Reported"
            v={
              <span className="text-[11px] leading-snug">
                {incident.meta.reported_areas.map((r) => (
                  <span key={r.source} className="block">
                    <span className="tabular">{r.ha.toLocaleString()} ha</span> <span className="text-muted">· {r.source}</span>
                  </span>
                ))}
              </span>
            }
          />
          <Row k="Ignition (est.)" v={<span>{fmtIso(ign.t)} <span className="block text-[11px] text-muted">{Math.abs(ign.lat).toFixed(4)}°S {ign.lon.toFixed(4)}°E · {incident.sim.ignition_basis}</span></span>} />
          <Row k="Cause" v={incident.meta.cause} />
        </dl>
      </Section>

      <Section title="At the fire now" aside={<span className="text-[10px] text-muted">ERA5 · 3,300 m</span>}>
        {w && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Wind" value={`${Math.round(w.wind_kmh)}`} unit="km/h" sub={`from ${compass(w.wind_from)} · gust ${Math.round(w.gust_kmh)}`} arrow={w.wind_from} />
            <Stat label="Humidity" value={`${Math.round(w.rh)}`} unit="%" sub={w.rh < 50 ? "dry, fast spread" : w.rh > 75 ? "damp, slow spread" : "moderate"} />
            <Stat label="Temp" value={`${Math.round(w.temp_c)}`} unit="°C" sub={w.rain_mm > 0 ? `rain ${w.rain_mm} mm` : "no rain"} />
          </div>
        )}
        <div className="mt-3 flex items-baseline justify-between rounded-md bg-fire-soft/60 px-3 py-2">
          <span className="text-[11px] text-stone-700">Model burned so far</span>
          <span className="tabular text-sm font-semibold text-fire">{burnedAt(incident, minute).toLocaleString()} ha</span>
        </div>
      </Section>

      <Section title="Model fit">
        <p className="text-[11px] leading-relaxed text-stone-600">
          Agreement with what Sentinel-2 saw burned (Sørensen score, 1 = perfect):{" "}
          {Object.entries(incident.sim.score_detail).map(([t, s], i) => (
            <span key={t} className="tabular">
              {i > 0 && " · "}
              {fmtIso(t).split(",")[0]} <b>{s.toFixed(2)}</b>
            </span>
          ))}
        </p>
        <button onClick={onAbout} className="mt-2 text-[11px] font-medium text-fire underline-offset-2 hover:underline">
          Method, data sources and limits →
        </button>
      </Section>
    </aside>
  );
}

function Stat({ label, value, unit, sub, arrow }: { label: string; value: string; unit: string; sub: string; arrow?: number }) {
  return (
    <div className="rounded-md border border-line bg-white px-1.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 flex items-center justify-center gap-1">
        {arrow != null && (
          <span className="inline-block text-sm text-stone-500" style={{ transform: `rotate(${arrow + 180}deg)` }} aria-hidden>
            ↑
          </span>
        )}
        <span className="tabular text-lg font-semibold leading-none">{value}</span>
        <span className="text-[10px] text-muted">{unit}</span>
      </div>
      <div className="mt-1 text-[10px] leading-tight text-muted">{sub}</div>
    </div>
  );
}

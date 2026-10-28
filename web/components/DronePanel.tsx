"use client";

import type { FireData } from "@/lib/data";
import { detect, droneState } from "@/lib/drones";
import { fmtIso } from "@/lib/time";

export default function DronePanel({
  data,
  minute,
  selected,
  onSelect,
}: {
  data: FireData;
  minute: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const fleet = data.drones.fleet.map((d) => {
    const s = droneState(data, d, minute);
    return { d, s, hit: s ? detect(data, d.id, s, minute) : null };
  });
  const airborne = fleet.filter((f) => f.s).length;
  const sel = fleet.find((f) => f.d.id === selected);

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      <section className="border-b border-line px-4 py-3">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Drone fleet</h2>
          <span className="text-[10px] text-muted">
            {airborne} of {fleet.length} airborne
          </span>
        </div>
        <p className="mb-2 rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900">
          Simulated. No drones were reported on this fire; these show what a fleet would have flown against the modelled fire.
        </p>
        <ul className="space-y-1">
          {fleet.map(({ d, s, hit }) => (
            <li key={d.id}>
              <button
                onClick={() => onSelect(d.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${selected === d.id ? "bg-fire-soft ring-1 ring-fire/40" : "hover:bg-paper"}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${s ? (hit ? "bg-red-500" : "bg-cyan-600") : "bg-stone-300"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium">
                    {d.id} {d.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted">{d.mission}</span>
                </span>
                {s ? (
                  <span className="w-12 text-right">
                    <span className="block h-1.5 overflow-hidden rounded bg-stone-200">
                      <span className="block h-full bg-emerald-500" style={{ width: `${s.battery}%` }} />
                    </span>
                    <span className="tabular text-[10px] text-muted">{s.battery}%</span>
                  </span>
                ) : (
                  <span className="text-[10px] text-muted">standby</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {sel && (
        <section className="px-4 py-3">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {sel.d.id} {sel.d.name}
          </h2>
          {sel.s ? (
            <div className="mb-3 grid grid-cols-3 gap-2 text-center">
              <Tile k="Altitude" v={`${sel.d.agl}`} u="m AGL" />
              <Tile k="Ground speed" v={`${sel.d.speed_kmh}`} u="km/h" />
              <Tile k="Heading" v={`${Math.round(sel.s.heading)}°`} u="" />
            </div>
          ) : (
            <p className="mb-3 text-[12px] text-muted">On standby until {fmtIso(data.drones.deploy[0])}.</p>
          )}
          <dl className="space-y-1 text-[12px]">
            {[
              ["Aircraft", sel.d.aircraft],
              ["Mission", sel.d.mission],
              ["Task", sel.d.task],
              ["Sensor", sel.d.sensor],
              ["Position", sel.s ? `${Math.abs(sel.s.lat).toFixed(4)}°S ${sel.s.lon.toFixed(4)}°E` : "—"],
              ["Thermal", sel.hit ? `Hot spot ${sel.hit.tempC} °C at ${sel.hit.distanceM} m` : "No fire in view"],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-[72px_1fr] gap-2">
                <dt className="text-muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </aside>
  );
}

function Tile({ k, v, u }: { k: string; v: string; u: string }) {
  return (
    <div className="rounded-md border border-line bg-white px-1 py-1.5">
      <div className="text-[10px] text-muted">{k}</div>
      <div className="tabular text-base font-semibold leading-tight">{v}</div>
      <div className="text-[10px] text-muted">{u}</div>
    </div>
  );
}

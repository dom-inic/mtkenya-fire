"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FireData } from "@/lib/data";
import { fmtDay, fmtDayTime, fromMinutes, toMinutes } from "@/lib/time";

// Validated categorical palette (dataviz validator, light surface #fbfaf7)
export const SERIES = { model: "#e8590c", observed: "#2563eb", reported: "#a21caf" };
const GRID = "#ece7df";
const AXIS = { fontSize: 10, fill: "#7a7064" };

function Panel({ title, legend, wide, children }: { title: string; legend?: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col rounded-lg border border-line bg-panel px-3 pt-2 pb-1 ${wide ? "flex-[1.5]" : "flex-1"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[11px] font-semibold tracking-wide text-ink">{title}</h3>
        {legend}
      </div>
      <div className="h-[86px] min-w-0">{children}</div>
    </div>
  );
}

function Key({ colour, label, shape }: { colour: string; label: string; shape: "line" | "dot" | "diamond" }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted">
      {shape === "line" && <span className="h-0.5 w-3 rounded" style={{ background: colour }} />}
      {shape === "dot" && <span className="h-2 w-2 rounded-full" style={{ background: colour }} />}
      {shape === "diamond" && <span className="h-2 w-2 rotate-45" style={{ background: colour }} />}
      {label}
    </span>
  );
}

function Tip({ active, payload, start, unit }: { active?: boolean; payload?: { name: string; value: number; color?: string; payload: { m: number } }[]; start: string; unit: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line bg-white px-2 py-1 text-[11px] shadow">
      <div className="font-mono text-muted">{fmtDayTime(fromMinutes(payload[0].payload.m, start))}</div>
      {payload.map((p) => (
        <div key={p.name} className="tabular text-ink">
          {p.name}: <b>{Math.round(p.value).toLocaleString()}</b> {unit}
        </div>
      ))}
    </div>
  );
}

export default function Charts({ data, minute, total }: { data: FireData; minute: number; total: number }) {
  const { incident } = data;
  const start = incident.meta.start;

  const { series, observed, reported, weather, ticks } = useMemo(() => {
    const series = incident.sim.series.map((s) => ({ m: toMinutes(s.t, start), burned: s.burned_ha, growth: s.growth_ha_h }));
    const observed = incident.sentinel.progression
      .map((p) => ({ m: toMinutes(`${p.date}T10:40`, start), seen: p.seen_burned_ha }))
      .filter((p) => p.m <= total);
    const reported = incident.meta.reported_areas.map((r) => ({ m: toMinutes(`${r.date}T12:00`, start), reported: r.ha, source: r.source }));
    const weather = incident.weather.map((w) => ({ m: toMinutes(w.time, start), wind: w.wind_kmh, gust: w.gust_kmh, rh: w.rh }));
    const ticks = Array.from({ length: Math.floor(total / 1440) }, (_, d) => d * 1440 + 720);
    return { series, observed, reported, weather, ticks };
  }, [incident, start, total]);

  const x = {
    dataKey: "m",
    type: "number" as const,
    domain: [0, total],
    ticks,
    tickFormatter: (m: number) => fmtDay(fromMinutes(m, start)),
    tick: AXIS,
    tickLine: false,
    axisLine: { stroke: GRID },
    allowDuplicatedCategory: false,
  };
  const now = <ReferenceLine x={minute} stroke="#1f1b16" strokeWidth={1} />;

  return (
    <div className="flex gap-2">
      <Panel
        wide
        title="Area burned (ha)"
        legend={
          <span className="flex gap-2">
            <Key colour={SERIES.model} label="Model" shape="line" />
            <Key colour={SERIES.observed} label="Sentinel-2" shape="dot" />
            <Key colour={SERIES.reported} label="Reported" shape="diamond" />
          </span>
        }
      >
        <ResponsiveContainer>
          <ComposedChart margin={{ top: 6, right: 6, bottom: 0, left: -14 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis {...x} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} domain={[0, 13000]} ticks={[0, 4000, 8000, 12000]} tickFormatter={(v) => `${v / 1000}k`} />
            <Tooltip content={<Tip start={start} unit="ha" />} />
            <Line data={series} dataKey="burned" name="Model" stroke={SERIES.model} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Scatter data={observed} dataKey="seen" name="Sentinel-2 seen burned" fill={SERIES.observed} stroke="#fbfaf7" strokeWidth={2} isAnimationActive={false} />
            <Scatter data={reported} dataKey="reported" name="Reported" fill={SERIES.reported} stroke="#fbfaf7" strokeWidth={2} shape="diamond" isAnimationActive={false} />
            {now}
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Model growth (ha/h)">
        <ResponsiveContainer>
          <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis {...x} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} />
            <Tooltip content={<Tip start={start} unit="ha/h" />} />
            <Area dataKey="growth" name="Growth" stroke={SERIES.model} strokeWidth={1.5} fill={SERIES.model} fillOpacity={0.18} isAnimationActive={false} />
            {now}
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Wind (km/h)">
        <ResponsiveContainer>
          <LineChart data={weather} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis {...x} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} />
            <Tooltip content={<Tip start={start} unit="km/h" />} />
            <Line dataKey="wind" name="Wind" stroke="#475569" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {now}
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Humidity (%)">
        <ResponsiveContainer>
          <LineChart data={weather} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis {...x} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} domain={[0, 100]} ticks={[0, 50, 100]} />
            <Tooltip content={<Tip start={start} unit="%" />} />
            <Line dataKey="rh" name="Humidity" stroke="#0e7490" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            {now}
          </LineChart>
        </ResponsiveContainer>
      </Panel>
    </div>
  );
}

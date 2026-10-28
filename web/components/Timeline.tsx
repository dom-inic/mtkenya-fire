"use client";

import { useMemo, useRef } from "react";
import type { FireData } from "@/lib/data";
import { fmtDay, fmtDayTime, fromMinutes, toMinutes } from "@/lib/time";

export const SPEEDS = [0.5, 1, 2, 4, 8]; // replay hours per second

interface Props {
  data: FireData;
  minute: number;
  total: number;
  playing: boolean;
  speed: number;
  onSeek: (m: number) => void;
  onPlay: (p: boolean) => void;
  onSpeed: (s: number) => void;
}

const EVENT_COLOUR: Record<string, string> = {
  ignition: "#dc2626",
  response: "#2563eb",
  behaviour: "#ea580c",
  weather: "#0891b2",
  containment: "#16a34a",
};

export default function Timeline({ data, minute, total, playing, speed, onSeek, onPlay, onSpeed }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const { incident } = data;
  const start = incident.meta.start;
  const pct = (m: number) => `${(Math.min(Math.max(m, 0), total) / total) * 100}%`;

  // Modelled growth as a sparkline behind the track
  const spark = useMemo(() => {
    const s = incident.sim.series;
    const max = Math.max(...s.map((p) => p.growth_ha_h), 1);
    return s.map((p, i) => `${(i / (s.length - 1)) * 1000},${40 - (p.growth_ha_h / max) * 38}`).join(" ");
  }, [incident]);

  const days = useMemo(() => Array.from({ length: Math.floor(total / 1440) + 1 }, (_, d) => d * 1440), [total]);
  const overpasses = incident.sentinel.progression.map((p) => ({ m: toMinutes(`${p.date}T10:40`, start), ...p })).filter((p) => p.m <= total);

  const seekFrom = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    onSeek(Math.round(((clientX - r.left) / r.width) * total));
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={() => onSeek(Math.max(minute - 60, 0))} className="grid h-8 w-8 place-items-center rounded-md border border-line bg-white text-sm hover:bg-paper" aria-label="Back one hour">
          ‹
        </button>
        <button onClick={() => onPlay(!playing)} className="grid h-8 w-9 place-items-center rounded-md bg-ink text-sm text-white hover:bg-stone-700" aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button onClick={() => onSeek(Math.min(minute + 60, total))} className="grid h-8 w-8 place-items-center rounded-md border border-line bg-white text-sm hover:bg-paper" aria-label="Forward one hour">
          ›
        </button>
        <span className="ml-2 w-[108px] font-mono text-[12px] leading-tight">
          <span className="block font-semibold text-ink">{fmtDayTime(fromMinutes(minute, start))}</span>
          <span className="text-[10px] text-muted">EAT, 2026</span>
        </span>
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} className="ml-1 h-8 rounded-md border border-line bg-white px-1.5 text-xs" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} h/s
            </option>
          ))}
        </select>
      </div>

      <div className="relative min-w-0 flex-1 select-none pt-5 pb-5">
        <div
          ref={track}
          className="relative h-10 cursor-pointer rounded-md bg-white ring-1 ring-line"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            seekFrom(e.clientX);
          }}
          onPointerMove={(e) => e.buttons === 1 && seekFrom(e.clientX)}
        >
          <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
            <polyline points={`0,40 ${spark} 1000,40`} fill="#fde4d3" stroke="#f08a4b" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          {days.map((m) => (
            <div key={m} className="absolute top-0 h-full border-l border-stone-200" style={{ left: pct(m) }} />
          ))}
          <div className="absolute inset-y-0 left-0 rounded-l-md bg-fire/10" style={{ width: pct(minute) }} />
          <div className="absolute -top-1 -bottom-1 w-0.5 bg-ink" style={{ left: pct(minute) }} />
        </div>

        {/* Day labels */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4">
          {days.slice(0, -1).map((m) => (
            <span key={m} className="absolute pl-1 text-[10px] text-muted" style={{ left: pct(m) }}>
              {fmtDay(fromMinutes(m, start))}
            </span>
          ))}
        </div>

        {/* Reported events and Sentinel-2 passes above the track */}
        <div className="absolute inset-x-0 top-0 h-5">
          {incident.events.map((e) => (
            <button
              key={e.time + e.title}
              title={`${fmtDayTime(new Date(`${e.time}Z`))} · ${e.title}`}
              onClick={() => onSeek(toMinutes(e.time, start))}
              className="absolute top-1 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] ring-2 ring-white"
              style={{ left: pct(toMinutes(e.time, start)), background: EVENT_COLOUR[e.kind] ?? "#555" }}
            />
          ))}
          {overpasses.map((o) => (
            <button
              key={o.date}
              title={`Sentinel-2 pass ${o.date} 10:40 · ${o.seen_burned_ha.toLocaleString()} ha seen burned`}
              onClick={() => onSeek(o.m)}
              className="absolute top-0.5 h-4 w-1 -translate-x-1/2 rounded-full bg-observed"
              style={{ left: pct(o.m) }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

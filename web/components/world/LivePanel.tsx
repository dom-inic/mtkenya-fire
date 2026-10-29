"use client";

import type { Incident } from "@/lib/hotspots";
import { minutesBetween } from "@/lib/hotspots";

export interface AlertItem {
  id: string;
  kind: "new" | "growing";
  at: string;
  text: string;
  channels: string[];
}

export interface ReportItem {
  id: string;
  at: string;
  type: string;
  lon: number;
  lat: number;
  note: string;
  by: string;
  photo: boolean;
}

const REPORT_ICON: Record<string, string> = { fire: "🔥", smoke: "💨", spot: "✳️", contained: "✅", crew: "👷", other: "📍" };

function ago(now: string, t: string) {
  const m = minutesBetween(t, now);
  if (m < 60) return `${Math.max(Math.round(m), 0)} min ago`;
  if (m < 48 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export default function LivePanel({
  source,
  setSource,
  now,
  drillAdvance,
  drillReset,
  status,
  incidents,
  selected,
  onSelect,
  skill,
  reports,
  alerts,
  onCheckAlerts,
  checking,
}: {
  source: "live" | "drill";
  setSource: (s: "live" | "drill") => void;
  now: string;
  drillAdvance: (hours: number) => void;
  drillReset: () => void;
  status: string;
  incidents: Incident[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  skill: { hits: number; total: number; issued: string } | null;
  reports: ReportItem[];
  alerts: AlertItem[];
  onCheckAlerts: () => void;
  checking: boolean;
}) {
  const high = incidents.filter((i) => i.priority === "high");
  const low = incidents.filter((i) => i.priority === "low");
  return (
    <div className="pointer-events-auto max-h-full w-[300px] overflow-y-auto rounded-lg bg-black/60 p-3 text-[11px] text-stone-200 shadow-xl backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold text-white">Live</span>
        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${source === "live" ? "bg-red-600 text-white" : "bg-amber-500 text-black"}`}>
          {source === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
          {source === "live" ? "LIVE" : "DRILL"}
        </span>
      </div>
      <div className="mb-2 flex gap-0.5 rounded-md bg-white/10 p-0.5">
        {(["live", "drill"] as const).map((s) => (
          <button key={s} onClick={() => setSource(s)} className={`flex-1 rounded px-1.5 py-1 ${source === s ? "bg-white font-medium text-ink" : "hover:bg-white/10"}`}>
            {s === "live" ? "NASA FIRMS, now" : "Drill: Sept 2026"}
          </button>
        ))}
      </div>
      {source === "drill" && (
        <div className="mb-2 rounded bg-amber-500/15 px-2 py-1.5 text-amber-100">
          <div className="font-mono font-semibold">{now.replace("T", " ")} EAT</div>
          <div className="mt-1 flex gap-1">
            {[1, 3, 6, 12].map((h) => (
              <button key={h} onClick={() => drillAdvance(h)} className="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20">
                +{h} h
              </button>
            ))}
            <button onClick={drillReset} className="ml-auto rounded px-1.5 py-0.5 text-amber-200 hover:bg-white/10">
              Restart
            </button>
          </div>
          <div className="mt-1 text-[10px] text-amber-200/80">The September fire as the satellites saw it, pass by pass. Advance the clock to get new detections.</div>
        </div>
      )}
      <div className="mb-2 text-[10.5px] text-stone-400">{status}</div>

      <div className="mb-1 font-medium text-white">Incidents ({high.length} high priority)</div>
      {incidents.length === 0 && <p className="rounded bg-white/5 px-2 py-2 text-stone-300">No fires detected on the mountain in the last 48 hours.</p>}
      <div className="space-y-1">
        {[...high, ...low].map((inc) => (
          <button
            key={inc.id}
            onClick={() => onSelect(selected === inc.id ? null : inc.id)}
            className={`w-full rounded-md px-2 py-1.5 text-left ${selected === inc.id ? "bg-orange-500/25 ring-1 ring-orange-400/60" : "bg-white/5 hover:bg-white/10"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-white">{inc.near ? `${inc.near.km} km from ${inc.near.name}` : "Fire"}</span>
              <span className={`shrink-0 rounded px-1 text-[9.5px] font-bold ${inc.priority === "high" ? "bg-red-600 text-white" : "bg-stone-500 text-white"}`}>{inc.priority === "high" ? "HIGH" : "LOW"}</span>
            </div>
            <div className="text-[10.5px] text-stone-300">
              {inc.setting} · {inc.detections.length} detection{inc.detections.length > 1 ? "s" : ""} · max {Math.round(inc.maxFrp)} MW
            </div>
            <div className="text-[10px] text-stone-400">
              first {ago(now, inc.first)} · latest {ago(now, inc.last)}
              {inc.priority === "low" && " · likely farm or land-clearing burn"}
            </div>
          </button>
        ))}
      </div>
      {skill && skill.total > 0 && (
        <div className="mt-2 rounded bg-sky-500/15 px-2 py-1.5 text-sky-100">
          Forecast check: <b>{skill.hits} of {skill.total}</b> detections since the {skill.issued.slice(11, 16)} forecast fell inside the area it predicted.
        </div>
      )}

      <div className="mt-3 mb-1 flex items-center justify-between">
        <span className="font-medium text-white">Field reports</span>
        <a href="/report" target="_blank" rel="noreferrer" className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">
          + New report
        </a>
      </div>
      {reports.length === 0 && <p className="text-stone-400">None yet. Rangers can send one from a phone at /report.</p>}
      <div className="space-y-1">
        {reports.slice(0, 6).map((r) => (
          <div key={r.id} className="rounded bg-white/5 px-2 py-1">
            <div className="flex justify-between">
              <span>
                {REPORT_ICON[r.type] ?? "📍"} <b className="text-white">{r.type}</b> {r.by && `· ${r.by}`}
              </span>
              <span className="text-stone-400">{new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {r.note && <div className="text-stone-300">{r.note}</div>}
            {r.photo && (
              <a href={`/api/reports/photo/${r.id}`} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                photo
              </a>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 mb-1 flex items-center justify-between">
        <span className="font-medium text-white">Alerts</span>
        <button onClick={onCheckAlerts} disabled={checking} className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20 disabled:opacity-50">
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      {alerts.length === 0 && <p className="text-stone-400">No alerts{source === "drill" ? " in this drill yet" : ""}.</p>}
      <div className="space-y-1">
        {alerts.slice(0, 5).map((a) => (
          <details key={a.id} className="rounded bg-white/5 px-2 py-1">
            <summary className="cursor-pointer">
              <b className="text-white">{a.kind === "new" ? "New fire" : "Growing"}</b> · {a.at.replace("T", " ")} · <span className="text-stone-400">{a.channels.join(", ")}</span>
            </summary>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-[10.5px] text-stone-300">{a.text}</pre>
          </details>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-snug text-stone-500">
        Alerts go to the channels set on the server (Telegram, Africa&apos;s Talking SMS, webhook). Drills and servers without channels only log them (&ldquo;dry-run&rdquo;).
      </p>
    </div>
  );
}

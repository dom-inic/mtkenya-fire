import { clusterIncidents, minutesBetween, type Incident } from "../hotspots";
import { run } from "../run";
import { forecast, nowEat } from "../scenario";
import { drillDetections, recentDetections } from "./firms";
import { readJson, writeJson } from "./store";
import { serverWorld } from "./world";

export interface Alert {
  id: string;
  incident: string;
  kind: "new" | "growing";
  at: string; // EAT
  text: string;
  channels: string[]; // where it went; ["dry-run"] when nothing is configured
  forecast: { ha24: number; threats: { name: string; hours: number }[]; crewHours: number | null } | null;
}

interface Log {
  alerts: Alert[];
  seen: Record<string, { at: string; detections: number }>;
}

const REALERT_MIN = 6 * 60; // at most one "growing" alert per incident every 6 h
const GROWTH = 5; // ...and only after this many new detections

/** Forecast the next 24 h for an incident from its latest detections and the live weather. */
async function quickForecast(inc: Incident, now: string, drill: boolean) {
  const w = await serverWorld();
  const recent = inc.detections.filter((d) => minutesBetween(d.t, inc.last) <= 12 * 60);
  let hours;
  if (drill) {
    // The weather that actually followed, from the drill hour on
    const i0 = Math.max(w.septWeather.findIndex((x) => x.time === `${now.slice(0, 13)}:00`), 0);
    hours = w.septWeather.slice(i0, i0 + 25);
  } else {
    try {
      hours = (await forecast(inc.lat, inc.lon, 3300, 25)).hours;
    } catch {
      hours = null;
    }
  }
  if (!hours?.length) hours = Array.from({ length: 25 }, () => ({ wind_kmh: 12, wind_from: 100, rh: 45, rain_mm: 0 }));
  const bases = w.places.filter((p) => ["gate", "station", "airstrip"].includes(p.kind));
  const r = run(w.engine, {
    ignition: { lon: recent[recent.length - 1].lon, lat: recent[recent.length - 1].lat },
    seeds: recent.map((d) => ({ lon: d.lon, lat: d.lat, t: 0 })),
    hours: 24,
    weather: hours,
    params: w.params,
    breaks: [],
    breakCells: [],
    bases,
    mobiliseMin: 60,
    ensemble: false,
  });
  const g = r.grid;
  const at = (lon: number, lat: number) => {
    const x = Math.floor((lon - g.west) / g.dLon);
    const y = Math.floor((g.north - lat) / g.dLat);
    return x < 0 || y < 0 || x >= g.w || y >= g.h ? Infinity : r.arrival[y * g.w + x];
  };
  const threats = w.places
    .filter((p) => ["place", "gate", "station", "alpine_hut", "wilderness_hut", "camp_site", "airstrip"].includes(p.kind))
    .map((p) => ({ name: p.name, hours: at(p.lon, p.lat) / 60 }))
    .filter((t) => Number.isFinite(t.hours))
    .sort((a, b) => a.hours - b.hours)
    .slice(0, 3);
  const eta = r.eta[Math.floor((g.north - inc.lat) / g.dLat) * g.w + Math.floor((inc.lon - g.west) / g.dLon)];
  return { ha24: r.series[24].ha, threats, crewHours: Number.isFinite(eta) ? Math.round((eta / 60) * 10) / 10 : null };
}

function message(inc: Incident, kind: Alert["kind"], f: Alert["forecast"]) {
  const time = (t: string) => t.slice(11, 16);
  const lines = [
    `${kind === "new" ? "🔥 New fire" : "🔥 Fire growing"} on Mount Kenya (high priority)`,
    `${inc.detections.length} satellite detection${inc.detections.length > 1 ? "s" : ""} in ${inc.setting}${inc.near ? `, ${inc.near.km} km from ${inc.near.name}` : ""}.`,
    `First seen ${inc.first.slice(0, 10)} ${time(inc.first)} EAT, latest ${time(inc.last)}, max ${Math.round(inc.maxFrp)} MW.`,
    `Location: ${Math.abs(inc.lat).toFixed(4)}°${inc.lat < 0 ? "S" : "N"} ${inc.lon.toFixed(4)}°E`,
  ];
  if (f) {
    lines.push(`Forecast: ~${f.ha24.toLocaleString()} ha in 24 h${f.threats.length ? `; reaches ${f.threats.map((t) => `${t.name} in ~${t.hours.toFixed(1)} h`).join(", ")}` : ""}.`);
    if (f.crewHours != null) lines.push(`Nearest ground crew ~${f.crewHours} h away.`);
  }
  if (process.env.APP_URL) lines.push(`${process.env.APP_URL}`);
  return lines.join("\n");
}

/** Send through every configured channel; returns the ones used. */
async function deliver(text: string): Promise<string[]> {
  const used: string[] = [];
  const env = process.env;
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    if (r.ok) used.push("telegram");
  }
  if (env.AT_USERNAME && env.AT_API_KEY && env.ALERT_SMS_TO) {
    const host = env.AT_USERNAME === "sandbox" ? "api.sandbox.africastalking.com" : "api.africastalking.com";
    const r = await fetch(`https://${host}/version1/messaging`, {
      method: "POST",
      headers: { apiKey: env.AT_API_KEY, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: env.AT_USERNAME, to: env.ALERT_SMS_TO, message: text.slice(0, 459) }),
    });
    if (r.ok) used.push("sms");
  }
  if (env.ALERT_WEBHOOK_URL) {
    const r = await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (r.ok) used.push("webhook");
  }
  return used.length ? used : ["dry-run"];
}

/**
 * Look at the latest detections and raise alerts: a new high-priority
 * incident, or one that keeps growing (5+ new detections, at most every 6 h).
 * `drill` (an EAT time) evaluates the September 2026 fire as if it were live.
 */
export async function checkAlerts(drill?: string) {
  const w = await serverWorld();
  const now = drill ?? nowEat();
  const dets = drill ? await drillDetections(drill) : (await recentDetections(2)).detections;
  const incidents = clusterIncidents(dets, w.fuelAt, w.places);
  const logName = drill ? "alerts-drill.json" : "alerts.json";
  const log = await readJson<Log>(logName, { alerts: [], seen: {} });
  const raised: Alert[] = [];
  for (const inc of incidents.filter((i) => i.priority === "high")) {
    const prev = log.seen[inc.id];
    const kind: Alert["kind"] | null = !prev ? "new" : inc.detections.length - prev.detections >= GROWTH && minutesBetween(prev.at, now) >= REALERT_MIN ? "growing" : null;
    if (!kind) continue;
    const f = await quickForecast(inc, now, !!drill);
    const text = message(inc, kind, f);
    const alert: Alert = { id: `${inc.id}_${now}`, incident: inc.id, kind, at: now, text, channels: drill ? ["dry-run"] : await deliver(text), forecast: f };
    log.alerts.unshift(alert);
    log.seen[inc.id] = { at: now, detections: inc.detections.length };
    raised.push(alert);
  }
  log.alerts = log.alerts.slice(0, 200);
  await writeJson(logName, log);
  return { now, incidents: incidents.length, high: incidents.filter((i) => i.priority === "high").length, raised, recent: log.alerts.slice(0, 20) };
}

export async function recentAlerts(drill = false) {
  return (await readJson<Log>(drill ? "alerts-drill.json" : "alerts.json", { alerts: [], seen: {} })).alerts.slice(0, 20);
}

export async function resetDrill() {
  await writeJson("alerts-drill.json", { alerts: [], seen: {} });
}

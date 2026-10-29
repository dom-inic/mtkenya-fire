"use client";

import { useEffect, useState } from "react";

const TYPES = [
  { id: "fire", label: "Fire", icon: "🔥" },
  { id: "smoke", label: "Smoke", icon: "💨" },
  { id: "spot", label: "Spot fire ahead", icon: "✳️" },
  { id: "contained", label: "Contained here", icon: "✅" },
  { id: "crew", label: "Crew position", icon: "👷" },
  { id: "other", label: "Other", icon: "📍" },
] as const;

/** Shrink a phone photo to <= 1600 px JPEG so it uploads on a weak signal. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, err) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = err;
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ReportPage() {
  const [type, setType] = useState<string>("fire");
  const [pos, setPos] = useState<{ lat: number; lon: number; acc?: number } | null>(null);
  const [gpsMsg, setGpsMsg] = useState("");
  const [manual, setManual] = useState({ lat: "", lon: "" });
  const [note, setNote] = useState("");
  const [by, setBy] = useState("");
  const [token, setToken] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    try {
      setBy(localStorage.getItem("report-by") ?? "");
      setToken(localStorage.getItem("report-token") ?? "");
    } catch {
      // storage unavailable (private mode): fields just start empty
    }
  }, []);

  const locate = () => {
    if (!navigator.geolocation) return setGpsMsg("This phone has no GPS access in the browser. Enter the position below.");
    setGpsMsg("Getting position…");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy });
        setGpsMsg("");
      },
      (e) => setGpsMsg(`No GPS fix (${e.message}). Enter the position below.`),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  };

  const send = async () => {
    const lat = pos?.lat ?? Number(manual.lat);
    const lon = pos?.lon ?? Number(manual.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!pos && (!manual.lat || !manual.lon))) {
      setStatus({ ok: false, text: "Add a position first (GPS or typed in)." });
      return;
    }
    setSending(true);
    setStatus(null);
    try {
      try {
        localStorage.setItem("report-by", by);
        localStorage.setItem("report-token", token);
      } catch {
        // not fatal
      }
      const r = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ type, lat, lon, accuracyM: pos?.acc, note, by, photo }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setStatus({ ok: true, text: "Sent. It's on the live map now." });
      setNote("");
      setPhoto(null);
    } catch (e) {
      setStatus({ ok: false, text: `Not sent: ${(e as Error).message}` });
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen max-w-md bg-paper px-4 py-5 text-ink">
      <h1 className="text-lg font-semibold">Field report</h1>
      <p className="mb-4 text-sm text-muted">Mount Kenya fire watch · goes straight to the live map</p>

      <div className="mb-4 grid grid-cols-2 gap-2">
        {TYPES.map((t) => (
          <button key={t.id} onClick={() => setType(t.id)} className={`rounded-lg border px-3 py-3 text-left text-sm font-medium ${type === t.id ? "border-fire bg-fire-soft" : "border-line bg-white"}`}>
            <span className="mr-1.5 text-lg">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <section className="mb-4 rounded-lg border border-line bg-white p-3">
        <button onClick={locate} className="w-full rounded-md bg-ink py-2.5 text-sm font-semibold text-white">
          📍 Use my GPS position
        </button>
        {pos && (
          <p className="mt-2 font-mono text-sm">
            {Math.abs(pos.lat).toFixed(5)}°{pos.lat < 0 ? "S" : "N"} {pos.lon.toFixed(5)}°E {pos.acc ? `· ±${Math.round(pos.acc)} m` : ""}
          </p>
        )}
        {gpsMsg && <p className="mt-2 text-sm text-amber-700">{gpsMsg}</p>}
        {!pos && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input inputMode="decimal" placeholder="Latitude, e.g. -0.0754" value={manual.lat} onChange={(e) => setManual({ ...manual, lat: e.target.value })} className="rounded border border-line px-2 py-2 text-sm" />
            <input inputMode="decimal" placeholder="Longitude, e.g. 37.4653" value={manual.lon} onChange={(e) => setManual({ ...manual, lon: e.target.value })} className="rounded border border-line px-2 py-2 text-sm" />
          </div>
        )}
      </section>

      <textarea placeholder="What do you see? Size, direction, wind…" value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="mb-3 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" />

      <label className="mb-3 block rounded-lg border border-dashed border-line bg-white px-3 py-3 text-sm">
        📷 {photo ? "Photo added (tap to change)" : "Add a photo (optional)"}
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async (e) => e.target.files?.[0] && setPhoto(await shrink(e.target.files[0]))} />
      </label>

      <div className="mb-4 grid grid-cols-2 gap-2">
        <input placeholder="Your name / unit" value={by} onChange={(e) => setBy(e.target.value)} className="rounded border border-line bg-white px-2 py-2 text-sm" />
        <input placeholder="Access code (if any)" value={token} onChange={(e) => setToken(e.target.value)} className="rounded border border-line bg-white px-2 py-2 text-sm" />
      </div>

      <button onClick={send} disabled={sending} className="w-full rounded-lg bg-fire py-3 text-base font-semibold text-white disabled:opacity-60">
        {sending ? "Sending…" : "Send report"}
      </button>
      {status && <p className={`mt-3 text-sm ${status.ok ? "text-emerald-700" : "text-red-700"}`}>{status.text}</p>}
    </main>
  );
}

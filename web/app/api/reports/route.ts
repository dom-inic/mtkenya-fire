import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, readJson, writeJson } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface FieldReport {
  id: string;
  at: string; // ISO UTC
  type: "fire" | "smoke" | "spot" | "contained" | "crew" | "other";
  lon: number;
  lat: number;
  accuracyM?: number;
  note: string;
  by: string;
  photo: boolean;
}

const TYPES = new Set(["fire", "smoke", "spot", "contained", "crew", "other"]);

export async function GET() {
  return Response.json({ reports: await readJson<FieldReport[]>("reports.json", []) });
}

/**
 * POST a report: {type, lon, lat, accuracyM?, note?, by?, photo? (data URL, JPEG/PNG, < 4 MB)}.
 * If REPORT_TOKEN is set, send it as "Authorization: Bearer <token>".
 */
export async function POST(req: Request) {
  const token = process.env.REPORT_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  const b = (await req.json().catch(() => null)) as Partial<FieldReport> & { photo?: string } | null;
  if (!b || !TYPES.has(String(b.type)) || !Number.isFinite(b.lon) || !Number.isFinite(b.lat)) {
    return Response.json({ error: "type, lon and lat are required" }, { status: 400 });
  }
  const id = randomUUID();
  let photo = false;
  if (typeof b.photo === "string") {
    const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(b.photo);
    if (!m || m[2].length > 5_500_000) return Response.json({ error: "photo must be a JPEG or PNG under 4 MB" }, { status: 400 });
    await fs.mkdir(path.join(DATA_DIR, "photos"), { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, "photos", `${id}.${m[1] === "png" ? "png" : "jpg"}`), Buffer.from(m[2], "base64"));
    photo = true;
  }
  const report: FieldReport = {
    id,
    at: new Date().toISOString(),
    type: b.type as FieldReport["type"],
    lon: Number(b.lon),
    lat: Number(b.lat),
    accuracyM: Number.isFinite(b.accuracyM) ? Math.round(Number(b.accuracyM)) : undefined,
    note: String(b.note ?? "").slice(0, 1000),
    by: String(b.by ?? "").slice(0, 80),
    photo,
  };
  const all = await readJson<FieldReport[]>("reports.json", []);
  all.unshift(report);
  await writeJson("reports.json", all.slice(0, 1000));
  return Response.json({ report });
}

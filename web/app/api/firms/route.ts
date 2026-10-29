import { drillDetections, recentDetections } from "@/lib/server/firms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/firms?days=2 (live) or ?drill=2026-09-02T06:00 (September as if live). */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const drill = q.get("drill");
  if (drill) return Response.json({ checked: drill, detections: await drillDetections(drill), drill: true });
  const days = Math.min(Math.max(Number(q.get("days") ?? 2), 1), 5);
  return Response.json(await recentDetections(days));
}

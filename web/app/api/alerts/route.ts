import { checkAlerts, recentAlerts, resetDrill } from "@/lib/server/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: recent alerts. ?drill=1 for the drill log. */
export async function GET(req: Request) {
  const drill = new URL(req.url).searchParams.has("drill");
  return Response.json({ alerts: await recentAlerts(drill) });
}

/**
 * POST: run the alert check now (a scheduler calls this every 10-15 min).
 * Body {drill: "2026-09-02T06:00"} evaluates the September fire as if live
 * (never sends); {resetDrill: true} clears the drill log.
 * If ALERT_CHECK_TOKEN is set, send it as "Authorization: Bearer <token>".
 */
export async function POST(req: Request) {
  const token = process.env.ALERT_CHECK_TOKEN;
  const body = (await req.json().catch(() => ({}))) as { drill?: string; resetDrill?: boolean };
  if (token && req.headers.get("authorization") !== `Bearer ${token}` && !body.drill) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  if (body.resetDrill) {
    await resetDrill();
    return Response.json({ ok: true });
  }
  return Response.json(await checkAlerts(body.drill));
}

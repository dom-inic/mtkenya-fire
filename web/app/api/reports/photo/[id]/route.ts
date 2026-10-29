import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("not found", { status: 404 });
  for (const [ext, type] of [["jpg", "image/jpeg"], ["png", "image/png"]] as const) {
    try {
      const data = await fs.readFile(path.join(DATA_DIR, "photos", `${id}.${ext}`));
      return new Response(new Uint8Array(data), { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
    } catch {
      // try the next extension
    }
  }
  return new Response("not found", { status: 404 });
}

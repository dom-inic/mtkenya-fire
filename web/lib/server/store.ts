import { promises as fs } from "node:fs";
import path from "node:path";

/** Prototype storage: JSON files under web/.data (gitignored). Use a database in production. */
export const DATA_DIR = path.join(process.cwd(), ".data");

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(name: string, data: unknown) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 1));
  await fs.rename(`${file}.tmp`, file);
}

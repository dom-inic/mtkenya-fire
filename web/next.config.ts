import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Keys live in the project-root .env shared with the data pipeline. Next has
// already loaded (and cached) web/'s own env by now, so force a reload of the
// root one and hand the public token to the client bundle explicitly.
const { combinedEnv } = loadEnvConfig(
  path.resolve(process.cwd(), ".."),
  process.env.NODE_ENV !== "production",
  { info: () => {}, error: console.error },
  true,
);

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_MAPBOX_TOKEN: combinedEnv.NEXT_PUBLIC_MAPBOX_TOKEN ?? "" },
};

export default nextConfig;

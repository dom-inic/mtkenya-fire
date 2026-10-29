# Mount Kenya Fire Analysis: web app

Next.js 15 app with three tabs: Incident (map replay), Drones (simulated fleet)
and Simulator (3D world with a what-if planner). See the [project README](../README.md)
for what it shows, how the data is built, and its limits.

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # production build
pnpm lint
```

Keys are read from the project-root `.env` (see `next.config.ts`). The app
reads its data from `public/data`, built by `pipeline/build.py`.

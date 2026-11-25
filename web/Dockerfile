# Production image for the web app. The data it serves is in the repo
# (public/data), so the pipeline doesn't need to run here.
#
#   docker build --build-arg NEXT_PUBLIC_MAPBOX_TOKEN=pk.… -t mtkenya-fire .
#   docker run -p 3000:3000 --env-file ../.env -v mtkenya-fire-data:/app/.data mtkenya-fire

FROM node:22-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public token: Next bakes it into the browser bundle at build time
ARG NEXT_PUBLIC_MAPBOX_TOKEN
ENV NEXT_PUBLIC_MAPBOX_TOKEN=${NEXT_PUBLIC_MAPBOX_TOKEN}
RUN pnpm build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs \
 && mkdir .data && chown nextjs:nodejs .data
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
# Field reports, photos and the alert log: mount a volume here to keep them
VOLUME /app/.data
CMD ["node", "server.js"]

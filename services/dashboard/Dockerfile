# ── S1.4 — Production build (no more `next dev`) ────────────────────────────
# Multi-stage build that compiles the Next.js app with `next build` (output:
# "standalone") and runs the optimized production server. The previous image
# ran `next dev` in production, which exposed source maps, the HMR WebSocket
# endpoint, and detailed dev-only error overlays. Switching to build+start
# closes those attack surfaces.

# ── Stage 1: dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── Stage 2: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Reuse node_modules from the deps stage; copy source over the top.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the standalone output. Next.js sets output: "standalone" in
# next.config.ts, so this produces .next/standalone/ as a self-contained
# Node.js server with deps bundled.
RUN npm run build

# ── Stage 3: production runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user for defense-in-depth — the container runs as `nextjs` so
# even a container escape lands in an unprivileged account.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone build output (server + bundled deps).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets (these are referenced from the standalone bundle by relative path).
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Public dir (logo, favicon, etc.) — standalone doesn't bundle these.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# The standalone server reads HOSTNAME/PORT from env. Logs go to stdout/stderr.
CMD ["node", "server.js"]

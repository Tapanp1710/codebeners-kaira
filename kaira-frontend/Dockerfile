# KAIRA frontend - production image (Next.js standalone output)
# Three stages: deps (locked install), build (next build), runner (standalone server + static assets only).
# Only the runner stage becomes the final image; full node_modules and source stay in the earlier stages.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Copying only the manifests first lets Docker cache this npm ci layer until dependencies change.
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
# Opt out of Next.js anonymous telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
# Whole build context; .dockerignore keeps out node_modules, .next, .git and every .env* file except .env.example.
COPY . .
# BACKEND_ORIGIN is read at RUNTIME by the server; the build does not need it.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# HOSTNAME=0.0.0.0 makes the standalone server listen on all interfaces so it is reachable from outside the container.
# BACKEND_ORIGIN (and optionally BACKEND_TIMEOUT_MS) is supplied at run time, e.g. docker run -e BACKEND_ORIGIN=...
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Unprivileged system user and group: the server never runs as root.
RUN addgroup -S kaira && adduser -S kaira -G kaira
# output: "standalone" (next.config) emits server.js with a traced minimal node_modules; static assets
# are not part of it and are copied separately. Files are owned by the kaira user.
COPY --from=build --chown=kaira:kaira /app/.next/standalone ./
COPY --from=build --chown=kaira:kaira /app/.next/static ./.next/static
USER kaira
EXPOSE 3000
# Health check with busybox wget (no curl in alpine) against /login, the same readiness URL the start scripts use.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/login || exit 1
# server.js is the standalone entry point; it reads PORT and HOSTNAME from the environment.
CMD ["node", "server.js"]

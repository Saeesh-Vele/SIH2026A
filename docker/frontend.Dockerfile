# ═══════════════════════════════════════════════════════════════
#  Aurora — frontend (Vite build served by nginx, which also reverse-proxies the
#  backend so the browser sees a single origin).
#
#  Build:  docker build -f docker/frontend.Dockerfile -t aurora-frontend .
# ═══════════════════════════════════════════════════════════════
ARG NODE_VERSION=22
ARG NGINX_VERSION=1.29

# ── Stage 1: build the static bundle ──────────────────────────
# Debian, not Alpine: Vite 8 (Rolldown) and oxlint ship native bindings per libc, and
# package-lock.json carries no `libc` field for them, so glibc is the safe match. Only
# this stage is Debian — the image that ships is nginx:alpine.
FROM node:${NODE_VERSION}-bookworm-slim AS builder

# Single origin: the browser calls /api and /ws on its own host and nginx proxies both,
# so there is no CORS to configure and no backend address baked into the JavaScript.
# src/config.js resolves ws:// or wss:// from window.location for a relative WS path.
ARG VITE_API_URL=/api
ARG VITE_WS_URL=/ws/station
# Firebase stays off (P0-6): the SDK is a dynamic import, so it is not even bundled.
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_WS_URL=${VITE_WS_URL} \
    VITE_ENABLE_FIREBASE=false

WORKDIR /build

# npm ci needs only the manifests; this layer is cached until a dependency changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY public/ ./public/
COPY src/ ./src/
# Station facts live in ONE file (CLAUDE.md), and src/data/stationConfig.js imports it
# at build time as ../../simulator/station_config.json — so it must sit beside src/ at
# the same relative depth, or the bundle cannot resolve it.
COPY simulator/station_config.json ./simulator/station_config.json
# The assistant's action whitelist, shared with the backend (src/assistant/actions.js imports it).
COPY simulator/assistant_actions.json ./simulator/assistant_actions.json

RUN npm run build

# ── Stage 2: serve ────────────────────────────────────────────
FROM nginx:${NGINX_VERSION}-alpine AS runtime

LABEL org.opencontainers.image.title="Aurora frontend" \
      org.opencontainers.image.description="Aurora UI (nginx) + reverse proxy to the unified backend (SIH PS 26060)" \
      org.opencontainers.image.source="https://github.com/Saeesh-Vele/SIH2026A" \
      org.opencontainers.image.licenses="MIT"

RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /build/dist /usr/share/nginx/html
# A template, not conf.d: the nginx entrypoint runs envsubst over /etc/nginx/templates.
COPY docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY docker/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf

# The upstream host:port is templated so compose (or another orchestrator) can move the
# backend without rebuilding. nginx substitutes these into the conf at container start.
# NGINX_ENTRYPOINT_LOCAL_RESOLVERS makes the entrypoint export NGINX_LOCAL_RESOLVERS from
# the container's /etc/resolv.conf, which the template needs for per-request DNS (see the
# comment in nginx.conf). The envsubst filter is kept to just those names, so nginx's own
# $variables in the template are never touched.
ENV BACKEND_HOST=backend \
    BACKEND_PORT=8080 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER='^(BACKEND_|NGINX_LOCAL_RESOLVERS)'

# nginx:alpine runs as root only to bind :80 and then drops to the `nginx` user for
# workers (`user nginx;` in the base nginx.conf). The image ships no application code
# and no credentials; keeping the master process able to bind :80 is what lets this
# work unchanged on a host that publishes port 80 directly.
EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/healthz || exit 1

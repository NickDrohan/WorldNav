# --- Build stage: compile the Vite app with the live cloud endpoint baked in ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The orchestrator endpoint is inlined at build time (import.meta.env.VITE_*).
# Defaults point at the production EarthRelay cloud; override with --build-arg.
ARG VITE_ORCHESTRATOR_URL=https://earthrelay.fly.dev/orchestrate
ARG VITE_AGENT_URL=https://earthrelay.fly.dev/agent/ingest
ENV VITE_ORCHESTRATOR_URL=$VITE_ORCHESTRATOR_URL
ENV VITE_AGENT_URL=$VITE_AGENT_URL
RUN npm run build

# --- Serve stage: static file server with SPA fallback ---
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80

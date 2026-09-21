# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# NocoDB (from source) — multi-stage build
#
# Builds the backend server bundle (rspack) and serves the prebuilt frontend
# (nc-lib-gui, a published dependency). Native modules (sqlite3, sharp, canvas)
# are compiled/downloaded in the build stage for the target platform.
#
# Build:
#   docker build -t nocodb:local .
#
# Run (SQLite):
#   docker run -d -p 8080:8080 -v "$(pwd)/data:/usr/app/data" nocodb:local
#
# Run (Postgres + LDAP):
#   docker run -d -p 8080:8080 \
#     -e NC_DB="pg://host.docker.internal:5432?u=root&p=password&d=noco" \
#     -e NC_AUTH_JWT_SECRET="<random>" \
#     -e NC_LDAP_URL="ldap://ldap.example.com:389" \
#     -e NC_LDAP_BIND_DN="cn=admin,dc=example,dc=com" \
#     -e NC_LDAP_BIND_PASSWORD="admin" \
#     -e NC_LDAP_SEARCH_BASE="ou=people,dc=example,dc=com" \
#     -e NC_LDAP_SEARCH_FILTER="(mail={{email}})" \
#     nocodb:local
# ---------------------------------------------------------------------------

# Node version matches `.npmrc` (use-node-version=24.14.0).
FROM node:24-bookworm AS build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# The workspace root's prepare script is `husky install`, which needs a git
# repo — .git is excluded from the build context, so make husky a no-op.
ENV HUSKY=0

# Pin pnpm to the version that generated pnpm-lock.yaml (pnpm 10.33.x).
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Build tools so native modules (sqlite3, sharp, canvas) can compile if no
# prebuilt binary matches the target Node ABI.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Full source first — pnpm-workspace.yaml lists every package and
# `--frozen-lockfile` requires all of them to be present.
COPY . .

# Build the SDK first. The workspace-wide install below runs nc-gui's postinstall
# (`nuxt prepare`), which loads nc-gui/uno.config.ts -> utils/colorsUtils.ts, which
# imports `nocodb-sdk`. If build/main is missing by then, that install dies with
#   Cannot find module '.../nc-gui/node_modules/nocodb-sdk/build/main/index.js'.
# The filtered install links only the SDK's own dependencies, so no other
# project's postinstall runs at this point.
RUN pnpm --filter=nocodb-sdk install --frozen-lockfile \
  && pnpm --filter=nocodb-sdk run build

# Install the remaining workspace dependencies. Build-time tooling only —
# pnpm 10 blocks native module scripts at the workspace level (no
# onlyBuiltDependencies here); the runtime natives are built in the deploy
# step below, where packages/nocodb's own approval list applies.
RUN pnpm install --frozen-lockfile

# Integrations + backend server bundle.
RUN pnpm run integrations:build \
  && pnpm run registerIntegrations \
  && pnpm --filter=nocodb run build:docker

# Prune the backend's dependencies down to production only. The workspace's
# node_modules holds every package's modules — dev dependencies included (nuxt,
# next, playwright, rspack …) — and the runtime stage used to copy all of it,
# carrying several gigabytes the server never loads. `pnpm deploy` materialises
# just what packages/nocodb needs at runtime, as a self-contained tree whose
# flat symlinks resolve inside its own .pnpm, pointing nowhere outside it.
#
# --legacy because pnpm >=10 refuses to deploy a workspace whose packages are
# not injected; the alternative is changing the workspace's install settings.
# The tree carries one absolute symlink back to the workspace package itself;
# it would dangle in the runtime image, so it goes.
RUN pnpm --filter=nocodb deploy --prod --legacy /app/deploy \
  && rm -f /app/deploy/node_modules/nocodb

# ---------------------------------------------------------------------------
# Runtime image.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    NC_APP_DATA_DIR=/usr/app/data \
    NC_GUI_DIST_PATH=/app/packages/nocodb/node_modules/nc-lib-gui/lib/dist

WORKDIR /app

# The pruned production tree in place of the whole store. It resolves on its
# own, so nothing is needed at /app/node_modules.
COPY --from=build /app/deploy/node_modules ./packages/nocodb/node_modules

# Backend server bundle + static assets.
COPY --from=build /app/packages/nocodb/dist ./packages/nocodb/dist
COPY --from=build /app/packages/nocodb/package.json ./packages/nocodb/package.json

# The login form ships prebuilt in nc-lib-gui, and it rejects anything without
# an "@" before the request is even sent — which blocks LDAP users signing in
# with their uid. Relax that in the bundle (see the script for what it rewrites);
# it fails the build rather than silently shipping an unpatched GUI.
COPY docker/patch-nc-gui-login.mjs ./docker/patch-nc-gui-login.mjs
RUN node docker/patch-nc-gui-login.mjs packages/nocodb/node_modules

# Data volume (SQLite / attachments). Matches NocoDB's default data dir.
# The server runs as root, like the official image: volumes created by other
# builds (or by root on the host) stay writable, avoiding the EACCES that
# uid-scoped images hit on bind mounts and pre-existing external volumes.
RUN mkdir -p /usr/app/data

WORKDIR /app/packages/nocodb

EXPOSE 8080
CMD ["node", "dist/main.js"]

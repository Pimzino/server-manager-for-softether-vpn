# SoftEther Manager — management server + web UI
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/api-catalog/package.json packages/api-catalog/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @sem/web run build

FROM node:24-bookworm-slim
# msitools provides wixl / msiinfo / msibuild for building client MSIs; openssl for the self-signed UI cert
RUN apt-get update && apt-get install -y --no-install-recommends wixl msitools openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
COPY package.json ./
ENV SEM_HOST=0.0.0.0 SEM_PORT=8443 SEM_DATA_DIR=/data NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8443
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "fetch('https://127.0.0.1:8443/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]

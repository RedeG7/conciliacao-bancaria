# WhatsApp Disparos (monorepo pnpm vindo do Replit): builda o front (Vite) e
# a API (esbuild) e roda so a API, que tambem serve o front.
# Debian (glibc), nao Alpine: o pnpm-workspace.yaml remove os binarios
# "linux-x64-musl" do esbuild/rollup/tailwind/lightningcss.
FROM node:24-bookworm-slim

RUN npm install -g pnpm@10.18.3 && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

# o vite.config.ts exige PORT e BASE_PATH mesmo para o build
RUN PORT=3000 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/whatsapp-disparos run build \
  && NODE_ENV=production pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/artifacts/whatsapp-disparos/dist/public \
    WHATSAPP_SESSION_DIR=/data/whatsapp-session \
    UPLOADS_DIR=/data/uploads

RUN chmod +x docker-entrypoint.sh
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./docker-entrypoint.sh"]

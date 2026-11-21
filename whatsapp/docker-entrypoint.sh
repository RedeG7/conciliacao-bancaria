#!/bin/sh
# Prepara o banco e sobe a API (que tambem serve o front - ver app.ts).
set -e

mkdir -p "$WHATSAPP_SESSION_DIR" "$UPLOADS_DIR/templates"

# 1) cria o banco "whatsapp" no Postgres do Hub, se ainda nao existir
node lib/db/ensure-db.mjs

# 2) cria/atualiza as tabelas a partir do schema (lib/db/src/schema). Sem
#    TTY o drizzle-kit nao pergunta nada: se uma mudanca exigir confirmacao
#    (ex.: apagar coluna com dados), so avisa no log e o app sobe com o
#    banco como esta.
(cd lib/db && timeout 180 pnpm exec drizzle-kit push --config ./drizzle.config.ts </dev/null) \
  || echo "AVISO: drizzle-kit push nao concluiu - confira o schema do banco"

exec node --enable-source-maps artifacts/api-server/dist/index.mjs

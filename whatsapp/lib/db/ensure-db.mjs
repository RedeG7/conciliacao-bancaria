// Cria o banco do WhatsApp Disparos no Postgres do Hub se ele ainda nao
// existir (o container "db" so cria sozinho o banco do Hub). Roda no
// entrypoint do container, antes do drizzle-kit push. DATABASE_URL aponta
// para o banco do app; a conexao administrativa usa o mesmo usuario no banco
// "postgres".
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL nao definida");
  process.exit(1);
}

const alvo = new URL(url);
const nome = decodeURIComponent(alvo.pathname.replace(/^\//, ""));
if (!/^[a-z_][a-z0-9_]*$/.test(nome)) {
  console.error(`Nome de banco invalido: ${nome}`);
  process.exit(1);
}

const admin = new URL(url);
admin.pathname = "/postgres";

for (let tentativa = 1; ; tentativa++) {
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const r = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [nome]);
    if (r.rowCount === 0) {
      await client.query(`CREATE DATABASE "${nome}"`);
      console.log(`Banco ${nome} criado`);
    } else {
      console.log(`Banco ${nome} ja existe`);
    }
    await client.end();
    break;
  } catch (err) {
    await client.end().catch(() => {});
    if (tentativa >= 15) {
      console.error("Nao foi possivel preparar o banco:", err.message);
      process.exit(1);
    }
    console.log(`Postgres ainda nao respondeu (tentativa ${tentativa}), aguardando...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

'use strict';
// Banco de dados: SQLite embutido no Node (node:sqlite).
// auth.db  -> usuários, sessões e configurações gerais
// real-<escritorio>.db -> dados reais de cada escritório do Hub (um arquivo por
//                         escritório: um escritório nunca enxerga os dados de outro)
// demo-<escritorio>.db -> dados fictícios do modo demonstração, também por escritório
// real.db / demo.db    -> dados de usuários sem escritório (cadastro antigo, antes do Hub)
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function open(file) {
  const db = new DatabaseSync(path.join(DATA_DIR, file));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

const { AUTH_SCHEMA, DATA_SCHEMA, seedLists } = require('./schema');

const auth = open('auth.db');
auth.exec(AUTH_SCHEMA);
// login único vindo do Hub (ver src/sso.js): liga o usuário daqui ao usuário do Hub
try { auth.exec('ALTER TABLE users ADD COLUMN hub_user TEXT'); } catch (e) { /* coluna já existe */ }
auth.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_hub_user ON users(hub_user)');

// escritório do Hub dono do usuário (ver /sso em server.js) - define qual
// arquivo de dados ele enxerga
try { auth.exec('ALTER TABLE users ADD COLUMN office TEXT'); } catch (e) { /* coluna já existe */ }
// nome do escritório e, para o super administrador do Hub (is_global), a lista
// de escritórios que ele pode escolher; sessions.office = escritório escolhido
for (const sql of ['ALTER TABLE users ADD COLUMN office_name TEXT',
  'ALTER TABLE users ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN offices TEXT',
  'ALTER TABLE sessions ADD COLUMN office TEXT']) {
  try { auth.exec(sql); } catch (e) { /* coluna já existe */ }
}

// id do escritório -> trecho seguro para nome de arquivo
const officeSlug = office => String(office || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
const dbFile = (mode, office) => (officeSlug(office) ? `${mode}-${officeSlug(office)}.db` : `${mode}.db`);

const dbs = {};
function dataDb(mode, office) {
  const m = mode === 'demo' ? 'demo' : 'real';
  const file = dbFile(m, office);
  if (!dbs[file]) {
    const db = open(file);
    db.exec(DATA_SCHEMA);
    seedLists(db);
    dbs[file] = db;
    if (m === 'demo') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
      if (!n) require('./demo').seed(db, office);
    }
  }
  return dbs[file];
}

// todos os bancos de dados reais existentes (link curto /r/código procura em todos)
function allRealDbs() {
  return fs.readdirSync(DATA_DIR).filter(f => /^real(-[a-z0-9_-]+)?\.db$/.test(f))
    .map(f => (f === 'real.db' ? dataDb('real', null) : dataDb('real', f.slice(5, -3))));
}

function resetDemo(office) {
  const file = dbFile('demo', office);
  if (dbs[file]) { dbs[file].close(); delete dbs[file]; }
  for (const f of [file, file + '-wal', file + '-shm']) {
    try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (e) { /* ignore */ }
  }
  return dataDb('demo', office);
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { auth, dataDb, allRealDbs, resetDemo, tx, DATA_DIR };

'use strict';
// Banco de dados: SQLite embutido no Node (node:sqlite).
// auth.db  -> usuários, sessões e configurações gerais
// real.db  -> dados reais da Real 4U
// demo.db  -> dados fictícios do modo demonstração (separados dos reais)
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

const dbs = {};
function dataDb(mode) {
  const m = mode === 'demo' ? 'demo' : 'real';
  if (!dbs[m]) {
    const db = open(m + '.db');
    db.exec(DATA_SCHEMA);
    seedLists(db);
    dbs[m] = db;
    if (m === 'demo') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
      if (!n) require('./demo').seed(db);
    }
  }
  return dbs[m];
}

function resetDemo() {
  if (dbs.demo) { dbs.demo.close(); delete dbs.demo; }
  for (const f of ['demo.db', 'demo.db-wal', 'demo.db-shm']) {
    try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (e) { /* ignore */ }
  }
  return dataDb('demo');
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { auth, dataDb, resetDemo, tx, DATA_DIR };

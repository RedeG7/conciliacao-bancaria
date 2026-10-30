'use strict';
// Banco de dados: SQLite embutido no Node (node:sqlite), um arquivo só
// (DATA_DIR/inssobras.db). Os dados de negócio levam a coluna "office" (id do
// escritório no Hub) e toda consulta filtra por ela - um escritório nunca
// enxerga os dados de outro. Os parâmetros de cálculo (tabela params) são da
// plataforma, iguais para todos, e só o super administrador do Hub edita.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { TABELAS, VALIDAR } = require('./params');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'inssobras.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hub_user TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0, is_global INTEGER NOT NULL DEFAULT 0,
  office TEXT, office_name TEXT, offices TEXT, created_at TEXT NOT NULL, last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  office TEXT, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS offices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, public_token TEXT NOT NULL UNIQUE,
  display_name TEXT, whatsapp TEXT, email TEXT, logo_url TEXT, mensagem TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'PF',
  nome TEXT NOT NULL, fantasia TEXT, documento TEXT, email TEXT, telefone TEXT, origem TEXT, obs TEXT,
  ativo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS clients_office ON clients(office, ativo);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, nome TEXT NOT NULL, email TEXT, telefone TEXT,
  tipo TEXT, origem TEXT, url TEXT, simulation_id INTEGER, client_id INTEGER, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS leads_office ON leads(office, created_at);
CREATE TABLE IF NOT EXISTS simulations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER REFERENCES clients(id),
  kind TEXT NOT NULL, identifier TEXT, status TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL,
  base_simulation_id INTEGER, public_uuid TEXT NOT NULL UNIQUE, created_by TEXT, created_at TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS simulations_office ON simulations(office, kind, ativo);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, simulation_id INTEGER NOT NULL REFERENCES simulations(id),
  client_id INTEGER, honorarios REAL NOT NULL DEFAULT 0, entrada REAL NOT NULL DEFAULT 0, parcelas INTEGER NOT NULL DEFAULT 1,
  validade TEXT, condicoes TEXT, status TEXT NOT NULL DEFAULT 'Enviada', created_by TEXT, created_at TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS params (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tabela TEXT NOT NULL, uf TEXT NOT NULL DEFAULT '', chave TEXT NOT NULL,
  vigencia TEXT NOT NULL DEFAULT '', valor REAL NOT NULL, obs TEXT, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS params_chave ON params(tabela, uf, chave, vigencia);
`);

const nowIso = () => new Date().toISOString();

// valores iniciais das tabelas de parâmetros (só quando a tabela está vazia)
for (const [tabela, def] of Object.entries(TABELAS)) {
  if (!def.seed) continue;
  if (db.prepare('SELECT COUNT(*) AS n FROM params WHERE tabela = ?').get(tabela).n) continue;
  const ins = db.prepare('INSERT INTO params (tabela, uf, chave, valor, obs, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)');
  for (const row of def.seed) {
    const [uf, chave, valor] = row.length === 3 ? row : ['', row[0], row[1]];
    ins.run(tabela, uf, chave, valor, VALIDAR, nowIso(), 'sistema');
  }
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Leitor de parâmetros usado pelas calculadoras (src/calc.js)
function paramReader() {
  const rows = db.prepare('SELECT tabela, uf, chave, vigencia, valor FROM params').all();
  const by = {};
  for (const r of rows) (by[r.tabela] ||= []).push(r);
  return {
    list: tabela => (by[tabela] || []).map(r => ({ ...r })),
    // procura UF+chave exatas e depois os curingas "*" (e UF vazia)
    get(tabela, chave, uf = '') {
      const t = by[tabela] || [];
      for (const [u, c] of [[uf, chave], [uf, '*'], ['*', chave], ['*', '*'], ['', chave]]) {
        const r = t.find(x => x.uf === u && x.chave === c);
        if (r) return r.valor;
      }
      return null;
    },
    // VAU vigente na competência de referência (a mais recente <= ref; se não
    // houver, a mais antiga cadastrada)
    vau(uf, destinacao, ref) {
      const t = (by.vau || []).filter(x => x.uf === uf && x.chave === destinacao).sort((a, b) => (a.vigencia < b.vigencia ? 1 : -1));
      const r = t.find(x => !ref || x.vigencia <= ref) || t[t.length - 1];
      return r ? { valor: r.valor, vigencia: r.vigencia } : null;
    },
  };
}

function ensureOffice(id, name) {
  const o = db.prepare('SELECT * FROM offices WHERE id = ?').get(id);
  if (o) {
    if (name && o.name !== name) db.prepare('UPDATE offices SET name = ? WHERE id = ?').run(name, id);
    return db.prepare('SELECT * FROM offices WHERE id = ?').get(id);
  }
  db.prepare('INSERT INTO offices (id, name, public_token, display_name, created_at) VALUES (?,?,?,?,?)')
    .run(id, name || id, crypto.randomBytes(9).toString('base64url'), name || id, nowIso());
  return db.prepare('SELECT * FROM offices WHERE id = ?').get(id);
}

module.exports = { db, tx, nowIso, paramReader, ensureOffice, DATA_DIR };

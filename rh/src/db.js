'use strict';
// Banco de dados: SQLite embutido no Node (node:sqlite), um arquivo só
// (DATA_DIR/rh.db). Toda linha de negócio leva "office" (id do escritório no
// Hub) e toda consulta filtra por ela: um escritório nunca enxerga outro.
//
// Os cadastros descritos em src/modelos.js ficam todos em "registros", com os
// campos em JSON (dados). A coluna colaborador_id repete o campo de mesmo nome
// para a ficha do colaborador buscar o histórico dele.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'rh.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hub_user TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0, is_global INTEGER NOT NULL DEFAULT 0,
  office TEXT, office_name TEXT, offices TEXT, created_at TEXT NOT NULL, last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  office TEXT, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS offices (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
-- papel do usuário dentro do escritório (src/acesso.js)
CREATE TABLE IF NOT EXISTS papeis (
  office TEXT NOT NULL, hub_user TEXT NOT NULL, papel TEXT NOT NULL, PRIMARY KEY (office, hub_user));
CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, kind TEXT NOT NULL, colaborador_id INTEGER,
  dados TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1, criado_por TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT);
CREATE INDEX IF NOT EXISTS registros_office ON registros(office, kind, ativo);
CREATE INDEX IF NOT EXISTS registros_colab ON registros(office, colaborador_id, ativo);
-- respostas das pesquisas: anônimas, sem usuário nem IP
CREATE TABLE IF NOT EXISTS respostas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, pesquisa_id INTEGER NOT NULL,
  dados TEXT NOT NULL, criado_em TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS respostas_pesquisa ON respostas(office, pesquisa_id);
-- configurações de uma tela só: cultura organizacional, antecedência dos alertas
CREATE TABLE IF NOT EXISTS config (
  office TEXT NOT NULL, chave TEXT NOT NULL, valor TEXT NOT NULL, PRIMARY KEY (office, chave));
-- quem fez o quê: guarda os nomes dos campos alterados, nunca os valores
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, usuario TEXT NOT NULL, acao TEXT NOT NULL,
  kind TEXT, registro_id INTEGER, detalhe TEXT, em TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS auditoria_office ON auditoria(office, id);
`);

const nowIso = () => new Date().toISOString();
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function ensureOffice(id, name) {
  const o = db.prepare('SELECT * FROM offices WHERE id = ?').get(id);
  if (o) {
    if (name && o.name !== name) db.prepare('UPDATE offices SET name = ? WHERE id = ?').run(name, id);
    return;
  }
  db.prepare('INSERT INTO offices (id, name, created_at) VALUES (?,?,?)').run(id, name || id, nowIso());
}

// ---------------------------------------------------------------- registros
const linha = r => ({ ...JSON.parse(r.dados), id: r.id, ativo: r.ativo, criado_por: r.criado_por, criado_em: r.criado_em, atualizado_em: r.atualizado_em });
// os campos do registro, sem as colunas de controle
function soDados(r) {
  const { id, ativo, criado_por, criado_em, atualizado_em, ...d } = r; // eslint-disable-line no-unused-vars
  return d;
}

const listar = (office, kind, { inativos = false } = {}) =>
  db.prepare(`SELECT * FROM registros WHERE office = ? AND kind = ? ${inativos ? '' : 'AND ativo = 1'} ORDER BY id DESC`).all(office, kind).map(linha);
const doColaborador = (office, kind, colaboradorId) =>
  db.prepare('SELECT * FROM registros WHERE office = ? AND kind = ? AND colaborador_id = ? AND ativo = 1 ORDER BY id DESC').all(office, kind, colaboradorId).map(linha);
function obter(office, kind, id) {
  const r = db.prepare('SELECT * FROM registros WHERE office = ? AND kind = ? AND id = ? AND ativo = 1').get(office, kind, Number(id) || 0);
  return r ? linha(r) : null;
}
function criar(office, kind, dados, usuario) {
  const r = db.prepare('INSERT INTO registros (office, kind, colaborador_id, dados, criado_por, criado_em) VALUES (?,?,?,?,?,?)')
    .run(office, kind, dados.colaborador_id || null, JSON.stringify(dados), usuario, nowIso());
  return Number(r.lastInsertRowid);
}
function atualizar(office, kind, id, dados) {
  db.prepare('UPDATE registros SET dados = ?, colaborador_id = ?, atualizado_em = ? WHERE office = ? AND kind = ? AND id = ?')
    .run(JSON.stringify(dados), dados.colaborador_id || null, nowIso(), office, kind, id);
}
const apagar = (office, kind, id) =>
  db.prepare('UPDATE registros SET ativo = 0, atualizado_em = ? WHERE office = ? AND kind = ? AND id = ?').run(nowIso(), office, kind, id);

// ---------------------------------------------------------------- config e auditoria
function config(office, chave, padrao = {}) {
  const r = db.prepare('SELECT valor FROM config WHERE office = ? AND chave = ?').get(office, chave);
  return r ? { ...padrao, ...JSON.parse(r.valor) } : { ...padrao };
}
function salvarConfig(office, chave, valor) {
  db.prepare('INSERT INTO config (office, chave, valor) VALUES (?,?,?) ON CONFLICT(office, chave) DO UPDATE SET valor = excluded.valor')
    .run(office, chave, JSON.stringify(valor));
}
function auditar(office, usuario, acao, kind = null, registroId = null, detalhe = null) {
  db.prepare('INSERT INTO auditoria (office, usuario, acao, kind, registro_id, detalhe, em) VALUES (?,?,?,?,?,?,?)')
    .run(office, usuario, acao, kind, registroId, detalhe, nowIso());
}

const novoToken = () => crypto.randomBytes(12).toString('base64url');

module.exports = { db, tx, nowIso, ensureOffice, listar, doColaborador, obter, criar, atualizar, apagar, soDados, config, salvarConfig, auditar, novoToken };

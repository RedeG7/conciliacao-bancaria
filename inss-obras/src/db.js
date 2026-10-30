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
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  cno TEXT, endereco TEXT, municipio TEXT, uf TEXT, area REAL, data_inicio TEXT, data_fim TEXT,
  status TEXT NOT NULL DEFAULT 'Em andamento', obs TEXT, ativo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS works_office ON works(office, ativo);
-- certificado A1: arquivo e senha cifrados (src/certificados.js), nunca em claro
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER REFERENCES clients(id),
  titular TEXT, documento TEXT, emissor TEXT, validade TEXT NOT NULL, arquivo_nome TEXT,
  pfx_enc TEXT NOT NULL, senha_enc TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS certificates_office ON certificates(office, ativo);
-- envio DCTFWeb de uma competência da obra, com o passo a passo (guia de envio)
CREATE TABLE IF NOT EXISTS dctf_envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  work_id INTEGER REFERENCES works(id), certificate_id INTEGER REFERENCES certificates(id), competencia TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Em andamento', esocial_status TEXT NOT NULL DEFAULT 'Não iniciado', passos_json TEXT NOT NULL DEFAULT '[]',
  pausado_em TEXT, pausado_por TEXT, ultimo_envio TEXT, valor_darf REAL, vencimento TEXT, recibo TEXT, obs TEXT,
  created_by TEXT, created_at TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS dctf_envios_office ON dctf_envios(office, ativo, competencia);
CREATE TABLE IF NOT EXISTS params (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tabela TEXT NOT NULL, uf TEXT NOT NULL DEFAULT '', chave TEXT NOT NULL,
  vigencia TEXT NOT NULL DEFAULT '', valor REAL NOT NULL, obs TEXT, updated_at TEXT NOT NULL, updated_by TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS params_chave ON params(tabela, uf, chave, vigencia);
`);

// colunas novas em tabelas que já existem em produção (ALTER só se faltar)
function addColumns(tabela, defs) {
  const tem = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name));
  for (const d of defs) if (!tem.has(d.split(' ')[0])) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${d}`);
}

// Módulo DCTF Web (SPEC_MODULO_DCTFWEB): cliente como empregador eSocial
// (S-1000) com procuração eletrônica para o procurador do escritório, cujo
// certificado A1 (tabela certificates) transmite em nome do cliente.
addColumns('clients', ['profissao TEXT', 'nacionalidade TEXT', 'registro TEXT', 'contato TEXT', 'telefone_fixo TEXT',
  'cep TEXT', 'rua TEXT', 'numero TEXT', 'bairro TEXT', 'cidade TEXT', 'uf TEXT', 'complemento TEXT',
  'possui_procuracao INTEGER NOT NULL DEFAULT 0', 'procuracao_data_assinatura TEXT', 'procuracao_data_fim TEXT',
  'certificate_id INTEGER', 's1000_inicio TEXT', 's1000_fim TEXT', "class_trib TEXT DEFAULT '21'",
  "ind_opt_reg_eletron TEXT DEFAULT '0'", "ind_desoneracao TEXT DEFAULT '0'", 'pis_pasep INTEGER NOT NULL DEFAULT 0', 's1000_recibo TEXT']);
// obra (S-1005)
addColumns('works', ['calculator_id INTEGER', 'custom_name TEXT', "registration_type TEXT DEFAULT 'CNO'", 'real_estate_registration TEXT',
  "cnae TEXT DEFAULT '4120400'", 'has_construction_permit INTEGER NOT NULL DEFAULT 0', 'date_construction_permit TEXT',
  'has_habitese INTEGER NOT NULL DEFAULT 0', 'date_habitese TEXT', 'cep TEXT', 'numero TEXT', 'bairro TEXT', 'complemento TEXT',
  "stoppages_json TEXT NOT NULL DEFAULT '[]'"]);
db.exec(`
-- autônomos (S-2300, TSVE sem vínculo) - vinculados ao cliente dono da obra
CREATE TABLE IF NOT EXISTS masons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL, document TEXT, birthday TEXT, phone TEXT, email TEXT,
  sex TEXT, skin TEXT, marital TEXT, scholarity TEXT, birth_country TEXT DEFAULT '105', country_nationality TEXT DEFAULT '105',
  category TEXT DEFAULT '701', cbo TEXT DEFAULT '710205', residence_time TEXT, entry_condition TEXT,
  address_zip_code TEXT, address TEXT, address_number TEXT, address_complement TEXT, address_district TEXT, address_city TEXT, address_municipality TEXT,
  ativo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS masons_office ON masons(office, client_id, ativo);
-- trabalhadores da obra, com o período de cada um
CREATE TABLE IF NOT EXISTS work_masons (
  work_id INTEGER NOT NULL REFERENCES works(id), mason_id INTEGER NOT NULL REFERENCES masons(id),
  start_date TEXT, end_date TEXT, PRIMARY KEY (work_id, mason_id));
-- envio DCTFWeb de uma obra (todas as competências ficam em payroll_months)
CREATE TABLE IF NOT EXISTS dctf_webs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  work_id INTEGER REFERENCES works(id), esocial_id INTEGER REFERENCES simulations(id),
  construction_init_date TEXT, construction_end_date TEXT, status TEXT NOT NULL DEFAULT 'em_andamento',
  send1005 INTEGER NOT NULL DEFAULT 1, send1010 TEXT NOT NULL DEFAULT 'inclusao', send1020 TEXT NOT NULL DEFAULT 'inclusao',
  rubric_code TEXT, rubric_description TEXT, rubric_validity TEXT, irrf TEXT DEFAULT '11',
  tax_allocation_code TEXT, tax_allocation_validity TEXT,
  has_s1005 INTEGER NOT NULL DEFAULT 0, has_s1010 INTEGER NOT NULL DEFAULT 0, has_s1020 INTEGER NOT NULL DEFAULT 0, has_s2300 INTEGER NOT NULL DEFAULT 0,
  fechamento_json TEXT NOT NULL DEFAULT '{}', cancel_reason TEXT, canceled_at TEXT, last_sent_at TEXT, last_competencia TEXT,
  created_by TEXT, created_at TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS dctf_webs_office ON dctf_webs(office, ativo);
CREATE TABLE IF NOT EXISTS payroll_months (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dctf_web_id INTEGER NOT NULL REFERENCES dctf_webs(id), competencia TEXT NOT NULL,
  is_paralyzed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'rascunho', nr_rec_1299 TEXT,
  UNIQUE (dctf_web_id, competencia));
CREATE TABLE IF NOT EXISTS payroll_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payroll_month_id INTEGER NOT NULL REFERENCES payroll_months(id) ON DELETE CASCADE,
  mason_id INTEGER REFERENCES masons(id), id_dm_dev TEXT, calc_base REAL NOT NULL DEFAULT 0, payment_date TEXT,
  nr_rec_1200 TEXT, nr_rec_1210 TEXT);
-- XML enviado / retorno de cada evento (preenchido quando a transmissão ao eSocial existir)
CREATE TABLE IF NOT EXISTS esocial_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER, dctf_web_id INTEGER, event TEXT NOT NULL,
  payload_xml TEXT, response_xml TEXT, receipt TEXT, status TEXT, created_at TEXT NOT NULL);
-- acompanhamento do guia de envio por cliente (o progresso é calculado pelos dados)
CREATE TABLE IF NOT EXISTS send_guides (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office TEXT NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL, paused_at TEXT, completed_at TEXT, user TEXT,
  ativo INTEGER NOT NULL DEFAULT 1, UNIQUE (office, client_id));
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

'use strict';
// Esquema e listas iniciais (compartilhado entre servidor Node e versão hospedada).
const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','marketing','comercial')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'real',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

const DATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, sort INTEGER DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS stages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost')), milestone TEXT, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS loss_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT DEFAULT 'outro', sort INTEGER DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ctas (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS qual_criteria (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, help TEXT, required INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, objective TEXT, channel TEXT, service_id INTEGER,
  start_date TEXT, end_date TEXT, status TEXT NOT NULL DEFAULT 'planejada', budget_planned REAL, audience TEXT, notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, theme TEXT, url TEXT, channel TEXT, format TEXT, published_at TEXT,
  service_id INTEGER, hook TEXT, cta TEXT, campaign_id INTEGER, is_ad INTEGER NOT NULL DEFAULT 0,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT, short_code TEXT UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ukey TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
  campaign_id INTEGER, content_id INTEGER, source_id INTEGER,
  spend REAL, impressions INTEGER, reach INTEGER, clicks INTEGER, conversations INTEGER,
  origin TEXT NOT NULL DEFAULT 'manual', updated_by INTEGER, updated_at TEXT);

CREATE TABLE IF NOT EXISTS other_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('marketing','vendas')),
  description TEXT, amount REAL NOT NULL, campaign_id INTEGER, created_by INTEGER, created_at TEXT);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, phone_norm TEXT, email TEXT, email_norm TEXT,
  company TEXT, city TEXT, kind TEXT NOT NULL DEFAULT 'cliente_potencial', profile TEXT, profile_other TEXT,
  decision_maker TEXT NOT NULL DEFAULT 'desconhecido', notes TEXT, captured_at TEXT, owner_id INTEGER,
  archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_contacts_phone ON contacts(phone_norm);
CREATE INDEX IF NOT EXISTS ix_contacts_email ON contacts(email_norm);

CREATE TABLE IF NOT EXISTS touchpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL REFERENCES contacts(id), occurred_at TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'outro', source_id INTEGER, campaign_id INTEGER, content_id INTEGER,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT, note TEXT,
  created_by INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_touch_contact ON touchpoints(contact_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL REFERENCES contacts(id), title TEXT,
  service_id INTEGER, stage_id INTEGER NOT NULL, owner_id INTEGER, status TEXT NOT NULL DEFAULT 'open',
  estimated_value REAL, need TEXT, difficulty TEXT, urgency TEXT DEFAULT 'desconhecida', deadline TEXT, budget_range TEXT,
  source_id INTEGER, campaign_id INTEGER, content_id INTEGER,
  next_action TEXT, next_action_date TEXT, stage_entered_at TEXT,
  qual_answers TEXT, qual_status TEXT DEFAULT 'em_analise', qual_manual INTEGER DEFAULT 0, qual_note TEXT, qualified_at TEXT,
  first_contact_at TEXT, meeting_scheduled_at TEXT, meeting_done_at TEXT, proposal_sent_at TEXT,
  won_at TEXT, contract_type TEXT, one_time_value REAL, monthly_value REAL, contract_months INTEGER, win_factors TEXT,
  lost_at TEXT, loss_reason_id INTEGER, loss_detail TEXT, retake_date TEXT,
  objection TEXT, feedback TEXT,
  archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_opp_contact ON opportunities(contact_id);

CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, opp_id INTEGER NOT NULL, from_stage_id INTEGER, to_stage_id INTEGER NOT NULL,
  user_id INTEGER, at TEXT NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS ix_hist_opp ON stage_history(opp_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, opp_id INTEGER, contact_id INTEGER, title TEXT NOT NULL, due_date TEXT,
  owner_id INTEGER, done_at TEXT, created_by INTEGER, created_at TEXT);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER, opp_id INTEGER, user_id INTEGER, body TEXT NOT NULL, created_at TEXT);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, opp_id INTEGER NOT NULL, sent_at TEXT NOT NULL, one_time_value REAL, monthly_value REAL,
  status TEXT NOT NULL DEFAULT 'enviada', followup_date TEXT, note TEXT, created_by INTEGER, created_at TEXT);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, opp_id INTEGER NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL, note TEXT,
  created_by INTEGER, created_at TEXT);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, period_start TEXT NOT NULL, period_end TEXT NOT NULL, service_id INTEGER,
  metric TEXT NOT NULL, target REAL NOT NULL, created_by INTEGER, created_at TEXT);

CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, view TEXT NOT NULL, name TEXT NOT NULL, params TEXT NOT NULL, created_at TEXT);

CREATE TABLE IF NOT EXISTS link_clicks (id INTEGER PRIMARY KEY AUTOINCREMENT, content_id INTEGER NOT NULL, at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, entity TEXT, entity_id INTEGER,
  details TEXT, at TEXT NOT NULL);
`;

// Listas iniciais (editáveis em Configurações). Não há metas nem resultados pré-cadastrados.
const SEED_LISTS = {
  services: [
    'Regularização de obras e INSS da obra',
    'Contabilidade para construtoras e incorporadoras',
    'RET — Regime Especial de Tributação',
    'Planejamento Tributário Societário — PTS',
    'Holdings e organização patrimonial',
    'Apoio à Produção e GERIC/Caixa',
    'Abertura e alterações de empresas',
    'Curso Prático de INSS da Obra e treinamentos',
  ],
  stages: [
    ['Novo lead', 'open', 'lead'],
    ['Primeiro contato', 'open', 'first_contact'],
    ['Em qualificação', 'open', null],
    ['Reunião agendada', 'open', 'meeting_scheduled'],
    ['Reunião realizada', 'open', 'meeting_done'],
    ['Proposta enviada', 'open', 'proposal'],
    ['Em negociação', 'open', null],
    ['Fechado — ganho', 'won', 'won'],
    ['Fechado — perdido', 'lost', 'lost'],
  ],
  loss_reasons: [
    'Preço', 'Sem orçamento no momento', 'Sem urgência', 'Não compreendeu o valor do serviço', 'Escolheu concorrente',
    'Não respondeu após tentativas', 'Serviço incompatível', 'Projeto adiado', 'Outro',
  ],
  sources: [
    ['Instagram (orgânico)', 'organico'], ['Meta Ads (Instagram/Facebook pago)', 'pago'], ['Google Ads', 'pago'],
    ['Google (busca orgânica)', 'organico'], ['YouTube', 'organico'], ['Site / formulário', 'organico'],
    ['WhatsApp direto', 'direto'], ['E-mail', 'organico'], ['Indicação de cliente', 'indicacao'],
    ['Indicação de parceiro', 'indicacao'], ['Evento', 'evento'], ['Contato direto / telefone', 'direto'], ['Outro', 'outro'],
  ],
  ctas: ['Agende uma reunião', 'Solicite uma simulação', 'Clique no link da bio', 'Envie a palavra OBRA', 'Fale com nossa equipe'],
  qual_criteria: [
    ['Perfil compatível', 'Construtor, incorporador, proprietário de obra, engenheiro, arquiteto, investidor ou parceiro do setor.', 1],
    ['Serviço procurado é oferecido', 'Ex.: INSS da obra (sim) x aposentadoria/benefício previdenciário (não).', 1],
    ['Necessidade real identificada', 'Existe um problema ou objetivo concreto a resolver.', 1],
    ['Urgência ou prazo definido', 'Há prazo, obra em andamento ou exigência a cumprir.', 0],
    ['Orçamento informado compatível', 'Faixa de investimento compatível com o serviço.', 0],
    ['Participa da decisão', 'Decide ou influencia diretamente a contratação.', 0],
  ],
};

function seedLists(db) {
  const has = db.prepare('SELECT COUNT(*) AS n FROM stages').get().n;
  if (has) return;
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  SEED_LISTS.services.forEach((n, i) => ins('INSERT INTO services (name, sort) VALUES (?,?)', n, i));
  SEED_LISTS.stages.forEach(([n, k, m], i) => ins('INSERT INTO stages (name, kind, milestone, sort) VALUES (?,?,?,?)', n, k, m, i));
  SEED_LISTS.loss_reasons.forEach((n, i) => ins('INSERT INTO loss_reasons (name, sort) VALUES (?,?)', n, i));
  SEED_LISTS.sources.forEach(([n, k], i) => ins('INSERT INTO sources (name, kind, sort) VALUES (?,?,?)', n, k, i));
  SEED_LISTS.ctas.forEach((n, i) => ins('INSERT INTO ctas (name, sort) VALUES (?,?)', n, i));
  SEED_LISTS.qual_criteria.forEach(([n, h, r], i) => ins('INSERT INTO qual_criteria (name, help, required, sort) VALUES (?,?,?,?)', n, h, r, i));
}

module.exports = { AUTH_SCHEMA, DATA_SCHEMA, SEED_LISTS, seedLists };

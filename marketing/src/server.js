'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { auth, dataDb, allRealDbs, resetDemo, tx } = require('./db');
const L = require('./logic');
const A = require('./analytics');
const integrations = require('./integrations');
const sso = require('./sso');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '15mb' }));

// ---------- cabeçalhos de segurança ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  next();
});

// ---------- utilidades ----------
const COOKIE = 'r4u_sid';
const SESSION_DAYS = 7;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPass(p) { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(p, salt, 64).toString('hex')}`; }
function checkPass(p, h) {
  const [, salt, hash] = String(h).split('$'); if (!salt) return false;
  const a = crypto.scryptSync(p, salt, 64); const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return o; }
function setCookie(res, val, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
}
const h = fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.then) r.catch(next); } catch (e) { next(e); } };
const err = L.httpErr;
// logo é por escritório (usuários sem escritório usam a chave antiga 'logo')
const logoKey = office => (office ? 'logo:' + office : 'logo');
const userName = id => { const u = id && auth.prepare('SELECT name FROM users WHERE id = ?').get(id); return u ? u.name : null; };
function audit(req, action, entity, id, details) {
  try {
    req.db.prepare('INSERT INTO audit (user_id, user_name, action, entity, entity_id, details, at) VALUES (?,?,?,?,?,?,?)')
      .run(req.user ? req.user.id : null, req.user ? req.user.name : 'sistema', action, entity || null, id || null, details ? JSON.stringify(details) : null, L.nowIso());
  } catch (e) { /* auditoria não deve derrubar a operação */ }
}
const ROLES = { admin: 'Administrador', marketing: 'Marketing', comercial: 'Comercial' };
function need(...roles) { return (req, res, next) => (roles.includes(req.user.role) ? next() : next(err(403, 'Seu perfil não tem permissão para esta ação.'))); }
const clean = v => (v === undefined || v === '' ? null : typeof v === 'string' ? v.trim() : v);
const idOrNull = v => (v === undefined || v === null || v === '' || Number(v) === 0 ? null : Number(v));
function pick(body, fields) { const o = {}; for (const f of fields) if (body[f] !== undefined) o[f] = clean(body[f]); return o; }
function insert(db, table, obj) {
  const k = Object.keys(obj);
  return Number(db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => obj[x])).lastInsertRowid);
}
function update(db, table, id, obj) {
  const k = Object.keys(obj); if (!k.length) return;
  db.prepare(`UPDATE ${table} SET ${k.map(x => x + ' = ?').join(', ')} WHERE id = ?`).run(...k.map(x => obj[x]), id);
}
function get(db, table, id) { const r = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id)); if (!r) throw err(404, 'Registro não encontrado.'); return r; }

// ---------- rate limit simples para login ----------
const attempts = new Map();
function loginLimited(key) {
  const now = Date.now(); const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60000);
  attempts.set(key, a); return a.length >= 8;
}

// ---------- rotas públicas ----------
app.get('/api/setup-status', h((req, res) => res.json({ needsSetup: auth.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 })));
app.post('/api/setup', h((req, res) => {
  if (auth.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) throw err(400, 'O sistema já foi configurado.');
  const { name, email, password } = req.body || {};
  if (!name || !L.normEmail(email) || !password || password.length < 8) throw err(400, 'Informe nome, e-mail válido e senha com ao menos 8 caracteres.');
  auth.prepare('INSERT INTO users (name, email, pass_hash, role, created_at) VALUES (?,?,?,?,?)').run(name.trim(), L.normEmail(email), hashPass(password), 'admin', L.nowIso());
  res.json({ ok: true });
}));
app.post('/api/login', h((req, res) => {
  const email = L.normEmail((req.body || {}).email); const key = (req.ip || '') + '|' + email;
  if (loginLimited(key)) throw err(429, 'Muitas tentativas. Aguarde 15 minutos.');
  const u = email && auth.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !u.active || !checkPass(req.body.password || '', u.pass_hash)) { attempts.get(key).push(Date.now()); throw err(401, 'E-mail ou senha incorretos.'); }
  attempts.delete(key);
  startSession(req, res, u, 'login');
  res.json({ ok: true });
}));
function startSession(req, res, u, action) {
  const token = crypto.randomBytes(32).toString('hex');
  auth.prepare('INSERT INTO sessions (token_hash, user_id, mode, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run(sha(token), u.id, 'real', new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), L.nowIso());
  auth.prepare('DELETE FROM sessions WHERE expires_at < ?').run(L.nowIso());
  setCookie(res, token, SESSION_DAYS * 86400);
  req.user = u; req.db = dataDb('real', u.office); audit(req, action, 'usuário', u.id);
}
// Login único vindo do Hub (ver src/sso.js): usuário do Hub entra direto, sem senha.
// No primeiro acesso cria o usuário aqui (admin do Hub vira Administrador, os demais
// Comercial - o perfil pode ser trocado depois em Configurações › Usuários).
function ssoErro(res, status, msg) {
  const hub = process.env.HUB_URL || '/';
  res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><title>Real 4U</title><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${msg}</p><p><a href="${hub}">Voltar ao Hub</a></p></body>`);
}
app.get('/sso', h((req, res) => {
  const p = sso.verificar(req.query.t, process.env.SSO_SECRET);
  if (!p) return ssoErro(res, 401, 'O link de acesso expirou ou é inválido. Abra o Marketing de novo pelo Hub.');
  // escritório do Hub: cada escritório só enxerga os próprios dados (um arquivo de banco por escritório)
  const office = typeof p.office === 'string' && p.office ? p.office : null;
  if (!office) return ssoErro(res, 403, 'Seu usuário do Hub não tem escritório definido. Fale com o administrador.');
  let u = auth.prepare('SELECT * FROM users WHERE hub_user = ?').get(p.sub);
  if (!u) {
    const nome = String(p.name || p.sub).slice(0, 120);
    const id = auth.prepare('INSERT INTO users (name, email, pass_hash, role, created_at, hub_user, office) VALUES (?,?,?,?,?,?,?)')
      .run(nome, 'hub:' + p.sub, hashPass(crypto.randomBytes(32).toString('hex')), p.admin ? 'admin' : 'comercial', L.nowIso(), p.sub, office).lastInsertRowid;
    u = auth.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  } else if (u.office !== office) {
    // usuário mudou de escritório no Hub (ou foi criado antes desta separação): segue o Hub
    auth.prepare('UPDATE users SET office = ? WHERE id = ?').run(office, u.id);
    auth.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    u = auth.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  }
  if (!u.active) return ssoErro(res, 403, 'Seu usuário está inativo no Marketing. Fale com o administrador.');
  startSession(req, res, u, 'login pelo Hub');
  res.redirect(302, '/');
}));
function sessionUser(req) {
  const t = cookies(req)[COOKIE];
  const s = t && auth.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha(t));
  if (!s || s.expires_at < L.nowIso()) return null;
  return auth.prepare('SELECT id, office FROM users WHERE id = ?').get(s.user_id) || null;
}
app.get('/api/logo', h((req, res) => {
  const su = sessionUser(req);
  const r = auth.prepare('SELECT value FROM settings WHERE key = ?').get(logoKey(su ? su.office : null));
  if (!r) return res.status(404).end();
  const m = r.value.match(/^data:(image\/(png|jpeg|svg\+xml|webp));base64,(.+)$/);
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m[1]); res.setHeader('Cache-Control', 'no-cache');
  if (m[1] === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.end(Buffer.from(m[3], 'base64'));
}));
// Link rastreável próprio: registra um clique ANÔNIMO (sem IP, sem identificação) e redireciona.
app.get('/r/:code', h((req, res) => {
  // procura o código em todos os escritórios (códigos são aleatórios)
  let db = null; let c = null;
  for (const d of allRealDbs()) { c = d.prepare('SELECT * FROM contents WHERE short_code = ?').get(req.params.code); if (c) { db = d; break; } }
  if (!c || !c.url) return res.status(404).send('Link não encontrado.');
  db.prepare('INSERT INTO link_clicks (content_id, at) VALUES (?,?)').run(c.id, L.nowIso());
  res.redirect(302, integrations.trackedUrl(c));
}));
// Recebimento de formulários (site, landing page). Exige token configurado no servidor.
// ?escritorio=<id do escritório no Hub> escolhe em qual escritório o lead entra
// (padrão: FORM_DEFAULT_OFFICE).
app.post('/api/webhooks/form', h((req, res) => integrations.receiveForm(req, res,
  dataDb('real', String(req.query.escritorio || process.env.FORM_DEFAULT_OFFICE || '') || null))));

// ---------- autenticação ----------
app.use('/api', (req, res, next) => {
  const t = cookies(req)[COOKIE];
  const s = t && auth.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha(t));
  if (!s || s.expires_at < L.nowIso()) return next(err(401, 'Sessão expirada. Entre novamente.'));
  const u = auth.prepare('SELECT id, name, email, role, active, must_change, office FROM users WHERE id = ?').get(s.user_id);
  if (!u || !u.active) return next(err(401, 'Usuário inativo.'));
  req.user = u; req.office = u.office || null; req.mode = s.mode; req.sessionHash = s.token_hash; req.db = dataDb(s.mode, req.office);
  // proteção CSRF: toda alteração precisa do cabeçalho enviado pela aplicação
  if (req.method !== 'GET' && req.get('X-R4U') !== '1') return next(err(403, 'Requisição bloqueada.'));
  next();
});

app.post('/api/logout', h((req, res) => { auth.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash); setCookie(res, '', 0); res.json({ ok: true }); }));
app.get('/api/me', h((req, res) => res.json({ user: req.user, mode: req.mode, roleLabel: ROLES[req.user.role] })));
app.post('/api/me/password', h((req, res) => {
  const { current, password } = req.body || {};
  const u = auth.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!checkPass(current || '', u.pass_hash)) throw err(400, 'Senha atual incorreta.');
  if (!password || password.length < 8) throw err(400, 'A nova senha precisa ter ao menos 8 caracteres.');
  auth.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(hashPass(password), u.id);
  audit(req, 'alterou a própria senha', 'usuário', u.id); res.json({ ok: true });
}));
app.post('/api/mode', h((req, res) => {
  const mode = req.body.mode === 'demo' ? 'demo' : 'real';
  auth.prepare('UPDATE sessions SET mode = ? WHERE token_hash = ?').run(mode, req.sessionHash);
  dataDb(mode, req.office); res.json({ ok: true, mode });
}));
app.post('/api/demo/reset', need('admin'), h((req, res) => {
  if (req.mode !== 'demo') throw err(400, 'Entre no modo demonstração para recriar os dados fictícios.');
  resetDemo(req.office); res.json({ ok: true });
}));

// ---------- usuários ----------
app.get('/api/users', h((req, res) => {
  const all = auth.prepare('SELECT id, name, email, role, active, created_at FROM users WHERE office IS ? ORDER BY name').all(req.office);
  res.json(req.user.role === 'admin' ? all : all.map(u => ({ id: u.id, name: u.name, role: u.role, active: u.active })));
}));
app.post('/api/users', need('admin'), h((req, res) => {
  const { name, email, role, password } = req.body;
  if (!name || !L.normEmail(email) || !ROLES[role] || !password || password.length < 8) throw err(400, 'Preencha nome, e-mail, perfil e uma senha provisória (mín. 8 caracteres).');
  if (auth.prepare('SELECT id FROM users WHERE email = ?').get(L.normEmail(email))) throw err(409, 'Já existe usuário com este e-mail.');
  const id = auth.prepare('INSERT INTO users (name, email, pass_hash, role, must_change, created_at, office) VALUES (?,?,?,?,1,?,?)').run(name.trim(), L.normEmail(email), hashPass(password), role, L.nowIso(), req.office).lastInsertRowid;
  audit(req, 'criou usuário', 'usuário', Number(id), { name, role }); res.json({ id: Number(id) });
}));
app.put('/api/users/:id', need('admin'), h((req, res) => {
  const id = Number(req.params.id); const u = auth.prepare('SELECT * FROM users WHERE id = ? AND office IS ?').get(id, req.office); if (!u) throw err(404, 'Usuário não encontrado.');
  const { name, role, active, password } = req.body;
  if (id === req.user.id && (active === 0 || active === false || (role && role !== 'admin'))) throw err(400, 'Você não pode desativar ou rebaixar o próprio acesso.');
  if (name) auth.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), id);
  if (role && ROLES[role]) auth.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (active !== undefined) { auth.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id); if (!active) auth.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); }
  if (password) { if (password.length < 8) throw err(400, 'Senha com ao menos 8 caracteres.'); auth.prepare('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?').run(hashPass(password), id); }
  audit(req, 'alterou usuário', 'usuário', id, { name, role, active, senha: password ? 'redefinida' : undefined }); res.json({ ok: true });
}));

// ---------- listas editáveis ----------
const LISTS = {
  services: ['name', 'description', 'sort', 'archived'], stages: ['name', 'sort', 'archived', 'milestone'],
  loss_reasons: ['name', 'sort', 'archived'], sources: ['name', 'kind', 'sort', 'archived'], ctas: ['name', 'sort', 'archived'],
  qual_criteria: ['name', 'help', 'required', 'sort', 'archived'],
};
app.get('/api/bootstrap', h((req, res) => {
  const db = req.db; const o = {};
  for (const t of Object.keys(LISTS)) o[t] = db.prepare(`SELECT * FROM ${t} ORDER BY sort, id`).all();
  o.campaigns = db.prepare('SELECT id, name, status, service_id, channel, archived FROM campaigns ORDER BY start_date DESC, id DESC').all();
  o.contents = db.prepare('SELECT id, title, campaign_id, hook, cta, channel, format, service_id, archived FROM contents ORDER BY published_at DESC, id DESC').all();
  o.users = auth.prepare('SELECT id, name, role, active FROM users WHERE office IS ? ORDER BY name').all(req.office);
  o.hooks = db.prepare("SELECT DISTINCT hook FROM contents WHERE hook IS NOT NULL AND hook <> '' ORDER BY hook").all().map(r => r.hook);
  o.goalMetrics = A.GOAL_METRICS;
  o.hasLogo = !!auth.prepare('SELECT 1 FROM settings WHERE key = ?').get(logoKey(req.office));
  o.today = L.today();
  res.json(o);
}));
app.post('/api/lists/:list', need('admin'), h((req, res) => {
  const t = req.params.list; if (!LISTS[t]) throw err(404, 'Lista inválida.');
  const o = pick(req.body, LISTS[t]); if (!o.name) throw err(400, 'Informe o nome.');
  if (t === 'stages') {
    // novas etapas são sempre abertas e entram antes das etapas de fechamento
    o.kind = 'open'; const won = req.db.prepare("SELECT MIN(sort) AS s FROM stages WHERE kind <> 'open'").get().s;
    if (o.sort === undefined || o.sort === null) { req.db.prepare("UPDATE stages SET sort = sort + 1 WHERE kind <> 'open'").run(); o.sort = won; }
  } else if (o.sort === undefined) o.sort = (req.db.prepare(`SELECT MAX(sort) AS s FROM ${t}`).get().s || 0) + 1;
  const id = insert(req.db, t, o); audit(req, 'criou item', t, id, o); res.json({ id });
}));
app.put('/api/lists/:list/:id', need('admin'), h((req, res) => {
  const t = req.params.list; if (!LISTS[t]) throw err(404, 'Lista inválida.');
  const cur = get(req.db, t, req.params.id); const o = pick(req.body, LISTS[t]);
  if (t === 'stages' && cur.kind !== 'open') { delete o.sort; if (o.archived) throw err(400, 'As etapas de fechamento (ganho/perdido) não podem ser arquivadas.'); }
  if (t === 'stages' && o.archived) {
    const n = req.db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE stage_id = ? AND status = 'open' AND archived = 0").get(cur.id).n;
    if (n) throw err(400, `Mova as ${n} oportunidade(s) desta etapa antes de arquivá-la.`);
  }
  update(req.db, t, cur.id, o); audit(req, 'alterou item', t, cur.id, o); res.json({ ok: true });
}));
app.post('/api/lists/stages/reorder', need('admin'), h((req, res) => {
  const ids = (req.body.ids || []).map(Number);
  tx(req.db, () => ids.forEach((id, i) => req.db.prepare("UPDATE stages SET sort = ? WHERE id = ? AND kind = 'open'").run(i, id)));
  const n = ids.length; req.db.prepare("UPDATE stages SET sort = ? WHERE kind = 'won'").run(n); req.db.prepare("UPDATE stages SET sort = ? WHERE kind = 'lost'").run(n + 1);
  audit(req, 'reordenou etapas', 'stages'); res.json({ ok: true });
}));

// ---------- logo ----------
app.post('/api/logo', need('admin'), h((req, res) => {
  const v = String(req.body.dataUrl || '');
  if (!/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(v) || v.length > 4e6) throw err(400, 'Envie PNG, JPG, SVG ou WEBP com até 3 MB.');
  auth.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(logoKey(req.office), v);
  audit(req, 'atualizou a logo', 'configurações'); res.json({ ok: true });
}));
app.delete('/api/logo', need('admin'), h((req, res) => { auth.prepare('DELETE FROM settings WHERE key = ?').run(logoKey(req.office)); res.json({ ok: true }); }));

// ---------- contatos ----------
const CONTACT_FIELDS = ['name', 'phone', 'email', 'company', 'city', 'kind', 'profile', 'profile_other', 'decision_maker', 'notes', 'captured_at', 'owner_id'];
const KINDS = ['cliente_potencial', 'parceiro', 'interessado_curso'];
function contactPayload(body) {
  const o = pick(body, CONTACT_FIELDS);
  if (o.kind && !KINDS.includes(o.kind)) o.kind = 'cliente_potencial';
  if (o.phone !== undefined) o.phone_norm = L.normPhone(o.phone) || null;
  if (o.email !== undefined) { o.email_norm = L.normEmail(o.email) || null; if (o.email && !o.email_norm) throw err(400, 'E-mail inválido.'); }
  if (o.captured_at !== undefined) o.captured_at = L.parseDateBR(o.captured_at) || L.today();
  if (o.owner_id !== undefined) o.owner_id = idOrNull(o.owner_id);
  return o;
}
function findDuplicates(db, phoneNorm, emailNorm, exceptId) {
  if (!phoneNorm && !emailNorm) return [];
  return db.prepare(`SELECT id, name, phone, email, company, archived FROM contacts WHERE id <> ? AND ((phone_norm IS NOT NULL AND phone_norm = ?) OR (email_norm IS NOT NULL AND email_norm = ?))`)
    .all(exceptId || 0, phoneNorm || '#', emailNorm || '#');
}
const TOUCH_FIELDS = ['occurred_at', 'type', 'source_id', 'campaign_id', 'content_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'note'];
function touchPayload(b) {
  const t = pick(b || {}, TOUCH_FIELDS);
  t.occurred_at = L.parseDateBR(t.occurred_at) || L.today();
  for (const k of ['source_id', 'campaign_id', 'content_id']) t[k] = idOrNull(t[k]);
  t.type = t.type || 'outro';
  return t;
}
function hasTouchData(t) { return t && (t.source_id || t.campaign_id || t.content_id || t.utm_source || t.utm_campaign); }

app.get('/api/contacts', h((req, res) => {
  const d = A.load(req.db); const q = (req.query.q || '').toLowerCase().trim(); const digits = q.replace(/\D/g, '');
  const archived = req.query.archived === '1' ? 1 : 0;
  const rows = d.contacts.filter(c => c.archived === archived).filter(c => {
    if (req.query.kind && c.kind !== req.query.kind) return false;
    if (req.query.profile && c.profile !== req.query.profile) return false;
    if (req.query.owner_id && String(c.owner_id || 0) !== String(req.query.owner_id)) return false;
    const a = A.contactAttr(c, d);
    if (req.query.source_id && String(a.source_id) !== String(req.query.source_id)) return false;
    if (req.query.campaign_id && String(a.campaign_id) !== String(req.query.campaign_id)) return false;
    if (q && !((c.name || '').toLowerCase().includes(q) || (c.company || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (digits.length >= 4 && (c.phone_norm || '').includes(digits)) || (c.city || '').toLowerCase().includes(q))) return false;
    return true;
  }).map(c => {
    const a = A.contactAttr(c, d); const os = d.oppsByContact.get(c.id) || [];
    return Object.assign({}, c, { source: a.source_id ? d.srcById.get(a.source_id).name : 'Não identificado', campaign: a.campaign_id ? (d.campById.get(a.campaign_id) || {}).name : null,
      content: a.content_id ? (d.contById.get(a.content_id) || {}).title : null, opps: os.length, open_opps: os.filter(o => o.status === 'open').length, won_opps: os.filter(o => o.status === 'won').length,
      qual: os.some(o => o.qual_status === 'qualificado') ? 'qualificado' : os.some(o => o.qual_status === 'nao_qualificado') ? 'nao_qualificado' : os.length ? 'em_analise' : null });
  }).sort((a, b) => (b.captured_at || '').localeCompare(a.captured_at || '') || b.id - a.id);
  res.json(rows);
}));

function contactDetail(db, id) {
  const c = get(db, 'contacts', id);
  const touch = db.prepare(`SELECT t.*, s.name AS source, cp.name AS campaign, ct.title AS content, ct.hook, ct.cta FROM touchpoints t LEFT JOIN sources s ON s.id = t.source_id
    LEFT JOIN campaigns cp ON cp.id = t.campaign_id LEFT JOIN contents ct ON ct.id = t.content_id WHERE t.contact_id = ? ORDER BY t.occurred_at, t.id`).all(c.id);
  const opps = db.prepare('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY created_at DESC').all(c.id).map(o => oppDetail(db, o));
  const notes = db.prepare('SELECT * FROM notes WHERE contact_id = ? ORDER BY created_at DESC').all(c.id).map(n => Object.assign(n, { user: userName(n.user_id) }));
  const tasks = db.prepare('SELECT * FROM tasks WHERE contact_id = ? ORDER BY done_at IS NOT NULL, due_date').all(c.id).map(t => Object.assign(t, { owner: userName(t.owner_id) }));
  const log = db.prepare("SELECT * FROM audit WHERE (entity = 'contato' AND entity_id = ?) OR (entity = 'oportunidade' AND entity_id IN (SELECT id FROM opportunities WHERE contact_id = ?)) ORDER BY at DESC LIMIT 200").all(c.id, c.id);
  return { contact: Object.assign(c, { owner: userName(c.owner_id) }), touchpoints: touch, opportunities: opps, notes, tasks, log };
}
function oppDetail(db, o) {
  const st = db.prepare('SELECT name, kind FROM stages WHERE id = ?').get(o.stage_id) || {};
  const crit = db.prepare('SELECT * FROM qual_criteria ORDER BY sort').all();
  let answers = {}; try { answers = JSON.parse(o.qual_answers || '{}'); } catch (e) { /* */ }
  const q = L.computeQualification(answers, crit);
  return Object.assign({}, o, {
    stage: st.name, stage_kind: st.kind, owner: userName(o.owner_id),
    qual: { auto: q, answers, status: o.qual_status, manual: !!o.qual_manual, note: o.qual_note },
    history: db.prepare('SELECT h.*, a.name AS from_name, b.name AS to_name FROM stage_history h LEFT JOIN stages a ON a.id = h.from_stage_id LEFT JOIN stages b ON b.id = h.to_stage_id WHERE opp_id = ? ORDER BY at DESC, h.id DESC').all(o.id).map(x => Object.assign(x, { user: userName(x.user_id) })),
    proposals: db.prepare('SELECT * FROM proposals WHERE opp_id = ? ORDER BY sent_at DESC').all(o.id),
    payments: db.prepare('SELECT * FROM payments WHERE opp_id = ? ORDER BY date DESC').all(o.id),
    loss_reason: o.loss_reason_id ? (db.prepare('SELECT name FROM loss_reasons WHERE id = ?').get(o.loss_reason_id) || {}).name : null,
  });
}
app.get('/api/contacts/:id', h((req, res) => res.json(contactDetail(req.db, req.params.id))));

app.post('/api/contacts', h((req, res) => {
  const db = req.db; const b = req.body || {};
  const c = contactPayload(b.contact || b);
  if (!c.name) throw err(400, 'Informe o nome do contato.');
  if (!c.phone_norm && !c.email_norm) throw err(400, 'Informe ao menos um telefone ou e-mail válido.');
  const dups = findDuplicates(db, c.phone_norm, c.email_norm);
  if (dups.length && !b.force) return res.status(409).json({ error: 'Já existe contato com este telefone ou e-mail.', duplicates: dups });
  const result = tx(db, () => {
    Object.assign(c, { kind: c.kind || 'cliente_potencial', decision_maker: c.decision_maker || 'desconhecido', captured_at: c.captured_at || L.today(), created_by: req.user.id, created_at: L.nowIso(), updated_at: L.nowIso() });
    const id = insert(db, 'contacts', c);
    const t = touchPayload(b.touch);
    if (!t.occurred_at || t.occurred_at > c.captured_at) t.occurred_at = c.captured_at;
    insert(db, 'touchpoints', Object.assign(t, { contact_id: id, created_by: req.user.id, created_at: L.nowIso(), type: t.type || 'atendimento' }));
    let oppId = null;
    if (b.opp && b.opp.create) oppId = createOpp(req, Object.assign({}, b.opp, { contact_id: id }));
    return { id, oppId };
  });
  audit(req, 'criou contato', 'contato', result.id, { name: c.name });
  res.json(result);
}));
app.put('/api/contacts/:id', h((req, res) => {
  const cur = get(req.db, 'contacts', req.params.id); const c = contactPayload(req.body);
  if (c.name === null) throw err(400, 'O nome não pode ficar vazio.');
  const ph = c.phone_norm !== undefined ? c.phone_norm : cur.phone_norm; const em = c.email_norm !== undefined ? c.email_norm : cur.email_norm;
  if (!ph && !em) throw err(400, 'Mantenha ao menos um telefone ou e-mail válido.');
  const dups = findDuplicates(req.db, c.phone_norm, c.email_norm, cur.id);
  if (dups.length && !req.body.force) return res.status(409).json({ error: 'Outro contato já usa este telefone ou e-mail.', duplicates: dups });
  c.updated_at = L.nowIso(); update(req.db, 'contacts', cur.id, c);
  const changed = Object.keys(c).filter(k => k !== 'updated_at' && String(cur[k] ?? '') !== String(c[k] ?? ''));
  audit(req, 'editou contato', 'contato', cur.id, { campos: changed }); res.json({ ok: true });
}));
app.post('/api/contacts/:id/archive', h((req, res) => {
  const cur = get(req.db, 'contacts', req.params.id); const a = req.body.archived ? 1 : 0;
  update(req.db, 'contacts', cur.id, { archived: a, updated_at: L.nowIso() });
  audit(req, a ? 'arquivou contato' : 'reativou contato', 'contato', cur.id); res.json({ ok: true });
}));

// interações / origens
app.post('/api/touchpoints', h((req, res) => {
  const c = get(req.db, 'contacts', req.body.contact_id); const t = touchPayload(req.body);
  const id = insert(req.db, 'touchpoints', Object.assign(t, { contact_id: c.id, created_by: req.user.id, created_at: L.nowIso() }));
  audit(req, 'registrou interação', 'contato', c.id, { tipo: t.type }); res.json({ id });
}));
app.put('/api/touchpoints/:id', h((req, res) => {
  const t0 = get(req.db, 'touchpoints', req.params.id); const t = touchPayload(Object.assign({}, t0, req.body));
  update(req.db, 'touchpoints', t0.id, t); audit(req, 'editou interação/origem', 'contato', t0.contact_id, { id: t0.id }); res.json({ ok: true });
}));
app.delete('/api/touchpoints/:id', h((req, res) => {
  const t0 = get(req.db, 'touchpoints', req.params.id);
  req.db.prepare('DELETE FROM touchpoints WHERE id = ?').run(t0.id); audit(req, 'excluiu interação', 'contato', t0.contact_id, { id: t0.id }); res.json({ ok: true });
}));

// ---------- importação de contatos (CSV) ----------
function resolveByName(db, table, col, val) {
  if (!val) return null; const v = String(val).trim(); if (!v) return null;
  if (/^\d+$/.test(v)) { const r = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(Number(v)); if (r) return r.id; }
  const r = db.prepare(`SELECT id FROM ${table} WHERE lower(trim(${col})) = lower(?)`).get(v); return r ? r.id : undefined;
}
const PROFILES = ['construtor', 'incorporador', 'engenheiro', 'arquiteto', 'advogado', 'proprietario', 'investidor', 'outro'];
function mapProfile(v) { if (!v) return null; const s = String(v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); return PROFILES.find(p => s.startsWith(p.slice(0, 6))) || 'outro'; }
function mapKind(v) { if (!v) return 'cliente_potencial'; const s = String(v).toLowerCase(); return s.includes('parc') ? 'parceiro' : s.includes('curso') || s.includes('aluno') ? 'interessado_curso' : 'cliente_potencial'; }
function prepareImportRow(db, r) {
  const errors = []; const warnings = [];
  const phone_norm = L.normPhone(r.phone); const email_norm = L.normEmail(r.email);
  if (!r.name || !String(r.name).trim()) errors.push('Sem nome');
  if (!phone_norm && !email_norm) errors.push('Sem telefone ou e-mail válido');
  const source_id = resolveByName(db, 'sources', 'name', r.source); if (r.source && source_id === undefined) warnings.push(`Origem "${r.source}" não cadastrada (ficará como Não identificado)`);
  const campaign_id = resolveByName(db, 'campaigns', 'name', r.campaign); if (r.campaign && campaign_id === undefined) warnings.push(`Campanha "${r.campaign}" não encontrada`);
  const content_id = resolveByName(db, 'contents', 'title', r.content); if (r.content && content_id === undefined) warnings.push(`Conteúdo "${r.content}" não encontrado`);
  const service_id = resolveByName(db, 'services', 'name', r.service); if (r.service && service_id === undefined) warnings.push(`Serviço "${r.service}" não encontrado`);
  const captured_at = L.parseDateBR(r.captured_at); if (r.captured_at && !captured_at) warnings.push('Data de captação inválida (usará hoje)');
  return { data: { name: (r.name || '').trim(), phone: r.phone || null, email: r.email || null, company: r.company || null, city: r.city || null, kind: mapKind(r.kind), profile: mapProfile(r.profile), notes: r.notes || null,
    captured_at: captured_at || L.today(), source_id: source_id || null, campaign_id: campaign_id || null, content_id: content_id || null, service_id: service_id || null,
    utm_source: r.utm_source || null, utm_medium: r.utm_medium || null, utm_campaign: r.utm_campaign || null, utm_content: r.utm_content || null, utm_term: r.utm_term || null, phone_norm, email_norm },
  errors, warnings };
}
app.post('/api/contacts/import/preview', h((req, res) => {
  const rows = (req.body.rows || []).slice(0, 5000);
  const seenP = new Map(); const seenE = new Map();
  const out = rows.map((r, i) => {
    const p = prepareImportRow(req.db, r); const d = p.data;
    const matches = p.errors.length ? [] : findDuplicates(req.db, d.phone_norm, d.email_norm);
    let inFile = null;
    if (d.phone_norm && seenP.has(d.phone_norm)) inFile = seenP.get(d.phone_norm); else if (d.email_norm && seenE.has(d.email_norm)) inFile = seenE.get(d.email_norm);
    if (d.phone_norm && !seenP.has(d.phone_norm)) seenP.set(d.phone_norm, i); if (d.email_norm && !seenE.has(d.email_norm)) seenE.set(d.email_norm, i);
    const status = p.errors.length ? 'erro' : inFile !== null ? 'repetido_no_arquivo' : matches.length ? 'duplicado' : 'novo';
    return { index: i, data: d, errors: p.errors, warnings: p.warnings, matches, inFile, status, action: status === 'novo' ? 'criar' : status === 'duplicado' ? 'atualizar' : 'ignorar' };
  });
  res.json({ rows: out, counts: out.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}) });
}));
app.post('/api/contacts/import/commit', h((req, res) => {
  const db = req.db; const rows = req.body.rows || []; const createOpps = !!req.body.create_opps; const ownerId = idOrNull(req.body.owner_id);
  const stats = { criados: 0, atualizados: 0, ignorados: 0, erros: [] };
  tx(db, () => {
    for (const r of rows) {
      if (r.action === 'ignorar') { stats.ignorados++; continue; }
      const p = prepareImportRow(db, Object.assign({}, r.data, { source: r.data.source_id, campaign: r.data.campaign_id, content: r.data.content_id, service: r.data.service_id, kind: r.data.kind, profile: r.data.profile }));
      if (p.errors.length) { stats.erros.push({ index: r.index, errors: p.errors }); continue; }
      const d = p.data; let contactId;
      if (r.action === 'atualizar' && r.match_id) {
        const cur = get(db, 'contacts', r.match_id); const upd = {};
        for (const k of ['phone', 'email', 'company', 'city', 'profile', 'notes']) if (!cur[k] && d[k]) upd[k] = d[k];
        if (upd.phone) upd.phone_norm = d.phone_norm; if (upd.email) upd.email_norm = d.email_norm;
        upd.updated_at = L.nowIso(); update(db, 'contacts', cur.id, upd); contactId = cur.id; stats.atualizados++;
      } else {
        contactId = insert(db, 'contacts', { name: d.name, phone: d.phone, phone_norm: d.phone_norm || null, email: d.email, email_norm: d.email_norm || null, company: d.company, city: d.city,
          kind: d.kind, profile: d.profile, notes: d.notes, captured_at: d.captured_at, owner_id: ownerId, decision_maker: 'desconhecido', created_by: req.user.id, created_at: L.nowIso(), updated_at: L.nowIso() });
        stats.criados++;
      }
      insert(db, 'touchpoints', { contact_id: contactId, occurred_at: d.captured_at, type: 'importacao', source_id: d.source_id, campaign_id: d.campaign_id, content_id: d.content_id,
        utm_source: d.utm_source, utm_medium: d.utm_medium, utm_campaign: d.utm_campaign, utm_content: d.utm_content, utm_term: d.utm_term, note: 'Importado por CSV', created_by: req.user.id, created_at: L.nowIso() });
      if (createOpps && r.action !== 'atualizar') createOpp(req, { contact_id: contactId, service_id: d.service_id, owner_id: ownerId, next_action: 'Fazer primeiro contato', next_action_date: L.today(), _import: true });
    }
  });
  audit(req, 'importou contatos (CSV)', 'contato', null, stats); res.json(stats);
}));

// ---------- oportunidades ----------
const OPP_FIELDS = ['title', 'service_id', 'owner_id', 'estimated_value', 'need', 'difficulty', 'urgency', 'deadline', 'budget_range', 'source_id', 'campaign_id', 'content_id',
  'next_action', 'next_action_date', 'objection', 'feedback', 'win_factors', 'loss_detail', 'retake_date', 'qual_note'];
const OPP_ADMIN_FIELDS = ['meeting_scheduled_at', 'meeting_done_at', 'proposal_sent_at', 'first_contact_at', 'one_time_value', 'monthly_value', 'contract_months', 'contract_type', 'won_at', 'lost_at', 'loss_reason_id'];
function oppPayload(b, allowClosed) {
  const o = pick(b, OPP_FIELDS.concat(allowClosed ? OPP_ADMIN_FIELDS : []));
  for (const k of ['service_id', 'owner_id', 'source_id', 'campaign_id', 'content_id', 'loss_reason_id']) if (o[k] !== undefined) o[k] = idOrNull(o[k]);
  for (const k of ['estimated_value', 'one_time_value', 'monthly_value']) if (o[k] !== undefined) o[k] = L.num(o[k]);
  if (o.contract_months !== undefined) o.contract_months = o.contract_months ? Number(o.contract_months) : null;
  for (const k of ['next_action_date', 'retake_date', 'meeting_scheduled_at', 'meeting_done_at', 'proposal_sent_at', 'first_contact_at', 'won_at', 'lost_at']) if (o[k] !== undefined && o[k] !== null) o[k] = L.parseDateBR(o[k]);
  if (o.urgency && !['alta', 'media', 'baixa', 'desconhecida'].includes(o.urgency)) o.urgency = 'desconhecida';
  return o;
}
function createOpp(req, b) {
  const db = req.db; const c = get(db, 'contacts', b.contact_id); const o = oppPayload(b);
  if (!b._import && !b._webhook) {
    if (!o.owner_id) throw err(400, 'Toda oportunidade precisa de um responsável.');
    if (!o.next_action || !o.next_action_date) throw err(400, 'Informe a próxima ação e o prazo.');
  }
  const first = db.prepare("SELECT * FROM stages WHERE kind = 'open' AND archived = 0 ORDER BY sort LIMIT 1").get();
  let stage = first;
  if (b.stage_id) { const s = db.prepare("SELECT * FROM stages WHERE id = ? AND kind = 'open'").get(Number(b.stage_id)); if (s) stage = s; }
  if (o.source_id === undefined && o.campaign_id === undefined && o.content_id === undefined) {
    // origem da oportunidade = última interação conhecida do contato antes da criação
    const t = db.prepare('SELECT * FROM touchpoints WHERE contact_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1').get(c.id);
    if (t) Object.assign(o, { source_id: t.source_id, campaign_id: t.campaign_id, content_id: t.content_id });
  }
  const now = L.nowIso();
  const crit = db.prepare('SELECT * FROM qual_criteria ORDER BY sort').all();
  const answers = b.qual_answers && typeof b.qual_answers === 'object' ? b.qual_answers : {};
  const q = L.computeQualification(answers, crit);
  const id = insert(db, 'opportunities', Object.assign(o, { contact_id: c.id, stage_id: stage.id, status: 'open', stage_entered_at: now, urgency: o.urgency || 'desconhecida',
    qual_answers: JSON.stringify(answers), qual_status: q.status, qualified_at: q.status === 'qualificado' ? L.today() : null, created_by: req.user.id, created_at: now, updated_at: now }));
  db.prepare('INSERT INTO stage_history (opp_id, from_stage_id, to_stage_id, user_id, at, note) VALUES (?,?,?,?,?,?)').run(id, null, stage.id, req.user.id, now, 'Oportunidade criada');
  if (stage.id !== first.id) L.moveOpp(db, id, stage.id, req.user.id, { force: true, note: 'Etapa inicial informada no cadastro' });
  audit(req, 'criou oportunidade', 'oportunidade', id, { contato: c.name });
  return id;
}
app.post('/api/opportunities', need('admin', 'comercial', 'marketing'), h((req, res) => {
  if (req.user.role === 'marketing') delete req.body.stage_id;
  const id = tx(req.db, () => createOpp(req, req.body)); res.json({ id });
}));
app.get('/api/opportunities', h((req, res) => {
  const d = A.load(req.db); const T = L.today(); const q = (req.query.q || '').toLowerCase().trim();
  const closedDays = req.query.closed_days === 'all' ? null : Number(req.query.closed_days || 30);
  const model = req.query.model === 'opp' ? 'opp' : 'first';
  const cards = d.opps.filter(o => {
    const c = d.contactById.get(o.contact_id); if (!c) return false;
    if (req.query.owner_id && String(o.owner_id || 0) !== String(req.query.owner_id)) return false;
    if (req.query.service_id && String(o.service_id || 0) !== String(req.query.service_id)) return false;
    const a = A.oppAttr(o, d, model);
    if (req.query.source_id && String(a.source_id) !== String(req.query.source_id)) return false;
    if (req.query.campaign_id && String(a.campaign_id) !== String(req.query.campaign_id)) return false;
    if (req.query.kind && c.kind !== req.query.kind) return false;
    if (req.query.overdue === '1' && !(o.status === 'open' && (!o.next_action_date || o.next_action_date < T))) return false;
    if (q && !((c.name || '').toLowerCase().includes(q) || (c.company || '').toLowerCase().includes(q) || (o.title || '').toLowerCase().includes(q))) return false;
    if (o.status !== 'open' && closedDays !== null) { const dt = o.status === 'won' ? o.won_at : o.lost_at; if (!dt || L.daysBetween(dt, T) > closedDays) return false; }
    return true;
  }).map(o => {
    const c = d.contactById.get(o.contact_id); const a = A.oppAttr(o, d, 'opp'); const af = A.contactAttr(c, d);
    const openTasks = d.tasks.filter(t => t.opp_id === o.id && !t.done_at);
    return { id: o.id, contact_id: c.id, name: c.name, company: c.company, kind: c.kind, title: o.title, stage_id: o.stage_id, status: o.status,
      service: o.service_id ? (d.svcById.get(o.service_id) || {}).name : null, service_id: o.service_id,
      source: a.source_id ? d.srcById.get(a.source_id).name : (af.source_id ? d.srcById.get(af.source_id).name : 'Não identificado'),
      campaign: a.campaign_id ? (d.campById.get(a.campaign_id) || {}).name : null, content: a.content_id ? (d.contById.get(a.content_id) || {}).title : null,
      owner_id: o.owner_id, estimated_value: o.estimated_value, one_time_value: o.one_time_value, monthly_value: o.monthly_value,
      stage_entered_at: o.stage_entered_at, next_action: o.next_action, next_action_date: o.next_action_date,
      overdue: o.status === 'open' && !!o.next_action_date && o.next_action_date < T, no_next: o.status === 'open' && (!o.next_action || !o.next_action_date),
      overdue_tasks: openTasks.filter(t => t.due_date && t.due_date < T).length, open_tasks: openTasks.length,
      qual_status: o.qual_status, loss_reason: o.loss_reason_id ? (d.reasonById.get(o.loss_reason_id) || {}).name : null, won_at: o.won_at, lost_at: o.lost_at };
  });
  res.json(cards);
}));
app.get('/api/opportunities/:id', h((req, res) => res.json(oppDetail(req.db, get(req.db, 'opportunities', req.params.id)))));
app.put('/api/opportunities/:id', h((req, res) => {
  const db = req.db; const cur = get(db, 'opportunities', req.params.id);
  const commercial = req.user.role !== 'marketing';
  const o = oppPayload(req.body, commercial);
  if (!commercial) { for (const k of ['owner_id', 'win_factors', 'loss_detail', 'retake_date']) delete o[k]; }
  if (o.owner_id === null) throw err(400, 'Toda oportunidade precisa de um responsável.');
  // qualificação
  if (req.body.qual_answers || req.body.qual_manual !== undefined) {
    const crit = db.prepare('SELECT * FROM qual_criteria ORDER BY sort').all();
    const answers = req.body.qual_answers || JSON.parse(cur.qual_answers || '{}');
    const auto = L.computeQualification(answers, crit);
    const manual = req.body.qual_manual !== undefined ? !!req.body.qual_manual : !!cur.qual_manual;
    let status = auto.status;
    if (manual) { status = req.body.qual_status || cur.qual_status; if (!['qualificado', 'nao_qualificado', 'em_analise'].includes(status)) status = 'em_analise'; if (!(req.body.qual_note || cur.qual_note)) throw err(400, 'Explique o motivo do ajuste manual da qualificação.'); }
    Object.assign(o, { qual_answers: JSON.stringify(answers), qual_manual: manual ? 1 : 0, qual_status: status });
    if (status === 'qualificado' && !cur.qualified_at) o.qualified_at = L.today();
    if (status !== 'qualificado') o.qualified_at = null;
  }
  o.updated_at = L.nowIso(); update(db, 'opportunities', cur.id, o);
  const changed = Object.keys(o).filter(k => k !== 'updated_at' && String(cur[k] ?? '') !== String(o[k] ?? ''));
  audit(req, 'editou oportunidade', 'oportunidade', cur.id, { campos: changed });
  res.json(oppDetail(db, get(db, 'opportunities', cur.id)));
}));
app.post('/api/opportunities/:id/move', need('admin', 'comercial'), h((req, res) => {
  const db = req.db; const cur = get(db, 'opportunities', req.params.id);
  const o = tx(db, () => L.moveOpp(db, cur.id, Number(req.body.stage_id), req.user.id, { won: req.body.won, lost: req.body.lost, note: req.body.note }));
  const st = db.prepare('SELECT name FROM stages WHERE id = ?').get(o.stage_id);
  audit(req, 'moveu oportunidade', 'oportunidade', cur.id, { para: st && st.name, status: o.status });
  res.json(oppDetail(db, o));
}));
app.post('/api/opportunities/:id/archive', need('admin'), h((req, res) => {
  const cur = get(req.db, 'opportunities', req.params.id); update(req.db, 'opportunities', cur.id, { archived: req.body.archived ? 1 : 0 });
  audit(req, req.body.archived ? 'arquivou oportunidade' : 'reativou oportunidade', 'oportunidade', cur.id); res.json({ ok: true });
}));

// propostas e recebimentos
app.post('/api/proposals', need('admin', 'comercial'), h((req, res) => {
  const db = req.db; const o = get(db, 'opportunities', req.body.opp_id);
  const p = { opp_id: o.id, sent_at: L.parseDateBR(req.body.sent_at) || L.today(), one_time_value: L.num(req.body.one_time_value), monthly_value: L.num(req.body.monthly_value),
    status: ['enviada', 'aceita', 'recusada'].includes(req.body.status) ? req.body.status : 'enviada', followup_date: L.parseDateBR(req.body.followup_date), note: clean(req.body.note), created_by: req.user.id, created_at: L.nowIso() };
  const id = tx(db, () => {
    const id = insert(db, 'proposals', p);
    const upd = {}; if (!o.proposal_sent_at || p.sent_at < o.proposal_sent_at) upd.proposal_sent_at = p.sent_at;
    if (p.followup_date) { upd.next_action = 'Retornar sobre a proposta'; upd.next_action_date = p.followup_date; }
    if (Object.keys(upd).length) update(db, 'opportunities', o.id, upd);
    return id;
  });
  audit(req, 'registrou proposta', 'oportunidade', o.id, { valor_unico: p.one_time_value, mensal: p.monthly_value }); res.json({ id });
}));
app.put('/api/proposals/:id', need('admin', 'comercial'), h((req, res) => {
  const p = get(req.db, 'proposals', req.params.id); const u = {};
  if (req.body.status && ['enviada', 'aceita', 'recusada'].includes(req.body.status)) u.status = req.body.status;
  if (req.body.note !== undefined) u.note = clean(req.body.note);
  update(req.db, 'proposals', p.id, u); audit(req, 'alterou proposta', 'oportunidade', p.opp_id, u); res.json({ ok: true });
}));
app.delete('/api/proposals/:id', need('admin', 'comercial'), h((req, res) => {
  const p = get(req.db, 'proposals', req.params.id); req.db.prepare('DELETE FROM proposals WHERE id = ?').run(p.id);
  audit(req, 'excluiu proposta', 'oportunidade', p.opp_id); res.json({ ok: true });
}));
app.post('/api/payments', need('admin', 'comercial'), h((req, res) => {
  const o = get(req.db, 'opportunities', req.body.opp_id);
  if (o.status !== 'won') throw err(400, 'Registre recebimentos apenas em oportunidades ganhas.');
  const amount = L.num(req.body.amount); if (!(amount > 0)) throw err(400, 'Informe o valor recebido.');
  const id = insert(req.db, 'payments', { opp_id: o.id, date: L.parseDateBR(req.body.date) || L.today(), amount, note: clean(req.body.note), created_by: req.user.id, created_at: L.nowIso() });
  audit(req, 'registrou recebimento', 'oportunidade', o.id, { valor: amount }); res.json({ id });
}));
app.delete('/api/payments/:id', need('admin', 'comercial'), h((req, res) => {
  const p = get(req.db, 'payments', req.params.id); req.db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
  audit(req, 'excluiu recebimento', 'oportunidade', p.opp_id, { valor: p.amount }); res.json({ ok: true });
}));

// ---------- anotações e tarefas ----------
app.post('/api/notes', h((req, res) => {
  const body = clean(req.body.body); if (!body) throw err(400, 'Escreva a anotação.');
  const c = get(req.db, 'contacts', req.body.contact_id);
  const id = insert(req.db, 'notes', { contact_id: c.id, opp_id: idOrNull(req.body.opp_id), user_id: req.user.id, body, created_at: L.nowIso() });
  audit(req, 'adicionou anotação', 'contato', c.id); res.json({ id });
}));
app.get('/api/tasks', h((req, res) => {
  const db = req.db; const T = L.today();
  let rows = db.prepare(`SELECT t.*, c.name AS contact_name, c.company FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id ORDER BY t.done_at IS NOT NULL, t.due_date, t.id`).all();
  if (req.query.scope === 'mine') rows = rows.filter(t => t.owner_id === req.user.id);
  else if (req.query.owner_id) rows = rows.filter(t => String(t.owner_id || 0) === String(req.query.owner_id));
  if (req.query.status === 'open') rows = rows.filter(t => !t.done_at); else if (req.query.status === 'done') rows = rows.filter(t => t.done_at);
  res.json(rows.map(t => Object.assign(t, { owner: userName(t.owner_id), overdue: !t.done_at && t.due_date && t.due_date < T })));
}));
app.post('/api/tasks', h((req, res) => {
  const title = clean(req.body.title); if (!title) throw err(400, 'Descreva a tarefa.');
  let contactId = idOrNull(req.body.contact_id); const oppId = idOrNull(req.body.opp_id);
  if (oppId && !contactId) contactId = get(req.db, 'opportunities', oppId).contact_id;
  const id = insert(req.db, 'tasks', { title, due_date: L.parseDateBR(req.body.due_date), owner_id: idOrNull(req.body.owner_id) || req.user.id, opp_id: oppId, contact_id: contactId, created_by: req.user.id, created_at: L.nowIso() });
  audit(req, 'criou tarefa', contactId ? 'contato' : 'tarefa', contactId || id, { title }); res.json({ id });
}));
app.put('/api/tasks/:id', h((req, res) => {
  const t = get(req.db, 'tasks', req.params.id); const u = {};
  if (req.body.title !== undefined) u.title = clean(req.body.title);
  if (req.body.due_date !== undefined) u.due_date = L.parseDateBR(req.body.due_date);
  if (req.body.owner_id !== undefined) u.owner_id = idOrNull(req.body.owner_id);
  if (req.body.done !== undefined) u.done_at = req.body.done ? L.nowIso() : null;
  update(req.db, 'tasks', t.id, u); audit(req, req.body.done ? 'concluiu tarefa' : 'alterou tarefa', t.contact_id ? 'contato' : 'tarefa', t.contact_id || t.id, { title: t.title }); res.json({ ok: true });
}));
app.delete('/api/tasks/:id', h((req, res) => { const t = get(req.db, 'tasks', req.params.id); req.db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id); audit(req, 'excluiu tarefa', 'tarefa', t.id, { title: t.title }); res.json({ ok: true }); }));

// ---------- campanhas ----------
const CAMP_FIELDS = ['name', 'objective', 'channel', 'service_id', 'start_date', 'end_date', 'status', 'budget_planned', 'audience', 'notes', 'archived'];
function campPayload(b) {
  const o = pick(b, CAMP_FIELDS);
  if (o.service_id !== undefined) o.service_id = idOrNull(o.service_id);
  if (o.budget_planned !== undefined) o.budget_planned = L.num(o.budget_planned);
  for (const k of ['start_date', 'end_date']) if (o[k] !== undefined && o[k] !== null) o[k] = L.parseDateBR(o[k]);
  if (o.status && !['planejada', 'ativa', 'pausada', 'encerrada'].includes(o.status)) throw err(400, 'Status inválido.');
  return o;
}
function campaignSummaries(db, model) {
  const d = A.load(db); const T = L.today();
  const f = { from: '1900-01-01', to: T, source_id: null, campaign_id: null, content_id: null, service_id: null, owner_id: null, kind: null, model: model === 'opp' ? 'opp' : 'first', view: 'cohort' };
  const rows = A.compare(db, Object.assign({}, f, { by: 'campaign', from: f.from, to: f.to, view: 'cohort', model: f.model })).rows;
  const byId = new Map(rows.map(r => [r.key, r]));
  return d.campaigns.map(c => {
    const r = byId.get(c.id) || {};
    const mets = d.metrics.filter(m => m.campaign_id === c.id);
    const spend = mets.reduce((a, m) => a + (m.spend || 0), 0);
    const start = c.start_date || (mets.length ? mets.map(m => m.date).sort()[0] : null);
    const end = c.end_date && c.end_date < T ? c.end_date : T;
    const days = start && start <= end ? L.daysBetween(start, end) + 1 : null;
    return Object.assign({}, c, { service: c.service_id ? (d.svcById.get(c.service_id) || {}).name : null,
      spend, metrics_count: mets.length, last_metric: mets.length ? mets.map(m => m.date).sort().pop() : null,
      budget_left: c.budget_planned !== null && c.budget_planned !== undefined ? c.budget_planned - spend : null,
      spend_per_day: days ? spend / days : null, days,
      impressions: mets.some(m => m.impressions !== null) ? mets.reduce((a, m) => a + (m.impressions || 0), 0) : null,
      clicks: mets.some(m => m.clicks !== null) ? mets.reduce((a, m) => a + (m.clicks || 0), 0) : null,
      conversations: mets.some(m => m.conversations !== null) ? mets.reduce((a, m) => a + (m.conversations || 0), 0) : null,
      contents: d.contents.filter(k => k.campaign_id === c.id).length,
      leads: r.leads || 0, qualified: r.qualified || 0, meetings: r.meetings || 0, won: r.won || 0, one: r.one || 0, monthly: r.monthly || 0, revenue: r.revenue || 0,
      cpl: spend && r.leads ? spend / r.leads : null, cpql: spend && r.qualified ? spend / r.qualified : null, cpa: spend && r.won ? spend / r.won : null, sample: r.sample || A.sampleNote(0) });
  });
}
app.get('/api/campaigns', h((req, res) => res.json(campaignSummaries(req.db, req.query.model))));
app.get('/api/campaigns/:id', h((req, res) => {
  const c = get(req.db, 'campaigns', req.params.id);
  const s = campaignSummaries(req.db, req.query.model).find(x => x.id === c.id);
  const metrics = req.db.prepare('SELECT m.*, s.name AS source, k.title AS content FROM metrics m LEFT JOIN sources s ON s.id = m.source_id LEFT JOIN contents k ON k.id = m.content_id WHERE m.campaign_id = ? ORDER BY m.date DESC, m.id DESC').all(c.id);
  const contents = req.db.prepare('SELECT * FROM contents WHERE campaign_id = ? ORDER BY published_at DESC').all(c.id);
  const costs = req.db.prepare('SELECT * FROM other_costs WHERE campaign_id = ? ORDER BY date DESC').all(c.id);
  res.json({ campaign: s, metrics, contents, costs });
}));
app.post('/api/campaigns', need('admin', 'marketing'), h((req, res) => {
  const o = campPayload(req.body); if (!o.name) throw err(400, 'Informe o nome da campanha.');
  if (o.start_date && o.end_date && o.end_date < o.start_date) throw err(400, 'A data de término é anterior ao início.');
  const id = insert(req.db, 'campaigns', Object.assign({ status: 'planejada' }, o, { created_by: req.user.id, created_at: L.nowIso(), updated_at: L.nowIso() }));
  audit(req, 'criou campanha', 'campanha', id, { name: o.name }); res.json({ id });
}));
app.put('/api/campaigns/:id', need('admin', 'marketing'), h((req, res) => {
  const c = get(req.db, 'campaigns', req.params.id); const o = campPayload(req.body); o.updated_at = L.nowIso();
  update(req.db, 'campaigns', c.id, o); audit(req, 'editou campanha', 'campanha', c.id, o); res.json({ ok: true });
}));

// ---------- conteúdos ----------
const CONT_FIELDS = ['title', 'theme', 'url', 'channel', 'format', 'published_at', 'service_id', 'hook', 'cta', 'campaign_id', 'is_ad', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'archived'];
function contPayload(b) {
  const o = pick(b, CONT_FIELDS);
  for (const k of ['service_id', 'campaign_id']) if (o[k] !== undefined) o[k] = idOrNull(o[k]);
  if (o.published_at !== undefined && o.published_at !== null) o.published_at = L.parseDateBR(o.published_at);
  if (o.is_ad !== undefined) o.is_ad = o.is_ad ? 1 : 0;
  if (o.url && !/^https?:\/\//i.test(o.url)) o.url = 'https://' + o.url;
  return o;
}
app.get('/api/contents', h((req, res) => {
  const rows = A.compare(req.db, { by: 'content', from: '1900-01-01', to: L.today(), view: 'cohort', model: req.query.model }).rows;
  const byId = new Map(rows.map(r => [r.key, r]));
  const d = A.load(req.db);
  const clicks = new Map(); d.clicks.forEach(c => clicks.set(c.content_id, (clicks.get(c.content_id) || 0) + 1));
  res.json(d.contents.map(k => Object.assign({}, k, { campaign: k.campaign_id ? (d.campById.get(k.campaign_id) || {}).name : null, service: k.service_id ? (d.svcById.get(k.service_id) || {}).name : null,
    tracked_url: integrations.trackedUrl(k), own_clicks: clicks.get(k.id) || 0, stats: byId.get(k.id) || null })).sort((a, b) => (b.published_at || '').localeCompare(a.published_at || '')));
}));
app.post('/api/contents', need('admin', 'marketing'), h((req, res) => {
  const o = contPayload(req.body); if (!o.title) throw err(400, 'Informe o título do conteúdo.');
  o.short_code = crypto.randomBytes(5).toString('base64url');
  const id = insert(req.db, 'contents', Object.assign(o, { created_by: req.user.id, created_at: L.nowIso(), updated_at: L.nowIso() }));
  audit(req, 'criou conteúdo', 'conteúdo', id, { title: o.title }); res.json({ id });
}));
app.put('/api/contents/:id', need('admin', 'marketing'), h((req, res) => {
  const c = get(req.db, 'contents', req.params.id); const o = contPayload(req.body); o.updated_at = L.nowIso();
  update(req.db, 'contents', c.id, o); audit(req, 'editou conteúdo', 'conteúdo', c.id, o); res.json({ ok: true });
}));

// ---------- métricas (manual e importação, sem duplicar) ----------
function metricRow(db, r) {
  const errors = [];
  const date = L.parseDateBR(r.date); if (!date) errors.push('Data inválida');
  let campaign_id = r.campaign_id ? Number(r.campaign_id) : resolveByName(db, 'campaigns', 'name', r.campaign);
  if (!campaign_id) errors.push(r.campaign ? `Campanha "${r.campaign}" não encontrada` : 'Informe a campanha');
  let content_id = r.content_id ? Number(r.content_id) : (r.content ? resolveByName(db, 'contents', 'title', r.content) : null);
  if (r.content && !content_id) errors.push(`Conteúdo "${r.content}" não encontrado`);
  let source_id = r.source_id ? Number(r.source_id) : (r.source ? resolveByName(db, 'sources', 'name', r.source) : null);
  if (r.source && !source_id) errors.push(`Origem "${r.source}" não encontrada`);
  const vals = {};
  for (const k of ['spend', 'impressions', 'reach', 'clicks', 'conversations']) { const v = L.num(r[k]); if (r[k] !== undefined && r[k] !== '' && r[k] !== null && v === null) errors.push(`Valor inválido em ${k}`); vals[k] = v; if (v !== null && v < 0) errors.push('Valores não podem ser negativos'); }
  if (Object.values(vals).every(v => v === null)) errors.push('Nenhuma métrica informada');
  const ukey = `${date}|${campaign_id || 0}|${content_id || 0}|${source_id || 0}`;
  return { errors, data: Object.assign({ ukey, date, campaign_id: campaign_id || null, content_id: content_id || null, source_id: source_id || null }, vals) };
}
function upsertMetric(req, data, origin) {
  const ex = req.db.prepare('SELECT * FROM metrics WHERE ukey = ?').get(data.ukey);
  if (ex) { update(req.db, 'metrics', ex.id, Object.assign({}, data, { origin, updated_by: req.user.id, updated_at: L.nowIso() })); return { id: ex.id, replaced: true }; }
  return { id: insert(req.db, 'metrics', Object.assign({}, data, { origin, updated_by: req.user.id, updated_at: L.nowIso() })), replaced: false };
}
app.get('/api/metrics', h((req, res) => {
  const where = []; const args = [];
  if (req.query.campaign_id) { where.push('m.campaign_id = ?'); args.push(Number(req.query.campaign_id)); }
  if (req.query.from) { where.push('m.date >= ?'); args.push(req.query.from); } if (req.query.to) { where.push('m.date <= ?'); args.push(req.query.to); }
  res.json(req.db.prepare(`SELECT m.*, c.name AS campaign, k.title AS content, s.name AS source FROM metrics m LEFT JOIN campaigns c ON c.id = m.campaign_id LEFT JOIN contents k ON k.id = m.content_id LEFT JOIN sources s ON s.id = m.source_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.date DESC, m.id DESC LIMIT 2000`).all(...args));
}));
app.post('/api/metrics', need('admin', 'marketing'), h((req, res) => {
  const r = metricRow(req.db, req.body); if (r.errors.length) throw err(400, r.errors.join('; '));
  const out = upsertMetric(req, r.data, 'manual'); audit(req, out.replaced ? 'substituiu métrica' : 'registrou métrica', 'campanha', r.data.campaign_id, r.data); res.json(out);
}));
app.delete('/api/metrics/:id', need('admin', 'marketing'), h((req, res) => {
  const m = get(req.db, 'metrics', req.params.id); req.db.prepare('DELETE FROM metrics WHERE id = ?').run(m.id); audit(req, 'excluiu métrica', 'campanha', m.campaign_id, m); res.json({ ok: true });
}));
app.post('/api/metrics/import/preview', need('admin', 'marketing'), h((req, res) => {
  const seen = new Map();
  const rows = (req.body.rows || []).slice(0, 20000).map((r, i) => {
    const p = metricRow(req.db, r);
    let status = 'novo';
    if (p.errors.length) status = 'erro';
    else {
      if (seen.has(p.data.ukey)) status = 'repetido_no_arquivo';
      else {
        const ex = req.db.prepare('SELECT * FROM metrics WHERE ukey = ?').get(p.data.ukey);
        if (ex) status = ['spend', 'impressions', 'reach', 'clicks', 'conversations'].every(k => (ex[k] ?? null) === (p.data[k] ?? null)) ? 'igual' : 'substitui';
      }
      seen.set(p.data.ukey, i);
    }
    return { index: i, status, errors: p.errors, data: p.data };
  });
  res.json({ rows, counts: rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}) });
}));
app.post('/api/metrics/import/commit', need('admin', 'marketing'), h((req, res) => {
  const stats = { novos: 0, substituidos: 0, ignorados: 0, erros: 0 };
  const latest = new Map();
  for (const r of req.body.rows || []) { const p = metricRow(req.db, r); if (p.errors.length) { stats.erros++; continue; } latest.set(p.data.ukey, p.data); }
  tx(req.db, () => { for (const data of latest.values()) {
    const ex = req.db.prepare('SELECT * FROM metrics WHERE ukey = ?').get(data.ukey);
    if (ex && ['spend', 'impressions', 'reach', 'clicks', 'conversations'].every(k => (ex[k] ?? null) === (data[k] ?? null))) { stats.ignorados++; continue; }
    const o = upsertMetric(req, data, 'importacao'); o.replaced ? stats.substituidos++ : stats.novos++;
  } });
  stats.ignorados += (req.body.rows || []).length - stats.erros - latest.size;
  audit(req, 'importou métricas (CSV)', 'campanha', null, stats); res.json(stats);
}));

// outros custos (para CAC completo)
app.get('/api/costs', h((req, res) => res.json(req.db.prepare('SELECT o.*, c.name AS campaign FROM other_costs o LEFT JOIN campaigns c ON c.id = o.campaign_id ORDER BY date DESC').all())));
app.post('/api/costs', need('admin', 'marketing'), h((req, res) => {
  const amount = L.num(req.body.amount); if (!(amount > 0)) throw err(400, 'Informe o valor.');
  if (!['marketing', 'vendas'].includes(req.body.category)) throw err(400, 'Escolha a categoria.');
  const id = insert(req.db, 'other_costs', { date: L.parseDateBR(req.body.date) || L.today(), category: req.body.category, description: clean(req.body.description), amount, campaign_id: idOrNull(req.body.campaign_id), created_by: req.user.id, created_at: L.nowIso() });
  audit(req, 'registrou custo', 'custo', id, { amount }); res.json({ id });
}));
app.delete('/api/costs/:id', need('admin', 'marketing'), h((req, res) => { const c = get(req.db, 'other_costs', req.params.id); req.db.prepare('DELETE FROM other_costs WHERE id = ?').run(c.id); audit(req, 'excluiu custo', 'custo', c.id, c); res.json({ ok: true }); }));

// ---------- metas ----------
app.get('/api/goals', h((req, res) => res.json(A.goalsList(req.db))));
app.post('/api/goals', need('admin'), h((req, res) => {
  const b = req.body; const ps = L.parseDateBR(b.period_start); const pe = L.parseDateBR(b.period_end); const target = L.num(b.target);
  if (!ps || !pe || pe < ps) throw err(400, 'Informe um período válido.'); if (!A.GOAL_METRICS[b.metric]) throw err(400, 'Indicador inválido.'); if (!(target > 0)) throw err(400, 'Informe a meta.');
  const id = insert(req.db, 'goals', { name: clean(b.name), period_start: ps, period_end: pe, service_id: idOrNull(b.service_id), metric: b.metric, target, created_by: req.user.id, created_at: L.nowIso() });
  audit(req, 'criou meta', 'meta', id, b); res.json({ id });
}));
app.delete('/api/goals/:id', need('admin'), h((req, res) => { const g = get(req.db, 'goals', req.params.id); req.db.prepare('DELETE FROM goals WHERE id = ?').run(g.id); audit(req, 'excluiu meta', 'meta', g.id, g); res.json({ ok: true }); }));

// ---------- análises ----------
app.get('/api/analytics/dashboard', h((req, res) => res.json(A.dashboard(req.db, req.query))));
app.get('/api/analytics/compare', h((req, res) => res.json(A.compare(req.db, req.query))));
app.get('/api/analytics/losses', h((req, res) => res.json(A.losses(req.db, req.query))));
app.get('/api/analytics/attribution', h((req, res) => res.json(A.attribution(req.db, req.query))));
app.get('/api/analytics/improve', h((req, res) => res.json(A.improve(req.db, req.query))));
app.get('/api/alerts', h((req, res) => res.json(A.alerts(req.db))));

// ---------- pesquisa global ----------
app.get('/api/search', h((req, res) => {
  const q = (req.query.q || '').trim(); if (q.length < 2) return res.json([]);
  const like = '%' + q.toLowerCase() + '%'; const digits = q.replace(/\D/g, '');
  const db = req.db; const out = [];
  db.prepare(`SELECT id, name, company, phone, email, archived FROM contacts WHERE lower(name) LIKE ? OR lower(ifnull(company,'')) LIKE ? OR lower(ifnull(email,'')) LIKE ? ${digits.length >= 4 ? 'OR phone_norm LIKE ?' : ''} LIMIT 12`)
    .all(...[like, like, like].concat(digits.length >= 4 ? ['%' + digits + '%'] : [])).forEach(c => out.push({ type: 'contato', id: c.id, label: c.name, sub: [c.company, c.phone, c.email, c.archived ? 'arquivado' : null].filter(Boolean).join(' · ') }));
  db.prepare('SELECT id, name, status FROM campaigns WHERE lower(name) LIKE ? LIMIT 6').all(like).forEach(c => out.push({ type: 'campanha', id: c.id, label: c.name, sub: c.status }));
  db.prepare("SELECT id, title, hook FROM contents WHERE lower(title) LIKE ? OR lower(ifnull(hook,'')) LIKE ? LIMIT 6").all(like, like).forEach(c => out.push({ type: 'conteúdo', id: c.id, label: c.title, sub: c.hook }));
  res.json(out);
}));

// ---------- filtros salvos ----------
app.get('/api/saved-filters', h((req, res) => res.json(req.db.prepare('SELECT * FROM saved_filters WHERE user_id = ? AND view = ? ORDER BY name').all(req.user.id, req.query.view || ''))));
app.post('/api/saved-filters', h((req, res) => {
  const name = clean(req.body.name); if (!name) throw err(400, 'Dê um nome ao filtro.');
  const id = insert(req.db, 'saved_filters', { user_id: req.user.id, view: String(req.body.view), name, params: JSON.stringify(req.body.params || {}), created_at: L.nowIso() }); res.json({ id });
}));
app.delete('/api/saved-filters/:id', h((req, res) => { req.db.prepare('DELETE FROM saved_filters WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id); res.json({ ok: true }); }));

// ---------- exportação CSV ----------
function csv(rows, cols) {
  const esc = v => { if (v === null || v === undefined) return ''; const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [cols.map(c => c[1]).join(';')].concat(rows.map(r => cols.map(c => esc(typeof c[0] === 'function' ? c[0](r) : r[c[0]])).join(';'))).join('\r\n');
}
app.get('/api/export/:entity', h((req, res) => {
  const e = req.params.entity; const db = req.db; const role = req.user.role;
  const allowed = { contatos: ['admin', 'comercial'], oportunidades: ['admin', 'comercial'], campanhas: ['admin', 'marketing', 'comercial'], conteudos: ['admin', 'marketing', 'comercial'], metricas: ['admin', 'marketing'], comparacao: ['admin', 'marketing', 'comercial'], tarefas: ['admin', 'marketing', 'comercial'], auditoria: ['admin'] };
  if (!allowed[e]) throw err(404, 'Exportação inválida.'); if (!allowed[e].includes(role)) throw err(403, 'Seu perfil não pode exportar estes dados.');
  const d = A.load(db); const users = new Map(auth.prepare('SELECT id, name FROM users').all().map(u => [u.id, u.name]));
  const nm = (m, id) => (id && m.get(id) ? (m.get(id).name || m.get(id).title) : '');
  let out;
  if (e === 'contatos') out = csv(d.contacts.filter(c => !c.archived || req.query.archived === '1'), [['id', 'ID'], ['name', 'Nome'], ['phone', 'Telefone'], ['email', 'E-mail'], ['company', 'Empresa'], ['city', 'Cidade'], ['kind', 'Tipo'], ['profile', 'Perfil'], ['decision_maker', 'Participa da decisão'], ['captured_at', 'Captado em'],
    [c => nm(d.srcById, A.contactAttr(c, d).source_id) || 'Não identificado', 'Primeira origem'], [c => nm(d.campById, A.contactAttr(c, d).campaign_id), 'Campanha (primeira origem)'], [c => nm(d.contById, A.contactAttr(c, d).content_id), 'Conteúdo (primeira origem)'], [c => users.get(c.owner_id) || '', 'Responsável']]);
  else if (e === 'oportunidades') out = csv(d.opps, [['id', 'ID'], [o => (d.contactById.get(o.contact_id) || {}).name, 'Contato'], [o => (d.contactById.get(o.contact_id) || {}).company, 'Empresa'], [o => nm(d.svcById, o.service_id), 'Serviço'], [o => nm(d.stageById, o.stage_id), 'Etapa'], ['status', 'Situação'], [o => users.get(o.owner_id) || '', 'Responsável'],
    ['estimated_value', 'Valor estimado'], ['qual_status', 'Qualificação'], [o => nm(d.srcById, o.source_id) || 'Não identificado', 'Origem (oportunidade)'], [o => nm(d.campById, o.campaign_id), 'Campanha'], [o => nm(d.contById, o.content_id), 'Conteúdo'], ['next_action', 'Próxima ação'], ['next_action_date', 'Prazo'],
    ['meeting_scheduled_at', 'Reunião agendada em'], ['meeting_done_at', 'Reunião realizada em'], ['proposal_sent_at', 'Proposta enviada em'], ['won_at', 'Fechado (ganho) em'], ['contract_type', 'Tipo de contrato'], ['one_time_value', 'Valor único'], ['monthly_value', 'Mensalidade'], ['contract_months', 'Meses'],
    ['lost_at', 'Perdido em'], [o => nm(d.reasonById, o.loss_reason_id), 'Motivo da perda'], ['objection', 'Objeção'], ['loss_detail', 'Detalhe da perda'], ['retake_date', 'Retomar em'], [o => L.localDate(o.created_at), 'Criada em']]);
  else if (e === 'campanhas') out = csv(campaignSummaries(db, req.query.model), [['id', 'ID'], ['name', 'Campanha'], ['channel', 'Canal'], ['status', 'Status'], ['service', 'Serviço'], ['start_date', 'Início'], ['end_date', 'Término'], ['budget_planned', 'Orçamento'], ['spend', 'Gasto'], ['budget_left', 'Saldo'],
    ['impressions', 'Impressões'], ['clicks', 'Cliques'], ['conversations', 'Conversas'], ['leads', 'Leads'], ['qualified', 'Qualificados'], ['meetings', 'Reuniões realizadas'], ['won', 'Vendas'], ['one', 'Valor único'], ['monthly', 'Mensalidades'], ['revenue', 'Receita recebida'], ['cpl', 'CPL médio atribuído'], ['cpa', 'Custo de mídia por cliente']]);
  else if (e === 'conteudos') out = csv(d.contents.map(k => Object.assign({}, k, { campaign: nm(d.campById, k.campaign_id), service: nm(d.svcById, k.service_id), link: integrations.trackedUrl(k) })), [['id', 'ID'], ['title', 'Título'], ['theme', 'Tema'], ['channel', 'Canal'], ['format', 'Formato'], ['published_at', 'Publicação'], ['service', 'Serviço'], ['hook', 'Gancho'], ['cta', 'CTA'], ['campaign', 'Campanha'], ['url', 'Link'], ['link', 'Link com UTM']]);
  else if (e === 'metricas') out = csv(d.metrics.sort((a, b) => a.date.localeCompare(b.date)), [['date', 'Data'], [m => nm(d.campById, m.campaign_id), 'Campanha'], [m => nm(d.contById, m.content_id), 'Conteúdo'], [m => nm(d.srcById, m.source_id), 'Origem'], ['spend', 'Investimento'], ['impressions', 'Impressões'], ['reach', 'Alcance'], ['clicks', 'Cliques'], ['conversations', 'Conversas'], ['origin', 'Entrada']]);
  else if (e === 'comparacao') { const r = A.compare(db, req.query); out = csv(r.rows, [['label', 'Item'], ['spend', 'Investimento'], ['clicks', 'Cliques'], ['conversations', 'Conversas'], ['leads', 'Leads'], ['qualified', 'Qualificados'], ['meetings', 'Reuniões realizadas'], ['proposals', 'Propostas'], ['won', 'Vendas'], ['one', 'Valor único'], ['monthly', 'Mensalidades'], ['cpl', 'CPL médio atribuído'], ['cpql', 'Custo por qualificado'], [r => r.sample.text, 'Amostra']]); }
  else if (e === 'tarefas') out = csv(d.tasks, [['id', 'ID'], ['title', 'Tarefa'], ['due_date', 'Prazo'], [t => users.get(t.owner_id) || '', 'Responsável'], [t => (d.contactById.get(t.contact_id) || {}).name, 'Contato'], ['done_at', 'Concluída em']]);
  else out = csv(db.prepare('SELECT * FROM audit ORDER BY at DESC').all(), [['at', 'Data/hora (UTC)'], ['user_name', 'Usuário'], ['action', 'Ação'], ['entity', 'Entidade'], ['entity_id', 'ID'], ['details', 'Detalhes']]);
  audit(req, 'exportou CSV', e);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="real4u-${e}-${L.today()}${req.mode === 'demo' ? '-DEMO' : ''}.csv"`);
  res.send(out);
}));

// ---------- auditoria e integrações ----------
app.get('/api/audit', need('admin'), h((req, res) => res.json(req.db.prepare('SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT 500').all())));
app.get('/api/integrations', h((req, res) => res.json(integrations.status(req))));

// ---------- erros e arquivos estáticos ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  const status = e.status || 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : e.message });
});

module.exports = app;

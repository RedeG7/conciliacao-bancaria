'use strict';
/* Versão hospedada no Claude: o mesmo servidor (src/server.js) roda no navegador sobre SQLite em memória.
   Os dados reais ficam no banco compartilhado do artifact (capacidade "db"), em documentos por tabela.
   O modo demonstração roda só em memória e não é salvo. */
const DB = require('./db-browser');
const { setSQL } = require('./sqlshim');

const TABLES = ['services', 'stages', 'loss_reasons', 'sources', 'ctas', 'qual_criteria', 'campaigns', 'contents', 'metrics', 'other_costs',
  'contacts', 'touchpoints', 'opportunities', 'stage_history', 'tasks', 'notes', 'proposals', 'payments', 'goals', 'saved_filters', 'link_clicks', 'audit'];
const NB = 32; // documentos (baldes) por tabela
const bucketOf = id => 'b' + (Math.abs(Math.round(Number(id))) % NB);

const R = { ready: false, store: null, user: null, uid: null, num: null, known: {}, roles: {}, inactive: {}, people: [], names: {}, logo: null, isOwner: false, canWrite: true, error: null, app: null };
window.R4U = R;

function hash53(s) {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b1;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return (h1 & 0x1fffff) * 4294967296 + h2 || 1;
}
const rowKey = r => JSON.stringify(r);

function upsertRow(db, table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]));
}
function snapshotTable(db, table) {
  const m = new Map(); for (const r of db.prepare(`SELECT * FROM ${table}`).all()) m.set(String(r.id), Object.assign({}, r)); return m;
}

// ---------- carga e sincronização ----------
async function loadTables(db) {
  for (const t of TABLES) {
    R.known[t] = new Map();
    const snap = await R.store.collection('tbl_' + t).get();
    for (const d of snap.docs) {
      const rows = (d.data() || {}).rows || {};
      for (const [id, row] of Object.entries(rows)) if (row) { upsertRow(db, t, row); R.known[t].set(id, rowKey(row)); }
    }
  }
}
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (window.S && S.mode === 'real' && !document.querySelector('.overlay')) { try { if (S.refreshPage) S.refreshPage(); refreshAlerts(); } catch (e) { /* */ } } }, 600);
}
function subscribeTables(db) {
  for (const t of TABLES) {
    R.store.collection('tbl_' + t).onSnapshot(snap => {
      let changed = false;
      for (const ch of snap.docChanges()) {
        const rows = (ch.doc.data() || {}).rows || {};
        for (const [id, row] of Object.entries(rows)) {
          const k = row ? rowKey(row) : null;
          if ((R.known[t].get(id) || null) === k) continue;
          if (row) { upsertRow(db, t, row); R.known[t].set(id, k); } else { db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(Number(id)); R.known[t].delete(id); }
          changed = true;
        }
      }
      if (changed) scheduleRefresh();
    }, () => {});
  }
}
// grava no banco compartilhado apenas as linhas que mudaram
let chain = Promise.resolve();
function persist(db) {
  const writes = new Map();
  for (const t of TABLES) {
    const now = snapshotTable(db, t); const known = R.known[t];
    for (const [id, row] of now) { const k = rowKey(row); if (known.get(id) !== k) { known.set(id, k); add(t, id, row); } }
    for (const id of [...known.keys()]) if (!now.has(id)) { known.delete(id); add(t, id, null); }
  }
  function add(t, id, row) { const key = 'tbl_' + t + '/' + bucketOf(id); if (!writes.has(key)) writes.set(key, {}); writes.get(key)[id] = row; }
  if (!writes.size) return chain;
  chain = chain.then(() => Promise.all([...writes].map(async ([path, rows]) => {
    const ref = R.store.doc(path);
    try { await ref.update({ rows }); }
    catch (e) {
      if (e && e.code === 'invalid_argument') {
        const cur = await ref.get();
        if (!cur.exists) { await ref.set({ rows }); return; }
      }
      throw e;
    }
  }))).catch(e => {
    const msg = e && e.code === 'quota_exceeded' ? 'O banco compartilhado atingiu o limite de armazenamento.' : 'Não foi possível salvar no banco compartilhado. Verifique se seu acesso permite editar (Colaborador ou superior).';
    if (window.toast) toast(msg, { err: true, ms: 8000 });
  });
  return chain;
}
// IDs únicos entre usuários simultâneos: base derivada do relógio + aleatório
function bumpSequences(db) {
  const base = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  for (const t of TABLES) {
    const r = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(t);
    if (!r) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(t, base);
    else if (r.seq < base) db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(base, t);
  }
}

// ---------- usuários (identidade do Claude) ----------
function roleOf(uid) { if (R.roles[uid]) return R.roles[uid]; return 'comercial'; }
async function rebuildUsers() {
  const auth = DB.auth;
  const uids = [...new Set(R.people.concat([R.uid]).concat(Object.keys(R.roles)))].filter(Boolean);
  try { const ps = await R.user.profiles(uids); for (const id of uids) if (ps[id] && ps[id].name) R.names[id] = ps[id].name; } catch (e) { /* */ }
  auth.exec('DELETE FROM users');
  for (const id of uids) {
    auth.prepare('INSERT INTO users (id, name, email, pass_hash, role, active, must_change, created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run(hash53(id), R.names[id] || 'Usuário', id + '@claude', 'x', roleOf(id), R.inactive[id] && id !== R.uid ? 0 : 1, new Date().toISOString());
  }
  R.uidByNum = Object.fromEntries(uids.map(id => [hash53(id), id]));
}

async function init() {
  setSQL(await window.initSqlJs()); // build asm.js: sem WebAssembly, compatível com a política de segurança do artifact
  DB.init();
  const app = require('../src/server');
  R.app = app;
  installOverrides(app);
  const claude = window.claude;
  R.store = claude ? await claude.use('db') : null;
  R.user = claude ? await claude.use('user') : null;
  R.uid = R.user ? await R.user.id() : null;
  if (!R.store || !R.uid) { R.error = 'sem_acesso'; await startSession('demo'); return; }
  R.isOwner = await R.user.isOwner();
  try { const me = await R.user.me(); if (me && me.name) R.names[R.uid] = me.name; } catch (e) { /* */ }
  // configurações compartilhadas
  const [rolesDoc, logoDoc, peopleSnap] = await Promise.all([R.store.doc('config/roles').get(), R.store.doc('config/logo').get(), R.store.collection('people').get()]);
  const rd = rolesDoc.exists ? rolesDoc.data() : {}; R.roles = Object.assign({}, rd.roles || {}); R.inactive = Object.assign({}, rd.inactive || {});
  R.logo = logoDoc.exists ? (logoDoc.data().dataUrl || null) : null;
  R.people = peopleSnap.docs.map(d => d.id);
  if (!R.people.includes(R.uid)) { try { await R.store.doc('people/' + R.uid).set({ joined: new Date().toISOString() }); R.people.push(R.uid); } catch (e) { R.canWrite = false; } }
  if (R.isOwner && R.roles[R.uid] !== 'admin') { R.roles[R.uid] = 'admin'; try { await R.store.doc('config/roles').set({ roles: R.roles, inactive: R.inactive }); } catch (e) { /* */ } }
  // dados
  const real = DB.fresh(); await loadTables(real);
  DB.setReal(real);
  if (!real.prepare('SELECT COUNT(*) AS n FROM stages').get().n) { require('../src/schema').seedLists(real); persist(real); }
  subscribeTables(real);
  R.store.doc('config/roles').onSnapshot(s => { const v = s.exists ? s.data() : {}; R.roles = Object.assign({}, v.roles || {}); R.inactive = Object.assign({}, v.inactive || {}); rebuildUsers().then(scheduleRefresh); }, () => {});
  R.store.collection('people').onSnapshot(s => { R.people = s.docs.map(d => d.id); rebuildUsers(); }, () => {});
  R.store.doc('config/logo').onSnapshot(s => { R.logo = s.exists ? (s.data().dataUrl || null) : null; }, () => {});
  await startSession('real');
}
async function startSession(mode) {
  if (!R.uid) { R.uid = 'visitante'; R.names[R.uid] = 'Visitante'; R.roles[R.uid] = 'admin'; }
  await rebuildUsers();
  R.num = hash53(R.uid);
  DB.auth.exec('DELETE FROM sessions');
  DB.auth.prepare('INSERT INTO sessions (token_hash, user_id, mode, expires_at, created_at) VALUES (?,?,?,?,?)').run('h:tok', R.num, mode, '9999-12-31T00:00:00Z', new Date().toISOString());
  if (mode === 'demo') DB.dataDb('demo');
  R.ready = true;
}

// ---------- requisições da interface ----------
async function request(method, url, body) {
  const [path, q] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(q || ''));
  const sess = DB.auth.prepare('SELECT mode FROM sessions LIMIT 1').get();
  const mode = sess ? sess.mode : 'real';
  const mutating = method !== 'GET';
  const real = mode === 'real' && R.store && R.uid !== 'visitante';
  if (mutating && real) bumpSequences(DB.dataDb('real'));
  const req = { method, path, url, query, body: body || {}, headers: { cookie: 'r4u_sid=tok', 'x-r4u': '1' }, ip: 'local' };
  const res = await R.app.handle(req);
  if (mutating && real && res.status < 400) persist(DB.dataDb('real'));
  return res;
}
R.request = request;

// ---------- rotas específicas da versão hospedada ----------
function installOverrides(app) {
  const integrations = require('../src/integrations');
  const L = require('../src/logic');
  const needAdmin = req => { const s = DB.auth.prepare('SELECT u.role FROM sessions s JOIN users u ON u.id = s.user_id').get(); if (!s || s.role !== 'admin') { const e = new Error('Somente administradores podem fazer isso.'); e.status = 403; throw e; } };
  const wrap = fn => (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
  app.prepend('POST', '/api/logout', (req, res) => res.json({ ok: true }));
  app.prepend('POST', '/api/me/password', (req, res) => res.status(400).json({ error: 'O acesso é feito pela sua conta do Claude; não há senha neste sistema.' }));
  app.prepend('POST', '/api/users', (req, res) => res.status(400).json({ error: 'Para adicionar alguém, compartilhe este sistema pelo botão Compartilhar do Claude. A pessoa aparece aqui ao abrir o link.' }));
  app.prepend('PUT', '/api/users/:id', wrap(async (req, res) => {
    needAdmin(req);
    const uid = R.uidByNum[Number(req.params.id)]; if (!uid) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (uid === R.uid && (req.body.role && req.body.role !== 'admin' || req.body.active === 0)) return res.status(400).json({ error: 'Você não pode rebaixar ou desativar o próprio acesso.' });
    if (req.body.role && ['admin', 'marketing', 'comercial'].includes(req.body.role)) R.roles[uid] = req.body.role;
    if (req.body.active !== undefined) { if (req.body.active) delete R.inactive[uid]; else R.inactive[uid] = true; }
    await R.store.doc('config/roles').set({ roles: R.roles, inactive: R.inactive });
    await rebuildUsers(); res.json({ ok: true });
  }));
  app.prepend('POST', '/api/logo', wrap(async (req, res) => {
    needAdmin(req);
    const v = String(req.body.dataUrl || '');
    if (!/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(v)) return res.status(400).json({ error: 'Envie PNG, JPG, SVG ou WEBP.' });
    if (v.length > 240000) return res.status(400).json({ error: 'Arquivo grande demais para esta versão (máx. ~170 KB). Envie um SVG ou PNG otimizado.' });
    await R.store.doc('config/logo').set({ dataUrl: v }); R.logo = v; res.json({ ok: true });
  }));
  app.prepend('DELETE', '/api/logo', wrap(async (req, res) => { needAdmin(req); await R.store.doc('config/logo').set({ dataUrl: null }); R.logo = null; res.json({ ok: true }); }));
  app.prepend('GET', '/api/integrations', (req, res) => {
    const list = integrations.status(req).map(i => {
      if (i.key === 'form') return Object.assign(i, { key: 'form_hosted', implemented: false, status: 'nao_conectado', statusLabel: 'Não disponível na versão hospedada no Claude',
        what: 'Receber formulários do site exige um servidor com endereço público. Esta versão roda dentro do Claude, sem endereço para o site enviar dados. Enquanto isso, cadastre os contatos do site manualmente ou importe o CSV exportado da ferramenta de formulário.',
        needs: ['Publicar a versão com servidor (pasta do projeto) em uma hospedagem com HTTPS.', 'Definir FORM_WEBHOOK_TOKEN nessa hospedagem.'], cost: 'Custo da hospedagem escolhida.' });
      if (i.key === 'shortlink') return Object.assign(i, { implemented: false, status: 'nao_conectado', statusLabel: 'Não disponível na versão hospedada no Claude',
        what: 'O link curto que conta cliques precisa de um servidor com endereço público. Nesta versão use o link com UTMs gerado em cada conteúdo; os cliques vêm dos relatórios das plataformas (importação CSV).',
        needs: ['Publicar a versão com servidor em um domínio próprio.'], cost: 'Custo da hospedagem escolhida.' });
      return i;
    });
    res.json(list);
  });
  // bootstrap informa se há logo
  app.prepend('GET', '/api/hosted-info', (req, res) => res.json({ logo: R.logo, error: R.error, canWrite: R.canWrite, isOwner: R.isOwner }));
  void L;
}

R.init = init;
module.exports = R;

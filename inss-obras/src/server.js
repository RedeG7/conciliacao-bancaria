'use strict';
// Simulador INSS Obras (inssobras.redeg7.com) - servidor HTTP (Express) com
// páginas renderizadas aqui mesmo (src/views.js). Login só pelo Hub (/sso, ver
// src/sso.js); o formulário público de cada escritório (/simulador/...) e o
// resultado compartilhável (/calculator/show/...) não exigem login.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, tx, nowIso, paramReader, ensureOffice, setting } = require('./db');
const sso = require('./sso');
const calc = require('./calc');
const integracoes = require('./integracoes');
const { TABELAS, UFS, VALIDAR } = require('./params');
const { avisosCertificados, situacaoProcuracao, lembretesDctf } = require('./dctf');
const { KINDS, porSlug, herdarDePredial, camposPredial, lerPredial, resultadoPredial } = require('./kinds');
const V = require('./views');
const { html, raw, brl, n2, dataBr, dataHoraBr, layout, page, contadores, tabela, select, campo } = V;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

const COOKIE = 'inssobras_sessao';
const SESSAO_DIAS = 7;
const HUB_URL = process.env.HUB_URL || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const h = fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };

function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
function setCookie(res, nome, valor, maxAgeS) {
  const seguro = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.append('Set-Cookie', `${nome}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${seguro}`);
}
// mensagem de uma tela para a próxima (após redirect)
function flash(res, msg, tipo = 'ok') { setCookie(res, 'inssobras_flash', JSON.stringify({ msg, tipo }), 30); }
const baseUrl = req => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

function telaErro(res, status, msg) {
  res.status(status).send(page('Aviso', html`<div class="centro"><div class="card estreito"><h1>Simulador INSS Obras</h1><p>${msg}</p>
    ${HUB_URL ? html`<a class="botao" href="${HUB_URL}">Voltar ao Hub</a>` : ''}</div></div>`));
}

// ---------------------------------------------------------------- login
function criarSessao(res, userId, office) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, office, expires_at) VALUES (?,?,?,?)').run(sha(token), userId, office, exp);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  setCookie(res, COOKIE, token, SESSAO_DIAS * 86400);
}

function entrar(res, p) {
  const office = p.office || (p.global && p.offices?.[0]?.id) || '';
  if (!office) return telaErro(res, 403, 'Seu usuário do Hub não tem escritório definido. Fale com o administrador.');
  const offices = p.global ? JSON.stringify(p.offices || []) : null;
  tx(() => {
    for (const o of p.global ? p.offices || [] : [{ id: office, name: p.office_name }]) ensureOffice(o.id, o.name);
    const u = db.prepare('SELECT id FROM users WHERE hub_user = ?').get(p.sub);
    if (u) {
      db.prepare('UPDATE users SET name=?, is_admin=?, is_global=?, office=?, office_name=?, offices=?, last_login=? WHERE id=?')
        .run(p.name || p.sub, p.admin ? 1 : 0, p.global ? 1 : 0, office, p.office_name || office, offices, nowIso(), u.id);
    } else {
      db.prepare('INSERT INTO users (hub_user, name, is_admin, is_global, office, office_name, offices, created_at, last_login) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(p.sub, p.name || p.sub, p.admin ? 1 : 0, p.global ? 1 : 0, office, p.office_name || office, offices, nowIso(), nowIso());
    }
  });
  const u = db.prepare('SELECT id FROM users WHERE hub_user = ?').get(p.sub);
  criarSessao(res, u.id, office);
  res.redirect('/dash');
}

app.get('/sso', h((req, res) => {
  const p = sso.verificar(req.query.t, process.env.SSO_SECRET);
  if (!p) return telaErro(res, 401, 'O link de acesso expirou ou é inválido. Abra o Simulador INSS Obras de novo pelo Hub.');
  entrar(res, p);
}));

// só para desenvolvimento local / testes (DEV_LOGIN=1): entra como super admin
app.get('/dev-login', h((req, res) => {
  if (process.env.DEV_LOGIN !== '1') return res.status(404).end();
  entrar(res, { sub: req.query.u || 'dev', name: 'Desenvolvedor', admin: true, global: !req.query.office, office: req.query.office || 'escritorio-dev', office_name: 'Escritório Dev',
    offices: [{ id: 'escritorio-dev', name: 'Escritório Dev' }, { id: 'outro', name: 'Outro Escritório' }] });
}));

app.get('/sair', h((req, res) => {
  const t = cookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  setCookie(res, COOKIE, '', 0);
  if (HUB_URL) return res.redirect(HUB_URL);
  telaErro(res, 200, 'Você saiu. Para entrar de novo, abra o Simulador INSS Obras pelo Hub.');
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- páginas públicas
const limite = new Map(); // ip -> [timestamps] (formulário público: 30 envios/hora)
function excedeuLimite(ip) {
  const agora = Date.now();
  const l = (limite.get(ip) || []).filter(t => agora - t < 3600e3);
  l.push(agora); limite.set(ip, l);
  return l.length > 30;
}

function cabecalhoPublico(o) {
  return html`<header class="topo-publico">${o.logo_url ? html`<img src="${o.logo_url}" alt="">` : html`<span class="logo">🏗️</span>`}
    <div><b>${o.display_name || o.name}</b><small>Simulação de INSS de obra</small></div></header>`;
}

// formulário público; num erro volta preenchido com o que a pessoa digitou
// (sem redirect, para não perder os dados nem acumular ?erro= no endereço)
function telaPublica(res, o, dados = {}, erro = '') {
  res.status(erro ? 422 : 200).send(page(`Simulador - ${o.display_name || o.name}`, html`<div class="publico">${cabecalhoPublico(o)}
    <form method="post" action="/simulador/obras-prediais/${o.public_token}" class="card">
      ${o.mensagem ? html`<p class="desc">${o.mensagem}</p>` : ''}${erro ? html`<div class="aviso erro">${erro}</div>` : ''}
      <h3>Seus dados</h3>
      <div class="grade">${campo('Nome *', html`<input name="nome" value="${dados.nome || ''}" required>`)}
        ${campo('E-mail *', html`<input name="email" type="email" value="${dados.email || ''}" required>`)}
        ${campo('Celular / WhatsApp *', html`<input name="telefone" value="${dados.telefone || ''}" required inputmode="tel">`)}</div>
      <h3>Dados da obra</h3>${camposPredial(dados, paramReader())}
      <input name="site" class="oculto" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="acoes"><button class="botao">Calcular</button></div>
    </form><p class="rodape">Estimativa com base na aferição indireta (IN RFB nº 2.021/2021). Não substitui a aferição oficial no SERO.</p></div>`));
}

app.get('/simulador/obras-prediais/:token', h((req, res) => {
  const o = db.prepare('SELECT * FROM offices WHERE public_token = ?').get(req.params.token);
  if (!o) return telaErro(res, 404, 'Link de simulação não encontrado.');
  telaPublica(res, o);
}));

app.post('/simulador/obras-prediais/:token', h((req, res) => {
  const o = db.prepare('SELECT * FROM offices WHERE public_token = ?').get(req.params.token);
  if (!o) return telaErro(res, 404, 'Link de simulação não encontrado.');
  const b = req.body;
  if (b.site) return res.redirect(req.path); // robô (campo oculto preenchido)
  if (excedeuLimite(req.ip)) return telaErro(res, 429, 'Muitas simulações seguidas. Tente de novo mais tarde.');
  const nome = String(b.nome || '').trim(), email = String(b.email || '').trim(), telefone = String(b.telefone || '').trim();
  const input = lerPredial(b);
  const volta = msg => telaPublica(res, o, { ...input, nome, email, telefone }, msg);
  if (!nome || !email || !telefone) return volta('Preencha nome, e-mail e celular.');
  let r;
  try { r = calc.predial(input, paramReader()); } catch (e) {
    // ao visitante não interessa onde se cadastra o parâmetro que falta
    if (e instanceof calc.CalcError) return volta(e.message.replace(/\. (Importe|Cadastre) .*$/, '. A simulação ainda não está disponível para esses dados - fale com o escritório.'));
    throw e;
  }
  const uuid = crypto.randomUUID();
  tx(() => {
    const cli = db.prepare('INSERT INTO clients (office, tipo, nome, email, telefone, origem, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(o.id, input.tipo_responsavel, nome, email, telefone, 'Simulador público', nowIso());
    const sim = db.prepare(`INSERT INTO simulations (office, client_id, kind, identifier, status, input_json, result_json, public_uuid, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(o.id, cli.lastInsertRowid, 'predial', `Simulação site - ${nome}`, 'Simulado pelo cliente', JSON.stringify(input), JSON.stringify(r), uuid, 'público', nowIso());
    db.prepare('INSERT INTO leads (office, nome, email, telefone, tipo, origem, url, simulation_id, client_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(o.id, nome, email, telefone, input.tipo_responsavel, 'Simulador público', `${baseUrl(req)}/calculator/show/${o.public_token}/${uuid}`, sim.lastInsertRowid, cli.lastInsertRowid, nowIso());
  });
  res.redirect(`/calculator/show/${o.public_token}/${uuid}`);
}));

app.get('/calculator/show/:token/:uuid', h((req, res) => {
  const o = db.prepare('SELECT * FROM offices WHERE public_token = ?').get(req.params.token);
  const s = o && db.prepare('SELECT * FROM simulations WHERE public_uuid = ? AND office = ? AND ativo = 1').get(req.params.uuid, o.id);
  if (!s) return telaErro(res, 404, 'Simulação não encontrada.');
  const k = KINDS[s.kind];
  const zap = o.whatsapp ? `https://wa.me/${o.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(`Olá! Fiz a simulação de INSS da minha obra: ${baseUrl(req)}${req.originalUrl}`)}` : '';
  res.send(page(`Resultado - ${k.titulo}`, html`<div class="publico">${cabecalhoPublico(o)}
    <h1>${k.titulo}</h1><p class="desc">${s.identifier || ''} · ${dataHoraBr(s.created_at)}</p>
    ${k.resultado(JSON.parse(s.result_json))}
    <div class="acoes nao-imprime"><button class="botao sec" onclick="print()">Imprimir / PDF</button>
      ${zap ? html`<a class="botao" href="${zap}" target="_blank" rel="noopener">Falar com o escritório no WhatsApp</a>` : ''}</div>
    <p class="rodape">Estimativa com base na aferição indireta (IN RFB nº 2.021/2021). Valores sujeitos à aferição oficial da Receita Federal (SERO).</p></div>`));
}));

// ---------------------------------------------------------------- área logada
app.use(h((req, res, next) => {
  const t = cookies(req)[COOKIE];
  const s = t && db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha(t), nowIso());
  const u = s && db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u) {
    if (HUB_URL) return res.redirect(HUB_URL);
    return telaErro(res, 401, 'Entre pelo Hub para usar o Simulador INSS Obras.');
  }
  req.user = u; req.office = s.office; req.sessionHash = s.token_hash;
  req.officeRow = db.prepare('SELECT * FROM offices WHERE id = ?').get(s.office);
  const f = cookies(req).inssobras_flash;
  if (f) { try { req.flash = JSON.parse(f); } catch (e) { /* ignora */ } setCookie(res, 'inssobras_flash', '', 0); }
  next();
}));

const exigirAdmin = req => { if (!req.user.is_admin && !req.user.is_global) throw Object.assign(new Error('Somente administradores do escritório.'), { status: 403 }); };
const exigirGlobal = req => { if (!req.user.is_global) throw Object.assign(new Error('Somente o super administrador do Hub altera os parâmetros de cálculo.'), { status: 403 }); };

app.post('/trocar-escritorio', h((req, res) => {
  const ok = req.user.is_global && JSON.parse(req.user.offices || '[]').some(o => o.id === req.body.office);
  if (ok) db.prepare('UPDATE sessions SET office = ? WHERE token_hash = ?').run(req.body.office, req.sessionHash);
  res.redirect('/dash');
}));

app.get('/', (req, res) => res.redirect('/dash'));

// contagens de hoje / mês / ano (e períodos anteriores) de uma tabela do escritório
function contagens(tabelaSql, office, extra = '', args = []) {
  const d = new Date();
  const iso = x => x.toISOString().slice(0, 10);
  const ini = {
    hoje: iso(d), ontem: iso(new Date(d.getTime() - 864e5)),
    mes: iso(new Date(d.getFullYear(), d.getMonth(), 1)), mesAnt: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)),
    ano: `${d.getFullYear()}-01-01`, anoAnt: `${d.getFullYear() - 1}-01-01`,
  };
  const q = (de, ate) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabelaSql} WHERE office = ? ${extra} AND created_at >= ? ${ate ? 'AND created_at < ?' : ''}`)
    .get(office, ...args, de, ...(ate ? [ate] : [])).n;
  return {
    hoje: q(ini.hoje), ontem: q(ini.ontem, ini.hoje), mes: q(ini.mes), mesAnt: q(ini.mesAnt, ini.mes), ano: q(ini.ano), anoAnt: q(ini.anoAnt, ini.ano),
  };
}

app.get('/dash', h((req, res) => {
  const P = paramReader();
  const sims = contagens('simulations', req.office, 'AND ativo = 1');
  const leads = contagens('leads', req.office);
  const props = contagens('proposals', req.office, 'AND ativo = 1');
  const link = `${baseUrl(req)}/simulador/obras-prediais/${req.officeRow.public_token}`;
  const pendencias = [];
  if (!P.list('vau').length) pendencias.push('Tabela VAU vazia: importe em Cadastros > Parâmetros > VAU (sem ela o simulador de obra predial não calcula).');
  if (!P.list('selic').length) pendencias.push('Tabela Selic vazia: o parcelamento só calcula com a Selic informada na tela.');
  const naoValidados = db.prepare('SELECT COUNT(*) AS n FROM params WHERE obs = ?').get(VALIDAR).n;
  if (naoValidados) pendencias.push(`${naoValidados} parâmetro(s) ainda com o valor inicial: confira com o time fiscal em Cadastros > Parâmetros.`);
  // a VAU muda todo mês: avisa quando a do mês anterior (a última publicada) ainda não entrou
  const ultimaVau = P.list('vau').map(v => v.vigencia).sort().pop();
  const d = new Date(), esperada = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 7);
  if (ultimaVau && ultimaVau < esperada) pendencias.push(`VAU desatualizada: a última importada é de ${ultimaVau}. Consulte a tabela do mês no SERO (e-CAC) e importe em Cadastros > Parâmetros > VAU.`);
  pendencias.push(...avisosCertificados(req.office), ...lembretesDctf(req.office));
  const ultimas = db.prepare(`SELECT s.*, c.nome AS cliente FROM simulations s LEFT JOIN clients c ON c.id = s.client_id
    WHERE s.office = ? AND s.ativo = 1 ORDER BY s.id DESC LIMIT 8`).all(req.office);
  res.send(layout(req, 'Dashboard', html`
    ${pendencias.length ? html`<div class="aviso alerta"><b>Atenção:</b><ul>${pendencias.map(p => html`<li>${p}</li>`)}</ul></div>` : ''}
    <div class="card"><h3>Link público do seu simulador</h3><p class="desc">Divulgue no site, Instagram ou WhatsApp: quem simular vira lead aqui.</p>
      <div class="copiar"><input readonly value="${link}" id="linkPublico"><button class="botao" data-copiar="linkPublico">Copiar</button><a class="botao sec" href="${link}" target="_blank">Abrir</a></div></div>
    <h3>Simulações</h3>${contadores(sims, 'Simulações')}
    <h3>Leads</h3>${contadores(leads, 'Leads')}
    <h3>Propostas</h3>${contadores(props, 'Propostas')}
    <h3>Últimas simulações</h3>
    ${tabela(['#', 'Tipo', 'Identificação', 'Cliente', 'Realizado em', 'Status', 'Ações'], ultimas.map(s => [s.id, KINDS[s.kind].titulo, s.identifier, s.cliente, dataHoraBr(s.created_at), s.status,
      html`<a href="/simulacoes/${s.id}">Abrir</a>`]))}
  `, { descricao: `Escritório ${req.officeRow.name}` }));
}));

// ---------------------------------------------------------------- simulações
const clientesDo = office => db.prepare('SELECT id, nome, documento FROM clients WHERE office = ? AND ativo = 1 ORDER BY nome').all(office);

// DCTF Web: obras (CNO), certificados digitais, envios e guia de envio
require('./dctf')(app, { h, flash, contagens, exigirAdmin, clientesDo });

function carregarSim(req) {
  const s = db.prepare('SELECT * FROM simulations WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
  if (!s) throw Object.assign(new Error('Simulação não encontrada.'), { status: 404 });
  return s;
}

app.get('/simuladores/:slug', h((req, res, next) => {
  const k = porSlug(req.params.slug);
  if (!k) return next();
  const rows = db.prepare(`SELECT s.*, c.nome AS cliente, c.email, c.telefone FROM simulations s LEFT JOIN clients c ON c.id = s.client_id
    WHERE s.office = ? AND s.kind = ? AND s.ativo = 1 ORDER BY s.id DESC`).all(req.office, k.kind);
  const linhas = rows.map(s => {
    const x = { ...s, i: JSON.parse(s.input_json), r: JSON.parse(s.result_json) };
    return [...k.linha(x), html`<span class="acoes-linha"><a href="/simulacoes/${s.id}">Ver</a><a href="/simulacoes/${s.id}/editar">Editar</a>
      <form method="post" action="/simulacoes/${s.id}/desativar" data-confirmar="Desativar esta simulação?"><button class="link">Desativar</button></form></span>`];
  });
  res.send(layout(req, k.titulo, html`
    ${contadores(contagens('simulations', req.office, 'AND ativo = 1 AND kind = ?', [k.kind]))}
    <div class="acoes"><a class="botao" href="/simuladores/${k.slug}/novo">+ Nova simulação</a></div>
    ${tabela([...k.colunas, 'Ações'], linhas)}`, { descricao: k.descricao, migalha: 'Simuladores' }));
}));

function telaForm(req, res, k, dados, { acao, erro, titulo }) {
  const P = paramReader();
  res.send(layout(req, titulo, html`<form method="post" action="${acao}" class="card">
    ${erro ? html`<div class="aviso erro">${erro}</div>` : ''}
    <div class="grade">
      ${campo('Identificador do registro *', html`<input name="identifier" value="${dados.identifier || ''}" required>`)}
      ${campo('Cliente', select('client_id', [['', '- sem cliente -'], ...clientesDo(req.office).map(c => [c.id, c.nome + (c.documento ? ` (${c.documento})` : '')])], dados.client_id))}
    </div>
    ${dados.base_simulation_id ? html`<input type="hidden" name="base_simulation_id" value="${dados.base_simulation_id}"><p class="desc">Dados herdados da simulação de obra predial #${dados.base_simulation_id}.</p>` : ''}
    <h3>Dados da simulação</h3>
    ${k.campos(dados, P)}
    <div class="acoes"><button class="botao">Calcular e salvar</button><a class="botao sec" href="/simuladores/${k.slug}">Cancelar</a></div>
  </form>`, { descricao: k.descricao, migalha: `Simuladores / ${k.titulo}` }));
}

app.get('/simuladores/:slug/novo', h((req, res, next) => {
  const k = porSlug(req.params.slug);
  if (!k) return next();
  let dados = { client_id: req.query.cliente || '' };
  if (req.query.base) {
    const base = db.prepare("SELECT * FROM simulations WHERE id = ? AND office = ? AND kind = 'predial'").get(Number(req.query.base), req.office);
    if (base) dados = { ...herdarDePredial(base), client_id: base.client_id, identifier: base.identifier, base_simulation_id: base.id };
  }
  telaForm(req, res, k, dados, { acao: req.originalUrl.split('?')[0], titulo: `Nova simulação - ${k.titulo}` });
}));

function salvarSim(req, res, k, existente) {
  const b = req.body;
  const input = k.ler(b);
  const dadosForm = { ...input, identifier: b.identifier, client_id: b.client_id, base_simulation_id: b.base_simulation_id };
  let r;
  try { r = k.calcular(input, paramReader()); } catch (e) {
    if (e instanceof calc.CalcError) {
      return telaForm(req, res, k, dadosForm, { acao: req.originalUrl, erro: e.message, titulo: existente ? `Editar simulação #${existente.id}` : `Nova simulação - ${k.titulo}` });
    }
    throw e;
  }
  const clientId = b.client_id && db.prepare('SELECT id FROM clients WHERE id = ? AND office = ?').get(Number(b.client_id), req.office) ? Number(b.client_id) : null;
  const baseId = b.base_simulation_id && db.prepare('SELECT id FROM simulations WHERE id = ? AND office = ?').get(Number(b.base_simulation_id), req.office) ? Number(b.base_simulation_id) : null;
  if (existente) {
    db.prepare('UPDATE simulations SET client_id=?, identifier=?, input_json=?, result_json=? WHERE id=?')
      .run(clientId, b.identifier || '', JSON.stringify(input), JSON.stringify(r), existente.id);
    flash(res, 'Simulação recalculada.');
    return res.redirect(`/simulacoes/${existente.id}`);
  }
  const ins = db.prepare(`INSERT INTO simulations (office, client_id, kind, identifier, status, input_json, result_json, base_simulation_id, public_uuid, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.office, clientId, k.kind, b.identifier || '', 'Simulado pelo Regularizador', JSON.stringify(input), JSON.stringify(r), baseId, crypto.randomUUID(), req.user.name, nowIso());
  flash(res, 'Simulação salva.');
  res.redirect(`/simulacoes/${ins.lastInsertRowid}`);
}

app.post('/simuladores/:slug/novo', h((req, res, next) => {
  const k = porSlug(req.params.slug);
  if (!k) return next();
  salvarSim(req, res, k, null);
}));

app.get('/simulacoes/:id', h((req, res) => {
  const s = carregarSim(req);
  const k = KINDS[s.kind];
  const cli = s.client_id && db.prepare('SELECT * FROM clients WHERE id = ?').get(s.client_id);
  const linkPublico = `${baseUrl(req)}/calculator/show/${req.officeRow.public_token}/${s.public_uuid}`;
  const fone = (cli?.telefone || '').replace(/\D/g, '');
  const zap = fone ? `https://wa.me/${fone.length <= 11 ? '55' + fone : fone}?text=${encodeURIComponent(`Olá ${cli.nome}! Segue a simulação do INSS da sua obra: ${linkPublico}`)}` : '';
  const outros = Object.values(KINDS).filter(x => x.kind !== 'predial');
  const propostas = db.prepare('SELECT * FROM proposals WHERE simulation_id = ? AND ativo = 1').all(s.id);
  res.send(layout(req, `${k.titulo} #${s.id}`, html`
    <div class="card info"><div><small>Identificação</small><b>${s.identifier}</b></div><div><small>Cliente</small><b>${cli?.nome || '-'}</b></div>
      <div><small>Realizado em</small><b>${dataHoraBr(s.created_at)}</b></div><div><small>Status</small><b>${s.status}</b></div>
      ${s.base_simulation_id ? html`<div><small>Origem</small><b><a href="/simulacoes/${s.base_simulation_id}">Obra predial #${s.base_simulation_id}</a></b></div>` : ''}</div>
    <div class="acoes nao-imprime">
      <a class="botao sec" href="/simulacoes/${s.id}/editar">Editar</a>
      <button class="botao sec" onclick="print()">Imprimir / PDF</button>
      <input readonly value="${linkPublico}" id="linkSim" class="oculto"><button class="botao sec" data-copiar="linkSim">Copiar link público</button>
      ${zap ? html`<a class="botao sec" target="_blank" rel="noopener" href="${zap}">WhatsApp</a>` : ''}
      <form method="post" action="/simulacoes/${s.id}/proposta"><button class="botao">Gerar proposta</button></form>
      ${s.kind === 'predial' ? html`<details class="menu-acao"><summary class="botao sec">Simular em ▾</summary><div>
        ${outros.map(x => html`<a href="/simuladores/${x.slug}/novo?base=${s.id}">${x.titulo}</a>`)}</div></details>` : ''}
    </div>
    ${k.resultado(JSON.parse(s.result_json))}
    ${propostas.length ? html`<div class="card"><h3>Propostas</h3>${propostas.map(p => html`<a href="/propostas/${p.id}">Proposta #${p.id} - ${brl(p.honorarios)} (${p.status})</a> `)}</div>` : ''}
    <p class="rodape">Estimativa com os parâmetros cadastrados (IN RFB nº 2.021/2021). Não substitui a aferição oficial no SERO.</p>`,
  { migalha: `Simuladores / ${k.titulo}` }));
}));

app.get('/simulacoes/:id/editar', h((req, res) => {
  const s = carregarSim(req);
  const k = KINDS[s.kind];
  telaForm(req, res, k, { ...JSON.parse(s.input_json), identifier: s.identifier, client_id: s.client_id, base_simulation_id: s.base_simulation_id },
    { acao: req.originalUrl, titulo: `Editar simulação #${s.id}` });
}));
app.post('/simulacoes/:id/editar', h((req, res) => { const s = carregarSim(req); salvarSim(req, res, KINDS[s.kind], s); }));

app.post('/simulacoes/:id/desativar', h((req, res) => {
  const s = carregarSim(req);
  db.prepare('UPDATE simulations SET ativo = 0 WHERE id = ?').run(s.id);
  flash(res, 'Simulação desativada.');
  res.redirect(`/simuladores/${KINDS[s.kind].slug}`);
}));

// ---------------------------------------------------------------- propostas
app.post('/simulacoes/:id/proposta', h((req, res) => {
  const s = carregarSim(req);
  const r = JSON.parse(s.result_json), i = JSON.parse(s.input_json);
  const validade = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
  const ins = db.prepare(`INSERT INTO proposals (office, simulation_id, client_id, honorarios, validade, condicoes, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(req.office, s.id, s.client_id, i.honorarios || r.honorarios || 0, validade,
    'Honorários para a regularização do INSS da obra junto à Receita Federal (CNO, SERO, DCTFWeb).', req.user.name, nowIso());
  res.redirect(`/propostas/${ins.lastInsertRowid}`);
}));

const STATUS_PROPOSTA = ['Enviada', 'Aceita', 'Recusada', 'Em negociação'];

app.get('/acompanhamento-de-obras/propostas', h((req, res) => {
  const rows = db.prepare(`SELECT p.*, c.nome AS cliente, s.kind, s.identifier FROM proposals p JOIN simulations s ON s.id = p.simulation_id
    LEFT JOIN clients c ON c.id = p.client_id WHERE p.office = ? AND p.ativo = 1 ORDER BY p.id DESC`).all(req.office);
  res.send(layout(req, 'Propostas', html`${contadores(contagens('proposals', req.office, 'AND ativo = 1'), 'Propostas')}
    ${tabela(['#', 'Cliente', 'Simulação', 'Honorários', 'Validade', 'Status', 'Ações'], rows.map(p => [p.id, p.cliente || '-',
      html`<a href="/simulacoes/${p.simulation_id}">${KINDS[p.kind].titulo} #${p.simulation_id}</a>`, brl(p.honorarios), dataBr(p.validade), p.status,
      html`<span class="acoes-linha"><a href="/propostas/${p.id}">Abrir / imprimir</a><form method="post" action="/propostas/${p.id}/desativar" data-confirmar="Desativar esta proposta?"><button class="link">Desativar</button></form></span>`]),
    'Nenhuma proposta. Gere uma a partir de uma simulação.')}`, { descricao: 'Proposta = simulação + honorários. Gere pelo botão "Gerar proposta" de uma simulação.', migalha: 'Acompanhamento de obras' }));
}));

function carregarProposta(req) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
  if (!p) throw Object.assign(new Error('Proposta não encontrada.'), { status: 404 });
  return p;
}

app.get('/propostas/:id', h((req, res) => {
  const p = carregarProposta(req);
  const s = db.prepare('SELECT * FROM simulations WHERE id = ?').get(p.simulation_id);
  const base = s.base_simulation_id && db.prepare('SELECT * FROM simulations WHERE id = ? AND office = ?').get(s.base_simulation_id, req.office);
  const cli = p.client_id && db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
  const o = req.officeRow;
  const valorParcela = p.parcelas > 0 ? (p.honorarios - p.entrada) / p.parcelas : 0;
  res.send(layout(req, `Proposta #${p.id}`, html`
    <form method="post" action="/propostas/${p.id}" class="card nao-imprime"><div class="grade">
      ${campo('Honorários (R$)', html`<input name="honorarios" value="${n2(p.honorarios)}" inputmode="decimal">`)}
      ${campo('Entrada (R$)', html`<input name="entrada" value="${n2(p.entrada)}" inputmode="decimal">`)}
      ${campo('Parcelas do saldo', html`<input name="parcelas" type="number" min="1" value="${p.parcelas}">`)}
      ${campo('Validade', html`<input name="validade" type="date" value="${p.validade || ''}">`)}
      ${campo('Status', select('status', STATUS_PROPOSTA, p.status))}
      ${campo('Condições / escopo', html`<textarea name="condicoes" rows="3">${p.condicoes || ''}</textarea>`, 'largo')}
    </div><div class="acoes"><button class="botao">Salvar</button><button type="button" class="botao sec" onclick="print()">Imprimir / PDF</button></div></form>
    <article class="card documento">
      <header>${o.logo_url ? html`<img src="${o.logo_url}" alt="" class="logo-doc">` : ''}<div><h2>${o.display_name || o.name}</h2>
        <small>${[o.email, o.whatsapp].filter(Boolean).join(' · ')}</small></div><div class="dir"><b>Proposta nº ${p.id}</b><small>${dataBr(p.created_at)}</small></div></header>
      <p><b>Cliente:</b> ${cli?.nome || '-'} ${cli?.documento ? `(${cli.documento})` : ''}</p>
      <p><b>Objeto:</b> ${p.condicoes}</p>
      ${base ? html`<h3>Obra predial (simulação #${base.id})</h3>${resultadoPredial(JSON.parse(base.result_json))}` : ''}
      <h3>${KINDS[s.kind].titulo} (simulação #${s.id})</h3>${KINDS[s.kind].resultado(JSON.parse(s.result_json))}
      <h3>Honorários</h3><table class="resumo"><tr><td>Valor total</td><td>${brl(p.honorarios)}</td></tr>
        ${p.entrada ? html`<tr><td>Entrada</td><td>${brl(p.entrada)}</td></tr>` : ''}
        <tr><td>Saldo</td><td>${p.parcelas}x de ${brl(valorParcela)}</td></tr><tr><td>Validade da proposta</td><td>${dataBr(p.validade)}</td></tr></table>
      <p class="rodape">Valores de INSS estimados pela aferição indireta (IN RFB nº 2.021/2021), sujeitos à aferição oficial da Receita Federal.</p>
      <div class="assinaturas"><div>${o.display_name || o.name}</div><div>${cli?.nome || 'Cliente'}</div></div>
    </article>`, { migalha: 'Acompanhamento de obras / Propostas' }));
}));

app.post('/propostas/:id', h((req, res) => {
  const p = carregarProposta(req);
  const b = req.body;
  db.prepare('UPDATE proposals SET honorarios=?, entrada=?, parcelas=?, validade=?, status=?, condicoes=? WHERE id=?')
    .run(calc.num(b.honorarios), calc.num(b.entrada), Math.max(1, Math.trunc(calc.num(b.parcelas)) || 1), b.validade || null,
      STATUS_PROPOSTA.includes(b.status) ? b.status : p.status, b.condicoes || '', p.id);
  flash(res, 'Proposta salva.');
  res.redirect(`/propostas/${p.id}`);
}));
app.post('/propostas/:id/desativar', h((req, res) => {
  const p = carregarProposta(req);
  db.prepare('UPDATE proposals SET ativo = 0 WHERE id = ?').run(p.id);
  flash(res, 'Proposta desativada.');
  res.redirect('/acompanhamento-de-obras/propostas');
}));

// ---------------------------------------------------------------- clientes
// Cliente = dono da obra. Para o envio eSocial/DCTFWeb ele é o empregador
// (S-1000) e dá procuração eletrônica ao procurador do escritório, cujo
// certificado A1 (DCTF Web > Certificados) transmite em nome dele.
const CAMPOS_CLIENTE = ['tipo', 'nome', 'fantasia', 'documento', 'email', 'telefone', 'origem', 'obs', 'profissao', 'nacionalidade', 'registro', 'contato',
  'telefone_fixo', 'cep', 'rua', 'numero', 'bairro', 'cidade', 'uf', 'complemento', 'possui_procuracao', 'procuracao_data_assinatura', 'procuracao_data_fim',
  'certificate_id', 's1000_inicio', 's1000_fim', 'class_trib', 'ind_opt_reg_eletron', 'ind_desoneracao', 'pis_pasep', 's1000_recibo'];
const CLASS_TRIB = [['21', '21 - Empregador doméstico ou empregador PF'], ['22', '22 - Segurado especial'], ['60', '60 - Missão diplomática'], ['70', '70 - Organismo internacional']];

function formCliente(req, c, acao, completo = false) {
  const inp = (n, attrs = '') => html`<input name="${n}" value="${c[n] ?? ''}" ${raw(attrs)}>`;
  const certs = db.prepare('SELECT id, titular, documento, validade FROM certificates WHERE office = ? AND ativo = 1 ORDER BY titular').all(req.office);
  const sp = c.id ? situacaoProcuracao(c) : null;
  return html`<form method="post" action="${acao}" class="card">
    <h3>Dados do cliente</h3><div class="grade">
    ${campo('Tipo', select('tipo', [['PF', 'Pessoa Física'], ['PJ', 'Pessoa Jurídica']], c.tipo))}
    ${campo('Nome / razão social *', inp('nome', 'required'))}
    ${campo('Nome fantasia', inp('fantasia'))}
    ${campo('CPF / CNPJ', inp('documento', 'inputmode="numeric"'))}
    ${campo('E-mail', inp('email', 'type="email"'))}
    ${campo('Celular', inp('telefone'))}
    ${campo('Origem', inp('origem', 'placeholder="Indicação, site, Instagram..."'))}
    ${completo ? html`${campo('Telefone fixo', inp('telefone_fixo'))}${campo('Profissão', inp('profissao'))}${campo('Nacionalidade', inp('nacionalidade'))}
      ${campo('Registro (RG)', inp('registro'))}${campo('Contato', inp('contato'))}` : ''}
    ${campo('Observações', html`<textarea name="obs" rows="2">${c.obs || ''}</textarea>`, 'largo')}
    </div>
    ${completo ? html`<h3>Endereço</h3><div class="grade g4">${campo('CEP', inp('cep'))}${campo('Rua', inp('rua'))}${campo('Número', inp('numero'))}${campo('Complemento', inp('complemento'))}
      ${campo('Bairro', inp('bairro'))}${campo('Cidade', inp('cidade'))}${campo('UF', select('uf', ['', ...UFS], c.uf))}</div>
    <h3>Procuração eletrônica e certificado do procurador</h3>
    <p class="desc">O cliente outorga procuração eletrônica no e-CAC ao procurador do escritório (permissões do eSocial e da DCTFWeb); o envio usa o certificado A1 do procurador. Sem procuração vigente o envio ao eSocial fica bloqueado.</p>
    ${sp ? html`<div class="aviso ${sp.ok ? 'ok' : 'alerta'}">${sp.ok ? 'Procuração vigente e certificado do procurador válido.' : `Falta: ${[!sp.proc && 'procuração informada e vigente', !sp.certOk && 'certificado do procurador válido'].filter(Boolean).join(' e ')}.`}</div>` : ''}
    <div class="grade">
      ${campo('Possui procuração eletrônica?', select('possui_procuracao', [['0', 'Não'], ['1', 'Sim']], c.possui_procuracao ? '1' : '0'))}
      ${campo('Data de assinatura', inp('procuracao_data_assinatura', 'type="date"'))}
      ${campo('Data de fim', inp('procuracao_data_fim', 'type="date"'))}
      ${campo('Certificado do procurador', select('certificate_id', [['', certs.length ? 'Selecione' : '- importe em DCTF Web > Certificados -'], ...certs.map(ce => [ce.id, `${ce.titular} (${ce.documento}, vence ${dataBr(ce.validade)})`])], c.certificate_id))}
    </div>
    <h3>Dados do empregador (S-1000)</h3><div class="grade">
      ${campo('Início de validade (mês/ano)', inp('s1000_inicio', 'type="month"'))}${campo('Término de validade', inp('s1000_fim', 'type="month"'))}
      ${campo('Classificação tributária', select('class_trib', CLASS_TRIB, c.class_trib || '21'))}
      ${campo('Registro eletrônico de empregados', select('ind_opt_reg_eletron', [['0', '0 - Não optou'], ['1', '1 - Optou']], c.ind_opt_reg_eletron || '0'))}
      ${campo('Indicativo de desoneração da folha', select('ind_desoneracao', [['0', '0 - Não aplicável'], ['1', '1 - Empresa Lei 12.546/2011']], c.ind_desoneracao || '0'))}
      ${campo('Tributação PIS/PASEP', select('pis_pasep', [['0', 'Não'], ['1', 'Sim']], c.pis_pasep ? '1' : '0'))}
      ${campo('Recibo do S-1000 (após cadastrar o empregador no eSocial)', inp('s1000_recibo'))}
    </div><p class="desc">Confira CPF e nome com o cadastro da Receita; se estiverem errados, o cliente precisa atualizar numa unidade conveniada antes do envio.</p>` : ''}
    <div class="acoes"><button class="botao">Salvar</button>${c.id && !completo ? html`<a class="botao sec" href="/clientes/${c.id}?guia=1">Completar dados do eSocial</a>` : ''}</div></form>`;
}
function lerCliente(req, b, atual = {}) {
  const v = { ...atual };
  for (const k of CAMPOS_CLIENTE) if (b[k] !== undefined) v[k] = String(b[k]).trim();
  v.tipo = v.tipo === 'PJ' ? 'PJ' : 'PF';
  v.nome = v.nome || '';
  v.possui_procuracao = v.possui_procuracao === '1' || v.possui_procuracao === 1 ? 1 : 0;
  v.pis_pasep = v.pis_pasep === '1' || v.pis_pasep === 1 ? 1 : 0;
  v.uf = UFS.includes(v.uf) ? v.uf : '';
  // só certificados do próprio escritório
  v.certificate_id = v.certificate_id && db.prepare('SELECT id FROM certificates WHERE id = ? AND office = ? AND ativo = 1').get(Number(v.certificate_id), req.office) ? Number(v.certificate_id) : null;
  return v;
}

app.get('/acompanhamento-de-obras/clientes', h((req, res) => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM simulations s WHERE s.client_id = c.id AND s.ativo = 1) AS sims
    FROM clients c WHERE c.office = ? AND c.ativo = 1 ORDER BY c.nome`).all(req.office);
  res.send(layout(req, 'Clientes', html`${contadores(contagens('clients', req.office, 'AND ativo = 1'))}
    <details class="card"><summary class="botao">+ Novo cliente</summary>${formCliente(req, {}, '/acompanhamento-de-obras/clientes')}</details>
    ${tabela(['Razão social / nome', 'Nome fantasia', 'Documento', 'Celular/telefone', 'E-mail', 'Simulações', 'Ações'], rows.map(c => [c.nome, c.fantasia, c.documento, c.telefone, c.email, c.sims,
      html`<span class="acoes-linha"><a href="/simuladores/obras-prediais/novo?cliente=${c.id}">Simular obra</a><a href="/acompanhamento-de-obras/obras?cliente=${c.id}">Cadastrar obra</a>
      <a href="/guia-de-envio/${c.id}">Guia de envio</a><a href="/clientes/${c.id}">Editar</a>
      <form method="post" action="/clientes/${c.id}/desativar" data-confirmar="Desativar este cliente?"><button class="link">Desativar</button></form></span>`]))}`,
  { descricao: 'Donos de obra (PF/PJ) atendidos pelo escritório.', migalha: 'Acompanhamento de obras' }));
}));
app.post('/acompanhamento-de-obras/clientes', h((req, res) => {
  const v = lerCliente(req, req.body);
  if (!v.nome) { flash(res, 'Informe o nome do cliente.', 'erro'); return res.redirect('/acompanhamento-de-obras/clientes'); }
  const cols = CAMPOS_CLIENTE.filter(k => v[k] !== undefined);
  db.prepare(`INSERT INTO clients (office, ${cols.join(', ')}, created_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`).run(req.office, ...cols.map(k => v[k]), nowIso());
  flash(res, 'Cliente cadastrado.');
  res.redirect('/acompanhamento-de-obras/clientes');
}));
function carregarCliente(req) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
  if (!c) throw Object.assign(new Error('Cliente não encontrado.'), { status: 404 });
  return c;
}
app.get('/clientes/:id', h((req, res) => {
  const c = carregarCliente(req);
  const completo = !!req.query.guia;
  const sims = db.prepare('SELECT * FROM simulations WHERE client_id = ? AND ativo = 1 ORDER BY id DESC').all(c.id);
  res.send(layout(req, c.nome, html`${completo ? html`<div class="acoes"><a class="botao sec" href="/guia-de-envio/${c.id}">← Voltar ao guia de envio</a></div>` : ''}
    ${formCliente(req, c, `/clientes/${c.id}${completo ? '?guia=1' : ''}`, completo)}<h3>Simulações</h3>
    ${tabela(['#', 'Tipo', 'Identificação', 'Realizado em', 'Status'], sims.map(s => [html`<a href="/simulacoes/${s.id}">${s.id}</a>`, KINDS[s.kind].titulo, s.identifier, dataHoraBr(s.created_at), s.status]))}`,
  { migalha: 'Acompanhamento de obras / Clientes' }));
}));
app.post('/clientes/:id', h((req, res) => {
  const c = carregarCliente(req);
  const v = lerCliente(req, req.body, c);
  if (!v.nome) { flash(res, 'Informe o nome do cliente.', 'erro'); return res.redirect(req.originalUrl); }
  if (v.possui_procuracao && v.procuracao_data_fim && v.procuracao_data_assinatura && v.procuracao_data_fim < v.procuracao_data_assinatura) {
    flash(res, 'A data de fim da procuração é anterior à de assinatura.', 'erro'); return res.redirect(req.originalUrl);
  }
  db.prepare(`UPDATE clients SET ${CAMPOS_CLIENTE.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...CAMPOS_CLIENTE.map(k => v[k] ?? null), c.id);
  flash(res, 'Cliente salvo.');
  res.redirect(req.query.guia ? `/guia-de-envio/${c.id}` : '/acompanhamento-de-obras/clientes');
}));
app.post('/clientes/:id/desativar', h((req, res) => {
  const c = carregarCliente(req);
  db.prepare('UPDATE clients SET ativo = 0 WHERE id = ?').run(c.id);
  flash(res, 'Cliente desativado.');
  res.redirect('/acompanhamento-de-obras/clientes');
}));

// ---------------------------------------------------------------- leads
app.get('/ferramentas-extras/leads', h((req, res) => {
  const rows = db.prepare('SELECT * FROM leads WHERE office = ? ORDER BY id DESC').all(req.office);
  res.send(layout(req, 'Leads', html`${contadores(contagens('leads', req.office), 'Leads')}
    ${tabela(['Nome', 'E-mail', 'Telefone', 'Tipo', 'Origem', 'Data', 'Ações'], rows.map(l => {
      const fone = (l.telefone || '').replace(/\D/g, '');
      return [l.nome, l.email, l.telefone, l.tipo, l.origem, dataHoraBr(l.created_at), html`<span class="acoes-linha">
        ${l.simulation_id ? html`<a href="/simulacoes/${l.simulation_id}">Simulação</a>` : ''}
        ${fone ? html`<a target="_blank" rel="noopener" href="https://wa.me/${fone.length <= 11 ? '55' + fone : fone}?text=${encodeURIComponent(`Olá ${l.nome}! Recebemos sua simulação de INSS de obra: ${l.url || ''}`)}">WhatsApp</a>` : ''}</span>`];
    }))}`, { descricao: 'Visitantes que usaram o simulador público do escritório.', migalha: 'Ferramentas extras' }));
}));

// ---------------------------------------------------------------- escritório
app.get('/cadastros/escritorio', h((req, res) => {
  const o = req.officeRow;
  const link = `${baseUrl(req)}/simulador/obras-prediais/${o.public_token}`;
  const pode = req.user.is_admin || req.user.is_global;
  res.send(layout(req, 'Escritório e link público', html`
    <div class="card"><h3>Link público</h3><div class="copiar"><input readonly value="${link}" id="lp"><button class="botao" data-copiar="lp">Copiar</button></div>
    ${pode ? html`<form method="post" action="/cadastros/escritorio/novo-link" data-confirmar="Gerar um link novo? O link atual deixa de funcionar."><button class="botao sec pequeno">Gerar link novo</button></form>` : ''}</div>
    <form method="post" class="card"><fieldset ${pode ? '' : 'disabled'}><div class="grade">
      ${campo('Nome exibido no simulador público', html`<input name="display_name" value="${o.display_name || ''}">`)}
      ${campo('WhatsApp do escritório (com DDD)', html`<input name="whatsapp" value="${o.whatsapp || ''}" placeholder="62999999999">`)}
      ${campo('E-mail', html`<input name="email" type="email" value="${o.email || ''}">`)}
      ${campo('URL do logotipo (https://...)', html`<input name="logo_url" value="${o.logo_url || ''}">`)}
      ${campo('Ambiente do eSocial (transmissão)', select('esocial_ambiente', [['producao_restrita', 'Produção restrita (homologação/testes)'], ['producao', 'Produção']], o.esocial_ambiente))}
      ${campo('Mensagem no topo do simulador público', html`<textarea name="mensagem" rows="2">${o.mensagem || ''}</textarea>`, 'largo')}
    </div><div class="acoes"><button class="botao">Salvar</button></div></fieldset>${pode ? '' : html`<p class="desc">Somente administradores do escritório alteram estes dados.</p>`}</form>`,
  { descricao: 'Marca do escritório no simulador público e na proposta.', migalha: 'Cadastros' }));
}));
app.post('/cadastros/escritorio', h((req, res) => {
  exigirAdmin(req);
  const b = req.body;
  const logo = /^https:\/\//.test(b.logo_url || '') ? b.logo_url : '';
  db.prepare('UPDATE offices SET display_name=?, whatsapp=?, email=?, logo_url=?, mensagem=?, esocial_ambiente=? WHERE id=?')
    .run(b.display_name || '', b.whatsapp || '', b.email || '', logo, b.mensagem || '', b.esocial_ambiente === 'producao' ? 'producao' : 'producao_restrita', req.office);
  flash(res, 'Dados do escritório salvos.');
  res.redirect('/cadastros/escritorio');
}));
app.post('/cadastros/escritorio/novo-link', h((req, res) => {
  exigirAdmin(req);
  db.prepare('UPDATE offices SET public_token = ? WHERE id = ?').run(crypto.randomBytes(9).toString('base64url'), req.office);
  flash(res, 'Link público trocado.');
  res.redirect('/cadastros/escritorio');
}));

// ---------------------------------------------------------------- parâmetros
app.get('/cadastros/parametros', h((req, res) => {
  const cont = Object.fromEntries(db.prepare('SELECT tabela, COUNT(*) AS n, SUM(obs = ?) AS pend FROM params GROUP BY tabela').all(VALIDAR).map(r => [r.tabela, r]));
  const aviso = setting('aviso_topo');
  res.send(layout(req, 'Parâmetros de cálculo', html`${req.user.is_global ? html`<form method="post" action="/cadastros/aviso-topo" class="card">
    ${campo('Faixa de aviso no topo de todas as telas (ex.: "eSocial instável - envios podem demorar"). Vazio = sem faixa.', html`<input name="aviso" value="${aviso}" maxlength="200">`)}
    <div class="acoes"><button class="botao sec">Salvar aviso</button></div></form>` : ''}<div class="grade-cards">${Object.entries(TABELAS).map(([k, t]) => html`
    <a class="card link-card" href="/cadastros/parametros/${k}"><b>${t.titulo}</b><small>${t.ajuda}</small>
      <span>${cont[k]?.n || 0} registro(s)${cont[k]?.pend ? html` · <em class="alerta-txt">${cont[k].pend} a validar</em>` : ''}</span></a>`)}</div>`,
  { descricao: 'Tabelas usadas pelos simuladores. Nenhum percentual fica no código: altere aqui. Somente o super administrador do Hub edita.', migalha: 'Cadastros' }));
}));

app.post('/cadastros/aviso-topo', h((req, res) => {
  exigirGlobal(req);
  db.prepare(`INSERT INTO settings (chave, valor, updated_at, updated_by) VALUES ('aviso_topo', ?, ?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(String(req.body.aviso || '').trim().slice(0, 200), nowIso(), req.user.name);
  flash(res, 'Aviso do topo salvo.');
  res.redirect('/cadastros/parametros');
}));

app.get('/cadastros/parametros/:tabela', h((req, res, next) => {
  const t = TABELAS[req.params.tabela];
  if (!t) return next();
  const rows = db.prepare('SELECT * FROM params WHERE tabela = ? ORDER BY uf, chave, vigencia DESC').all(req.params.tabela);
  const pode = !!req.user.is_global;
  const usa = c => t.colunas.includes(c);
  const chaveInput = (v = '') => (t.opcoesChave ? select('chave', [...(t.aceitaCuringa ? ['*'] : []), ...t.opcoesChave], v) : html`<input name="chave" value="${v}" required>`);
  const ufInput = (v = '') => select('uf', [...(t.aceitaCuringa ? ['*'] : []), ...UFS], v);
  const cab = [...(usa('uf') ? ['UF'] : []), t.rotuloChave, ...(usa('vigencia') ? ['Vigência'] : []), `Valor (${t.unidade})`, 'Observação', 'Atualizado'];
  const linhas = rows.map(r => {
    const cel = [...(usa('uf') ? [r.uf] : []), r.chave, ...(usa('vigencia') ? [r.vigencia] : []), n2(r.valor), r.obs === VALIDAR ? html`<em class="alerta-txt">${r.obs}</em>` : r.obs, `${dataBr(r.updated_at)} ${r.updated_by || ''}`];
    if (pode) {
      cel.push(html`<span class="acoes-linha"><form method="post" action="/cadastros/parametros/${req.params.tabela}/salvar" class="inline">
        <input type="hidden" name="id" value="${r.id}"><input name="valor" value="${r.valor}" inputmode="decimal" class="curto" aria-label="Novo valor">
        <input name="obs" placeholder="Fonte / observação" class="medio" aria-label="Observação"><button class="link">Salvar</button></form>
        <form method="post" action="/cadastros/parametros/${req.params.tabela}/excluir" data-confirmar="Excluir este registro?"><input type="hidden" name="id" value="${r.id}"><button class="link">Excluir</button></form></span>`);
    }
    return cel;
  });
  res.send(layout(req, t.titulo, html`
    ${pode ? html`<details class="card"><summary class="botao">+ Novo registro</summary>
      <form method="post" action="/cadastros/parametros/${req.params.tabela}/salvar"><div class="grade">
        ${usa('uf') ? campo('UF', ufInput()) : ''}${campo(t.rotuloChave, chaveInput())}
        ${usa('vigencia') ? campo('Vigência', html`<input name="vigencia" type="month" required>`) : ''}
        ${campo(`Valor (${t.unidade})`, html`<input name="valor" inputmode="decimal" required>`)}
        ${campo('Fonte / observação', html`<input name="obs" placeholder="Ex.: IN RFB 2.021/2021, art. ...">`)}
      </div><div class="acoes"><button class="botao">Salvar</button></div></form></details>
    ${req.params.tabela === 'selic' ? html`<form method="post" action="/cadastros/parametros/selic/banco-central" class="card acoes">
      <button class="botao">↻ Atualizar pelo Banco Central</button><span class="desc">Selic acumulada no mês (série 4390 do Banco Central, a mesma usada pela Receita). Também atualiza sozinha todo dia.</span></form>` : ''}
    ${req.params.tabela === 'vau' ? html`<details class="card" open><summary class="botao">Colar tabela do SERO</summary>
      <form method="post" action="/cadastros/parametros/vau/colar"><p class="desc">No e-CAC, abra o SERO > Consultar Tabela VAU, escolha a UF e o mês, selecione a tabela, copie (Ctrl+C) e cole aqui (Ctrl+V). O sistema reconhece cada destinação e o valor.</p>
        <div class="grade">${campo('UF *', select('uf', ['', ...UFS], req.query.uf || '', 'required'))}
          ${campo('Mês de referência *', html`<input type="month" name="vigencia" value="${req.query.vigencia || new Date().toISOString().slice(0, 7)}" required>`)}</div>
        <textarea name="texto" rows="8" placeholder="Residência unifamiliar     R$ 2.345,67&#10;Residência multifamiliar   R$ 2.123,45&#10;..." required></textarea>
        <div class="acoes"><button class="botao">Importar VAU colada</button></div></form></details>` : ''}
    ${t.importavel ? html`<details class="card"><summary class="botao sec">Importar CSV</summary>
      <form method="post" action="/cadastros/parametros/${req.params.tabela}/importar"><p class="desc">${t.ajuda}. Separador ; ou , - linhas repetidas são atualizadas.</p>
        <input type="file" accept=".csv,.txt" class="ler-arquivo" data-alvo="csv${req.params.tabela}" aria-label="Arquivo CSV">
        <textarea name="csv" id="csv${req.params.tabela}" rows="8" placeholder="${req.params.tabela === 'vau' ? 'GO;Residência unifamiliar;2026-10;1234,56' : '2026-09;0,95'}"></textarea>
        <div class="acoes"><button class="botao">Importar</button></div></form></details>` : ''}` : html`<div class="aviso">Somente o super administrador do Hub altera os parâmetros.</div>`}
    ${tabela(pode ? [...cab, 'Ações'] : cab, linhas)}`, { descricao: t.ajuda, migalha: 'Cadastros / Parâmetros' }));
}));

function gravarParam(tabela, { uf = '', chave, vigencia = '', valor, obs }, usuario) {
  db.prepare(`INSERT INTO params (tabela, uf, chave, vigencia, valor, obs, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(tabela, uf, chave, vigencia) DO UPDATE SET valor = excluded.valor, obs = excluded.obs, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(tabela, uf, chave, vigencia, valor, obs || '', nowIso(), usuario);
}

app.post('/cadastros/parametros/:tabela/salvar', h((req, res, next) => {
  const t = TABELAS[req.params.tabela];
  if (!t) return next();
  exigirGlobal(req);
  const b = req.body;
  const valor = calc.num(b.valor);
  if (b.id) {
    db.prepare('UPDATE params SET valor = ?, obs = ?, updated_at = ?, updated_by = ? WHERE id = ? AND tabela = ?')
      .run(valor, b.obs || '', nowIso(), req.user.name, Number(b.id), req.params.tabela);
  } else {
    if (!String(b.chave || '').trim()) { flash(res, `Informe ${t.rotuloChave}.`, 'erro'); return res.redirect(req.originalUrl.replace(/\/salvar$/, '')); }
    gravarParam(req.params.tabela, { uf: t.colunas.includes('uf') ? b.uf || '' : '', chave: String(b.chave).trim(), vigencia: t.colunas.includes('vigencia') ? b.vigencia || '' : '', valor, obs: b.obs }, req.user.name);
  }
  flash(res, 'Parâmetro salvo.');
  res.redirect(`/cadastros/parametros/${req.params.tabela}`);
}));

app.post('/cadastros/parametros/:tabela/excluir', h((req, res) => {
  exigirGlobal(req);
  db.prepare('DELETE FROM params WHERE id = ? AND tabela = ?').run(Number(req.body.id), req.params.tabela);
  flash(res, 'Registro excluído.');
  res.redirect(`/cadastros/parametros/${req.params.tabela}`);
}));

// CSV da VAU (uf;destinação;vigência;valor) e da Selic (mês;percentual)
function importarCsv(tabela, texto, usuario) {
  const t = TABELAS[tabela];
  const erros = [];
  let ok = 0;
  const linhas = String(texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  tx(() => {
    linhas.forEach((l, i) => {
      const c = l.split(l.includes(';') ? ';' : ',').map(x => x.trim().replace(/^"|"$/g, ''));
      const mes = s => { const m = String(s).match(/^(\d{4})-(\d{2})$/) || String(s).match(/^(\d{2})\/(\d{4})$/); return m ? (m[1].length === 4 ? `${m[1]}-${m[2]}` : `${m[2]}-${m[1]}`) : null; };
      if (tabela === 'vau') {
        const [uf, dest, vig, valor] = c;
        const v = calc.num(valor), vm = mes(vig);
        const destOk = t.opcoesChave.find(d => d.toLowerCase() === String(dest).toLowerCase());
        if (!UFS.includes(String(uf).toUpperCase()) || !destOk || !vm || !(v > 0)) { if (i || UFS.includes(String(uf).toUpperCase())) erros.push(`linha ${i + 1}: ${l}`); return; }
        gravarParam('vau', { uf: uf.toUpperCase(), chave: destOk, vigencia: vm, valor: v, obs: 'Importado (CSV)' }, usuario);
      } else {
        const [m, valor] = c;
        const vm = mes(m), v = calc.num(valor);
        if (!vm || valor === undefined || valor === '') { if (i || vm) erros.push(`linha ${i + 1}: ${l}`); return; }
        gravarParam('selic', { chave: vm, valor: v, obs: 'Importado (CSV)' }, usuario);
      }
      ok++;
    });
  });
  return { ok, erros };
}

app.post('/cadastros/parametros/selic/banco-central', h(async (req, res) => {
  exigirGlobal(req);
  try {
    const r = await integracoes.atualizarSelic({ usuario: req.user.name });
    flash(res, `Selic atualizada pelo Banco Central: ${r.gravados} mês(es), o último é ${r.ultimo || '-'}.`);
  } catch (e) {
    flash(res, `Não foi possível consultar o Banco Central agora (${e.message}). Tente de novo mais tarde ou importe o CSV.`, 'erro');
  }
  res.redirect('/cadastros/parametros/selic');
}));
app.post('/cadastros/parametros/vau/colar', h((req, res) => {
  exigirGlobal(req);
  const uf = UFS.includes(req.body.uf) ? req.body.uf : '';
  const vigencia = /^\d{4}-\d{2}$/.test(req.body.vigencia || '') ? req.body.vigencia : '';
  const volta = `/cadastros/parametros/vau?uf=${uf}&vigencia=${vigencia}`;
  if (!uf || !vigencia) { flash(res, 'Escolha a UF e o mês de referência.', 'erro'); return res.redirect(volta); }
  const itens = integracoes.importarVauColada({ uf, vigencia, texto: req.body.texto }, req.user.name);
  if (!itens.length) { flash(res, 'Nenhuma destinação com valor foi reconhecida no texto colado. Confira se copiou a tabela inteira.', 'erro'); return res.redirect(volta); }
  const faltam = TABELAS.vau.opcoesChave.filter(d => !itens.some(i => i.destinacao === d));
  flash(res, `VAU ${uf} ${vigencia}: ${itens.map(i => `${i.destinacao} ${brl(i.valor)}`).join('; ')}.${faltam.length ? ` Não encontradas: ${faltam.join(', ')}.` : ''}`, faltam.length ? 'alerta' : 'ok');
  res.redirect(volta);
}));

app.post('/cadastros/parametros/:tabela/importar', h((req, res, next) => {
  const t = TABELAS[req.params.tabela];
  if (!t || !t.importavel) return next();
  exigirGlobal(req);
  const { ok, erros } = importarCsv(req.params.tabela, req.body.csv, req.user.name);
  flash(res, `${ok} linha(s) importada(s).${erros.length ? ` Ignoradas ${erros.length}: ${erros.slice(0, 5).join(' | ')}` : ''}`, erros.length ? 'alerta' : 'ok');
  res.redirect(`/cadastros/parametros/${req.params.tabela}`);
}));

// ---------------------------------------------------------------- erros
app.use((req, res) => {
  if (req.user) return res.status(404).send(layout(req, 'Página não encontrada', html`<div class="card"><p>Essa tela não existe.</p><a class="botao" href="/dash">Ir ao Dashboard</a></div>`));
  telaErro(res, 404, 'Página não encontrada.');
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const msg = status >= 500 ? 'Erro inesperado. Tente de novo; se continuar, avise o suporte.' : err.message;
  if (req.user) return res.status(status).send(layout(req, 'Aviso', html`<div class="aviso erro">${msg}</div>`));
  telaErro(res, status, msg);
});

module.exports = app;
module.exports.importarCsv = importarCsv;

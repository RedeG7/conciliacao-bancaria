'use strict';
// RH (rh.redeg7.com) - servidor HTTP (Express) com páginas renderizadas aqui
// mesmo (src/views.js). Login só pelo Hub (/sso, ver src/sso.js). Sem login, só a
// resposta anônima de pesquisa (/pesquisa/:token) e o questionário de perfil
// comportamental (/perfil/:token e /perfil-aberto/:token).
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const R = require('./db');
const { db, tx, nowIso, ensureOffice } = R;
const sso = require('./sso');
const { KINDS, porSlug, HISTORICO, MESES, MODELOS_PESQUISA } = require('./modelos');
const { PAPEIS, ve, pode } = require('./acesso');
const { um, contexto, lerForm, mudancas, colunas, ordenar, formulario, csv, exportar, numero, data, valor } = require('./crud');
const { alertas, ANTECEDENCIA_PADRAO } = require('./alertas');
const M = require('./metricas');
const imp = require('./importar');
const perfilRotas = require('./rotas_comportamental');
const { hoje, addMeses } = require('./datas');
const V = require('./views');
const { html, raw, brl, n2, dataBr, dataHoraBr, layout, page, tabela, select, campo, cartao, barras } = V;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.use(express.urlencoded({ extended: false, limit: '4mb', parameterLimit: 5000 }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

const COOKIE = 'rh_sessao';
const SESSAO_DIAS = 7;
const HUB_URL = process.env.HUB_URL || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const h = fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };
const falha = (status, message) => Object.assign(new Error(message), { status });
const baseUrl = req => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) { try { o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch (e) { /* cookie malformado */ } }
  });
  return o;
}
function setCookie(res, nome, valorCookie, maxAgeS) {
  const seguro = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.append('Set-Cookie', `${nome}=${encodeURIComponent(valorCookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${seguro}`);
}
const flash = (res, msg, tipo = 'ok') => setCookie(res, 'rh_flash', JSON.stringify({ msg, tipo }), 30);

function telaErro(res, status, msg) {
  res.status(status).send(page('Aviso', html`<div class="centro"><div class="card estreito"><h1>RH</h1><p>${msg}</p>
    ${HUB_URL ? html`<a class="botao" href="${HUB_URL}">Voltar ao Hub</a>` : ''}</div></div>`));
}

// ---------------------------------------------------------------- login
function entrar(res, p) {
  const office = p.office || (p.global && p.offices?.[0]?.id) || '';
  if (!office) return telaErro(res, 403, 'Seu usuário do Hub não tem escritório definido. Fale com o administrador.');
  const offices = p.global ? JSON.stringify(p.offices || []) : null;
  const userId = tx(() => {
    for (const o of p.global ? p.offices || [] : [{ id: office, name: p.office_name }]) ensureOffice(o.id, o.name);
    const u = db.prepare('SELECT id FROM users WHERE hub_user = ?').get(p.sub);
    if (u) {
      db.prepare('UPDATE users SET name=?, is_admin=?, is_global=?, office=?, office_name=?, offices=?, last_login=? WHERE id=?')
        .run(p.name || p.sub, p.admin ? 1 : 0, p.global ? 1 : 0, office, p.office_name || office, offices, nowIso(), u.id);
      return u.id;
    }
    return Number(db.prepare('INSERT INTO users (hub_user, name, is_admin, is_global, office, office_name, offices, created_at, last_login) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(p.sub, p.name || p.sub, p.admin ? 1 : 0, p.global ? 1 : 0, office, p.office_name || office, offices, nowIso(), nowIso()).lastInsertRowid);
  });
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, office, expires_at) VALUES (?,?,?,?)').run(sha(token), userId, office, new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  setCookie(res, COOKIE, token, SESSAO_DIAS * 86400);
  res.redirect('/dash');
}

app.get('/sso', h((req, res) => {
  const p = sso.verificar(req.query.t, process.env.SSO_SECRET);
  if (!p) return telaErro(res, 401, 'O link de acesso expirou ou é inválido. Abra o RH de novo pelo Hub.');
  entrar(res, p);
}));

// só para desenvolvimento local / testes (DEV_LOGIN=1)
app.get('/dev-login', h((req, res) => {
  if (process.env.DEV_LOGIN !== '1') return res.status(404).end();
  entrar(res, { sub: req.query.u || 'dev', name: req.query.u || 'Desenvolvedor', admin: req.query.admin !== '0', global: !req.query.office, office: req.query.office || 'escritorio-dev', office_name: 'Escritório Dev',
    offices: [{ id: 'escritorio-dev', name: 'Escritório Dev' }, { id: 'outro', name: 'Outro Escritório' }] });
}));

app.get('/sair', h((req, res) => {
  const t = cookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  setCookie(res, COOKIE, '', 0);
  if (HUB_URL) return res.redirect(HUB_URL);
  telaErro(res, 200, 'Você saiu. Para entrar de novo, abra o RH pelo Hub.');
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- pesquisa pública
const limite = new Map(); // ip -> [timestamps] (60 envios/hora), só em memória
function excedeuLimite(ip) {
  const agora = Date.now();
  const l = (limite.get(ip) || []).filter(t => agora - t < 3600e3);
  l.push(agora); limite.set(ip, l);
  if (limite.size > 5000) limite.clear();
  return l.length > 60;
}
const perguntasDe = p => String(p.perguntas || '').split('\n').map(l => l.trim()).filter(Boolean);
function pesquisaPublica(token) {
  const r = db.prepare("SELECT * FROM registros WHERE kind = 'pesquisa' AND ativo = 1 AND json_extract(dados, '$.token') = ?").get(String(token));
  return r ? { ...JSON.parse(r.dados), id: r.id, office: r.office } : null;
}
function telaPesquisa(res, p, msg, status = 200) {
  const corpo = msg ? html`<div class="card"><p>${msg}</p></div>` : html`<form method="post" class="card">
    ${perguntasDe(p).map((q, i) => html`<div class="pergunta"><p><b>${i + 1}. ${q}</b></p><div class="escala">
      ${Array.from({ length: 11 }, (_, n) => html`<label><input type="radio" name="q${i}" value="${n}" required>${n}</label>`)}</div></div>`)}
    ${campo('Comentário (opcional)', html`<textarea name="comentario" rows="3" maxlength="2000"></textarea>`)}
    <input name="site" class="oculto" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="acoes"><button class="botao">Enviar resposta</button></div></form>`;
  res.status(status).send(page(p.titulo, html`<div class="publico"><header class="topo-publico"><span class="logo">📋</span><div><b>${p.titulo}</b><small>Resposta anônima: seu nome não é registrado.</small></div></header>${corpo}</div>`));
}
const aberta = p => p.status === 'Aberta' && (!p.disponivel_em || p.disponivel_em <= hoje());

app.get('/pesquisa/:token', h((req, res) => {
  const p = pesquisaPublica(req.params.token);
  if (!p) return telaErro(res, 404, 'Pesquisa não encontrada.');
  if (!aberta(p)) return telaPesquisa(res, p, 'Esta pesquisa não está aberta para respostas.');
  if (cookies(req)[`rh_resp_${p.id}`]) return telaPesquisa(res, p, 'Sua resposta já foi registrada. Obrigado!');
  telaPesquisa(res, p);
}));
app.post('/pesquisa/:token', h((req, res) => {
  const p = pesquisaPublica(req.params.token);
  if (!p) return telaErro(res, 404, 'Pesquisa não encontrada.');
  if (!aberta(p)) return telaPesquisa(res, p, 'Esta pesquisa não está aberta para respostas.');
  if (req.body.site) return res.redirect(req.path); // robô (campo oculto preenchido)
  if (excedeuLimite(req.ip)) return telaPesquisa(res, p, 'Muitas respostas seguidas. Tente de novo mais tarde.', 429);
  if (cookies(req)[`rh_resp_${p.id}`]) return telaPesquisa(res, p, 'Sua resposta já foi registrada. Obrigado!');
  const notas = perguntasDe(p).map((_, i) => Number(um(req.body[`q${i}`]) ?? NaN));
  if (notas.some(n => !Number.isInteger(n) || n < 0 || n > 10)) return telaPesquisa(res, p, 'Responda todas as perguntas com uma nota de 0 a 10.', 422);
  // só o dia, sem hora: a hora exata ajudaria a identificar quem respondeu
  db.prepare('INSERT INTO respostas (office, pesquisa_id, dados, criado_em) VALUES (?,?,?,?)')
    .run(p.office, p.id, JSON.stringify({ notas, comentario: String(um(req.body.comentario) || '').slice(0, 2000).trim() }), hoje());
  setCookie(res, `rh_resp_${p.id}`, '1', 90 * 86400);
  telaPesquisa(res, p, 'Resposta registrada. Obrigado por participar!');
}));

perfilRotas.publicas(app, { h, excedeuLimite, telaErro });

// ---------------------------------------------------------------- sessão
app.use(h((req, res, next) => {
  const t = cookies(req)[COOKIE];
  const s = t && db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha(t), nowIso());
  if (!s) return telaErro(res, 401, 'Sua sessão terminou. Abra o RH pelo card no Hub.');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u) return telaErro(res, 401, 'Sua sessão terminou. Abra o RH pelo card no Hub.');
  req.user = u; req.office = s.office; req.sessionHash = s.token_hash;
  req.officeRow = db.prepare('SELECT * FROM offices WHERE id = ?').get(s.office);
  const p = db.prepare('SELECT papel FROM papeis WHERE office = ? AND hub_user = ?').get(s.office, u.hub_user);
  req.papel = u.is_admin || u.is_global ? 'admin' : p && PAPEIS[p.papel] ? p.papel : 'leitura';
  req.c = contexto(req.office, req.papel);
  const f = cookies(req).rh_flash;
  if (f) { try { req.flash = JSON.parse(f); } catch (e) { /* ignora */ } setCookie(res, 'rh_flash', '', 0); }
  res.set('Cache-Control', 'no-store'); // páginas com dados pessoais não ficam no cache
  next();
}));

const exige = acao => (req, res, next) => (pode(req.papel, acao) ? next() : next(falha(403, 'Seu papel não permite esta ação.')));
const auditar = (req, ...a) => R.auditar(req.office, req.user.name, ...a);

app.post('/trocar-escritorio', h((req, res) => {
  const ok = req.user.is_global && JSON.parse(req.user.offices || '[]').some(o => o.id === req.body.office);
  if (ok) db.prepare('UPDATE sessions SET office = ? WHERE token_hash = ?').run(req.body.office, req.sessionHash);
  res.redirect('/dash');
}));

app.get('/', (req, res) => res.redirect('/dash'));

// ---------------------------------------------------------------- painel
function dadosAlertas(req) {
  return { colaboradores: R.listar(req.office, 'colaborador'), ferias: R.listar(req.office, 'ferias'), pdis: R.listar(req.office, 'pdi'),
    ciclos: R.listar(req.office, 'ciclo'), treinamentos: R.listar(req.office, 'treinamento'), participacoes: R.listar(req.office, 'participacao'), saude: ve(req.papel, 'saude') ? R.listar(req.office, 'saude') : null };
}

app.get('/dash', h((req, res) => {
  const d = dadosAlertas(req), dia = hoje();
  const q = M.resumoQuadro(d.colaboradores, dia);
  const dsl = M.resumoDesligamentos(R.listar(req.office, 'desligamento'), d.colaboradores, dia);
  const avisos = alertas(d, R.config(req.office, 'alertas', ANTECEDENCIA_PADRAO), dia);
  const porDep = M.contar(q.ativos, c => req.c.nome('departamento', c.departamento_id));
  res.send(layout(req, 'Painel', html`
    <div class="cards4">
      ${cartao('Colaboradores ativos', q.ativos.length)}${cartao('Em experiência', q.emExperiencia)}
      ${cartao('Bloqueados', q.bloqueados)}${cartao('Inativos', q.inativos)}
    </div>
    <div class="grade-2">
      <div class="card"><h3 class="primeiro">Alertas</h3>${avisos.length ? html`<ul class="alertas">${avisos.slice(0, 15).map(a => html`<li><span><span class="selo ${a.vencido ? 'vencido' : 'alerta'}">${a.tipo}</span> <a href="${a.link}">${a.texto}</a></span><time>${dataBr(a.data)}</time></li>`)}</ul>
        ${avisos.length > 15 ? html`<p class="desc pequeno">E mais ${avisos.length - 15}.</p>` : ''}` : html`<p class="desc">Nada para os próximos dias.</p>`}</div>
      <div>
        <div class="card"><h3 class="primeiro">Desligamentos nos últimos 12 meses</h3><div class="info">
          <div><small>Total</small><b>${dsl.total}</b></div><div><small>Com menos de 1 ano de casa</small><b>${dsl.menosDeUmAno}</b></div>
          <div><small>Rotatividade</small><b>${n2(dsl.taxa)}%</b></div></div><p><a href="/metricas/desligamentos">Ver métricas</a></p></div>
        <div class="card"><h3 class="primeiro">Ativos por departamento</h3>${barras(porDep, 'Nenhum colaborador ativo. Comece por Importar CSV em Colaboradores ou cadastre o primeiro.')}</div>
      </div>
    </div>`, { descricao: req.officeRow.name }));
}));

app.get('/aniversariantes', h((req, res) => {
  const mes = Math.min(12, Math.max(1, Number(req.query.mes) || Number(hoje().slice(5, 7))));
  const lista = R.listar(req.office, 'colaborador').filter(c => c.situacao !== 'Inativo' && c.nascimento && Number(c.nascimento.slice(5, 7)) === mes)
    .sort((a, b) => a.nascimento.slice(8).localeCompare(b.nascimento.slice(8)));
  res.send(layout(req, 'Aniversariantes', html`<form class="acoes" method="get">${select('mes', MESES, mes, 'class="medio" onchange="this.form.submit()" aria-label="Mês"')}</form>
    ${tabela(['Dia', 'Nome', 'Departamento'], lista.map(c => [c.nascimento.slice(8), html`<a href="/cad/colaboradores/${c.id}/ficha">${c.nome}</a>`, req.c.nome('departamento', c.departamento_id)]), 'Ninguém faz aniversário neste mês.')}`));
}));

// ---------------------------------------------------------------- cadastros
function carregarKind(req) {
  const k = porSlug(req.params.slug);
  if (!k || !ve(req.papel, k.cl)) throw falha(404, 'Tela não encontrada.');
  return k;
}
function carregarRegistro(req, k) {
  const r = R.obter(req.office, k.kind, req.params.id);
  if (!r) throw falha(404, 'Registro não encontrado.');
  return r;
}
const idFicha = (req, body = req.body) => { const n = Number(um(body.ficha)); return Number.isInteger(n) && n > 0 ? n : 0; };
const destino = (k, ficha) => (ficha ? `/cad/colaboradores/${ficha}/ficha` : k.ficha ? null : `/cad/${k.slug}`);

function telaLista(req, res, k) {
  const c = req.c, cols = colunas(k, c);
  let linhas = ordenar(k, c.listar(k.kind));
  let abas = '';
  if (k.abas) {
    const ativa = k.abas.valores.includes(req.query.aba) ? req.query.aba : k.abas.padrao || k.abas.valores[0];
    abas = html`<div class="abas">${k.abas.valores.map(v => html`<a href="?aba=${encodeURIComponent(v)}" class="${v === ativa ? 'ativo' : ''}">${v}<span>${linhas.filter(r => r[k.abas.campo] === v).length}</span></a>`)}
      ${k.abaExtra ? html`<a href="${k.abaExtra.href}">${k.abaExtra.rotulo}</a>` : ''}</div>`;
    linhas = linhas.filter(r => r[k.abas.campo] === ativa);
  }
  let resumo = '';
  if (k.resumo) {
    const r = c.listar(k.kind).filter(x => !x.data || x.data >= addMeses(hoje(), -12));
    resumo = html`<details class="card"><summary><b>Análise dos últimos 12 meses</b></summary><div class="grade-2">${k.resumo.map(n => {
      const f = k.campos.find(x => x.n === n);
      return html`<div><h3 class="primeiro">${f.r}</h3>${barras(M.contar(r, x => x[n]))}</div>`;
    })}</div></details>`;
  }
  const editar = pode(req.papel, 'edita'), apagar = pode(req.papel, 'apaga');
  const corpo = linhas.map(r => [
    ...cols.map((col, i) => (i === 0 ? html`<a href="/cad/${k.slug}/${r.id}${k.ficha ? '/ficha' : ''}">${col.texto(r) || 'abrir'}</a>` : col.texto(r))),
    html`<span class="acoes-linha">${(k.acoes ? k.acoes(r) : []).map(([href, t]) => html`<a href="${href}">${t}</a>`)}
      ${editar && !k.ficha ? html`<a href="/cad/${k.slug}/${r.id}">Editar</a>` : ''}${apagar ? html`<form method="post" action="/cad/${k.slug}/${r.id}/apagar" data-confirmar="Apagar este registro?"><button class="link">Apagar</button></form>` : ''}</span>`,
  ]);
  res.send(layout(req, k.titulo, html`${resumo}${abas}
    <div class="acoes">${editar && !k.novoBloqueado ? html`<a class="botao" href="${k.novoHref || `/cad/${k.slug}/novo`}">Adicionar</a>` : ''}
      ${(k.acoesLista || []).map(([href, t]) => html`<a class="botao sec" href="${href}">${t}</a>`)}
      ${editar && !k.novoBloqueado ? html`<a class="botao sec" href="/cad/${k.slug}/importar">Importar CSV</a>` : ''}
      <a class="botao sec" href="/cad/${k.slug}/exportar">Exportar CSV</a></div>
    ${tabela([...cols.map(x => x.rotulo), 'Ações'], corpo)}`, { descricao: k.desc }));
}

function telaForm(req, res, k, { dados, atual, erros = [], ficha = 0 }) {
  const somenteLeitura = !pode(req.papel, 'edita');
  res.status(erros.length ? 422 : 200).send(layout(req, atual ? (somenteLeitura ? `Ver ${k.singular}` : `Editar ${k.singular}`) : `Novo cadastro: ${k.singular}`,
    formulario(k, dados, req.c, { acao: atual ? `/cad/${k.slug}/${atual.id}` : `/cad/${k.slug}/novo`, erros, somenteLeitura, novo: !atual, ficha }), { migalha: k.titulo }));
}

function salvar(req, res, k, atual) {
  const body = req.body, ficha = idFicha(req);
  const alvos = k.multi && !atual ? [].concat(body[k.multi] || []).filter(Boolean) : [null];
  const volta = erros => telaForm(req, res, k, { dados: { ...(atual ? R.soDados(atual) : {}), ...body }, atual, erros, ficha });
  if (k.multi && !atual && !alvos.length) return volta([`Selecione ao menos um: ${k.campos.find(f => f.n === k.multi).r}.`]);
  const lidos = alvos.map(a => lerForm(k, a === null ? body : { ...body, [k.multi]: a }, req.c, atual));
  const erros = [...new Set(lidos.flatMap(l => l.erros))];
  if (erros.length) return volta(erros);
  const novoId = tx(() => {
    let id = atual?.id;
    for (const { dados } of lidos) {
      if (atual) {
        R.atualizar(req.office, k.kind, atual.id, dados);
        auditar(req, 'Editou', k.kind, atual.id, mudancas(k, atual, dados));
      } else {
        id = R.criar(req.office, k.kind, dados, req.user.name);
        auditar(req, 'Criou', k.kind, id);
      }
    }
    return id;
  });
  flash(res, 'Salvo.');
  res.redirect(destino(k, ficha) || `/cad/colaboradores/${novoId}/ficha`);
}

app.get('/cad/:slug', h((req, res) => telaLista(req, res, carregarKind(req))));
app.get('/cad/:slug/exportar', h((req, res) => {
  const k = carregarKind(req);
  auditar(req, 'Exportou', k.kind);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${k.slug}.csv"` }).send(exportar(k, req.c));
}));
function carregarImportavel(req) {
  const k = carregarKind(req);
  if (k.novoBloqueado) throw falha(404, 'Este cadastro não aceita importação.');
  return k;
}
app.get('/cad/:slug/importar', exige('edita'), h((req, res) => {
  const k = carregarImportavel(req), aviso = k.kind === 'colaborador'
    ? 'CPF já cadastrado atualiza só as colunas da planilha. Departamento, cargo, filial e unidade novos são criados pelo nome.'
    : 'Aceita o arquivo de Exportar CSV. Registro já existente é atualizado, e linha repetida não duplica; os demais viram cadastro novo. Pessoas e outros cadastros citados precisam já existir, pelo nome.';
  res.send(layout(req, `Importar: ${k.titulo}`, html`<form method="post" class="card">
    ${campo('Arquivo CSV', html`<input type="file" accept=".csv,text/csv" class="ler-arquivo" data-alvo="csv">`)}
    ${campo('Conteúdo', html`<textarea id="csv" name="csv" rows="10" required></textarea>`)}
    <div class="acoes"><button class="botao">Importar</button><a class="botao sec" href="/cad/${k.slug}/importar/modelo">Baixar modelo</a><a class="botao sec" href="/cad/${k.slug}">Voltar</a></div></form>`, { migalha: k.titulo, descricao: aviso }));
}));
app.get('/cad/:slug/importar/modelo', exige('edita'), h((req, res) => {
  const k = carregarImportavel(req);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="modelo-${k.slug}.csv"` }).send(imp.modelo(k, req.c));
}));
app.post('/cad/:slug/importar', exige('edita'), h((req, res) => {
  const k = carregarImportavel(req);
  const r = imp.importar(String(um(req.body.csv) || ''), req.c, req.user.name, k);
  auditar(req, 'Importou', k.kind, null, `${r.criados} novos, ${r.atualizados} atualizados, ${r.erros.length} erros`);
  res.send(layout(req, 'Importação concluída', html`<div class="cards4">${cartao('Novos', r.criados)}${cartao('Atualizados', r.atualizados)}${cartao('Com erro', r.erros.length)}</div>
    ${r.erros.length ? html`<div class="aviso erro"><ul>${r.erros.slice(0, 100).map(e => html`<li>${e}</li>`)}</ul></div>` : ''}
    ${r.ignoradas.length ? html`<div class="aviso alerta">Colunas não reconhecidas (ignoradas): ${r.ignoradas.join(', ')}</div>` : ''}
    <div class="acoes"><a class="botao" href="/cad/${k.slug}">Ver ${k.titulo.toLowerCase()}</a><a class="botao sec" href="/cad/${k.slug}/importar">Importar outra</a></div>`, { migalha: k.titulo }));
}));
app.get('/cad/:slug/novo', exige('edita'), h((req, res) => {
  const k = carregarKind(req);
  if (k.novoBloqueado) throw falha(404, 'Tela não encontrada.');
  const dados = Object.fromEntries(k.campos.filter(f => req.query[f.n] !== undefined).map(f => [f.n, req.query[f.n]]));
  if (k.aoAbrirNovo) k.aoAbrirNovo(dados);
  telaForm(req, res, k, { dados, ficha: idFicha(req, req.query) });
}));
app.post('/cad/:slug/novo', exige('edita'), h((req, res) => {
  const k = carregarKind(req);
  if (k.novoBloqueado) throw falha(404, 'Tela não encontrada.');
  salvar(req, res, k, null);
}));
app.get('/cad/:slug/:id(\\d+)', h((req, res) => {
  const k = carregarKind(req), r = carregarRegistro(req, k);
  telaForm(req, res, k, { dados: R.soDados(r), atual: r, ficha: idFicha(req, req.query) });
}));
app.post('/cad/:slug/:id(\\d+)', exige('edita'), h((req, res) => {
  const k = carregarKind(req);
  salvar(req, res, k, carregarRegistro(req, k));
}));
app.post('/cad/:slug/:id(\\d+)/apagar', exige('apaga'), h((req, res) => {
  const k = carregarKind(req), r = carregarRegistro(req, k);
  tx(() => { R.apagar(req.office, k.kind, r.id); auditar(req, 'Apagou', k.kind, r.id); });
  flash(res, 'Registro apagado.');
  res.redirect(`/cad/${k.slug}`);
}));

// ---------------------------------------------------------------- ficha do colaborador
const carregarColaborador = req => { const r = R.obter(req.office, 'colaborador', req.params.id); if (!r) throw falha(404, 'Colaborador não encontrado.'); return r; };

app.get('/cad/colaboradores/:id(\\d+)/ficha', h((req, res) => {
  const c = carregarColaborador(req), ctx = req.c, editar = pode(req.papel, 'edita');
  const k = KINDS.colaborador;
  const dados = k.campos.filter(f => !f.interno && ve(req.papel, f.cl) && f.t !== 'longo' && c[f.n] != null && c[f.n] !== '');
  const abas = HISTORICO.map(n => KINDS[n]).filter(x => ve(req.papel, x.cl));
  const painelKind = x => {
    const cols = colunas(x, ctx).filter(col => col.rotulo !== 'Colaborador');
    const linhas = R.doColaborador(req.office, x.kind, c.id);
    return html`<div class="acoes">${editar && !x.novoBloqueado ? html`<a class="botao pequeno" href="/cad/${x.slug}/novo?colaborador_id=${c.id}&ficha=${c.id}">Adicionar</a>` : ''}</div>
      ${tabela([...cols.map(col => col.rotulo), 'Abrir'], linhas.map(r => [...cols.map(col => col.texto(r)), html`<a href="/cad/${x.slug}/${r.id}?ficha=${c.id}">Abrir</a>`]))}`;
  };
  const feitos = new Set(c.checklist_feitos || []);
  const topicos = R.listar(req.office, 'checklist');
  const etapa = c.situacao === 'Inativo' ? 'Demissão' : 'Contratação';
  const lista = topicos.filter(t => t.etapa === etapa);
  const checklist = html`<form method="post" action="/cad/colaboradores/${c.id}/checklist" class="card"><h3 class="primeiro">${etapa}</h3>
    ${lista.length ? html`<div class="passos">${lista.map(t => html`<label class="passo ${feitos.has(t.id) ? 'feito' : ''}"><input type="checkbox" name="feito" value="${t.id}" ${feitos.has(t.id) ? 'checked' : ''} ${editar ? '' : raw('disabled')}>${t.titulo}</label>`)}</div>
    ${editar ? html`<div class="acoes"><button class="botao">Salvar checklist</button></div>` : ''}` : html`<p class="desc">Nenhum tópico. Cadastre em Pessoas &gt; Checklists.</p>`}</form>`;
  const acoes = editar ? html`<div class="acoes nao-imprime">
    <a class="botao" href="/cad/colaboradores/${c.id}">Editar</a>
    ${c.situacao === 'Inativo' ? html`<form method="post" action="/cad/colaboradores/${c.id}/reativar" data-confirmar="Reativar (recontratar) este colaborador?"><button class="botao sec">Recontratar</button></form>` : html`
      <details class="menu-acao"><summary class="botao sec">Desligar</summary><div><form method="post" action="/cad/colaboradores/${c.id}/desligar" data-confirmar="Confirmar o desligamento?">
        ${campo('Data *', html`<input type="date" name="data" value="${hoje()}" required>`)}
        ${campo('Tipo *', select('tipo', KINDS.desligamento.campos.find(f => f.n === 'tipo').op, '', 'required'))}
        ${campo('Motivo', select('motivo_id', [['', '- selecione -'], ...ctx.listar('motivo_demissao').map(m => [m.id, m.nome])], ''))}
        ${ve(req.papel, 'salario') ? campo('Valor da rescisão', html`<input name="valor_rescisao" inputmode="decimal">`) : ''}
        ${campo('Observação', html`<textarea name="obs" rows="2"></textarea>`)}
        <div class="acoes"><button class="botao">Confirmar desligamento</button></div></form></div></details>
      <form method="post" action="/cad/colaboradores/${c.id}/bloquear"><button class="botao sec">${c.situacao === 'Bloqueado' ? 'Desbloquear' : 'Bloquear'}</button></form>`}
    <button type="button" class="botao sec" onclick="window.print()">Imprimir</button></div>` : '';
  res.send(layout(req, c.nome_social || c.nome, html`${acoes}
    <div class="abas-form"><button type="button" data-aba="dados" class="ativo">Dados</button>
      ${abas.map(x => html`<button type="button" data-aba="${x.kind}">${x.titulo}</button>`)}<button type="button" data-aba="checklist">Checklist</button></div>
    <div data-painel="dados"><div class="card"><table class="resumo largo"><tbody>${dados.map(f => html`<tr><td>${f.r}</td><td>${valor(f, c[f.n], ctx)}</td></tr>`)}</tbody></table>
      ${c.observacoes ? html`<p>${c.observacoes}</p>` : ''}</div></div>
    ${abas.map(x => html`<div data-painel="${x.kind}" hidden>${painelKind(x)}</div>`)}
    <div data-painel="checklist" hidden>${checklist}</div>`,
  { migalha: 'Colaboradores', descricao: [ctx.nome('cargo', c.cargo_id), ctx.nome('departamento', c.departamento_id), c.situacao, `banco de horas: ${ctx.saldoBanco(c.id)}`].filter(Boolean).join(' · ') }));
}));

const gravarColaborador = (req, c, mudar) => R.atualizar(req.office, 'colaborador', c.id, { ...R.soDados(c), ...mudar });

app.post('/cad/colaboradores/:id(\\d+)/checklist', exige('edita'), h((req, res) => {
  const c = carregarColaborador(req);
  const validos = new Set(R.listar(req.office, 'checklist').map(t => t.id));
  gravarColaborador(req, c, { checklist_feitos: [].concat(req.body.feito || []).map(Number).filter(n => validos.has(n)) });
  flash(res, 'Checklist salvo.');
  res.redirect(`/cad/colaboradores/${c.id}/ficha#checklist`);
}));
app.post('/cad/colaboradores/:id(\\d+)/bloquear', exige('edita'), h((req, res) => {
  const c = carregarColaborador(req);
  if (c.situacao === 'Inativo') throw falha(409, 'Colaborador desligado não pode ser bloqueado.');
  const situacao = c.situacao === 'Bloqueado' ? 'Ativo' : 'Bloqueado';
  tx(() => { gravarColaborador(req, c, { situacao }); auditar(req, situacao === 'Ativo' ? 'Desbloqueou' : 'Bloqueou', 'colaborador', c.id); });
  res.redirect(`/cad/colaboradores/${c.id}/ficha`);
}));
app.post('/cad/colaboradores/:id(\\d+)/desligar', exige('edita'), h((req, res) => {
  const c = carregarColaborador(req);
  if (c.situacao === 'Inativo') throw falha(409, 'Este colaborador já está desligado.');
  const { dados, erros } = lerForm(KINDS.desligamento, { ...req.body, colaborador_id: c.id }, req.c);
  if (erros.length) { flash(res, erros.join(' '), 'erro'); return res.redirect(`/cad/colaboradores/${c.id}/ficha`); }
  tx(() => {
    const id = R.criar(req.office, 'desligamento', dados, req.user.name);
    gravarColaborador(req, c, { situacao: 'Inativo', checklist_feitos: [] });
    auditar(req, 'Desligou', 'colaborador', c.id, `desligamento ${id}`);
  });
  flash(res, 'Desligamento registrado. O checklist de demissão está na ficha.');
  res.redirect(`/cad/colaboradores/${c.id}/ficha`);
}));
app.post('/cad/colaboradores/:id(\\d+)/reativar', exige('edita'), h((req, res) => {
  const c = carregarColaborador(req);
  if (c.situacao !== 'Inativo') throw falha(409, 'Este colaborador não está desligado.');
  tx(() => {
    gravarColaborador(req, c, { situacao: 'Ativo', checklist_feitos: [] });
    R.criar(req.office, 'ocorrencia', { colaborador_id: c.id, data: hoje(), tipo: 'Recontratação', classificacao: 'Positivo' }, req.user.name);
    auditar(req, 'Recontratou', 'colaborador', c.id);
  });
  flash(res, 'Colaborador recontratado. Confira a data de admissão e o contrato.');
  res.redirect(`/cad/colaboradores/${c.id}/ficha`);
}));

// ---------------------------------------------------------------- desempenho
function seletorCiclo(req) {
  const ciclos = R.listar(req.office, 'ciclo');
  const atual = ciclos.find(c => c.id === Number(req.query.ciclo)) || ciclos[0];
  return { ciclos, atual, avaliacoes: atual ? R.listar(req.office, 'avaliacao').filter(a => a.ciclo_id === atual.id) : [] };
}
const formCiclo = (ciclos, atual) => html`<form class="acoes" method="get">${select('ciclo', ciclos.map(c => [c.id, c.titulo]), atual?.id, 'class="medio" onchange="this.form.submit()" aria-label="Ciclo"')}</form>`;

app.get('/matriz-potencial', h((req, res) => {
  const { ciclos, atual, avaliacoes } = seletorCiclo(req);
  if (!atual) return res.send(layout(req, 'Matriz de potencial', html`<div class="aviso alerta">Crie um ciclo em <a href="/cad/ciclos-avaliacao">Ciclos de avaliação</a> e lance as avaliações.</div>`));
  res.send(layout(req, 'Matriz de potencial', html`${formCiclo(ciclos, atual)}<div class="card"><p class="eixo">↑ Potencial</p><div class="nove">
    ${M.matriz(avaliacoes).flat().map(q => html`<div><h4>${q.nome} (${q.itens.length})</h4><ul>${q.itens.map(a => html`<li><a href="/cad/colaboradores/${a.colaborador_id}/ficha">${req.c.nome('colaborador', a.colaborador_id)}</a></li>`)}</ul></div>`)}
  </div><p class="eixo">Desempenho →</p></div>`, { descricao: 'Nota 1-2 = baixo, 3 = médio, 4-5 = alto.' }));
}));

app.get('/performance', h((req, res) => {
  const { ciclos, atual, avaliacoes } = seletorCiclo(req);
  if (!atual) return res.send(layout(req, 'Análise de performance', html`<div class="aviso alerta">Crie um ciclo em <a href="/cad/ciclos-avaliacao">Ciclos de avaliação</a> e lance as avaliações.</div>`));
  const dep = a => req.c.nome('departamento', req.c.registro('colaborador', a.colaborador_id)?.departamento_id) || 'Sem departamento';
  const grupos = new Map();
  for (const a of avaliacoes) grupos.set(dep(a), [...(grupos.get(dep(a)) || []), a.desempenho]);
  const linhas = [...grupos].map(([g, n]) => [g, n.length, n2(M.media(n)), n.filter(x => x >= 4).length, n.filter(x => x <= 2).length]);
  res.send(layout(req, 'Análise de performance', html`${formCiclo(ciclos, atual)}${tabela(['Departamento', 'Avaliados', 'Média', 'Alta performance', 'Baixa performance'], linhas, 'Nenhuma avaliação neste ciclo.')}`,
    { descricao: 'Alta = desempenho 4 ou 5. Baixa = desempenho 1 ou 2.' }));
}));

// ---------------------------------------------------------------- visão geral
const FICHA = (c, id) => html`<a href="/cad/colaboradores/${id}/ficha">${c.nome('colaborador', id) || 'Colaborador removido'}</a>`;
const ABA_AVD = [['cargos', 'Cargos', 'cargo'], ['departamentos', 'Departamentos', 'departamento'], ['unidades', 'Unidades', 'unidade']];

function visaoAvd(req) {
  const c = req.c, { ciclos, atual, avaliacoes } = seletorCiclo(req);
  if (!atual) return html`<div class="aviso alerta">Crie um ciclo em <a href="/cad/ciclos-avaliacao">Solicitar Avaliação</a> e lance as avaliações.</div>`;
  const pendentes = M.pendentesAvd(atual, c.listar('colaborador'), avaliacoes);
  const total = avaliacoes.length + pendentes.length;
  const pessoa = a => c.registro('colaborador', a.colaborador_id) || {};
  const [por, rotulo, kind] = ABA_AVD.find(x => x[0] === req.query.por) || ABA_AVD[0];
  const todos = req.query.mostrar === 'todos';
  const medias = M.mediasPor(avaliacoes, a => c.nome(kind, pessoa(a)[`${kind}_id`]) || `Sem ${kind}`);
  const url = (p, m) => `?aba=avd&ciclo=${atual.id}&por=${p}&mostrar=${m}`;
  const linhas = [
    ...avaliacoes.map(a => [FICHA(c, a.colaborador_id), c.nome('colaborador', pessoa(a).superior_id) || '-', c.nome('cargo', pessoa(a).cargo_id) || '-', 'Respondida', a.desempenho, a.potencial]),
    ...pendentes.map(p => [FICHA(c, p.id), c.nome('colaborador', p.superior_id) || '-', c.nome('cargo', p.cargo_id) || '-', 'Pendente', '-', '-']),
  ];
  return html`${formCiclo(ciclos, atual)}
    <div class="cards4">${cartao('Avaliados', avaliacoes.length)}${cartao('Pendentes', pendentes.length)}
      ${cartao('Taxa de resposta', total ? `${Math.round((avaliacoes.length / total) * 100)}%` : '-')}${cartao('Média de desempenho', avaliacoes.length ? n2(M.media(avaliacoes.map(a => a.desempenho))) : '-', 'Notas de 1 a 5')}</div>
    <h3>Notas médias</h3>
    <div class="abas">${ABA_AVD.map(([p, r]) => html`<a href="${url(p, todos ? 'todos' : 'top')}" class="${p === por ? 'ativo' : ''}">${r}</a>`)}
      <a href="${url(por, 'top')}" class="fim ${todos ? '' : 'ativo'}">Top 5</a><a href="${url(por, 'todos')}" class="${todos ? 'ativo' : ''}">Todos</a></div>
    <div class="card">${barras(todos ? medias : medias.slice(0, 5), `Nenhuma avaliação por ${rotulo.toLowerCase()} neste ciclo.`, { partes: false })}</div>
    <h3>Avaliações do ciclo</h3>
    ${tabela(['Avaliado', 'Avaliador', 'Cargo', 'Status', 'Desempenho', 'Potencial'], linhas, 'Nenhuma avaliação neste ciclo.')}
    <a class="botao sec" href="/cad/avaliacoes">Ver todas as avaliações</a>`;
}

function visaoPdi(req) {
  const c = req.c, dia = hoje(), pdis = ordenar(KINDS.pdi, c.listar('pdi')), avaliacoes = c.listar('avaliacao');
  const nota = p => (avaliacoes.find(a => a.colaborador_id === p.colaborador_id && a.ciclo_id === p.ciclo_id) || avaliacoes.find(a => a.colaborador_id === p.colaborador_id))?.desempenho ?? '-';
  const ativa = M.PDI_SITUACOES.includes(req.query.pdi) ? req.query.pdi : 'Todos';
  const conta = s => pdis.filter(p => M.situacaoPdi(p, dia) === s).length;
  const lista = ativa === 'Todos' ? pdis : pdis.filter(p => M.situacaoPdi(p, dia) === ativa);
  return html`<div class="abas">${[['Todos', pdis.length], ...M.PDI_SITUACOES.map(s => [s, conta(s)])].map(([s, n]) => html`<a href="?aba=pdi&pdi=${encodeURIComponent(s)}" class="${s === ativa ? 'ativo' : ''}">${s}<span>${n}</span></a>`)}</div>
    ${tabela(['Colaborador', 'Título do PDI', 'Iniciado em', 'Prazo', 'Nota AVD', 'Status'], lista.map(p => [FICHA(c, p.colaborador_id), html`<a href="/cad/pdi/${p.id}">${p.titulo}</a>`, dataBr(p.inicio), dataBr(p.entrega), nota(p), M.situacaoPdi(p, dia).replace(/s$/, '')]), 'Nenhum PDI nesta situação.')}
    <a class="botao sec" href="/cad/pdi">Ver todos os PDIs</a>`;
}

function visaoFeedbacks(req) {
  const c = req.c, lista = c.listar('feedback').sort((a, b) => String(b.data).localeCompare(String(a.data))).slice(0, 50);
  return html`${tabela(['Colaborador', 'Tipo do feedback', 'Data', 'Autor'], lista.map(f => [FICHA(c, f.colaborador_id), html`<a href="/cad/feedbacks/${f.id}">${f.classificacao}</a>`, dataBr(f.data), f.criado_por || '-']), 'Nenhum feedback registrado.')}
    <a class="botao sec" href="/cad/feedbacks">Ver todos os feedbacks</a>`;
}

app.get('/desenvolvimento', h((req, res) => {
  const abas = { avd: ['AVD', visaoAvd], pdi: ['PDI', visaoPdi], feedbacks: ['Feedbacks', visaoFeedbacks] };
  const ativa = abas[req.query.aba] ? req.query.aba : 'avd';
  res.send(layout(req, 'Visão Geral', html`<div class="abas">${Object.entries(abas).map(([k, [r]]) => html`<a href="?aba=${k}" class="${k === ativa ? 'ativo' : ''}">${r}</a>`)}</div>${abas[ativa][1](req)}`,
    { migalha: 'Desenv. e Performance', descricao: 'Avaliações, PDIs e feedbacks reunidos em um só lugar.' }));
}));

app.get('/cad/pdi/avaliados-sem-pdi', h((req, res) => {
  const c = req.c, editar = pode(req.papel, 'edita');
  const lista = M.avaliadosSemPdi(c.listar('colaborador'), c.listar('avaliacao'), c.listar('pdi'));
  res.send(layout(req, 'Avaliados sem PDI', tabela(['Colaborador', 'Ciclo', 'Desempenho', 'Potencial', 'Ações'], lista.map(({ colaborador: p, avaliacao: a }) => [
    html`<a href="/cad/colaboradores/${p.id}/ficha">${p.nome}</a>`, c.nome('ciclo', a.ciclo_id), a.desempenho, a.potencial,
    editar ? html`<a href="/cad/pdi/novo?colaborador_id=${p.id}&ciclo_id=${a.ciclo_id}">Criar PDI</a>` : '',
  ]), 'Todos os avaliados têm PDI em andamento.'), { migalha: 'PDI', descricao: 'Última avaliação de quem está sem PDI aberto ou em revisão.' }));
}));

// ---------------------------------------------------------------- pesquisas
const MIN_RESPOSTAS = 3; // com menos, a média poderia revelar a nota de alguém

function resumoPesquisa(office, p) {
  const resp = db.prepare('SELECT dados FROM respostas WHERE office = ? AND pesquisa_id = ?').all(office, p.id).map(r => JSON.parse(r.dados));
  const notas = i => resp.map(r => r.notas[i]).filter(n => n !== undefined);
  return { resp, q: perguntasDe(p), notas, visivel: resp.length >= MIN_RESPOSTAS, media: M.media(resp.flatMap(r => r.notas)), enps: p.categoria === 'eNPS' ? M.enps(notas(0)) : null };
}

app.get('/cad/pesquisas/modelos', exige('edita'), h((req, res) => {
  const opcoes = [['Clima', 'Clima', `${MODELOS_PESQUISA.Clima.length} perguntas prontas sobre liderança, comunicação, reconhecimento e ambiente.`],
    ['eNPS', 'eNPS', 'Uma pergunta: o quanto a pessoa recomendaria a empresa como lugar para trabalhar.'],
    ['Personalizada', 'Personalizada', 'Comece em branco e escreva as suas perguntas.']];
  res.send(layout(req, 'Nova pesquisa', html`<div class="grade-cards">${opcoes.map(([v, t, d]) => html`<a class="card link-card" href="/cad/pesquisas/novo?categoria=${v}"><b>${t}</b><span>${d}</span></a>`)}</div>
    <a class="botao sec" href="/cad/pesquisas">Voltar</a>`, { migalha: 'Pesquisas', descricao: 'Escolha um modelo. Você pode editar tudo antes de abrir a pesquisa.' }));
}));

app.get('/cad/pesquisas/comparar', h((req, res) => {
  const lista = req.c.listar('pesquisa').filter(p => p.status !== 'Rascunho');
  if (lista.length < 2) return res.send(layout(req, 'Comparar pesquisas', html`<div class="aviso alerta">Abra ao menos duas pesquisas para comparar.</div><a class="botao sec" href="/cad/pesquisas">Voltar</a>`, { migalha: 'Pesquisas' }));
  const achar = (id, padrao) => lista.find(p => p.id === Number(id)) || padrao;
  const pa = achar(req.query.a, lista[1]), pb = achar(req.query.b, lista[0]);
  const a = resumoPesquisa(req.office, pa), b = resumoPesquisa(req.office, pb);
  const num = (r, v) => (!r.visivel ? 'poucas respostas' : v === null ? '-' : n2(v));
  const op = lista.map(p => [p.id, p.titulo]);
  const comuns = a.q.filter(t => b.q.includes(t));
  const linhas = [['Respostas', a.resp.length, b.resp.length], ['Média geral', num(a, a.media), num(b, b.media)], ['eNPS', num(a, a.enps), num(b, b.enps)],
    ...comuns.map(t => [t, num(a, M.media(a.notas(a.q.indexOf(t)))), num(b, M.media(b.notas(b.q.indexOf(t))))])];
  res.send(layout(req, 'Comparar pesquisas', html`<form class="acoes" method="get">
      ${select('a', op, pa.id, 'class="medio" onchange="this.form.submit()" aria-label="Primeira pesquisa"')}${select('b', op, pb.id, 'class="medio" onchange="this.form.submit()" aria-label="Segunda pesquisa"')}</form>
    ${tabela(['Indicador', pa.titulo, pb.titulo], linhas)}`, { migalha: 'Pesquisas', descricao: `Resultados só com ${MIN_RESPOSTAS} respostas ou mais. Perguntas iguais nas duas aparecem lado a lado.` }));
}));

app.get('/pesquisas/:id(\\d+)', h((req, res) => {
  const p = R.obter(req.office, 'pesquisa', req.params.id);
  if (!p) throw falha(404, 'Pesquisa não encontrada.');
  const { resp, q, notas } = resumoPesquisa(req.office, p);
  const link = `${baseUrl(req)}/pesquisa/${p.token}`;
  const resultado = resp.length < MIN_RESPOSTAS ? html`<div class="aviso alerta">Os resultados aparecem a partir de ${MIN_RESPOSTAS} respostas, para proteger o anonimato.</div>` : html`
    ${p.categoria === 'eNPS' ? html`<div class="cards4">${cartao('eNPS', M.enps(notas(0)), 'promotores menos detratores')}</div>` : ''}
    ${tabela(['Pergunta', 'Média', 'Respostas'], q.map((t, i) => [t, n2(M.media(notas(i))), notas(i).length]))}
    <div class="card"><h3 class="primeiro">Comentários</h3>${resp.filter(r => r.comentario).length ? html`<ul>${resp.filter(r => r.comentario).map(r => html`<li>${r.comentario}</li>`)}</ul>` : html`<p class="desc">Nenhum comentário.</p>`}</div>`;
  res.send(layout(req, p.titulo, html`<div class="card"><small>Link para responder (status: ${p.status})</small>
    <div class="copiar"><input id="linkPesquisa" value="${link}" readonly aria-label="Link da pesquisa"><button type="button" class="botao sec" data-copiar="linkPesquisa">Copiar</button></div></div>
    <div class="cards4">${cartao('Respostas', resp.length)}</div>${resultado}`, { migalha: 'Pesquisas' }));
}));

// ---------------------------------------------------------------- cultura
const CULTURA = [['missao', 'Missão'], ['visao', 'Visão'], ['valores', 'Valores'], ['forcas', 'Forças'], ['fraquezas', 'Fraquezas'], ['oportunidades', 'Oportunidades'], ['ameacas', 'Ameaças']];
app.get('/cultura', h((req, res) => {
  const d = R.config(req.office, 'cultura'), editar = pode(req.papel, 'edita');
  res.send(layout(req, 'Cultura organizacional', html`<form method="post" class="card"><fieldset ${editar ? '' : raw('disabled')}><div class="grade">
    ${CULTURA.map(([n, r]) => campo(r, html`<textarea name="${n}" rows="4" maxlength="5000">${d[n] || ''}</textarea>`, n === 'missao' || n === 'visao' || n === 'valores' ? 'largo' : ''))}</div></fieldset>
    <div class="acoes nao-imprime">${editar ? html`<button class="botao">Salvar</button>` : ''}<button type="button" class="botao sec" onclick="window.print()">Imprimir</button></div></form>`, { descricao: 'Missão, visão, valores e análise SWOT.' }));
}));
app.post('/cultura', exige('edita'), h((req, res) => {
  R.salvarConfig(req.office, 'cultura', Object.fromEntries(CULTURA.map(([n]) => [n, String(um(req.body[n]) || '').slice(0, 5000)])));
  auditar(req, 'Editou', 'cultura');
  flash(res, 'Salvo.');
  res.redirect('/cultura');
}));

// ---------------------------------------------------------------- métricas
app.get('/metricas/colaboradores', h((req, res) => {
  const lista = R.listar(req.office, 'colaborador'), dia = hoje(), q = M.resumoQuadro(lista, dia), c = req.c;
  const fat = ve(req.papel, 'salario') ? R.listar(req.office, 'faturamento').sort((a, b) => (b.ano - a.ano) || (Number(b.mes) - Number(a.mes)))[0] : null;
  const bloco = (t, pares) => html`<div class="card"><h3 class="primeiro">${t}</h3>${barras(pares)}</div>`;
  res.send(layout(req, 'Métricas de colaboradores', html`<div class="cards4">
      ${cartao('Ativos', q.ativos.length)}${cartao('Idade média', q.idadeMedia ? `${n2(q.idadeMedia)} anos` : '-')}${cartao('Tempo médio de casa', q.tempoMedio ? `${n2(q.tempoMedio)} anos` : '-')}
      ${fat && q.ativos.length ? cartao('Faturamento por colaborador', brl(fat.valor / q.ativos.length), `${fat.mes}/${fat.ano}`) : ''}</div>
    <div class="grade-2">${bloco('Por departamento', M.contar(q.ativos, x => c.nome('departamento', x.departamento_id)))}${bloco('Por cargo', M.contar(q.ativos, x => c.nome('cargo', x.cargo_id)).slice(0, 10))}
      ${bloco('Por tipo de contrato', M.contar(q.ativos, x => x.tipo_contrato))}
      ${ve(req.papel, 'pessoal') ? html`${bloco('Gênero', M.contar(q.ativos, x => x.genero))}${bloco('Raça/etnia', M.contar(q.ativos, x => x.raca))}${bloco('Escolaridade', M.contar(q.ativos, x => x.escolaridade))}
        ${bloco('Pessoas com deficiência', M.contar(q.ativos, x => (x.pcd ? 'Sim' : 'Não')))}` : ''}</div>`));
}));

app.get('/metricas/desligamentos', h((req, res) => {
  const meses = [3, 6, 12, 24].includes(Number(req.query.meses)) ? Number(req.query.meses) : 12;
  const s = M.resumoDesligamentos(R.listar(req.office, 'desligamento'), R.listar(req.office, 'colaborador'), hoje(), meses), c = req.c;
  const vRes = ve(req.papel, 'salario');
  res.send(layout(req, 'Métricas de desligamento', html`<form class="acoes" method="get">${select('meses', [[3, 'Últimos 3 meses'], [6, 'Últimos 6 meses'], [12, 'Últimos 12 meses'], [24, 'Últimos 24 meses']], meses, 'class="medio" onchange="this.form.submit()" aria-label="Período"')}</form>
    <div class="cards4">${cartao('Desligamentos', s.total)}${cartao('Rotatividade', `${n2(s.taxa)}%`, 'sobre o quadro médio')}${cartao('Menos de 1 ano de casa', s.menosDeUmAno)}${vRes ? cartao('Valor de rescisão', brl(s.valorRescisao)) : ''}</div>
    <div class="grade-2"><div class="card"><h3 class="primeiro">Motivos</h3>${barras(M.contar(s.lista, d => c.nome('motivo_demissao', d.motivo_id)))}</div>
      <div class="card"><h3 class="primeiro">Tipo</h3>${barras(M.contar(s.lista, d => d.tipo))}</div></div>
    ${tabela(['Colaborador', 'Data', 'Tipo', 'Motivo', ...(vRes ? ['Rescisão'] : [])], s.lista.map(d => [c.nome('colaborador', d.colaborador_id), dataBr(d.data), d.tipo, c.nome('motivo_demissao', d.motivo_id), ...(vRes ? [d.valor_rescisao != null ? brl(d.valor_rescisao) : ''] : [])]))}`, { descricao: `Desde ${dataBr(s.desde)}.` }));
}));

// ---------------------------------------------------------------- configurações
const ROT_ALERTA = { experiencia: 'Fim de experiência', contrato: 'Fim de contrato', aniversario: 'Aniversário', exame: 'Exame', ferias: 'Férias sem programação', pdi: 'Entrega de PDI', avaliacao: 'Fim de ciclo de avaliação', treinamento: 'Vencimento de treinamento' };
app.get('/config/alertas', exige('configura'), h((req, res) => {
  const d = R.config(req.office, 'alertas', ANTECEDENCIA_PADRAO);
  res.send(layout(req, 'Alertas', html`<form method="post" class="card"><div class="grade">${Object.entries(ROT_ALERTA).map(([n, r]) => campo(`${r} (dias antes)`, html`<input type="number" name="${n}" min="0" max="365" value="${d[n]}" required>`))}</div>
    <div class="acoes"><button class="botao">Salvar</button></div></form>`, { descricao: 'Antecedência de cada aviso no Painel.' }));
}));
app.post('/config/alertas', exige('configura'), h((req, res) => {
  const d = {};
  for (const n of Object.keys(ROT_ALERTA)) { const v = Number(um(req.body[n])); if (!Number.isInteger(v) || v < 0 || v > 365) throw falha(422, 'Use um número de dias entre 0 e 365.'); d[n] = v; }
  R.salvarConfig(req.office, 'alertas', d);
  auditar(req, 'Editou', 'alertas');
  flash(res, 'Salvo.');
  res.redirect('/config/alertas');
}));

app.get('/config/usuarios', exige('configura'), h((req, res) => {
  const lista = db.prepare(`SELECT u.*, p.papel FROM users u LEFT JOIN papeis p ON p.office = ? AND p.hub_user = u.hub_user WHERE u.office = ? AND u.is_global = 0 ORDER BY u.name`).all(req.office, req.office);
  const op = Object.entries(PAPEIS).map(([id, p]) => [id, p.rotulo]);
  res.send(layout(req, 'Usuários e papéis', tabela(['Usuário', 'Último acesso', 'Papel'], lista.map(u => [u.name, dataHoraBr(u.last_login),
    u.is_admin ? 'Administrador no Hub (acesso total)' : html`<form method="post" class="acoes-linha" action="/config/usuarios"><input type="hidden" name="hub_user" value="${u.hub_user}">${select('papel', op, u.papel || 'leitura', 'class="medio" aria-label="Papel"')}<button class="botao sec pequeno">Salvar</button></form>`]), 'Ninguém entrou ainda.'),
  { descricao: 'O usuário aparece aqui depois do primeiro acesso pelo card do Hub. Quem entra começa em "Apenas visualização".' }));
}));
app.post('/config/usuarios', exige('configura'), h((req, res) => {
  const hubUser = String(um(req.body.hub_user) || ''), papel = String(um(req.body.papel) || '');
  const u = db.prepare('SELECT 1 FROM users WHERE hub_user = ? AND office = ?').get(hubUser, req.office);
  if (!u || !PAPEIS[papel]) throw falha(422, 'Usuário ou papel inválido.');
  db.prepare('INSERT INTO papeis (office, hub_user, papel) VALUES (?,?,?) ON CONFLICT(office, hub_user) DO UPDATE SET papel = excluded.papel').run(req.office, hubUser, papel);
  auditar(req, 'Mudou papel', null, null, `${hubUser}: ${PAPEIS[papel].rotulo}`);
  flash(res, 'Papel salvo.');
  res.redirect('/config/usuarios');
}));

// mesmo fluxo de /cad/:slug/importar, mantido no menu de Configurações
app.get('/config/importar', exige('edita'), (req, res) => res.redirect('/cad/colaboradores/importar'));

app.get('/config/auditoria', exige('configura'), h((req, res) => {
  const lista = db.prepare('SELECT * FROM auditoria WHERE office = ? ORDER BY id DESC LIMIT 1000').all(req.office);
  res.send(layout(req, 'Auditoria', tabela(['Quando', 'Usuário', 'Ação', 'Cadastro', 'Registro', 'Detalhe'], lista.map(a => [dataHoraBr(a.em), a.usuario, a.acao, KINDS[a.kind]?.titulo || a.kind || '', a.registro_id ?? '', a.detalhe || ''])),
    { descricao: 'Últimas 1.000 ações. Guarda os nomes dos campos alterados, nunca os valores.' }));
}));

perfilRotas.internas(app, { h, exige, auditar, flash, falha, baseUrl });

// eslint-disable-next-line no-unused-vars
app.use((req, res, next) => next(falha(404, 'Tela não encontrada.')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const msg = status >= 500 ? 'Erro inesperado. Tente de novo; se continuar, avise o suporte.' : err.message;
  if (req.user) return res.status(status).send(layout(req, 'Aviso', html`<div class="aviso erro">${msg}</div>`));
  telaErro(res, status, msg);
});

module.exports = app;

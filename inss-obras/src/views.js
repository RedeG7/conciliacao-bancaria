'use strict';
// HTML renderizado no servidor: layout (menu lateral + barra superior) e
// pequenos componentes reaproveitados pelas telas.

// versão (hash do conteúdo) no endereço do CSS/JS: a cada deploy o navegador
// baixa os arquivos novos em vez de usar os do cache (que vale 1 hora)
const VERSAO = Object.fromEntries(['app.css', 'app.js'].map(f => [f, require('crypto').createHash('md5')
  .update(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', f))).digest('hex').slice(0, 10)]));

// faixa de aviso no topo de todas as telas (ex.: instabilidade do eSocial),
// definida pelo super administrador em Cadastros > Parâmetros
const faixa = () => require('./db').setting('aviso_topo');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// html`...` escapa as interpolações; use raw() para HTML já montado
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = s => new Raw(s);
const val = v => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
const html = (strs, ...vals) => raw(strs.reduce((o, s, i) => o + s + (i < vals.length ? val(vals[i]) : ''), ''));

const brl = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const n2 = v => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const dataBr = s => { if (!s) return ''; const d = String(s).slice(0, 10).split('-'); return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s; };
const dataHoraBr = s => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '');

const MENU = [
  ['Início', [['/dash', 'Dashboard', '🏠']]],
  ['Simuladores', [
    ['/simuladores/obras-prediais', 'Obras prediais', '🏗️'],
    ['/simuladores/fator-de-ajuste-e-social', 'Fator de ajuste eSocial', '📊'],
    ['/simuladores/fator-de-ajuste-gfip', 'Fator de ajuste GFIP', '📊'],
    ['/simuladores/fator-de-ajuste-gps-espontanea', 'Fator de ajuste GPS espontânea', '📊'],
    ['/simuladores/obras-contratuais-pj-nf-contrato', 'PJ NF contrato', '🧾'],
    ['/simuladores/obras-contratuais-pj-nf-medicao', 'PJ NF contrato medição', '🧾'],
    ['/simuladores/decadencia', 'Decadência', '⏳'],
    ['/simuladores/parcelamento', 'Parcelamento e-CAC', '💳'],
  ]],
  ['DCTF Web', [
    ['/guia-de-envio', 'Guia de envio', '🧭'],
    ['/dctf-web', 'Envios', '📤'],
    ['/cadastros/certificados', 'Certificados digitais', '🔐'],
    ['/acompanhamento-de-obras/autonomos', 'Autônomos', '👷'],
    ['/acompanhamento-de-obras/obras', 'Obras (CNO)', '🏗️'],
  ]],
  ['Acompanhamento de obras', [
    ['/acompanhamento-de-obras/clientes', 'Clientes', '👤'],
    ['/acompanhamento-de-obras/propostas', 'Propostas', '📄'],
  ]],
  ['Ferramentas', [['/ferramentas-extras/leads', 'Leads', '🎯']]],
  ['Cadastros', [
    ['/cadastros/escritorio', 'Escritório e link público', '🏢'],
    ['/cadastros/parametros', 'Parâmetros de cálculo', '⚙️'],
  ]],
];

function layout(req, titulo, corpo, { descricao = '', migalha = '' } = {}) {
  const u = req.user;
  const atual = req.path;
  const offices = u.is_global ? JSON.parse(u.offices || '[]') : [];
  const menu = MENU.map(([grupo, itens]) => html`
    <details class="grupo" open data-grupo="${grupo}"><summary>${grupo}</summary>
      ${itens.map(([href, rot, ic]) => html`<a href="${href}" class="${atual === href || atual.startsWith(href + '/') ? 'ativo' : ''}" data-busca="${rot.toLowerCase()}" title="${rot}"><span>${ic}</span><span class="rot">${rot}</span></a>`)}
    </details>`);
  return page(titulo, html`
<div class="app">
  <aside class="lateral" id="lateral">
    <div class="marca"><span class="logo" id="logoMenu" title="Expandir menu">🏗️</span><div><b>Simulador INSS Obras</b><small>RedeG7</small></div>
      <button class="recolher" id="recolherMenu" aria-label="Recolher menu" title="Recolher / expandir menu">«</button></div>
    <input class="busca-menu" id="buscaMenu" placeholder="Buscar tela..." aria-label="Buscar tela">
    <nav>${menu}</nav>
  </aside>
  <div class="principal">
    <header class="topo">
      <button class="icone" id="abrirMenu" aria-label="Menu" title="Recolher / expandir menu">☰</button>
      <div class="escritorio">${u.is_global && offices.length ? html`
        <form method="post" action="/trocar-escritorio"><select name="office" onchange="this.form.submit()" aria-label="Escritório">
          ${offices.map(o => html`<option value="${o.id}" ${o.id === req.office ? 'selected' : ''}>${o.name}</option>`)}
        </select></form>` : html`<span>${req.officeRow?.name || ''}</span>`}</div>
      <div class="acoes-topo">
        <button class="icone" id="telaCheia" title="Tela cheia" aria-label="Tela cheia">⛶</button>
        <button class="icone" id="modoEscuro" title="Modo escuro" aria-label="Alternar modo escuro">🌓</button>
        <span class="usuario">${u.name}${u.is_global ? ' · super admin' : u.is_admin ? ' · admin' : ''}</span>
        <a class="botao sec pequeno" href="/sair">Sair</a>
      </div>
    </header>
    ${faixa() ? html`<div class="faixa-status" role="status">⚠️ ${faixa()}</div>` : ''}
    <main>
      <div class="cabecalho"><div><small class="migalha">${migalha}</small><h1>${titulo}</h1>${descricao ? html`<p class="desc">${descricao}</p>` : ''}</div></div>
      ${req.flash ? html`<div class="aviso ${req.flash.tipo || 'ok'}">${req.flash.msg}</div>` : ''}
      ${corpo}
    </main>
  </div>
</div>`);
}

function page(titulo, corpo, extraHead = '') {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · Simulador INSS Obras</title><link rel="stylesheet" href="/static/app.css?v=${VERSAO['app.css']}">${extraHead}
<script>try{var t=localStorage.getItem('tema');if(t)document.documentElement.dataset.theme=t;var m=localStorage.getItem('menu');if(m)document.documentElement.dataset.menu=m}catch(e){}</script></head>
<body>${corpo}<script src="/static/app.js?v=${VERSAO['app.js']}"></script></body></html>`;
}

// 3 cartões: cadastrados hoje / no mês / no ano, com variação vs. período anterior
function contadores(c, rotulo = 'Cadastrados') {
  const varr = (a, b) => (b ? Math.round(((a - b) / b) * 100) : a ? 100 : 0);
  const card = (t, a, b, ant) => {
    const v = varr(a, b);
    return html`<div class="card contador"><small>${rotulo} ${t}</small><b>${a}</b><span class="${v >= 0 ? 'sobe' : 'desce'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}% vs. ${ant}</span></div>`;
  };
  return html`<div class="cards3 contadores">${card('hoje', c.hoje, c.ontem, 'ontem')}${card('esse mês', c.mes, c.mesAnt, 'mês anterior')}${card('no ano', c.ano, c.anoAnt, 'ano anterior')}</div>`;
}

// tabela com busca e paginação no navegador (public/app.js)
function tabela(cabecalhos, linhas, vazio = 'Nenhum registro.') {
  return html`<div class="card"><div class="tabela-topo">
    <label>Mostrar <select class="por-pagina"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></label>
    <input class="busca-tabela" placeholder="Buscar..." aria-label="Buscar na tabela"></div>
    <div class="rolagem"><table class="lista cartoes"><thead><tr>${cabecalhos.map(c => html`<th>${c}</th>`)}</tr></thead>
    <tbody>${linhas.length ? linhas.map(l => html`<tr>${l.map((c, i) => html`<td data-label="${cabecalhos[i]}">${c}</td>`)}</tr>`) : html`<tr class="vazio"><td colspan="${cabecalhos.length}">${vazio}</td></tr>`}</tbody></table></div>
    <div class="paginacao"></div></div>`;
}

const select = (name, opcoes, atual, attrs = '') => html`<select name="${name}" ${raw(attrs)}>${opcoes.map(o => {
  const [v, t] = Array.isArray(o) ? o : [o, o];
  return html`<option value="${v}" ${String(v) === String(atual ?? '') ? 'selected' : ''}>${t}</option>`;
})}</select>`;

const campo = (rotulo, input, extra = '') => html`<label class="campo ${raw(extra)}"><span>${rotulo}</span>${input}</label>`;

module.exports = { esc, raw, html, brl, n2, dataBr, dataHoraBr, layout, page, contadores, tabela, select, campo };

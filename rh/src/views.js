'use strict';
// HTML renderizado no servidor: layout (menu lateral + barra superior) e
// pequenos componentes reaproveitados pelas telas. Mesmo visual dos outros
// apps do Hub (public/app.css).
const { KINDS } = require('./modelos');
const { PAPEIS, ve, pode } = require('./acesso');

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

const cad = kind => [`/cad/${KINDS[kind].slug}`, KINDS[kind].titulo, KINDS[kind].icone, KINDS[kind].cl];
const MENU = [
  ['Início', [['/dash', 'Painel', '🏠'], ['/aniversariantes', 'Aniversariantes', '🎂']]],
  ['Pessoas', [cad('colaborador'), cad('ocorrencia'), cad('feedback'), cad('ferias'), cad('banco_horas'), cad('saude'), cad('desligamento'), cad('checklist')]],
  ['Estrutura', [cad('departamento'), cad('cargo'), cad('filial'), cad('unidade'), cad('motivo_demissao')]],
  ['Desempenho', [cad('ciclo'), cad('avaliacao'), ['/matriz-potencial', 'Matriz de potencial', '🔲'], ['/performance', 'Análise de performance', '📊'],
    cad('grupo_competencia'), cad('competencia'), cad('meta'), cad('meta_colaborador'), cad('pdi'), cad('treinamento'), cad('participacao')]],
  ['Engajamento', [cad('pesquisa'), cad('beneficio'), cad('beneficiario'), ['/cultura', 'Cultura organizacional', '🧭'], cad('faturamento')]],
  ['Métricas', [['/metricas/colaboradores', 'Métricas de colaboradores', '📈'], ['/metricas/desligamentos', 'Métricas de desligamento', '📉']]],
  ['Configurações', [['/config/alertas', 'Alertas', '🔔', null, 'configura'], ['/config/usuarios', 'Usuários e papéis', '🔑', null, 'configura'],
    ['/config/importar', 'Importar colaboradores', '📥', null, 'edita'], ['/config/auditoria', 'Auditoria', '🔍', null, 'configura']]],
];

function layout(req, titulo, corpo, { descricao = '', migalha = '' } = {}) {
  const u = req.user, atual = req.path, offices = u.is_global ? JSON.parse(u.offices || '[]') : [];
  const menu = MENU.map(([grupo, itens]) => {
    const vis = itens.filter(([, , , cl, acao]) => ve(req.papel, cl) && (!acao || pode(req.papel, acao)));
    return vis.length ? html`<details class="grupo" open><summary>${grupo}</summary>
      ${vis.map(([href, rot, ic]) => html`<a href="${href}" class="${atual === href || atual.startsWith(href + '/') ? 'ativo' : ''}" data-busca="${rot.toLowerCase()}"><span>${ic}</span>${rot}</a>`)}
    </details>` : '';
  });
  return page(titulo, html`
<div class="app">
  <aside class="lateral" id="lateral">
    <div class="marca"><span class="logo">👥</span><div><b>RH</b><small>RedeG7</small></div></div>
    <input class="busca-menu" id="buscaMenu" placeholder="Buscar tela..." aria-label="Buscar tela">
    <nav>${menu}</nav>
  </aside>
  <div class="principal">
    <header class="topo">
      <button class="icone" id="abrirMenu" aria-label="Abrir menu">☰</button>
      <div class="escritorio">${u.is_global && offices.length ? html`
        <form method="post" action="/trocar-escritorio"><select name="office" onchange="this.form.submit()" aria-label="Escritório">
          ${offices.map(o => html`<option value="${o.id}" ${o.id === req.office ? 'selected' : ''}>${o.name}</option>`)}
        </select></form>` : html`<span>${req.officeRow?.name || ''}</span>`}</div>
      <div class="acoes-topo">
        <button class="icone" id="modoEscuro" title="Modo escuro" aria-label="Alternar modo escuro">🌓</button>
        <span class="usuario">${u.name} · ${PAPEIS[req.papel].rotulo}</span>
        <a class="botao sec pequeno" href="/sair">Sair</a>
      </div>
    </header>
    <main>
      <div class="cabecalho"><div><small class="migalha">${migalha}</small><h1>${titulo}</h1>${descricao ? html`<p class="desc">${descricao}</p>` : ''}</div></div>
      ${req.flash ? html`<div class="aviso ${req.flash.tipo || 'ok'}">${req.flash.msg}</div>` : ''}
      ${corpo}
    </main>
  </div>
</div>`);
}

function page(titulo, corpo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · RH</title><link rel="stylesheet" href="/static/app.css">
<script>try{var t=localStorage.getItem('tema');if(t)document.documentElement.dataset.theme=t}catch(e){}</script></head>
<body>${corpo}<script src="/static/app.js"></script></body></html>`;
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

const cartao = (titulo, valor, nota = '') => html`<div class="card"><small>${titulo}</small><b>${valor}</b>${nota ? html`<span>${nota}</span>` : ''}</div>`;

// composição de um total: uma cor só, sempre com o número ao lado da barra
function barras(pares, vazio = 'Sem dados ainda.') {
  if (!pares.length) return html`<p class="desc">${vazio}</p>`;
  const maior = Math.max(...pares.map(p => p[1]), 1);
  const total = pares.reduce((s, p) => s + p[1], 0);
  return html`<div class="barras">${pares.map(([r, v]) => html`<div class="item" title="${r}: ${v} (${total ? Math.round((v / total) * 100) : 0}%)"><span>${r}</span>
    <div class="barra"><span style="width:${Math.round((v / maior) * 100)}%"></span></div><span class="valor">${n2(v)}</span></div>`)}</div>`;
}

module.exports = { esc, raw, html, brl, n2, dataBr, dataHoraBr, layout, page, tabela, select, campo, cartao, barras };

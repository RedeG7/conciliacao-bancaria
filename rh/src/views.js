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

// item do menu: [href, rótulo, classe sensível, ação exigida]
const cad = (kind, rotulo) => [`/cad/${KINDS[kind].slug}`, rotulo || KINDS[kind].titulo, KINDS[kind].cl];
const tela = (href, rotulo, cl, acao) => [href, rotulo, cl, acao];
// aba do menu: tem subitens, que podem ser outras abas
const aba = (nome, itens, icone) => ({ nome, itens, icone });
const MENU = [
  { ...aba('Home', [], '🏠'), href: '/dash' },
  aba('Perfil Comportamental', [
    tela('/comportamental/metricas', 'Métricas do Perfil', 'perfil'), tela('/comportamental/perfis', 'Perfis', 'perfil'),
    tela('/comportamental/cargos', 'Engenharia de Cargo', 'perfil'), tela('/comportamental/responder', 'Responder Perfil', 'perfil', 'edita'),
    tela('/comportamental/busca', 'Busca de Perfil', 'perfil'), tela('/comportamental/comparar', 'Comparar Perfis', 'perfil'),
    tela('/comportamental/grupos', 'Análise de Grupo', 'perfil'), tela('/comportamental/extrato', 'Extrato de Envios', 'perfil'),
  ], '🧠'),
  aba('Cargos e Salários', [cad('cargo', 'Engenharia de Cargo')], '💼'),
  aba('Gestão de Talentos', [
    cad('colaborador'), cad('filial', 'Filiais'), cad('departamento', 'Departamentos'), cad('ferias'), cad('banco_horas'), cad('ocorrencia'), cad('feedback'),
    cad('checklist', 'Checklists'), tela('/aniversariantes', 'Aniversariantes'), cad('saude', 'Registro de Saúde'), cad('desligamento'),
    cad('motivo_demissao', 'Motivo de Demissões'), cad('unidade', 'Unidades'), tela('/metricas/colaboradores', 'Métricas do Colaborador'),
  ], '👥'),
  aba('Desenv. e Performance', [
    tela('/desenvolvimento', 'Visão Geral'),
    aba('Competências', [cad('grupo_competencia', 'Grupos de competências'), cad('competencia', 'Competências')]),
    aba('Avaliação Desemp.', [cad('ciclo', 'Solicitar Avaliação'), cad('avaliacao', 'Relatórios Individuais')]),
    aba('Gestão de Metas', [cad('meta', 'Cadastro de Metas'), cad('meta_colaborador', 'Controle de Metas')]),
    tela('/performance', 'Análise de Performance'),
    aba('Treinamentos', [cad('treinamento', 'Gestão de Treinamentos'), cad('participacao')]),
    tela('/matriz-potencial', '9box'), cad('pdi'),
  ], '🎯'),
  aba('Reten. e Engajamento', [
    cad('pesquisa'),
    aba('Gestão de Benefícios', [cad('beneficio', 'Cadastro de Benefícios'), cad('beneficiario')]),
    tela('/cultura', 'Cultura Organizacional'), cad('faturamento'), tela('/metricas/desligamentos', 'Métricas de Desligamento'),
  ], '💬'),
  aba('Configurações', [
    tela('/config/alertas', 'Alerta', null, 'configura'), tela('/config/usuarios', 'Usuários', null, 'configura'),
    aba('Importações', [tela('/cad/colaboradores/importar', 'Colaboradores', null, 'edita')]),
    tela('/config/auditoria', 'Auditoria', null, 'configura'),
  ], '⚙️'),
];

// roda antes da primeira pintura, para a aba aberta não piscar fechada
const RESTAURA_MENU = `<script>try{var g=JSON.parse(localStorage.getItem('menuAberto')||'[]');document.querySelectorAll('.lateral .grupo').forEach(function(d){if(g.indexOf(d.dataset.grupo)>=0)d.open=true})}catch(e){}</script>`;
// muda a cada publicação, para o navegador não usar o JS/CSS antigo do cache
const VERSAO = Date.now().toString(36);

// abas só aparecem com algum item visível; a aba da tela atual já vem aberta
function montarMenu(req, itens, caminho = '') {
  const atual = req.path;
  const ativo = href => atual === href || atual.startsWith(href + '/');
  let temAtivo = false;
  const partes = itens.map(i => {
    if (i.href) { temAtivo = temAtivo || ativo(i.href); return html`<a href="${i.href}" class="topo-menu ${ativo(i.href) ? 'ativo' : ''}" data-busca="${i.nome.toLowerCase()}"><span>${i.icone}</span>${i.nome}</a>`; }
    if (i.nome) {
      const id = caminho + i.nome;
      const sub = montarMenu(req, i.itens, id + '/');
      if (!sub.html) return '';
      temAtivo = temAtivo || sub.temAtivo;
      return html`<details class="grupo" data-grupo="${id}" ${sub.temAtivo ? 'open' : ''}><summary>${i.icone ? html`<span>${i.icone}</span>` : ''}<b>${i.nome}</b></summary>
        <div class="subitens">${raw(sub.html)}</div></details>`;
    }
    const [href, rot, cl, acao] = i;
    if (!ve(req.papel, cl) || (acao && !pode(req.papel, acao))) return '';
    temAtivo = temAtivo || ativo(href);
    return html`<a href="${href}" class="${ativo(href) ? 'ativo' : ''}" data-busca="${rot.toLowerCase()}">${rot}</a>`;
  });
  return { html: partes.map(String).join(''), temAtivo };
}

function layout(req, titulo, corpo, { descricao = '', migalha = '' } = {}) {
  const u = req.user, offices = u.is_global ? JSON.parse(u.offices || '[]') : [];
  const menu = raw(montarMenu(req, MENU).html);
  return page(titulo, html`
<div class="app">
  <aside class="lateral" id="lateral">
    <div class="marca"><span class="logo">👥</span><div><b>RH</b><small>RedeG7</small></div></div>
    <input class="busca-menu" id="buscaMenu" placeholder="Buscar tela..." aria-label="Buscar tela">
    <nav>${menu}</nav>
    ${raw(RESTAURA_MENU)}
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
<title>${esc(titulo)} · RH</title><link rel="stylesheet" href="/static/app.css?v=${VERSAO}">
<script>try{var t=localStorage.getItem('tema');if(t)document.documentElement.dataset.theme=t}catch(e){}</script></head>
<body>${corpo}<script src="/static/app.js?v=${VERSAO}"></script></body></html>`;
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
function barras(pares, vazio = 'Sem dados ainda.', { partes = true } = {}) {
  if (!pares.length) return html`<p class="desc">${vazio}</p>`;
  const maior = Math.max(...pares.map(p => p[1]), 1);
  const total = pares.reduce((s, p) => s + p[1], 0);
  return html`<div class="barras">${pares.map(([r, v]) => html`<div class="item" title="${partes ? `${r}: ${v} (${total ? Math.round((v / total) * 100) : 0}%)` : r}"><span>${r}</span>
    <div class="barra"><span style="width:${Math.round((v / maior) * 100)}%"></span></div><span class="valor">${n2(v)}</span></div>`)}</div>`;
}

module.exports = { MENU, esc, raw, html, brl, n2, dataBr, dataHoraBr, layout, page, tabela, select, campo, cartao, barras };

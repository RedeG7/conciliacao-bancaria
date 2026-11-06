'use strict';
// Gráficos em HTML e CSS, sem biblioteca: acompanham a largura da tela sem
// encolher o texto. Cor vem de .vg-s1 a .vg-s4 (public/app.css); a dica ao
// passar o mouse sai de data-dica (public/app.js). Todo gráfico traz os mesmos
// números em tabela, em "Ver dados", para quem não distingue as cores.
const { html } = require('./views');

const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);
// topo do eixo em número redondo, com pelo menos 2 divisões inteiras
function topoEixo(maior) {
  if (maior <= 4) return 4;
  const passo = 10 ** Math.floor(Math.log10(maior));
  const m = [1, 2, 2.5, 5, 10].find(x => x * passo >= maior);
  return Math.ceil(m * passo);
}

const legenda = series => (series.length < 2 ? '' : html`<div class="vg-legenda">${series.map(s => html`<span><i class="vg-${s.cls}"></i>${s.nome}</span>`)}</div>`);
const verDados = (cabecalho, linhas) => html`<details class="vg-dados"><summary>Ver dados</summary><div class="rolagem"><table class="lista"><thead><tr>${cabecalho.map(c => html`<th>${c}</th>`)}</tr></thead>
  <tbody>${linhas.map(l => html`<tr>${l.map(c => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div></details>`;

// cats: [{ rotulo, valores: [n por série] }]. empilhado soma as séries na mesma coluna
function colunas({ cats, series, titulo, empilhado = true, unidade = '', topo = null }) {
  const total = c => c.valores.reduce((s, v) => s + v, 0);
  const maximo = topo ?? topoEixo(Math.max(1, ...cats.map(c => (empilhado ? total(c) : Math.max(...c.valores)))));
  // divisões inteiras: contagem de pessoas não tem meio
  const partes = [4, 5, 2, 1].find(d => Number.isInteger(maximo / d));
  const marcas = Array.from({ length: partes + 1 }, (_, i) => (maximo / partes) * i);
  const altura = v => `${(v / maximo) * 100}%`;
  const dica = (c, s, v) => `${c.rotulo} · ${s.nome}: ${v}${unidade}${empilhado && total(c) ? ` (${pct(v, total(c))}%)` : ''}`;
  return html`<div class="vg" role="img" aria-label="${titulo}">${legenda(series)}
    <div class="vg-area"><div class="vg-plot">
      ${marcas.map(m => html`<span class="vg-linha ${m ? '' : 'base'}" style="bottom:${altura(m)}"><small>${m}${unidade}</small></span>`)}
      <div class="vg-cols" style="--n:${cats.length}">${cats.map(c => html`<div class="vg-col">${empilhado ? html`
        ${total(c) ? html`<b class="vg-topo" style="bottom:${altura(total(c))}">${total(c)}</b>` : ''}
        <div class="vg-pilha" style="height:${altura(total(c))}">${c.valores.map((v, i) => (v ? html`<i class="vg-${series[i].cls}" style="flex-grow:${v}" data-dica="${dica(c, series[i], v)}"></i>` : ''))}</div>` : html`
        <div class="vg-lado">${c.valores.map((v, i) => html`<i class="vg-${series[i].cls}" style="height:${altura(v)}" data-dica="${dica(c, series[i], v)}"></i>`)}</div>`}</div>`)}</div>
    </div>
    <div class="vg-rotulos" style="--n:${cats.length}">${cats.map(c => html`<span>${c.rotulo}</span>`)}</div></div></div>
    ${verDados(['', ...series.map(s => s.nome)], cats.map(c => [c.rotulo, ...c.valores.map(v => `${v}${unidade}`)]))}`;
}

// itens: [{ rotulo, valor, texto?, cls? }], com o valor na ponta da barra
function barrasH(itens, { maximo = null, vazio = 'Sem dados ainda.' } = {}) {
  if (!itens.length) return html`<p class="desc">${vazio}</p>`;
  const topo = maximo ?? Math.max(1, ...itens.map(i => i.valor));
  return html`<div class="vg-h">${itens.map(i => html`<div class="item" data-dica="${i.rotulo}: ${i.texto ?? i.valor}"><span>${i.rotulo}</span>
    <div class="trilho"><i class="vg-${i.cls || 's1'}" style="width:${pct(i.valor, topo)}%"></i></div><b>${i.texto ?? i.valor}</b></div>`)}</div>`;
}

// uma linha por grupo, cada uma somando 100%: compara a composição entre grupos
function barras100(itens, series, { vazio = 'Sem dados ainda.' } = {}) {
  if (!itens.length) return html`<p class="desc">${vazio}</p>`;
  const total = i => i.valores.reduce((s, v) => s + v, 0);
  return html`${legenda(series)}<div class="vg-100">${itens.map(i => html`<div class="item"><span>${i.rotulo}</span>
    <div class="faixa">${i.valores.map((v, n) => (v ? html`<i class="vg-${series[n].cls}" style="flex-grow:${v}" data-dica="${i.rotulo} · ${series[n].nome}: ${v} (${pct(v, total(i))}%)"></i>` : ''))}</div><b>${total(i)}</b></div>`)}</div>
    ${verDados(['', ...series.map(s => s.nome), 'Total'], itens.map(i => [i.rotulo, ...i.valores, total(i)]))}`;
}

// partes: [{ nome, cls, valor }] de um mesmo todo (valor em %)
const segmentada = partes => html`<div class="vg-seg">${partes.map(p => html`<i class="vg-${p.cls}" style="flex-grow:${p.valor}" data-dica="${p.nome}: ${p.valor}%"></i>`)}</div>`;

// uma razão contra o máximo: preenchido sobre a trilha da mesma cor
const medidor = (valor, nota) => html`<div class="vg-medidor"><b>${valor}%</b><div class="trilho"><i style="width:${valor}%"></i></div><span>${nota}</span></div>`;

module.exports = { colunas, barrasH, barras100, segmentada, medidor };

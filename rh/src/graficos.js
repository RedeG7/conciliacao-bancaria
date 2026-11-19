'use strict';
// Gráficos em HTML e CSS, sem biblioteca: acompanham a largura da tela sem
// encolher o texto. Cor vem de .vg-s1 a .vg-s4 (public/app.css); a dica ao
// passar o mouse sai de data-dica (public/app.js). Todo gráfico traz os mesmos
// números em tabela, em "Ver dados", para quem não distingue as cores.
const { html, n2 } = require('./views');

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

// 9box: quadros vem da matriz, com pessoas em cada quadrante. Filtros, seleção de
// quadrante e detalhe da pessoa rodam no navegador (public/app.js), a partir dos data-*.
const iniciais = n => { const p = n.split(/\s+/).filter(x => !/^(d[aeo]s?|e)$/i.test(x)); return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); };
const nomeCurto = n => { const p = n.split(/\s+/); return p.length > 2 ? `${p[0]} ${p[p.length - 1]}` : n; };
const NIVEL = ['Baixo', 'Médio', 'Alto'];
function noveBox(quadros, { semNota = 0 } = {}) {
  const todas = quadros.flat().flatMap(q => q.pessoas.map(p => ({ ...p, quadrante: q.nome })));
  if (!todas.length) return html`<div class="card"><p class="desc">Nenhuma avaliação com as duas notas neste ciclo.</p></div>`;
  const deptos = [...new Set(todas.map(p => p.departamento))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const num = v => String(v);
  const dadosPessoa = p => html`data-nome="${p.nome}" data-depto="${p.departamento}" data-c="${num(p.comportamento)}" data-d="${num(p.desempenho)}"`;
  const cartaoVivo = (rotulo, chave, sub) => html`<div class="card"><small>${rotulo}</small><b data-box9-n="${chave}">-</b><span>${sub}</span></div>`;
  return html`<div class="box9" data-box9>
    <div class="cards4">${cartaoVivo('Pessoas no quadro', 'total', 'Com as duas notas')}${cartaoVivo('Destaques', 'destaques', 'Comportamento e desempenho altos')}${cartaoVivo('Pedem atenção', 'atencao', 'Insuficientes, Verificar situação e Trabalhar valores')}${cartaoVivo('Média dos eixos', 'medias', 'Comportamento · Desempenho')}</div>
    ${semNota ? html`<div class="aviso alerta">${semNota} avaliação(ões) deste ciclo sem nota de comportamento não aparecem no quadro.</div>` : ''}
    <div class="box9-filtros nao-imprime">
      <input type="search" class="box9-busca" placeholder="Buscar pessoa" aria-label="Buscar pessoa">
      <select class="box9-depto" aria-label="Departamento"><option value="">Todos os departamentos</option>${deptos.map(d => html`<option>${d}</option>`)}</select>
      <button type="button" class="botao sec pequeno box9-limpar" hidden>Limpar filtros</button>
      <span class="box9-status" role="status"></span>
    </div>
    <div class="box9-painel">
      <div class="box9-area">
        <div class="box9-y" aria-hidden="true"><b>Comportamento</b><div>${[...NIVEL].reverse().map(n => html`<span>${n}</span>`)}</div></div>
        <div class="box9-grade">${quadros.map((linha, i) => linha.map((q, j) => html`<section class="box9-q t${q.tom}" data-q="${q.nome}" data-total="${q.pessoas.length}">
          <button type="button" class="box9-titulo" aria-pressed="false"><span>${q.nome}</span><b class="box9-conta">${q.pessoas.length}</b></button>
          <small class="box9-pos">Comportamento ${NIVEL[2 - i].toLowerCase()} · Desempenho ${NIVEL[j].toLowerCase()}</small>
          <ul>${q.pessoas.map(p => html`<li><button type="button" class="box9-pessoa" ${dadosPessoa(p)} data-cargo="${p.cargo}" data-quadrante="${q.nome}" data-ficha="${p.ficha}" data-relatorio="${p.relatorio}" data-pdi="${p.pdi}"
            data-dica="${p.nome} · Comportamento ${n2(p.comportamento)} · Desempenho ${n2(p.desempenho)}"><i aria-hidden="true">${iniciais(p.nome)}</i><span>${nomeCurto(p.nome)}</span></button></li>`)}</ul>
          <p class="box9-vazio" ${q.pessoas.length ? 'hidden' : ''}>Ninguém aqui</p></section>`))}</div>
        <div class="box9-x" aria-hidden="true"><div>${NIVEL.map(n => html`<span>${n}</span>`)}</div><b>Desempenho</b></div>
      </div>
      <details class="vg-dados"><summary>Ver dados</summary><div class="rolagem"><table class="lista"><thead><tr><th>Pessoa</th><th>Cargo</th><th>Departamento</th><th>Comportamento</th><th>Desempenho</th><th>Quadrante</th></tr></thead>
        <tbody>${todas.map(p => html`<tr ${dadosPessoa(p)} data-q="${p.quadrante}"><td>${p.nome}</td><td>${p.cargo}</td><td>${p.departamento}</td><td>${n2(p.comportamento)}</td><td>${n2(p.desempenho)}</td><td>${p.quadrante}</td></tr>`)}</tbody></table></div></details>
    </div>
    <dialog class="box9-detalhe" aria-labelledby="box9Nome">
      <button type="button" class="box9-fechar" aria-label="Fechar">×</button>
      <div class="box9-cabeca"><i aria-hidden="true" data-campo="iniciais"></i><div><h3 id="box9Nome" data-campo="nome"></h3><p data-campo="funcao"></p></div></div>
      <p class="box9-selo" data-campo="quadrante"></p>
      ${[['Comportamento', 'c'], ['Desempenho', 'd']].map(([r, k]) => html`<div class="box9-nota"><span>${r}</span><b data-campo="${k}"></b><div class="box9-trilho"><i data-barra="${k}"></i></div></div>`)}
      <p class="box9-legenda">Escala de 0 a 10. As marcas mostram os cortes de 5 e 8.</p>
      <div class="acoes"><a class="botao" data-link="relatorio">Ver relatório</a><a class="botao sec" data-link="ficha">Ficha</a><a class="botao sec" data-link="pdi">Criar PDI</a></div>
    </dialog>
  </div>`;
}

module.exports = { colunas, barrasH, barras100, segmentada, medidor, noveBox, iniciais };

'use strict';
// Telas e relatório do Profiler (perfil comportamental de uma pessoa): gráfico
// radar, barras por estilo, habilidades e indicadores, e o relatório em PDF.
// Tudo sai dos pontos calculados das respostas (src/comportamental.js).
const P = require('./comportamental');
const { Pdf, A4 } = require('./pdf');
const { html, raw, dataBr } = require('./views');
const SP = require('./solides_profiler');

const CORES = { realizador: '#2a78d6', conector: '#eb6834', constante: '#1baf7a', criterioso: '#eda100' };
const cls = e => `s${P.CHAVES.indexOf(e) + 1}`;
const nomeEstilo = e => P.ESTILOS[e]?.nome || '';
const iniciais = n => { const p = String(n || '?').split(/\s+/).filter(x => x && !/^(d[aeo]s?|e)$/i.test(x)); return ((p[0]?.[0] || '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); };

// selo colorido com o(s) estilo(s) do perfil
const selos = p => (p?.principal
  ? html`<span class="pf-selos">${[p.principal, p.secundario].filter(Boolean).map(e => html`<span class="pf-selo ${cls(e)}">${nomeEstilo(e)}</span>`)}</span>`
  : html`<span class="pf-selo vazio">Aguardando resposta</span>`);
const avatar = p => html`<span class="pf-avatar ${p.principal ? cls(p.principal) : ''}" aria-hidden="true">${iniciais(p.nome)}</span>`;

// ---------------------------------------------------------------- radar (SVG)
// eixos: Realizador no topo, Conector à direita, Constante embaixo, Criterioso à esquerda
const ANG = { realizador: -90, conector: 0, constante: 90, criterioso: 180 };
function ponto(cx, cy, r, e, v) {
  const a = (ANG[e] * Math.PI) / 180;
  return [cx + Math.cos(a) * r * (v / 100), cy + Math.sin(a) * r * (v / 100)];
}
function radar(pontos, { alvo = null, tamanho = 280 } = {}) {
  const c = tamanho / 2, r = c - 46;
  const poli = vals => P.CHAVES.map(e => ponto(c, c, r, e, vals[e]).map(n => n.toFixed(1)).join(',')).join(' ');
  const aneis = [20, 40, 60, 80, 100];
  const rotulo = e => {
    const [x, y] = ponto(c, c, r + 22, e, 100);
    const anc = e === 'conector' ? 'start' : e === 'criterioso' ? 'end' : 'middle';
    const dx = e === 'conector' ? -14 : e === 'criterioso' ? 14 : 0;
    return html`<text x="${(x + dx).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anc}" class="pf-radar-rot">${nomeEstilo(e)} <tspan class="pf-radar-num">${pontos[e]}</tspan></text>`;
  };
  return html`<svg class="pf-radar" viewBox="0 0 ${tamanho} ${tamanho}" role="img" aria-label="Gráfico radar: ${P.CHAVES.map(e => `${nomeEstilo(e)} ${pontos[e]}`).join(', ')}">
    ${aneis.map(a => html`<polygon points="${poli(Object.fromEntries(P.CHAVES.map(e => [e, a])))}" class="pf-radar-anel"/>`)}
    ${P.CHAVES.map(e => { const [x, y] = ponto(c, c, r, e, 100); return html`<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="pf-radar-eixo"/>`; })}
    ${alvo ? html`<polygon points="${poli(alvo)}" class="pf-radar-alvo"/>` : ''}
    <polygon points="${poli(pontos)}" class="pf-radar-area"/>
    ${P.CHAVES.map(e => { const [x, y] = ponto(c, c, r, e, pontos[e]); return html`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${CORES[e]}"><title>${nomeEstilo(e)}: ${pontos[e]}</title></circle>`; })}
    ${P.CHAVES.map(rotulo)}</svg>`;
}

// barra de 0 a 100 com faixas de fundo (Baixo até 39, Médio até 69, Alto)
const barraNivel = (rotulo, valor, estilo, extra = '') => html`<div class="pf-nivel" data-dica="${rotulo}: ${valor} (${P.faixa(valor)})">
  <div class="pf-nivel-topo"><span>${rotulo}${extra}</span><b>${valor}<small> · ${P.faixa(valor)}</small></b></div>
  <div class="pf-trilho"><i class="vg-${cls(estilo)}" style="width:${valor}%"></i><span style="left:40%"></span><span style="left:70%"></span></div></div>`;

// ---------------------------------------------------------------- tela "Visualizar Profiler"
function visualizar(p, { cargo = null, colab = null, menu = '' } = {}) {
  const est = P.ESTILOS[p.principal], sec = p.secundario ? P.ESTILOS[p.secundario] : null;
  const alvo = cargo?.perfil_esperado ? P.alvo(cargo.perfil_esperado) : null;
  const ind = P.indicadores(p.pontos), hab = P.habilidades(p.pontos).sort((a, b) => b.valor - a.valor);
  const ordem = [...P.CHAVES].sort((a, b) => p.pontos[b] - p.pontos[a]);
  return html`<div class="pf-cabeca card">
      ${avatar(p)}
      <div class="pf-cabeca-txt"><h2>${p.nome}</h2>
        <p>${[colab?.cargo, colab?.departamento, p.vinculo].filter(Boolean).join(' · ')}</p>
        ${selos(p)}</div>
      <div class="pf-cabeca-dados"><small>Respondido em</small><b>${dataBr(p.data_resposta)}</b>${alvo ? html`<small>Aderência a ${cargo.nome}</small><b>${P.aderencia(p.pontos, alvo)}%</b>` : ''}</div>
      ${menu}
    </div>
    <div class="abas-form pf-abas"><button type="button" data-aba="resumo" class="ativo">Resumo do perfil</button><button type="button" data-aba="habilidades">Habilidades</button><button type="button" data-aba="graficos">Gráficos</button><button type="button" data-aba="gestao">Como trabalhar com ${p.nome.split(' ')[0]}</button>${p.solides ? html`<button type="button" data-aba="importado">Resultado importado</button>` : ''}</div>

    <div data-painel="resumo">
      <div class="pf-grade">
        <div class="card"><h3 class="primeiro">Perfil ${P.nomePerfil(p)}</h3><p>${est.resumo}${sec ? ` Também traz traços de ${sec.nome}: ${sec.resumo.charAt(0).toLowerCase()}${sec.resumo.slice(1)}` : ''}</p>
          ${radar(p.pontos, { alvo })}
          ${alvo ? html`<p class="desc pf-legenda-radar"><i class="pf-l-area"></i> Pessoa <i class="pf-l-alvo"></i> Esperado para ${cargo.nome}</p>` : ''}</div>
        <div class="card"><h3 class="primeiro">Pontuação por estilo</h3><p class="desc">De 0 a 100. Até 39 é baixo, de 40 a 69 médio e a partir de 70 alto.</p>
          ${ordem.map(e => barraNivel(nomeEstilo(e), p.pontos[e], e, e === p.principal ? html` <em class="pf-tag">principal</em>` : e === p.secundario ? html` <em class="pf-tag">secundário</em>` : ''))}
          <h3>Indicadores</h3>
          <div class="pf-ind">
            <div><b>${ind.intensidade}</b><span>Intensidade</span><small>Quanto o estilo principal se destaca dos outros.</small></div>
            <div><b>${ind.equilibrio}</b><span>Equilíbrio</span><small>Quanto mais alto, mais parecidos são os 4 estilos.</small></div>
            <div><b>${ind.media}</b><span>Média geral</span><small>Média dos 4 estilos.</small></div>
          </div></div>
      </div>
      <div class="pf-grade">
        <div class="card"><h3 class="primeiro">Pontos fortes</h3><ul class="pf-lista ok">${[...est.fortes, ...(sec ? sec.fortes.slice(0, 1) : [])].map(t => html`<li>${t}</li>`)}</ul></div>
        <div class="card"><h3 class="primeiro">Pontos de atenção</h3><ul class="pf-lista atencao">${est.cuidados.map(t => html`<li>${t}</li>`)}</ul></div>
      </div>
    </div>

    <div data-painel="habilidades" hidden><div class="card"><h3 class="primeiro">Habilidades</h3>
      <p class="desc">Cada habilidade combina os pontos dos estilos que mais pesam nela, a partir das respostas da pessoa.</p>
      <div class="pf-hab">${hab.map(h => barraNivel(h.nome, h.valor, h.estilo))}</div></div></div>

    <div data-painel="graficos" hidden><div class="pf-grade">
      <div class="card"><h3 class="primeiro">Radar dos estilos</h3>${radar(p.pontos, { alvo, tamanho: 320 })}</div>
      <div class="card"><h3 class="primeiro">Composição do perfil</h3><p class="desc">Peso de cada estilo na soma dos pontos.</p>
        ${(() => {
          const soma = P.CHAVES.reduce((s, e) => s + p.pontos[e], 0) || 1;
          return html`<div class="vg-seg">${P.CHAVES.map(e => html`<i class="vg-${cls(e)}" style="flex-grow:${p.pontos[e]}" data-dica="${nomeEstilo(e)}: ${Math.round((p.pontos[e] / soma) * 100)}%"></i>`)}</div>
          <div class="vg-pesos">${P.CHAVES.map(e => html`<div><i class="vg-${cls(e)}"></i><b>${Math.round((p.pontos[e] / soma) * 100)}%</b><span>${nomeEstilo(e)}</span></div>`)}</div>`;
        })()}
        <h3>Habilidades em destaque</h3>${hab.slice(0, 5).map(h => barraNivel(h.nome, h.valor, h.estilo))}</div>
    </div></div>

    <div data-painel="gestao" hidden><div class="pf-grade">
      <div class="card"><h3 class="primeiro">Como apoiar</h3><p>${est.gestao}</p>${sec ? html`<p>${sec.gestao}</p>` : ''}</div>
      <div class="card"><h3 class="primeiro">Ambiente em que rende mais</h3><ul class="pf-lista ok">${AMBIENTE[p.principal].map(t => html`<li>${t}</li>`)}</ul></div>
    </div></div>
    ${p.solides ? importado(p) : ''}`;
}
// aba com o resultado como veio da Sólides (percentuais, energia, indicadores e habilidades)
function importado(p) {
  const s = p.solides, ordem = [...P.CHAVES].sort((a, b) => (s.percentuais[b] ?? 0) - (s.percentuais[a] ?? 0));
  const n1 = v => (v == null ? '-' : String(Math.round(v * 10) / 10).replace('.', ','));
  const hab = SP.HABILIDADES.filter(([k]) => s.habilidades?.[k] != null).map(([k, nome]) => ({ nome, valor: s.habilidades[k] })).sort((a, b) => b.valor - a.valor);
  return html`<div data-painel="importado" hidden>
    <div class="pf-grade">
      <div class="card"><h3 class="primeiro">Composição do perfil${s.letra ? html` <em class="pf-tag">${s.letra}</em>` : ''}</h3>
        <p class="desc">Percentual de cada estilo no resultado importado. Os pontos das outras abas saem destes percentuais: o estilo mais forte vale 80.</p>
        <div class="vg-seg">${P.CHAVES.map(e => html`<i class="vg-${cls(e)}" style="flex-grow:${s.percentuais[e] || 0}" data-dica="${nomeEstilo(e)}: ${n1(s.percentuais[e])}%"></i>`)}</div>
        <div class="vg-pesos">${ordem.map(e => html`<div><i class="vg-${cls(e)}"></i><b>${n1(s.percentuais[e])}%</b><span>${nomeEstilo(e)}</span></div>`)}</div>
        <h3>Natural e adaptado</h3><p class="desc">Como a pessoa é e como se adapta ao que o ambiente cobra.</p>
        <table class="pf-tab-mini"><thead><tr><th>Estilo</th><th>Natural</th><th>Adaptado</th><th>Energia</th></tr></thead>
          <tbody>${ordem.map(e => html`<tr><td><i class="pf-ponto vg-${cls(e)}"></i>${nomeEstilo(e)}</td><td>${n1(s.natural?.[e])}</td><td>${n1(s.adaptado?.[e])}</td><td>${s.energia?.[e] ?? '-'}</td></tr>`)}</tbody></table></div>
      <div class="card"><h3 class="primeiro">Indicadores</h3><p class="desc">Níveis como vieram no resultado importado.</p>
        <div class="pf-ind pf-ind-sol">${SP.INDICADORES.filter(([k]) => s.indicadores?.[k] != null).map(([k, nome]) => html`<div><b>${s.indicadores[k]}</b><span>${nome}</span></div>`)}</div>
        ${s.tempo ? html`<p class="desc">Tempo de resposta do questionário: ${Math.floor(s.tempo / 60)} min ${s.tempo % 60} s.</p>` : ''}
        ${s.cargo || s.departamento ? html`<p class="desc">Cargo no resultado: ${[s.cargo, s.departamento].filter(Boolean).join(' · ')}</p>` : ''}</div>
    </div>
    ${hab.length ? html`<div class="card"><h3 class="primeiro">Habilidades do resultado importado</h3><p class="desc">De 0 a 100.</p>
      <div class="pf-hab">${hab.map(h => barraNivel(h.nome, h.valor, p.principal))}</div></div>` : ''}
  </div>`;
}
const AMBIENTE = {
  realizador: ['Metas claras e desafiadoras', 'Autonomia para decidir o caminho', 'Retorno rápido sobre resultados'],
  conector: ['Contato frequente com pessoas', 'Espaço para expor ideias', 'Reconhecimento público'],
  constante: ['Rotina previsível', 'Equipe estável e colaborativa', 'Mudanças avisadas com antecedência'],
  criterioso: ['Processos e padrões definidos', 'Tempo para analisar antes de decidir', 'Informação completa e precisa'],
};

// ---------------------------------------------------------------- relatório em PDF
function relatorioPdf(p, { cargo = null, colab = null, escritorio = '', aviso = '' } = {}) {
  const doc = new Pdf().pagina();
  const M = 44, L = A4.w - 2 * M;
  const est = P.ESTILOS[p.principal], sec = p.secundario ? P.ESTILOS[p.secundario] : null;
  const alvo = cargo?.perfil_esperado ? P.alvo(cargo.perfil_esperado) : null;
  let y = 0;
  const cabecalho = () => {
    doc.ret(0, 0, A4.w, 70, '#0f1f17');
    doc.texto(M, 32, 'Relatório de Perfil Comportamental', { corpo: 17, negrito: true, cor: '#ffffff' });
    doc.texto(M, 52, escritorio || 'RH', { corpo: 10, cor: '#cfe9d9' });
    doc.texto(A4.w - M, 52, `Gerado em ${dataBr(new Date().toISOString())}`, { corpo: 9, cor: '#cfe9d9', alinha: 'dir' });
    y = 96;
  };
  const cabe = h => { if (y + h > A4.h - 60) { doc.pagina(); cabecalho(); } };
  const titulo = t => { cabe(40); doc.texto(M, y, t, { corpo: 13, negrito: true, cor: '#0f7a37' }); doc.linha(M, y + 6, M + L, y + 6, '#bbf7d0', 1); y += 24; };
  const paragrafo = (t, { corpo = 10, x = M, largura = L, cor: c = '#1d2733' } = {}) => {
    for (const l of doc.quebrar(t, corpo, largura)) { cabe(corpo + 5); doc.texto(x, y, l, { corpo, cor: c }); y += corpo + 5; }
  };
  const barra = (rot, v, estilo, x = M, largura = L) => {
    cabe(28);
    doc.texto(x, y, rot, { corpo: 9.5 });
    doc.texto(x + largura, y, `${v} · ${P.faixa(v)}`, { corpo: 9.5, negrito: true, alinha: 'dir' });
    doc.ret(x, y + 5, largura, 7, '#e5e9ee');
    doc.ret(x, y + 5, (largura * v) / 100, 7, CORES[estilo]);
    for (const m of [40, 70]) doc.linha(x + (largura * m) / 100, y + 4, x + (largura * m) / 100, y + 13, '#ffffff', 1.2);
    y += 26;
  };

  cabecalho();
  // identificação
  doc.ret(M, y - 14, L, 62, '#f4f6f8');
  doc.texto(M + 12, y + 4, p.nome, { corpo: 15, negrito: true });
  doc.texto(M + 12, y + 22, [colab?.cargo, colab?.departamento, p.vinculo].filter(Boolean).join(' · '), { corpo: 9.5, cor: '#5f6b7a' });
  doc.texto(M + 12, y + 38, `Respondido em ${dataBr(p.data_resposta)}${p.email ? ` · ${p.email}` : ''}`, { corpo: 9.5, cor: '#5f6b7a' });
  doc.texto(M + L - 12, y + 4, P.nomePerfil(p), { corpo: 12, negrito: true, cor: CORES[p.principal], alinha: 'dir' });
  if (alvo) doc.texto(M + L - 12, y + 22, `Aderência a ${cargo.nome}: ${P.aderencia(p.pontos, alvo)}%`, { corpo: 9.5, alinha: 'dir' });
  y += 70;

  titulo('Resumo do perfil');
  paragrafo(`${est.resumo}${sec ? ` Também traz traços de ${sec.nome}: ${sec.resumo.charAt(0).toLowerCase()}${sec.resumo.slice(1)}` : ''}`);
  y += 8;

  // radar à esquerda, barras à direita
  cabe(210);
  const cx = M + 100, cy = y + 95, r = 72;
  for (const a of [20, 40, 60, 80, 100]) doc.poligono(P.CHAVES.map(e => ponto(cx, cy, r, e, a)), { traco: '#d5dbe2', espessura: 0.5 });
  for (const e of P.CHAVES) { const [x2, y2] = ponto(cx, cy, r, e, 100); doc.linha(cx, cy, x2, y2, '#d5dbe2', 0.5); }
  if (alvo) doc.poligono(P.CHAVES.map(e => ponto(cx, cy, r, e, alvo[e])), { traco: '#5f6b7a', espessura: 1, tracejado: true });
  doc.poligono(P.CHAVES.map(e => ponto(cx, cy, r, e, p.pontos[e])), { preenche: '#bfe3cc', traco: '#16a34a', espessura: 1.5 });
  for (const e of P.CHAVES) {
    const [x, yy] = ponto(cx, cy, r + 14, e, 100);
    const al = e === 'conector' ? 'esq' : e === 'criterioso' ? 'dir' : 'centro';
    doc.texto(x + (e === 'conector' ? -8 : e === 'criterioso' ? 8 : 0), yy + (e === 'realizador' ? -2 : e === 'constante' ? 8 : 3), `${nomeEstilo(e)} ${p.pontos[e]}`, { corpo: 8.5, negrito: true, alinha: al, cor: CORES[e] });
  }
  const topo = y;
  y = topo + 18;
  const bx = M + 230, bl = L - 230;
  doc.texto(bx, topo + 4, 'Pontuação por estilo (0 a 100)', { corpo: 10, negrito: true });
  for (const e of [...P.CHAVES].sort((a, b) => p.pontos[b] - p.pontos[a])) barra(nomeEstilo(e), p.pontos[e], e, bx, bl);
  const ind = P.indicadores(p.pontos);
  doc.texto(bx, y + 4, `Intensidade ${ind.intensidade}  ·  Equilíbrio ${ind.equilibrio}  ·  Média ${ind.media}`, { corpo: 9, cor: '#5f6b7a' });
  y = Math.max(y + 20, topo + 206);
  if (alvo) { doc.texto(M, y, `Linha tracejada no radar: perfil esperado para ${cargo.nome}.`, { corpo: 8.5, cor: '#5f6b7a' }); y += 10; }
  y += 14;

  titulo('Habilidades');
  const hab = P.habilidades(p.pontos).sort((a, b) => b.valor - a.valor);
  const meio = Math.ceil(hab.length / 2), col = (L - 24) / 2, y0 = y;
  cabe(meio * 26);
  let yEsq = y0, yDir = y0;
  hab.forEach((h, i) => {
    if (i < meio) { y = yEsq; barra(h.nome, h.valor, h.estilo, M, col); yEsq = y; } else { y = yDir; barra(h.nome, h.valor, h.estilo, M + col + 24, col); yDir = y; }
  });
  y = Math.max(yEsq, yDir) + 6;

  // duas colunas: título + itens em cada uma
  const colunas2 = (esq, dir) => {
    const col2 = (L - 24) / 2;
    cabe(60);
    const y0 = y;
    const bloco = ([t, itens, marca], x) => {
      y = y0;
      doc.texto(x, y, t, { corpo: 12, negrito: true, cor: '#0f7a37' }); doc.linha(x, y + 6, x + col2, y + 6, '#bbf7d0', 1); y += 22;
      for (const it of itens) {
        if (marca) doc.texto(x + 2, y, marca, { corpo: 10, negrito: true, cor: marca === '!' ? '#b45309' : '#16a34a' });
        for (const l of doc.quebrar(it, 9.5, col2 - 14)) { doc.texto(x + 14, y, l, { corpo: 9.5 }); y += 14; }
        y += 3;
      }
      return y;
    };
    y = Math.max(bloco(esq, M), bloco(dir, M + col2 + 24)) + 10;
  };
  colunas2(['Pontos fortes', [...est.fortes, ...(sec ? sec.fortes.slice(0, 1) : [])], '+'], ['Pontos de atenção', est.cuidados, '!']);
  colunas2(['Como apoiar', [est.gestao, ...(sec ? [sec.gestao] : [])], ''], ['Ambiente em que rende mais', AMBIENTE[p.principal], '+']);

  // rodapé em todas as páginas
  const total = doc.paginas.length;
  doc.paginas.forEach((pg, i) => {
    doc.atual = pg;
    doc.linha(M, A4.h - 44, A4.w - M, A4.h - 44, '#dfe4ea', 0.6);
    doc.quebrar(aviso, 7.5, L - 60).forEach((l, n) => doc.texto(M, A4.h - 32 + n * 9, l, { corpo: 7.5, cor: '#5f6b7a' }));
    doc.texto(A4.w - M, A4.h - 32, `Página ${i + 1} de ${total}`, { corpo: 7.5, cor: '#5f6b7a', alinha: 'dir' });
  });
  return doc.gerar();
}

module.exports = { CORES, iniciais, selos, avatar, radar, visualizar, relatorioPdf };

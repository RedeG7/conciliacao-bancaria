'use strict';
// Os tipos de simulação: rota, título, formulário, leitura do formulário,
// cálculo (src/calc.js), resultado e colunas da lista.
const calc = require('./calc');
const { UFS, DESTINACOES, TIPOS_OBRA, CATEGORIAS, AREAS_COMPLEMENTARES } = require('./params');
const { html, raw, brl, n2, dataBr, select, campo } = require('./views');

const arr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const opcoesParam = (P, tabela) => P.list(tabela).map(l => l.chave);

// ------------------------------------------------------------------ campos
const inp = (name, v, attrs = '') => html`<input name="${name}" value="${v ?? ''}" ${raw(attrs)}>`;
const dinheiro = (name, v, req = true) => inp(name, v, `inputmode="decimal" placeholder="0,00" ${req ? 'required' : ''}`);
const data = (name, v, req = false) => inp(name, v, `type="date" ${req ? 'required' : ''}`);

function camposPredial(d, P) {
  const dest = d.destinacoes?.length ? d.destinacoes : [{}];
  const comp = d.complementares || [];
  const linhaDest = x => html`<div class="linha-rep">
    ${campo('Destinação', select('dest_destinacao', DESTINACOES, x.destinacao))}
    ${campo('Tipo de obra', select('dest_tipo_obra', TIPOS_OBRA, x.tipo_obra))}
    ${campo('Categoria', select('dest_categoria', CATEGORIAS, x.categoria))}
    ${campo('Concreto usinado', select('dest_concreto', [['0', 'Não'], ['1', 'Sim']], x.concreto_usinado ? '1' : '0'))}
    ${campo('Área (m²)', inp('dest_area', x.area, 'inputmode="decimal" required'))}
    <button type="button" class="botao sec pequeno remover-linha" aria-label="Remover destinação">✕</button></div>`;
  const linhaComp = x => html`<div class="linha-rep">
    ${campo('Tipo', select('comp_tipo', AREAS_COMPLEMENTARES, x.tipo))}
    ${campo('Cobertura', select('comp_coberta', [['1', 'Coberta'], ['0', 'Descoberta']], x.coberta === false ? '0' : '1'))}
    ${campo('Área (m²)', inp('comp_area', x.area, 'inputmode="decimal"'))}
    <button type="button" class="botao sec pequeno remover-linha" aria-label="Remover área">✕</button></div>`;
  return html`
  <div class="grade">
    ${campo('UF *', select('uf', [['', 'Selecione'], ...UFS], d.uf, 'required'))}
    ${campo('Tipo do responsável *', select('tipo_responsavel', [['PF', 'Pessoa Física'], ['PJ', 'Pessoa Jurídica']], d.tipo_responsavel))}
    ${campo('Utilizou NF de pré-moldado acima de 40% do COD? *', select('premoldado', [['0', 'Não'], ['1', 'Sim']], d.premoldado ? '1' : '0'))}
    ${campo('Data de início da obra', data('data_inicio', d.data_inicio))}
    ${campo('Data de término da obra', data('data_fim', d.data_fim))}
    ${campo('Área principal (m²)', inp('area_principal', d.area_principal, 'inputmode="decimal"'))}
  </div>
  <h3>Destinações</h3>
  <div class="repetidor" data-modelo="modeloDest">${dest.map(linhaDest)}</div>
  <template id="modeloDest">${linhaDest({})}</template>
  <button type="button" class="botao sec pequeno adicionar-linha" data-alvo="modeloDest">+ Adicionar destinação</button>
  <h3>Áreas complementares</h3>
  <div class="repetidor" data-modelo="modeloComp">${comp.map(linhaComp)}</div>
  <template id="modeloComp">${linhaComp({})}</template>
  <button type="button" class="botao sec pequeno adicionar-linha" data-alvo="modeloComp">+ Adicionar área complementar</button>`;
}

function lerPredial(b) {
  const dest = arr(b.dest_destinacao).map((x, i) => ({
    destinacao: x, tipo_obra: arr(b.dest_tipo_obra)[i], categoria: arr(b.dest_categoria)[i],
    concreto_usinado: arr(b.dest_concreto)[i] === '1', area: calc.num(arr(b.dest_area)[i]),
  }));
  const comp = arr(b.comp_tipo).map((x, i) => ({ tipo: x, coberta: arr(b.comp_coberta)[i] !== '0', area: calc.num(arr(b.comp_area)[i]) }))
    .filter(c => c.area > 0);
  return {
    uf: b.uf, tipo_responsavel: b.tipo_responsavel === 'PJ' ? 'PJ' : 'PF', premoldado: b.premoldado === '1',
    data_inicio: b.data_inicio || '', data_fim: b.data_fim || '', area_principal: calc.num(b.area_principal),
    destinacoes: dest, complementares: comp,
  };
}

function resultadoPredial(r) {
  return html`
  <div class="cards3">
    <div class="card destaque"><small>INSS estimado da obra</small><b>${brl(r.inss)}</b><span>${n2(r.aliquota_total)}% sobre a RMT</span></div>
    <div class="card"><small>RMT (remuneração da mão de obra total)</small><b>${brl(r.rmt)}</b></div>
    <div class="card"><small>Custo da obra (COD)</small><b>${brl(r.cod_total)}</b><span>${n2(r.area_total)} m² · ${r.uf} · ref. ${r.referencia}</span></div>
  </div>
  <div class="card"><h3>Memória de cálculo</h3><div class="rolagem"><table class="lista">
    <thead><tr><th>Item</th><th>Tipo de obra</th><th>Área equivalente</th><th>VAU (vigência)</th><th>Red. concreto</th><th>COD</th><th>% M.O.</th><th>RMT</th></tr></thead>
    <tbody>${r.linhas.map(l => html`<tr><td>${l.rotulo}</td><td>${l.tipo_obra}</td><td>${n2(l.area)} m²</td><td>${brl(l.vau)} (${l.vigencia || '-'})</td><td>${l.red_concreto ? n2(l.red_concreto) + '%' : '-'}</td><td>${brl(l.cod)}</td><td>${n2(l.pct_mo)}%</td><td>${brl(l.rmt)}</td></tr>`)}</tbody>
  </table></div>
  <table class="resumo">${r.etapas.map(e => html`<tr><td>${e.rotulo}</td><td>${brl(e.valor)}</td></tr>`)}
    ${r.aliquotas.map(a => html`<tr class="leve"><td>${a.nome} (${n2(a.valor)}%)</td><td>${brl(r.rmt * a.valor / 100)}</td></tr>`)}
    <tr class="total"><td>INSS estimado</td><td>${brl(r.inss)}</td></tr></table></div>`;
}

// fator de ajuste: eSocial / GFIP / GPS espontânea têm o mesmo cálculo
function camposFator(gps) {
  return d => html`<div class="grade">
    ${campo('RMT (R$) *', dinheiro('rmt', d.rmt))}
    ${campo('Remuneração já declarada (R$)', dinheiro('remuneracao_declarada', d.remuneracao_declarada, false))}
    ${campo('Área (m²)', inp('area', d.area, 'inputmode="decimal"'))}
    ${campo('Início', data('data_inicio', d.data_inicio))}
    ${campo('Fim', data('data_fim', d.data_fim))}
    ${gps ? html`${campo('Rua / endereço da obra', inp('rua', d.rua))}${campo('CNO', inp('cno', d.cno))}
      ${campo('Competência', inp('competencia', d.competencia, 'type="month"'))}${campo('Vencimento', data('vencimento', d.vencimento))}` : ''}
    ${campo('Honorários (R$)', dinheiro('honorarios', d.honorarios, false))}</div>`;
}
const lerFator = b => ({
  rmt: calc.num(b.rmt), remuneracao_declarada: calc.num(b.remuneracao_declarada), area: calc.num(b.area),
  data_inicio: b.data_inicio || '', data_fim: b.data_fim || '', rua: b.rua || '', cno: b.cno || '',
  competencia: b.competencia || '', vencimento: b.vencimento || '', honorarios: calc.num(b.honorarios),
});
const resultadoFator = r => html`
  <div class="cards3">
    <div class="card destaque"><small>INSS com fator de ajuste</small><b>${brl(r.inss)}</b><span>${r.aplica_fator ? 'Fator de ajuste aplicado' : 'Remuneração declarada abaixo do mínimo'}</span></div>
    <div class="card"><small>INSS sem fator de ajuste</small><b>${brl(r.inss_sem_fator)}</b><span>Economia: ${brl(r.inss_sem_fator - r.inss)}</span></div>
    <div class="card"><small>Falta declarar para atingir ${n2(r.minimo_pct)}% da RMT</small><b>${brl(r.falta_para_minimo)}</b><span>INSS sobre isso: ${brl(r.inss_para_atingir_minimo)}</span></div>
  </div>
  <div class="card"><table class="resumo">
    <tr><td>RMT</td><td>${brl(r.rmt)}</td></tr>
    <tr><td>Remuneração mínima (${n2(r.minimo_pct)}% da RMT)</td><td>${brl(r.minimo_valor)}</td></tr>
    <tr><td>Remuneração já declarada</td><td>${brl(r.remuneracao_declarada)}</td></tr>
    <tr><td>Diferença (RMT - declarada)</td><td>${brl(r.diferenca)}</td></tr>
    <tr><td>Remuneração apurada ${r.aplica_fator ? `(redução de ${n2(r.reducao_pct)}%)` : ''}</td><td>${brl(r.remuneracao_apurada)}</td></tr>
    <tr class="leve"><td>Alíquota total</td><td>${n2(r.aliquota_total)}%</td></tr>
    ${r.honorarios ? html`<tr class="leve"><td>Honorários</td><td>${brl(r.honorarios)}</td></tr>` : ''}
    <tr class="total"><td>INSS a recolher</td><td>${brl(r.inss)}</td></tr></table></div>`;

function camposPj(medicao) {
  return (d, P) => html`<div class="grade">
    ${campo('Conformidade fiscal', select('conformidade', ['Regular', 'Com pendências'], d.conformidade))}
    ${campo('Regime tributário *', select('regime', opcoesParam(P, 'regime'), d.regime))}
    ${campo('Serviço contratado *', select('servico', opcoesParam(P, 'servico_pj'), d.servico))}
    ${medicao ? '' : campo('Valor do contrato (R$) *', dinheiro('valor_contrato', d.valor_contrato))}
    ${campo('Início', data('data_inicio', d.data_inicio))}${campo('Término', data('data_fim', d.data_fim))}
    ${campo('Honorários (R$)', dinheiro('honorarios', d.honorarios, false))}</div>
    ${medicao ? html`<h3>Medições (uma NF por medição)</h3>
      <div class="repetidor">${(d.medicoes?.length ? d.medicoes : [{}]).map(m => linhaMed(m))}</div>
      <template id="modeloMed">${linhaMed({})}</template>
      <button type="button" class="botao sec pequeno adicionar-linha" data-alvo="modeloMed">+ Adicionar medição</button>` : ''}`;
}
const linhaMed = m => html`<div class="linha-rep">${campo('Descrição', inp('med_descricao', m.descricao, 'placeholder="Medição 1"'))}
  ${campo('Valor da NF (R$)', dinheiro('med_valor', m.valor))}<button type="button" class="botao sec pequeno remover-linha" aria-label="Remover medição">✕</button></div>`;
const lerPj = b => ({
  conformidade: b.conformidade || '', regime: b.regime, servico: b.servico, valor_contrato: calc.num(b.valor_contrato),
  data_inicio: b.data_inicio || '', data_fim: b.data_fim || '', honorarios: calc.num(b.honorarios),
  medicoes: arr(b.med_valor).map((v, i) => ({ descricao: arr(b.med_descricao)[i] || `Medição ${i + 1}`, valor: calc.num(v) })).filter(m => m.valor > 0),
});
const resultadoPj = r => html`
  <div class="cards3">
    <div class="card destaque"><small>Retenção de INSS na NF</small><b>${brl(r.retencao)}</b><span>${n2(r.aliquota)}% sobre a base · ${r.regime}</span></div>
    <div class="card"><small>Valor total das notas</small><b>${brl(r.valor_total)}</b></div>
    <div class="card"><small>Base de cálculo (${n2(r.pct_base)}%)</small><b>${brl(r.base_total)}</b><span>${r.servico}</span></div>
  </div>
  <div class="card"><table class="lista"><thead><tr><th>Nota / medição</th><th>Valor</th><th>Base</th><th>Retenção</th></tr></thead>
  <tbody>${r.linhas.map(l => html`<tr><td>${l.descricao}</td><td>${brl(l.valor)}</td><td>${brl(l.base)}</td><td>${brl(l.retencao)}</td></tr>`)}</tbody></table>
  <table class="resumo"><tr><td>Líquido a receber pela contratada</td><td>${brl(r.liquido)}</td></tr>
  ${r.honorarios ? html`<tr class="leve"><td>Honorários</td><td>${brl(r.honorarios)}</td></tr>` : ''}</table></div>`;

const camposDecadencia = (d, P) => html`<div class="grade">
  ${campo('RMT (R$) *', dinheiro('rmt', d.rmt))}
  ${campo('Início da obra *', data('data_inicio', d.data_inicio, true))}
  ${campo('Término da obra *', data('data_fim', d.data_fim, true))}
  ${campo('Regime tributário', select('regime', ['', ...opcoesParam(P, 'regime'), 'Pessoa Física'], d.regime))}
  ${campo('Honorários (R$)', dinheiro('honorarios', d.honorarios, false))}</div>`;
const lerDecadencia = b => ({ rmt: calc.num(b.rmt), data_inicio: b.data_inicio, data_fim: b.data_fim, regime: b.regime || '', honorarios: calc.num(b.honorarios) });
const resultadoDecadencia = r => html`
  <div class="cards3">
    <div class="card destaque"><small>INSS exigível</small><b>${brl(r.inss)}</b><span>${r.meses_exigiveis} de ${r.meses} competências</span></div>
    <div class="card"><small>INSS sem considerar a decadência</small><b>${brl(r.inss_sem_decadencia)}</b></div>
    <div class="card"><small>Economia pela decadência</small><b>${brl(r.economia)}</b><span>${r.meses_decaidos} competência(s) decaída(s)</span></div>
  </div>
  <div class="card"><table class="resumo">
    <tr><td>Período da obra</td><td>${r.primeira} a ${r.ultima} (${r.meses} meses)</td></tr>
    <tr><td>Prazo decadencial</td><td>${r.prazo_anos} anos - decaídas as competências até 12/${r.ultimo_ano_decaido}</td></tr>
    <tr><td>RMT total</td><td>${brl(r.rmt)}</td></tr><tr><td>RMT decaída</td><td>${brl(r.rmt_decaida)}</td></tr>
    <tr><td>RMT exigível</td><td>${brl(r.rmt_exigivel)}</td></tr><tr class="leve"><td>Alíquota total</td><td>${n2(r.aliquota_total)}%</td></tr>
    <tr class="total"><td>INSS exigível</td><td>${brl(r.inss)}</td></tr></table></div>`;

const camposParcelamento = d => html`<div class="grade">
  ${campo('Valor do débito (R$) *', dinheiro('debito', d.debito))}
  ${campo('Nº de parcelas *', inp('parcelas', d.parcelas || 60, 'type="number" min="1" max="60" required'))}
  ${campo('Contribuinte', select('tipo_responsavel', [['PF', 'Pessoa Física'], ['PJ', 'Pessoa Jurídica']], d.tipo_responsavel))}
  ${campo('Selic mensal projetada (%) - vazio = média da tabela', inp('selic_mensal', d.selic_mensal || '', 'inputmode="decimal"'))}
  ${campo('Honorários (R$)', dinheiro('honorarios', d.honorarios, false))}</div>`;
const lerParcelamento = b => ({ debito: calc.num(b.debito), parcelas: calc.num(b.parcelas), tipo_responsavel: b.tipo_responsavel === 'PJ' ? 'PJ' : 'PF', selic_mensal: calc.num(b.selic_mensal), honorarios: calc.num(b.honorarios) });
const resultadoParcelamento = r => html`
  <div class="cards3">
    <div class="card destaque"><small>Parcela média estimada</small><b>${brl(r.parcela_media)}</b><span>${r.parcelas_qtd} parcelas</span></div>
    <div class="card"><small>Total estimado pago</small><b>${brl(r.total)}</b><span>Juros: ${brl(r.juros_total)}</span></div>
    <div class="card"><small>Selic projetada</small><b>${n2(r.selic_mensal)}% a.m.</b><span>${n2(r.selic_anual)}% a.a. · ${r.fonte_selic}</span></div>
  </div>
  <div class="card"><h3>Parcelas (parcela básica ${brl(r.parcela_basica)})</h3><div class="rolagem"><table class="lista"><thead><tr><th>Parcela</th><th>Acréscimo</th><th>Valor estimado</th></tr></thead>
  <tbody>${r.parcelas.map(p => html`<tr><td>${p.n}</td><td>${n2(p.acrescimo_pct)}%</td><td>${brl(p.valor)}</td></tr>`)}</tbody></table></div></div>`;

const statusCol = s => html`<span class="selo">${s.status}</span>`;
const KINDS = {
  predial: {
    slug: 'obras-prediais', titulo: 'Obras prediais', descricao: 'Aferição indireta do INSS da obra (área × VAU, destinação, tipo, categoria, fator social).',
    campos: camposPredial, ler: lerPredial, calcular: calc.predial, resultado: resultadoPredial,
    colunas: ['Identificação', 'Cliente', 'E-mail', 'Telefone', 'RMT', 'INSS estimado', 'Realizado em', 'Status'],
    linha: s => [s.identifier, s.cliente, s.email, s.telefone, brl(s.r.rmt), brl(s.r.inss), dataBr(s.created_at), statusCol(s)],
  },
  esocial: {
    slug: 'fator-de-ajuste-e-social', titulo: 'Fator de ajuste eSocial', descricao: 'Diferença entre a RMT e a remuneração declarada no eSocial/DCTFWeb, com o fator de ajuste.',
    campos: camposFator(false), ler: lerFator, calcular: calc.fatorAjuste, resultado: resultadoFator,
    colunas: ['Cliente', 'Área', 'RMT informado', 'Honorários', 'Início', 'Fim', 'Status'],
    linha: s => [s.cliente, n2(s.i.area) + ' m²', brl(s.i.rmt), brl(s.i.honorarios), dataBr(s.i.data_inicio), dataBr(s.i.data_fim), statusCol(s)],
  },
  gfip: {
    slug: 'fator-de-ajuste-gfip', titulo: 'Fator de ajuste GFIP', descricao: 'Fator de ajuste para obras com remuneração declarada em GFIP.',
    campos: camposFator(false), ler: lerFator, calcular: calc.fatorAjuste, resultado: resultadoFator,
    colunas: ['Cliente', 'Área', 'RMT', 'Honorários', 'Início', 'Fim', 'Status'],
    linha: s => [s.cliente, n2(s.i.area) + ' m²', brl(s.i.rmt), brl(s.i.honorarios), dataBr(s.i.data_inicio), dataBr(s.i.data_fim), statusCol(s)],
  },
  gps_espontanea: {
    slug: 'fator-de-ajuste-gps-espontanea', titulo: 'Fator de ajuste GPS espontânea', descricao: 'Fator de ajuste com recolhimento espontâneo em GPS.',
    campos: camposFator(true), ler: lerFator, calcular: calc.fatorAjuste, resultado: resultadoFator,
    colunas: ['Cliente', 'Rua', 'CNO', 'Área', 'RMT', 'Honorários', 'Competência', 'Vencimento', 'Status'],
    linha: s => [s.cliente, s.i.rua, s.i.cno, n2(s.i.area) + ' m²', brl(s.i.rmt), brl(s.i.honorarios), s.i.competencia, dataBr(s.i.vencimento), statusCol(s)],
  },
  pj_nf_contrato: {
    slug: 'obras-contratuais-pj-nf-contrato', titulo: 'Obras contratuais PJ NF contrato', descricao: 'Retenção de INSS na nota fiscal de serviço da empreiteira (cessão de mão de obra / empreitada).',
    campos: camposPj(false), ler: lerPj, calcular: calc.pjNf, resultado: resultadoPj,
    colunas: ['Cliente', 'Conformidade fiscal', 'Valor do contrato', 'Regime tributário', 'Início', 'Término', 'Status'],
    linha: s => [s.cliente, s.i.conformidade, brl(s.r.valor_total), s.i.regime, dataBr(s.i.data_inicio), dataBr(s.i.data_fim), statusCol(s)],
  },
  pj_nf_medicao: {
    slug: 'obras-contratuais-pj-nf-medicao', titulo: 'Obras contratuais PJ NF contrato medição', descricao: 'Retenção de INSS por medição (uma nota fiscal por medição).',
    campos: camposPj(true), ler: lerPj, calcular: calc.pjNf, resultado: resultadoPj,
    colunas: ['Cliente', 'Conformidade fiscal', 'Valor do contrato', 'Regime tributário', 'Início', 'Término', 'Status'],
    linha: s => [s.cliente, s.i.conformidade, brl(s.r.valor_total), s.i.regime, dataBr(s.i.data_inicio), dataBr(s.i.data_fim), statusCol(s)],
  },
  decadencia: {
    slug: 'decadencia', titulo: 'Decadência', descricao: 'Exclui da base as competências alcançadas pelo prazo decadencial.',
    campos: camposDecadencia, ler: lerDecadencia, calcular: calc.decadencia, resultado: resultadoDecadencia,
    colunas: ['Cliente', 'RMT', 'Início', 'Término', 'Regime tributário', 'INSS exigível', 'Status'],
    linha: s => [s.cliente, brl(s.i.rmt), dataBr(s.i.data_inicio), dataBr(s.i.data_fim), s.i.regime, brl(s.r.inss), statusCol(s)],
  },
  parcelamento: {
    slug: 'parcelamento', titulo: 'Parcelamento e-CAC', descricao: 'Estimativa das parcelas corrigidas pela Selic.',
    campos: camposParcelamento, ler: lerParcelamento, calcular: calc.parcelamento, resultado: resultadoParcelamento,
    colunas: ['Cliente', 'Débito', 'Nº parcelas', 'Parcela mensal', 'Selic anual', 'Status'],
    linha: s => [s.cliente, brl(s.i.debito), s.i.parcelas, brl(s.r.parcela_media), n2(s.r.selic_anual) + '%', statusCol(s)],
  },
};
for (const [k, v] of Object.entries(KINDS)) v.kind = k;
const porSlug = slug => Object.values(KINDS).find(k => k.slug === slug);

// dados que um tipo herda de uma simulação de obra predial ("Simular em")
function herdarDePredial(base) {
  const r = JSON.parse(base.result_json), i = JSON.parse(base.input_json);
  return {
    rmt: r.rmt, area: r.area_total, data_inicio: i.data_inicio, data_fim: i.data_fim,
    tipo_responsavel: i.tipo_responsavel, debito: r.inss,
  };
}

module.exports = { KINDS, porSlug, herdarDePredial, camposPredial, lerPredial, resultadoPredial, arr };

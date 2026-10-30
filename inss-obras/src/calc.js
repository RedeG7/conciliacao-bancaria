'use strict';
// Calculadoras dos simuladores. Funções puras: recebem os dados do formulário e
// um leitor de parâmetros P (src/db.js -> paramReader) e devolvem o resultado
// com a memória de cálculo linha a linha. Nenhum percentual fica aqui - todos
// vêm das tabelas de Cadastros (src/params.js).

class CalcError extends Error {}

const num = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  // aceita "1.234,56" (pt-BR) e "1234.56"
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : 0;
};
const r2 = v => Math.round(v * 100) / 100;

function exigir(P, tabela, chave, uf) {
  const v = P.get(tabela, chave, uf);
  if (v === null || v === undefined) throw new CalcError(`Parâmetro não cadastrado: ${tabela} / ${chave}${uf ? ` (${uf})` : ''}. Cadastre em Cadastros > Parâmetros.`);
  return v;
}

function aliquotaTotal(P) {
  const linhas = P.list('aliquota');
  if (!linhas.length) throw new CalcError('Nenhuma alíquota cadastrada em Cadastros > Parâmetros > Alíquotas.');
  return { total: linhas.reduce((s, l) => s + l.valor, 0), linhas: linhas.map(l => ({ nome: l.chave, valor: l.valor })) };
}

// fator social: primeira faixa (limite superior de área) que comporta a área
function fatorSocial(P, area) {
  const faixas = P.list('fator_social').map(l => ({ ate: num(l.chave), valor: l.valor })).sort((a, b) => a.ate - b.ate);
  const f = faixas.find(x => area <= x.ate) || faixas[faixas.length - 1];
  if (!f) throw new CalcError('Tabela de fator social vazia (Cadastros > Parâmetros).');
  return f.valor;
}

function competencia(data) {
  const s = String(data || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Obra predial - aferição indireta
// ---------------------------------------------------------------------------
// COD da destinação = área × % categoria × VAU (UF, destinação), menos a redução
// de concreto usinado; RMT = COD × % de mão de obra do tipo de obra. Áreas
// complementares entram pela % de equivalência, avaliadas na destinação
// principal (a de maior área). Depois: fator social (só PF) e redução de
// pré-moldados. INSS estimado = RMT × soma das alíquotas.
function predial(input, P, hoje = new Date()) {
  const uf = String(input.uf || '').toUpperCase();
  if (!uf) throw new CalcError('Informe a UF da obra.');
  const destinos = (input.destinacoes || []).filter(d => num(d.area) > 0);
  if (!destinos.length) throw new CalcError('Informe ao menos uma destinação com área maior que zero.');
  const ref = competencia(input.data_fim) || competencia(input.data_inicio) || hoje.toISOString().slice(0, 7);

  const linhas = [];
  let codTotal = 0, rmtTotal = 0, areaTotal = 0;
  const vauUsados = {};
  const calcLinha = (rotulo, d, area) => {
    const vau = P.vau(uf, d.destinacao, ref);
    if (!vau) throw new CalcError(`VAU não cadastrado para ${uf} / ${d.destinacao}. Importe a tabela em Cadastros > Parâmetros > VAU.`);
    vauUsados[d.destinacao] = vau;
    let cod = area * vau.valor;
    let redConcreto = 0;
    if (d.concreto_usinado) {
      redConcreto = exigir(P, 'concreto_usinado', d.destinacao, uf);
      cod = cod * (1 - redConcreto / 100);
    }
    const pctMo = exigir(P, 'tipo_obra', d.tipo_obra);
    const rmt = cod * pctMo / 100;
    codTotal += cod; rmtTotal += rmt;
    linhas.push({ rotulo, destinacao: d.destinacao, tipo_obra: d.tipo_obra, categoria: d.categoria || '', area: r2(area), vau: vau.valor, vigencia: vau.vigencia, red_concreto: redConcreto, cod: r2(cod), pct_mo: pctMo, rmt: r2(rmt) });
  };

  for (const d of destinos) {
    const pctCat = exigir(P, 'categoria', d.categoria);
    const area = num(d.area) * pctCat / 100;
    areaTotal += num(d.area);
    calcLinha(`${d.destinacao} - ${d.categoria} (${pctCat}% de ${num(d.area)} m²)`, d, area);
  }

  const principal = destinos.slice().sort((a, b) => num(b.area) - num(a.area))[0];
  for (const c of (input.complementares || []).filter(x => num(x.area) > 0)) {
    const chave = `${c.tipo} | ${c.coberta ? 'coberta' : 'descoberta'}`;
    const pct = exigir(P, 'area_complementar', chave);
    const area = num(c.area) * pct / 100;
    calcLinha(`Área complementar: ${chave} (${pct}% de ${num(c.area)} m²)`, { ...principal, concreto_usinado: false }, area);
  }

  const etapas = [{ rotulo: 'RMT das destinações', valor: r2(rmtTotal) }];
  let rmt = rmtTotal;
  const areaFator = num(input.area_principal) || areaTotal;
  let fator = null;
  if (input.tipo_responsavel === 'PF') {
    fator = fatorSocial(P, areaFator);
    rmt = rmt * fator / 100;
    etapas.push({ rotulo: `Fator social PF (${fator}% para ${areaFator} m²)`, valor: r2(rmt) });
  }
  if (input.premoldado) {
    const red = exigir(P, 'pre_moldado', 'Redução da RMT');
    const lim = P.get('pre_moldado', 'Limite mínimo das NFs (% do COD)');
    rmt = rmt * (1 - red / 100);
    etapas.push({ rotulo: `Redução pré-moldados (${red}%, NFs ≥ ${lim ?? '?'}% do COD)`, valor: r2(rmt) });
  }
  const aliq = aliquotaTotal(P);
  const inss = rmt * aliq.total / 100;
  return {
    referencia: ref, uf, linhas, etapas,
    area_total: r2(areaTotal), cod_total: r2(codTotal), rmt_bruta: r2(rmtTotal), fator_social: fator,
    rmt: r2(rmt), aliquotas: aliq.linhas, aliquota_total: r2(aliq.total), inss: r2(inss),
    data_inicio: input.data_inicio || '', data_fim: input.data_fim || '',
  };
}

// ---------------------------------------------------------------------------
// Fator de ajuste (eSocial, GFIP, GPS espontânea)
// ---------------------------------------------------------------------------
// Diferença = RMT - remuneração já declarada. Se a declarada atinge o mínimo
// (% da RMT), a diferença é reduzida pelo percentual de redução do fator.
function fatorAjuste(input, P) {
  const rmt = num(input.rmt);
  if (rmt <= 0) throw new CalcError('Informe a RMT (ou simule a partir de uma obra predial).');
  const declarada = num(input.remuneracao_declarada);
  const minimo = exigir(P, 'fator_ajuste', 'Remuneração mínima declarada (% da RMT)');
  const reducao = exigir(P, 'fator_ajuste', 'Redução da diferença apurada');
  const diferenca = Math.max(0, rmt - declarada);
  const atinge = declarada >= rmt * minimo / 100;
  const apurada = atinge ? diferenca * (1 - reducao / 100) : diferenca;
  const aliq = aliquotaTotal(P);
  const minimoValor = rmt * minimo / 100;
  return {
    rmt: r2(rmt), remuneracao_declarada: r2(declarada), minimo_pct: minimo, minimo_valor: r2(minimoValor),
    falta_para_minimo: r2(Math.max(0, minimoValor - declarada)), aplica_fator: atinge, reducao_pct: reducao,
    diferenca: r2(diferenca), remuneracao_apurada: r2(apurada), aliquota_total: r2(aliq.total), aliquotas: aliq.linhas,
    inss_sem_fator: r2(diferenca * aliq.total / 100), inss: r2(apurada * aliq.total / 100),
    // INSS da remuneração mínima a declarar (o que se paga mês a mês para chegar ao fator)
    inss_para_atingir_minimo: r2(Math.max(0, minimoValor - declarada) * aliq.total / 100),
    honorarios: r2(num(input.honorarios)),
  };
}

// ---------------------------------------------------------------------------
// Decadência
// ---------------------------------------------------------------------------
// A RMT é distribuída igualmente pelas competências da obra; as competências de
// exercícios encerrados há mais que o prazo decadencial (CTN art. 173, I: conta
// do 1º dia do exercício seguinte) saem da base.
function mesesEntre(ini, fim) {
  const [ai, mi] = ini.split('-').map(Number), [af, mf] = fim.split('-').map(Number);
  const out = [];
  for (let a = ai, m = mi; a < af || (a === af && m <= mf); m === 12 ? (a++, m = 1) : m++) out.push(`${a}-${String(m).padStart(2, '0')}`);
  return out;
}
function decadencia(input, P, hoje = new Date()) {
  const rmt = num(input.rmt);
  if (rmt <= 0) throw new CalcError('Informe a RMT.');
  const ini = competencia(input.data_inicio), fim = competencia(input.data_fim);
  if (!ini || !fim || ini > fim) throw new CalcError('Informe as datas de início e de término da obra (início antes do término).');
  const anos = exigir(P, 'decadencia', 'Prazo decadencial (anos)');
  const meses = mesesEntre(ini, fim);
  // ex.: em 2026 com 5 anos, o exercício 2020 decaiu em 01/01/2026 (prazo conta de 01/01/2021)
  const ultimoAnoDecaido = hoje.getFullYear() - anos - 1;
  const decaidos = meses.filter(m => Number(m.slice(0, 4)) <= ultimoAnoDecaido);
  const exigiveis = meses.length - decaidos.length;
  const rmtExigivel = rmt * exigiveis / meses.length;
  const aliq = aliquotaTotal(P);
  return {
    rmt: r2(rmt), meses: meses.length, meses_decaidos: decaidos.length, meses_exigiveis: exigiveis,
    primeira: ini, ultima: fim, ultimo_ano_decaido: ultimoAnoDecaido, prazo_anos: anos,
    rmt_exigivel: r2(rmtExigivel), rmt_decaida: r2(rmt - rmtExigivel), aliquota_total: r2(aliq.total), aliquotas: aliq.linhas,
    inss_sem_decadencia: r2(rmt * aliq.total / 100), inss: r2(rmtExigivel * aliq.total / 100),
    economia: r2((rmt - rmtExigivel) * aliq.total / 100), regime: input.regime || '', honorarios: r2(num(input.honorarios)),
  };
}

// ---------------------------------------------------------------------------
// Parcelamento e-CAC
// ---------------------------------------------------------------------------
// Parcela básica = débito / nº de parcelas. Cada parcela a partir da 2ª é
// acrescida da Selic acumulada desde a consolidação até o mês anterior ao
// pagamento + juros do mês do pagamento. Selic projetada = informada ou média
// dos últimos 12 meses da tabela.
function parcelamento(input, P) {
  const debito = num(input.debito);
  if (debito <= 0) throw new CalcError('Informe o valor do débito.');
  const max = exigir(P, 'parcelamento', 'Máximo de parcelas');
  const n = Math.trunc(num(input.parcelas));
  if (n < 1 || n > max) throw new CalcError(`Número de parcelas deve estar entre 1 e ${max}.`);
  const minimo = exigir(P, 'parcelamento', input.tipo_responsavel === 'PJ' ? 'Parcela mínima PJ (R$)' : 'Parcela mínima PF (R$)');
  const jurosMes = exigir(P, 'parcelamento', 'Juros no mês do pagamento (%)');
  let selicMes = num(input.selic_mensal);
  let fonteSelic = 'informada';
  if (!selicMes) {
    const ult = P.list('selic').sort((a, b) => (a.chave < b.chave ? 1 : -1)).slice(0, 12);
    if (!ult.length) throw new CalcError('Informe a Selic mensal projetada ou importe a tabela Selic em Cadastros > Parâmetros.');
    selicMes = ult.reduce((s, l) => s + l.valor, 0) / ult.length;
    fonteSelic = `média de ${ult.length} mês(es) da tabela (${ult[ult.length - 1].chave} a ${ult[0].chave})`;
  }
  const base = debito / n;
  if (base < minimo) throw new CalcError(`Parcela de R$ ${r2(base).toFixed(2)} fica abaixo do mínimo de R$ ${minimo.toFixed(2)}. Reduza o número de parcelas.`);
  const parcelas = [];
  let total = 0;
  for (let k = 1; k <= n; k++) {
    const pct = k === 1 ? 0 : selicMes * (k - 1) + jurosMes;
    const valor = base * (1 + pct / 100);
    total += valor;
    parcelas.push({ n: k, acrescimo_pct: r2(pct), valor: r2(valor) });
  }
  return {
    debito: r2(debito), parcelas_qtd: n, parcela_basica: r2(base), selic_mensal: r2(selicMes * 100) / 100,
    selic_anual: r2(selicMes * 12), fonte_selic: fonteSelic, juros_mes: jurosMes, parcelas, total: r2(total),
    juros_total: r2(total - debito), parcela_media: r2(total / n), honorarios: r2(num(input.honorarios)),
  };
}

// ---------------------------------------------------------------------------
// Obras contratuais PJ - NF de contrato / medição
// ---------------------------------------------------------------------------
// Retenção = valor da NF × % de base do serviço × alíquota do regime. Para
// contrato por medição, cada medição vira uma NF.
function pjNf(input, P) {
  const notas = (input.medicoes && input.medicoes.length ? input.medicoes : [{ descricao: 'Contrato', valor: input.valor_contrato }])
    .map(m => ({ descricao: m.descricao || '', valor: num(m.valor) })).filter(m => m.valor > 0);
  if (!notas.length) throw new CalcError('Informe o valor do contrato (ou das medições).');
  const pctBase = exigir(P, 'servico_pj', input.servico);
  const aliq = exigir(P, 'regime', input.regime);
  const linhas = notas.map(m => {
    const base = m.valor * pctBase / 100;
    return { ...m, base: r2(base), retencao: r2(base * aliq / 100) };
  });
  const valor = notas.reduce((s, m) => s + m.valor, 0);
  const retencao = linhas.reduce((s, l) => s + l.retencao, 0);
  return {
    servico: input.servico, regime: input.regime, pct_base: pctBase, aliquota: aliq, linhas,
    valor_total: r2(valor), base_total: r2(valor * pctBase / 100), retencao: r2(retencao),
    liquido: r2(valor - retencao), conformidade: input.conformidade || '', honorarios: r2(num(input.honorarios)),
  };
}

module.exports = { predial, fatorAjuste, decadencia, parcelamento, pjNf, CalcError, num, mesesEntre };

'use strict';
// Quadro de cálculo do envio DCTFWeb da obra (SPEC_MODULO_DCTFWEB 5.2, aba 5).
// Função pura: recebe as competências da folha e os parâmetros (tabela "dctf"
// de Cadastros > Parâmetros) e devolve, por competência, remuneração, CPP,
// multa de mora, Selic acumulada, juros, MAED e total. As regras marcadas na
// seção 8 da spec ainda precisam da validação do fiscal - por isso todo
// percentual vem dos parâmetros.
const { CalcError, mesesEntre } = require('./calc');

const r2 = v => Math.round(v * 100) / 100;
const exigir = (P, chave) => {
  const v = P.get('dctf', chave);
  if (v === null || v === undefined) throw new CalcError(`Parâmetro não cadastrado: dctf / ${chave}. Cadastre em Cadastros > Parâmetros.`);
  return v;
};
const proxMes = c => { const [a, m] = c.split('-').map(Number); return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`; };
const iso = d => d.toISOString().slice(0, 10);

// vencimento: dia N do mês seguinte à competência
function vencimento(comp, dia) {
  const [a, m] = proxMes(comp).split('-').map(Number);
  return `${a}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Base da distribuição mensal ("valor calculado"): a remuneração-alvo
// (mínimo do fator de ajuste da simulação eSocial; sem ele, a RMT) dividida
// igualmente pelos meses da obra que não estão paralisados.
function valorCalculadoMensal({ alvo, inicio, fim, paralisados = [] }) {
  if (!alvo || !inicio) return 0;
  const meses = mesesEntre(inicio.slice(0, 7), (fim || inicio).slice(0, 7)).filter(m => !paralisados.includes(m));
  return meses.length ? alvo / meses.length : 0;
}

// RMT sem as competências alcançadas pela decadência (proporcional aos meses)
function rmtNaoDecadente({ rmt, inicio, fim, anos, hoje }) {
  if (!rmt || !inicio) return rmt || 0;
  const meses = mesesEntre(inicio.slice(0, 7), (fim || iso(hoje)).slice(0, 7));
  const ultimoDecaido = hoje.getFullYear() - anos - 1;
  const validos = meses.filter(m => Number(m.slice(0, 4)) > ultimoDecaido).length;
  return meses.length ? rmt * validos / meses.length : rmt;
}

function quadro({ meses, calculadoMensal = 0, rmtBase = 0, hoje = new Date() }, P) {
  const cppPct = exigir(P, 'CPP (%)');
  const dia = exigir(P, 'Dia de vencimento');
  const multaDia = exigir(P, 'Multa de mora ao dia (%)');
  const multaMax = exigir(P, 'Multa de mora máxima (%)');
  const jurosMes = exigir(P, 'Juros no mês do pagamento (%)');
  const maedMes = exigir(P, 'MAED ao mês (%)');
  const maedMax = exigir(P, 'MAED máxima (%)');
  const maedMin = exigir(P, 'MAED mínima (R$)');
  const selic = Object.fromEntries(P.list('selic').map(s => [s.chave, s.valor]));
  const hojeIso = iso(hoje), mesAtual = hojeIso.slice(0, 7);
  const semSelic = new Set();

  // encargos de uma competência sobre uma remuneração (CPP + multa + juros + MAED)
  function encargos(rem, venc, vencida) {
    const cpp = rem * cppPct / 100;
    if (!vencida) return { cpp, multa: 0, selicPct: 0, juros: 0, maed: 0, total: cpp };
    const dias = Math.floor((new Date(hojeIso) - new Date(venc)) / 864e5);
    const multa = cpp * Math.min(dias * multaDia, multaMax) / 100;
    // Selic dos meses seguintes ao do vencimento até o anterior ao pagamento, + juros do mês do pagamento
    let selicPct = 0;
    for (let c = proxMes(venc.slice(0, 7)); c < mesAtual; c = proxMes(c)) {
      if (selic[c] === undefined) semSelic.add(c); else selicPct += selic[c];
    }
    selicPct += jurosMes;
    const juros = cpp * selicPct / 100;
    // MAED: por mês-calendário (ou fração) de atraso, com teto e valor mínimo
    const [av, mv] = venc.split('-').map(Number), [ah, mh] = hojeIso.split('-').map(Number);
    const mesesAtraso = Math.max(1, (ah - av) * 12 + (mh - mv) + (Number(hojeIso.slice(8)) > Number(venc.slice(8)) ? 1 : 0));
    const maed = Math.max(maedMin, cpp * Math.min(mesesAtraso * maedMes, maedMax) / 100);
    return { cpp, multa, selicPct, juros, maed, total: cpp + multa + juros + maed };
  }

  const linhas = meses.slice().sort((a, b) => (a.competencia < b.competencia ? -1 : 1)).map(m => {
    const informado = m.items.reduce((s, i) => s + (Number(i.calc_base) || 0), 0);
    const calculado = m.is_paralyzed ? 0 : calculadoMensal;
    const atualizada = m.is_paralyzed ? 0 : (informado || calculado);
    const venc = vencimento(m.competencia, dia);
    const vencida = !m.is_paralyzed && hojeIso > venc;
    const e = encargos(atualizada, venc, vencida), o = encargos(calculado, venc, vencida);
    return {
      competencia: m.competencia, paralisado: !!m.is_paralyzed, status: m.status, vencimento: venc, vencida,
      informado: r2(informado), calculado: r2(calculado), rem_original: r2(calculado), rem_atualizada: r2(atualizada),
      cpp: r2(e.cpp), multa: r2(e.multa), selic_pct: r2(e.selicPct), juros: r2(e.juros), maed: r2(e.maed), total: r2(e.total),
      total_original: r2(o.total),
    };
  });
  const soma = k => r2(linhas.reduce((s, l) => s + l[k], 0));
  const informadoTotal = soma('informado');
  return {
    linhas, cpp_pct: cppPct,
    total: soma('total'), total_original: soma('total_original'), informado_total: informadoTotal,
    cpp_total: soma('cpp'), multa_total: soma('multa'), juros_total: soma('juros'), maed_total: soma('maed'),
    rmt_base: r2(rmtBase), percentual: rmtBase ? r2(informadoTotal / rmtBase * 100) : null,
    selic_faltando: [...semSelic].sort(),
  };
}

module.exports = { quadro, vencimento, valorCalculadoMensal, rmtNaoDecadente, proxMes };

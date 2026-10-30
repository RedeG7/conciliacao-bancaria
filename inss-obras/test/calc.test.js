'use strict';
// Calculadoras com parâmetros fixos (independentes dos valores do banco)
const test = require('node:test');
const assert = require('node:assert');
const calc = require('../src/calc');

const tab = {
  categoria: [['Obra nova', 100], ['Reforma', 35]],
  tipo_obra: [['Alvenaria', 20], ['Mista', 15]],
  fator_social: [['100', 20], ['200', 40], ['999999999', 90]],
  area_complementar: [['Piscina | descoberta', 25]],
  concreto_usinado: [['*', '*', 5]],
  pre_moldado: [['Redução da RMT', 70], ['Limite mínimo das NFs (% do COD)', 40]],
  aliquota: [['Patronal', 20], ['Segurados', 8]],
  fator_ajuste: [['Remuneração mínima declarada (% da RMT)', 50], ['Redução da diferença apurada', 100]],
  decadencia: [['Prazo decadencial (anos)', 5]],
  parcelamento: [['Máximo de parcelas', 60], ['Juros no mês do pagamento (%)', 1], ['Parcela mínima PF (R$)', 200], ['Parcela mínima PJ (R$)', 500]],
  regime: [['Lucro Presumido', 11]],
  servico_pj: [['Somente mão de obra', 100], ['Drenagem', 50]],
  selic: [['2026-08', 1], ['2026-09', 0.8]],
};
const rows = Object.entries(tab).flatMap(([t, l]) => l.map(r => (r.length === 3 ? { tabela: t, uf: r[0], chave: r[1], valor: r[2] } : { tabela: t, uf: '', chave: r[0], valor: r[1] })));
const P = {
  list: t => rows.filter(r => r.tabela === t),
  get(t, chave, uf = '') {
    for (const [u, c] of [[uf, chave], [uf, '*'], ['*', chave], ['*', '*'], ['', chave]]) {
      const r = rows.find(x => x.tabela === t && x.uf === u && x.chave === c);
      if (r) return r.valor;
    }
    return null;
  },
  vau: (uf, dest) => (uf === 'GO' && dest === 'Residência unifamiliar' ? { valor: 2000, vigencia: '2026-09' } : null),
};

test('predial PF: área × VAU × % categoria × % mão de obra × fator social', () => {
  const r = calc.predial({ uf: 'GO', tipo_responsavel: 'PF', destinacoes: [{ destinacao: 'Residência unifamiliar', tipo_obra: 'Alvenaria', categoria: 'Obra nova', area: 150 }] }, P);
  assert.strictEqual(r.cod_total, 300000);      // 150 × 2000
  assert.strictEqual(r.rmt_bruta, 60000);       // 20%
  assert.strictEqual(r.fator_social, 40);       // 101-200 m²
  assert.strictEqual(r.rmt, 24000);
  assert.strictEqual(r.inss, 6720);             // 28%
});

test('predial PJ com reforma, concreto usinado, área complementar e pré-moldados', () => {
  const r = calc.predial({ uf: 'GO', tipo_responsavel: 'PJ', premoldado: true,
    destinacoes: [{ destinacao: 'Residência unifamiliar', tipo_obra: 'Alvenaria', categoria: 'Reforma', concreto_usinado: true, area: 100 }],
    complementares: [{ tipo: 'Piscina', coberta: false, area: 40 }] }, P);
  // reforma: 35 m² × 2000 = 70000 - 5% = 66500; piscina 10 m² × 2000 = 20000 (sem redução de concreto)
  assert.strictEqual(r.cod_total, 86500);
  assert.strictEqual(r.rmt_bruta, 17300);
  assert.strictEqual(r.fator_social, null);
  assert.strictEqual(r.rmt, 5190);              // -70% pré-moldados
});

test('predial sem VAU cadastrada avisa o que falta', () => {
  assert.throws(() => calc.predial({ uf: 'SP', destinacoes: [{ destinacao: 'Comercial', tipo_obra: 'Alvenaria', categoria: 'Obra nova', area: 10 }] }, P), /VAU não cadastrado para SP/);
});

test('fator de ajuste: zera a diferença quando atinge o mínimo', () => {
  const a = calc.fatorAjuste({ rmt: 100000, remuneracao_declarada: 60000 }, P);
  assert.strictEqual(a.aplica_fator, true);
  assert.strictEqual(a.inss, 0);
  assert.strictEqual(a.inss_sem_fator, 11200);
  const b = calc.fatorAjuste({ rmt: 100000, remuneracao_declarada: 30000 }, P);
  assert.strictEqual(b.aplica_fator, false);
  assert.strictEqual(b.remuneracao_apurada, 70000);
  assert.strictEqual(b.falta_para_minimo, 20000);
});

test('decadência: exercícios até ano-6 saem da base', () => {
  const r = calc.decadencia({ rmt: 24000, data_inicio: '2020-01-10', data_fim: '2021-12-20' }, P, new Date('2026-10-30'));
  assert.strictEqual(r.meses, 24);
  assert.strictEqual(r.meses_decaidos, 12);     // 2020 decaiu
  assert.strictEqual(r.rmt_exigivel, 12000);
});

test('parcelamento: Selic média da tabela + 1% no mês do pagamento', () => {
  const r = calc.parcelamento({ debito: 12000, parcelas: 3 }, P);
  assert.strictEqual(r.parcela_basica, 4000);
  assert.deepStrictEqual(r.parcelas.map(p => p.valor), [4000, 4076, 4112]); // 0%, 0,9+1, 1,8+1
  assert.throws(() => calc.parcelamento({ debito: 1000, parcelas: 10 }, P), /abaixo do mínimo/);
});

test('PJ NF por medição: base por serviço × alíquota do regime', () => {
  const r = calc.pjNf({ regime: 'Lucro Presumido', servico: 'Drenagem', medicoes: [{ descricao: 'M1', valor: 10000 }, { descricao: 'M2', valor: '5.000,00' }] }, P);
  assert.strictEqual(r.valor_total, 15000);
  assert.strictEqual(r.retencao, 825);          // 15000 × 50% × 11%
});

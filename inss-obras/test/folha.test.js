'use strict';
// Quadro de cálculo da folha da obra (CPP, multa, Selic, MAED) com parâmetros fixos
const test = require('node:test');
const assert = require('node:assert');
const folha = require('../src/folha');

const dctf = { 'CPP (%)': 20, 'Dia de vencimento': 20, 'Multa de mora ao dia (%)': 0.33, 'Multa de mora máxima (%)': 20,
  'Juros no mês do pagamento (%)': 1, 'MAED ao mês (%)': 2, 'MAED máxima (%)': 20, 'MAED mínima (R$)': 200 };
const selic = { '2026-07': 1, '2026-08': 1.1, '2026-09': 0.9 };
const P = {
  get: (t, k) => (t === 'dctf' ? dctf[k] ?? null : null),
  list: t => (t === 'selic' ? Object.entries(selic).map(([chave, valor]) => ({ chave, valor })) : []),
};
const hoje = new Date('2026-10-30T12:00:00Z');

test('competência corrente não leva multa, juros nem MAED', () => {
  const q = folha.quadro({ meses: [{ competencia: '2026-09', items: [{ calc_base: 1000 }] }], hoje }, P);
  const l = q.linhas[0];
  assert.strictEqual(l.vencimento, '2026-10-20');
  // 30/10 já passou do dia 20: vencida há 10 dias
  assert.strictEqual(l.vencida, true);
  assert.strictEqual(l.cpp, 200);
  assert.strictEqual(l.multa, 6.6);          // 10 dias × 0,33% = 3,3%
  assert.strictEqual(l.selic_pct, 1);        // só o 1% do mês do pagamento
  assert.strictEqual(l.maed, 200);           // mínimo
  const q2 = folha.quadro({ meses: [{ competencia: '2026-10', items: [{ calc_base: 1000 }] }], hoje }, P);
  assert.strictEqual(q2.linhas[0].vencida, false);
  assert.strictEqual(q2.linhas[0].total, 200);
});

test('competência antiga: multa limitada a 20%, Selic acumulada, MAED proporcional, Selic faltando avisada', () => {
  const q = folha.quadro({ meses: [{ competencia: '2026-05', items: [{ calc_base: 20000 }] }], hoje }, P);
  const l = q.linhas[0];
  assert.strictEqual(l.vencimento, '2026-06-20');
  assert.strictEqual(l.cpp, 4000);
  assert.strictEqual(l.multa, 800);           // teto de 20%
  assert.strictEqual(l.selic_pct, 4);         // jul 1 + ago 1,1 + set 0,9 + 1%
  assert.strictEqual(l.juros, 160);
  assert.strictEqual(l.maed, 400);            // 5 meses × 2% = 10% de 4000
  assert.strictEqual(l.total, 5360);
  const q2 = folha.quadro({ meses: [{ competencia: '2026-03', items: [{ calc_base: 100 }] }], hoje }, P);
  assert.deepStrictEqual(q2.selic_faltando, ['2026-05', '2026-06']);
});

test('valor calculado, paralisação e percentual sobre a RMT não decadente', () => {
  const calcMes = folha.valorCalculadoMensal({ alvo: 12000, inicio: '2026-01-10', fim: '2026-06-30', paralisados: ['2026-03', '2026-04'] });
  assert.strictEqual(calcMes, 3000);          // 12000 / 4 meses ativos
  const q = folha.quadro({ meses: [
    { competencia: '2026-10', items: [] },                       // sem valor informado: usa o calculado
    { competencia: '2026-11', is_paralyzed: 1, items: [] },
  ], calculadoMensal: calcMes, rmtBase: 24000, hoje }, P);
  assert.strictEqual(q.linhas[0].rem_atualizada, 3000);
  assert.strictEqual(q.linhas[1].total, 0);
  assert.strictEqual(q.percentual, 0);
  assert.strictEqual(folha.rmtNaoDecadente({ rmt: 24000, inicio: '2020-01-01', fim: '2021-12-31', anos: 5, hoje }), 12000);
});

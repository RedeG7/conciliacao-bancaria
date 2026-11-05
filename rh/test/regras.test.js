'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { addMeses, proximoAniversario, anosEntre, dataValida } = require('../src/datas');
const { alertas, ANTECEDENCIA_PADRAO } = require('../src/alertas');
const M = require('../src/metricas');
const { numero, data, csv } = (() => { process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'rh-r-')); return require('../src/crud'); })();
const { parseCsv } = require('../src/importar');
const { cpfValido } = require('../src/modelos');

test('datas', () => {
  assert.strictEqual(addMeses('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(proximoAniversario('1990-11-10', '2026-11-05'), '2026-11-10');
  assert.strictEqual(proximoAniversario('1990-01-10', '2026-11-05'), '2027-01-10');
  assert.strictEqual(proximoAniversario('2000-02-29', '2026-01-01'), '2026-03-01');
  assert.strictEqual(anosEntre('2000-11-06', '2026-11-05'), 25);
  assert.ok(!dataValida('2026-02-30'));
});

test('números, datas e CPF', () => {
  assert.strictEqual(numero('1.234,56'), 1234.56);
  assert.strictEqual(numero('1234.56'), 1234.56);
  assert.strictEqual(numero('R$ 10,00'), 10);
  assert.strictEqual(numero('abc'), null);
  assert.strictEqual(data('10/02/2026'), '2026-02-10');
  assert.strictEqual(data('31/02/2026'), null);
  assert.ok(cpfValido('529.982.247-25'));
  assert.ok(!cpfValido('529.982.247-26'));
});

test('CSV: aspas, separador e fórmula', () => {
  assert.deepStrictEqual(parseCsv('a;b\r\n"x;1";"di""z"\n'), [['a', 'b'], ['x;1', 'di"z']]);
  assert.deepStrictEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.match(csv(['a'], [['=1+1'], ['-2']]), /'=1\+1\r\n'-2/);
});

test('alertas', () => {
  const hoje = '2026-11-05';
  const d = {
    colaboradores: [
      { id: 1, nome: 'Exp', situacao: 'Ativo', fim_experiencia: '2026-11-10' },
      { id: 2, nome: 'Niver', situacao: 'Ativo', nascimento: '1990-11-08' },
      { id: 3, nome: 'Saiu', situacao: 'Inativo', fim_experiencia: '2026-11-10', nascimento: '1990-11-08' },
      { id: 4, nome: 'Ferias', situacao: 'Ativo', data_admissao: '2024-12-01' }, // período até 30/11/2025, limite 30/11/2026
      { id: 5, nome: 'FeriasOk', situacao: 'Ativo', data_admissao: '2024-12-01' },
    ],
    ferias: [{ colaborador_id: 5, status: 'Programada', aquisitivo_inicio: '2024-12-01', aquisitivo_fim: '2025-11-30' }],
    pdis: [{ id: 1, colaborador_id: 1, titulo: 'P', status: 'Aberto', entrega: '2026-10-01' }],
    ciclos: [],
    saude: [{ colaborador_id: 2, proximo_exame: '2026-01-01' }, { colaborador_id: 2, proximo_exame: '2026-11-20' }],
  };
  const a = alertas(d, ANTECEDENCIA_PADRAO, hoje);
  assert.deepStrictEqual(a.map(x => x.tipo), ['PDI', 'Aniversário', 'Experiência', 'Exame', 'Férias']);
  assert.ok(a[0].vencido);
  assert.strictEqual(a.find(x => x.tipo === 'Férias').data, '2026-11-30');
  assert.ok(!alertas({ ...d, saude: null }, ANTECEDENCIA_PADRAO, hoje).some(x => x.tipo === 'Exame'), 'sem acesso a saúde, sem aviso de exame');
});

test('métricas', () => {
  assert.strictEqual(M.enps([10, 9, 3]), 33);
  assert.strictEqual(M.enps([]), null);
  const m = M.matriz([{ desempenho: 5, potencial: 5 }, { desempenho: 1, potencial: 1 }, { desempenho: 3, potencial: 3 }]);
  assert.strictEqual(m[0][2].itens.length, 1);
  assert.strictEqual(m[2][0].itens.length, 1);
  assert.strictEqual(m[1][1].itens.length, 1);
  const cols = [{ id: 1, situacao: 'Ativo', data_admissao: '2020-01-01' }, { id: 2, situacao: 'Ativo', data_admissao: '2020-01-01' }, { id: 3, situacao: 'Inativo', data_admissao: '2026-06-01' }];
  const r = M.resumoDesligamentos([{ colaborador_id: 3, data: '2026-08-01', valor_rescisao: 100 }, { colaborador_id: 3, data: '2020-01-01' }], cols, '2026-11-05');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.menosDeUmAno, 1);
  assert.strictEqual(r.valorRescisao, 100);
});

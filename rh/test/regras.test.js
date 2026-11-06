'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { addMeses, proximoAniversario, anosEntre, dataValida } = require('../src/datas');
const { alertas, ANTECEDENCIA_PADRAO } = require('../src/alertas');
const M = require('../src/metricas');
const { numero, data, csv, horas, hhmm } = (() => { process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'rh-r-')); return require('../src/crud'); })();
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

test('horas', () => {
  assert.strictEqual(horas('8:30'), 8.5);
  assert.strictEqual(horas('8,5'), 8.5);
  assert.strictEqual(horas('8:75'), null);
  assert.strictEqual(hhmm(8.5), '08:30');
  assert.strictEqual(hhmm(horas('1:20')), '01:20');
});

test('treinamento: alerta só da conclusão mais recente', () => {
  const d = { colaboradores: [{ id: 1, nome: 'Ana', situacao: 'Ativo' }, { id: 2, nome: 'Saiu', situacao: 'Inativo' }], ferias: [], pdis: [], ciclos: [],
    treinamentos: [{ id: 9, titulo: 'NR-35', validade_meses: 12 }],
    participacoes: [
      { colaborador_id: 2, treinamento_id: 9, status: 'Concluiu', data_conclusao: '2025-11-20' },
      { colaborador_id: 1, treinamento_id: 9, status: 'Concluiu', data_conclusao: '2025-11-20' },
    ] };
  const a = alertas(d, ANTECEDENCIA_PADRAO, '2026-11-05');
  assert.deepStrictEqual(a.map(x => [x.tipo, x.data]), [['Treinamento', '2026-11-20']]);
  d.participacoes.push({ colaborador_id: 1, treinamento_id: 9, status: 'Concluiu', data_conclusao: '2026-10-01' });
  assert.strictEqual(alertas(d, ANTECEDENCIA_PADRAO, '2026-11-05').length, 0);
});

test('avaliados sem PDI', () => {
  const cols = [{ id: 1, nome: 'A', situacao: 'Ativo' }, { id: 2, nome: 'B', situacao: 'Ativo' }, { id: 3, nome: 'C', situacao: 'Inativo' }, { id: 4, nome: 'D', situacao: 'Ativo' }];
  const av = [{ colaborador_id: 2, desempenho: 2 }, { colaborador_id: 2, desempenho: 5 }, { colaborador_id: 1, desempenho: 4 }, { colaborador_id: 3, desempenho: 1 }, { colaborador_id: 4, desempenho: 1 }];
  const r = M.avaliadosSemPdi(cols, av, [{ colaborador_id: 4, status: 'Aberto' }, { colaborador_id: 1, status: 'Finalizado' }]);
  assert.deepStrictEqual(r.map(x => [x.colaborador.nome, x.avaliacao.desempenho]), [['B', 2], ['A', 4]]);
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

test('perfil comportamental: pontuação, segundo estilo, faixas e aderência', () => {
  const P = require('../src/comportamental');
  assert.strictEqual(P.QUESTOES.length, 24);
  for (const e of P.CHAVES) assert.strictEqual(P.QUESTOES.filter(q => q.estilo === e).length, 6, e);
  assert.strictEqual(P.pontuar([1, 2]), null, 'faltando resposta');
  assert.strictEqual(P.pontuar(Array(24).fill(6)), null, 'fora da escala');
  const r = P.pontuar(P.QUESTOES.map(q => (q.estilo === 'realizador' ? 5 : q.estilo === 'conector' ? 4 : 1)));
  assert.deepStrictEqual(r.pontos, { realizador: 100, conector: 75, constante: 0, criterioso: 0 });
  assert.strictEqual(r.principal, 'realizador');
  assert.strictEqual(r.secundario, null, '25 pontos de distância não contam como 2º estilo');
  const perto = P.pontuar(P.QUESTOES.map((q, i) => (q.estilo === 'realizador' ? 5 : q.estilo === 'conector' ? (i === 1 ? 3 : 5) : 1)));
  assert.strictEqual(perto.secundario, 'conector');
  assert.strictEqual(P.nomePerfil(perto), 'Realizador e Conector');
  assert.deepStrictEqual([P.faixa(39), P.faixa(40), P.faixa(70)], ['Baixo', 'Médio', 'Alto']);
  assert.strictEqual(P.aderencia(r.pontos, r.pontos), 100);
  assert.strictEqual(P.aderencia({ realizador: 0, conector: 0, constante: 0, criterioso: 0 }, { realizador: 100, conector: 100, constante: 100, criterioso: 100 }), 0);
});

test('visão geral: situação do PDI, pendentes da AVD e médias por grupo', () => {
  const dia = '2026-11-06';
  assert.strictEqual(M.situacaoPdi({ status: 'Finalizado', entrega: '2026-01-01' }, dia), 'Concluídos');
  assert.strictEqual(M.situacaoPdi({ status: 'Aberto', entrega: '2026-11-05' }, dia), 'Atrasados');
  assert.strictEqual(M.situacaoPdi({ status: 'Em revisão', entrega: '2026-11-05' }, dia), 'Atrasados');
  assert.strictEqual(M.situacaoPdi({ status: 'Em revisão', entrega: '2026-11-06' }, dia), 'Aguardando aprovação');
  assert.strictEqual(M.situacaoPdi({ status: 'Aberto', entrega: '2026-12-01' }, dia), 'Em andamento');
  const pessoas = [{ id: 1, situacao: 'Ativo', data_admissao: '2026-01-01' }, { id: 2, situacao: 'Ativo', data_admissao: '2026-01-01' },
    { id: 3, situacao: 'Inativo', data_admissao: '2026-01-01' }, { id: 4, situacao: 'Ativo', data_admissao: '2027-01-01' }];
  const ciclo = { status: 'Aberto', fim: '2026-12-31' };
  assert.deepStrictEqual(M.pendentesAvd(ciclo, pessoas, [{ colaborador_id: 1 }]).map(p => p.id), [2]);
  assert.deepStrictEqual(M.pendentesAvd({ ...ciclo, status: 'Encerrado' }, pessoas, []), []);
  assert.deepStrictEqual(M.mediasPor([{ g: 'A', desempenho: 2 }, { g: 'B', desempenho: 5 }, { g: 'A', desempenho: 4 }], a => a.g), [['B', 5], ['A', 3]]);
});

'use strict';
// Selic pelo Banco Central (resposta simulada) e VAU colada do SERO
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inssobras-integ-'));
process.env.DATA_DIR = dir;
const { db, paramReader } = require('../src/db');
const integ = require('../src/integracoes');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Selic: grava os meses encerrados da série 4390 e ignora o mês corrente', async () => {
  let url = '';
  const fetchFn = async u => { url = u; return { ok: true, json: async () => [
    { data: '01/08/2026', valor: '1.16' }, { data: '01/09/2026', valor: '1.22' }, { data: '01/10/2026', valor: '0.80' }] }; };
  const r = await integ.atualizarSelic({ fetchFn, hoje: new Date('2026-10-30T12:00:00Z') });
  assert.match(url, /bcdata\.sgs\.4390\/dados\?formato=json&dataInicial=01\/01\/2016&dataFinal=30\/10\/2026/);
  assert.deepStrictEqual(r, { gravados: 2, ultimo: '2026-09' });
  const P = paramReader();
  assert.strictEqual(P.get('selic', '2026-09'), 1.22);
  assert.strictEqual(P.get('selic', '2026-10'), null);
  // de novo: atualiza sem duplicar
  await integ.atualizarSelic({ fetchFn, hoje: new Date('2026-10-30T12:00:00Z') });
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM params WHERE tabela = 'selic'").get().n, 2);
  await assert.rejects(integ.atualizarSelic({ fetchFn: async () => ({ ok: false, status: 503 }) }), /respondeu 503/);
});

test('VAU colada: mesma linha, coluna seguinte, R$, acentos e números no nome', () => {
  const texto = `Destinação\tValor
R1 - Residência Unifamiliar\tR$ 2.345,67
RESIDENCIA MULTIFAMILIAR    2.123,45
Edifício de Garagens
R$ 1.987,00
Galpão Industrial 1.234,56
Conj. Habitacional Popular 1.100,10
Comercial - CAL 8 2.500,99
Casa Popular 999,90`;
  assert.deepStrictEqual(integ.lerVauColada(texto), [
    { destinacao: 'Residência unifamiliar', valor: 2345.67 }, { destinacao: 'Residência multifamiliar', valor: 2123.45 },
    { destinacao: 'Edifício de garagens', valor: 1987 }, { destinacao: 'Galpão industrial', valor: 1234.56 },
    { destinacao: 'Conjunto habitacional popular', valor: 1100.1 }, { destinacao: 'Comercial', valor: 2500.99 },
    { destinacao: 'Casa popular', valor: 999.9 },
  ]);
  const itens = integ.importarVauColada({ uf: 'GO', vigencia: '2026-09', texto: 'Residência unifamiliar R$ 2.345,67' }, 'teste');
  assert.strictEqual(itens.length, 1);
  assert.deepStrictEqual(paramReader().vau('GO', 'Residência unifamiliar', '2026-10'), { valor: 2345.67, vigencia: '2026-09' });
  assert.deepStrictEqual(integ.lerVauColada('texto qualquer sem valores'), []);
});

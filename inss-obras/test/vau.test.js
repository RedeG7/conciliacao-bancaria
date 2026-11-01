'use strict';
// Tabela VAU no formato do módulo VAU (JSON/CSV do e-CAC): validação "tudo ou
// nada", upsert, tela de importação por escritório e CSV.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inssobras-vau-'));
process.env.DATA_DIR = dir;
process.env.DEV_LOGIN = '1';
const app = require('../src/server');
const { db, paramReader } = require('../src/db');
const vau = require('../src/vau');

const reg = (competencia, uf, base) => ({ competencia, uf, casa_popular: base, comercial_salas_lojas: base + 1, conj_habitacional_popular: base + 2,
  edificio_garagens: base + 3, galpao_industrial: base + 4, residencial_multifamiliar: base + 5, residencial_unifamiliar: base + 6 });

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const login = async (qs = '') => (await fetch(`${base}/dev-login${qs}`, { redirect: 'manual' })).headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const post = (url, cookie, body) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const contar = () => db.prepare("SELECT COUNT(*) AS n FROM params WHERE tabela = 'vau'").get().n;

test('importação: JSON e CSV, tudo ou nada, upsert sem duplicar', () => {
  const r = vau.importar({ conteudo: JSON.stringify({ registros: [reg('2026-09', 'GO', 1000), reg('10/2026', 'GO', 1100), reg('2026-10', 'SP', 2000)] }), nome: 't.json' });
  assert.deepStrictEqual({ ...r, erros: undefined }, { registros: 21, competencias: 2, ufs: 2, inicio: '2026-09', fim: '2026-10', erros: undefined });
  const P = paramReader('');
  assert.strictEqual(P.vau('GO', 'Residência unifamiliar', '2026-10').valor, 1106);
  assert.strictEqual(P.vau('GO', 'Comercial', '2026-09').valor, 1001);
  // reimportar com valor novo: atualiza sem duplicar
  vau.importar({ conteudo: JSON.stringify([reg('2026-10', 'GO', 1200)]) });
  assert.strictEqual(contar(), 21);
  assert.strictEqual(paramReader('').vau('GO', 'Casa popular', '2026-10').valor, 1200);
  // uma linha inválida: nada é gravado
  const ruim = vau.importar({ conteudo: JSON.stringify({ registros: [reg('2026-11', 'GO', 1300), { ...reg('2026-11', 'XX', 1) }, { competencia: '2026-11', uf: 'MG', casa_popular: 1 }] }) });
  assert.strictEqual(ruim.registros, 0);
  assert.match(ruim.erros.join(' '), /registro 2: UF inválida/);
  assert.match(ruim.erros.join(' '), /registro 3: coluna ausente: comercial_salas_lojas/);
  assert.strictEqual(contar(), 21);
  // CSV do e-CAC (';', decimal ',', MM/AAAA)
  const csv = '﻿competencia;uf;casa_popular;comercial_salas_lojas;conj_habitacional_popular;edificio_garagens;galpao_industrial;residencial_multifamiliar;residencial_unifamiliar\n11/2026;GO;1.456,86;1.500,00;1.400,10;1.300,00;1.200,00;1.700,00;1.800,55';
  const rc = vau.importar({ conteudo: csv, nome: 'vau.csv' });
  assert.strictEqual(rc.registros, 7);
  assert.strictEqual(paramReader('').vau('GO', 'Residência unifamiliar', '2026-12').valor, 1800.55);
  assert.strictEqual(paramReader('').vau('GO', 'Casa popular', '2026-11').valor, 1456.86);
  assert.match(vau.importar({ conteudo: '{ruim' }).erros[0], /arquivo ilegível/);
});

test('tela: admin importa arquivo só para o escritório dele; filtro e CSV', async () => {
  const ck = await login('?u=adm&office=esc1');
  const corpo = JSON.stringify({ registros: [reg('2026-12', 'GO', 9000)] });
  let r = await post('/cadastros/parametros/vau/arquivo', ck, { conteudo: corpo, nome: 'meu.json' });
  assert.match(decodeURIComponent(r.headers.getSetCookie().join()), /VAU importada \(só deste escritório\): 7 valores/);
  assert.strictEqual(paramReader('esc1').vau('GO', 'Casa popular', '2026-12').valor, 9000);
  assert.strictEqual(paramReader('').vau('GO', 'Casa popular', '2026-12').valor, 1456.86);   // padrão intacto (vigente: 2026-11)
  r = await post('/cadastros/parametros/vau/arquivo', ck, { conteudo: JSON.stringify([{ competencia: '2026-12', uf: 'ZZ' }]), nome: 'ruim.json' });
  assert.match(decodeURIComponent(r.headers.getSetCookie().join()), /nada foi gravado/);
  const pg = await (await fetch(`${base}/cadastros/parametros/vau?fuf=GO&fano=2026`, { headers: { cookie: ck } })).text();
  assert.match(pg, /Última competência no banco: <b>2026-12<\/b>/);
  assert.match(pg, /R\$\s?9\.000,00/);
  const bruto = Buffer.from(await (await fetch(`${base}/cadastros/parametros/vau/csv?fuf=GO&fano=2026`, { headers: { cookie: ck } })).arrayBuffer());
  assert.deepStrictEqual([...bruto.subarray(0, 3)], [0xef, 0xbb, 0xbf]);   // BOM: o Excel abre com acentos
  const csv = bruto.subarray(3).toString('utf8');
  assert.match(csv, /^competencia;uf;casa_popular;/);
  assert.match(csv, /2026-12;GO;9000,00;9001,00/);
  // o CSV baixado volta a importar igual
  assert.strictEqual(vau.importar({ conteudo: csv, nome: 'volta.csv', office: 'esc2' }).erros.length, 0);
  // usuário comum não importa
  const ck2 = await login('?u=comum&office=esc1&admin=0');
  assert.strictEqual((await post('/cadastros/parametros/vau/arquivo', ck2, { conteudo: corpo })).status, 403);
});

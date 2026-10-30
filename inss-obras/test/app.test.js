'use strict';
// Fluxo pelo HTTP: login de desenvolvimento, VAU por CSV, simulação, "Simular
// em", proposta, formulário público (lead) e isolamento entre escritórios.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inssobras-'));
process.env.DATA_DIR = dir;
process.env.DEV_LOGIN = '1';
const app = require('../src/server');

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(qs = '') {
  const r = await fetch(`${base}/dev-login${qs}`, { redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
const form = o => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]))).toString();
const post = (url, cookie, body) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });

test('fluxo completo', async () => {
  assert.strictEqual((await get('/dash')).status, 401);
  const ck = await login();
  let r = await post('/cadastros/parametros/vau/importar', ck, { csv: 'uf;destinacao;vigencia;valor\nGO;Residência unifamiliar;2026-09;2.000,00\nXX;Nada;2026-09;1' });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.headers.getSetCookie().join()), /1 linha\(s\) importada/);

  r = await post('/acompanhamento-de-obras/clientes', ck, { tipo: 'PF', nome: 'Maria Obra', telefone: '62999990000' });
  assert.strictEqual(r.status, 302);
  const dados = { identifier: 'Casa Maria', client_id: '1', uf: 'GO', tipo_responsavel: 'PF', premoldado: '0', data_inicio: '2025-01-01', data_fim: '2025-12-31',
    dest_destinacao: 'Residência unifamiliar', dest_tipo_obra: 'Alvenaria', dest_categoria: 'Obra nova', dest_concreto: '0', dest_area: '150' };
  r = await post('/simuladores/obras-prediais/novo', ck, dados);
  assert.strictEqual(r.status, 302);
  const simUrl = r.headers.get('location');
  let pg = await (await get(simUrl, ck)).text();
  assert.match(pg, /R\$\s?8\.832,00/);         // 150 m² × 2000 × 20% × 40% × 36,8%

  // erro de cálculo volta ao formulário com a mensagem
  pg = await (await post('/simuladores/obras-prediais/novo', ck, { ...dados, uf: 'SP' })).text();
  assert.match(pg, /VAU não cadastrado para SP/);

  // Simular em -> fator de ajuste herda a RMT
  pg = await (await get('/simuladores/fator-de-ajuste-e-social/novo?base=1', ck)).text();
  assert.match(pg, /name="rmt" value="24000"/);
  r = await post('/simuladores/fator-de-ajuste-e-social/novo', ck, { identifier: 'Casa Maria', client_id: '1', base_simulation_id: '1', rmt: '24000', remuneracao_declarada: '13000', honorarios: '1500' });
  const sim2 = r.headers.get('location');
  r = await post(`${sim2}/proposta`, ck, {});
  pg = await (await get(r.headers.get('location'), ck)).text();
  assert.match(pg, /Proposta nº 1/);
  assert.match(pg, /R\$\s?1\.500,00/);

  // formulário público do escritório gera lead + resultado compartilhável
  const dash = await (await get('/dash', ck)).text();
  const link = dash.match(/\/simulador\/obras-prediais\/([\w-]+)/)[0];
  r = await post(link, '', { nome: 'Visitante', email: 'v@ex.com', telefone: '62988887777', uf: 'GO', tipo_responsavel: 'PJ', premoldado: '0',
    dest_destinacao: 'Residência unifamiliar', dest_tipo_obra: 'Alvenaria', dest_categoria: 'Obra nova', dest_concreto: '0', dest_area: '100' });
  assert.match(r.headers.get('location'), /^\/calculator\/show\//);
  pg = await (await get(r.headers.get('location'))).text();
  assert.match(pg, /R\$\s?14\.720,00/);         // 100 × 2000 × 20% × 36,8% (PJ, sem fator social)
  pg = await (await get('/ferramentas-extras/leads', ck)).text();
  assert.match(pg, /v@ex\.com/);

  // outro escritório não enxerga nada do primeiro
  const ck2 = await login('?u=outro&office=outro');
  assert.strictEqual((await get('/simulacoes/1', ck2)).status, 404);
  const pgOutro = await (await get('/ferramentas-extras/leads', ck2)).text();
  assert.doesNotMatch(pgOutro, /v@ex\.com/);
  // usuário comum (não global) não altera parâmetros
  assert.strictEqual((await post('/cadastros/parametros/aliquota/salvar', ck2, { id: '1', valor: '1' })).status, 403);
});

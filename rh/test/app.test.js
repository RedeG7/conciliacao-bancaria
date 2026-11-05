'use strict';
// Fluxo pelo HTTP: cadastro, permissões por papel, isolamento entre escritórios,
// desligamento, pesquisa anônima, importação e exportação.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
process.env.DATA_DIR = dir;
process.env.DEV_LOGIN = '1';
process.env.SSO_SECRET = 'segredo-teste';
const app = require('../src/server');

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); require('../src/db').db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(qs = '') {
  const r = await fetch(`${base}/dev-login${qs}`, { redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
const form = o => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]))).toString();
const post = (url, cookie, body) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const texto = async (url, cookie) => (await get(url, cookie)).text();
const CPF = '529.982.247-25';

test('sem login não entra e o bilhete do Hub funciona uma vez só', async () => {
  assert.strictEqual((await get('/dash')).status, 401);
  const corpo = Buffer.from(JSON.stringify({ sub: 'ana', name: 'Ana', admin: true, office: 'bilhete', office_name: 'Bilhete', exp: Math.floor(Date.now() / 1000) + 60, jti: 'x1' })).toString('base64url');
  const t = `${corpo}.${crypto.createHmac('sha256', 'segredo-teste').update(corpo).digest('base64url')}`;
  assert.strictEqual((await get(`/sso?t=${t}`)).status, 302);
  assert.strictEqual((await get(`/sso?t=${t}`)).status, 401);
  assert.strictEqual((await get(`/sso?t=${corpo}.falso`)).status, 401);
});

test('colaborador: cadastro, ficha, desligamento e recontratação', async () => {
  const ck = await login('?office=a&u=adm');
  let r = await post('/cad/departamentos/novo', ck, { nome: 'Contábil' });
  assert.strictEqual(r.status, 302);
  const dep = (await texto('/cad/departamentos', ck)).match(/\/cad\/departamentos\/(\d+)/)[1];

  r = await post('/cad/colaboradores/novo', ck, { nome: 'Maria', data_admissao: '2025-01-10', cpf: '111.111.111-11' });
  assert.strictEqual(r.status, 422, 'CPF inválido é recusado');
  assert.match(await r.text(), /CPF inválido/);

  r = await post('/cad/colaboradores/novo', ck, { nome: 'Maria <b>', data_admissao: '2025-01-10', cpf: CPF, salario: '3.500,50', departamento_id: dep });
  assert.strictEqual(r.status, 302);
  const ficha = r.headers.get('location');
  const id = ficha.match(/\d+/)[0];
  const t = await texto(ficha, ck);
  assert.match(t, /R\$\s*3\.500,50/);
  assert.match(t, /Maria &lt;b&gt;/, 'nome escapado');
  assert.ok(!t.includes('Maria <b>'));

  r = await post('/cad/colaboradores/novo', ck, { nome: 'Outra', data_admissao: '2025-01-10', cpf: CPF });
  assert.strictEqual(r.status, 422, 'CPF repetido é recusado');

  await post('/cad/motivos-demissao/novo', ck, { nome: 'Nova oportunidade' });
  r = await post(`/cad/colaboradores/${id}/desligar`, ck, { data: '2026-01-10', tipo: 'Voluntário', valor_rescisao: '1000' });
  assert.strictEqual(r.status, 302);
  assert.match(await texto('/cad/colaboradores?aba=Inativo', ck), /Maria/);
  assert.strictEqual((await post(`/cad/colaboradores/${id}/desligar`, ck, { data: '2026-01-10', tipo: 'Voluntário' })).status, 409);
  assert.strictEqual((await post(`/cad/colaboradores/${id}/reativar`, ck, {})).status, 302);
  assert.match(await texto('/cad/colaboradores', ck), /Maria/);
  assert.match(await texto(`/cad/colaboradores/${id}/ficha`, ck), /Recontratação/);
});

test('escritórios não se enxergam, nem por referência', async () => {
  const a = await login('?office=iso-a&u=adm-a'), b = await login('?office=iso-b&u=adm-b');
  await post('/cad/colaboradores/novo', a, { nome: 'Pessoa A', data_admissao: '2025-01-01' });
  const id = (await texto('/cad/colaboradores', a)).match(/\/cad\/colaboradores\/(\d+)\/ficha/)[1];
  assert.ok(!(await texto('/cad/colaboradores', b)).includes('Pessoa A'));
  assert.strictEqual((await get(`/cad/colaboradores/${id}/ficha`, b)).status, 404);
  assert.strictEqual((await post(`/cad/colaboradores/${id}`, b, { nome: 'x', data_admissao: '2025-01-01' })).status, 404);
  assert.strictEqual((await post(`/cad/colaboradores/${id}/apagar`, b, {})).status, 404);
  const r = await post('/cad/feedbacks/novo', b, { colaborador_id: id, data: '2026-01-01', classificacao: 'Positivo', texto: 'oi' });
  assert.strictEqual(r.status, 422, 'não aceita colaborador de outro escritório');
});

test('papéis: leitura não vê sensível nem altera; sem_salario não apaga o salário', async () => {
  const adm = await login('?office=pap&u=chefe');
  const leitura = await login('?office=pap&admin=0&u=estagio');
  const sem = await login('?office=pap&admin=0&u=analista');
  await post('/cad/colaboradores/novo', adm, { nome: 'Joao', data_admissao: '2025-01-01', cpf: CPF, salario: '9999' });
  await post('/cad/registro-de-saude/novo', adm, { colaborador_id: '1', tipo_exame: 'Periódico', data: '2026-01-01' });
  const id = (await texto('/cad/colaboradores', adm)).match(/\/cad\/colaboradores\/(\d+)\/ficha/)[1];

  const f = await texto(`/cad/colaboradores/${id}/ficha`, leitura);
  assert.ok(!f.includes(CPF) && !f.includes('9.999'), 'leitura não vê CPF nem salário');
  assert.ok(!(await texto(`/cad/colaboradores/${id}`, leitura)).includes('9999'));
  assert.ok(!(await texto('/cad/colaboradores/exportar', leitura)).includes(CPF), 'exportação também filtra');
  assert.strictEqual((await get('/cad/registro-de-saude', leitura)).status, 404);
  assert.strictEqual((await post(`/cad/colaboradores/${id}`, leitura, { nome: 'x', data_admissao: '2025-01-01' })).status, 403);
  assert.strictEqual((await get('/config/usuarios', leitura)).status, 403);

  assert.strictEqual((await post('/config/usuarios', adm, { hub_user: 'analista', papel: 'sem_salario' })).status, 302);
  assert.ok(!(await texto(`/cad/colaboradores/${id}`, sem)).includes('9999'));
  assert.strictEqual((await post(`/cad/colaboradores/${id}`, sem, { nome: 'Joao Editado', data_admissao: '2025-01-01', cpf: CPF })).status, 302);
  assert.match(await texto(`/cad/colaboradores/${id}/ficha`, adm), /Joao Editado[\s\S]*9\.999/, 'salário continua lá');
  assert.strictEqual((await post(`/cad/colaboradores/${id}/apagar`, sem, {})).status, 403);
});

test('pesquisa anônima: link público, uma resposta, resultado só com 3 ou mais', async () => {
  const ck = await login('?office=pesq&u=adm');
  let r = await post('/cad/pesquisas/novo', ck, { titulo: 'Clima', categoria: 'eNPS', status: 'Aberta' });
  assert.strictEqual(r.status, 302);
  const id = (await texto('/cad/pesquisas', ck)).match(/\/pesquisas\/(\d+)/)[1];
  const tela = await texto(`/pesquisas/${id}`, ck);
  const token = tela.match(/\/pesquisa\/([\w-]+)/)[1];
  assert.match(tela, /a partir de 3 respostas/);
  assert.strictEqual((await post(`/pesquisa/${token}`, '', { q0: '11' })).status, 422);
  for (const nota of ['10', '9', '3']) assert.strictEqual((await post(`/pesquisa/${token}`, '', { q0: nota })).status, 200);
  const res = await texto(`/pesquisas/${id}`, ck);
  assert.match(res, /eNPS/);
  assert.match(res, /<b>33<\/b>/, '2 promotores e 1 detrator de 3 = 33');
  r = await post(`/pesquisa/${token}`, 'rh_resp_' + id + '=1', { q0: '10' });
  assert.match(await r.text(), /já foi registrada/);
  r = await post(`/cad/pesquisas/${id}`, ck, { titulo: 'Clima', categoria: 'Outra', status: 'Aberta', perguntas: 'Outra pergunta' });
  assert.strictEqual(r.status, 422, 'perguntas travadas depois da 1ª resposta');
});

test('importação cria, atualiza por CPF, cria departamento e aponta erro por linha', async () => {
  const ck = await login('?office=imp&u=adm');
  const csv = 'Nome completo;CPF;Data de admissão;Departamento;Salário;Coluna X\nAna;529.982.247-25;01/02/2025;Fiscal;2.000,00;a\nSem data;;;Fiscal;;b\nBia;;15/03/2025;fiscal;;c';
  let t = await (await post('/config/importar', ck, { csv })).text();
  assert.match(t, /Linha 3: Preencha: Data de admissão/);
  assert.match(t, /Coluna X/);
  assert.strictEqual(((await texto('/cad/departamentos', ck)).match(/Fiscal/g) || []).length, 1, 'não duplica departamento');
  assert.match(await texto('/cad/colaboradores', ck), /Ana[\s\S]*Bia/);
  t = await (await post('/config/importar', ck, { csv: 'CPF;Salário\n52998224725;3000' })).text();
  assert.match(t, /Atualizados<\/small><b>1/);
  assert.match(await texto('/cad/colaboradores/exportar', ck), /Ana;.*R\$\s*3\.000,00/);
});

test('vínculo em massa, célula perigosa no CSV e matriz de potencial', async () => {
  const ck = await login('?office=mass&u=adm');
  await post('/cad/colaboradores/novo', ck, { nome: '=HYPERLINK("x")', data_admissao: '2025-01-01' });
  await post('/cad/colaboradores/novo', ck, { nome: 'Dois', data_admissao: '2025-01-01' });
  assert.match(await texto('/cad/colaboradores/exportar', ck), /"'=HYPERLINK/);
  const ids = [...(await texto('/cad/colaboradores', ck)).matchAll(/\/cad\/colaboradores\/(\d+)\/ficha/g)].map(m => m[1]);
  await post('/cad/beneficios/novo', ck, { nome: 'VR' });
  const ben = (await texto('/cad/beneficios', ck)).match(/\/cad\/beneficios\/(\d+)/)[1];
  assert.strictEqual((await post('/cad/beneficiarios/novo', ck, { beneficio_id: ben, colaborador_id: ids })).status, 302);
  assert.strictEqual((await post('/cad/beneficiarios/novo', ck, { beneficio_id: ben, colaborador_id: ids[0] })).status, 422, 'não repete');
  await post('/cad/ciclos-avaliacao/novo', ck, { titulo: '2026', inicio: '2026-01-01', fim: '2026-12-31', status: 'Aberto' });
  const ciclo = (await texto('/cad/ciclos-avaliacao', ck)).match(/\/cad\/ciclos-avaliacao\/(\d+)/)[1];
  await post('/cad/avaliacoes/novo', ck, { ciclo_id: ciclo, colaborador_id: ids[1], desempenho: '5', potencial: '5' });
  assert.match(await texto('/matriz-potencial', ck), /Talento de destaque \(1\)/);
  assert.strictEqual((await post('/cad/avaliacoes/novo', ck, { ciclo_id: ciclo, colaborador_id: ids[0], desempenho: '6', potencial: '5' })).status, 422);
});

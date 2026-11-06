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
// cadastro mínimo válido: cria departamento e cargo no escritório da sessão
const fixos = new Map();
async function base_colab(ck) {
  if (fixos.has(ck)) return fixos.get(ck);
  await post('/cad/departamentos/novo', ck, { nome: 'Geral' });
  await post('/cad/cargos/novo', ck, { nome: 'Analista' });
  const departamento_id = (await texto('/cad/departamentos', ck)).match(/\/cad\/departamentos\/(\d+)/)[1];
  const cargo_id = (await texto('/cad/cargos', ck)).match(/\/cad\/cargos\/(\d+)/)[1];
  const b = { nascimento: '1990-05-10', genero: 'Feminino', email: 'pessoa@exemplo.com', data_admissao: '2025-01-10', estrangeiro: '1', departamento_id, cargo_id };
  fixos.set(ck, b);
  return b;
}
const novoColab = async (ck, extra) => post('/cad/colaboradores/novo', ck, { ...(await base_colab(ck)), ...extra });

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

  r = await novoColab(ck, { nome: 'Maria', cpf: '111.111.111-11', estrangeiro: '0' });
  assert.strictEqual(r.status, 422, 'CPF inválido é recusado');
  assert.match(await r.text(), /CPF inválido/);

  r = await novoColab(ck, { nome: 'Maria <b>', cpf: CPF, salario: '3.500,50', departamento_id: dep, estrangeiro: '0' });
  assert.strictEqual(r.status, 302);
  const ficha = r.headers.get('location');
  const id = ficha.match(/\d+/)[0];
  const t = await texto(ficha, ck);
  assert.match(t, /R\$\s*3\.500,50/);
  assert.match(t, /Maria &lt;b&gt;/, 'nome escapado');
  assert.ok(!t.includes('Maria <b>'));

  r = await novoColab(ck, { nome: 'Outra', cpf: CPF, estrangeiro: '0' });
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
  await novoColab(a, { nome: 'Pessoa A' });
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
  await novoColab(adm, { nome: 'Joao', cpf: CPF, salario: '9999', estrangeiro: '0' });
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
  assert.strictEqual((await post(`/cad/colaboradores/${id}`, sem, { ...(await base_colab(adm)), nome: 'Joao Editado', cpf: CPF, estrangeiro: '0' })).status, 302);
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
  const cab = 'Nome;CPF;Estrangeiro;Data de Nascimento;Sexo;Email;Data de admissão;Departamento;Cargo;Tipo de contrato;Salário;Estado Civil;CTPS NUM;Coluna X';
  const csv = `${cab}\nAna;529.982.247-25;não;10/05/1990;feminino;a@x.com;01/02/2025;Fiscal;Analista;clt + comissao;2.000,00;Uniao Estavel;123;a\n`
    + 'Sem data;;sim;10/05/1990;Feminino;b@x.com;;Fiscal;Analista;CLT;;;;b\n'
    + 'Bia;;sim;10/05/1990;Feminino;c@x.com;15/03/2025;fiscal;Analista;CLT;;;;c';
  let t = await (await post('/config/importar', ck, { csv })).text();
  assert.match(t, /Linha 3:.*Data de admissão/);
  assert.match(t, /Coluna X/);
  assert.strictEqual(((await texto('/cad/departamentos', ck)).match(/Fiscal/g) || []).length, 1, 'não duplica departamento');
  assert.match(await texto('/cad/colaboradores', ck), /Ana[\s\S]*Bia/);
  t = await (await post('/config/importar', ck, { csv: 'CPF;Salário\n52998224725;3000' })).text();
  assert.match(t, /Atualizados<\/small><b>1/);
  assert.match(await texto('/cad/colaboradores/exportar', ck), /Ana;.*R\$\s*3\.000,00/);
});

test('vínculo em massa, célula perigosa no CSV e matriz de potencial', async () => {
  const ck = await login('?office=mass&u=adm');
  await novoColab(ck, { nome: '=HYPERLINK("x")' });
  await novoColab(ck, { nome: 'Dois' });
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

test('experiência e contrato pela duração, insalubridade, CPF e opção fora da lista', async () => {
  const ck = await login('?office=prazo&u=adm');
  let r = await novoColab(ck, { nome: 'Prazo', data_admissao: '2026-01-01', periodo_experiencia: '45', data_contrato: '2026-01-01', duracao_contrato: '90', percentual_insalubridade: '20%' });
  assert.strictEqual(r.status, 302);
  const ficha = r.headers.get('location'), id = ficha.match(/\d+/)[0];
  const t = await texto(ficha, ck);
  assert.match(t, /14\/02\/2026/, 'fim da experiência = admissão + 45 dias');
  assert.match(t, /31\/03\/2026/, 'vencimento = contrato + 90 dias');
  assert.ok(!t.includes('20%'), 'sem insalubridade não guarda percentual');
  r = await novoColab(ck, { nome: 'Sem CPF', estrangeiro: '0' });
  assert.strictEqual(r.status, 422);
  assert.match(await r.text(), /Preencha: CPF/);
  assert.strictEqual((await post(`/cad/colaboradores/${id}`, ck, { ...(await base_colab(ck)), nome: 'Prazo', estado_civil: 'Solteiro(a)' })).status, 422, 'opção fora da lista é recusada');
});

test('treinamento com horas e competências; PDI a partir de quem foi avaliado', async () => {
  const ck = await login('?office=treino&u=adm'), outro = await login('?office=treino2&u=adm2');
  await post('/cad/competencias/novo', ck, { nome: 'Comunicação' });
  await post('/cad/competencias/novo', ck, { nome: 'Liderança' });
  await post('/cad/competencias/novo', outro, { nome: 'De outro escritório' });
  const comp = [...(await texto('/cad/competencias', ck)).matchAll(/\/cad\/competencias\/(\d+)"/g)].map(m => m[1]);
  const alheia = (await texto('/cad/competencias', outro)).match(/\/cad\/competencias\/(\d+)"/)[1];
  const base = { titulo: 'NR-35', conteudo: 'Altura', objetivos: 'Segurança', carga_horaria: '8:30', status: 'Concluído', validade_meses: '12' };
  assert.strictEqual((await post('/cad/treinamentos/novo', ck, { ...base, competencias: [comp[0], alheia] })).status, 422, 'competência de outro escritório');
  assert.strictEqual((await post('/cad/treinamentos/novo', ck, { ...base, carga_horaria: '8:99' })).status, 422);
  assert.strictEqual((await post('/cad/treinamentos/novo', ck, { ...base, competencias: comp })).status, 302);
  assert.match(await texto('/cad/treinamentos', ck), /08:30/);
  const tid = (await texto('/cad/treinamentos', ck)).match(/\/cad\/treinamentos\/(\d+)/)[1];
  const form = await texto(`/cad/treinamentos/${tid}`, ck);
  assert.match(form, /value="08:30"/);
  assert.strictEqual((form.match(/<option value="\d+" selected>/g) || []).length, 2, 'competências continuam marcadas');

  await novoColab(ck, { nome: 'Avaliada' });
  const id = (await texto('/cad/colaboradores', ck)).match(/\/cad\/colaboradores\/(\d+)\/ficha/)[1];
  await post('/cad/participantes-treinamento/novo', ck, { treinamento_id: tid, colaborador_id: id, status: 'Concluiu', data_conclusao: '2025-06-10' });
  assert.match(await texto('/cad/participantes-treinamento', ck), /10\/06\/2026/, 'vencimento = conclusão + 12 meses');

  await post('/cad/ciclos-avaliacao/novo', ck, { titulo: 'Ciclo A', inicio: '2026-01-01', fim: '2026-12-31', status: 'Aberto' });
  const ciclo = (await texto('/cad/ciclos-avaliacao', ck)).match(/\/cad\/ciclos-avaliacao\/(\d+)/)[1];
  await post('/cad/avaliacoes/novo', ck, { ciclo_id: ciclo, colaborador_id: id, desempenho: '2', potencial: '3' });
  const sem = await texto('/cad/pdi/avaliados-sem-pdi', ck);
  assert.match(sem, /Avaliada/);
  assert.ok(sem.includes(`/cad/pdi/novo?colaborador_id=${id}&ciclo_id=${ciclo}`));
  assert.match(await texto(`/cad/pdi/novo?colaborador_id=${id}&ciclo_id=${ciclo}`, ck), new RegExp(`<option value="${ciclo}" selected>`));
  assert.match(await texto('/cad/pdi', ck), /Avaliados sem PDI/);
  await post('/cad/pdi/novo', ck, { colaborador_id: id, ciclo_id: ciclo, titulo: 'Plano', inicio: '2026-01-01', entrega: '2026-06-01', status: 'Aberto' });
  assert.ok(!(await texto('/cad/pdi/avaliados-sem-pdi', ck)).includes('Avaliada'));
  assert.match(await texto('/cad/pdi', ck), /Ciclo A/);
});

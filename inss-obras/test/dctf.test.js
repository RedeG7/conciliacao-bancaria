'use strict';
// DCTF Web: certificado do procurador, cliente com procuração/S-1000,
// autônomos, obra com trabalhadores, envio com folha, fechamento, relatório e
// guia de envio com progresso detectado pelos dados.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inssobras-dctf-'));
process.env.DATA_DIR = dir;
process.env.DEV_LOGIN = '1';
process.env.CERT_ENC_KEY = 'chave-de-teste';
const app = require('../src/server');
const { db } = require('../src/db');

// certificado A1 autoassinado no formato ICP-Brasil ("RAZAO SOCIAL:CNPJ")
function gerarPfx(senha, dias) {
  const k = forge.pki.rsa.generateKeyPair(1024);
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey; c.serialNumber = '01';
  c.validity.notBefore = new Date(Date.now() - 864e5);
  c.validity.notAfter = new Date(Date.now() + dias * 864e5);
  c.setSubject([{ name: 'commonName', value: forge.util.encodeUtf8('ESCRITÓRIO CONTÁBIL LTDA:12345678000199') }]);
  c.setIssuer([{ name: 'commonName', value: 'AC TESTE' }]);
  c.sign(k.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(k.privateKey, [c], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
}

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const login = async (qs = '') => (await fetch(`${base}/dev-login${qs}`, { redirect: 'manual' })).headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const form = o => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]))).toString();
const post = (url, cookie, body) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
const get = async (url, cookie) => (await fetch(base + url, { headers: { cookie } })).text();
const flashDe = r => decodeURIComponent(r.headers.getSetCookie().join());
const progresso = async (ck, cli) => (await get(`/guia-de-envio/${cli}`, ck)).match(/(\d) de 8 passos/)[1];

test('fluxo do módulo DCTF Web', async () => {
  const ck = await login();
  await post('/cadastros/parametros/vau/importar', ck, { csv: 'GO;Residência unifamiliar;2026-09;2000' });

  // certificado do procurador (sem cliente)
  let r = await post('/cadastros/certificados', ck, { pfx_b64: gerarPfx('certa', 20), senha: 'errada' });
  assert.match(flashDe(r), /Senha do certificado incorreta/);
  r = await post('/cadastros/certificados', ck, { pfx_b64: gerarPfx('certa', 20), senha: 'certa', arquivo_nome: 'procurador.pfx' });
  assert.match(flashDe(r), /ESCRITÓRIO CONTÁBIL LTDA importado/);
  let pg = await get('/cadastros/certificados', ck);
  assert.match(pg, /e-CNPJ 12345678000199/);
  assert.match(await get('/dash', ck), /Certificado do procurador ESCRITÓRIO CONTÁBIL LTDA vence em/);
  const row = db.prepare('SELECT * FROM certificates').get();
  assert.strictEqual(require('../src/certificados').decifrar(row.senha_enc).toString(), 'certa');

  // cliente + guia: só o passo 1
  await post('/acompanhamento-de-obras/clientes', ck, { tipo: 'PF', nome: 'Maria Obra', documento: '12345678901' });
  await post('/guia-de-envio', ck, { client_id: '1' });
  assert.strictEqual(await progresso(ck, 1), '1');

  // simulação predial + fator de ajuste eSocial
  await post('/simuladores/obras-prediais/novo', ck, { identifier: 'Casa Maria', client_id: '1', uf: 'GO', tipo_responsavel: 'PF', premoldado: '0',
    data_inicio: '2026-01-01', data_fim: '2026-12-31', dest_destinacao: 'Residência unifamiliar', dest_tipo_obra: 'Alvenaria', dest_categoria: 'Obra nova', dest_concreto: '0', dest_area: '150' });
  await post('/simuladores/fator-de-ajuste-e-social/novo', ck, { identifier: 'Casa Maria', client_id: '1', base_simulation_id: '1', rmt: '24000', remuneracao_declarada: '0', data_inicio: '2026-01-01', data_fim: '2026-12-31' });
  assert.strictEqual(await progresso(ck, 1), '3');

  // sem procuração o envio é bloqueado
  pg = await get('/dctf-web/cadastrar?cliente=1', ck);
  assert.match(pg, /ainda não tem procuração eletrônica vigente/);
  r = await post('/dctf-web/cadastrar', ck, { client_id: '1', work_id: '1', esocial_id: '2' });
  assert.match(flashDe(r), /sem procuração vigente/);

  // completar cliente: procuração, certificado do procurador, S-1000
  r = await post('/clientes/1?guia=1', ck, { tipo: 'PF', nome: 'Maria Obra', documento: '12345678901', possui_procuracao: '1', procuracao_data_assinatura: '2026-01-01',
    procuracao_data_fim: '2030-01-01', certificate_id: '1', class_trib: '21', s1000_recibo: '1.1.0000000000000000001' });
  assert.strictEqual(r.headers.get('location'), '/guia-de-envio/1');
  assert.strictEqual(await progresso(ck, 1), '4');

  // autônomos (CPF validado) e obra com trabalhadores
  r = await post('/acompanhamento-de-obras/autonomos/cadastrar', ck, { client_id: '1', name: 'João Pedreiro', document: '123' });
  assert.strictEqual(r.status, 422);
  await post('/acompanhamento-de-obras/autonomos/cadastrar', ck, { client_id: '1', name: 'João Pedreiro', document: '111.222.333-44', category: '701', cbo: '710205' });
  await post('/acompanhamento-de-obras/autonomos/cadastrar', ck, { client_id: '1', name: 'José Servente', document: '55566677788' });
  assert.match(await get('/acompanhamento-de-obras/autonomos', ck), /11122233344/);
  r = await post('/acompanhamento-de-obras/obras', ck, { client_id: '1', calculator_id: '1', custom_name: 'Rua X Q18 L37', cno: '90.000.00001/71', uf: 'GO',
    data_inicio: '2026-01-01', data_fim: '2026-12-31', mason_id: ['1', '2'], mason_start: ['2026-01-01', '2026-06-01'], mason_end: ['', ''], par_ini: '2026-03-01', par_fim: '2026-03-31' });
  assert.strictEqual(r.headers.get('location'), '/obras/1');
  assert.strictEqual(await progresso(ck, 1), '6');

  // envio DCTFWeb
  r = await post('/dctf-web/cadastrar', ck, { client_id: '1', work_id: '1', esocial_id: '2' });
  assert.strictEqual(r.headers.get('location'), '/dctf-web/editar/1');
  pg = await get('/dctf-web/editar/1', ck);
  assert.match(pg, /ESCRITÓRIO CONTÁBIL LTDA/);         // certificado do procurador no cartão
  assert.match(pg, /90\.000\.00001\/71/);
  assert.match(pg, /min="2021-10-01"/);
  // data de início antes da obrigatoriedade é recusada
  r = await post('/dctf-web/editar/1', ck, { work_id: '1', esocial_id: '2', status: 'mensal', construction_init_date: '2021-01-01' });
  assert.match(flashDe(r), /não pode ser antes de 01\/10\/2021/);
  await post('/dctf-web/editar/1', ck, { work_id: '1', esocial_id: '2', status: 'mensal', construction_init_date: '2026-01-01', construction_end_date: '2026-12-31',
    send1005: '1', send1010: 'inclusao', rubric_code: '1', irrf: '11', send1020: 'inclusao', tax_allocation_code: '1', question1: '1', question2: '1' });

  // adicionar mês: entra só quem está ativo no mês, com o valor calculado dividido
  r = await post('/dctf-web/1/meses', ck, { competencia: '2026-02' });
  assert.match(flashDe(r), /com 1 autônomo/);
  r = await post('/dctf-web/1/meses', ck, { competencia: '2026-07' });
  assert.match(flashDe(r), /com 2 autônomo/);
  const itens = db.prepare('SELECT * FROM payroll_items WHERE payroll_month_id = 2').all();
  // alvo = 50% de 24000 = 12000 / 11 meses (março paralisado) = 1090,91 por mês, metade para cada
  assert.deepStrictEqual(itens.map(i => i.calc_base), [545.45, 545.45]);
  pg = await get('/dctf-web/editar/1', ck);
  assert.match(pg, /Quadro de cálculo/);
  assert.match(pg, /Julho de 2026/);

  // registrar envio do mês (remuneração e pagamento) e encerrar a folha
  await post('/dctf-web/1/meses/2', ck, { item_mason: ['1', '2', '99'], item_iddmdev: ['1', '2', 'x'], item_valor: ['600,00', '400,00', '1'], item_pagto: ['2026-07-31', '2026-07-31', ''],
    item_rec1200: ['r1', 'r2', ''], item_rec1210: ['p1', 'p2', ''], status: 'enviado', is_paralyzed: '0' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM payroll_items WHERE payroll_month_id = 2').get().n, 2); // autônomo de fora da obra ignorado
  assert.strictEqual(await progresso(ck, 1), '7');
  await post('/dctf-web/1/fechar', ck, { fechar_mes: '2', nr_rec_1299: 'f1' });
  assert.strictEqual(await progresso(ck, 1), '8');
  assert.match(await get('/guia-de-envio?aba=completed', ck), /Maria Obra/);
  assert.match(await get('/dctf-web', ck), /2026-07/);

  // relatório e recibo
  pg = await get('/dctf-web/visualizar/1', ck);
  assert.match(pg, /S-1005 Estabelecimento\/obra/);
  assert.match(pg, /João Pedreiro/);
  assert.match(await get('/dctf-web/1/meses/2/recibo', ck), /Recibo de pagamento a autônomo/);

  // reabrir volta o guia para em andamento
  await post('/dctf-web/1/meses/2/reabrir', ck, {});
  assert.strictEqual(await progresso(ck, 1), '6');

  // outro escritório não vê nada
  const ck2 = await login('?u=outro&office=outro');
  assert.doesNotMatch(await get('/cadastros/certificados', ck2), /12345678000199/);
  assert.strictEqual((await fetch(base + '/dctf-web/editar/1', { headers: { cookie: ck2 } })).status, 404);
  assert.strictEqual((await fetch(base + '/guia-de-envio/1', { headers: { cookie: ck2 } })).status, 404);
  assert.doesNotMatch(await get('/acompanhamento-de-obras/autonomos', ck2), /João/);
});

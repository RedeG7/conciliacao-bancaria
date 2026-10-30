'use strict';
// DCTF Web: certificado A1 (leitura, senha errada, cifra, isolamento), obra,
// envio com passo a passo, próxima competência e guia de envio.
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
  c.setSubject([{ name: 'commonName', value: forge.util.encodeUtf8('CONSTRUTORA ÁGUA LTDA:12345678000199') }]);
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

test('certificado, obra, envio DCTFWeb e guia', async () => {
  const ck = await login();
  await post('/acompanhamento-de-obras/clientes', ck, { tipo: 'PJ', nome: 'Construtora Água' });

  // senha errada
  let r = await post('/cadastros/certificados', ck, { client_id: '1', pfx_b64: gerarPfx('certa', 20), senha: 'errada', arquivo_nome: 'a.pfx' });
  assert.match(flashDe(r), /Senha do certificado incorreta/);
  // arquivo que não é certificado
  r = await post('/cadastros/certificados', ck, { client_id: '1', pfx_b64: Buffer.from('nada').toString('base64'), senha: 'x' });
  assert.match(flashDe(r), /não é um certificado A1/);
  // certificado válido, vencendo em 20 dias
  r = await post('/cadastros/certificados', ck, { client_id: '1', pfx_b64: gerarPfx('certa', 20), senha: 'certa', arquivo_nome: 'agua.pfx' });
  assert.match(flashDe(r), /CONSTRUTORA ÁGUA LTDA importado/);
  let pg = await get('/cadastros/certificados', ck);
  assert.match(pg, /CNPJ 12345678000199/);
  assert.match(pg, /Expira em (19|20) dia/);
  assert.match(await get('/dash', ck), /Certificado de Construtora Água vence em/);
  // no banco nada fica em claro
  const row = db.prepare('SELECT * FROM certificates').get();
  assert.doesNotMatch(row.senha_enc, /certa/);
  assert.notStrictEqual(require('../src/certificados').decifrar(row.senha_enc).toString(), '');
  assert.strictEqual(require('../src/certificados').decifrar(row.senha_enc).toString(), 'certa');

  // atualizar: troca pelo certificado novo (validade longa)
  r = await post('/cadastros/certificados/atualizar', ck, { substituir: '1', pfx_b64: gerarPfx('nova', 365), senha: 'nova' });
  assert.match(flashDe(r), /Certificado atualizado/);
  assert.doesNotMatch(await get('/dash', ck), /Certificado de Construtora Água/);

  // obra e envio
  await post('/acompanhamento-de-obras/obras', ck, { client_id: '1', cno: '90.000.00001/71', endereco: 'Rua A, 10', uf: 'GO', status: 'Em andamento' });
  pg = await get('/dctf-web/novo?obra=1', ck);
  assert.match(pg, /<option value="1" selected>Construtora Água/);
  r = await post('/dctf-web/novo', ck, { client_id: '1', work_id: '1', certificate_id: '1', competencia: '2026-09', status: 'Mensal', esocial_status: 'Não iniciado' });
  const envio = r.headers.get('location');
  assert.strictEqual(envio, '/dctf-web/1');
  await post('/dctf-web/1/passos', ck, { passo: ['0', '1', '2', '3', '4'] });
  pg = await get(envio, ck);
  assert.match(pg, /Passo a passo \(71%\)/);
  assert.match(pg, /<option value="Fechado \(S-1299\)" selected>/);
  assert.match(await get('/dctf-web', ck), /90\.000\.00001\/71/);

  // pausa -> aba Pausados do guia; próxima competência do envio mensal
  await post('/dctf-web/1/pausar', ck, {});
  assert.match(await get('/guia-de-envio?aba=pausados', ck), /Construtora Água/);
  r = await post('/dctf-web/1/proxima', ck, {});
  assert.strictEqual(r.headers.get('location'), '/dctf-web/2');
  assert.match(await get('/dctf-web/2', ck), /DCTFWeb 2026-10/);
  assert.strictEqual((await post('/dctf-web/1/proxima', ck, {})).headers.get('location'), '/dctf-web/2'); // não duplica
  assert.match(await get('/dctf-web?status=Mensal&de=2026-10', ck), /2026-10/);

  // outro escritório não vê certificado, obra nem envio
  const ck2 = await login('?u=outro&office=outro');
  assert.doesNotMatch(await get('/cadastros/certificados', ck2), /12345678000199/);
  assert.strictEqual((await fetch(base + '/dctf-web/1', { headers: { cookie: ck2 } })).status, 404);
  assert.strictEqual((await post('/cadastros/certificados/1/excluir', ck2, {})).status, 404); // não acha o de outro escritório

  // excluir apaga o conteúdo cifrado
  await post('/cadastros/certificados/1/excluir', ck, {});
  assert.strictEqual(db.prepare('SELECT pfx_enc FROM certificates WHERE id = 1').get().pfx_enc, '');
});

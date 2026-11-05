'use strict';
// Transmissão do S-1000 com o eSocial simulado: XML do evento, assinatura
// válida, envio do lote, consulta do protocolo (101 -> 201), recibo gravado no
// cliente, rejeição com ocorrências e a tela "Salvar e enviar" + andamento.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inssobras-esocial-'));
process.env.DATA_DIR = dir;
process.env.DEV_LOGIN = '1';
process.env.CERT_ENC_KEY = 'chave-de-teste';
const app = require('../src/server');
const { db } = require('../src/db');
const esocial = require('../src/esocial');
const { SignedXml } = require('xml-crypto');

function gerarPfx(senha) {
  const k = forge.pki.rsa.generateKeyPair(1024);
  const c = forge.pki.createCertificate();
  c.publicKey = k.publicKey; c.serialNumber = '01';
  c.validity.notBefore = new Date(Date.now() - 864e5); c.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  c.setSubject([{ name: 'commonName', value: 'ESCRITORIO CONTABIL LTDA:12345678000199' }]);
  c.setIssuer([{ name: 'commonName', value: 'AC TESTE' }]);
  c.sign(k.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(k.privateKey, [c], senha, { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
}
const env = corpo => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${corpo}</s:Body></s:Envelope>`;
const RET_ENVIO_OK = env('<EnviarLoteEventosResponse><EnviarLoteEventosResult><eSocial xmlns="http://www.esocial.gov.br/schema/lote/eventos/envio/retornoEnvio/v1_1_0"><retornoEnvioLoteEventos>'
  + '<status><cdResposta>201</cdResposta><descResposta>Lote Recebido com Sucesso.</descResposta></status>'
  + '<dadosRecepcaoLote><protocoloEnvio>1.2.202611.0000000000000000077</protocoloEnvio></dadosRecepcaoLote></retornoEnvioLoteEventos></eSocial></EnviarLoteEventosResult></EnviarLoteEventosResponse>');
const RET_101 = env('<ConsultarLoteEventosResponse><ConsultarLoteEventosResult><eSocial><retornoProcessamentoLoteEventos><status><cdResposta>101</cdResposta><descResposta>Lote Aguardando Processamento.</descResposta></status></retornoProcessamentoLoteEventos></eSocial></ConsultarLoteEventosResult></ConsultarLoteEventosResponse>');
const retConsulta = (cd, extra) => env('<ConsultarLoteEventosResponse><ConsultarLoteEventosResult><eSocial><retornoProcessamentoLoteEventos>'
  + '<status><cdResposta>201</cdResposta><descResposta>Lote processado com sucesso.</descResposta></status><retornoEventos><evento Id="ID1"><retornoEvento>'
  + `<eSocial xmlns="http://www.esocial.gov.br/schema/evt/retornoEvento/v1_2_1"><retornoEvento Id="ID1"><processamento><cdResposta>${cd}</cdResposta><descResposta>${cd === '201' ? 'Sucesso.' : 'Evento rejeitado.'}</descResposta>${extra}</processamento>`
  + `${cd === '201' ? '<recibo><nrRecibo>1.1.0000000000000000123</nrRecibo></recibo>' : ''}</retornoEvento></eSocial></retornoEvento></evento></retornoEventos></retornoProcessamentoLoteEventos></eSocial></ConsultarLoteEventosResult></ConsultarLoteEventosResponse>`);

let server, base;
test.before(() => new Promise(r => { esocial.setIntervalo(5); server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const login = async () => (await fetch(`${base}/dev-login`, { redirect: 'manual' })).headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const post = (url, cookie, body) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const ate = async (cond, ms = 2000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('tempo esgotado'); await new Promise(r => setTimeout(r, 10)); } };

test('S-1000: XML, Id e assinatura válida', () => {
  const { id, xml } = esocial.xmlS1000({ documento: '529.982.247-25', s1000_inicio: '2021-01', class_trib: '21', ind_desoneracao: '0', ind_opt_reg_eletron: '0', pis_pasep: 0 }, 2, new Date(2026, 10, 5, 9, 8, 7));
  assert.match(id, /^ID2529982247250002026110509080700001$/);
  assert.strictEqual(id.length, 36);
  assert.match(xml, /<tpAmb>2<\/tpAmb>.*<tpInsc>2<\/tpInsc><nrInsc>52998224725<\/nrInsc>.*<iniValid>2021-01<\/iniValid>.*<classTrib>21<\/classTrib><indDesFolha>0<\/indDesFolha><indOptRegEletron>0<\/indOptRegEletron><\/infoCadastro>/);
  assert.doesNotMatch(xml, /indTribFolhaPisPasep/);
  const pem = require('../src/certificados').pemDoCertificado(Buffer.from(gerarPfx('s'), 'base64'), 's');
  const assinado = esocial.assinar(xml, pem);
  assert.match(assinado, /<\/evtInfoEmpregador><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">.*rsa-sha256.*<Reference URI="">.*enveloped-signature.*<X509Certificate>.*<\/Signature><\/eSocial>$/);
  const v = new SignedXml({ publicCert: pem.certPem });
  v.loadSignature(assinado.match(/<Signature[\s\S]*<\/Signature>/)[0]);
  assert.strictEqual(v.checkSignature(assinado), true);
  assert.strictEqual(esocial.cpfValido('52998224725'), true);
  assert.strictEqual(esocial.cpfValido('52998224724'), false);
});

test('Salvar e enviar: envio, processamento, recibo; rejeição com ocorrências', async () => {
  const ck = await login();
  await post('/cadastros/certificados', ck, { pfx_b64: gerarPfx('certa'), senha: 'certa' });
  await post('/acompanhamento-de-obras/clientes', ck, { tipo: 'PF', nome: 'Maria Obra', documento: '52998224725' });
  // formulário completo já vem com procuração "Sim", o certificado e o S-1000 padrão
  let pg = await (await fetch(`${base}/clientes/1?guia=1`, { headers: { cookie: ck } })).text();
  assert.match(pg, /name="possui_procuracao"[^>]*><option value="0" >Não<\/option><option value="1" selected>Sim/);
  assert.match(pg, /name="certificate_id"[^>]*>.*<option value="1" selected>/s);
  assert.match(pg, /name="s1000_inicio" value="2021-01"/);
  assert.match(pg, /Salvar e enviar/);

  const chamadas = [];
  const respostas = [RET_ENVIO_OK, RET_101, retConsulta('201', '')];
  esocial.setTransporte(async (url, acao, corpo, pem) => { chamadas.push({ url, acao, corpo, pem }); return { status: 200, corpo: respostas.shift() }; });
  const dados = { tipo: 'PF', nome: 'Maria Obra', documento: '52998224725', possui_procuracao: '1', procuracao_data_assinatura: '2026-01-01',
    procuracao_data_fim: '2030-01-01', certificate_id: '1', s1000_inicio: '2021-01', class_trib: '21', ind_opt_reg_eletron: '0', ind_desoneracao: '0', pis_pasep: '0' };
  // sem procuração: não envia e explica
  let r = await post('/clientes/1?guia=1', ck, { ...dados, procuracao_data_fim: '', enviar: '1' });
  assert.match(decodeURIComponent(r.headers.getSetCookie().join()), /S-1000 não foi enviado.*procuração eletrônica vigente/);
  r = await post('/clientes/1?guia=1', ck, { ...dados, enviar: '1' });
  assert.strictEqual(r.headers.get('location'), '/esocial/envios/1');
  pg = await (await fetch(`${base}/esocial/envios/1`, { headers: { cookie: ck } })).text();
  assert.match(pg, /Produção restrita \(testes\)/);
  await ate(() => db.prepare('SELECT status FROM esocial_logs WHERE id = 1').get().status === 'recebido');
  assert.strictEqual(db.prepare('SELECT s1000_recibo FROM clients WHERE id = 1').get().s1000_recibo, '1.1.0000000000000000123');
  const j = await (await fetch(`${base}/esocial/envios/1.json`, { headers: { cookie: ck } })).json();
  assert.deepStrictEqual([j.status, j.protocolo, j.recibo], ['recebido', '1.2.202611.0000000000000000077', '1.1.0000000000000000123']);
  // o que foi enviado: produção restrita, lote grupo 1, empregador CPF, transmissor CNPJ do procurador, evento assinado
  assert.strictEqual(chamadas.length, 3);
  assert.match(chamadas[0].url, /producaorestrita.*WsEnviarLoteEventos/);
  assert.match(chamadas[0].corpo, /<envioLoteEventos grupo="1"><ideEmpregador><tpInsc>2<\/tpInsc><nrInsc>52998224725<\/nrInsc><\/ideEmpregador><ideTransmissor><tpInsc>1<\/tpInsc><nrInsc>12345678000199<\/nrInsc>/);
  assert.match(chamadas[0].corpo, /<evento Id="ID2529982247250\d+"><eSocial xmlns="[^"]+evtInfoEmpregador[^"]+">.*<Signature/);
  assert.match(chamadas[1].corpo, /<protocoloEnvio>1\.2\.202611\.0000000000000000077<\/protocoloEnvio>/);
  assert.match(chamadas[0].pem.keyPem, /PRIVATE KEY/);
  // depois do recibo, o botão volta a ser só "Salvar"
  pg = await (await fetch(`${base}/clientes/1?guia=1`, { headers: { cookie: ck } })).text();
  assert.match(pg, /Empregador já cadastrado no eSocial \(recibo 1\.1\.0000000000000000123\)/);
  assert.doesNotMatch(pg, /Salvar e enviar/);

  // rejeição: mostra as ocorrências e permite tentar de novo
  db.prepare("UPDATE clients SET s1000_recibo = '' WHERE id = 1").run();
  respostas.push(RET_ENVIO_OK, retConsulta('401', '<ocorrencias><ocorrencia><codigo>1234</codigo><descricao>Empregador já cadastrado.</descricao><localizacao>/eSocial/evtInfoEmpregador</localizacao></ocorrencia></ocorrencias>'));
  r = await post('/clientes/1?guia=1', ck, { ...dados, enviar: '1' });
  await ate(() => db.prepare('SELECT status FROM esocial_logs WHERE id = 2').get().status === 'erro');
  const log = db.prepare('SELECT * FROM esocial_logs WHERE id = 2').get();
  assert.match(log.mensagem, /401 - Evento rejeitado\.\n1234 - Empregador já cadastrado\. \(\/eSocial\/evtInfoEmpregador\)/);
  // lote recusado logo no envio
  respostas.push(env('<EnviarLoteEventosResponse><EnviarLoteEventosResult><eSocial><retornoEnvioLoteEventos><status><cdResposta>402</cdResposta><descResposta>Lote com erro de schema.</descResposta>'
    + '<ocorrencias><ocorrencia><codigo>142</codigo><descricao>Schema inválido.</descricao></ocorrencia></ocorrencias></status></retornoEnvioLoteEventos></eSocial></EnviarLoteEventosResult></EnviarLoteEventosResponse>'));
  r = await post('/esocial/envios/2/tentar', ck, {});
  assert.strictEqual(r.headers.get('location'), '/esocial/envios/3');
  await ate(() => db.prepare('SELECT status FROM esocial_logs WHERE id = 3').get().status === 'erro');
  assert.match(db.prepare('SELECT mensagem FROM esocial_logs WHERE id = 3').get().mensagem, /402 - Lote com erro de schema\.\n142 - Schema inválido\./);
  // falha de conexão vira mensagem clara
  esocial.setTransporte(async () => { throw new esocial.EsocialError('não foi possível conectar ao eSocial (ECONNREFUSED)'); });
  await post('/esocial/envios/3/tentar', ck, {});
  await ate(() => db.prepare('SELECT status FROM esocial_logs WHERE id = 4').get().status === 'erro');
  assert.match(db.prepare('SELECT mensagem FROM esocial_logs WHERE id = 4').get().mensagem, /não foi possível conectar ao eSocial/);
});

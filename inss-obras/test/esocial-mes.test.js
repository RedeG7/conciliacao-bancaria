'use strict';
// Envio do mês ao eSocial com o eSocial simulado: tabelas (S-1005/S-1010/S-1020)
// uma vez, S-1200 por autônomo, S-1210 no mês do pagamento, recibos gravados nos
// itens, rejeição parcial com reenvio só do que faltou e o fechamento (S-1299).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inssobras-esocial-mes-'));
process.env.DATA_DIR = dir;
process.env.DEV_LOGIN = '1';
process.env.CERT_ENC_KEY = 'chave-de-teste';
const app = require('../src/server');
const { db, nowIso } = require('../src/db');
const esocial = require('../src/esocial');

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

// eSocial simulado: cada lote recebe um protocolo; a consulta devolve um
// retorno por <evento Id>, com recibo, salvo os Ids que "rejeitar" escolher
const env = corpo => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${corpo}</s:Body></s:Envelope>`;
let lotes = [], rejeitar = () => false, recibo = 0;
function simulador(url, acao, corpo) {
  if (/EnviarLoteEventos"?$/.test(acao)) {
    const ids = [...corpo.matchAll(/<evento Id="([^"]+)">/g)].map(m => m[1]);
    const protocolo = `1.2.202611.${String(lotes.length + 1).padStart(19, '0')}`;
    lotes.push({ protocolo, corpo, ids, grupo: corpo.match(/grupo="(\d)"/)[1] });
    return { status: 200, corpo: env(`<EnviarLoteEventosResponse><EnviarLoteEventosResult><eSocial><retornoEnvioLoteEventos><status><cdResposta>201</cdResposta><descResposta>Lote Recebido com Sucesso.</descResposta></status><dadosRecepcaoLote><protocoloEnvio>${protocolo}</protocoloEnvio></dadosRecepcaoLote></retornoEnvioLoteEventos></eSocial></EnviarLoteEventosResult></EnviarLoteEventosResponse>`) };
  }
  const protocolo = corpo.match(/<protocoloEnvio>([^<]+)</)[1];
  const lote = lotes.find(l => l.protocolo === protocolo);
  const evs = lote.ids.map(id => {
    const xmlEv = lote.corpo.split(`<evento Id="${id}">`)[1].split('</evento>')[0];
    const ruim = rejeitar(xmlEv);
    return `<evento Id="${id}"><retornoEvento><eSocial><retornoEvento Id="${id}"><processamento><cdResposta>${ruim ? '401' : '201'}</cdResposta><descResposta>${ruim ? 'Evento rejeitado.' : 'Sucesso.'}</descResposta>`
      + `${ruim ? '<ocorrencias><ocorrencia><codigo>1234</codigo><descricao>CPF não cadastrado.</descricao></ocorrencia></ocorrencias>' : ''}</processamento>`
      + `${ruim ? '' : `<recibo><nrRecibo>1.1.${String(++recibo).padStart(19, '0')}</nrRecibo></recibo>`}</retornoEvento></eSocial></retornoEvento></evento>`;
  }).join('');
  return { status: 200, corpo: env(`<ConsultarLoteEventosResponse><ConsultarLoteEventosResult><eSocial><retornoProcessamentoLoteEventos><status><cdResposta>201</cdResposta><descResposta>Lote processado.</descResposta></status><retornoEventos>${evs}</retornoEventos></retornoProcessamentoLoteEventos></eSocial></ConsultarLoteEventosResult></ConsultarLoteEventosResponse>`) };
}

let server, base;
test.before(() => new Promise(r => { esocial.setIntervalo(5); esocial.setTransporte(async (u, a, c) => simulador(u, a, c)); server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const login = async () => (await fetch(`${base}/dev-login`, { redirect: 'manual' })).headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const post = (url, cookie, body) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const ate = async (cond, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('tempo esgotado'); await new Promise(r => setTimeout(r, 10)); } };
const log = id => db.prepare('SELECT * FROM esocial_logs WHERE id = ?').get(id);
const idDe = r => Number(r.headers.get('location').split('/').pop());

test('envio do mês: tabelas, S-1200, S-1210 (mês do pagamento), rejeição parcial e S-1299', async () => {
  const ck = await login();
  await post('/cadastros/certificados', ck, { pfx_b64: gerarPfx('certa'), senha: 'certa' });
  const O = 'escritorio-dev';
  const cli = db.prepare(`INSERT INTO clients (office, tipo, nome, documento, created_at, possui_procuracao, procuracao_data_assinatura, procuracao_data_fim, certificate_id, s1000_inicio, s1000_recibo)
    VALUES (?,?,?,?,?,1,'2026-01-01','2030-01-01',1,'2021-01','1.1.0000000000000000001')`).run(O, 'PF', 'Maria Obra', '52998224725', nowIso()).lastInsertRowid;
  const obra = db.prepare("INSERT INTO works (office, client_id, cno, cnae, created_at) VALUES (?,?,'',?,?)").run(O, cli, '4120400', nowIso()).lastInsertRowid;
  const m1 = db.prepare("INSERT INTO masons (office, client_id, name, document, birthday, cbo, created_at) VALUES (?,?,?,?,?,?,?)").run(O, cli, 'JOELIO', '11144477735', '1980-05-02', '715210', nowIso()).lastInsertRowid;
  const m2 = db.prepare("INSERT INTO masons (office, client_id, name, document, birthday, cbo, created_at) VALUES (?,?,?,?,?,?,?)").run(O, cli, 'ANA', '39053344705', '1990-01-01', '715210', nowIso()).lastInsertRowid;
  for (const m of [m1, m2]) db.prepare('INSERT INTO work_masons (work_id, mason_id) VALUES (?,?)').run(obra, m);
  const d = db.prepare(`INSERT INTO dctf_webs (office, client_id, work_id, construction_init_date, rubric_code, rubric_description, rubric_validity, tax_allocation_code, tax_allocation_validity, created_at)
    VALUES (?,?,?,'2026-09-01','1000','Serviços de autônomo','2026-09','OBRA01','2026-09',?)`).run(O, cli, obra, nowIso()).lastInsertRowid;
  const mes = db.prepare("INSERT INTO payroll_months (dctf_web_id, competencia) VALUES (?, '2026-09')").run(d).lastInsertRowid;
  const corpoMes = { item_mason: [String(m1), String(m2)], item_iddmdev: ['7', '8'], item_valor: ['6330,00', '1.000,50'], item_pagto: ['2026-11-30', '2026-09-30'],
    item_rec1200: ['', ''], item_rec1210: ['', ''], status: 'rascunho', nr_rec_1299: '', is_paralyzed: '0' };
  const form = b => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(b)) for (const x of [].concat(v)) u.append(k, x); return u; };
  const postMes = (url, b) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded' }, body: form(b).toString() });

  // sem CNO: não envia e diz o que falta
  let r = await postMes(`/dctf-web/${d}/meses/${mes}/esocial`, corpoMes);
  assert.match(decodeURIComponent(r.headers.getSetCookie().join()), /não foi enviado.*CNO da obra com 12 dígitos/);
  assert.strictEqual(lotes.length, 0);
  db.prepare("UPDATE works SET cno = '900123456789' WHERE id = ?").run(obra);

  // ANA rejeitada no S-1200: JOELIO recebe recibo, o envio para com a ocorrência
  rejeitar = xml => xml.includes('<evtRemun') && xml.includes('<cpfTrab>39053344705</cpfTrab>');
  r = await postMes(`/dctf-web/${d}/meses/${mes}/esocial`, corpoMes);
  const e1 = idDe(r);
  await ate(() => ['erro', 'recebido'].includes(log(e1).status));
  assert.strictEqual(log(e1).status, 'erro');
  assert.match(log(e1).mensagem, /S-1200 ANA: 401 - Evento rejeitado\.\n {2}1234 - CPF não cadastrado\./);
  assert.deepStrictEqual(lotes.map(l => [l.grupo, l.ids.length]), [['1', 3], ['3', 2]]);  // tabelas (3) e S-1200 (2)
  assert.match(lotes[0].corpo, /<evtTabEstab[\s\S]*<nrInsc>900123456789<\/nrInsc><iniValid>2026-09<\/iniValid>[\s\S]*<evtTabRubrica[\s\S]*<evtTabLotacao/);
  const dd = db.prepare('SELECT has_s1005, has_s1010, has_s1020 FROM dctf_webs WHERE id = ?').get(d);
  assert.deepStrictEqual({ ...dd }, { has_s1005: 1, has_s1010: 1, has_s1020: 1 });
  let itens = db.prepare('SELECT * FROM payroll_items WHERE payroll_month_id = ? ORDER BY id').all(mes);
  assert.ok(itens[0].nr_rec_1200 && !itens[1].nr_rec_1200);
  assert.ok(!itens[0].nr_rec_1210); // S-1210 só depois do S-1200 de todos

  // corrigido: "Tentar novamente" reenvia só a ANA, depois os dois S-1210
  rejeitar = () => false;
  r = await post(`/esocial/envios/${e1}/tentar`, ck, {});
  const e2 = idDe(r);
  await ate(() => ['erro', 'recebido'].includes(log(e2).status));
  assert.strictEqual(log(e2).status, 'recebido', log(e2).mensagem);
  assert.deepStrictEqual(lotes.slice(2).map(l => [l.grupo, l.ids.length]), [['3', 1], ['3', 2]]);
  assert.match(lotes[2].corpo, /<cpfTrab>39053344705<\/cpfTrab><infoComplem><nmTrab>ANA<\/nmTrab>[\s\S]*<vrRubr>1000\.50<\/vrRubr>[\s\S]*<codCBO>715210<\/codCBO>/);
  // S-1210 no período do pagamento, com perRef = competência
  assert.match(lotes[3].corpo, /<perApur>2026-11<\/perApur>[\s\S]*<cpfBenef>11144477735<\/cpfBenef><infoPgto><dtPgto>2026-11-30<\/dtPgto><tpPgto>1<\/tpPgto><perRef>2026-09<\/perRef><ideDmDev>7<\/ideDmDev><vrLiq>6330\.00<\/vrLiq>/);
  assert.match(lotes[3].corpo, /<perApur>2026-09<\/perApur>[\s\S]*<cpfBenef>39053344705<\/cpfBenef>/);
  itens = db.prepare('SELECT * FROM payroll_items WHERE payroll_month_id = ? ORDER BY id').all(mes);
  assert.ok(itens.every(i => i.nr_rec_1200 && i.nr_rec_1210));
  assert.strictEqual(db.prepare('SELECT status FROM payroll_months WHERE id = ?').get(mes).status, 'enviado');
  assert.match(log(e2).receipt, /2 S-1200 e 2 S-1210 com recibo/);
  const pg = await (await fetch(`${base}/dctf-web/editar/${d}`, { headers: { cookie: ck } })).text();
  assert.match(pg, /Enviar ao eSocial/);
  assert.match(pg, /Último envio \(S-1200\/S-1210: recebido\)/);

  // fechamento de 2026-09: há S-1200 na competência e o S-1210 da ANA (pago em 09)
  r = await post(`/dctf-web/${d}/fechar/esocial`, ck, { fechar_mes: String(mes) });
  const e3 = idDe(r);
  await ate(() => ['erro', 'recebido'].includes(log(e3).status));
  assert.strictEqual(log(e3).status, 'recebido', log(e3).mensagem);
  assert.match(lotes[4].corpo, /<evtFechaEvPer[\s\S]*<perApur>2026-09<\/perApur>[\s\S]*<evtRemun>S<\/evtRemun><evtPgtos>S<\/evtPgtos><evtComProd>N<\/evtComProd>/);
  const fech = db.prepare('SELECT status, nr_rec_1299 FROM payroll_months WHERE id = ?').get(mes);
  assert.strictEqual(fech.status, 'fechado');
  assert.strictEqual(fech.nr_rec_1299, log(e3).receipt);
  // mês fechado: não envia de novo
  r = await postMes(`/dctf-web/${d}/meses/${mes}/esocial`, corpoMes);
  assert.match(decodeURIComponent(r.headers.getSetCookie().join()), /já está fechado/);
});

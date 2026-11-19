'use strict';
// Transmissão ao eSocial (web services SOAP do eSocial / leiaute S-1.3).
//
// Fluxo de um evento: monta o XML -> assina (XMLDSig, RSA-SHA256, C14N) com o
// certificado A1 do PROCURADOR do escritório -> envia o lote (TLS com o mesmo
// certificado) -> recebe o protocolo -> consulta o processamento até sair o
// recibo ou as ocorrências. Cada envio fica em esocial_logs com o XML enviado,
// a resposta, o protocolo e o recibo; a tela de andamento lê esse registro.
//
// O ambiente (produção restrita = testes / produção) é o do escritório, em
// Cadastros > Escritório. Comece sempre pela produção restrita.
//
// Endereços, ações SOAP e namespaces ficam todos aqui embaixo: se o eSocial
// recusar algum (versão de leiaute nova, por exemplo), é só ajustar este bloco.
const https = require('https');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { db, nowIso } = require('./db');
const cert = require('./certificados');

const SERVICOS = {
  producao_restrita: {
    tpAmb: 2,
    envio: 'https://webservices.producaorestrita.esocial.gov.br/servicos/empregador/enviarloteeventos/WsEnviarLoteEventos.svc',
    consulta: 'https://webservices.producaorestrita.esocial.gov.br/servicos/empregador/consultarloteeventos/WsConsultarLoteEventos.svc',
  },
  producao: {
    tpAmb: 1,
    envio: 'https://webservices.envio.esocial.gov.br/servicos/empregador/enviarloteeventos/WsEnviarLoteEventos.svc',
    consulta: 'https://webservices.consulta.esocial.gov.br/servicos/empregador/consultarloteeventos/WsConsultarLoteEventos.svc',
  },
};
const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  wsEnvio: 'http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/v1_1_0',
  acaoEnvio: 'http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/v1_1_0/ServicoEnviarLoteEventos/EnviarLoteEventos',
  loteEnvio: 'http://www.esocial.gov.br/schema/lote/eventos/envio/v1_1_1',
  wsConsulta: 'http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/consulta/retornoProcessamento/v1_1_0',
  acaoConsulta: 'http://www.esocial.gov.br/servicos/empregador/lote/eventos/envio/consulta/retornoProcessamento/v1_1_0/ServicoConsultarLoteEventos/ConsultarLoteEventos',
  loteConsulta: 'http://www.esocial.gov.br/schema/lote/eventos/envio/consulta/retornoProcessamento/v1_0_0',
  s1000: 'http://www.esocial.gov.br/schema/evt/evtInfoEmpregador/v_S_01_03_00',
};
const VER_PROC = 'INSSOBRAS_1.0';
const CONSULTA_INTERVALO_MS = 5000;
const CONSULTA_TENTATIVAS = 36; // ~3 minutos; depois a tela oferece "Consultar de novo"

class EsocialError extends Error {}

const soDigitos = v => String(v || '').replace(/\D/g, '');
const escXml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const cpfValido = c => {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
};

// Id do evento: "ID" + tipo de inscrição + inscrição (14, completada com zeros à
// direita) + AAAAMMDDHHMMSS + sequencial de 5 dígitos
function idEvento(tpInsc, nrInsc, agora = new Date(), seq = 1) {
  const p = n => String(n).padStart(2, '0');
  const ts = `${agora.getFullYear()}${p(agora.getMonth() + 1)}${p(agora.getDate())}${p(agora.getHours())}${p(agora.getMinutes())}${p(agora.getSeconds())}`;
  return `ID${tpInsc}${soDigitos(nrInsc).padEnd(14, '0')}${ts}${String(seq).padStart(5, '0')}`;
}

// S-1000 (informações do empregador) - inclusão, empregador pessoa física (CPF).
// procEmi 1 = aplicativo do empregador (webservice): o empregador fica no módulo
// Geral do portal, não no Simplificado (que usa procEmi 22, doméstico/seg. especial).
function xmlS1000(cliente, tpAmb, agora = new Date()) {
  const cpf = soDigitos(cliente.documento);
  const id = idEvento(2, cpf, agora);
  const fim = cliente.s1000_fim ? `<fimValid>${escXml(cliente.s1000_fim)}</fimValid>` : '';
  const pis = Number(cliente.pis_pasep) === 1 ? '<indTribFolhaPisPasep>S</indTribFolhaPisPasep>' : '';
  const xml = `<eSocial xmlns="${NS.s1000}"><evtInfoEmpregador Id="${id}">`
    + `<ideEvento><tpAmb>${tpAmb}</tpAmb><procEmi>1</procEmi><verProc>${VER_PROC}</verProc></ideEvento>`
    + `<ideEmpregador><tpInsc>2</tpInsc><nrInsc>${cpf}</nrInsc></ideEmpregador>`
    + `<infoEmpregador><inclusao><idePeriodo><iniValid>${escXml(cliente.s1000_inicio)}</iniValid>${fim}</idePeriodo>`
    + `<infoCadastro><classTrib>${escXml(cliente.class_trib || '21')}</classTrib>`
    + `<indDesFolha>${escXml(cliente.ind_desoneracao || '0')}</indDesFolha>`
    + `<indOptRegEletron>${escXml(cliente.ind_opt_reg_eletron || '0')}</indOptRegEletron>${pis}</infoCadastro>`
    + '</inclusao></infoEmpregador></evtInfoEmpregador></eSocial>';
  return { id, xml };
}

// ---------------------------------------------------------------- eventos da obra e do mês
// Leiaute S-1.3 (XSDs oficiais): empregador pessoa física (tpInsc 2) com obra
// própria no CNO. Regras aplicadas (das validações do leiaute):
// - S-1005 de PF: só CNO + início + CNAE (RAT/FAP são de PJ; infoObra é de construtora).
// - S-1020 tipo 21 (obra própria de PF): sem tpInsc/nrInsc; o CNO vai no S-1200.
// - S-1200 de autônomo (701) sem S-2300: infoComplem (nome e nascimento) e infoComplCont (CBO).
// - S-1210 vai no período do PAGAMENTO (dtPgto dentro do perApur), com perRef = competência.
// - S-1299: evtRemun/evtPgtos = S só se existirem esses eventos no período; transDCTFWeb
//   opcional (pedido de transmissão imediata); indExcApur1250 não se informa desde 2021-07.
const nsEvt = nome => `http://www.esocial.gov.br/schema/evt/${nome}/v_S_01_03_00`;
const ID_TAB_RUBR = 'OBRA';
const valor2 = v => Number(v || 0).toFixed(2);
const ideEmpregadorPF = cpf => `<ideEmpregador><tpInsc>2</tpInsc><nrInsc>${soDigitos(cpf)}</nrInsc></ideEmpregador>`;
const procEmi = tpAmb => `<tpAmb>${tpAmb}</tpAmb><procEmi>1</procEmi><verProc>${VER_PROC}</verProc>`;
const envolver = (nome, evt, id, corpo) => `<eSocial xmlns="${nsEvt(nome)}"><${evt} Id="${id}">${corpo}</${evt}></eSocial>`;
const modoTab = m => (m === 'alteracao' ? 'alteracao' : 'inclusao');

function xmlS1005({ cpf, cno, cnae, iniValid, modo, tpAmb, agora = new Date(), seq = 1 }) {
  const id = idEvento(2, cpf, agora, seq), tag = modoTab(modo);
  const corpo = `<ideEvento>${procEmi(tpAmb)}</ideEvento>${ideEmpregadorPF(cpf)}<infoEstab><${tag}>`
    + `<ideEstab><tpInsc>4</tpInsc><nrInsc>${soDigitos(cno)}</nrInsc><iniValid>${escXml(iniValid)}</iniValid></ideEstab>`
    + `<dadosEstab><cnaePrep>${soDigitos(cnae)}</cnaePrep></dadosEstab></${tag}></infoEstab>`;
  return { id, xml: envolver('evtTabEstab', 'evtTabEstab', id, corpo) };
}
function xmlS1010({ cpf, codRubr, dscRubr, iniValid, codIncIRRF, modo, tpAmb, agora = new Date(), seq = 1 }) {
  const id = idEvento(2, cpf, agora, seq), tag = modoTab(modo);
  const corpo = `<ideEvento>${procEmi(tpAmb)}</ideEvento>${ideEmpregadorPF(cpf)}<infoRubrica><${tag}>`
    + `<ideRubrica><codRubr>${escXml(codRubr)}</codRubr><ideTabRubr>${ID_TAB_RUBR}</ideTabRubr><iniValid>${escXml(iniValid)}</iniValid></ideRubrica>`
    + `<dadosRubrica><dscRubr>${escXml(dscRubr)}</dscRubr><natRubr>3501</natRubr><tpRubr>1</tpRubr><codIncCP>13</codIncCP>`
    + `<codIncIRRF>${escXml(codIncIRRF || '11')}</codIncIRRF><codIncFGTS>00</codIncFGTS></dadosRubrica></${tag}></infoRubrica>`;
  return { id, xml: envolver('evtTabRubrica', 'evtTabRubrica', id, corpo) };
}
function xmlS1020({ cpf, codLotacao, iniValid, modo, tpAmb, agora = new Date(), seq = 1 }) {
  const id = idEvento(2, cpf, agora, seq), tag = modoTab(modo);
  const corpo = `<ideEvento>${procEmi(tpAmb)}</ideEvento>${ideEmpregadorPF(cpf)}<infoLotacao><${tag}>`
    + `<ideLotacao><codLotacao>${escXml(codLotacao)}</codLotacao><iniValid>${escXml(iniValid)}</iniValid></ideLotacao>`
    + '<dadosLotacao><tpLotacao>21</tpLotacao><fpasLotacao><fpas>507</fpas><codTercs>0079</codTercs></fpasLotacao></dadosLotacao>'
    + `</${tag}></infoLotacao>`;
  return { id, xml: envolver('evtTabLotacao', 'evtTabLotacao', id, corpo) };
}
// S-1200 de um autônomo na competência: um demonstrativo (dmDev) por pagamento
function xmlS1200({ cpf, perApur, trab, comS2300, cno, codLotacao, codRubr, itens, tpAmb, agora = new Date(), seq = 1 }) {
  const id = idEvento(2, cpf, agora, seq);
  const complem = comS2300 ? '' : `<infoComplem><nmTrab>${escXml(trab.nome)}</nmTrab><dtNascto>${escXml(trab.nascimento)}</dtNascto></infoComplem>`;
  const complCont = comS2300 ? '' : `<infoComplCont><codCBO>${soDigitos(trab.cbo)}</codCBO></infoComplCont>`;
  const dm = itens.map(i => `<dmDev><ideDmDev>${escXml(i.ideDmDev)}</ideDmDev><codCateg>${escXml(trab.categoria || '701')}</codCateg>`
    + `<infoPerApur><ideEstabLot><tpInsc>4</tpInsc><nrInsc>${soDigitos(cno)}</nrInsc><codLotacao>${escXml(codLotacao)}</codLotacao>`
    + `<remunPerApur><itensRemun><codRubr>${escXml(codRubr)}</codRubr><ideTabRubr>${ID_TAB_RUBR}</ideTabRubr><vrRubr>${valor2(i.valor)}</vrRubr><indApurIR>0</indApurIR></itensRemun></remunPerApur>`
    + `</ideEstabLot></infoPerApur>${complCont}</dmDev>`).join('');
  const corpo = `<ideEvento><indRetif>1</indRetif><indApuracao>1</indApuracao><perApur>${perApur}</perApur>${procEmi(tpAmb)}</ideEvento>`
    + `${ideEmpregadorPF(cpf)}<ideTrabalhador><cpfTrab>${soDigitos(trab.cpf)}</cpfTrab>${complem}</ideTrabalhador>${dm}`;
  return { id, xml: envolver('evtRemun', 'evtRemun', id, corpo) };
}
// S-1210 de um beneficiário no período do pagamento
function xmlS1210({ cpf, perApur, cpfBenef, pgtos, tpAmb, agora = new Date(), seq = 1 }) {
  const id = idEvento(2, cpf, agora, seq);
  const corpo = `<ideEvento><indRetif>1</indRetif><perApur>${perApur}</perApur>${procEmi(tpAmb)}</ideEvento>${ideEmpregadorPF(cpf)}`
    + `<ideBenef><cpfBenef>${soDigitos(cpfBenef)}</cpfBenef>${pgtos.map(p => `<infoPgto><dtPgto>${escXml(p.dtPgto)}</dtPgto><tpPgto>1</tpPgto>`
      + `<perRef>${escXml(p.perRef)}</perRef><ideDmDev>${escXml(p.ideDmDev)}</ideDmDev><vrLiq>${valor2(p.vrLiq)}</vrLiq></infoPgto>`).join('')}</ideBenef>`;
  return { id, xml: envolver('evtPgtos', 'evtPgtos', id, corpo) };
}
function xmlS1299({ cpf, perApur, evtRemun, evtPgtos, evtComProd, evtContratAvNP, evtInfoComplPer, transDCTFWeb, naoValid, tpAmb, agora = new Date(), seq = 1 }) {
  const id = idEvento(2, cpf, agora, seq);
  const sn = v => (v ? 'S' : 'N');
  const corpo = `<ideEvento><indApuracao>1</indApuracao><perApur>${perApur}</perApur>${procEmi(tpAmb)}</ideEvento>${ideEmpregadorPF(cpf)}`
    + `<infoFech><evtRemun>${sn(evtRemun)}</evtRemun><evtPgtos>${sn(evtPgtos)}</evtPgtos><evtComProd>${sn(evtComProd)}</evtComProd>`
    + `<evtContratAvNP>${sn(evtContratAvNP)}</evtContratAvNP><evtInfoComplPer>${sn(evtInfoComplPer)}</evtInfoComplPer>`
    + `${transDCTFWeb ? '<transDCTFWeb>S</transDCTFWeb>' : ''}${naoValid ? '<naoValid>S</naoValid>' : ''}</infoFech>`;
  return { id, xml: envolver('evtFechaEvPer', 'evtFechaEvPer', id, corpo) };
}

// assinatura do evento (enveloped, Reference URI="", RSA-SHA256, C14N)
function assinar(xml, { keyPem, certPem }) {
  const sig = new SignedXml({
    privateKey: keyPem, publicCert: certPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });
  sig.addReference({
    xpath: '/*', isEmptyUri: true, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'],
  });
  sig.computeSignature(xml, { location: { reference: '/*', action: 'append' } });
  return sig.getSignedXml();
}

function envelopeEnvio({ grupo, empregadorCpf, transmissorDoc, eventos }) {
  const tpTransm = soDigitos(transmissorDoc).length === 14 ? 1 : 2;
  const lote = `<eSocial xmlns="${NS.loteEnvio}"><envioLoteEventos grupo="${grupo}">`
    + `<ideEmpregador><tpInsc>2</tpInsc><nrInsc>${soDigitos(empregadorCpf)}</nrInsc></ideEmpregador>`
    + `<ideTransmissor><tpInsc>${tpTransm}</tpInsc><nrInsc>${soDigitos(transmissorDoc)}</nrInsc></ideTransmissor>`
    + `<eventos>${eventos.map(e => `<evento Id="${e.id}">${e.xmlAssinado.replace(/^<\?xml[^>]*\?>/, '')}</evento>`).join('')}</eventos>`
    + '</envioLoteEventos></eSocial>';
  return `<soapenv:Envelope xmlns:soapenv="${NS.soap}" xmlns:v1="${NS.wsEnvio}"><soapenv:Header/><soapenv:Body>`
    + `<v1:EnviarLoteEventos><v1:loteEventos>${lote}</v1:loteEventos></v1:EnviarLoteEventos></soapenv:Body></soapenv:Envelope>`;
}
function envelopeConsulta(protocolo) {
  return `<soapenv:Envelope xmlns:soapenv="${NS.soap}" xmlns:v1="${NS.wsConsulta}"><soapenv:Header/><soapenv:Body>`
    + `<v1:ConsultarLoteEventos><v1:consulta><eSocial xmlns="${NS.loteConsulta}"><consultaLoteEventos>`
    + `<protocoloEnvio>${escXml(protocolo)}</protocoloEnvio></consultaLoteEventos></eSocial></v1:consulta></v1:ConsultarLoteEventos>`
    + '</soapenv:Body></soapenv:Envelope>';
}

// ---------------------------------------------------------------- leitura das respostas
const doc = xml => new DOMParser({ onError: () => {} }).parseFromString(String(xml || ''), 'text/xml');
const tags = (no, nome) => Array.from(no.getElementsByTagNameNS('*', nome));
const texto = (no, nome) => { const t = tags(no, nome)[0]; return t ? String(t.textContent).trim() : ''; };
const ocorrencias = no => tags(no, 'ocorrencia').map(o => `${texto(o, 'codigo')} - ${texto(o, 'descricao')}${texto(o, 'localizacao') ? ` (${texto(o, 'localizacao')})` : ''}`);

function lerRetornoEnvio(xml) {
  const d = doc(xml);
  const st = tags(d, 'retornoEnvioLoteEventos')[0] || d;
  const status = tags(st, 'status')[0] || st;
  const fault = texto(d, 'faultstring');
  return { cdResposta: texto(status, 'cdResposta'), descResposta: texto(status, 'descResposta') || fault, protocolo: texto(d, 'protocoloEnvio'), ocorrencias: ocorrencias(d) };
}
function lerRetornoConsulta(xml) {
  const d = doc(xml);
  const raiz = tags(d, 'retornoProcessamentoLoteEventos')[0] || d;
  const status = tags(raiz, 'status')[0] || raiz;
  // cada <evento Id="..."> do lote (o Id liga o retorno ao evento enviado)
  const porEvento = tags(raiz, 'evento').filter(e => e.getAttribute('Id'));
  const fontes = porEvento.length ? porEvento : tags(raiz, 'retornoEvento').filter(e => tags(e, 'processamento').length);
  const eventos = fontes.filter(e => tags(e, 'processamento').length).map(e => {
    const proc = tags(e, 'processamento')[0];
    return { id: e.getAttribute('Id') || '', cdResposta: texto(proc, 'cdResposta'), descResposta: texto(proc, 'descResposta'), recibo: texto(e, 'nrRecibo'), ocorrencias: ocorrencias(proc) };
  });
  return { cdResposta: texto(status, 'cdResposta'), descResposta: texto(status, 'descResposta') || texto(d, 'faultstring'), ocorrencias: ocorrencias(status), eventos };
}

// ---------------------------------------------------------------- transporte (TLS com o certificado)
// trocável nos testes (setTransporte)
let transporte = (url, acao, corpo, { keyPem, certPem }) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: 'POST', key: keyPem, cert: certPem, timeout: 60000,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${acao}"`, 'Content-Length': Buffer.byteLength(corpo) },
  }, res => {
    let dados = '';
    res.setEncoding('utf8');
    res.on('data', c => { dados += c; });
    res.on('end', () => resolve({ status: res.statusCode, corpo: dados }));
  });
  req.on('timeout', () => req.destroy(new Error('o eSocial não respondeu em 60 segundos')));
  req.on('error', e => reject(new EsocialError(/certificate|self.signed|unable to verify/i.test(e.message)
    ? `falha de certificado na conexão com o eSocial (${e.message}). Confira a cadeia ICP-Brasil do servidor (NODE_EXTRA_CA_CERTS).`
    : `não foi possível conectar ao eSocial (${e.message})`)));
  req.end(corpo);
});
const setTransporte = fn => { transporte = fn; };

// ---------------------------------------------------------------- registro e processamento
const atualizar = (id, campos) => {
  const k = Object.keys(campos);
  db.prepare(`UPDATE esocial_logs SET ${k.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...k.map(c => campos[c]), nowIso(), id);
};
const emAndamento = new Set();
const espera = ms => new Promise(r => setTimeout(r, ms));
let intervalo = CONSULTA_INTERVALO_MS;
const setIntervalo = ms => { intervalo = ms; };

// pré-requisitos do S-1000; devolve a lista do que falta
function pendenciasS1000(cliente) {
  const p = [];
  if (!cpfValido(soDigitos(cliente.documento))) p.push('CPF do cliente válido');
  if (!/^\d{4}-\d{2}$/.test(cliente.s1000_inicio || '')) p.push('início de validade do S-1000');
  const hoje = new Date().toISOString().slice(0, 10);
  if (!cliente.possui_procuracao || !cliente.procuracao_data_assinatura || !(cliente.procuracao_data_fim >= hoje)) p.push('procuração eletrônica vigente');
  const ce = cliente.certificate_id && db.prepare('SELECT * FROM certificates WHERE id = ? AND office = ? AND ativo = 1').get(cliente.certificate_id, cliente.office);
  if (!ce || cert.diasPara(ce.validade) < 0) p.push('certificado do procurador válido');
  if (!cert.cifraDisponivel()) p.push('guarda de certificados configurada no servidor');
  return p;
}

// cria o registro do envio do S-1000 e começa o processamento em segundo plano
function enviarS1000(cliente, office, usuario) {
  const falta = pendenciasS1000(cliente);
  if (falta.length) throw new EsocialError(`Para enviar o S-1000 falta: ${falta.join(', ')}.`);
  const amb = (db.prepare('SELECT esocial_ambiente FROM offices WHERE id = ?').get(office) || {}).esocial_ambiente === 'producao' ? 'producao' : 'producao_restrita';
  const r = db.prepare(`INSERT INTO esocial_logs (office, client_id, event, status, etapa, ambiente, usuario, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(office, cliente.id, 'S-1000', 'enviando', 'Montando e assinando o evento', amb, usuario, nowIso(), nowIso());
  const id = Number(r.lastInsertRowid);
  processar(id).catch(() => {});
  return id;
}

async function processar(id) {
  if (emAndamento.has(id)) return;
  emAndamento.add(id);
  try {
    const log = db.prepare('SELECT * FROM esocial_logs WHERE id = ?').get(id);
    if (log.event !== 'S-1000') { await processarEnvioMes(id); return; }
    const cliente = db.prepare('SELECT * FROM clients WHERE id = ?').get(log.client_id);
    const ce = db.prepare('SELECT * FROM certificates WHERE id = ? AND ativo = 1').get(cliente.certificate_id);
    if (!ce) throw new EsocialError('certificado do procurador não encontrado');
    const pem = cert.pemDoCertificado(cert.decifrar(ce.pfx_enc), cert.decifrar(ce.senha_enc).toString());
    const srv = SERVICOS[log.ambiente] || SERVICOS.producao_restrita;

    let protocolo = log.protocolo;
    if (!protocolo) {
      const ev = xmlS1000(cliente, srv.tpAmb);
      const xmlAssinado = assinar(ev.xml, pem);
      const corpo = envelopeEnvio({ grupo: 1, empregadorCpf: cliente.documento, transmissorDoc: ce.documento, eventos: [{ id: ev.id, xmlAssinado }] });
      atualizar(id, { payload_xml: corpo, etapa: 'Enviando o lote ao eSocial' });
      const resp = await transporte(srv.envio, NS.acaoEnvio, corpo, pem);
      const ret = lerRetornoEnvio(resp.corpo);
      if (ret.cdResposta !== '201' || !ret.protocolo) {
        atualizar(id, { response_xml: resp.corpo, status: 'erro', etapa: 'Lote recusado pelo eSocial',
          mensagem: [`${ret.cdResposta || `HTTP ${resp.status}`} - ${ret.descResposta || 'resposta inesperada do eSocial'}`, ...ret.ocorrencias].join('\n') });
        return;
      }
      protocolo = ret.protocolo;
      atualizar(id, { response_xml: resp.corpo, protocolo, status: 'processando', etapa: 'Lote recebido; aguardando o processamento' });
    }

    for (let t = 0; t < CONSULTA_TENTATIVAS; t++) {
      await espera(intervalo);
      const resp = await transporte(srv.consulta, NS.acaoConsulta, envelopeConsulta(protocolo), pem);
      const ret = lerRetornoConsulta(resp.corpo);
      if (ret.cdResposta === '101') { atualizar(id, { etapa: `Em processamento no eSocial (consulta ${t + 1})` }); continue; }
      const ev = ret.eventos[0];
      if (ret.cdResposta === '201' && ev && ['201', '202'].includes(ev.cdResposta) && ev.recibo) {
        atualizar(id, { response_xml: resp.corpo, status: 'recebido', receipt: ev.recibo, etapa: 'Recibo recebido',
          mensagem: ev.cdResposta === '202' ? ['Processado com advertências:', ...ev.ocorrencias].join('\n') : '' });
        db.prepare('UPDATE clients SET s1000_recibo = ? WHERE id = ?').run(ev.recibo, cliente.id);
        return;
      }
      atualizar(id, { response_xml: resp.corpo, status: 'erro', etapa: 'Evento rejeitado pelo eSocial',
        mensagem: [ev ? `${ev.cdResposta} - ${ev.descResposta}` : `${ret.cdResposta} - ${ret.descResposta || 'resposta inesperada do eSocial'}`,
          ...(ev ? ev.ocorrencias : ret.ocorrencias)].join('\n') });
      return;
    }
    atualizar(id, { etapa: 'O eSocial ainda está processando: consulte de novo em alguns minutos' });
  } catch (e) {
    atualizar(id, { status: 'erro', etapa: 'Falha no envio', mensagem: e instanceof EsocialError ? e.message : `erro inesperado: ${e.message}` });
  } finally {
    emAndamento.delete(id);
  }
}

// ---------------------------------------------------------------- envio do mês e fechamento
// Um envio do mês ("S-1200/S-1210") roda em etapas, cada uma num lote:
// tabelas (S-1005/S-1010/S-1020, só as que ainda não foram aceitas) ->
// S-1200 (um por autônomo) -> S-1210 (um por autônomo e mês de pagamento).
// O fechamento ("S-1299") é um lote só. Cada recibo é gravado assim que chega
// (itens do mês, indicadores da obra), então "Tentar novamente" só reenvia o
// que faltou. O lote em andamento fica em esocial_logs.contexto (protocolo e o
// destino de cada evento) para retomar a consulta se o servidor reiniciar.
const ambienteDo = office => ((db.prepare('SELECT esocial_ambiente FROM offices WHERE id = ?').get(office) || {}).esocial_ambiente === 'producao' ? 'producao' : 'producao_restrita');
const mesDe = data => String(data || '').slice(0, 7);

function contextoMes(monthId) {
  const mes = db.prepare('SELECT * FROM payroll_months WHERE id = ?').get(monthId);
  if (!mes) throw new EsocialError('mês não encontrado');
  const d = db.prepare('SELECT * FROM dctf_webs WHERE id = ?').get(mes.dctf_web_id);
  const cliente = db.prepare('SELECT * FROM clients WHERE id = ?').get(d.client_id);
  const obra = d.work_id ? db.prepare('SELECT * FROM works WHERE id = ?').get(d.work_id) : null;
  const itens = db.prepare(`SELECT pi.*, ms.name, ms.document, ms.birthday, ms.cbo, ms.category FROM payroll_items pi
    JOIN masons ms ON ms.id = pi.mason_id WHERE pi.payroll_month_id = ? ORDER BY pi.id`).all(mes.id);
  return { mes, d, cliente, obra, itens };
}

function pendenciasMes({ mes, d, cliente, obra, itens }) {
  const p = pendenciasS1000(cliente);
  if (!cliente.s1000_recibo) p.push('S-1000 do cliente aceito pelo eSocial (recibo no cadastro do cliente)');
  if (!obra || !/^\d{12}$/.test(soDigitos(obra.cno))) p.push('CNO da obra com 12 dígitos');
  if (!String(d.rubric_code || '').trim() || !String(d.rubric_description || '').trim()) p.push('código e descrição da rubrica (aba S-1010)');
  if (!String(d.tax_allocation_code || '').trim()) p.push('código da lotação (aba S-1020)');
  if (mes.is_paralyzed) p.push('mês com atividade (mês paralisado não tem remuneração a enviar)');
  if (['fechado', 'fechado_externo'].includes(mes.status)) p.push('mês aberto (este mês já está fechado; reabra antes)');
  if (!itens.length) p.push('ao menos um autônomo no mês');
  for (const i of itens) {
    const quem = i.name || `autônomo ${i.mason_id}`;
    if (!cpfValido(soDigitos(i.document))) p.push(`CPF válido de ${quem}`);
    if (!(Number(i.calc_base) > 0)) p.push(`valor maior que zero para ${quem}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.payment_date || '') || mesDe(i.payment_date) < mes.competencia) p.push(`data de pagamento de ${quem} (no mês da competência ou depois)`);
    if (!d.has_s2300) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(i.birthday || '')) p.push(`data de nascimento de ${quem} (cadastro do autônomo)`);
      if (!/^\d{6}$/.test(soDigitos(i.cbo))) p.push(`CBO de ${quem} (cadastro do autônomo)`);
    }
  }
  return [...new Set(p)];
}

function criarEnvio(ctx, evento, office, usuario) {
  const r = db.prepare(`INSERT INTO esocial_logs (office, client_id, dctf_web_id, payroll_month_id, competencia, event, status, etapa, ambiente, usuario, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(office, ctx.cliente.id, ctx.d.id, ctx.mes.id, ctx.mes.competencia, evento, 'enviando',
    'Montando e assinando os eventos', ambienteDo(office), usuario, nowIso(), nowIso());
  const id = Number(r.lastInsertRowid);
  processar(id).catch(() => {});
  return id;
}
// envio do mês: tabelas que faltam + S-1200 + S-1210
function enviarMes(monthId, office, usuario) {
  const ctx = contextoMes(monthId);
  const falta = pendenciasMes(ctx);
  if (falta.length) throw new EsocialError(`Para enviar o mês falta: ${falta.join('; ')}.`);
  return criarEnvio(ctx, 'S-1200/S-1210', office, usuario);
}
// fechamento da folha do período (S-1299)
function enviarFechamento(monthId, office, usuario) {
  const ctx = contextoMes(monthId);
  const falta = pendenciasS1000(ctx.cliente);
  if (!ctx.cliente.s1000_recibo) falta.push('S-1000 do cliente aceito pelo eSocial (recibo no cadastro do cliente)');
  if (['fechado', 'fechado_externo'].includes(ctx.mes.status)) falta.push('mês aberto (este mês já está fechado)');
  const pend = db.prepare(`SELECT COUNT(*) AS n FROM payroll_items pi JOIN payroll_months pm ON pm.id = pi.payroll_month_id
    JOIN dctf_webs d ON d.id = pm.dctf_web_id WHERE d.client_id = ? AND d.ativo = 1 AND
    ((pm.competencia = ? AND COALESCE(pi.nr_rec_1200, '') = '') OR (substr(pi.payment_date, 1, 7) = ? AND COALESCE(pi.nr_rec_1210, '') = ''))`)
    .get(ctx.cliente.id, ctx.mes.competencia, ctx.mes.competencia).n;
  if (pend) falta.push(`envio dos pagamentos do período (${pend} item(ns) sem recibo de S-1200 ou S-1210)`);
  if (falta.length) throw new EsocialError(`Para fechar a folha falta: ${falta.join('; ')}.`);
  return criarEnvio(ctx, 'S-1299', office, usuario);
}

// eventos de uma etapa, com o destino de cada recibo (tipo + ref)
function montarEtapa(etapa, ctx, tpAmb) {
  const { mes, d, cliente, obra, itens } = ctx;
  const cpf = cliente.documento, agora = new Date();
  const ev = [];
  const push = (tipo, ref, rotulo, x) => ev.push({ ...x, tipo, ref, rotulo });
  const seq = () => ev.length + 1;
  if (etapa === 'tabelas') {
    if (d.send1005 && !d.has_s1005) push('S-1005', d.id, 'S-1005 obra', xmlS1005({ cpf, cno: obra.cno, cnae: obra.cnae || '4120400', iniValid: mesDe(d.construction_init_date) || mes.competencia, modo: 'inclusao', tpAmb, agora, seq: seq() }));
    if (!d.has_s1010) push('S-1010', d.id, 'S-1010 rubrica', xmlS1010({ cpf, codRubr: d.rubric_code, dscRubr: d.rubric_description, iniValid: d.rubric_validity || mes.competencia, codIncIRRF: d.irrf, modo: d.send1010, tpAmb, agora, seq: seq() }));
    if (!d.has_s1020) push('S-1020', d.id, 'S-1020 lotação', xmlS1020({ cpf, codLotacao: d.tax_allocation_code, iniValid: d.tax_allocation_validity || mes.competencia, modo: d.send1020, tpAmb, agora, seq: seq() }));
  } else if (etapa === 'S-1200') {
    const porTrab = new Map();
    for (const i of itens.filter(x => !x.nr_rec_1200)) porTrab.set(i.mason_id, [...(porTrab.get(i.mason_id) || []), i]);
    for (const lista of porTrab.values()) {
      const t = lista[0];
      push('S-1200', lista.map(i => i.id), `S-1200 ${t.name}`, xmlS1200({ cpf, perApur: mes.competencia, comS2300: !!d.has_s2300,
        trab: { cpf: t.document, nome: t.name, nascimento: t.birthday, cbo: t.cbo, categoria: t.category || '701' },
        cno: obra.cno, codLotacao: d.tax_allocation_code, codRubr: d.rubric_code,
        itens: lista.map(i => ({ ideDmDev: i.id_dm_dev || String(i.id), valor: i.calc_base })), tpAmb, agora, seq: seq() }));
    }
  } else if (etapa === 'S-1210') {
    const grupos = new Map();
    for (const i of itens.filter(x => x.nr_rec_1200 && !x.nr_rec_1210)) {
      const k = `${i.mason_id}|${mesDe(i.payment_date)}`;
      grupos.set(k, [...(grupos.get(k) || []), i]);
    }
    for (const lista of grupos.values()) {
      const t = lista[0];
      push('S-1210', lista.map(i => i.id), `S-1210 ${t.name} (pago em ${mesDe(t.payment_date)})`, xmlS1210({ cpf, perApur: mesDe(t.payment_date), cpfBenef: t.document,
        pgtos: lista.map(i => ({ dtPgto: i.payment_date, perRef: mes.competencia, ideDmDev: i.id_dm_dev || String(i.id), vrLiq: i.calc_base })), tpAmb, agora, seq: seq() }));
    }
  } else if (etapa === 'S-1299') {
    const per = mes.competencia;
    const existe = sql => !!db.prepare(`SELECT 1 FROM payroll_items pi JOIN payroll_months pm ON pm.id = pi.payroll_month_id
      JOIN dctf_webs d ON d.id = pm.dctf_web_id WHERE d.client_id = ? AND d.ativo = 1 AND ${sql} LIMIT 1`).get(cliente.id, per);
    const f = JSON.parse(d.fechamento_json || '{}');
    const sim = k => String(f[k]) === '1';
    push('S-1299', { client: cliente.id, competencia: per }, `S-1299 ${per}`, xmlS1299({ cpf, perApur: per,
      evtRemun: existe("pm.competencia = ? AND COALESCE(pi.nr_rec_1200, '') <> ''"),
      evtPgtos: existe("substr(pi.payment_date, 1, 7) = ? AND COALESCE(pi.nr_rec_1210, '') <> ''"),
      evtComProd: sim('question3'), evtContratAvNP: sim('question4'), evtInfoComplPer: sim('question5'),
      transDCTFWeb: !!f.transmissao_imediata, naoValid: sim('question7'), tpAmb, agora, seq: seq() }));
  }
  return ev;
}

function aplicarRecibo(tipo, ref, recibo) {
  const flag = { 'S-1005': 'has_s1005', 'S-1010': 'has_s1010', 'S-1020': 'has_s1020' }[tipo];
  if (flag) return db.prepare(`UPDATE dctf_webs SET ${flag} = 1 WHERE id = ?`).run(ref);
  if (tipo === 'S-1200' || tipo === 'S-1210') {
    const col = tipo === 'S-1200' ? 'nr_rec_1200' : 'nr_rec_1210';
    for (const itemId of ref) db.prepare(`UPDATE payroll_items SET ${col} = ? WHERE id = ?`).run(recibo, itemId);
    return null;
  }
  if (tipo === 'S-1299') {
    db.prepare(`UPDATE payroll_months SET status = 'fechado', nr_rec_1299 = ? WHERE competencia = ?
      AND dctf_web_id IN (SELECT id FROM dctf_webs WHERE client_id = ?)`).run(recibo, ref.competencia, ref.client);
    db.prepare('UPDATE dctf_webs SET last_sent_at = ? WHERE client_id = ?').run(nowIso(), ref.client);
  }
  return null;
}

const acrescentar = (id, linhas) => {
  if (!linhas.length) return;
  const atual = (db.prepare('SELECT mensagem FROM esocial_logs WHERE id = ?').get(id) || {}).mensagem || '';
  atualizar(id, { mensagem: [atual, ...linhas].filter(Boolean).join('\n') });
};

// consulta o lote até o processamento; grava os recibos; false = parou (erro ou ainda processando)
async function acompanharLote(id, srv, pem, pend) {
  for (let t = 0; t < CONSULTA_TENTATIVAS; t++) {
    await espera(intervalo);
    const resp = await transporte(srv.consulta, NS.acaoConsulta, envelopeConsulta(pend.protocolo), pem);
    const ret = lerRetornoConsulta(resp.corpo);
    if (ret.cdResposta === '101') { atualizar(id, { etapa: `${pend.etapa}: em processamento no eSocial (consulta ${t + 1})` }); continue; }
    const porId = new Map(ret.eventos.map(e => [e.id, e]));
    const erros = [], avisos = [];
    for (const ev of pend.eventos) {
      const r = porId.get(ev.id) || (pend.eventos.length === 1 && ret.eventos.length === 1 ? ret.eventos[0] : null);
      if (ret.cdResposta === '201' && r && ['201', '202'].includes(r.cdResposta) && r.recibo) {
        aplicarRecibo(ev.tipo, ev.ref, r.recibo);
        if (r.cdResposta === '202') avisos.push(`${ev.rotulo}: aceito com advertências`, ...r.ocorrencias.map(o => `  ${o}`));
      } else {
        erros.push(`${ev.rotulo}: ${r ? `${r.cdResposta} - ${r.descResposta}` : `${ret.cdResposta} - ${ret.descResposta || 'sem retorno do evento'}`}`,
          ...(r ? r.ocorrencias : ret.ocorrencias).map(o => `  ${o}`));
      }
    }
    atualizar(id, { response_xml: resp.corpo, contexto: null });
    acrescentar(id, avisos);
    if (erros.length) {
      acrescentar(id, erros);
      atualizar(id, { status: 'erro', etapa: `${pend.etapa}: evento rejeitado pelo eSocial (os aceitos já tiveram o recibo gravado)` });
      return false;
    }
    return true;
  }
  atualizar(id, { etapa: `${pend.etapa}: o eSocial ainda está processando; consulte de novo em alguns minutos` });
  return false;
}

async function enviarEtapa(id, srv, pem, ctx, ce, etapa, eventos) {
  const grupo = etapa === 'tabelas' ? 1 : 3;
  const lote = eventos.map(e => ({ id: e.id, xmlAssinado: assinar(e.xml, pem) }));
  const corpo = envelopeEnvio({ grupo, empregadorCpf: ctx.cliente.documento, transmissorDoc: ce.documento, eventos: lote });
  const rotulo = { tabelas: 'Tabelas (S-1005/S-1010/S-1020)', 'S-1200': 'Remuneração (S-1200)', 'S-1210': 'Pagamentos (S-1210)', 'S-1299': 'Fechamento (S-1299)' }[etapa];
  atualizar(id, { payload_xml: corpo, status: 'enviando', etapa: `${rotulo}: enviando ${eventos.length} evento(s)` });
  const resp = await transporte(srv.envio, NS.acaoEnvio, corpo, pem);
  const ret = lerRetornoEnvio(resp.corpo);
  if (ret.cdResposta !== '201' || !ret.protocolo) {
    acrescentar(id, [`${rotulo}: ${ret.cdResposta || `HTTP ${resp.status}`} - ${ret.descResposta || 'resposta inesperada do eSocial'}`, ...ret.ocorrencias]);
    atualizar(id, { response_xml: resp.corpo, status: 'erro', etapa: `${rotulo}: lote recusado pelo eSocial` });
    return false;
  }
  const pend = { protocolo: ret.protocolo, etapa: rotulo, eventos: eventos.map(e => ({ id: e.id, tipo: e.tipo, ref: e.ref, rotulo: e.rotulo })) };
  atualizar(id, { response_xml: resp.corpo, protocolo: ret.protocolo, contexto: JSON.stringify(pend), status: 'processando', etapa: `${rotulo}: lote recebido; aguardando o processamento` });
  return acompanharLote(id, srv, pem, pend);
}

async function processarEnvioMes(id) {
  const log = db.prepare('SELECT * FROM esocial_logs WHERE id = ?').get(id);
  let ctx = contextoMes(log.payroll_month_id);
  const ce = db.prepare('SELECT * FROM certificates WHERE id = ? AND ativo = 1').get(ctx.cliente.certificate_id);
  if (!ce) throw new EsocialError('certificado do procurador não encontrado');
  const pem = cert.pemDoCertificado(cert.decifrar(ce.pfx_enc), cert.decifrar(ce.senha_enc).toString());
  const srv = SERVICOS[log.ambiente] || SERVICOS.producao_restrita;
  // retoma o lote que estava em processamento
  if (log.contexto && !(await acompanharLote(id, srv, pem, JSON.parse(log.contexto)))) return;
  const etapas = log.event === 'S-1299' ? ['S-1299'] : ['tabelas', 'S-1200', 'S-1210'];
  for (const etapa of etapas) {
    ctx = contextoMes(log.payroll_month_id); // recarrega: a etapa anterior gravou recibos
    const eventos = montarEtapa(etapa, ctx, srv.tpAmb);
    if (eventos.length && !(await enviarEtapa(id, srv, pem, ctx, ce, etapa, eventos))) return;
  }
  ctx = contextoMes(log.payroll_month_id);
  if (log.event !== 'S-1299') {
    if (!['fechado', 'fechado_externo'].includes(ctx.mes.status)) db.prepare("UPDATE payroll_months SET status = 'enviado' WHERE id = ?").run(ctx.mes.id);
    db.prepare('UPDATE dctf_webs SET last_sent_at = ? WHERE id = ?').run(nowIso(), ctx.d.id);
  }
  const recibo = log.event === 'S-1299' ? ctx.mes.nr_rec_1299 : `${ctx.itens.filter(i => i.nr_rec_1200).length} S-1200 e ${ctx.itens.filter(i => i.nr_rec_1210).length} S-1210 com recibo`;
  atualizar(id, { status: 'recebido', receipt: recibo, etapa: 'Concluído: recibos gravados' });
}

// registro para a tela de andamento; retoma a consulta se o servidor reiniciou no meio
function situacao(id, office) {
  const log = db.prepare('SELECT * FROM esocial_logs WHERE id = ? AND office = ?').get(id, office);
  if (!log) return null;
  if (log.status === 'processando' && !emAndamento.has(id)) processar(id).catch(() => {});
  return log;
}

module.exports = { enviarS1000, enviarMes, enviarFechamento, contextoMes, pendenciasMes, situacao, processar, pendenciasS1000, xmlS1000, xmlS1005, xmlS1010, xmlS1020, xmlS1200, xmlS1210, xmlS1299, assinar, envelopeEnvio, envelopeConsulta,
  lerRetornoEnvio, lerRetornoConsulta, idEvento, cpfValido, setTransporte, setIntervalo, emAndamento, SERVICOS, NS, EsocialError };

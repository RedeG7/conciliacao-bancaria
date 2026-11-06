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
  const eventos = tags(raiz, 'retornoEvento').filter(e => tags(e, 'processamento').length).map(e => {
    const proc = tags(e, 'processamento')[0];
    return { cdResposta: texto(proc, 'cdResposta'), descResposta: texto(proc, 'descResposta'), recibo: texto(e, 'nrRecibo'), ocorrencias: ocorrencias(proc) };
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

// registro para a tela de andamento; retoma a consulta se o servidor reiniciou no meio
function situacao(id, office) {
  const log = db.prepare('SELECT * FROM esocial_logs WHERE id = ? AND office = ?').get(id, office);
  if (!log) return null;
  if (log.status === 'processando' && !emAndamento.has(id)) processar(id).catch(() => {});
  return log;
}

module.exports = { enviarS1000, situacao, processar, pendenciasS1000, xmlS1000, assinar, envelopeEnvio, envelopeConsulta,
  lerRetornoEnvio, lerRetornoConsulta, idEvento, cpfValido, setTransporte, setIntervalo, emAndamento, SERVICOS, NS, EsocialError };

'use strict';
// Módulo DCTF Web (fase manual): obras com CNO, certificados digitais A1 dos
// clientes, envios DCTFWeb por competência com o passo a passo (guia de envio).
// O envio em si ainda é feito pelo escritório no e-CAC/eSocial; aqui fica o
// controle de cada competência. Rotas registradas pelo src/server.js.
const { db, nowIso } = require('./db');
const cert = require('./certificados');
const calc = require('./calc');
const { UFS } = require('./params');
const { html, brl, n2, dataBr, dataHoraBr, layout, contadores, tabela, select, campo } = require('./views');

const STATUS_OBRA = ['Em andamento', 'Concluída', 'Paralisada'];
const STATUS_ENVIO = ['Em andamento', 'Finalizado', 'Mensal', 'Cancelado'];
const STATUS_ESOCIAL = ['Não iniciado', 'Eventos enviados', 'Fechado (S-1299)', 'Com pendência'];
const PASSOS = [
  'Obra inscrita no CNO e dados conferidos',
  'Procuração e-CAC ou certificado do cliente conferido',
  'Remunerações enviadas no eSocial (S-1200 / S-1210)',
  'Movimento do eSocial fechado (S-1299)',
  'DCTFWeb conferida e transmitida no e-CAC',
  'DARF emitido e enviado ao cliente',
  'DARF pago e comprovante arquivado',
];
const PASSO_TRANSMITIDA = 4; // marca o "último envio" quando este passo é concluído
const AVISO_CERT_DIAS = 30;

const erro404 = msg => Object.assign(new Error(msg), { status: 404 });
const proxCompetencia = c => { const [a, m] = c.split('-').map(Number); return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`; };
const competenciaAtual = () => new Date().toISOString().slice(0, 7);
const passosDe = e => { const p = JSON.parse(e.passos_json || '[]'); return PASSOS.map((_, i) => !!p[i]); };
const progresso = e => Math.round((passosDe(e).filter(Boolean).length / PASSOS.length) * 100);
const passoAtual = e => { const i = passosDe(e).findIndex(x => !x); return i < 0 ? 'Concluído' : `${i + 1}. ${PASSOS[i]}`; };

function selo(dias) {
  if (dias < 0) return html`<span class="selo vencido">Vencido</span>`;
  if (dias <= AVISO_CERT_DIAS) return html`<span class="selo alerta">Expira em ${dias} dia(s)</span>`;
  return html`<span class="selo">Expira em ${dias} dias</span>`;
}

// avisos do Dashboard: certificados vencendo/vencidos
function avisosCertificados(office) {
  const lim = new Date(Date.now() + AVISO_CERT_DIAS * 864e5).toISOString();
  return db.prepare(`SELECT ce.*, c.nome AS cliente FROM certificates ce LEFT JOIN clients c ON c.id = ce.client_id
    WHERE ce.office = ? AND ce.ativo = 1 AND ce.validade <= ? ORDER BY ce.validade`).all(office, lim)
    .map(ce => {
      const d = cert.diasPara(ce.validade);
      return `Certificado de ${ce.cliente || ce.titular} ${d < 0 ? 'VENCIDO' : `vence em ${d} dia(s)`} (${dataBr(ce.validade)}): atualize em DCTF Web > Certificados digitais.`;
    });
}

module.exports = function registrar(app, { h, flash, contagens, exigirAdmin, clientesDo }) {
  const obrasDo = office => db.prepare(`SELECT w.id, w.cno, w.endereco, c.nome AS cliente FROM works w JOIN clients c ON c.id = w.client_id
    WHERE w.office = ? AND w.ativo = 1 ORDER BY c.nome`).all(office);
  const clienteDoEscritorio = (office, id) => (id && db.prepare('SELECT id FROM clients WHERE id = ? AND office = ? AND ativo = 1').get(Number(id), office) ? Number(id) : null);

  // ------------------------------------------------------------ obras (CNO)
  function formObra(req, w, acao) {
    return html`<form method="post" action="${acao}" class="card"><div class="grade">
      ${campo('Cliente *', select('client_id', [['', 'Selecione'], ...clientesDo(req.office).map(c => [c.id, c.nome])], w.client_id, 'required'))}
      ${campo('CNO', html`<input name="cno" value="${w.cno || ''}" placeholder="00.000.00000/00">`)}
      ${campo('Endereço da obra', html`<input name="endereco" value="${w.endereco || ''}">`)}
      ${campo('Município', html`<input name="municipio" value="${w.municipio || ''}">`)}
      ${campo('UF', select('uf', ['', ...UFS], w.uf))}
      ${campo('Área (m²)', html`<input name="area" value="${w.area ?? ''}" inputmode="decimal">`)}
      ${campo('Início', html`<input name="data_inicio" type="date" value="${w.data_inicio || ''}">`)}
      ${campo('Término', html`<input name="data_fim" type="date" value="${w.data_fim || ''}">`)}
      ${campo('Situação', select('status', STATUS_OBRA, w.status))}
      ${campo('Observações', html`<textarea name="obs" rows="2">${w.obs || ''}</textarea>`, 'largo')}
    </div><div class="acoes"><button class="botao">Salvar</button></div></form>`;
  }
  const lerObra = (req, b) => [clienteDoEscritorio(req.office, b.client_id), b.cno || '', b.endereco || '', b.municipio || '', UFS.includes(b.uf) ? b.uf : '',
    calc.num(b.area) || null, b.data_inicio || '', b.data_fim || '', STATUS_OBRA.includes(b.status) ? b.status : 'Em andamento', b.obs || ''];

  app.get('/acompanhamento-de-obras/obras', h((req, res) => {
    const filtro = Number(req.query.cliente) || null;
    const rows = db.prepare(`SELECT w.*, c.nome AS cliente FROM works w JOIN clients c ON c.id = w.client_id
      WHERE w.office = ? AND w.ativo = 1 ${filtro ? 'AND w.client_id = ?' : ''} ORDER BY w.id DESC`).all(req.office, ...(filtro ? [filtro] : []));
    res.send(layout(req, 'Obras (CNO)', html`${contadores(contagens('works', req.office, 'AND ativo = 1'))}
      <details class="card" ${filtro ? 'open' : ''}><summary class="botao">+ Cadastrar obra</summary>${formObra(req, { client_id: filtro }, '/acompanhamento-de-obras/obras')}</details>
      ${tabela(['Cliente', 'CNO', 'Endereço', 'Município/UF', 'Área', 'Início', 'Término', 'Situação', 'Ações'], rows.map(w => [w.cliente, w.cno, w.endereco,
        [w.municipio, w.uf].filter(Boolean).join('/'), w.area ? `${n2(w.area)} m²` : '', dataBr(w.data_inicio), dataBr(w.data_fim), w.status,
        html`<span class="acoes-linha"><a href="/dctf-web/novo?obra=${w.id}">Novo envio</a><a href="/obras/${w.id}">Editar</a>
        <form method="post" action="/obras/${w.id}/desativar" data-confirmar="Desativar esta obra?"><button class="link">Desativar</button></form></span>`]))}`,
    { descricao: 'Obras dos clientes com a inscrição no CNO. Cada envio DCTFWeb é de uma obra.', migalha: 'DCTF Web' }));
  }));
  app.post('/acompanhamento-de-obras/obras', h((req, res) => {
    const v = lerObra(req, req.body);
    if (!v[0]) { flash(res, 'Escolha o cliente da obra.', 'erro'); return res.redirect('/acompanhamento-de-obras/obras'); }
    db.prepare(`INSERT INTO works (office, client_id, cno, endereco, municipio, uf, area, data_inicio, data_fim, status, obs, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.office, ...v, nowIso());
    flash(res, 'Obra cadastrada.');
    res.redirect('/acompanhamento-de-obras/obras');
  }));
  const carregarObra = req => {
    const w = db.prepare('SELECT * FROM works WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
    if (!w) throw erro404('Obra não encontrada.');
    return w;
  };
  app.get('/obras/:id', h((req, res) => {
    const w = carregarObra(req);
    res.send(layout(req, `Obra ${w.cno || '#' + w.id}`, formObra(req, w, `/obras/${w.id}`), { migalha: 'DCTF Web / Obras' }));
  }));
  app.post('/obras/:id', h((req, res) => {
    const w = carregarObra(req);
    const v = lerObra(req, req.body);
    if (!v[0]) { flash(res, 'Escolha o cliente da obra.', 'erro'); return res.redirect(`/obras/${w.id}`); }
    db.prepare('UPDATE works SET client_id=?, cno=?, endereco=?, municipio=?, uf=?, area=?, data_inicio=?, data_fim=?, status=?, obs=? WHERE id=?').run(...v, w.id);
    flash(res, 'Obra salva.');
    res.redirect('/acompanhamento-de-obras/obras');
  }));
  app.post('/obras/:id/desativar', h((req, res) => {
    const w = carregarObra(req);
    db.prepare('UPDATE works SET ativo = 0 WHERE id = ?').run(w.id);
    flash(res, 'Obra desativada.');
    res.redirect('/acompanhamento-de-obras/obras');
  }));

  // ------------------------------------------------------------ certificados
  app.get('/cadastros/certificados', h((req, res) => {
    const rows = db.prepare(`SELECT ce.*, c.nome AS cliente FROM certificates ce LEFT JOIN clients c ON c.id = ce.client_id
      WHERE ce.office = ? AND ce.ativo = 1 ORDER BY ce.validade`).all(req.office);
    const opcCli = [['', '- sem cliente -'], ...clientesDo(req.office).map(c => [c.id, c.nome])];
    const upload = (titulo, acao, extra = '') => html`<details class="card"><summary class="botao ${extra ? 'sec' : ''}">${titulo}</summary>
      <form method="post" action="${acao}" autocomplete="off"><div class="grade">
        ${extra ? campo('Certificado a substituir *', select('substituir', rows.map(ce => [ce.id, `${ce.cliente || ce.titular} - ${ce.documento} (vence ${dataBr(ce.validade)})`]), '', 'required')) : campo('Cliente', select('client_id', opcCli, req.query.cliente))}
        ${campo('Arquivo A1 (.pfx / .p12) *', html`<input type="file" accept=".pfx,.p12" class="ler-arquivo-b64" data-alvo="pfx${extra}" data-nome="nome${extra}" required>`)}
        ${campo('Senha do certificado *', html`<input type="password" name="senha" required autocomplete="new-password">`)}
      </div><input type="hidden" name="pfx_b64" id="pfx${extra}"><input type="hidden" name="arquivo_nome" id="nome${extra}">
      <div class="acoes"><button class="botao">Importar</button></div></form></details>`;
    res.send(layout(req, 'Certificados digitais', html`
      ${cert.cifraDisponivel() ? html`${upload('+ Importar certificado', '/cadastros/certificados')}${rows.length ? upload('Atualizar certificado', '/cadastros/certificados/atualizar', 'sub') : ''}`
        : html`<div class="aviso erro">Guarda de certificados não configurada no servidor (CERT_ENC_KEY). Avise o administrador.</div>`}
      <div class="grade-cards">${rows.map(ce => html`<div class="card cert">
        <b>${ce.cliente || ce.titular}</b><small>${ce.titular}</small>
        <span>${ce.documento.length === 14 ? 'CNPJ' : 'CPF'} ${ce.documento || '-'} · ${ce.emissor}</span>
        <div class="acoes-linha">${selo(cert.diasPara(ce.validade))}<small>Validade ${dataBr(ce.validade)}</small></div>
        <form method="post" action="/cadastros/certificados/${ce.id}/excluir" data-confirmar="Excluir este certificado? O arquivo e a senha são apagados."><button class="link">Excluir</button></form>
      </div>`)}</div>${rows.length ? '' : html`<div class="card"><p class="desc">Nenhum certificado importado.</p></div>`}`,
    { descricao: 'Certificado A1 dos clientes para o envio DCTFWeb. O arquivo e a senha ficam cifrados; o sistema avisa 30 dias antes do vencimento.', migalha: 'DCTF Web' }));
  }));

  function lerUpload(b) {
    const buf = Buffer.from(String(b.pfx_b64 || ''), 'base64');
    if (!buf.length) throw new cert.CertError('Escolha o arquivo do certificado.');
    if (buf.length > 200 * 1024) throw new cert.CertError('Arquivo grande demais para um certificado A1.');
    return { buf, info: cert.lerPfx(buf, String(b.senha || '')) };
  }
  const voltaCert = (res, e) => { if (!(e instanceof cert.CertError)) throw e; flash(res, e.message, 'erro'); res.redirect('/cadastros/certificados'); };

  app.post('/cadastros/certificados', h((req, res) => {
    let up;
    try { up = lerUpload(req.body); } catch (e) { return voltaCert(res, e); }
    db.prepare(`INSERT INTO certificates (office, client_id, titular, documento, emissor, validade, arquivo_nome, pfx_enc, senha_enc, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.office, clienteDoEscritorio(req.office, req.body.client_id), up.info.titular, up.info.documento, up.info.emissor,
      up.info.validade, String(req.body.arquivo_nome || '').slice(0, 120), cert.cifrar(up.buf), cert.cifrar(Buffer.from(String(req.body.senha))), req.user.name, nowIso());
    const dias = cert.diasPara(up.info.validade);
    flash(res, `Certificado de ${up.info.titular} importado (validade ${dataBr(up.info.validade)}).`, dias < 0 ? 'erro' : dias <= AVISO_CERT_DIAS ? 'alerta' : 'ok');
    res.redirect('/cadastros/certificados');
  }));
  app.post('/cadastros/certificados/atualizar', h((req, res) => {
    const velho = db.prepare('SELECT * FROM certificates WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.body.substituir), req.office);
    if (!velho) throw erro404('Certificado não encontrado.');
    let up;
    try { up = lerUpload(req.body); } catch (e) { return voltaCert(res, e); }
    db.prepare(`UPDATE certificates SET titular=?, documento=?, emissor=?, validade=?, arquivo_nome=?, pfx_enc=?, senha_enc=?, created_by=?, created_at=? WHERE id=?`)
      .run(up.info.titular, up.info.documento, up.info.emissor, up.info.validade, String(req.body.arquivo_nome || '').slice(0, 120),
        cert.cifrar(up.buf), cert.cifrar(Buffer.from(String(req.body.senha))), req.user.name, nowIso(), velho.id);
    flash(res, `Certificado atualizado (nova validade ${dataBr(up.info.validade)}).`);
    res.redirect('/cadastros/certificados');
  }));
  app.post('/cadastros/certificados/:id/excluir', h((req, res) => {
    exigirAdmin(req);
    // apaga o conteúdo cifrado (não só desativa): certificado é dado sensível
    const r = db.prepare("UPDATE certificates SET ativo = 0, pfx_enc = '', senha_enc = '' WHERE id = ? AND office = ?").run(Number(req.params.id), req.office);
    if (!r.changes) throw erro404('Certificado não encontrado.');
    flash(res, 'Certificado excluído.');
    res.redirect('/cadastros/certificados');
  }));

  // ------------------------------------------------------------ envios DCTFWeb
  const carregarEnvio = req => {
    const e = db.prepare('SELECT * FROM dctf_envios WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
    if (!e) throw erro404('Envio não encontrado.');
    return e;
  };
  const SQL_ENVIOS = `SELECT e.*, c.nome AS cliente, w.cno, w.endereco, ce.validade AS cert_validade FROM dctf_envios e JOIN clients c ON c.id = e.client_id
    LEFT JOIN works w ON w.id = e.work_id LEFT JOIN certificates ce ON ce.id = e.certificate_id AND ce.ativo = 1 WHERE e.office = ? AND e.ativo = 1`;

  app.get('/dctf-web', h((req, res) => {
    const q = req.query;
    const cond = [], args = [req.office];
    if (STATUS_ENVIO.includes(q.status)) { cond.push('e.status = ?'); args.push(q.status); }
    if (/^\d{4}-\d{2}$/.test(q.de || '')) { cond.push('e.competencia >= ?'); args.push(q.de); }
    if (/^\d{4}-\d{2}$/.test(q.ate || '')) { cond.push('e.competencia <= ?'); args.push(q.ate); }
    const rows = db.prepare(`${SQL_ENVIOS} ${cond.map(c => 'AND ' + c).join(' ')} ORDER BY e.competencia DESC, e.id DESC`).all(...args);
    res.send(layout(req, 'Envios DCTFWeb', html`${contadores(contagens('dctf_envios', req.office, 'AND ativo = 1'))}
      <form class="card filtros" method="get"><div class="grade">
        ${campo('Status', select('status', [['', 'Todos'], ...STATUS_ENVIO], q.status))}
        ${campo('Competência de', html`<input type="month" name="de" value="${q.de || ''}">`)}
        ${campo('até', html`<input type="month" name="ate" value="${q.ate || ''}">`)}
      </div><div class="acoes"><button class="botao sec">Filtrar</button><a class="botao" href="/dctf-web/novo">+ Novo envio</a></div></form>
      ${tabela(['ID', 'Cliente', 'Obra', 'CNO', 'eSocial', 'Status', 'Progresso', 'Último envio', 'Competência', 'Ações'], rows.map(e => [e.id, e.cliente, e.endereco, e.cno,
        e.esocial_status, html`<span class="selo">${e.status}</span>`, `${progresso(e)}%`, dataBr(e.ultimo_envio), e.competencia,
        html`<a href="/dctf-web/${e.id}">Abrir</a>`]))}`,
    { descricao: 'Controle mensal dos envios DCTFWeb por obra e competência. A transmissão é feita no e-CAC; aqui fica o passo a passo e o histórico.', migalha: 'DCTF Web' }));
  }));

  function formEnvio(req, e, acao) {
    const certs = db.prepare(`SELECT ce.id, ce.titular, ce.documento, ce.validade, c.nome AS cliente FROM certificates ce LEFT JOIN clients c ON c.id = ce.client_id
      WHERE ce.office = ? AND ce.ativo = 1 ORDER BY ce.titular`).all(req.office);
    return html`<div class="grade">
      ${campo('Cliente *', select('client_id', [['', 'Selecione'], ...clientesDo(req.office).map(c => [c.id, c.nome])], e.client_id, 'required'))}
      ${campo('Obra (CNO)', select('work_id', [['', '- sem obra cadastrada -'], ...obrasDo(req.office).map(w => [w.id, `${w.cliente} - ${w.cno || 'sem CNO'} ${w.endereco ? '- ' + w.endereco : ''}`])], e.work_id))}
      ${campo('Competência *', html`<input type="month" name="competencia" value="${e.competencia || ''}" required>`)}
      ${campo('Status', select('status', STATUS_ENVIO, e.status))}
      ${campo('eSocial', select('esocial_status', STATUS_ESOCIAL, e.esocial_status))}
      ${campo('Certificado usado', select('certificate_id', [['', '- procuração e-CAC / nenhum -'], ...certs.map(c => [c.id, `${c.cliente || c.titular} (${c.documento}, vence ${dataBr(c.validade)})`])], e.certificate_id))}
      ${campo('Valor do DARF (R$)', html`<input name="valor_darf" value="${e.valor_darf ? n2(e.valor_darf) : ''}" inputmode="decimal">`)}
      ${campo('Vencimento do DARF', html`<input type="date" name="vencimento" value="${e.vencimento || ''}">`)}
      ${campo('Nº do recibo da DCTFWeb', html`<input name="recibo" value="${e.recibo || ''}">`)}
      ${campo('Observações', html`<textarea name="obs" rows="2">${e.obs || ''}</textarea>`, 'largo')}
    </div>`;
  }
  const lerEnvio = (req, b) => {
    const clientId = clienteDoEscritorio(req.office, b.client_id);
    const work = b.work_id && db.prepare('SELECT id FROM works WHERE id = ? AND office = ?').get(Number(b.work_id), req.office);
    const certRow = b.certificate_id && db.prepare('SELECT id FROM certificates WHERE id = ? AND office = ? AND ativo = 1').get(Number(b.certificate_id), req.office);
    return {
      client_id: clientId, work_id: work ? work.id : null, certificate_id: certRow ? certRow.id : null,
      competencia: /^\d{4}-\d{2}$/.test(b.competencia || '') ? b.competencia : null,
      status: STATUS_ENVIO.includes(b.status) ? b.status : 'Em andamento', esocial_status: STATUS_ESOCIAL.includes(b.esocial_status) ? b.esocial_status : STATUS_ESOCIAL[0],
      valor_darf: calc.num(b.valor_darf) || null, vencimento: b.vencimento || null, recibo: b.recibo || '', obs: b.obs || '',
    };
  };

  app.get('/dctf-web/novo', h((req, res) => {
    const w = req.query.obra && db.prepare('SELECT * FROM works WHERE id = ? AND office = ?').get(Number(req.query.obra), req.office);
    const certCli = w && db.prepare('SELECT id FROM certificates WHERE client_id = ? AND office = ? AND ativo = 1 ORDER BY validade DESC').get(w.client_id, req.office);
    const e = { client_id: w?.client_id, work_id: w?.id, certificate_id: certCli?.id, competencia: competenciaAtual() };
    res.send(layout(req, 'Novo envio DCTFWeb', html`<form method="post" action="/dctf-web/novo" class="card">${formEnvio(req, e)}
      <div class="acoes"><button class="botao">Criar envio</button><a class="botao sec" href="/dctf-web">Cancelar</a></div></form>`, { migalha: 'DCTF Web / Envios' }));
  }));
  app.post('/dctf-web/novo', h((req, res) => {
    const v = lerEnvio(req, req.body);
    if (!v.client_id || !v.competencia) { flash(res, 'Informe cliente e competência.', 'erro'); return res.redirect('/dctf-web/novo'); }
    const r = db.prepare(`INSERT INTO dctf_envios (office, client_id, work_id, certificate_id, competencia, status, esocial_status, valor_darf, vencimento, recibo, obs, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.office, v.client_id, v.work_id, v.certificate_id, v.competencia, v.status, v.esocial_status, v.valor_darf, v.vencimento, v.recibo, v.obs, req.user.name, nowIso());
    flash(res, 'Envio criado. Siga o passo a passo.');
    res.redirect(`/dctf-web/${r.lastInsertRowid}`);
  }));

  app.get('/dctf-web/:id', h((req, res) => {
    const e = carregarEnvio(req);
    const x = db.prepare(`${SQL_ENVIOS} AND e.id = ?`).get(req.office, e.id);
    const feitos = passosDe(e);
    const certAviso = x.cert_validade && cert.diasPara(x.cert_validade) <= AVISO_CERT_DIAS
      ? html`<div class="aviso alerta">O certificado escolhido ${cert.diasPara(x.cert_validade) < 0 ? 'está vencido' : `vence em ${cert.diasPara(x.cert_validade)} dia(s)`}.</div>` : '';
    res.send(layout(req, `DCTFWeb ${e.competencia} - ${x.cliente}`, html`${certAviso}
      ${e.pausado_em ? html`<div class="aviso alerta">Pausado em ${dataHoraBr(e.pausado_em)} por ${e.pausado_por}.</div>` : ''}
      <div class="card"><h3>Passo a passo (${progresso(e)}%)</h3><div class="barra"><span style="width:${progresso(e)}%"></span></div>
        <form method="post" action="/dctf-web/${e.id}/passos" class="passos">${PASSOS.map((p, i) => html`
          <label class="passo ${feitos[i] ? 'feito' : ''}"><input type="checkbox" name="passo" value="${i}" ${feitos[i] ? 'checked' : ''}> ${i + 1}. ${p}</label>`)}
          <div class="acoes"><button class="botao">Salvar passo a passo</button></div></form>
        <div class="acoes"><form method="post" action="/dctf-web/${e.id}/pausar"><button class="botao sec">${e.pausado_em ? 'Retomar' : 'Pausar'}</button></form>
          ${e.status === 'Mensal' || progresso(e) === 100 ? html`<form method="post" action="/dctf-web/${e.id}/proxima"><button class="botao sec">Abrir competência ${proxCompetencia(e.competencia)}</button></form>` : ''}
          <form method="post" action="/dctf-web/${e.id}/desativar" data-confirmar="Excluir este envio?"><button class="botao sec">Excluir</button></form></div></div>
      <form method="post" action="/dctf-web/${e.id}" class="card"><h3>Dados do envio</h3>${formEnvio(req, e)}
        <p class="desc">Último envio: ${e.ultimo_envio ? dataHoraBr(e.ultimo_envio) : '-'}${e.valor_darf ? ` · DARF ${brl(e.valor_darf)}` : ''}</p>
        <div class="acoes"><button class="botao">Salvar</button></div></form>`, { migalha: 'DCTF Web / Envios' }));
  }));
  app.post('/dctf-web/:id', h((req, res) => {
    const e = carregarEnvio(req);
    const v = lerEnvio(req, req.body);
    if (!v.client_id || !v.competencia) { flash(res, 'Informe cliente e competência.', 'erro'); return res.redirect(`/dctf-web/${e.id}`); }
    db.prepare('UPDATE dctf_envios SET client_id=?, work_id=?, certificate_id=?, competencia=?, status=?, esocial_status=?, valor_darf=?, vencimento=?, recibo=?, obs=? WHERE id=?')
      .run(v.client_id, v.work_id, v.certificate_id, v.competencia, v.status, v.esocial_status, v.valor_darf, v.vencimento, v.recibo, v.obs, e.id);
    flash(res, 'Envio salvo.');
    res.redirect(`/dctf-web/${e.id}`);
  }));
  app.post('/dctf-web/:id/passos', h((req, res) => {
    const e = carregarEnvio(req);
    const marcados = new Set([].concat(req.body.passo || []).map(Number));
    const passos = PASSOS.map((_, i) => marcados.has(i));
    const antes = passosDe(e);
    const ultimo = passos[PASSO_TRANSMITIDA] && !antes[PASSO_TRANSMITIDA] ? nowIso() : e.ultimo_envio;
    // eSocial acompanha os passos 3 e 4; envio com tudo feito vira Finalizado (o Mensal continua Mensal)
    const esocial = passos[3] ? 'Fechado (S-1299)' : passos[2] ? 'Eventos enviados' : e.esocial_status;
    const status = passos.every(Boolean) && e.status === 'Em andamento' ? 'Finalizado' : e.status;
    db.prepare('UPDATE dctf_envios SET passos_json=?, ultimo_envio=?, esocial_status=?, status=? WHERE id=?').run(JSON.stringify(passos), ultimo, esocial, status, e.id);
    flash(res, 'Passo a passo salvo.');
    res.redirect(`/dctf-web/${e.id}`);
  }));
  app.post('/dctf-web/:id/pausar', h((req, res) => {
    const e = carregarEnvio(req);
    if (e.pausado_em) db.prepare('UPDATE dctf_envios SET pausado_em = NULL, pausado_por = NULL WHERE id = ?').run(e.id);
    else db.prepare('UPDATE dctf_envios SET pausado_em = ?, pausado_por = ? WHERE id = ?').run(nowIso(), req.user.name, e.id);
    res.redirect(req.get('referer')?.includes('/guia-de-envio') ? '/guia-de-envio' : `/dctf-web/${e.id}`);
  }));
  app.post('/dctf-web/:id/proxima', h((req, res) => {
    const e = carregarEnvio(req);
    const comp = proxCompetencia(e.competencia);
    const existe = db.prepare('SELECT id FROM dctf_envios WHERE office = ? AND client_id = ? AND IFNULL(work_id, 0) = IFNULL(?, 0) AND competencia = ? AND ativo = 1')
      .get(req.office, e.client_id, e.work_id, comp);
    if (existe) return res.redirect(`/dctf-web/${existe.id}`);
    const r = db.prepare(`INSERT INTO dctf_envios (office, client_id, work_id, certificate_id, competencia, status, esocial_status, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(req.office, e.client_id, e.work_id, e.certificate_id, comp, e.status === 'Mensal' ? 'Mensal' : 'Em andamento', STATUS_ESOCIAL[0], req.user.name, nowIso());
    flash(res, `Competência ${comp} aberta.`);
    res.redirect(`/dctf-web/${r.lastInsertRowid}`);
  }));
  app.post('/dctf-web/:id/desativar', h((req, res) => {
    const e = carregarEnvio(req);
    db.prepare('UPDATE dctf_envios SET ativo = 0 WHERE id = ?').run(e.id);
    flash(res, 'Envio excluído.');
    res.redirect('/dctf-web');
  }));

  // ------------------------------------------------------------ guia de envio
  app.get('/guia-de-envio', h((req, res) => {
    const todos = db.prepare(`${SQL_ENVIOS} AND e.status != 'Cancelado' ORDER BY e.competencia DESC, e.id DESC`).all(req.office);
    const abas = {
      andamento: ['Em andamento', todos.filter(e => !e.pausado_em && progresso(e) < 100)],
      pausados: ['Pausados', todos.filter(e => e.pausado_em && progresso(e) < 100)],
      concluidos: ['Concluídos', todos.filter(e => progresso(e) === 100)],
    };
    const aba = abas[req.query.aba] ? req.query.aba : 'andamento';
    res.send(layout(req, 'Guia de envio', html`
      <div class="abas">${Object.entries(abas).map(([k, [t, l]]) => html`<a href="?aba=${k}" class="${k === aba ? 'ativo' : ''}">${t} <span>${l.length}</span></a>`)}
        <a class="botao" href="/dctf-web/novo">+ Novo guia</a></div>
      ${tabela(['Cliente', 'Competência', 'Progresso', 'Passo atual', 'Pausado em', 'Por', 'Ações'], abas[aba][1].map(e => [e.cliente, e.competencia,
        html`<div class="barra pequena"><span style="width:${progresso(e)}%"></span></div>${progresso(e)}%`, passoAtual(e), dataHoraBr(e.pausado_em), e.pausado_por || e.created_by,
        html`<span class="acoes-linha"><a href="/dctf-web/${e.id}">Ver passo a passo</a>${progresso(e) < 100 ? html`<form method="post" action="/dctf-web/${e.id}/pausar"><button class="link">${e.pausado_em ? 'Retomar' : 'Pausar'}</button></form>` : ''}</span>`]),
      'Nenhum envio nesta aba.')}`,
    { descricao: 'Passo a passo do envio DCTFWeb de cada obra e competência: do CNO ao DARF pago.', migalha: 'DCTF Web' }));
  }));
};
module.exports.avisosCertificados = avisosCertificados;

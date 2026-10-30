'use strict';
// Módulo DCTF Web (SPEC_MODULO_DCTFWEB): envio eSocial da obra de pessoa física.
// Cliente (empregador S-1000) com procuração eletrônica para o procurador do
// escritório - o certificado A1 é DO PROCURADOR, não do cliente -, autônomos
// (S-2300), obra (S-1005), envio DCTFWeb com rubrica (S-1010), lotação
// (S-1020), remuneração/pagamento por competência (S-1200/S-1210) e
// fechamento (S-1299), relatório e guia de envio com progresso automático.
// A transmissão ao eSocial ainda não existe: os envios são feitos fora e os
// recibos são registrados aqui. Rotas registradas pelo src/server.js.
const { db, nowIso, paramReader } = require('./db');
const cert = require('./certificados');
const calc = require('./calc');
const folha = require('./folha');
const { UFS } = require('./params');
const { html, raw, brl, n2, dataBr, dataHoraBr, layout, contadores, tabela, select, campo } = require('./views');

const AVISO_CERT_DIAS = 30;
const STATUS_DCTF = [['em_andamento', 'Em andamento'], ['finalizado', 'Finalizado'], ['mensal', 'Mensal'], ['cancelado', 'Cancelado']];
const rotuloStatus = s => (STATUS_DCTF.find(x => x[0] === s) || [s, s])[1];
const STATUS_MES = [['rascunho', 'Rascunho'], ['marcado', 'Marcado para envio'], ['enviado', 'Enviado'], ['fechado', 'Enviado e fechado'], ['fechado_externo', 'Fechado no eSocial fora do sistema']];
const PERGUNTAS_1299 = [
  'Possui informações relativas a remuneração de trabalhadores ou provento/pensão no período?',
  'Possui informações de pagamento de rendimentos do trabalho no período?',
  'Possui informações de comercialização de produção?',
  'Contratou, por intermédio de sindicato, trabalhadores avulsos não portuários?',
  'Possui informações de desoneração de folha / Simples com atividade substituída e não substituída?',
  'Indicativo de exclusão de apuração das aquisições de produção rural (S-1250)',
  'Indicativo de não validação das regras de fechamento',
];
const IRRF = [['11', '11 - Remuneração mensal'], ['79', '79 - Outras isenções'], ['09', '09 - Rendimentos isentos de IRRF']];
const SEXO = [['', '-'], ['M', 'Masculino'], ['F', 'Feminino']];
const RACA = [['', '-'], ['1', '1 - Branca'], ['2', '2 - Preta'], ['3', '3 - Parda'], ['4', '4 - Amarela'], ['5', '5 - Indígena'], ['6', '6 - Não informado']];
const EST_CIVIL = [['', '-'], ['1', '1 - Solteiro'], ['2', '2 - Casado'], ['3', '3 - Divorciado'], ['4', '4 - Separado'], ['5', '5 - Viúvo']];
const INSTRUCAO = [['', '-'], ['01', '01 - Analfabeto'], ['02', '02 - Até o 5º ano incompleto'], ['03', '03 - 5º ano completo'], ['04', '04 - 6º ao 9º ano incompleto'],
  ['05', '05 - Fundamental completo'], ['06', '06 - Médio incompleto'], ['07', '07 - Médio completo'], ['08', '08 - Superior incompleto'], ['09', '09 - Superior completo'],
  ['10', '10 - Pós-graduação'], ['11', '11 - Mestrado'], ['12', '12 - Doutorado']];
const DATA_MIN_OBRA = P => {
  const v = String(P.get('dctf', 'Início da obrigatoriedade (AAAAMM)') || '202110');
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-01`;
};

const erro404 = msg => Object.assign(new Error(msg), { status: 404 });
const soDigitos = v => String(v || '').replace(/\D/g, '');
const idade = d => { if (!d) return ''; const n = new Date(d), h = new Date(); let a = h.getFullYear() - n.getFullYear(); if (h < new Date(h.getFullYear(), n.getMonth(), n.getDate())) a--; return a; };
const nomeMes = c => new Date(`${c}-15`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, x => x.toUpperCase());
const ultimoDia = c => { const [a, m] = c.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };
const inp = (name, v, attrs = '') => html`<input name="${name}" value="${v ?? ''}" ${raw(attrs)}>`;
const simNao = (name, v) => select(name, [['1', 'Sim'], ['0', 'Não']], v ? '1' : '0');

function selo(dias) {
  if (dias < 0) return html`<span class="selo vencido">Vencido</span>`;
  if (dias <= AVISO_CERT_DIAS) return html`<span class="selo alerta">Expira em ${dias} dia(s)</span>`;
  return html`<span class="selo">Expira em ${dias} dias</span>`;
}

// procuração informada e vigente + certificado do procurador válido: sem isso
// o envio ao eSocial fica bloqueado (spec 1)
function situacaoProcuracao(c) {
  const hoje = new Date().toISOString().slice(0, 10);
  const ce = c.certificate_id && db.prepare('SELECT * FROM certificates WHERE id = ? AND office = ? AND ativo = 1').get(c.certificate_id, c.office);
  const proc = !!c.possui_procuracao && !!c.procuracao_data_assinatura && !!c.procuracao_data_fim && c.procuracao_data_fim >= hoje;
  const certOk = !!ce && cert.diasPara(ce.validade) >= 0;
  return { proc, certOk, cert: ce, ok: proc && certOk };
}

// avisos do Dashboard: certificados do procurador vencendo/vencidos
function avisosCertificados(office) {
  const lim = new Date(Date.now() + AVISO_CERT_DIAS * 864e5).toISOString();
  return db.prepare('SELECT * FROM certificates WHERE office = ? AND ativo = 1 AND validade <= ? ORDER BY validade').all(office, lim).map(ce => {
    const d = cert.diasPara(ce.validade);
    return `Certificado do procurador ${ce.titular} ${d < 0 ? 'VENCIDO' : `vence em ${d} dia(s)`} (${dataBr(ce.validade)}): atualize em DCTF Web > Certificados digitais.`;
  });
}

// "Ativar lembretes": para cada envio com lembrete ligado (e não finalizado
// nem cancelado), avisa se a competência do mês anterior - a que vence no
// dia de vencimento deste mês - ainda não foi enviada nem marcada como
// paralisada. Aparece no Dashboard.
function lembretesDctf(office, hoje = new Date()) {
  const dia = paramReader(office).get('dctf', 'Dia de vencimento') || 20;
  const comp = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 15)).toISOString().slice(0, 7);
  const venc = folha.vencimento(comp, dia);
  const hojeIso = hoje.toISOString().slice(0, 10);
  return db.prepare(`SELECT d.*, c.nome AS cliente, w.data_inicio, w.data_fim FROM dctf_webs d JOIN clients c ON c.id = d.client_id LEFT JOIN works w ON w.id = d.work_id
    WHERE d.office = ? AND d.ativo = 1 AND d.lembretes = 1 AND d.status IN ('em_andamento','mensal')`).all(office)
    .filter(d => {
      const ini = (d.construction_init_date || d.data_inicio || '').slice(0, 7), fim = (d.construction_end_date || d.data_fim || '').slice(0, 7);
      if ((ini && comp < ini) || (fim && comp > fim)) return false;
      const m = db.prepare('SELECT status, is_paralyzed FROM payroll_months WHERE dctf_web_id = ? AND competencia = ?').get(d.id, comp);
      return !m || (!m.is_paralyzed && !['enviado', 'fechado', 'fechado_externo'].includes(m.status));
    })
    .map(d => `Envio DCTFWeb #${d.id} (${d.cliente}): competência ${comp.slice(5)}/${comp.slice(0, 4)} ${hojeIso > venc ? `VENCIDA em ${dataBr(venc)}` : `vence em ${dataBr(venc)}`} e ainda não foi enviada.`);
}

// ---------------------------------------------------------------- guia de envio
// Os 8 passos da spec, detectados pelos dados já cadastrados (não é checklist).
function passosGuia(office, c) {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const predial = n("SELECT COUNT(*) AS n FROM simulations WHERE office = ? AND client_id = ? AND kind = 'predial' AND ativo = 1", office, c.id);
  const esocial = n("SELECT COUNT(*) AS n FROM simulations WHERE office = ? AND client_id = ? AND kind = 'esocial' AND ativo = 1", office, c.id);
  const sp = situacaoProcuracao(c);
  const masons = n('SELECT COUNT(*) AS n FROM masons WHERE office = ? AND client_id = ? AND ativo = 1', office, c.id);
  const obra = db.prepare('SELECT * FROM works WHERE office = ? AND client_id = ? AND ativo = 1 ORDER BY (calculator_id IS NULL), id LIMIT 1').get(office, c.id);
  const trab = obra ? n('SELECT COUNT(*) AS n FROM work_masons WHERE work_id = ? AND start_date IS NOT NULL AND start_date != ?', obra.id, '') : 0;
  const dctf = db.prepare('SELECT id FROM dctf_webs WHERE office = ? AND client_id = ? AND ativo = 1 ORDER BY id DESC LIMIT 1').get(office, c.id);
  const enviados = n(`SELECT COUNT(*) AS n FROM payroll_months pm JOIN dctf_webs d ON d.id = pm.dctf_web_id
    WHERE d.office = ? AND d.client_id = ? AND d.ativo = 1 AND pm.status IN ('enviado','fechado','fechado_externo')`, office, c.id);
  const fechados = n(`SELECT COUNT(*) AS n FROM payroll_months pm JOIN dctf_webs d ON d.id = pm.dctf_web_id
    WHERE d.office = ? AND d.client_id = ? AND d.ativo = 1 AND pm.status IN ('fechado','fechado_externo')`, office, c.id);
  const passos = [
    { key: 'client', titulo: 'Cadastro do cliente (dono da obra)', texto: 'O cliente é o empregador no eSocial.', done: true, url: `/clientes/${c.id}?guia=1` },
    { key: 'calculator', titulo: 'Simulação de obra predial', texto: 'Aferição indireta da obra (área × VAU) vinculada ao cliente.', done: !!predial, url: `/simuladores/obras-prediais/novo?cliente=${c.id}` },
    { key: 'esocial', titulo: 'Fator de ajuste eSocial', texto: 'Na simulação da obra predial, use "Simular em" > Fator de ajuste eSocial.', done: !!esocial, url: '/simuladores/obras-prediais' },
    { key: 'client_complete', titulo: 'Completar o cliente', texto: 'CPF, procuração eletrônica para o procurador do escritório, certificado do procurador e empregador (S-1000).', url: `/clientes/${c.id}?guia=1`,
      checks: [['CPF informado', soDigitos(c.documento).length === 11], ['Certificado do procurador selecionado', sp.certOk],
        ['Empregador cadastrado (recibo S-1000)', !!c.s1000_recibo], ['Procuração eletrônica informada (com datas, vigente)', sp.proc]] },
    { key: 'masons', titulo: 'Cadastrar autônomos', texto: 'Trabalhadores sem vínculo (S-2300) que atuaram na obra.', done: masons > 0, url: `/acompanhamento-de-obras/autonomos/cadastrar?client_id=${c.id}` },
    { key: 'construction', titulo: 'Cadastrar a obra', texto: 'Obra com CNO (S-1005), aferição selecionada e trabalhadores com datas.', url: obra ? `/obras/${obra.id}` : `/acompanhamento-de-obras/obras?cliente=${c.id}`,
      checks: [['Obra cadastrada', !!obra], ['Aferição de obra predial selecionada', !!obra?.calculator_id], ['Trabalhadores e datas informados', trab > 0]] },
    { key: 'dctfweb', titulo: 'Envio DCTFWeb', texto: 'Remuneração (S-1200) e pagamento (S-1210) das competências.', done: enviados > 0, url: dctf ? `/dctf-web/editar/${dctf.id}` : `/dctf-web/cadastrar?cliente=${c.id}` },
    { key: 'close_folha', titulo: 'Fechar folha', texto: 'Encerramento da folha (S-1299) - gera a DCTFWeb com a CPP da obra.', url: dctf ? `/dctf-web/editar/${dctf.id}#aba6` : '/dctf-web',
      checks: [['Folha encerrada', fechados > 0]] },
  ];
  for (const p of passos) if (p.checks) p.done = p.checks.every(x => x[1]);
  const feitos = passos.filter(p => p.done).length;
  const atual = passos.find(p => !p.done);
  if (atual) atual.current = true;
  return { passos, progress: { done: feitos, total: passos.length, percent: Math.round(feitos / passos.length * 100) }, atual };
}

module.exports = function registrar(app, { h, flash, contagens, exigirAdmin, clientesDo }) {
  const clienteDoEscritorio = (office, id) => (id && db.prepare('SELECT id FROM clients WHERE id = ? AND office = ? AND ativo = 1').get(Number(id), office) ? Number(id) : null);

  // ============================================================ certificados (do procurador)
  app.get('/cadastros/certificados', h((req, res) => {
    const rows = db.prepare('SELECT * FROM certificates WHERE office = ? AND ativo = 1 ORDER BY validade').all(req.office);
    const usos = id => db.prepare('SELECT COUNT(*) AS n FROM clients WHERE certificate_id = ? AND office = ? AND ativo = 1').get(id, req.office).n;
    const upload = (titulo, acao, sub = '') => html`<details class="card"><summary class="botao ${sub ? 'sec' : ''}">${titulo}</summary>
      <form method="post" action="${acao}" autocomplete="off"><div class="grade">
        ${sub ? campo('Certificado a substituir *', select('substituir', rows.map(ce => [ce.id, `${ce.titular} - ${ce.documento} (vence ${dataBr(ce.validade)})`]), '', 'required')) : ''}
        ${campo('Arquivo A1 do procurador (.pfx / .p12) *', html`<input type="file" accept=".pfx,.p12" class="ler-arquivo-b64" data-alvo="pfx${sub}" data-nome="nome${sub}" required>`)}
        ${campo('Senha do certificado *', html`<input type="password" name="senha" required autocomplete="new-password">`)}
      </div><input type="hidden" name="pfx_b64" id="pfx${sub}"><input type="hidden" name="arquivo_nome" id="nome${sub}">
      <div class="acoes"><button class="botao">Importar</button></div></form></details>`;
    res.send(layout(req, 'Certificados digitais', html`
      ${cert.cifraDisponivel() ? html`${upload('+ Importar certificado', '/cadastros/certificados')}${rows.length ? upload('Atualizar certificado', '/cadastros/certificados/atualizar', 'sub') : ''}`
        : html`<div class="aviso erro">Guarda de certificados não configurada no servidor (CERT_ENC_KEY). Avise o administrador.</div>`}
      <div class="grade-cards">${rows.map(ce => html`<div class="card cert">
        <b>${ce.titular}</b><span>${ce.documento.length === 14 ? 'e-CNPJ' : 'e-CPF'} ${ce.documento || '-'} · ${ce.emissor}</span>
        <div class="acoes-linha">${selo(cert.diasPara(ce.validade))}<small>Validade ${dataBr(ce.validade)}</small></div>
        <small>Usado por ${usos(ce.id)} cliente(s) com procuração</small>
        <form method="post" action="/cadastros/certificados/${ce.id}/excluir" data-confirmar="Excluir este certificado? O arquivo e a senha são apagados."><button class="link">Excluir</button></form>
      </div>`)}</div>${rows.length ? '' : html`<div class="card"><p class="desc">Nenhum certificado importado.</p></div>`}`,
    { descricao: 'Certificado A1 do procurador do escritório: transmite ao eSocial em nome dos clientes que deram procuração eletrônica. O arquivo e a senha ficam cifrados; o sistema avisa 30 dias antes do vencimento.', migalha: 'DCTF Web' }));
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
    db.prepare(`INSERT INTO certificates (office, titular, documento, emissor, validade, arquivo_nome, pfx_enc, senha_enc, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(req.office, up.info.titular, up.info.documento, up.info.emissor, up.info.validade,
      String(req.body.arquivo_nome || '').slice(0, 120), cert.cifrar(up.buf), cert.cifrar(Buffer.from(String(req.body.senha))), req.user.name, nowIso());
    const dias = cert.diasPara(up.info.validade);
    flash(res, `Certificado de ${up.info.titular} importado (validade ${dataBr(up.info.validade)}).`, dias < 0 ? 'erro' : dias <= AVISO_CERT_DIAS ? 'alerta' : 'ok');
    res.redirect('/cadastros/certificados');
  }));
  app.post('/cadastros/certificados/atualizar', h((req, res) => {
    const velho = db.prepare('SELECT * FROM certificates WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.body.substituir), req.office);
    if (!velho) throw erro404('Certificado não encontrado.');
    let up;
    try { up = lerUpload(req.body); } catch (e) { return voltaCert(res, e); }
    db.prepare('UPDATE certificates SET titular=?, documento=?, emissor=?, validade=?, arquivo_nome=?, pfx_enc=?, senha_enc=?, created_by=?, created_at=? WHERE id=?')
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

  // ============================================================ autônomos (S-2300)
  const AUTONOMO = ['name', 'document', 'birthday', 'phone', 'email', 'sex', 'skin', 'marital', 'scholarity', 'birth_country', 'country_nationality',
    'category', 'cbo', 'residence_time', 'entry_condition', 'address_zip_code', 'address', 'address_number', 'address_complement', 'address_district', 'address_city', 'address_municipality'];
  const carregarAutonomo = req => {
    const m = db.prepare('SELECT * FROM masons WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
    if (!m) throw erro404('Autônomo não encontrado.');
    return m;
  };
  function formAutonomo(req, m, acao) {
    const abas = [['a1', 'Dados Autônomo'], ['a2', 'Dados para eSocial'], ['a3', 'Endereço']];
    return html`<form method="post" action="${acao}" class="card">
      ${campo('Cliente (com quem o autônomo tem vínculo) *', select('client_id', [['', 'Selecione'], ...clientesDo(req.office).map(c => [c.id, c.nome])], m.client_id, 'required'))}
      <nav class="abas-form">${abas.map(([k, t], i) => html`<button type="button" data-aba="${k}" class="${i ? '' : 'ativo'}">${t}</button>`)}</nav>
      <section data-painel="a1"><div class="grade">
        ${campo('Nome *', inp('name', m.name, 'required'))}${campo('CPF *', inp('document', m.document, 'required inputmode="numeric"'))}
        ${campo('Nascimento', inp('birthday', m.birthday, 'type="date"'))}${campo('Telefone', inp('phone', m.phone))}${campo('E-mail', inp('email', m.email, 'type="email"'))}
      </div></section>
      <section data-painel="a2" hidden><div class="grade">
        ${campo('Sexo', select('sex', SEXO, m.sex))}
        ${campo('Raça/cor (japonesa, chinesa, coreana = Amarela)', select('skin', RACA, m.skin))}
        ${campo('Estado civil', select('marital', EST_CIVIL, m.marital))}
        ${campo('Grau de instrução', select('scholarity', INSTRUCAO, m.scholarity))}
        ${campo('País de nascimento (código)', inp('birth_country', m.birth_country ?? '105'))}
        ${campo('País de nacionalidade (código; 105 = Brasil)', inp('country_nationality', m.country_nationality ?? '105'))}
        ${campo('Categoria eSocial (701 = contribuinte individual autônomo)', inp('category', m.category ?? '701'))}
        ${campo('CBO (ex.: 710205 mestre de obras)', inp('cbo', m.cbo ?? '710205'))}
        ${campo('Tempo de residência (estrangeiro)', select('residence_time', [['', '-'], ['1', '1 - Prazo indeterminado'], ['2', '2 - Prazo determinado']], m.residence_time))}
        ${campo('Condição de ingresso (estrangeiro)', inp('entry_condition', m.entry_condition))}
      </div></section>
      <section data-painel="a3" hidden><div class="grade">
        ${campo('CEP', inp('address_zip_code', m.address_zip_code))}${campo('Logradouro', inp('address', m.address))}${campo('Número', inp('address_number', m.address_number))}
        ${campo('Complemento', inp('address_complement', m.address_complement))}${campo('Bairro', inp('address_district', m.address_district))}
        ${campo('Cidade', inp('address_city', m.address_city))}${campo('Código do município (IBGE)', inp('address_municipality', m.address_municipality))}
      </div></section>
      <div class="acoes"><button class="botao">Salvar</button><a class="botao sec" href="/acompanhamento-de-obras/autonomos">Voltar</a></div></form>`;
  }
  const lerAutonomo = (req, b) => {
    const v = Object.fromEntries(AUTONOMO.map(k => [k, String(b[k] ?? '').trim()]));
    v.document = soDigitos(v.document);
    return { v, client_id: clienteDoEscritorio(req.office, b.client_id) };
  };
  const validaAutonomo = ({ v, client_id }) => (!client_id ? 'Escolha o cliente.' : !v.name ? 'Informe o nome.' : v.document.length !== 11 ? 'CPF do autônomo deve ter 11 dígitos.' : '');

  app.get('/acompanhamento-de-obras/autonomos', h((req, res) => {
    const rows = db.prepare(`SELECT m.*, c.nome AS cliente FROM masons m JOIN clients c ON c.id = m.client_id WHERE m.office = ? AND m.ativo = 1 ORDER BY m.name`).all(req.office);
    const opc = clientesDo(req.office).map(c => [c.id, c.nome]);
    res.send(layout(req, 'Autônomos', html`${contadores(contagens('masons', req.office, 'AND ativo = 1'))}
      <div class="acoes"><a class="botao" href="/acompanhamento-de-obras/autonomos/cadastrar">+ Cadastrar autônomo</a></div>
      ${tabela(['Nome do autônomo', 'Cliente', 'Documento', 'Idade', 'Ações'], rows.map(m => [m.name, m.cliente, m.document, idade(m.birthday),
        html`<span class="acoes-linha"><a href="/acompanhamento-de-obras/autonomos/editar/${m.id}">Editar</a>
          <form method="post" action="/acompanhamento-de-obras/autonomos/${m.id}/duplicar" class="inline">${select('client_id', opc, '', 'aria-label="Duplicar para o cliente"')}<button class="link">Duplicar</button></form>
          <form method="post" action="/acompanhamento-de-obras/autonomos/${m.id}/desativar" data-confirmar="Desativar este autônomo?"><button class="link">Desativar</button></form></span>`]))}`,
    { descricao: 'Trabalhadores sem vínculo (TSVE, S-2300) que atuaram nas obras dos clientes.', migalha: 'DCTF Web' }));
  }));
  app.get('/acompanhamento-de-obras/autonomos/cadastrar', h((req, res) => {
    res.send(layout(req, 'Cadastrar autônomo', formAutonomo(req, { client_id: req.query.client_id }, '/acompanhamento-de-obras/autonomos/cadastrar'), { migalha: 'DCTF Web / Autônomos' }));
  }));
  app.post('/acompanhamento-de-obras/autonomos/cadastrar', h((req, res) => {
    const a = lerAutonomo(req, req.body), e = validaAutonomo(a);
    if (e) { req.flash = { msg: e, tipo: 'erro' }; return res.status(422).send(layout(req, 'Cadastrar autônomo', formAutonomo(req, { ...a.v, client_id: a.client_id }, req.path), { migalha: 'DCTF Web / Autônomos' })); }
    db.prepare(`INSERT INTO masons (office, client_id, ${AUTONOMO.join(', ')}, created_at) VALUES (?,?,${AUTONOMO.map(() => '?').join(',')},?)`)
      .run(req.office, a.client_id, ...AUTONOMO.map(k => a.v[k]), nowIso());
    flash(res, 'Autônomo cadastrado.');
    res.redirect(req.query.guia ? `/guia-de-envio/${a.client_id}` : '/acompanhamento-de-obras/autonomos');
  }));
  app.get('/acompanhamento-de-obras/autonomos/editar/:id', h((req, res) => {
    const m = carregarAutonomo(req);
    res.send(layout(req, `Autônomo ${m.name}`, formAutonomo(req, m, req.path), { migalha: 'DCTF Web / Autônomos' }));
  }));
  app.post('/acompanhamento-de-obras/autonomos/editar/:id', h((req, res) => {
    const m = carregarAutonomo(req);
    const a = lerAutonomo(req, req.body), e = validaAutonomo(a);
    if (e) { req.flash = { msg: e, tipo: 'erro' }; return res.status(422).send(layout(req, `Autônomo ${m.name}`, formAutonomo(req, { ...a.v, client_id: a.client_id }, req.path))); }
    db.prepare(`UPDATE masons SET client_id = ?, ${AUTONOMO.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(a.client_id, ...AUTONOMO.map(k => a.v[k]), m.id);
    flash(res, 'Autônomo salvo.');
    res.redirect('/acompanhamento-de-obras/autonomos');
  }));
  app.post('/acompanhamento-de-obras/autonomos/:id/duplicar', h((req, res) => {
    const m = carregarAutonomo(req);
    const cli = clienteDoEscritorio(req.office, req.body.client_id);
    if (!cli) { flash(res, 'Escolha o cliente para duplicar.', 'erro'); return res.redirect('/acompanhamento-de-obras/autonomos'); }
    db.prepare(`INSERT INTO masons (office, client_id, ${AUTONOMO.join(', ')}, created_at) VALUES (?,?,${AUTONOMO.map(() => '?').join(',')},?)`)
      .run(req.office, cli, ...AUTONOMO.map(k => m[k]), nowIso());
    flash(res, `${m.name} duplicado para o outro cliente.`);
    res.redirect('/acompanhamento-de-obras/autonomos');
  }));
  app.post('/acompanhamento-de-obras/autonomos/:id/desativar', h((req, res) => {
    const m = carregarAutonomo(req);
    db.prepare('UPDATE masons SET ativo = 0 WHERE id = ?').run(m.id);
    flash(res, 'Autônomo desativado.');
    res.redirect('/acompanhamento-de-obras/autonomos');
  }));

  // ============================================================ obra (S-1005)
  const STATUS_OBRA = ['Em andamento', 'Concluída', 'Paralisada'];
  const carregarObra = req => {
    const w = db.prepare('SELECT * FROM works WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
    if (!w) throw erro404('Obra não encontrada.');
    return w;
  };
  const trabalhadoresDa = workId => db.prepare(`SELECT wm.*, m.name, m.document FROM work_masons wm JOIN masons m ON m.id = wm.mason_id
    WHERE wm.work_id = ? AND m.ativo = 1 ORDER BY m.name`).all(workId);

  function formObra(req, w, acao) {
    const cliId = Number(w.client_id) || null;
    const afericoes = db.prepare("SELECT id, identifier, created_at FROM simulations WHERE office = ? AND kind = 'predial' AND ativo = 1 AND (? IS NULL OR client_id = ?) ORDER BY id DESC")
      .all(req.office, cliId, cliId);
    const masons = cliId ? db.prepare('SELECT id, name FROM masons WHERE office = ? AND client_id = ? AND ativo = 1 ORDER BY name').all(req.office, cliId) : [];
    const trab = w.id ? trabalhadoresDa(w.id) : [];
    const linhaTrab = t => html`<div class="linha-rep">${campo('Autônomo', select('mason_id', [['', 'Selecione'], ...masons.map(m => [m.id, m.name])], t.mason_id))}
      ${campo('Início', inp('mason_start', t.start_date, 'type="date"'))}${campo('Fim', inp('mason_end', t.end_date, 'type="date"'))}
      <button type="button" class="botao sec pequeno remover-linha" aria-label="Remover trabalhador">✕</button></div>`;
    const linhaPar = p => html`<div class="linha-rep">${campo('Paralisada de', inp('par_ini', p.inicio, 'type="date"'))}${campo('até', inp('par_fim', p.fim, 'type="date"'))}
      <button type="button" class="botao sec pequeno remover-linha" aria-label="Remover paralisação">✕</button></div>`;
    return html`<form method="post" action="${acao}" class="card">
    <h3 class="primeiro">Identificação</h3><div class="grade">
      ${campo('Cliente *', select('client_id', [['', 'Selecione'], ...clientesDo(req.office).map(c => [c.id, c.nome])], w.client_id, 'required'))}
      ${campo('Nome da obra', inp('custom_name', w.custom_name, 'placeholder="Ex.: Rua X Q18 L37"'))}
      ${campo('Aferição de obra predial (simulação)', select('calculator_id', [['', '- selecione -'], ...afericoes.map(a => [a.id, `#${a.id} ${a.identifier || ''} (${dataBr(a.created_at)})`])], w.calculator_id))}
    </div><h3>Inscrição</h3><div class="grade g4">
      ${campo('Tipo de inscrição', select('registration_type', ['CNO'], w.registration_type))}
      ${campo('CNO', inp('cno', w.cno, 'placeholder="00.000.00000/00"'))}
      ${campo('Cadastro imobiliário (IPTU)', inp('real_estate_registration', w.real_estate_registration))}
      ${campo('CNAE', inp('cnae', w.cnae ?? '4120400'))}
    </div><h3>Alvará e habite-se</h3><div class="grade g4">
      ${campo('Possui alvará?', simNao('has_construction_permit', w.has_construction_permit))}${campo('Data do alvará', inp('date_construction_permit', w.date_construction_permit, 'type="date"'))}
      ${campo('Possui habite-se?', simNao('has_habitese', w.has_habitese))}${campo('Data do habite-se', inp('date_habitese', w.date_habitese, 'type="date"'))}
    </div><h3>Período e situação</h3><div class="grade g4">
      ${campo('Início', inp('data_inicio', w.data_inicio, 'type="date"'))}${campo('Término', inp('data_fim', w.data_fim, 'type="date"'))}
      ${campo('Área (m²)', inp('area', w.area ?? '', 'inputmode="decimal"'))}${campo('Situação', select('status', STATUS_OBRA, w.status))}
    </div><h3>Endereço da obra</h3><div class="grade g4">
      ${campo('CEP', inp('cep', w.cep))}${campo('Rua', inp('endereco', w.endereco))}${campo('Número', inp('numero', w.numero))}${campo('Complemento', inp('complemento', w.complemento))}
      ${campo('Bairro', inp('bairro', w.bairro))}${campo('Cidade', inp('municipio', w.municipio))}${campo('UF', select('uf', ['', ...UFS], w.uf))}
    </div>
    <h3>Trabalhadores da obra</h3>${cliId ? '' : html`<p class="desc">Salve a obra com o cliente para escolher os autônomos dele.</p>`}
    <div class="repetidor">${trab.map(linhaTrab)}</div><template id="modeloTrab">${linhaTrab({})}</template>
    <button type="button" class="botao sec pequeno adicionar-linha" data-alvo="modeloTrab">+ Adicionar trabalhador</button>
    <h3>Paralisações</h3>
    <div class="repetidor">${JSON.parse(w.stoppages_json || '[]').map(linhaPar)}</div><template id="modeloPar">${linhaPar({})}</template>
    <button type="button" class="botao sec pequeno adicionar-linha" data-alvo="modeloPar">+ Adicionar paralisação</button>
    ${campo('Observações', html`<textarea name="obs" rows="2">${w.obs || ''}</textarea>`, 'largo')}
    <div class="acoes"><button class="botao">Salvar</button></div></form>`;
  }
  const arr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  function salvarObra(req, b, id) {
    const cli = clienteDoEscritorio(req.office, b.client_id);
    if (!cli) return null;
    const afer = b.calculator_id && db.prepare("SELECT id FROM simulations WHERE id = ? AND office = ? AND kind = 'predial'").get(Number(b.calculator_id), req.office);
    const par = arr(b.par_ini).map((ini, i) => ({ inicio: ini, fim: arr(b.par_fim)[i] || '' })).filter(p => p.inicio);
    const v = [cli, afer ? afer.id : null, b.custom_name || '', b.registration_type || 'CNO', b.cno || '', b.real_estate_registration || '', b.cnae || '',
      b.has_construction_permit === '1' ? 1 : 0, b.date_construction_permit || '', b.has_habitese === '1' ? 1 : 0, b.date_habitese || '',
      calc.num(b.area) || null, b.data_inicio || '', b.data_fim || '', STATUS_OBRA.includes(b.status) ? b.status : 'Em andamento',
      b.cep || '', b.endereco || '', b.numero || '', b.complemento || '', b.bairro || '', b.municipio || '', UFS.includes(b.uf) ? b.uf : '', JSON.stringify(par), b.obs || ''];
    const cols = 'client_id, calculator_id, custom_name, registration_type, cno, real_estate_registration, cnae, has_construction_permit, date_construction_permit, has_habitese, date_habitese, area, data_inicio, data_fim, status, cep, endereco, numero, complemento, bairro, municipio, uf, stoppages_json, obs';
    if (id) db.prepare(`UPDATE works SET ${cols.split(', ').map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...v, id);
    else id = db.prepare(`INSERT INTO works (office, ${cols}, created_at) VALUES (?, ${cols.split(', ').map(() => '?').join(', ')}, ?)`).run(req.office, ...v, nowIso()).lastInsertRowid;
    // trabalhadores: só autônomos do próprio cliente
    db.prepare('DELETE FROM work_masons WHERE work_id = ?').run(id);
    const ins = db.prepare('INSERT OR REPLACE INTO work_masons (work_id, mason_id, start_date, end_date) VALUES (?,?,?,?)');
    arr(b.mason_id).forEach((mid, i) => {
      const m = mid && db.prepare('SELECT id FROM masons WHERE id = ? AND office = ? AND client_id = ? AND ativo = 1').get(Number(mid), req.office, cli);
      if (m) ins.run(id, m.id, arr(b.mason_start)[i] || null, arr(b.mason_end)[i] || null);
    });
    return id;
  }

  app.get('/acompanhamento-de-obras/obras', h((req, res) => {
    const filtro = Number(req.query.cliente) || null;
    const rows = db.prepare(`SELECT w.*, c.nome AS cliente, (SELECT COUNT(*) FROM work_masons wm WHERE wm.work_id = w.id) AS trab FROM works w JOIN clients c ON c.id = w.client_id
      WHERE w.office = ? AND w.ativo = 1 ${filtro ? 'AND w.client_id = ?' : ''} ORDER BY w.id DESC`).all(req.office, ...(filtro ? [filtro] : []));
    res.send(layout(req, 'Obras (CNO)', html`${contadores(contagens('works', req.office, 'AND ativo = 1'))}
      <details class="card" ${filtro ? 'open' : ''}><summary class="botao">+ Cadastrar obra</summary>${formObra(req, { client_id: filtro }, '/acompanhamento-de-obras/obras')}</details>
      ${tabela(['Obra', 'Cliente', 'CNO', 'Cidade/UF', 'Trabalhadores', 'Aferição', 'Situação', 'Ações'], rows.map(w => [w.custom_name || w.endereco, w.cliente, w.cno,
        [w.municipio, w.uf].filter(Boolean).join('/'), w.trab, w.calculator_id ? html`<a href="/simulacoes/${w.calculator_id}">#${w.calculator_id}</a>` : '-', w.status,
        html`<span class="acoes-linha"><a href="/obras/${w.id}">Editar</a><a href="/dctf-web/cadastrar?cliente=${w.client_id}&obra=${w.id}">Envio DCTFWeb</a>
        <form method="post" action="/obras/${w.id}/desativar" data-confirmar="Desativar esta obra?"><button class="link">Desativar</button></form></span>`]))}`,
    { descricao: 'Obras dos clientes (estabelecimento S-1005) com CNO, aferição, trabalhadores e paralisações.', migalha: 'DCTF Web' }));
  }));
  app.post('/acompanhamento-de-obras/obras', h((req, res) => {
    const id = salvarObra(req, req.body);
    if (!id) { flash(res, 'Escolha o cliente da obra.', 'erro'); return res.redirect('/acompanhamento-de-obras/obras'); }
    flash(res, 'Obra cadastrada. Agora inclua os trabalhadores.');
    res.redirect(`/obras/${id}`);
  }));
  app.get('/obras/:id', h((req, res) => {
    const w = carregarObra(req);
    res.send(layout(req, w.custom_name || `Obra ${w.cno || '#' + w.id}`, formObra(req, w, `/obras/${w.id}`), { migalha: 'DCTF Web / Obras' }));
  }));
  app.post('/obras/:id', h((req, res) => {
    const w = carregarObra(req);
    if (!salvarObra(req, req.body, w.id)) { flash(res, 'Escolha o cliente da obra.', 'erro'); return res.redirect(`/obras/${w.id}`); }
    flash(res, 'Obra salva.');
    res.redirect(`/obras/${w.id}`);
  }));
  app.post('/obras/:id/desativar', h((req, res) => {
    const w = carregarObra(req);
    db.prepare('UPDATE works SET ativo = 0 WHERE id = ?').run(w.id);
    flash(res, 'Obra desativada.');
    res.redirect('/acompanhamento-de-obras/obras');
  }));

  // ============================================================ envio DCTFWeb
  const carregarDctf = req => {
    const d = db.prepare('SELECT * FROM dctf_webs WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.id), req.office);
    if (!d) throw erro404('Envio DCTFWeb não encontrado.');
    return d;
  };
  const mesesDe = dId => db.prepare('SELECT * FROM payroll_months WHERE dctf_web_id = ? ORDER BY competencia').all(dId)
    .map(m => ({ ...m, items: db.prepare('SELECT pi.*, ms.name FROM payroll_items pi LEFT JOIN masons ms ON ms.id = pi.mason_id WHERE payroll_month_id = ? ORDER BY pi.id').all(m.id) }));

  // dados derivados do envio: obra, aferição, fator de ajuste e quadro de cálculo
  function contexto(req, d) {
    const P = paramReader(req.office);
    const cli = db.prepare('SELECT * FROM clients WHERE id = ?').get(d.client_id);
    const obra = d.work_id && db.prepare('SELECT * FROM works WHERE id = ?').get(d.work_id);
    const afer = obra?.calculator_id && db.prepare('SELECT * FROM simulations WHERE id = ?').get(obra.calculator_id);
    const es = d.esocial_id && db.prepare('SELECT * FROM simulations WHERE id = ?').get(d.esocial_id);
    const esR = es ? JSON.parse(es.result_json) : null;
    const aferR = afer ? JSON.parse(afer.result_json) : null;
    const meses = mesesDe(d.id);
    const inicio = d.construction_init_date || obra?.data_inicio || '';
    const fim = d.construction_end_date || obra?.data_fim || '';
    const rmt = esR?.rmt || aferR?.rmt || 0;
    const alvo = esR?.minimo_valor || rmt;
    // meses sem atividade: os marcados como paralisados na folha + as paralisações da obra
    const paralisados = new Set(meses.filter(m => m.is_paralyzed).map(m => m.competencia));
    for (const p of JSON.parse(obra?.stoppages_json || '[]')) {
      if (p.inicio) for (const c of calc.mesesEntre(p.inicio.slice(0, 7), (p.fim || p.inicio).slice(0, 7))) paralisados.add(c);
    }
    const calculadoMensal = folha.valorCalculadoMensal({ alvo, inicio, fim: fim || new Date().toISOString().slice(0, 10), paralisados: [...paralisados] });
    let q = null, erroQ = '';
    try {
      q = folha.quadro({ meses, calculadoMensal, rmtBase: folha.rmtNaoDecadente({ rmt, inicio, fim, anos: P.get('decadencia', 'Prazo decadencial (anos)') ?? 5, hoje: new Date() }) }, P);
    } catch (e) { if (e instanceof calc.CalcError) erroQ = e.message; else throw e; }
    return { P, cli, obra, afer, aferR, es, esR, meses, inicio, fim, rmt, calculadoMensal, q, erroQ, sp: situacaoProcuracao(cli) };
  }

  const SQL_LISTA = `SELECT d.*, c.nome AS cliente, w.cno, w.custom_name, w.endereco, s.identifier AS esocial_ident FROM dctf_webs d JOIN clients c ON c.id = d.client_id
    LEFT JOIN works w ON w.id = d.work_id LEFT JOIN simulations s ON s.id = d.esocial_id WHERE d.office = ? AND d.ativo = 1`;
  app.get('/dctf-web', h((req, res) => {
    const q = req.query;
    const cond = [], args = [req.office];
    if (STATUS_DCTF.some(s => s[0] === q.status)) { cond.push('d.status = ?'); args.push(q.status); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.de || '')) { cond.push('d.last_sent_at >= ?'); args.push(q.de); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.ate || '')) { cond.push('d.last_sent_at < ?'); args.push(`${q.ate}T99`); }
    const rows = db.prepare(`${SQL_LISTA} ${cond.map(c => 'AND ' + c).join(' ')} ORDER BY d.last_sent_at IS NULL, d.last_sent_at DESC, d.id DESC`).all(...args);
    res.send(layout(req, 'Envios DCTFWeb', html`${contadores(contagens('dctf_webs', req.office, 'AND ativo = 1'))}
      <form class="card filtros" method="get"><div class="grade">
        ${campo('Status', select('status', [['', 'Todos'], ...STATUS_DCTF], q.status))}
        ${campo('Último envio de', html`<input type="date" name="de" value="${q.de || ''}">`)}
        ${campo('até', html`<input type="date" name="ate" value="${q.ate || ''}">`)}
      </div><div class="acoes"><button class="botao sec">Filtrar</button><a class="botao" href="/dctf-web/cadastrar">+ Cadastrar DCTFWeb</a>
        <a class="botao sec" href="https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cno" target="_blank" rel="noopener">Emitir CND</a></div></form>
      ${tabela(['ID', 'Cliente', 'Obra', 'Identificador (CNO)', 'eSocial', 'Status', 'Último envio', 'Competência', 'Ações'], rows.map(d => [d.id, d.cliente,
        d.work_id ? html`<a href="/obras/${d.work_id}">${d.custom_name || d.endereco || '#' + d.work_id}</a>` : '-', d.cno, d.esocial_id ? html`<a href="/simulacoes/${d.esocial_id}">#${d.esocial_id}</a>` : '-',
        html`<span class="selo">${rotuloStatus(d.status)}</span>`, dataHoraBr(d.last_sent_at), d.last_competencia,
        html`<span class="acoes-linha"><a href="/dctf-web/editar/${d.id}">Editar</a><a href="/dctf-web/visualizar/${d.id}">Relatório</a></span>`]))}`,
    { descricao: 'Envio eSocial da obra de pessoa física: obra, rubrica, lotação, remuneração mensal dos autônomos e fechamento da folha.', migalha: 'DCTF Web' }));
  }));

  // clientes que podem ter envio: com procuração e certificado do procurador
  const clientesAptos = office => db.prepare('SELECT * FROM clients WHERE office = ? AND ativo = 1 ORDER BY nome').all(office).filter(c => situacaoProcuracao(c).ok);

  app.get('/dctf-web/cadastrar', h((req, res) => {
    const aptos = clientesAptos(req.office);
    const cli = Number(req.query.cliente) || '';
    const obras = cli ? db.prepare('SELECT id, custom_name, cno, endereco FROM works WHERE office = ? AND client_id = ? AND ativo = 1').all(req.office, cli) : [];
    const esociais = cli ? db.prepare("SELECT id, identifier FROM simulations WHERE office = ? AND client_id = ? AND kind = 'esocial' AND ativo = 1 ORDER BY id DESC").all(req.office, cli) : [];
    const naoApto = cli && !aptos.some(c => c.id === cli);
    res.send(layout(req, 'Cadastrar DCTFWeb', html`
      ${naoApto ? html`<div class="aviso erro">Este cliente ainda não tem procuração eletrônica vigente e certificado do procurador válido. <a href="/clientes/${cli}?guia=1">Completar o cliente</a></div>` : ''}
      <form method="get" class="card"><div class="grade">${campo('Cliente * (apenas com procuração e certificado do procurador)', select('cliente', [['', 'Selecione'], ...aptos.map(c => [c.id, c.nome])], cli, 'onchange="this.form.submit()"'))}</div></form>
      ${cli && !naoApto ? html`<form method="post" class="card"><input type="hidden" name="client_id" value="${cli}"><div class="grade">
        ${campo('Obra *', select('work_id', [['', 'Selecione'], ...obras.map(o => [o.id, `${o.custom_name || o.endereco || 'Obra'} - CNO ${o.cno || '?'}`])], req.query.obra, 'required'))}
        ${campo('eSocial (simulação de fator de ajuste) *', select('esocial_id', [['', 'Selecione'], ...esociais.map(s => [s.id, `#${s.id} ${s.identifier || ''}`])], '', 'required'))}
      </div>${!obras.length || !esociais.length ? html`<p class="desc">Falta ${!obras.length ? html`<a href="/acompanhamento-de-obras/obras?cliente=${cli}">cadastrar a obra</a>` : ''} ${!esociais.length ? html`<a href="/simuladores/obras-prediais">a simulação de fator de ajuste eSocial</a>` : ''}.</p>` : ''}
        <div class="acoes"><button class="botao">Cadastrar</button></div></form>` : ''}`, { migalha: 'DCTF Web / Envios' }));
  }));
  app.post('/dctf-web/cadastrar', h((req, res) => {
    const b = req.body;
    const cli = clienteDoEscritorio(req.office, b.client_id);
    const c = cli && db.prepare('SELECT * FROM clients WHERE id = ?').get(cli);
    if (!c || !situacaoProcuracao(c).ok) { flash(res, 'Cliente sem procuração vigente ou sem certificado do procurador.', 'erro'); return res.redirect('/dctf-web/cadastrar'); }
    const w = db.prepare('SELECT * FROM works WHERE id = ? AND office = ? AND client_id = ? AND ativo = 1').get(Number(b.work_id), req.office, cli);
    const es = db.prepare("SELECT id FROM simulations WHERE id = ? AND office = ? AND client_id = ? AND kind = 'esocial'").get(Number(b.esocial_id), req.office, cli);
    if (!w || !es) { flash(res, 'Escolha a obra e a simulação de fator de ajuste eSocial do cliente.', 'erro'); return res.redirect(`/dctf-web/cadastrar?cliente=${cli}`); }
    const r = db.prepare(`INSERT INTO dctf_webs (office, client_id, work_id, esocial_id, construction_init_date, construction_end_date, rubric_code, rubric_description,
      rubric_validity, tax_allocation_code, tax_allocation_validity, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.office, cli, w.id, es.id, w.data_inicio || null, w.data_fim || null, '1', 'Remuneração por prestação de serviço', (w.data_inicio || '').slice(0, 7) || null,
        '1', (w.data_inicio || '').slice(0, 7) || null, req.user.name, nowIso());
    flash(res, 'Envio cadastrado. Confira as abas e adicione os meses da folha.');
    res.redirect(`/dctf-web/editar/${r.lastInsertRowid}`);
  }));

  function telaDctf(req, res, d) {
    const x = contexto(req, d);
    const obras = db.prepare('SELECT id, custom_name, cno, endereco FROM works WHERE office = ? AND client_id = ? AND ativo = 1').all(req.office, d.client_id);
    const esociais = db.prepare("SELECT id, identifier FROM simulations WHERE office = ? AND client_id = ? AND kind = 'esocial' AND ativo = 1 ORDER BY id DESC").all(req.office, d.client_id);
    const trab = d.work_id ? trabalhadoresDa(d.work_id) : [];
    const fech = JSON.parse(d.fechamento_json || '{}');
    const abas = [['aba1', '1. Cliente'], ['aba2', '2. Estabelecimento/Obra'], ['aba3', '3. Rubrica'], ['aba4', '4. Lotação'], ['aba5', '5. Remuneração e pagamento'], ['aba6', '6. Fechar folha']];
    const o = x.obra || {};
    const info = (r, v) => html`<div><small>${r}</small><b>${v || '-'}</b></div>`;
    const ultimoMes = x.meses.length ? x.meses[x.meses.length - 1].competencia : (x.inicio || '').slice(0, 7);
    const linhaItem = (i, mid) => html`<tr class="linha-rep">
      <td data-label="Autônomo">${select('item_mason', [['', 'Selecione'], ...trab.map(t => [t.mason_id, t.name])], i.mason_id, 'aria-label="Autônomo"')}</td>
      <td data-label="Número">${inp('item_iddmdev', i.id_dm_dev, 'class="curto" aria-label="Número"')}</td>
      <td data-label="Valor (base)">${inp('item_valor', i.calc_base ? n2(i.calc_base) : '', 'inputmode="decimal" class="curto" aria-label="Valor"')}</td>
      <td data-label="Pagamento">${inp('item_pagto', i.payment_date, 'type="date" aria-label="Data de pagamento"')}</td>
      <td data-label="Recibos" class="recibos">${inp('item_rec1200', i.nr_rec_1200, 'class="medio" placeholder="recibo S-1200" aria-label="Recibo S-1200"')}${inp('item_rec1210', i.nr_rec_1210, 'class="medio" placeholder="recibo S-1210" aria-label="Recibo S-1210"')}</td>
      <td class="acao-linha"><button type="button" class="botao sec pequeno remover-linha" aria-label="Remover linha">✕ <span>Remover</span></button></td></tr>`;

    const bloqueio = !x.sp.ok ? html`<div class="aviso erro">Envio ao eSocial bloqueado: ${!x.sp.proc ? 'procuração eletrônica não informada ou vencida' : 'certificado do procurador inválido ou vencido'}. <a href="/clientes/${d.client_id}?guia=1">Completar o cliente</a></div>` : '';
    res.send(layout(req, `DCTFWeb #${d.id} - ${x.cli.nome}`, html`${bloqueio}
      ${d.status === 'cancelado' ? html`<div class="aviso alerta">Envio cancelado em ${dataHoraBr(d.canceled_at)}: ${d.cancel_reason}</div>` : ''}
      <div class="dctf-grade">
      <aside class="card lateral-dctf">
        <div class="lado-info"><div><b>#${d.id}</b> <small>${x.cli.nome}</small></div>
          ${x.sp.cert ? html`<div class="cert-mini"><small>Certificado do procurador</small><b>${x.sp.cert.titular}</b>${selo(cert.diasPara(x.sp.cert.validade))}</div>` : ''}
          <small class="desc">eSocial: ${req.officeRow.esocial_ambiente === 'producao' ? 'Produção' : 'Produção restrita (testes)'}</small></div>
        <div class="lado-botoes">
          <button class="botao" form="formDctf">Salvar</button>
          <button class="botao sec" form="formDctf" name="marcar" value="1" title="Marca os meses em rascunho para envio">Salvar e marcar para envio</button>
          <form method="post" action="/dctf-web/${d.id}/lembretes"><button class="botao sec">${d.lembretes ? '🔔 Desativar lembretes' : '🔕 Ativar lembretes'}</button></form>
          <a class="botao sec" href="/dctf-web/visualizar/${d.id}">Relatório</a>
          <a class="botao sec" href="/dctf-web">Voltar</a>
          ${d.status !== 'cancelado' ? html`<form method="post" action="/dctf-web/${d.id}/cancelar" data-pedir="Motivo do cancelamento:"><input type="hidden" name="cancel_reason"><button class="botao sec perigo">Cancelar envio</button></form>` : ''}
        </div>
        <p class="desc pequeno nota">A transmissão automática ao eSocial ainda não está ligada: transmita no eSocial/e-CAC e registre os recibos aqui.</p>
      </aside>
      <div>
      <nav class="abas-form">${abas.map(([k, t], i) => html`<button type="button" data-aba="${k}" class="${i ? '' : 'ativo'}">${t}</button>`)}</nav>
      <form method="post" action="/dctf-web/editar/${d.id}" id="formDctf">
      <section data-painel="aba1" class="card"><div class="grade">
        ${campo('Cliente', html`<input value="${x.cli.nome}" disabled>`)}
        ${campo('Obra *', select('work_id', obras.map(w => [w.id, `${w.custom_name || w.endereco || 'Obra'} - CNO ${w.cno || '?'}`]), d.work_id))}
        ${campo('eSocial (fator de ajuste) *', select('esocial_id', esociais.map(s => [s.id, `#${s.id} ${s.identifier || ''}`]), d.esocial_id))}
        ${campo('Status', select('status', STATUS_DCTF, d.status))}
      </div><div class="card info fixo">${info('Registro eletrônico de ponto', '0 - Não optou')}${info('Desoneração da folha', '0 - Não aplicável')}${info('PIS/Cofins', 'Não')}${info('Recibo S-1000', x.cli.s1000_recibo)}</div></section>

      <section data-painel="aba2" class="card" hidden>
        ${campo('Deseja cadastrar essa obra no eSocial? (S-1005)', simNao('send1005', d.send1005))}
        <div class="card info fixo">${info('Tipo de inscrição', o.registration_type || 'CNO')}${info('CNO', o.cno)}${info('IPTU', o.real_estate_registration)}
          ${info('Endereço', [o.endereco, o.numero, o.bairro, o.municipio, o.uf].filter(Boolean).join(', '))}${info('CNAE', o.cnae)}
          ${info('Alvará', o.has_construction_permit ? dataBr(o.date_construction_permit) || 'Sim' : 'Não')}${info('Habite-se', o.has_habitese ? dataBr(o.date_habitese) || 'Sim' : 'Não')}
          ${info('Paralisações', JSON.parse(o.stoppages_json || '[]').map(p => `${dataBr(p.inicio)} a ${dataBr(p.fim)}`).join('; '))}</div>
        <div class="grade">
          ${campo(`Data de início da obra * (mínimo ${dataBr(DATA_MIN_OBRA(x.P))})`, inp('construction_init_date', d.construction_init_date, `type="date" min="${DATA_MIN_OBRA(x.P)}" required`))}
          ${campo('Data do fim', inp('construction_end_date', d.construction_end_date, 'type="date"'))}</div>
        ${x.aferR ? html`<div class="card info fixo">${info('Aferição', html`<a href="/simulacoes/${x.afer.id}">#${x.afer.id}</a>`)}
          ${info('Destinação / material', x.aferR.linhas.map(l => `${l.destinacao} / ${l.tipo_obra}`).join('; '))}
          ${info('Concreto usinado', x.aferR.linhas.some(l => l.red_concreto) ? 'Sim' : 'Não')}${info('Referência do VAU', x.aferR.referencia)}
          ${info('Área', `${n2(x.aferR.area_total)} m²`)}${info('Área de equivalência', `${n2(x.aferR.linhas.reduce((s, l) => s + l.area, 0))} m²`)}
          ${info('VAU utilizado', x.aferR.linhas.map(l => brl(l.vau)).join('; '))}${info('RMT', brl(x.aferR.rmt))}</div>` : html`<p class="desc">A obra não tem aferição de obra predial selecionada.</p>`}
      </section>

      <section data-painel="aba3" class="card" hidden><div class="grade">
        ${campo('Envio S-1010', select('send1010', [['inclusao', 'INCLUSÃO (primeiro envio)'], ['alteracao', 'ALTERAÇÃO']], d.send1010))}
        ${campo('Código da rubrica', inp('rubric_code', d.rubric_code))}${campo('Data de validade', inp('rubric_validity', d.rubric_validity, 'type="month"'))}
        ${campo('Descrição', inp('rubric_description', d.rubric_description))}${campo('IRRF', select('irrf', IRRF, d.irrf))}
      </div><div class="card info fixo">${info('Natureza', '3501 - Remuneração por prestação de serviço')}${info('Tipo', '1 - Vencimento/Provento')}
        ${info('Incidência INSS', '13')}${info('Incidência IRRF', '11')}${info('FGTS', '00 - Não é base')}</div></section>

      <section data-painel="aba4" class="card" hidden><div class="grade">
        ${campo('Envio S-1020', select('send1020', [['inclusao', 'INCLUSÃO (primeiro envio)'], ['alteracao', 'ALTERAÇÃO']], d.send1020))}
        ${campo('Código da lotação', inp('tax_allocation_code', d.tax_allocation_code))}${campo('Data de validade', inp('tax_allocation_validity', d.tax_allocation_validity, 'type="month"'))}
      </div><div class="card info fixo">${info('Tipo de lotação', '21 - Obra própria de construção civil de PF')}${info('FPAS', '507')}${info('Código de terceiros', '0079')}</div></section>

      <section data-painel="aba6" class="card" hidden>
        ${PERGUNTAS_1299.map((p, i) => campo(`${i + 1}. ${p}${i < 5 ? ' *' : ''}`, simNao(`question${i + 1}`, fech[`question${i + 1}`] ?? (i < 2 ? 1 : 0))))}
        <label class="passo"><input type="checkbox" name="transmissao_imediata" value="1" ${fech.transmissao_imediata ? 'checked' : ''}> Solicitação de transmissão imediata da DCTFWeb</label>
        <p class="desc">Salve as respostas e, depois de encerrar a folha no eSocial, registre abaixo o recibo do S-1299.</p>
        <div class="grade">
          ${campo('Competência encerrada', select('fechar_mes', x.meses.map(m => [m.id, `${nomeMes(m.competencia)} (${STATUS_MES.find(s => s[0] === m.status)[1]})`]), '', 'form="formFechar"'))}
          ${campo('Recibo do S-1299', inp('nr_rec_1299', '', 'form="formFechar"'))}</div>
        <button class="botao" form="formFechar">Encerrar folha de pagamento</button>
      </section>
      </form>
      <form method="post" action="/dctf-web/${d.id}/fechar" id="formFechar"></form>

      <section data-painel="aba5" hidden>
        <div class="legenda card"><span class="m-marcado">marcado para envio</span><span class="m-enviado">enviado (não fechado)</span><span class="m-fechado">enviado e fechado</span><span class="m-externo">fechado no eSocial fora do sistema</span></div>
        <form method="post" action="/dctf-web/${d.id}/meses" class="card acoes">
          <label class="campo"><span>Adicionar mês</span><input type="month" name="competencia" value="${ultimoMes ? folha.proxMes(ultimoMes) : ''}" required></label>
          <button class="botao">+ Adicionar mês</button><span class="desc">Já entra com os autônomos da obra ativos no mês e o valor calculado.</span></form>
        ${x.meses.map(m => {
          const ql = x.q?.linhas.find(l => l.competencia === m.competencia);
          return html`<details class="card mes m-${m.status === 'fechado_externo' ? 'externo' : m.status}" open>
          <summary><b>${nomeMes(m.competencia)}</b> ${m.is_paralyzed ? html`<span class="selo alerta">Paralisado</span>` : html`<span>Valor: ${brl(ql?.informado)} informado / ${brl(ql?.calculado)} calculado</span>`}</summary>
          <form method="post" action="/dctf-web/${d.id}/meses/${m.id}">
            <div class="rolagem"><table class="lista cartoes"><thead><tr><th>Autônomo</th><th>Número</th><th>Valor (base)</th><th>Pagamento</th><th>Recibos</th><th></th></tr></thead>
            <tbody class="repetidor">${m.items.map(i => linhaItem(i))}</tbody></table></div>
            <template id="modeloItem${m.id}">${linhaItem({ payment_date: ultimoDia(m.competencia) })}</template>
            <button type="button" class="botao sec pequeno adicionar-linha" data-alvo="modeloItem${m.id}">+ Autônomo</button>
            <div class="grade">${campo('Situação do mês', select('status', STATUS_MES, m.status))}${campo('Recibo S-1299', inp('nr_rec_1299', m.nr_rec_1299))}
              ${campo('Mês sem atividade (paralisado)', simNao('is_paralyzed', m.is_paralyzed))}</div>
            <div class="acoes"><button class="botao">Salvar mês</button><a class="botao sec" href="/dctf-web/${d.id}/meses/${m.id}/recibo" target="_blank">Gerar recibo</a>
              <button class="botao sec" formaction="/dctf-web/${d.id}/meses/${m.id}/reabrir">Reabrir</button>
              <button class="botao sec perigo" formaction="/dctf-web/${d.id}/meses/${m.id}/excluir" data-confirmar="Excluir este mês e os valores dele?">Excluir mês</button></div>
          </form></details>`;
        })}
        ${x.erroQ ? html`<div class="aviso erro">${x.erroQ}</div>` : x.q && x.q.linhas.length ? quadroHtml(x.q) : ''}
      </section>
      </div></div>`, { migalha: 'DCTF Web / Envios' }));
  }

  function quadroHtml(q) {
    return html`<div class="card"><h3>Quadro de cálculo</h3>
      ${q.selic_faltando.length ? html`<div class="aviso alerta">Selic não cadastrada para ${q.selic_faltando.join(', ')}: os juros dessas competências estão a menor. Importe em Cadastros > Parâmetros > Selic.</div>` : ''}
      <div class="rolagem"><table class="lista quadro"><thead><tr><th>Mês/ano</th><th>Rem. atualizada</th><th>Rem. original</th><th>CPP de ${n2(q.cpp_pct)}%</th><th>Multa</th><th>Selic acum. (%)</th><th>Juros de mora</th><th>Multa MAED</th><th>Total</th></tr></thead>
      <tbody>${q.linhas.map(l => html`<tr class="${l.paralisado ? 'leve' : ''}"><td>${l.competencia}${l.paralisado ? ' (paralisado)' : ''}</td><td>${brl(l.rem_atualizada)}</td><td>${brl(l.rem_original)}</td><td>${brl(l.cpp)}</td>
        <td>${brl(l.multa)}</td><td>${n2(l.selic_pct)}</td><td>${brl(l.juros)}</td><td>${brl(l.maed)}</td><td>${brl(l.total)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="8">TOTAL</td><td>${brl(q.total)}</td></tr><tr><td colspan="8">TOTAL (Original)</td><td>${brl(q.total_original)}</td></tr>
        <tr><td colspan="8">PERCENTUAL CALCULADO (créditos / RMT não decadente de ${brl(q.rmt_base)})</td><td>${q.percentual === null ? '-' : n2(q.percentual) + '%'}</td></tr></tfoot></table></div>
      <p class="rodape">Competência ainda não vencida não leva multa, juros nem MAED. Percentuais em Cadastros > Parâmetros > DCTFWeb (validar com o fiscal).</p></div>`;
  }

  app.get('/dctf-web/editar/:id', h((req, res) => telaDctf(req, res, carregarDctf(req))));
  app.post('/dctf-web/editar/:id', h((req, res) => {
    const d = carregarDctf(req);
    const b = req.body;
    const w = db.prepare('SELECT id FROM works WHERE id = ? AND office = ? AND client_id = ?').get(Number(b.work_id), req.office, d.client_id);
    const es = db.prepare("SELECT id FROM simulations WHERE id = ? AND office = ? AND client_id = ? AND kind = 'esocial'").get(Number(b.esocial_id), req.office, d.client_id);
    const min = DATA_MIN_OBRA(paramReader(req.office));
    if (b.construction_init_date && b.construction_init_date < min) { flash(res, `A data de início da obra não pode ser antes de ${dataBr(min)}.`, 'erro'); return res.redirect(`/dctf-web/editar/${d.id}#aba2`); }
    const fech = Object.fromEntries(PERGUNTAS_1299.map((_, i) => [`question${i + 1}`, b[`question${i + 1}`] === '1' ? 1 : 0]));
    fech.transmissao_imediata = b.transmissao_imediata === '1' ? 1 : 0;
    db.prepare(`UPDATE dctf_webs SET work_id=?, esocial_id=?, status=?, send1005=?, construction_init_date=?, construction_end_date=?, send1010=?, rubric_code=?, rubric_validity=?,
      rubric_description=?, irrf=?, send1020=?, tax_allocation_code=?, tax_allocation_validity=?, fechamento_json=? WHERE id=?`)
      .run(w ? w.id : d.work_id, es ? es.id : d.esocial_id, STATUS_DCTF.some(s => s[0] === b.status) ? b.status : d.status, b.send1005 === '0' ? 0 : 1,
        b.construction_init_date || null, b.construction_end_date || null, b.send1010 === 'alteracao' ? 'alteracao' : 'inclusao', b.rubric_code || '', b.rubric_validity || '',
        b.rubric_description || '', IRRF.some(x => x[0] === b.irrf) ? b.irrf : '11', b.send1020 === 'alteracao' ? 'alteracao' : 'inclusao', b.tax_allocation_code || '',
        b.tax_allocation_validity || '', JSON.stringify(fech), d.id);
    if (b.marcar) {
      const n = db.prepare("UPDATE payroll_months SET status = 'marcado' WHERE dctf_web_id = ? AND status = 'rascunho' AND is_paralyzed = 0").run(d.id).changes;
      flash(res, `Envio salvo. ${n} mês(es) marcado(s) para envio.`);
    } else flash(res, 'Envio salvo.');
    res.redirect(`/dctf-web/editar/${d.id}`);
  }));
  app.post('/dctf-web/:id/lembretes', h((req, res) => {
    const d = carregarDctf(req);
    db.prepare('UPDATE dctf_webs SET lembretes = ? WHERE id = ?').run(d.lembretes ? 0 : 1, d.id);
    flash(res, d.lembretes ? 'Lembretes desativados.' : 'Lembretes ativados: o Dashboard avisa quando a competência do mês ainda não foi enviada.');
    res.redirect(`/dctf-web/editar/${d.id}`);
  }));
  app.post('/dctf-web/:id/cancelar', h((req, res) => {
    const d = carregarDctf(req);
    db.prepare("UPDATE dctf_webs SET status = 'cancelado', cancel_reason = ?, canceled_at = ? WHERE id = ?").run(String(req.body.cancel_reason || 'Sem motivo informado'), nowIso(), d.id);
    flash(res, 'Envio cancelado.');
    res.redirect(`/dctf-web/editar/${d.id}`);
  }));

  // último envio / competência do envio, pelos meses enviados
  function atualizarUltimoEnvio(dId) {
    const m = db.prepare("SELECT MAX(competencia) AS c FROM payroll_months WHERE dctf_web_id = ? AND status IN ('enviado','fechado','fechado_externo')").get(dId).c;
    db.prepare('UPDATE dctf_webs SET last_competencia = ? WHERE id = ?').run(m || null, dId);
  }

  app.post('/dctf-web/:id/meses', h((req, res) => {
    const d = carregarDctf(req);
    const comp = String(req.body.competencia || '');
    if (!/^\d{4}-\d{2}$/.test(comp)) { flash(res, 'Informe o mês.', 'erro'); return res.redirect(`/dctf-web/editar/${d.id}#aba5`); }
    if (db.prepare('SELECT id FROM payroll_months WHERE dctf_web_id = ? AND competencia = ?').get(d.id, comp)) {
      flash(res, `${nomeMes(comp)} já está na folha.`, 'alerta'); return res.redirect(`/dctf-web/editar/${d.id}#aba5`);
    }
    const x = contexto(req, d);
    const mid = db.prepare('INSERT INTO payroll_months (dctf_web_id, competencia) VALUES (?,?)').run(d.id, comp).lastInsertRowid;
    // autônomos da obra ativos no mês, com o valor calculado dividido entre eles
    const ini = `${comp}-01`, fim = ultimoDia(comp);
    const ativos = (d.work_id ? trabalhadoresDa(d.work_id) : []).filter(t => (!t.start_date || t.start_date <= fim) && (!t.end_date || t.end_date >= ini));
    const ins = db.prepare('INSERT INTO payroll_items (payroll_month_id, mason_id, id_dm_dev, calc_base, payment_date) VALUES (?,?,?,?,?)');
    ativos.forEach((t, k) => ins.run(mid, t.mason_id, `${comp.replace('-', '')}-${k + 1}`, Math.round(x.calculadoMensal / ativos.length * 100) / 100, fim));
    flash(res, `${nomeMes(comp)} adicionado com ${ativos.length} autônomo(s).`);
    res.redirect(`/dctf-web/editar/${d.id}#aba5`);
  }));
  const carregarMes = (req, d) => {
    const m = db.prepare('SELECT * FROM payroll_months WHERE id = ? AND dctf_web_id = ?').get(Number(req.params.mid), d.id);
    if (!m) throw erro404('Mês não encontrado.');
    return m;
  };
  app.post('/dctf-web/:id/meses/:mid', h((req, res) => {
    const d = carregarDctf(req), m = carregarMes(req, d), b = req.body;
    const masonsObra = new Set((d.work_id ? trabalhadoresDa(d.work_id) : []).map(t => t.mason_id));
    db.prepare('DELETE FROM payroll_items WHERE payroll_month_id = ?').run(m.id);
    const ins = db.prepare('INSERT INTO payroll_items (payroll_month_id, mason_id, id_dm_dev, calc_base, payment_date, nr_rec_1200, nr_rec_1210) VALUES (?,?,?,?,?,?,?)');
    arr(b.item_mason).forEach((mid, i) => {
      if (!masonsObra.has(Number(mid))) return;
      ins.run(m.id, Number(mid), arr(b.item_iddmdev)[i] || '', calc.num(arr(b.item_valor)[i]), arr(b.item_pagto)[i] || null, arr(b.item_rec1200)[i] || '', arr(b.item_rec1210)[i] || '');
    });
    const status = STATUS_MES.some(s => s[0] === b.status) ? b.status : m.status;
    db.prepare('UPDATE payroll_months SET status = ?, nr_rec_1299 = ?, is_paralyzed = ? WHERE id = ?').run(status, b.nr_rec_1299 || '', b.is_paralyzed === '1' ? 1 : 0, m.id);
    if (['enviado', 'fechado'].includes(status) && !['enviado', 'fechado'].includes(m.status)) db.prepare('UPDATE dctf_webs SET last_sent_at = ? WHERE id = ?').run(nowIso(), d.id);
    atualizarUltimoEnvio(d.id);
    flash(res, `${nomeMes(m.competencia)} salvo.`);
    res.redirect(`/dctf-web/editar/${d.id}#aba5`);
  }));
  app.post('/dctf-web/:id/meses/:mid/reabrir', h((req, res) => {
    const d = carregarDctf(req), m = carregarMes(req, d);
    db.prepare("UPDATE payroll_months SET status = 'rascunho', nr_rec_1299 = '' WHERE id = ?").run(m.id);
    atualizarUltimoEnvio(d.id);
    flash(res, `${nomeMes(m.competencia)} reaberto (lembre de reabrir a folha também no eSocial - S-1298).`, 'alerta');
    res.redirect(`/dctf-web/editar/${d.id}#aba5`);
  }));
  app.post('/dctf-web/:id/meses/:mid/excluir', h((req, res) => {
    const d = carregarDctf(req), m = carregarMes(req, d);
    db.prepare('DELETE FROM payroll_items WHERE payroll_month_id = ?').run(m.id);
    db.prepare('DELETE FROM payroll_months WHERE id = ?').run(m.id);
    atualizarUltimoEnvio(d.id);
    flash(res, `${nomeMes(m.competencia)} excluído${['enviado', 'fechado'].includes(m.status) ? ' (se já foi enviado, exclua também no eSocial - S-3000)' : ''}.`, 'alerta');
    res.redirect(`/dctf-web/editar/${d.id}#aba5`);
  }));
  app.post('/dctf-web/:id/fechar', h((req, res) => {
    const d = carregarDctf(req);
    const m = db.prepare('SELECT * FROM payroll_months WHERE id = ? AND dctf_web_id = ?').get(Number(req.body.fechar_mes), d.id);
    if (!m) { flash(res, 'Escolha a competência.', 'erro'); return res.redirect(`/dctf-web/editar/${d.id}#aba6`); }
    db.prepare("UPDATE payroll_months SET status = 'fechado', nr_rec_1299 = ? WHERE id = ?").run(String(req.body.nr_rec_1299 || ''), m.id);
    db.prepare('UPDATE dctf_webs SET last_sent_at = ? WHERE id = ?').run(nowIso(), d.id);
    atualizarUltimoEnvio(d.id);
    flash(res, `Folha de ${nomeMes(m.competencia)} encerrada.`);
    res.redirect(`/dctf-web/editar/${d.id}#aba6`);
  }));

  // recibo de pagamento dos autônomos do mês (impressão)
  app.get('/dctf-web/:id/meses/:mid/recibo', h((req, res) => {
    const d = carregarDctf(req), m = carregarMes(req, d);
    const cli = db.prepare('SELECT * FROM clients WHERE id = ?').get(d.client_id);
    const obra = d.work_id && db.prepare('SELECT * FROM works WHERE id = ?').get(d.work_id);
    const itens = db.prepare('SELECT pi.*, ms.name, ms.document, ms.cbo FROM payroll_items pi JOIN masons ms ON ms.id = pi.mason_id WHERE pi.payroll_month_id = ?').all(m.id);
    res.send(layout(req, `Recibos - ${nomeMes(m.competencia)}`, html`<div class="acoes nao-imprime"><button class="botao" onclick="print()">Imprimir / PDF</button></div>
      ${itens.map(i => html`<article class="card documento recibo"><h2>Recibo de pagamento a autônomo</h2>
        <p>Recebi de <b>${cli.nome}</b> ${cli.documento ? `(CPF/CNPJ ${cli.documento})` : ''} a importância de <b>${brl(i.calc_base)}</b>, referente a serviços prestados na obra
        ${obra ? `${obra.custom_name || obra.endereco || ''} - CNO ${obra.cno || '-'}` : ''}, competência ${nomeMes(m.competencia)} (nº ${i.id_dm_dev}).</p>
        <p>Data do pagamento: ${dataBr(i.payment_date)}</p>
        <div class="assinaturas"><div>${i.name}<br><small>CPF ${i.document} · CBO ${i.cbo}</small></div><div>${cli.nome}</div></div></article>`)}`,
    { migalha: `DCTF Web / Envio #${d.id}` }));
  }));

  // relatório por evento (imprimir/PDF)
  app.get('/dctf-web/visualizar/:id', h((req, res) => {
    const d = carregarDctf(req);
    const x = contexto(req, d);
    const o = x.obra || {}, c = x.cli, esc = req.officeRow;
    res.send(layout(req, `Relatório DCTFWeb #${d.id}`, html`<div class="acoes nao-imprime"><button class="botao" onclick="print()">Imprimir / PDF</button><a class="botao sec" href="/dctf-web/editar/${d.id}">Editar</a></div>
      <article class="card documento">
      <div class="grade"><div><h3>Informações do Cliente (Empregador)</h3><p>${c.nome}<br>${c.documento || ''}<br>${c.telefone || ''} ${c.email || ''}</p></div>
        <div><h3>Informações da Empresa (Transmissor)</h3><p>${esc.display_name || esc.name}<br>${x.sp.cert ? `${x.sp.cert.titular} (${x.sp.cert.documento})` : ''}<br>${esc.email || ''} ${esc.whatsapp || ''}</p></div></div>
      <h3>S-1000 Cliente, obra e eSocial</h3><table class="resumo largo"><tr><td>Classificação tributária</td><td>${c.class_trib || '21'}</td></tr><tr><td>Recibo S-1000</td><td>${c.s1000_recibo || '-'}</td></tr>
        <tr><td>Procuração eletrônica</td><td>${c.possui_procuracao ? `${dataBr(c.procuracao_data_assinatura)} a ${dataBr(c.procuracao_data_fim)}` : 'Não informada'}</td></tr>
        <tr><td>Fator de ajuste eSocial</td><td>${x.es ? `#${x.es.id} - RMT ${brl(x.esR.rmt)}` : '-'}</td></tr><tr><td>Status</td><td>${rotuloStatus(d.status)}</td></tr></table>
      <h3>S-1005 Estabelecimento/obra</h3><table class="resumo largo"><tr><td>${o.registration_type || 'CNO'}</td><td>${o.cno || '-'}</td></tr><tr><td>Obra</td><td>${o.custom_name || ''} ${[o.endereco, o.numero, o.bairro, o.municipio, o.uf].filter(Boolean).join(', ')}</td></tr>
        <tr><td>CNAE</td><td>${o.cnae || '-'}</td></tr><tr><td>Período</td><td>${dataBr(x.inicio)} a ${dataBr(x.fim) || '-'}</td></tr></table>
      <h3>S-1010 Rubricas</h3><table class="resumo largo"><tr><td>Código / descrição</td><td>${d.rubric_code} - ${d.rubric_description}</td></tr><tr><td>Validade</td><td>${d.rubric_validity || '-'}</td></tr>
        <tr><td>Natureza / tipo / IRRF</td><td>3501 / 1 / ${d.irrf}</td></tr></table>
      <h3>S-1020 Lotações</h3><table class="resumo largo"><tr><td>Código</td><td>${d.tax_allocation_code}</td></tr><tr><td>Tipo / FPAS / terceiros</td><td>21 / 507 / 0079</td></tr><tr><td>Validade</td><td>${d.tax_allocation_validity || '-'}</td></tr></table>
      <h3>S-1200 | S-1210 Remunerações e pagamentos</h3>
      <table class="lista"><thead><tr><th>Mês</th><th>Autônomo</th><th>Número</th><th>Valor</th><th>Pagamento</th><th>Situação</th></tr></thead><tbody>
        ${x.meses.flatMap(m => (m.items.length ? m.items : [{}]).map(i => html`<tr><td>${m.competencia}</td><td>${i.name || (m.is_paralyzed ? 'Paralisado' : '-')}</td><td>${i.id_dm_dev || ''}</td>
          <td>${i.calc_base ? brl(i.calc_base) : ''}</td><td>${dataBr(i.payment_date)}</td><td>${STATUS_MES.find(s => s[0] === m.status)[1]}</td></tr>`))}</tbody></table>
      ${x.q && x.q.linhas.length ? quadroHtml(x.q) : ''}</article>`, { migalha: 'DCTF Web / Envios' }));
  }));

  // ============================================================ guia de envio
  app.get('/guia-de-envio', h((req, res) => {
    const guias = db.prepare(`SELECT g.*, c.nome AS cliente FROM send_guides g JOIN clients c ON c.id = g.client_id WHERE g.office = ? AND g.ativo = 1 AND c.ativo = 1 ORDER BY g.id DESC`).all(req.office)
      .map(g => {
        const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(g.client_id);
        const p = passosGuia(req.office, c);
        if (p.progress.percent === 100 && g.status !== 'completed') {
          db.prepare("UPDATE send_guides SET status = 'completed', completed_at = ? WHERE id = ?").run(nowIso(), g.id);
          g.status = 'completed';
        } else if (p.progress.percent < 100 && g.status === 'completed') {
          db.prepare("UPDATE send_guides SET status = 'active', completed_at = NULL WHERE id = ?").run(g.id);
          g.status = 'active';
        }
        return { ...g, p };
      });
    const abas = { active: 'Em andamento', paused: 'Pausados', completed: 'Concluídos' };
    const aba = abas[req.query.aba] ? req.query.aba : 'active';
    const semGuia = db.prepare('SELECT id, nome FROM clients WHERE office = ? AND ativo = 1 AND id NOT IN (SELECT client_id FROM send_guides WHERE office = ? AND ativo = 1) ORDER BY nome').all(req.office, req.office);
    res.send(layout(req, 'Guia de envio', html`
      <div class="abas">${Object.entries(abas).map(([k, t]) => html`<a href="?aba=${k}" class="${k === aba ? 'ativo' : ''}">${t} <span>${guias.filter(g => g.status === k).length}</span></a>`)}</div>
      <details class="card"><summary class="botao">+ Novo guia</summary><div class="grade">
        <form method="post" action="/guia-de-envio" class="acoes">${campo('Cliente existente', select('client_id', [['', 'Selecione'], ...semGuia.map(c => [c.id, c.nome])], '', 'required'))}<button class="botao">Iniciar guia</button></form>
        <div class="acoes"><a class="botao sec" href="/acompanhamento-de-obras/clientes">Cadastrar cliente novo</a></div></div></details>
      ${tabela(['Cliente', 'Progresso', 'Passo atual', 'Pausado em', 'Por', 'Ações'], guias.filter(g => g.status === aba).map(g => [g.cliente,
        html`<div class="barra pequena"><span style="width:${g.p.progress.percent}%"></span></div>${g.p.progress.done}/${g.p.progress.total} (${g.p.progress.percent}%)`,
        g.p.atual ? html`<a href="${g.p.atual.url}">${g.p.atual.titulo}</a>` : 'Concluído', dataHoraBr(g.paused_at), g.user,
        html`<span class="acoes-linha"><a href="/guia-de-envio/${g.client_id}">Ver passo a passo</a>
          ${g.status !== 'completed' ? html`<form method="post" action="/guia-de-envio/${g.client_id}/pausar"><button class="link">${g.status === 'paused' ? 'Retomar' : 'Pausar'}</button></form>` : ''}
          <form method="post" action="/guia-de-envio/${g.client_id}/excluir" data-confirmar="Excluir o acompanhamento deste cliente? Os cadastros continuam."><button class="link">Excluir acompanhamento</button></form></span>`]),
      'Nenhum guia nesta aba.')}`,
    { descricao: 'Passo a passo do envio eSocial/DCTFWeb de cada cliente. O progresso é detectado pelos cadastros já feitos.', migalha: 'DCTF Web' }));
  }));
  app.post('/guia-de-envio', h((req, res) => {
    const cli = clienteDoEscritorio(req.office, req.body.client_id);
    if (!cli) { flash(res, 'Escolha o cliente.', 'erro'); return res.redirect('/guia-de-envio'); }
    db.prepare(`INSERT INTO send_guides (office, client_id, started_at, user) VALUES (?,?,?,?)
      ON CONFLICT(office, client_id) DO UPDATE SET ativo = 1, status = 'active', paused_at = NULL`).run(req.office, cli, nowIso(), req.user.name);
    res.redirect(`/guia-de-envio/${cli}`);
  }));
  const carregarGuia = req => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ? AND office = ? AND ativo = 1').get(Number(req.params.clientId), req.office);
    if (!c) throw erro404('Cliente não encontrado.');
    return c;
  };
  app.get('/guia-de-envio/:clientId', h((req, res) => {
    const c = carregarGuia(req);
    db.prepare('INSERT OR IGNORE INTO send_guides (office, client_id, started_at, user) VALUES (?,?,?,?)').run(req.office, c.id, nowIso(), req.user.name);
    const g = db.prepare('SELECT * FROM send_guides WHERE office = ? AND client_id = ?').get(req.office, c.id);
    const p = passosGuia(req.office, c);
    res.send(layout(req, `Guia de envio - ${c.nome}`, html`
      <div class="card"><div class="barra"><span style="width:${p.progress.percent}%"></span></div>${p.progress.done} de ${p.progress.total} passos (${p.progress.percent}%)
        ${g.status === 'paused' ? html`<form method="post" action="/guia-de-envio/${c.id}/pausar" class="acoes"><span class="selo alerta">Pausado em ${dataHoraBr(g.paused_at)}</span><button class="botao">Retomar guia</button></form>` : ''}</div>
      <ol class="guia">${p.passos.map((s, i) => html`<li class="card passo-guia ${s.done ? 'feito' : ''} ${s.current ? 'atual' : ''}">
        <div><b>${i + 1}. ${s.titulo}</b> ${s.done ? html`<span class="selo">Concluído</span>` : s.current ? html`<span class="selo alerta">Passo atual</span>` : ''}
        <p class="desc">${s.texto}</p>${s.checks ? html`<ul class="checks">${s.checks.map(([t, ok]) => html`<li class="${ok ? 'ok' : 'falta'}">${ok ? '✔' : '✘'} ${t}</li>`)}</ul>` : ''}</div>
        <a class="botao ${s.current ? '' : 'sec'} pequeno" href="${s.url}">${s.done ? 'Revisar' : s.key === 'client_complete' ? 'Editar cliente' : 'Ir para o passo'}</a></li>`)}</ol>`,
    { migalha: 'DCTF Web / Guia de envio' }));
  }));
  app.post('/guia-de-envio/:clientId/pausar', h((req, res) => {
    const c = carregarGuia(req);
    const g = db.prepare('SELECT * FROM send_guides WHERE office = ? AND client_id = ?').get(req.office, c.id);
    if (g) {
      if (g.status === 'paused') db.prepare("UPDATE send_guides SET status = 'active', paused_at = NULL WHERE id = ?").run(g.id);
      else db.prepare("UPDATE send_guides SET status = 'paused', paused_at = ?, user = ? WHERE id = ?").run(nowIso(), req.user.name, g.id);
    }
    res.redirect(req.get('referer')?.includes(`/guia-de-envio/${c.id}`) ? `/guia-de-envio/${c.id}` : '/guia-de-envio');
  }));
  app.post('/guia-de-envio/:clientId/excluir', h((req, res) => {
    const c = carregarGuia(req);
    db.prepare('UPDATE send_guides SET ativo = 0 WHERE office = ? AND client_id = ?').run(req.office, c.id);
    flash(res, 'Acompanhamento excluído.');
    res.redirect('/guia-de-envio');
  }));
};
module.exports.avisosCertificados = avisosCertificados;
module.exports.situacaoProcuracao = situacaoProcuracao;
module.exports.passosGuia = passosGuia;
module.exports.lembretesDctf = lembretesDctf;

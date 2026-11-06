'use strict';
// Telas do Perfil Comportamental. Cada envio é um registro "perfil" (sem entrada
// em KINDS: não passa pelo cadastro genérico, para só quem tem a classe "perfil"
// chegar nele). O link geral do escritório fica em config, chave "perfil_link".
const R = require('./db');
const { db, tx, nowIso } = R;
const { ve, pode } = require('./acesso');
const { um, csv } = require('./crud');
const M = require('./metricas');
const P = require('./comportamental');
const { hoje } = require('./datas');
const { html, raw, dataBr, layout, page, tabela, select, campo, cartao, barras } = require('./views');

const ABAS_PERFIS = ['Todos', 'Respondidos', 'Aguardando'];
const AVISO = 'Questionário próprio, de apoio à conversa. Não é teste psicológico e não deve ser o único critério de uma decisão sobre a pessoa.';
const MIGALHA = 'Perfil Comportamental';
const nomeEstilo = e => P.ESTILOS[e]?.nome || '';
const respondidos = lista => lista.filter(p => p.status === 'Respondido');
const texto = v => String(um(v) ?? '').trim();
const emailOk = e => /^[^@\s]+@[^@\s]+$/.test(e);
const lerRespostas = body => P.pontuar(P.QUESTOES.map((_, i) => Number(um(body[`q${i}`]) ?? NaN)));

// ---------------------------------------------------------------- questionário
const blocoPerguntas = () => html`${P.QUESTOES.map((q, i) => html`<div class="pergunta"><p><b>${i + 1}. ${q.texto}</b></p><div class="escala">
  ${P.ESCALA.map(([v, t]) => html`<label><input type="radio" name="q${i}" value="${v}" required>${t}</label>`)}</div></div>`)}`;
const blocoAceite = () => html`<p class="desc">Não há resposta certa ou errada. ${AVISO} O resultado fica visível só para a equipe de RH da empresa.</p>
  <label class="aceite"><input type="checkbox" name="aceite" value="1" required> Li e concordo em responder.</label>`;

function telaPublica(res, corpo, status = 200) {
  res.status(status).send(page('Perfil comportamental', html`<div class="publico"><header class="topo-publico"><span class="logo">🧠</span><div><b>Perfil comportamental</b><small>Leva cerca de 5 minutos.</small></div></header>${corpo}</div>`));
}
const aviso = msg => html`<div class="card"><p>${msg}</p></div>`;
const formPublico = (extra = '') => html`<form method="post" class="card">${extra}${blocoPerguntas()}${blocoAceite()}
  <input name="site" class="oculto" tabindex="-1" autocomplete="off" aria-hidden="true">
  <div class="acoes"><button class="botao">Enviar respostas</button></div></form>`;
const camposPessoa = (nome = '', email = '') => html`<div class="grade">${campo('Nome completo *', html`<input name="nome" value="${nome}" required maxlength="200">`)}
  ${campo('E-mail *', html`<input name="email" type="email" value="${email}" required maxlength="200">`)}</div>`;

function porToken(token) {
  const r = db.prepare("SELECT * FROM registros WHERE kind = 'perfil' AND ativo = 1 AND json_extract(dados, '$.token') = ?").get(String(token));
  return r ? { ...JSON.parse(r.dados), id: r.id, office: r.office } : null;
}
const officeDoLink = token => db.prepare("SELECT office FROM config WHERE chave = 'perfil_link' AND json_extract(valor, '$.token') = ?").get(String(token))?.office;
const novoRegistro = (dados, office, usuario) => R.criar(office, 'perfil', { status: 'Aguardando', token: R.novoToken(), data_envio: hoje(), ...dados }, usuario);
const respondido = (dados, r) => ({ ...dados, status: 'Respondido', data_resposta: hoje(), ...r });
function linkAberto(office) {
  const atual = R.config(office, 'perfil_link');
  if (atual.token) return atual.token;
  R.salvarConfig(office, 'perfil_link', { token: R.novoToken() });
  return R.config(office, 'perfil_link').token;
}

function publicas(app, { h, excedeuLimite, telaErro }) {
  const recusa = (req, res) => {
    if (req.body.site) { res.redirect(req.originalUrl); return true; } // robô (campo oculto preenchido)
    if (excedeuLimite(req.ip)) { telaPublica(res, aviso('Muitos envios seguidos. Tente de novo mais tarde.'), 429); return true; }
    return false;
  };
  const invalido = (res, msg) => telaPublica(res, aviso(msg), 422);
  const obrigado = res => telaPublica(res, aviso('Respostas registradas. Obrigado por participar!'));

  app.get('/perfil/:token', h((req, res) => {
    const p = porToken(req.params.token);
    if (!p) return telaErro(res, 404, 'Link não encontrado ou cancelado.');
    telaPublica(res, p.status === 'Respondido' ? aviso('Este questionário já foi respondido. Obrigado!') : formPublico(html`<p>Olá, ${p.nome}.</p>`));
  }));
  app.post('/perfil/:token', h((req, res) => {
    const p = porToken(req.params.token);
    if (!p) return telaErro(res, 404, 'Link não encontrado ou cancelado.');
    if (p.status === 'Respondido') return telaPublica(res, aviso('Este questionário já foi respondido. Obrigado!'));
    if (recusa(req, res)) return;
    const r = lerRespostas(req.body);
    if (!r || um(req.body.aceite) !== '1') return invalido(res, 'Responda todas as afirmações e marque o aceite.');
    const { id, office, ...dados } = p;
    R.atualizar(office, 'perfil', id, respondido(dados, r));
    obrigado(res);
  }));

  app.get('/perfil-aberto/:token', h((req, res) => {
    if (!officeDoLink(req.params.token)) return telaErro(res, 404, 'Link não encontrado ou cancelado.');
    telaPublica(res, formPublico(camposPessoa()));
  }));
  app.post('/perfil-aberto/:token', h((req, res) => {
    const office = officeDoLink(req.params.token);
    if (!office) return telaErro(res, 404, 'Link não encontrado ou cancelado.');
    if (recusa(req, res)) return;
    const r = lerRespostas(req.body), nome = texto(req.body.nome).slice(0, 200), email = texto(req.body.email).slice(0, 200);
    if (!r || !nome || !emailOk(email) || um(req.body.aceite) !== '1') return invalido(res, 'Preencha nome e e-mail, responda todas as afirmações e marque o aceite.');
    // sempre como candidato: quem usa o link geral não prova quem é
    novoRegistro(respondido({ vinculo: 'Candidato', nome, email, tipo_envio: 'Link de preenchimento' }, r), office, 'Link de preenchimento');
    obrigado(res);
  }));
}

// ---------------------------------------------------------------- telas internas
function internas(app, { h, exige, auditar, flash, falha, baseUrl }) {
  app.use('/comportamental', (req, res, next) => (ve(req.papel, 'perfil') ? next() : next(falha(403, 'Seu papel não permite ver perfis comportamentais.'))));

  const lista = req => R.listar(req.office, 'perfil');
  const carregar = req => {
    const p = R.obter(req.office, 'perfil', req.params.id);
    if (!p) throw falha(404, 'Perfil não encontrado.');
    return p;
  };
  const opcoesCad = (req, kind) => [['', 'Todos'], ...req.c.listar(kind).map(r => [r.id, r.nome])];
  const colabDe = (req, p) => (p.colaborador_id ? req.c.registro('colaborador', p.colaborador_id) : null);

  // filtros por pessoa: ao filtrar por área, candidato fica de fora
  function filtrar(req, itens, campoData) {
    const q = req.query, f = n => Number(um(q[n])) || 0;
    const porColab = ['departamento_id', 'unidade_id', 'cargo_id', 'superior_id'].filter(f);
    const de = texto(q.de), ate = texto(q.ate), vinculo = texto(q.vinculo);
    return itens.filter(p => {
      if (vinculo && p.vinculo !== vinculo) return false;
      if ((de && (p[campoData] || '') < de) || (ate && (p[campoData] || '9') > ate)) return false;
      if (!porColab.length) return true;
      const c = colabDe(req, p);
      return Boolean(c) && porColab.every(n => c[n] === f(n));
    });
  }
  const formFiltros = (req, aba, { vinculo = true } = {}) => html`<form method="get" class="card"><input type="hidden" name="aba" value="${aba}"><div class="grade">
    ${vinculo ? campo('Vínculo', select('vinculo', [['', 'Todos'], 'Colaborador', 'Candidato'], req.query.vinculo)) : ''}
    ${campo('Unidade', select('unidade_id', opcoesCad(req, 'unidade'), req.query.unidade_id))}
    ${campo('Departamento', select('departamento_id', opcoesCad(req, 'departamento'), req.query.departamento_id))}
    ${campo('Cargo', select('cargo_id', opcoesCad(req, 'cargo'), req.query.cargo_id))}
    ${campo('Superior direto', select('superior_id', opcoesCad(req, 'colaborador').filter(([id]) => !id || req.c.listar('colaborador').some(x => x.superior_id === id)), req.query.superior_id))}
    ${campo('De', html`<input type="date" name="de" value="${req.query.de || ''}">`)}
    ${campo('Até', html`<input type="date" name="ate" value="${req.query.ate || ''}">`)}</div>
    <div class="acoes"><button class="botao">Filtrar</button><a class="botao sec" href="?aba=${aba}">Limpar filtros</a></div></form>`;
  const abasDe = (itens, ativa) => html`<div class="abas">${itens.map(([v, t]) => html`<a href="?aba=${v}" class="${v === ativa ? 'ativo' : ''}">${t}</a>`)}</div>`;

  const barrasPontos = pontos => barras(P.CHAVES.map(e => [`${nomeEstilo(e)} (${P.faixa(pontos[e])})`, pontos[e]]), '', { partes: false });
  const distribuicao = itens => barras(P.CHAVES.map(e => [nomeEstilo(e), itens.filter(p => p.principal === e).length]).filter(x => x[1]));

  // -------------------------------------------------------------- métricas
  const ABAS_METRICAS = [['participacao', 'Participação'], ['empresa', 'Perfil da Empresa'], ['grupos', 'Análise dos Grupos']];
  app.get('/comportamental/metricas', h((req, res) => {
    const aba = ABAS_METRICAS.some(a => a[0] === req.query.aba) ? req.query.aba : 'participacao';
    let corpo;
    if (aba === 'participacao') {
      const itens = filtrar(req, lista(req), 'data_envio'), feitos = respondidos(itens);
      const porMes = M.contar(feitos, p => p.data_resposta.slice(0, 7)).sort((a, b) => a[0].localeCompare(b[0]));
      corpo = html`${formFiltros(req, aba)}<div class="cards4">${cartao('Enviados', itens.length)}${cartao('Respondidos', feitos.length)}
        ${cartao('Aguardando', itens.length - feitos.length)}${cartao('Participação', `${itens.length ? Math.round((feitos.length / itens.length) * 100) : 0}%`)}</div>
        <div class="card"><h3 class="primeiro">Respostas por mês</h3>${barras(porMes, 'Nenhuma resposta no período.', { partes: false })}</div>`;
    } else if (aba === 'empresa') {
      const itens = filtrar(req, respondidos(lista(req)).filter(p => p.vinculo === 'Colaborador'), 'data_resposta');
      corpo = html`${formFiltros(req, aba, { vinculo: false })}${itens.length ? html`<div class="grade-2">
        <div class="card"><h3 class="primeiro">Estilo principal</h3>${distribuicao(itens)}</div>
        <div class="card"><h3 class="primeiro">Média por estilo</h3>${barrasPontos(P.mediaPontos(itens))}</div>
        ${P.CHAVES.map(e => html`<div class="card"><h3 class="primeiro">Faixas: ${nomeEstilo(e)}</h3>${barras(P.ORDEM_FAIXAS.map(x => [x, itens.filter(p => P.faixa(p.pontos[e]) === x).length]))}</div>`)}
      </div>` : html`<div class="aviso alerta">Nenhum colaborador respondeu com esses filtros.</div>`}`;
    } else {
      const grupos = R.listar(req.office, 'perfil_grupo');
      corpo = tabela(['Grupo', 'Pessoas', 'Criado por'], grupos.map(g => [html`<a href="/comportamental/grupos?grupo=${g.id}">${g.nome}</a>`, g.perfis.length, g.criado_por]), 'Nenhum grupo salvo. Crie um em Análise de Grupo.');
    }
    res.send(layout(req, 'Métricas do Perfil', html`${abasDe(ABAS_METRICAS, aba)}${corpo}`, { migalha: MIGALHA, descricao: 'Participação e distribuição dos perfis da empresa.' }));
  }));

  // -------------------------------------------------------------- perfis
  app.get('/comportamental/perfis', h((req, res) => {
    const todos = lista(req), estilo = P.ESTILOS[req.query.estilo] ? req.query.estilo : '', vinculo = texto(req.query.vinculo);
    const base = todos.filter(p => (!estilo || p.principal === estilo) && (!vinculo || p.vinculo === vinculo));
    const dessa = a => base.filter(p => a === 'Todos' || (a === 'Respondidos' ? p.status === 'Respondido' : p.status === 'Aguardando'));
    const ativa = ABAS_PERFIS.includes(req.query.aba) ? req.query.aba : 'Todos';
    const apagar = pode(req.papel, 'apaga');
    const linhas = dessa(ativa).map(p => [html`<a href="/comportamental/perfis/${p.id}">${p.nome}</a>`, p.email || '', p.vinculo, P.nomePerfil(p) || 'Não respondido', dataBr(p.data_envio), dataBr(p.data_resposta),
      html`<span class="acoes-linha"><a href="/comportamental/perfis/${p.id}">Ver</a>${apagar ? html`<form method="post" action="/comportamental/perfis/${p.id}/apagar" data-confirmar="Apagar este perfil?"><button class="link">Apagar</button></form>` : ''}</span>`]);
    res.send(layout(req, 'Perfis', html`<div class="abas">${ABAS_PERFIS.map(a => html`<a href="?aba=${a}&estilo=${estilo}&vinculo=${vinculo}" class="${a === ativa ? 'ativo' : ''}">${a}<span>${dessa(a).length}</span></a>`)}</div>
      <form method="get" class="card"><input type="hidden" name="aba" value="${ativa}"><div class="grade">
        ${campo('Estilo principal', select('estilo', [['', 'Todos'], ...P.CHAVES.map(e => [e, nomeEstilo(e)])], estilo))}
        ${campo('Vínculo', select('vinculo', [['', 'Todos'], 'Colaborador', 'Candidato'], vinculo))}</div>
        <div class="acoes"><button class="botao">Filtrar</button>${pode(req.papel, 'edita') ? html`<a class="botao" href="/comportamental/enviar">Enviar questionário</a>` : ''}<a class="botao sec" href="/comportamental/perfis/exportar">Exportar CSV</a></div></form>
      ${tabela(['Nome', 'E-mail', 'Vínculo', 'Perfil', 'Envio', 'Resposta', 'Ações'], linhas, 'Nenhum perfil aqui.')}`, { migalha: MIGALHA, descricao: AVISO }));
  }));
  app.get('/comportamental/perfis/exportar', h((req, res) => {
    auditar(req, 'Exportou', 'perfil');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="perfis-comportamentais.csv"' }).send(csv(
      ['Nome', 'E-mail', 'Vínculo', 'Situação', 'Perfil', ...P.CHAVES.map(nomeEstilo), 'Envio', 'Resposta'],
      lista(req).map(p => [p.nome, p.email, p.vinculo, p.status, P.nomePerfil(p), ...P.CHAVES.map(e => p.pontos?.[e] ?? ''), dataBr(p.data_envio), dataBr(p.data_resposta)])));
  }));
  app.get('/comportamental/perfis/:id(\\d+)', h((req, res) => {
    const p = carregar(req), editar = pode(req.papel, 'edita');
    let corpo;
    if (p.status === 'Aguardando') {
      const link = `${baseUrl(req)}/perfil/${p.token}`;
      const carta = `Olá, ${p.nome}. Por favor, responda ao questionário de perfil comportamental neste link: ${link}`;
      corpo = html`<div class="card"><small>Link individual, aguardando resposta</small>
        <div class="copiar"><input id="linkPerfil" value="${link}" readonly aria-label="Link do questionário"><button type="button" class="botao sec" data-copiar="linkPerfil">Copiar</button></div>
        ${p.email ? html`<div class="acoes"><a class="botao sec" href="mailto:${p.email}?subject=${encodeURIComponent('Perfil comportamental')}&body=${encodeURIComponent(carta)}">Abrir no e-mail</a></div>` : ''}</div>`;
    } else {
      const est = P.ESTILOS[p.principal], cargo = colabDe(req, p) && req.c.registro('cargo', colabDe(req, p).cargo_id);
      corpo = html`<div class="cards4">${cartao('Perfil', P.nomePerfil(p), est.resumo)}${cartao('Respondido em', dataBr(p.data_resposta))}
        ${cargo?.perfil_esperado ? cartao(`Aderência a ${cargo.nome}`, `${P.aderencia(p.pontos, P.alvo(cargo.perfil_esperado))}%`, `Esperado: ${nomeEstilo(cargo.perfil_esperado)}`) : ''}</div>
        <div class="grade-2"><div class="card"><h3 class="primeiro">Pontuação (0 a 100)</h3>${barrasPontos(p.pontos)}</div>
        <div class="card"><h3 class="primeiro">Pontos fortes</h3><ul>${est.fortes.map(t => html`<li>${t}</li>`)}</ul>
          <h3>Pontos de atenção</h3><ul>${est.cuidados.map(t => html`<li>${t}</li>`)}</ul>
          <h3>Como apoiar</h3><p>${est.gestao}</p></div></div>
        <div class="acoes nao-imprime"><button type="button" class="botao sec" onclick="window.print()">Imprimir ou salvar PDF</button></div>`;
    }
    res.send(layout(req, p.nome, html`${corpo}
      <form method="post" action="/comportamental/perfis/${p.id}" class="card nao-imprime"><fieldset ${editar ? '' : raw('disabled')}><h3 class="primeiro">Dados da pessoa</h3>${camposPessoa(p.nome, p.email || '')}</fieldset>
        <div class="acoes">${editar ? html`<button class="botao">Salvar</button>` : ''}<a class="botao sec" href="/comportamental/perfis">Voltar</a></div></form>`, { migalha: 'Perfis', descricao: AVISO }));
  }));
  app.post('/comportamental/perfis/:id(\\d+)', exige('edita'), h((req, res) => {
    const p = carregar(req), nome = texto(req.body.nome).slice(0, 200), email = texto(req.body.email).slice(0, 200);
    if (!nome || !emailOk(email)) { flash(res, 'Informe nome e e-mail válidos.', 'erro'); return res.redirect(req.originalUrl); }
    tx(() => { R.atualizar(req.office, 'perfil', p.id, { ...R.soDados(p), nome, email }); auditar(req, 'Editou', 'perfil', p.id, 'Nome, E-mail'); });
    flash(res, 'Salvo.');
    res.redirect(req.originalUrl);
  }));
  app.post('/comportamental/perfis/:id(\\d+)/apagar', exige('apaga'), h((req, res) => {
    const p = carregar(req);
    tx(() => { R.apagar(req.office, 'perfil', p.id); auditar(req, 'Apagou', 'perfil', p.id); });
    flash(res, 'Apagado.');
    res.redirect('/comportamental/perfis');
  }));

  // -------------------------------------------------------------- envio
  const colabsAtivos = req => req.c.listar('colaborador').filter(c => c.situacao === 'Ativo').sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  app.get('/comportamental/enviar', exige('edita'), h((req, res) => {
    const link = `${baseUrl(req)}/perfil-aberto/${linkAberto(req.office)}`;
    res.send(layout(req, 'Enviar questionário', html`<form method="post" class="card"><h3 class="primeiro">Por lista</h3>
      <p class="desc">Cada pessoa recebe um link próprio. Quem já tem envio aguardando resposta não entra de novo.</p><div class="grade">
      ${campo('Colaboradores', html`<select name="colaboradores" multiple size="8">${colabsAtivos(req).map(c => html`<option value="${c.id}">${c.nome}</option>`)}</select>`)}
      ${campo('Candidatos (um por linha: Nome;E-mail)', html`<textarea name="candidatos" rows="8" maxlength="50000"></textarea>`)}</div>
      <div class="acoes"><button class="botao">Gerar links</button></div></form>
      <div class="card"><h3 class="primeiro">Link de preenchimento</h3><p class="desc">Um link só, para divulgar. Quem responder por ele entra como candidato.</p>
        <div class="copiar"><input id="linkAberto" value="${link}" readonly aria-label="Link de preenchimento"><button type="button" class="botao sec" data-copiar="linkAberto">Copiar</button></div>
        <form method="post" action="/comportamental/enviar/novo-link" data-confirmar="O link atual para de funcionar. Continuar?"><div class="acoes"><button class="botao sec">Trocar link</button></div></form></div>`,
    { migalha: MIGALHA, descricao: 'O RH ainda não envia e-mail: cada link pode ser copiado ou aberto no seu e-mail.' }));
  }));
  app.post('/comportamental/enviar', exige('edita'), h((req, res) => {
    const pendentes = lista(req).filter(p => p.status === 'Aguardando');
    const ids = [...new Set([].concat(req.body.colaboradores ?? []).map(Number))];
    const linhas = String(um(req.body.candidatos) || '').split(/\r?\n/).map(l => l.split(/[;,\t]/).map(x => x.trim())).filter(l => l[0]);
    const invalida = linhas.find(l => !emailOk(l[1] || ''));
    if (invalida) { flash(res, `Linha sem e-mail válido: ${invalida[0]}.`, 'erro'); return res.redirect('/comportamental/enviar'); }
    const novos = [];
    for (const id of ids) {
      const c = req.c.registro('colaborador', id);
      if (!c) throw falha(404, 'Colaborador não encontrado.');
      if (!pendentes.some(p => p.colaborador_id === id)) novos.push({ vinculo: 'Colaborador', colaborador_id: id, nome: c.nome, email: c.email });
    }
    const emails = new Set(pendentes.map(p => String(p.email).toLowerCase()));
    for (const [nome, email] of linhas) {
      if (!emails.has(email.toLowerCase())) { emails.add(email.toLowerCase()); novos.push({ vinculo: 'Candidato', nome: nome.slice(0, 200), email: email.slice(0, 200) }); }
    }
    tx(() => { for (const d of novos) auditar(req, 'Enviou', 'perfil', novoRegistro({ ...d, tipo_envio: 'Lista' }, req.office, req.user.name)); });
    flash(res, novos.length ? `${novos.length} link(s) gerado(s). Abra cada pessoa para copiar o link.` : 'Nenhum link novo: selecione alguém sem envio pendente.', novos.length ? 'ok' : 'alerta');
    res.redirect('/comportamental/perfis?aba=Aguardando');
  }));
  app.post('/comportamental/enviar/novo-link', exige('edita'), h((req, res) => {
    R.salvarConfig(req.office, 'perfil_link', { token: R.novoToken() });
    auditar(req, 'Trocou o link', 'perfil');
    flash(res, 'Link trocado.');
    res.redirect('/comportamental/enviar');
  }));

  // -------------------------------------------------------------- aplicação presencial
  app.get('/comportamental/responder', exige('edita'), h((req, res) => {
    res.send(layout(req, 'Responder Perfil', html`<form method="post" class="card"><div class="grade">
      ${campo('Colaborador', select('colaborador_id', [['', '- outra pessoa -'], ...colabsAtivos(req).map(c => [c.id, c.nome])], ''))}
      ${campo('Nome (se não for colaborador)', html`<input name="nome" maxlength="200">`)}${campo('E-mail (se não for colaborador)', html`<input name="email" type="email" maxlength="200">`)}</div>
      ${blocoPerguntas()}${blocoAceite()}<div class="acoes"><button class="botao">Salvar respostas</button></div></form>`, { migalha: MIGALHA, descricao: 'Aplicação presencial: a própria pessoa responde nesta tela.' }));
  }));
  app.post('/comportamental/responder', exige('edita'), h((req, res) => {
    const r = lerRespostas(req.body), id = Number(um(req.body.colaborador_id)) || 0;
    const c = id ? req.c.registro('colaborador', id) : null;
    if (id && !c) throw falha(404, 'Colaborador não encontrado.');
    const nome = c?.nome || texto(req.body.nome).slice(0, 200), email = c?.email || texto(req.body.email).slice(0, 200);
    if (!r || !nome || !emailOk(email) || um(req.body.aceite) !== '1') { flash(res, 'Informe a pessoa, responda todas as afirmações e marque o aceite.', 'erro'); return res.redirect('/comportamental/responder'); }
    const pendente = c && lista(req).find(p => p.status === 'Aguardando' && p.colaborador_id === id);
    const novoId = tx(() => {
      let alvo = pendente?.id;
      if (pendente) R.atualizar(req.office, 'perfil', pendente.id, respondido(R.soDados(pendente), r));
      else alvo = novoRegistro(respondido({ vinculo: c ? 'Colaborador' : 'Candidato', colaborador_id: c?.id, nome, email, tipo_envio: 'Aplicação presencial' }, r), req.office, req.user.name);
      auditar(req, 'Registrou respostas', 'perfil', alvo);
      return alvo;
    });
    flash(res, 'Respostas salvas.');
    res.redirect(`/comportamental/perfis/${novoId}`);
  }));

  // -------------------------------------------------------------- engenharia de cargo
  app.get('/comportamental/cargos', h((req, res) => {
    const feitos = respondidos(lista(req)).filter(p => p.vinculo === 'Colaborador');
    const colabs = req.c.listar('colaborador').filter(c => c.situacao === 'Ativo');
    const linhas = req.c.listar('cargo').sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map(cg => {
      const pessoas = colabs.filter(c => c.cargo_id === cg.id);
      const dele = feitos.filter(p => pessoas.some(c => c.id === p.colaborador_id));
      const ader = cg.perfil_esperado && dele.length ? `${Math.round(M.media(dele.map(p => P.aderencia(p.pontos, P.alvo(cg.perfil_esperado)))))}%` : '';
      return [html`<a href="/cad/cargos/${cg.id}">${cg.nome}</a>`, nomeEstilo(cg.perfil_esperado) || 'Não definido', pessoas.length, dele.length, ader];
    });
    res.send(layout(req, 'Engenharia de Cargo', tabela(['Cargo', 'Perfil esperado', 'Pessoas', 'Responderam', 'Aderência média'], linhas, 'Nenhum cargo cadastrado.'), { migalha: MIGALHA, descricao: 'Abra o cargo para definir o perfil esperado.' }));
  }));

  // -------------------------------------------------------------- busca
  const TIPOS_BUSCA = [['estilo', 'Por estilo'], ['cargo', 'Por cargo'], ['indicador', 'Por indicador'], ['personalizado', 'Personalizada']];
  app.get('/comportamental/busca', h((req, res) => {
    const q = req.query, tipo = TIPOS_BUSCA.some(t => t[0] === q.tipo) ? q.tipo : 'estilo';
    const cargos = req.c.listar('cargo').filter(c => c.perfil_esperado);
    const estilos = P.CHAVES.map(e => [e, nomeEstilo(e)]);
    const num = e => Math.min(100, Math.max(0, Number(um(q[e])) || 0));
    const criterio = {
      estilo: () => campo('Estilo', select('estilo', estilos, q.estilo)),
      cargo: () => campo('Cargo com perfil esperado', select('cargo', cargos.map(c => [c.id, c.nome]), q.cargo)),
      indicador: () => html`${campo('Estilo', select('estilo', estilos, q.estilo))}${campo('Faixa', select('faixa', P.ORDEM_FAIXAS, q.faixa))}`,
      personalizado: () => html`${P.CHAVES.map(e => campo(`${nomeEstilo(e)} (0 a 100)`, html`<input type="number" name="${e}" min="0" max="100" value="${q[e] ?? 50}">`))}`,
    }[tipo]();
    let resultado = html`<div class="aviso alerta">Escolha o critério e clique em Buscar.</div>`;
    if (q.buscar) {
      let itens = respondidos(lista(req)), meta = null;
      if (tipo === 'estilo' && P.ESTILOS[q.estilo]) meta = P.alvo(q.estilo);
      if (tipo === 'cargo') { const c = cargos.find(x => x.id === Number(q.cargo)); if (c) meta = P.alvo(c.perfil_esperado); }
      if (tipo === 'personalizado') meta = Object.fromEntries(P.CHAVES.map(e => [e, num(e)]));
      if (tipo === 'indicador' && P.ESTILOS[q.estilo]) itens = itens.filter(p => P.faixa(p.pontos[q.estilo]) === q.faixa).sort((a, b) => b.pontos[q.estilo] - a.pontos[q.estilo]);
      const linhas = (meta ? itens.map(p => ({ p, a: P.aderencia(p.pontos, meta) })).sort((x, y) => y.a - x.a) : itens.map(p => ({ p, a: tipo === 'indicador' ? p.pontos[q.estilo] : null })))
        .map(({ p, a }) => [html`<a href="/comportamental/perfis/${p.id}">${p.nome}</a>`, p.vinculo, P.nomePerfil(p), a === null ? '' : tipo === 'indicador' ? a : `${a}%`]);
      resultado = tabela(['Nome', 'Vínculo', 'Perfil', tipo === 'indicador' ? 'Pontos' : 'Aderência'], linhas, 'Nenhuma pessoa encontrada.');
    }
    res.send(layout(req, 'Busca de Perfil', html`<div class="abas">${TIPOS_BUSCA.map(([v, t]) => html`<a href="?tipo=${v}" class="${v === tipo ? 'ativo' : ''}">${t}</a>`)}</div>
      <form method="get" class="card"><input type="hidden" name="tipo" value="${tipo}"><input type="hidden" name="buscar" value="1"><div class="grade">${criterio}</div>
      <div class="acoes"><button class="botao">Buscar</button></div></form>${resultado}`, { migalha: MIGALHA, descricao: 'Encontre quem mais se aproxima de um perfil.' }));
  }));

  // -------------------------------------------------------------- comparar
  app.get('/comportamental/comparar', h((req, res) => {
    const pessoas = respondidos(lista(req)), cargos = req.c.listar('cargo').filter(c => c.perfil_esperado);
    const opcoes = [['', '- selecione -'], ...pessoas.map(p => [`p${p.id}`, `${p.nome} (${p.vinculo})`]), ...cargos.map(c => [`c${c.id}`, `Cargo: ${c.nome}`])];
    const ler = v => {
      const m = String(um(v) || '').match(/^([pc])(\d+)$/);
      if (!m) return null;
      if (m[1] === 'p') { const p = pessoas.find(x => x.id === Number(m[2])); return p && { nome: p.nome, pontos: p.pontos }; }
      const c = cargos.find(x => x.id === Number(m[2]));
      return c && { nome: `Cargo: ${c.nome}`, pontos: P.alvo(c.perfil_esperado) };
    };
    const a = ler(req.query.a), b = ler(req.query.b);
    const resultado = a && b ? html`<div class="cards4">${cartao('Aderência', `${P.aderencia(a.pontos, b.pontos)}%`)}</div>
      ${tabela(['Estilo', a.nome, b.nome, 'Diferença'], P.CHAVES.map(e => [nomeEstilo(e), a.pontos[e], b.pontos[e], Math.abs(a.pontos[e] - b.pontos[e])]))}` : html`<div class="aviso alerta">Escolha duas pessoas, ou uma pessoa e um cargo.</div>`;
    res.send(layout(req, 'Comparar Perfis', html`<form method="get" class="card"><div class="grade">${campo('Perfil 1', select('a', opcoes, req.query.a))}${campo('Perfil 2', select('b', opcoes, req.query.b))}</div>
      <div class="acoes"><button class="botao">Comparar</button></div></form>${resultado}`, { migalha: MIGALHA, descricao: 'Compara duas pessoas, ou uma pessoa e o perfil esperado de um cargo.' }));
  }));

  // -------------------------------------------------------------- grupos
  app.get('/comportamental/grupos', h((req, res) => {
    const pessoas = respondidos(lista(req));
    const salvo = req.query.grupo ? R.obter(req.office, 'perfil_grupo', req.query.grupo) : null;
    const ids = new Set(salvo ? salvo.perfis : [].concat(req.query.ids ?? []).map(Number));
    const sel = pessoas.filter(p => ids.has(p.id));
    const menor = sel.length ? [...P.CHAVES].sort((x, y) => P.mediaPontos(sel)[x] - P.mediaPontos(sel)[y])[0] : null;
    const resultado = sel.length ? html`<div class="cards4">${cartao('Pessoas', sel.length)}${cartao('Estilo mais presente', M.contar(sel, p => nomeEstilo(p.principal))[0][0])}${cartao('Estilo menos presente', nomeEstilo(menor), P.ESTILOS[menor].resumo)}</div>
      <div class="grade-2"><div class="card"><h3 class="primeiro">Média do grupo</h3>${barrasPontos(P.mediaPontos(sel))}</div><div class="card"><h3 class="primeiro">Estilo principal</h3>${distribuicao(sel)}</div></div>
      ${pode(req.papel, 'edita') && !salvo ? html`<form method="post" class="card">${[...ids].map(i => html`<input type="hidden" name="ids" value="${i}">`)}${campo('Nome para salvar este grupo', html`<input name="nome" required maxlength="120">`)}<div class="acoes"><button class="botao sec">Salvar grupo</button></div></form>` : ''}
      ${salvo && pode(req.papel, 'apaga') ? html`<form method="post" action="/comportamental/grupos/${salvo.id}/apagar" data-confirmar="Apagar este grupo?"><button class="botao sec">Apagar grupo</button></form>` : ''}` : html`<div class="aviso alerta">Selecione as pessoas e clique em Analisar.</div>`;
    res.send(layout(req, salvo ? `Análise de Grupo: ${salvo.nome}` : 'Análise de Grupo', html`<form method="get" class="card">
      ${campo('Pessoas (segure Ctrl para marcar várias)', html`<select name="ids" multiple size="10">${pessoas.map(p => html`<option value="${p.id}" ${ids.has(p.id) ? 'selected' : ''}>${p.nome} (${p.vinculo})</option>`)}</select>`)}
      <div class="acoes"><button class="botao">Analisar</button></div></form>${resultado}`, { migalha: MIGALHA, descricao: 'Veja o equilíbrio de estilos de um time ou de um grupo de candidatos.' }));
  }));
  app.post('/comportamental/grupos', exige('edita'), h((req, res) => {
    const nome = texto(req.body.nome).slice(0, 120), validos = new Set(lista(req).map(p => p.id));
    const perfis = [...new Set([].concat(req.body.ids ?? []).map(Number))].filter(i => validos.has(i));
    if (!nome || !perfis.length) { flash(res, 'Informe o nome e ao menos uma pessoa.', 'erro'); return res.redirect('/comportamental/grupos'); }
    const id = tx(() => { const n = R.criar(req.office, 'perfil_grupo', { nome, perfis }, req.user.name); auditar(req, 'Criou', 'perfil_grupo', n); return n; });
    flash(res, 'Grupo salvo.');
    res.redirect(`/comportamental/grupos?grupo=${id}`);
  }));
  app.post('/comportamental/grupos/:id(\\d+)/apagar', exige('apaga'), h((req, res) => {
    if (!R.obter(req.office, 'perfil_grupo', req.params.id)) throw falha(404, 'Grupo não encontrado.');
    tx(() => { R.apagar(req.office, 'perfil_grupo', req.params.id); auditar(req, 'Apagou', 'perfil_grupo', Number(req.params.id)); });
    flash(res, 'Grupo apagado.');
    res.redirect('/comportamental/metricas?aba=grupos');
  }));

  // -------------------------------------------------------------- extrato
  app.get('/comportamental/extrato', h((req, res) => {
    const todos = R.listar(req.office, 'perfil', { inativos: true });
    const eventos = todos.flatMap(p => [
      { data: p.data_envio, acao: 'Envio', p },
      ...(p.data_resposta ? [{ data: p.data_resposta, acao: 'Resposta', p }] : []),
    ]).sort((a, b) => b.data.localeCompare(a.data) || b.p.id - a.p.id);
    const ativos = todos.filter(p => p.ativo);
    res.send(layout(req, 'Extrato de Envios', html`<div class="cards4">${cartao('Enviados', todos.length)}${cartao('Respondidos', respondidos(ativos).length)}
      ${cartao('Aguardando', ativos.filter(p => p.status === 'Aguardando').length)}${cartao('Apagados', todos.length - ativos.length)}</div>
      ${tabela(['Data', 'Ação', 'Pessoa', 'Tipo de envio', 'Solicitante', 'ID'], eventos.map(e => [dataBr(e.data), e.acao, e.p.nome, e.p.tipo_envio, e.p.criado_por, e.p.id]), 'Nenhum envio ainda.')}`,
    { migalha: MIGALHA, descricao: 'Histórico de envios e respostas. Aqui não há consumo de créditos.' }));
  }));
}

module.exports = { publicas, internas };

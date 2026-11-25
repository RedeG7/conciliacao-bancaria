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
const G = require('./graficos');
const PF = require('./profiler');
const SP = require('./solides_profiler');
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
const blocoPerguntas = () => html`<p class="desc">Dê uma nota de 0 a 10 para cada frase: 0 = discordo totalmente, 10 = concordo totalmente.</p>
  ${P.QUESTOES.map((q, i) => html`<div class="pergunta"><p><b>${i + 1}. ${q.texto}</b></p><div class="escala-caixa"><div class="escala">
  ${P.ESCALA.map(([v, t]) => html`<label><input type="radio" name="q${i}" value="${v}" required>${t}</label>`)}</div>
  <div class="escala-pontas" aria-hidden="true"><span>Discordo totalmente</span><span>Concordo totalmente</span></div></div></div>`)}`;
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

  // -------------------------------------------------------------- gráficos
  const SERIES = P.CHAVES.map((e, i) => ({ nome: nomeEstilo(e), cls: `s${i + 1}` }));
  const cartaoGrafico = (titulo, corpo, nota = '') => html`<div class="card"><h3 class="primeiro">${titulo}</h3>${nota ? html`<p class="desc">${nota}</p>` : ''}${corpo}</div>`;
  const porEstilo = itens => P.CHAVES.map(e => itens.filter(p => p.principal === e).length);
  const mesCurto = m => `${['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'][Number(m.slice(5)) - 1]}/${m.slice(2, 4)}`;
  function graficoMeses(feitos) {
    if (!feitos.length) return html`<p class="desc">Nenhuma resposta no período.</p>`;
    const datas = feitos.map(p => p.data_resposta.slice(0, 7)).sort();
    const meses = P.mesesEntre(datas[0], datas[datas.length - 1]).slice(-12);
    return G.colunas({ titulo: 'Respostas por mês e estilo principal', series: SERIES, cats: meses.map(m => ({ rotulo: mesCurto(m), valores: porEstilo(feitos.filter(p => p.data_resposta.startsWith(m))) })) });
  }
  function porGrupoColab(req, itens, campoId, kind) {
    const m = new Map();
    for (const p of itens) {
      const id = colabDe(req, p)?.[campoId];
      if (id) m.set(id, [...(m.get(id) || []), p]);
    }
    return [...m].map(([id, l]) => ({ rotulo: req.c.nome(kind, id), lista: l })).sort((a, b) => b.lista.length - a.lista.length || a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
  }
  // nome do perfil, peso de cada estilo e a composição em uma barra só
  function painelGeral(itens) {
    const g = P.perfilGeral(itens);
    return html`<div class="card vg-geral"><small>Perfil geral</small><h2>${g.nome}</h2>
      ${G.segmentada(g.pesos.map(x => ({ nome: nomeEstilo(x.estilo), cls: `s${P.CHAVES.indexOf(x.estilo) + 1}`, valor: x.peso })))}
      <div class="vg-pesos">${g.pesos.map(x => html`<div><i class="vg-s${P.CHAVES.indexOf(x.estilo) + 1}"></i><b>${String(x.peso).replace('.', ',')}%</b><span>${nomeEstilo(x.estilo)}</span><small>${x.peso >= 25 ? 'Dominante' : 'Complementar'}</small></div>`)}</div>
      <p class="desc">Peso de cada estilo no grupo. Acima de 25% o estilo é dominante.</p></div>`;
  }
  const graficosEstilos = itens => html`<div class="grade-2">
    ${cartaoGrafico('Estilo principal', G.barrasH(P.CHAVES.map((e, i) => ({ rotulo: nomeEstilo(e), valor: porEstilo(itens)[i], texto: `${porEstilo(itens)[i]} (${Math.round((porEstilo(itens)[i] / itens.length) * 100)}%)`, cls: `s${i + 1}` }))), 'Quantas pessoas têm cada estilo como principal.')}
    ${cartaoGrafico('Média de pontos por estilo', G.barrasH(P.CHAVES.map((e, i) => ({ rotulo: nomeEstilo(e), valor: P.mediaPontos(itens)[e], texto: `${P.mediaPontos(itens)[e]} (${P.faixa(P.mediaPontos(itens)[e])})`, cls: `s${i + 1}` })), { maximo: 100 }), 'Escala de 0 a 100.')}</div>`;
  const histogramas = itens => html`<div class="vg-multi">${P.CHAVES.map((e, i) => {
    const h2 = P.histograma(itens, e);
    return cartaoGrafico(`Distribuição: ${nomeEstilo(e)}`, G.colunas({ titulo: `Pessoas por faixa de pontos em ${nomeEstilo(e)}`, series: [SERIES[i]], cats: h2.map(x => ({ rotulo: x.rotulo, valores: [x.total] })) }));
  })}</div>`;

  // -------------------------------------------------------------- métricas
  const ABAS_METRICAS = [['participacao', 'Participação'], ['empresa', 'Perfil da Empresa'], ['grupos', 'Análise dos Grupos']];
  app.get('/comportamental/metricas', h((req, res) => {
    const aba = ABAS_METRICAS.some(a => a[0] === req.query.aba) ? req.query.aba : 'participacao';
    let corpo;
    if (aba === 'participacao') {
      const itens = filtrar(req, lista(req), 'data_envio'), feitos = respondidos(itens), taxa = itens.length ? Math.round((feitos.length / itens.length) * 100) : 0;
      const deptos = porGrupoColab(req, itens, 'departamento_id', 'departamento').map(g => {
        const r = respondidos(g.lista).length;
        return { rotulo: g.rotulo, valor: Math.round((r / g.lista.length) * 100), texto: `${Math.round((r / g.lista.length) * 100)}% (${r} de ${g.lista.length})` };
      });
      corpo = html`${formFiltros(req, aba)}<div class="cards4">${cartao('Enviados', itens.length)}${cartao('Respondidos', feitos.length)}${cartao('Aguardando', itens.length - feitos.length)}</div>
        <div class="grade-2">${cartaoGrafico('Taxa de participação', G.medidor(taxa, `${feitos.length} de ${itens.length} responderam`))}
        ${cartaoGrafico('Participação por departamento', G.barrasH(deptos, { maximo: 100, vazio: 'Nenhum colaborador neste filtro.' }))}</div>
        ${cartaoGrafico('Distribuição de perfis por mês', graficoMeses(feitos), 'Considera a data de resposta.')}`;
    } else if (aba === 'empresa') {
      const itens = filtrar(req, respondidos(lista(req)).filter(p => p.vinculo === 'Colaborador'), 'data_resposta');
      if (!itens.length) corpo = html`${formFiltros(req, aba, { vinculo: false })}<div class="aviso alerta">Nenhum colaborador respondeu com esses filtros.</div>`;
      else {
        const ativos = req.c.listar('colaborador').filter(c => c.situacao === 'Ativo');
        const ehLider = p => ativos.some(c => c.superior_id && c.superior_id === p.colaborador_id);
        const lideres = itens.filter(ehLider), equipe = itens.filter(p => !ehLider(p));
        const cargos = porGrupoColab(req, itens, 'cargo_id', 'cargo').map(g => {
          const c = req.c.listar('cargo').find(x => x.nome === g.rotulo);
          return c?.perfil_esperado ? { rotulo: g.rotulo, valor: Math.round(M.media(g.lista.map(p => P.aderencia(p.pontos, P.alvo(c.perfil_esperado))))) } : null;
        }).filter(Boolean).sort((a, b) => b.valor - a.valor).map(x => ({ ...x, texto: `${x.valor}%` }));
        corpo = html`${formFiltros(req, aba, { vinculo: false })}${painelGeral(itens)}${graficosEstilos(itens)}
          ${cartaoGrafico('Estilos por departamento', G.barras100(porGrupoColab(req, itens, 'departamento_id', 'departamento').map(g => ({ rotulo: g.rotulo, valores: porEstilo(g.lista) })), SERIES), 'Composição de cada área. O número à direita é o total de pessoas.')}
          <div class="grade-2">${cartaoGrafico('Liderança x equipe', lideres.length && equipe.length ? G.colunas({ titulo: 'Média de pontos da liderança e da equipe', empilhado: false, topo: 100, series: [{ nome: 'Liderança', cls: 's1' }, { nome: 'Equipe', cls: 's2' }], cats: P.CHAVES.map(e => ({ rotulo: nomeEstilo(e), valores: [P.mediaPontos(lideres)[e], P.mediaPontos(equipe)[e]] })) }) : html`<p class="desc">Preencha o superior direto dos colaboradores para ver esta comparação.</p>`, 'Média de pontos de quem é superior direto e dos demais.')}
          ${cartaoGrafico('Aderência por cargo', G.barrasH(cargos, { maximo: 100, vazio: 'Defina o perfil esperado em Engenharia de Cargo.' }), 'Média das pessoas do cargo frente ao perfil esperado.')}</div>
          ${histogramas(itens)}`;
      }
    } else {
      const todos = respondidos(lista(req));
      const grupos = R.listar(req.office, 'perfil_grupo').map(g => ({ ...g, pessoas: todos.filter(p => g.perfis.includes(p.id)) }));
      corpo = html`<div class="acoes"><a class="botao" href="/comportamental/grupos">Criar grupo</a></div>
        ${cartaoGrafico('Composição dos grupos salvos', G.barras100(grupos.filter(g => g.pessoas.length).map(g => ({ rotulo: g.nome, valores: porEstilo(g.pessoas) })), SERIES, { vazio: 'Nenhum grupo salvo. Crie um em Análise de Grupo.' }))}
        ${tabela(['Grupo', 'Pessoas', 'Perfil geral', 'Criado por'], grupos.map(g => [html`<a href="/comportamental/grupos?grupo=${g.id}">${g.nome}</a>`, g.pessoas.length, g.pessoas.length ? P.perfilGeral(g.pessoas).nome : '', g.criado_por]), 'Nenhum grupo salvo.')}`;
    }
    res.send(layout(req, 'Métricas do Perfil', html`${abasDe(ABAS_METRICAS, aba)}${corpo}`, { migalha: MIGALHA, descricao: 'Participação e distribuição dos perfis da empresa.' }));
  }));

  // -------------------------------------------------------------- perfis (Profiler)
  // cargo e departamento do colaborador vinculado, para o cabeçalho e o relatório
  const infoColab = (req, p) => {
    const c = colabDe(req, p);
    return c ? { cargo: req.c.nome('cargo', c.cargo_id), departamento: req.c.nome('departamento', c.departamento_id), cargoReg: req.c.registro('cargo', c.cargo_id) } : null;
  };
  // menu de 3 pontos de cada perfil
  const menuPerfil = (req, p, { classe = '' } = {}) => {
    const feito = p.status === 'Respondido';
    return html`<details class="kebab ${classe}"><summary aria-label="Ações de ${p.nome}" title="Ações">⋮</summary><div class="kebab-menu" role="menu">
      ${feito ? html`<a role="menuitem" href="/comportamental/perfis/${p.id}"><span aria-hidden="true">👁</span>Visualizar Profiler</a>` : html`<a role="menuitem" href="/comportamental/perfis/${p.id}"><span aria-hidden="true">🔗</span>Ver link de resposta</a>`}
      ${pode(req.papel, 'edita') ? html`<a role="menuitem" href="/comportamental/perfis/${p.id}/editar"><span aria-hidden="true">✏️</span>Editar dados Profiler</a>` : ''}
      ${feito ? html`<a role="menuitem" href="/comportamental/perfis/${p.id}/relatorio.pdf"><span aria-hidden="true">⬇</span>Baixar relatório Profiler</a>` : html`<span class="kebab-off" title="Disponível depois da resposta"><span aria-hidden="true">⬇</span>Baixar relatório Profiler</span>`}
      ${pode(req.papel, 'apaga') ? html`<form method="post" action="/comportamental/perfis/${p.id}/apagar" data-confirmar="Apagar este perfil?"><button class="kebab-perigo"><span aria-hidden="true">🗑</span>Apagar</button></form>` : ''}
    </div></details>`;
  };

  app.get('/comportamental/perfis', h((req, res) => {
    const todos = lista(req), estilo = P.ESTILOS[req.query.estilo] ? req.query.estilo : '', vinculo = texto(req.query.vinculo);
    const base = todos.filter(p => (!estilo || p.principal === estilo) && (!vinculo || p.vinculo === vinculo));
    const dessa = a => base.filter(p => a === 'Todos' || (a === 'Respondidos' ? p.status === 'Respondido' : p.status === 'Aguardando'));
    const ativa = ABAS_PERFIS.includes(req.query.aba) ? req.query.aba : 'Todos';
    const feitos = respondidos(todos);
    const ordenados = dessa(ativa).sort((a, b) => (b.data_resposta || b.data_envio || '').localeCompare(a.data_resposta || a.data_envio || '') || a.nome.localeCompare(b.nome, 'pt-BR'));
    const linhas = ordenados.map(p => {
      const info = infoColab(req, p);
      return [html`<div class="pf-pessoa">${PF.avatar(p)}<div><a href="/comportamental/perfis/${p.id}">${p.nome}</a><small>${p.email || ''}</small></div></div>`,
        PF.selos(p), p.vinculo, info?.cargo || '', dataBr(p.data_resposta) || html`<span class="desc">Enviado em ${dataBr(p.data_envio)}</span>`, menuPerfil(req, p)];
    });
    const qs = (o = {}) => new URLSearchParams({ aba: ativa, estilo, vinculo, ...o }).toString();
    res.send(layout(req, 'Profiler', html`
      <div class="pf-kpis">
        <div class="card"><small>Perfis</small><b>${todos.length}</b></div>
        <div class="card"><small>Respondidos</small><b>${feitos.length}</b></div>
        <div class="card"><small>Aguardando</small><b>${todos.length - feitos.length}</b></div>
        ${P.CHAVES.map(e => html`<a class="card pf-kpi-estilo ${estilo === e ? 'ativo' : ''}" href="?${qs({ estilo: estilo === e ? '' : e })}"><small><i class="vg-${'s' + (P.CHAVES.indexOf(e) + 1)}"></i>${nomeEstilo(e)}</small><b>${feitos.filter(p => p.principal === e).length}</b></a>`)}
      </div>
      <div class="card pf-lista-card">
        <div class="pf-barra">
          <nav class="pf-abas-lista">${ABAS_PERFIS.map(a => html`<a href="?${qs({ aba: a })}" class="${a === ativa ? 'ativo' : ''}">${a}<span>${dessa(a).length}</span></a>`)}</nav>
          <form method="get" class="pf-filtros"><input type="hidden" name="aba" value="${ativa}">
            ${select('estilo', [['', 'Todos os estilos'], ...P.CHAVES.map(e => [e, nomeEstilo(e)])], estilo, 'aria-label="Estilo principal" onchange="this.form.submit()"')}
            ${select('vinculo', [['', 'Todos os vínculos'], 'Colaborador', 'Candidato'], vinculo, 'aria-label="Vínculo" onchange="this.form.submit()"')}
            <noscript><button class="botao sec pequeno">Filtrar</button></noscript></form>
          <div class="pf-botoes">${pode(req.papel, 'edita') ? html`<a class="botao" href="/comportamental/enviar">+ Enviar questionário</a><a class="botao sec" href="/comportamental/importar-solides">Importar resultados</a>` : ''}<a class="botao sec" href="/comportamental/perfis/exportar">Exportar CSV</a></div>
        </div>
        ${tabela(['Nome', 'Perfil', 'Vínculo', 'Cargo', 'Respondido em', ''], linhas, 'Nenhum perfil aqui.')}
      </div>`, { migalha: MIGALHA, descricao: AVISO }));
  }));
  app.get('/comportamental/perfis/exportar', h((req, res) => {
    auditar(req, 'Exportou', 'perfil');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="perfis-comportamentais.csv"' }).send(csv(
      ['Nome', 'E-mail', 'Vínculo', 'Situação', 'Perfil', ...P.CHAVES.map(nomeEstilo), ...P.HABILIDADES.map(x => x.nome), 'Envio', 'Resposta'],
      lista(req).map(p => [p.nome, p.email, p.vinculo, p.status, P.nomePerfil(p), ...P.CHAVES.map(e => p.pontos?.[e] ?? ''), ...(p.pontos ? P.habilidades(p.pontos).map(x => x.valor) : P.HABILIDADES.map(() => '')), dataBr(p.data_envio), dataBr(p.data_resposta)])));
  }));

  // Visualizar Profiler
  app.get('/comportamental/perfis/:id(\\d+)', h((req, res) => {
    const p = carregar(req);
    let corpo;
    if (p.status === 'Aguardando') {
      const link = `${baseUrl(req)}/perfil/${p.token}`;
      const carta = `Olá, ${p.nome}. Por favor, responda ao questionário de perfil comportamental neste link: ${link}`;
      corpo = html`<div class="pf-cabeca card">${PF.avatar(p)}<div class="pf-cabeca-txt"><h2>${p.nome}</h2><p>${p.vinculo}</p>${PF.selos(p)}</div>${menuPerfil(req, p)}</div>
        <div class="card"><small>Link individual, aguardando resposta</small>
        <div class="copiar"><input id="linkPerfil" value="${link}" readonly aria-label="Link do questionário"><button type="button" class="botao sec" data-copiar="linkPerfil">Copiar</button></div>
        ${p.email ? html`<div class="acoes"><a class="botao sec" href="mailto:${p.email}?subject=${encodeURIComponent('Perfil comportamental')}&body=${encodeURIComponent(carta)}">Abrir no e-mail</a></div>` : ''}</div>`;
    } else {
      const info = infoColab(req, p);
      corpo = html`${PF.visualizar(p, { cargo: info?.cargoReg, colab: info, menu: menuPerfil(req, p) })}
        <div class="acoes"><a class="botao" href="/comportamental/perfis/${p.id}/relatorio.pdf">⬇ Baixar relatório Profiler</a><a class="botao sec" href="/comportamental/perfis">Voltar</a></div>`;
    }
    res.send(layout(req, 'Visualizar Profiler', corpo, { migalha: 'Profiler', descricao: AVISO }));
  }));

  // Baixar relatório Profiler (PDF)
  app.get('/comportamental/perfis/:id(\\d+)/relatorio.pdf', h((req, res) => {
    const p = carregar(req);
    if (p.status !== 'Respondido') throw falha(409, 'O relatório fica disponível depois que a pessoa responder.');
    const info = infoColab(req, p);
    const pdf = PF.relatorioPdf(p, { cargo: info?.cargoReg, colab: info, escritorio: req.officeRow?.name || '', aviso: AVISO });
    auditar(req, 'Baixou relatório', 'perfil', p.id);
    const arquivo = `profiler-${p.nome.normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || p.id}.pdf`;
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${arquivo}"`, 'Cache-Control': 'no-store' }).send(pdf);
  }));

  // Editar dados Profiler
  const telaEditar = (req, res, p, d = p, erro = '') => {
    const colabs = colabsAtivos(req);
    if (p.colaborador_id && !colabs.some(c => c.id === p.colaborador_id)) { const c = req.c.registro('colaborador', p.colaborador_id); if (c) colabs.push(c); }
    res.status(erro ? 422 : 200).send(layout(req, 'Editar dados Profiler', html`${erro ? html`<div class="aviso erro">${erro}</div>` : ''}
      <div class="pf-cabeca card">${PF.avatar(p)}<div class="pf-cabeca-txt"><h2>${p.nome}</h2><p>${p.vinculo}${p.data_resposta ? ` · respondido em ${dataBr(p.data_resposta)}` : ''}</p>${PF.selos(p)}</div></div>
      <form method="post" action="/comportamental/perfis/${p.id}/editar" class="card"><h3 class="primeiro">Dados da pessoa</h3>
        ${camposPessoa(d.nome, d.email || '')}
        <div class="grade">${campo('Vínculo', select('vinculo', ['Colaborador', 'Candidato'], d.vinculo))}
          ${campo('Colaborador vinculado', select('colaborador_id', [['', '- nenhum -'], ...colabs.map(c => [c.id, c.nome])], d.colaborador_id))}</div>
        <p class="desc">Ao vincular um colaborador, o relatório passa a mostrar o cargo, o departamento e a aderência ao perfil esperado do cargo.</p>
        ${p.status === 'Respondido' ? html`<h3>Resultado</h3><p class="desc">Os pontos vêm das respostas e não são editados à mão. Para refazer, aplique o questionário de novo em <a href="/comportamental/responder">Responder Perfil</a>.</p>
          <div class="pf-mini">${P.CHAVES.map(e => html`<span><i class="vg-s${P.CHAVES.indexOf(e) + 1}"></i>${nomeEstilo(e)} <b>${p.pontos[e]}</b></span>`)}</div>` : ''}
        <div class="acoes"><button class="botao">Salvar</button><a class="botao sec" href="/comportamental/perfis/${p.id}">Cancelar</a></div></form>`, { migalha: 'Profiler', descricao: AVISO }));
  };
  app.get('/comportamental/perfis/:id(\\d+)/editar', exige('edita'), h((req, res) => telaEditar(req, res, carregar(req))));
  const salvarDados = (req, res, p, volta) => {
    const nome = texto(req.body.nome).slice(0, 200), email = texto(req.body.email).slice(0, 200);
    const vinculo = ['Colaborador', 'Candidato'].includes(texto(req.body.vinculo)) ? texto(req.body.vinculo) : p.vinculo;
    const cid = 'colaborador_id' in req.body ? Number(texto(req.body.colaborador_id)) || null : p.colaborador_id ?? null;
    const d = { ...p, nome, email, vinculo, colaborador_id: cid };
    if (!nome || !emailOk(email)) return volta(d, 'Informe nome e e-mail válidos.');
    if (cid && !req.c.registro('colaborador', cid)) return volta(d, 'Colaborador não encontrado.');
    if (vinculo === 'Colaborador' && !cid && 'colaborador_id' in req.body) return volta(d, 'Para o vínculo Colaborador, escolha o colaborador.');
    const novos = { ...R.soDados(p), nome, email, vinculo, colaborador_id: vinculo === 'Candidato' ? null : cid };
    const mudou = [['nome', 'Nome'], ['email', 'E-mail'], ['vinculo', 'Vínculo'], ['colaborador_id', 'Colaborador']].filter(([k]) => (p[k] ?? null) !== (novos[k] ?? null)).map(x => x[1]).join(', ');
    tx(() => { R.atualizar(req.office, 'perfil', p.id, novos); auditar(req, 'Editou', 'perfil', p.id, mudou); });
    flash(res, 'Dados do Profiler salvos.');
    res.redirect(`/comportamental/perfis/${p.id}`);
  };
  app.post('/comportamental/perfis/:id(\\d+)/editar', exige('edita'), h((req, res) => {
    const p = carregar(req);
    salvarDados(req, res, p, (d, erro) => telaEditar(req, res, p, d, erro));
  }));
  // formulário antigo (só nome e e-mail) continua aceito
  app.post('/comportamental/perfis/:id(\\d+)', exige('edita'), h((req, res) => {
    const p = carregar(req);
    salvarDados(req, res, p, (d, erro) => { flash(res, erro, 'erro'); res.redirect(`/comportamental/perfis/${p.id}/editar`); });
  }));
  app.post('/comportamental/perfis/:id(\\d+)/apagar', exige('apaga'), h((req, res) => {
    const p = carregar(req);
    tx(() => { R.apagar(req.office, 'perfil', p.id); auditar(req, 'Apagou', 'perfil', p.id); });
    flash(res, 'Apagado.');
    res.redirect('/comportamental/perfis');
  }));

  // -------------------------------------------------------------- importar da Sólides
  // Recebe os resultados em JSON (lista de pessoas), mostra a prévia e só grava
  // quando a pessoa confirma.
  const lerImportacao = body => {
    try { const v = JSON.parse(texto(body.dados)); return Array.isArray(v) ? v.slice(0, 500) : null; } catch { return null; }
  };
  const telaImportar = (req, res, { dados = '', plano = null, erro = '' } = {}) => {
    const linhas = (plano || []).map(i => [i.nome, i.erro ? html`<span class="pdi-chip atraso">${i.erro}</span>` : html`${PF.selos({ principal: i.conv.principal, secundario: i.conv.secundario })} <small>${i.conv.solides.letra}</small>`,
      i.colab ? i.colab.nome : html`<span class="desc">sem vínculo</span>`, i.erro ? '' : i.perfil ? 'Atualiza o perfil existente' : 'Cria perfil novo', dataBr(i.resposta)]);
    res.status(erro ? 422 : 200).send(layout(req, 'Importar Profiler da Sólides', html`${erro ? html`<div class="aviso erro">${erro}</div>` : ''}
      <form method="post" action="/comportamental/importar-solides" class="card">
        <p class="desc">Cole os resultados em JSON. Antes de gravar aparece a prévia com o perfil de cada pessoa e o colaborador vinculado (pelo e-mail ou pelo nome).
          Perfis respondidos no questionário daqui não são alterados: nesse caso entra um perfil novo.</p>
        ${campo('Resultados (JSON)', html`<textarea name="dados" rows="${plano ? 3 : 10}" required>${dados}</textarea>`)}
        ${plano ? html`${tabela(['Pessoa', 'Perfil', 'Colaborador', 'O que acontece', 'Respondido em'], linhas, 'Nada para importar.')}
          <div class="acoes"><button class="botao" name="acao" value="gravar">Gravar ${plano.filter(i => !i.erro).length} perfis</button><button class="botao sec" name="acao" value="previa">Atualizar prévia</button></div>`
        : html`<div class="acoes"><button class="botao" name="acao" value="previa">Ver prévia</button></div>`}
      </form>`, { migalha: 'Profiler', descricao: AVISO }));
  };
  app.get('/comportamental/importar-solides', exige('edita'), h((req, res) => telaImportar(req, res)));
  app.post('/comportamental/importar-solides', exige('edita'), h((req, res) => {
    const pessoas = lerImportacao(req.body), dados = texto(req.body.dados);
    if (!pessoas) return telaImportar(req, res, { dados, erro: 'O conteúdo não é uma lista em JSON.' });
    const plano = SP.planejar(pessoas, { colaboradores: req.c.listar('colaborador', { inativos: true }), perfis: lista(req) });
    if (texto(req.body.acao) !== 'gravar') return telaImportar(req, res, { dados, plano });
    let novos = 0, atualizados = 0;
    tx(() => {
      for (const i of plano.filter(x => !x.erro)) {
        if (i.perfil) { R.atualizar(req.office, 'perfil', i.perfil.id, SP.dadosPerfil(i, R.soDados(i.perfil))); atualizados++; } else { R.criar(req.office, 'perfil', SP.dadosPerfil(i, { token: R.novoToken(), tipo_envio: 'Importado da Sólides' }), req.user.name); novos++; }
      }
      auditar(req, 'Importou', 'perfil', null, `Sólides: ${novos} novos, ${atualizados} atualizados`);
    });
    flash(res, `Profiler importado: ${novos} perfis novos e ${atualizados} atualizados.`);
    res.redirect('/comportamental/perfis?aba=Respondidos');
  }));

  // -------------------------------------------------------------- envio
  const colabsAtivos = req => req.c.listar('colaborador').filter(c => c.situacao === 'Ativo').sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  app.get('/comportamental/enviar', exige('edita'), h((req, res) => {
    const link = `${baseUrl(req)}/perfil-aberto/${linkAberto(req.office)}`;
    res.send(layout(req, 'Enviar questionário', html`<form method="post" class="card"><h3 class="primeiro">Por lista</h3>
      <p class="desc">Cada pessoa recebe um link próprio. Quem já tem envio aguardando resposta não entra de novo.</p><div class="grade">
      ${campo('Colaboradores', html`<select name="colaboradores" multiple size="8">${colabsAtivos(req).map(c => html`<option value="${c.id}">${c.nome}</option>`)}</select>`)}
      ${campo('Candidatos (um por linha: Nome;E-mail)', html`<textarea id="candidatos" name="candidatos" rows="8" maxlength="50000"></textarea>`)}
      ${campo('Importar CSV com Nome e E-mail', html`<input type="file" accept=".csv,text/csv" class="ler-arquivo" data-alvo="candidatos">`)}</div>
      <div class="acoes"><button class="botao">Gerar links</button></div></form>
      <div class="card"><h3 class="primeiro">Link de preenchimento</h3><p class="desc">Um link só, para divulgar. Quem responder por ele entra como candidato.</p>
        <div class="copiar"><input id="linkAberto" value="${link}" readonly aria-label="Link de preenchimento"><button type="button" class="botao sec" data-copiar="linkAberto">Copiar</button></div>
        <form method="post" action="/comportamental/enviar/novo-link" data-confirmar="O link atual para de funcionar. Continuar?"><div class="acoes"><button class="botao sec">Trocar link</button></div></form></div>`,
    { migalha: MIGALHA, descricao: 'O RH ainda não envia e-mail: cada link pode ser copiado ou aberto no seu e-mail.' }));
  }));
  app.post('/comportamental/enviar', exige('edita'), h((req, res) => {
    const pendentes = lista(req).filter(p => p.status === 'Aguardando');
    const ids = [...new Set([].concat(req.body.colaboradores ?? []).map(Number))];
    const linhas = String(um(req.body.candidatos) || '').split(/\r?\n/).map(l => l.replace(/^\ufeff/, '').split(/[;,\t]/).map(x => x.trim())).filter(l => l[0])
      .filter((l, i) => i > 0 || !/^nome/i.test(l[0])); // cabeçalho do arquivo
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
      ${painelGeral(sel)}${graficosEstilos(sel)}
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

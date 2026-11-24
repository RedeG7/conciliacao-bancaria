'use strict';
// Telas do PDI: lista com filtros e menu de 3 pontos (Visualizar, Editar,
// Finalizar, Excluir) e a visualização da pessoa, com diagnóstico (perfil
// comportamental e competências da AVD), metas, últimos PDIs e feedbacks.
// Cadastro, edição e exclusão continuam no cadastro genérico (/cad/pdi/...).
const R = require('./db');
const { tx } = R;
const { ve, pode } = require('./acesso');
const { um } = require('./crud');
const M = require('./metricas');
const P = require('./comportamental');
const PF = require('./profiler');
const { hoje } = require('./datas');
const { html, raw, dataBr, layout, tabela, select, campo } = require('./views');
// notas da AVD são guardadas de 0 a 10; no PDI aparecem de 0 a 100
const n100 = v => String(Math.round(Number(v) * 10));

const ABAS = [['Aberto', 'PDIs abertos'], ['Em revisão', 'PDIs em revisão'], ['Finalizado', 'PDIs finalizados']];
const META_FEITA = ['sucesso', 'concluido', 'concluida', 'finalizado', 'finalizada', 'atingida'];
const sem = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const metaFeita = m => META_FEITA.includes(sem(m.status));
const metasDe = p => (Array.isArray(p.metas) ? p.metas : []);
const progressoDe = metas => (metas.length ? Math.round((metas.filter(metaFeita).length / metas.length) * 100) : null);
const atrasado = (p, dia) => p.status !== 'Finalizado' && p.entrega && p.entrega < dia;
const texto = v => String(um(v) ?? '').trim();
const meses = (de, ate) => { if (!de) return null; const [a1, m1, d1] = de.split('-').map(Number), [a2, m2, d2] = ate.split('-').map(Number); return (a2 - a1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0); };
const diasAte = (dia, ate) => Math.round((Date.parse(ate) - Date.parse(dia)) / 864e5);

const avatar = nome => html`<span class="pf-avatar pdi-av" aria-hidden="true">${PF.iniciais(nome)}</span>`;
const barraProg = (v, extra = '') => html`<div class="pdi-prog ${extra}" title="${v}% concluído"><div><i style="width:${v}%"></i></div><b>${v}%</b></div>`;
const chipStatus = (st, dia, p) => {
  if (p && atrasado(p, dia)) return html`<span class="pdi-chip atraso">Atrasado</span>`;
  const cls = { Aberto: 'andamento', 'Em revisão': 'revisao', Finalizado: 'feito' }[st] || 'andamento';
  return html`<span class="pdi-chip ${cls}">${st === 'Aberto' ? 'Em andamento' : st}</span>`;
};
const chipMeta = m => html`<span class="pdi-chip ${metaFeita(m) ? 'feito' : 'andamento'}">${m.status || 'Em andamento'}</span>`;

function rotas(app, { h, exige, auditar, flash, falha }) {
  const carregar = req => {
    const p = R.obter(req.office, 'pdi', req.params.id);
    if (!p) throw falha(404, 'PDI não encontrado.');
    return p;
  };
  // AVD ligada ao PDI: a do ciclo do PDI ou, sem ciclo, a mais recente da pessoa
  const avdDe = (c, p) => {
    const da = c.listar('avaliacao').filter(a => a.colaborador_id === p.colaborador_id);
    return da.find(a => a.ciclo_id && a.ciclo_id === p.ciclo_id) || da.sort((a, b) => String(b.data_resposta || b.criado_em).localeCompare(String(a.data_resposta || a.criado_em)))[0] || null;
  };

  const menu = (req, p, { classe = '' } = {}) => html`<details class="kebab ${classe}"><summary aria-label="Ações do PDI de ${req.c.nome('colaborador', p.colaborador_id)}" title="Ações">⋮</summary><div class="kebab-menu" role="menu">
    <a role="menuitem" href="/pdi/${p.id}"><span aria-hidden="true">👁</span>Visualizar</a>
    ${pode(req.papel, 'edita') ? html`<a role="menuitem" href="/cad/pdi/${p.id}"><span aria-hidden="true">✏️</span>Editar</a>
      <form method="post" action="/pdi/${p.id}/${p.status === 'Finalizado' ? 'reabrir' : 'finalizar'}" ${p.status === 'Finalizado' ? '' : raw('data-confirmar="Finalizar este PDI?"')}><button><span aria-hidden="true">${p.status === 'Finalizado' ? '↺' : '✓'}</span>${p.status === 'Finalizado' ? 'Reabrir' : 'Finalizar'}</button></form>` : ''}
    ${pode(req.papel, 'apaga') ? html`<form method="post" action="/cad/pdi/${p.id}/apagar" data-confirmar="Excluir este PDI? Ele sai das telas, mas continua guardado no histórico."><button class="kebab-perigo"><span aria-hidden="true">🗑</span>Excluir</button></form>` : ''}
  </div></details>`;

  // ------------------------------------------------------------ lista
  app.get('/cad/pdi', h((req, res) => {
    const c = req.c, dia = hoje(), q = req.query, n = k => Number(um(q[k])) || 0;
    const ativa = ABAS.some(a => a[0] === q.aba) ? q.aba : 'Aberto';
    const todos = c.listar('pdi');
    const pessoa = p => c.registro('colaborador', p.colaborador_id) || {};
    const filtrado = todos.filter(p => (!n('departamento_id') || pessoa(p).departamento_id === n('departamento_id'))
      && (!n('superior_id') || (p.superior_id || pessoa(p).superior_id) === n('superior_id'))
      && (!n('colaborador_id') || p.colaborador_id === n('colaborador_id'))
      && (!q.de || (p.inicio || '') >= q.de) && (!q.ate || (p.entrega || '9') <= q.ate));
    const lista = filtrado.filter(p => p.status === ativa).sort((a, b) => c.nome('colaborador', a.colaborador_id).localeCompare(c.nome('colaborador', b.colaborador_id), 'pt-BR'));
    const metas = lista.flatMap(metasDe);
    const prog = lista.map(p => p.progresso ?? progressoDe(metasDe(p)) ?? 0);
    const opc = (kind, filtro = () => true) => [['', 'Todos'], ...c.listar(kind).filter(filtro).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR')).map(r => [r.id, r.nome])];
    const colabs = c.listar('colaborador');
    const linhas = lista.map(p => {
      const pe = pessoa(p), avd = avdDe(c, p), sup = p.superior_id || pe.superior_id;
      return [html`<div class="pf-pessoa">${avatar(c.nome('colaborador', p.colaborador_id))}<div><a href="/pdi/${p.id}">${c.nome('colaborador', p.colaborador_id) || 'Colaborador removido'}</a><small>${c.nome('cargo', pe.cargo_id)}</small></div></div>`,
        html`<a class="pdi-titulo" href="/pdi/${p.id}" title="${p.titulo}">${p.titulo}</a>`, c.nome('colaborador', sup) || html`<span class="desc">-</span>`,
        html`<span class="pdi-prazo">${dataBr(p.inicio)}<br><span class="${atrasado(p, dia) ? 'pdi-atraso' : ''}">até ${dataBr(p.entrega)}</span></span>`,
        barraProg(p.progresso ?? progressoDe(metasDe(p)) ?? 0),
        avd ? html`<span class="pdi-avd" title="${c.nome('ciclo', avd.ciclo_id)}: desempenho ${n100(avd.desempenho)} de 100">${n100(avd.desempenho)}<small>${c.nome('ciclo', avd.ciclo_id)}</small></span>` : html`<span class="pdi-chip vazio">Não informada</span>`,
        menu(req, p)];
    });
    const qs = o => new URLSearchParams({ ...Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v === 'string' && v)), ...o }).toString();
    res.send(layout(req, 'PDI', html`
      <div class="pdi-topo"><nav class="pf-abas-lista">${ABAS.map(([v, r]) => html`<a href="?${qs({ aba: v })}" class="${v === ativa ? 'ativo' : ''}">${r}<span>${filtrado.filter(p => p.status === v).length}</span></a>`)}<a href="/cad/pdi/avaliados-sem-pdi">Avaliados sem PDI</a></nav>
        ${pode(req.papel, 'edita') ? html`<a class="botao" href="/cad/pdi/novo">+ Criar novo PDI</a>` : ''}</div>
      <div class="pf-kpis pdi-kpis">
        <div class="card"><small>PDIs nesta aba</small><b>${lista.length}</b></div>
        <div class="card"><small>Progresso médio</small><b>${prog.length ? Math.round(prog.reduce((s, v) => s + v, 0) / prog.length) : 0}%</b></div>
        <div class="card"><small>Metas concluídas</small><b>${metas.filter(metaFeita).length}<small> de ${metas.length}</small></b></div>
        <div class="card"><small>Atrasados</small><b class="${lista.some(p => atrasado(p, dia)) ? 'pdi-atraso' : ''}">${lista.filter(p => atrasado(p, dia)).length}</b></div>
      </div>
      <details class="card pdi-filtros" ${['departamento_id', 'superior_id', 'colaborador_id', 'de', 'ate'].some(k => q[k]) ? 'open' : ''}><summary><b>Filtrar colaboradores</b></summary>
        <form method="get"><input type="hidden" name="aba" value="${ativa}"><div class="grade">
          ${campo('Departamento', select('departamento_id', opc('departamento'), q.departamento_id))}
          ${campo('Superior direto', select('superior_id', opc('colaborador', x => colabs.some(o => o.superior_id === x.id) || todos.some(p => p.superior_id === x.id)), q.superior_id))}
          ${campo('Colaborador', select('colaborador_id', opc('colaborador', x => todos.some(p => p.colaborador_id === x.id)), q.colaborador_id))}
          ${campo('Início a partir de', html`<input type="date" name="de" value="${q.de || ''}">`)}${campo('Entrega até', html`<input type="date" name="ate" value="${q.ate || ''}">`)}</div>
          <div class="acoes"><button class="botao">Filtrar</button><a class="botao sec" href="?aba=${ativa}">Limpar</a></div></form></details>
      <div class="card pf-lista-card"><div class="pf-barra"><h3 class="primeiro pdi-h">Colaboradores</h3>
        <div class="pf-botoes">${pode(req.papel, 'edita') ? html`<a class="botao sec" href="/cad/pdi/importar">Importar CSV</a>` : ''}<a class="botao sec" href="/cad/pdi/exportar">Exportar CSV</a></div></div>
        ${tabela(['Colaborador', 'Título do PDI', 'Superior direto', 'Prazo', 'Progresso', 'Nota AVD', ''], linhas, 'Nenhum PDI nesta aba.')}</div>`,
    { migalha: 'Desenv. e Performance', descricao: 'Planos de desenvolvimento individual: metas, prazos e acompanhamento de cada pessoa.' }));
  }));

  // ------------------------------------------------------------ visualizar
  app.get('/pdi/:id(\\d+)', h((req, res) => {
    const c = req.c, p = carregar(req), dia = hoje(), editar = pode(req.papel, 'edita');
    const pe = c.registro('colaborador', p.colaborador_id) || {}, nome = c.nome('colaborador', p.colaborador_id) || 'Colaborador removido';
    const gestor = c.nome('colaborador', p.superior_id || pe.superior_id);
    const tempo = meses(pe.data_admissao, dia);
    const metas = metasDe(p), feitas = metas.filter(metaFeita).length;
    const progresso = p.progresso ?? progressoDe(metas) ?? 0;
    const feedbacks = c.listar('feedback').filter(f => f.colaborador_id === p.colaborador_id).sort((a, b) => String(b.data).localeCompare(String(a.data)));
    const outros = c.listar('pdi').filter(x => x.colaborador_id === p.colaborador_id).sort((a, b) => String(b.inicio).localeCompare(String(a.inicio)));

    // perfil comportamental da pessoa x média da área (mesmo departamento)
    let blocoPerfil = html`<p class="desc">Seu papel não permite ver o perfil comportamental.</p>`;
    if (ve(req.papel, 'perfil')) {
      const perfis = R.listar(req.office, 'perfil').filter(x => x.status === 'Respondido' && x.pontos);
      const dela = perfis.filter(x => x.colaborador_id === p.colaborador_id).sort((a, b) => String(b.data_resposta).localeCompare(String(a.data_resposta)))[0];
      const colegas = perfis.filter(x => x.colaborador_id && x.colaborador_id !== p.colaborador_id && c.registro('colaborador', x.colaborador_id)?.departamento_id === pe.departamento_id);
      blocoPerfil = dela ? html`<small class="desc">Respondido em ${dataBr(dela.data_resposta)} · ${PF.selos(dela)}</small>
          ${PF.radar(dela.pontos, { alvo: colegas.length ? P.mediaPontos(colegas) : null, tamanho: 300 })}
          <p class="desc pf-legenda-radar"><i class="pf-l-area"></i> ${nome.split(' ')[0]} ${colegas.length ? html`<i class="pf-l-alvo"></i> Média da área (${colegas.length})` : ''}</p>
          <div class="acoes"><a class="botao sec pequeno" href="/comportamental/perfis/${dela.id}">Visualizar Profiler</a><a class="botao sec pequeno" href="/comportamental/perfis/${dela.id}/relatorio.pdf">Baixar relatório Profiler</a></div>`
        : html`<p class="desc">${nome.split(' ')[0]} ainda não respondeu o perfil comportamental.</p>${editar ? html`<a class="botao sec pequeno" href="/comportamental/enviar">Enviar questionário</a>` : ''}`;
    }

    // competências com menor nota na AVD, com a média da área no mesmo ciclo
    const avd = avdDe(c, p);
    let blocoAvd = html`<p class="desc">Sem avaliação de desempenho para esta pessoa.</p>`;
    if (avd) {
      const itens = (avd.itens || []).filter(i => typeof i.nota === 'number');
      const daArea = c.listar('avaliacao').filter(a => a.ciclo_id === avd.ciclo_id && a.colaborador_id !== p.colaborador_id && c.registro('colaborador', a.colaborador_id)?.departamento_id === pe.departamento_id);
      const mediaArea = comp => { const v = daArea.flatMap(a => (a.itens || []).filter(i => sem(i.competencia) === sem(comp)).map(i => i.nota)); return v.length ? M.media(v) : null; };
      const menores = [...itens].sort((a, b) => a.nota - b.nota).slice(0, 4);
      const barra = (v, cls) => html`<div class="pdi-dupla ${cls}"><i style="width:${(v / 10) * 100}%"></i><b>${n100(v)}</b></div>`;
      blocoAvd = html`<small class="desc">${c.nome('ciclo', avd.ciclo_id)}${avd.data_resposta ? ` · respondido em ${dataBr(avd.data_resposta)}` : ''}</small>
        <div class="pdi-notas"><div><span>Desempenho</span><b>${n100(avd.desempenho)}</b></div><div><span>Comportamento</span><b>${avd.potencial == null ? '-' : n100(avd.potencial)}</b></div></div>
        ${menores.length ? html`${menores.map(i => { const ma = mediaArea(i.competencia); return html`<div class="pdi-comp"><span title="${i.competencia}">${i.competencia}</span>${barra(i.nota, 'pessoa')}${ma == null ? '' : barra(ma, 'area')}</div>`; })}
          <p class="desc pf-legenda-radar"><i class="pdi-l-pessoa"></i> ${nome.split(' ')[0]} <i class="pdi-l-area"></i> Média da área · escala de 0 a 100</p>` : html`<p class="desc">A avaliação não traz notas por competência.</p>`}
        ${ve(req.papel, 'pessoal') ? html`<a class="botao sec pequeno" href="/avaliacoes/${avd.id}">Ver todas as competências na avaliação</a>` : ''}`;
    }

    const restante = p.entrega ? diasAte(dia, p.entrega) : null;
    const anel = html`<div class="pdi-anel" style="--v:${progresso}"><b>${progresso}%</b><small>concluído</small></div>`;
    const cartaoMeta = (m, i) => html`<details class="pdi-meta ${metaFeita(m) ? 'feita' : ''}" ${metaFeita(m) ? '' : 'open'}><summary><span class="pdi-meta-n">${i + 1}</span><b>${m.meta}</b>${chipMeta(m)}</summary>
      <div class="pdi-meta-corpo"><dl>
        <div><dt>Entrega</dt><dd>${dataBr(m.entrega) || '-'}</dd></div><div><dt>Competência</dt><dd>${m.competencia || '-'}</dd></div>
        <div><dt>Treinamento</dt><dd>${m.treinamento || '-'}</dd></div></dl>
        ${m.acao ? html`<p><b>Ação:</b> ${m.acao}</p>` : ''}
        ${editar ? html`<form method="post" action="/pdi/${p.id}/metas/${i}"><input type="hidden" name="feita" value="${metaFeita(m) ? '0' : '1'}"><button class="botao ${metaFeita(m) ? 'sec' : ''} pequeno">${metaFeita(m) ? 'Reabrir meta' : '✓ Marcar como concluída'}</button></form>` : ''}</div></details>`;

    res.send(layout(req, 'Visualizar PDI', html`
      <div class="pf-cabeca card">${avatar(nome)}
        <div class="pf-cabeca-txt"><h2>${nome}</h2><p>${[gestor && `Gestor: ${gestor}`, c.nome('cargo', pe.cargo_id), c.nome('departamento', pe.departamento_id)].filter(Boolean).join(' · ')}</p>${chipStatus(p.status, dia, p)}</div>
        <div class="pf-cabeca-dados">${pe.data_admissao ? html`<small>Admissão</small><b>${dataBr(pe.data_admissao)}${tempo != null ? ` (${tempo} ${tempo === 1 ? 'mês' : 'meses'})` : ''}</b>` : ''}
          <small>Entrega do PDI</small><b class="${atrasado(p, dia) ? 'pdi-atraso' : ''}">${dataBr(p.entrega)}</b></div>
        ${menu(req, p)}</div>
      <div class="abas-form pf-abas"><button type="button" data-aba="diagnostico" class="ativo">Diagnóstico</button><button type="button" data-aba="metas">Metas e plano <span class="pdi-cont">${metas.length}</span></button><button type="button" data-aba="ultimos">Últimos PDIs <span class="pdi-cont">${outros.length}</span></button><button type="button" data-aba="feedbacks">Feedbacks <span class="pdi-cont">${feedbacks.length}</span></button></div>

      <div data-painel="diagnostico">
        <div class="pf-grade">
          <div class="card"><h3 class="primeiro">Comparativo comportamental</h3>${blocoPerfil}</div>
          <div class="card"><h3 class="primeiro">AVD: competências com menor nota</h3>${blocoAvd}</div>
        </div>
        <div class="card pdi-resumo">${anel}
          <div><h3 class="primeiro">Andamento do PDI</h3>
            <p>${metas.length ? `${feitas} de ${metas.length} meta(s) concluída(s).` : 'Nenhuma meta cadastrada ainda.'} ${restante == null ? '' : p.status === 'Finalizado' ? `Finalizado${p.finalizado_em ? ` em ${dataBr(p.finalizado_em)}` : ''}.` : restante >= 0 ? `Faltam ${restante} dia(s) para a entrega.` : `Entrega vencida há ${-restante} dia(s).`}</p>
            ${metas.length ? html`<div class="pdi-mini-metas">${metas.map(m => html`<span class="${metaFeita(m) ? 'feita' : ''}" title="${m.meta}: ${m.status || 'Em andamento'}"></span>`)}</div>` : ''}</div></div>
      </div>

      <div data-painel="metas" hidden>
        <div class="card"><div class="pdi-dados-topo"><h3 class="primeiro">Dados gerais</h3>${chipStatus(p.status, dia, p)}</div>
          <div class="pdi-dados"><div><small>Título do PDI</small><b>${p.titulo}</b></div><div><small>Início</small><b>${dataBr(p.inicio)}</b></div><div><small>Entrega</small><b>${dataBr(p.entrega)}</b></div><div><small>Progresso</small>${barraProg(progresso)}</div></div>
          <div class="pf-grade pdi-onde"><div><h4>Onde a pessoa está</h4><p>${p.situacao_atual || html`<span class="desc">Não preenchido.</span>`}</p></div><div><h4>Onde quer chegar</h4><p>${p.objetivo || html`<span class="desc">Não preenchido.</span>`}</p></div></div>
          ${editar ? html`<a class="botao sec pequeno" href="/cad/pdi/${p.id}">Editar dados do PDI</a>` : ''}</div>
        <div class="card"><h3 class="primeiro">Metas <span class="desc">· ${feitas} de ${metas.length} concluída(s)</span></h3>
          ${metas.length ? metas.map(cartaoMeta) : p.acoes ? html`<p class="pdi-acoes">${p.acoes}</p>` : html`<p class="desc">Nenhuma meta ainda.</p>`}
          ${editar && p.status !== 'Finalizado' ? html`<details class="pdi-nova"><summary class="botao sec pequeno">+ Adicionar meta</summary><form method="post" action="/pdi/${p.id}/metas" class="grade">
            ${campo('Meta *', html`<input name="meta" required maxlength="300">`, 'largo')}${campo('Entrega', html`<input type="date" name="entrega" value="${p.entrega || ''}">`)}
            ${campo('Competência', html`<input name="competencia" maxlength="200">`)}${campo('Treinamento', html`<input name="treinamento" maxlength="200">`)}
            ${campo('Ação', html`<textarea name="acao" rows="2" maxlength="2000"></textarea>`, 'largo')}<div class="acoes"><button class="botao">Adicionar meta</button></div></form></details>` : ''}</div>
      </div>

      <div data-painel="ultimos" hidden><div class="card"><h3 class="primeiro">Últimos PDIs</h3>
        ${outros.map(x => html`<a class="pdi-hist ${x.id === p.id ? 'atual' : ''}" href="/pdi/${x.id}"><div><b>${x.titulo}</b><small>Início ${dataBr(x.inicio)} · Prazo ${dataBr(x.entrega)}${avdDe(c, x) ? ` · ${c.nome('ciclo', avdDe(c, x).ciclo_id)}` : ''}</small></div>${chipStatus(x.status, dia, x)}${barraProg(x.progresso ?? progressoDe(metasDe(x)) ?? 0, 'largo')}</a>`)}</div></div>

      <div data-painel="feedbacks" hidden><div class="card"><div class="pdi-dados-topo"><h3 class="primeiro">Feedbacks recebidos <span class="pdi-cont">${feedbacks.length}</span></h3>
          ${editar ? html`<a class="botao sec pequeno" href="/cad/feedbacks/novo?colaborador_id=${p.colaborador_id}">+ Registrar feedback</a>` : ''}</div>
        ${feedbacks.length ? feedbacks.map(f => html`<details class="pdi-fb"><summary>${avatar(f.criado_por || '?')}<div><b>${f.criado_por || 'Sem autor'}</b><small>${dataBr(f.data)}</small></div><span class="pdi-chip ${{ Positivo: 'feito', Construtivo: 'revisao' }[f.classificacao] || 'vazio'}">${f.classificacao}</span></summary><p>${f.texto}</p></details>`)
          : html`<p class="desc">Nenhum feedback registrado para ${nome.split(' ')[0]}.</p>`}</div></div>

      <div class="acoes"><a class="botao sec" href="/cad/pdi?aba=${encodeURIComponent(p.status)}">Voltar</a></div>`,
    { migalha: 'PDI', descricao: '' }));
  }));

  // ------------------------------------------------------------ ações
  const salvar = (req, p, mudar, acao, detalhe) => tx(() => { R.atualizar(req.office, 'pdi', p.id, { ...R.soDados(p), ...mudar }); auditar(req, acao, 'pdi', p.id, detalhe); });
  const volta = req => { const r = req.get('referer') || ''; return /\/(cad\/)?pdi\b/.test(r) ? r.replace(/^https?:\/\/[^/]+/, '') : `/pdi/${req.params.id}`; };
  app.post('/pdi/:id(\\d+)/finalizar', exige('edita'), h((req, res) => {
    const p = carregar(req);
    salvar(req, p, { status: 'Finalizado', finalizado_em: hoje() }, 'Finalizou', 'Status');
    flash(res, 'PDI finalizado.');
    res.redirect(volta(req));
  }));
  app.post('/pdi/:id(\\d+)/reabrir', exige('edita'), h((req, res) => {
    const p = carregar(req);
    salvar(req, p, { status: 'Aberto', finalizado_em: null }, 'Reabriu', 'Status');
    flash(res, 'PDI reaberto.');
    res.redirect(volta(req));
  }));
  app.post('/pdi/:id(\\d+)/metas', exige('edita'), h((req, res) => {
    const p = carregar(req), meta = texto(req.body.meta).slice(0, 300);
    if (!meta) { flash(res, 'Informe a meta.', 'erro'); return res.redirect(`/pdi/${p.id}#metas`); }
    const entrega = /^\d{4}-\d{2}-\d{2}$/.test(texto(req.body.entrega)) ? texto(req.body.entrega) : null;
    const metas = [...metasDe(p), { meta, status: 'Em andamento', entrega, competencia: texto(req.body.competencia).slice(0, 200), treinamento: texto(req.body.treinamento).slice(0, 200), acao: texto(req.body.acao).slice(0, 2000) }];
    salvar(req, p, { metas, progresso: progressoDe(metas) }, 'Adicionou meta', 'Metas');
    flash(res, 'Meta adicionada.');
    res.redirect(`/pdi/${p.id}#metas`);
  }));
  app.post('/pdi/:id(\\d+)/metas/:i(\\d+)', exige('edita'), h((req, res) => {
    const p = carregar(req), i = Number(req.params.i), metas = metasDe(p).map(m => ({ ...m }));
    if (!metas[i]) throw falha(404, 'Meta não encontrada.');
    metas[i].status = texto(req.body.feita) === '1' ? 'Sucesso' : 'Em andamento';
    salvar(req, p, { metas, progresso: progressoDe(metas) }, metas[i].status === 'Sucesso' ? 'Concluiu meta' : 'Reabriu meta', 'Metas');
    flash(res, metas[i].status === 'Sucesso' ? 'Meta concluída.' : 'Meta reaberta.');
    res.redirect(`/pdi/${p.id}#metas`);
  }));
}

module.exports = { rotas, progressoDe, metaFeita };

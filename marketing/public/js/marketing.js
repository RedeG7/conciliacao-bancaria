'use strict';
/* Campanhas, investimento, métricas (manual e CSV) e conteúdos com ganchos, CTAs e UTMs. */

const STATUS_CHIP = { planejada: 'blue', ativa: 'green', pausada: 'amber', encerrada: '' };

function campaignForm(c = {}) {
  formModal({ title: c.id ? 'Editar campanha' : 'Nova campanha', size: 'wide', values: c, fields: [
    { name: 'name', label: 'Nome da campanha', required: true, full: true },
    { name: 'objective', label: 'Objetivo', full: true, placeholder: 'Ex.: gerar reuniões para regularização de obra' },
    { name: 'channel', label: 'Canal', type: 'list', items: CHANNELS }, { name: 'service_id', label: 'Serviço divulgado', type: 'select', options: opts(listOf('services', c.service_id), c.service_id, { empty: 'Selecione…' }) },
    { name: 'start_date', label: 'Início', type: 'date' }, { name: 'end_date', label: 'Término', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: mapOpts(LBL.campStatus, c.status || 'planejada') }, { name: 'budget_planned', label: 'Orçamento planejado (R$)', type: 'money' },
    { name: 'audience', label: 'Público-alvo', type: 'textarea', full: true }, { name: 'notes', label: 'Observações', type: 'textarea', full: true },
  ], onSubmit: async v => {
    if (c.id) await PUT('/api/campaigns/' + c.id, v); else { const r = await POST('/api/campaigns', v); c.id = r.id; }
    await refreshBoot(); toast('Campanha salva.'); dataChanged();
  } });
}

route('/campanhas', async (main, p, alive) => {
  S.campModel = S.campModel || 'first';
  const edit = can('admin', 'marketing');
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Campanhas e investimento</h1><p>Orçamento, gasto, métricas das plataformas e os resultados comerciais atribuídos a cada campanha.</p></div>
    <div class="actions">${edit ? `<button class="btn" id="imp">${icon('upload')}Importar métricas</button><button class="btn" id="costs">Outros custos (CAC)</button>` : ''}<button class="btn" data-download="/api/export/campanhas">${icon('download')}Exportar</button>${edit ? `<button class="btn primary" id="new">${icon('plus')}Nova campanha</button>` : ''}</div></div>
    <div class="filters"><label class="f"><span>Atribuição dos resultados</span><select id="model">${mapOpts({ first: 'Primeira origem do contato', opp: 'Última interação antes da oportunidade' }, S.campModel)}</select></label>
    <p class="small muted" style="flex:3;margin:0">Leads e vendas contam todo o histórico, atribuídos pelo modelo escolhido. Cada venda entra em uma só campanha. CPL e custo por cliente são <b>custos médios atribuídos</b>, não custo individual.</p></div>
    <div class="card" id="list"></div>`;
  if (edit) { $('#new', main).onclick = () => campaignForm(); $('#imp', main).onclick = importMetricsWizard; $('#costs', main).onclick = costsModal; }
  $('#model', main).onchange = e => { S.campModel = e.target.value; load(); };
  async function load() {
    const rows = await GET('/api/campaigns?model=' + S.campModel); if (!alive()) return;
    $('#list', main).innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Campanha</th><th>Status</th><th class="num">Orçamento</th><th class="num">Gasto</th><th class="num">Saldo</th><th class="num">Gasto/dia</th><th class="num">Cliques</th><th class="num">Leads</th><th class="num">Qualif.</th><th class="num">Vendas</th><th class="num">Valor fechado</th><th class="num">CPL médio</th><th class="num">Mídia/cliente</th></tr></thead><tbody>
      ${rows.filter(r => !r.archived).map(r => `<tr class="click" data-go="#/campanhas/${r.id}"><td><b>${esc(r.name)}</b><div class="small muted">${esc([r.channel, r.service].filter(Boolean).join(' · '))}</div><div class="small faint">${F.date(r.start_date)} a ${r.end_date ? F.date(r.end_date) : 'sem término'}</div></td>
        <td><span class="chip ${STATUS_CHIP[r.status]}">${esc(LBL.campStatus[r.status])}</span></td><td class="num">${F.brl(r.budget_planned)}</td><td class="num">${F.brl(r.spend)}</td>
        <td class="num" ${r.budget_left < 0 ? 'style="color:var(--red)"' : ''}>${F.brl(r.budget_left)}</td><td class="num">${F.brl(r.spend_per_day)}</td><td class="num">${F.int(r.clicks)}</td>
        <td class="num">${r.leads}</td><td class="num">${r.qualified}</td><td class="num">${r.won}</td><td class="num">${F.brl(r.one)}${r.monthly ? `<div class="small">${F.brl(r.monthly)}/mês</div>` : ''}</td><td class="num">${F.brl(r.cpl)}</td><td class="num">${F.brl(r.cpa)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><b>Nenhuma campanha cadastrada.</b>${edit ? 'Cadastre a primeira campanha para começar a associar conteúdos, investimento e leads.' : ''}</div>`;
  }
  S.refreshPage = load; await load();
});

route('/campanhas/:id', async (main, p, alive) => {
  const edit = can('admin', 'marketing');
  async function load() {
    const d = await GET(`/api/campaigns/${p.id}?model=${S.campModel || 'first'}`); if (!alive()) return;
    const c = d.campaign;
    const sm = c.sample || {};
    main.innerHTML = `<div class="page-head"><div class="grow"><a href="#/campanhas" class="small">← Campanhas</a><h1 class="mt-s">${esc(c.name)}</h1>
      <p><span class="chip ${STATUS_CHIP[c.status]}">${esc(LBL.campStatus[c.status])}</span> ${esc([c.channel, c.service, `${F.date(c.start_date)} a ${c.end_date ? F.date(c.end_date) : 'sem término'}`].filter(Boolean).join(' · '))}</p></div>
      <div class="actions">${edit ? `<button class="btn" id="edit">Editar</button><button class="btn" id="imp">${icon('upload')}Importar métricas</button><button class="btn primary" id="addm">${icon('plus')}Registrar métricas</button>` : ''}</div></div>
      <div class="kpis mb">${[['Orçamento planejado', F.brl(c.budget_planned)], ['Gasto registrado', F.brl(c.spend)], ['Saldo do orçamento', F.brl(c.budget_left)], ['Gasto médio por dia', F.brl(c.spend_per_day)],
        ['Impressões', F.int(c.impressions)], ['Cliques', F.int(c.clicks)], ['Conversas iniciadas', F.int(c.conversations)], ['Leads atribuídos', c.leads], ['Leads qualificados', c.qualified], ['Reuniões realizadas', c.meetings],
        ['Vendas', c.won], ['Valor único fechado', F.brl(c.one)], ['Mensalidades fechadas', c.monthly ? F.brl(c.monthly) + '/mês' : '—'], ['Receita recebida', F.brl(c.revenue)], ['CPL médio atribuído', F.brl(c.cpl)], ['Custo por qualificado', F.brl(c.cpql)], ['Custo de mídia por cliente', F.brl(c.cpa)]]
        .map(([l, v]) => `<div class="kpi" style="cursor:default"><span class="lbl">${esc(l)}</span><span class="val" style="font-size:18px">${esc(String(v))}</span></div>`).join('')}</div>
      <p class="callout small mb">${esc(sm.text || '')} Gasto por dia = gasto registrado ÷ dias desde o início (até hoje ou até o término). Alcance não é somado como pessoas únicas.</p>
      <div class="grid g2">
        <div class="card"><div class="card-head"><h2>Dados da campanha</h2></div><div class="card-body"><dl class="kv"><dt>Objetivo</dt><dd>${esc(c.objective || '—')}</dd><dt>Público-alvo</dt><dd>${esc(c.audience || '—')}</dd><dt>Observações</dt><dd>${esc(c.notes || '—')}</dd><dt>Última métrica</dt><dd>${F.date(c.last_metric)} <span class="small muted">(dados manuais/importados — não são em tempo real)</span></dd></dl></div></div>
        <div class="card"><div class="card-head"><h2>Conteúdos e anúncios (${d.contents.length})</h2>${edit ? '<button class="btn sm" id="addc" style="margin-left:auto">+ Conteúdo</button>' : ''}</div>
          <table class="t"><tbody>${d.contents.map(k => `<tr class="click" data-go="#/conteudos?id=${k.id}"><td><b>${esc(k.title)}</b><div class="small muted">${esc([k.channel, k.format, F.date(k.published_at)].filter(Boolean).join(' · '))}</div></td><td class="small">${esc(k.hook || '')}<div class="muted">CTA: ${esc(k.cta || '—')}</div></td></tr>`).join('') || '<tr><td class="muted">Nenhum conteúdo associado.</td></tr>'}</tbody></table></div>
      </div>
      <div class="card mt"><div class="card-head"><h2>Métricas registradas por data</h2><span class="sub">uma linha por data + conteúdo + origem; importar de novo substitui, não soma</span></div>
        <div class="table-wrap" style="max-height:420px"><table class="t"><thead><tr><th>Data</th><th>Conteúdo</th><th>Origem</th><th class="num">Investimento</th><th class="num">Impressões</th><th class="num">Alcance</th><th class="num">Cliques</th><th class="num">Conversas</th><th>Entrada</th><th></th></tr></thead><tbody>
        ${d.metrics.map(m => `<tr><td>${F.date(m.date)}</td><td class="small">${esc(m.content || '—')}</td><td class="small">${esc(m.source || '—')}</td><td class="num">${F.brl(m.spend)}</td><td class="num">${F.int(m.impressions)}</td><td class="num">${F.int(m.reach)}</td><td class="num">${F.int(m.clicks)}</td><td class="num">${F.int(m.conversations)}</td><td class="small">${m.origin === 'importacao' ? 'Importação' : 'Manual'}</td><td class="right">${edit ? `<button class="btn sm danger" data-delm="${m.id}">Excluir</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">Nenhuma métrica registrada.</td></tr>'}</tbody></table></div></div>`;
    if (edit) {
      $('#edit', main).onclick = () => campaignForm(Object.assign({}, c));
      $('#imp', main).onclick = importMetricsWizard;
      $('#addm', main).onclick = () => metricForm(c);
      $('#addc', main).onclick = () => contentForm({ campaign_id: c.id, service_id: c.service_id, channel: c.channel });
      $$('[data-delm]', main).forEach(b => { b.onclick = async () => { if (await confirmDlg('Excluir este registro de métricas?', { danger: true, ok: 'Excluir' })) { await DEL('/api/metrics/' + b.dataset.delm).catch(fail); load(); } }; });
    }
  }
  S.refreshPage = load; await load();
});

function metricForm(c) {
  const conts = listOf('contents').filter(k => k.campaign_id === c.id);
  formModal({ title: 'Registrar métricas', intro: H`<p class="small muted" style="margin-top:0">Informe os números da plataforma para uma data. Se já existir registro para a mesma data, conteúdo e origem, ele será <b>substituído</b> (não somado). Deixe em branco o que não estiver disponível.</p>`,
    fields: [{ name: 'date', label: 'Data', type: 'date', required: true, value: today() }, { name: 'source_id', label: 'Origem / plataforma', type: 'select', options: opts(listOf('sources'), (listOf('sources').find(s => s.kind === 'pago') || {}).id, { empty: 'Não informada' }) },
      { name: 'content_id', label: 'Conteúdo / anúncio (opcional)', type: 'select', full: true, options: opts(conts, '', { empty: 'Campanha inteira (sem conteúdo específico)', label: x => x.title }) },
      { name: 'spend', label: 'Investimento (R$)', type: 'money' }, { name: 'impressions', label: 'Impressões', type: 'number' }, { name: 'reach', label: 'Alcance', type: 'number' }, { name: 'clicks', label: 'Cliques', type: 'number' }, { name: 'conversations', label: 'Conversas iniciadas', type: 'number' }],
    onSubmit: async v => { const r = await POST('/api/metrics', Object.assign(v, { campaign_id: c.id })); toast(r.replaced ? 'Registro existente substituído.' : 'Métricas registradas.'); dataChanged(); } });
}
function importMetricsWizard() {
  importWizard({
    title: 'Importar métricas de campanha (CSV)', previewUrl: '/api/metrics/import/preview', commitUrl: '/api/metrics/import/commit',
    intro: H`<p>Use o relatório exportado do Gerenciador de Anúncios, do Google Ads ou uma planilha própria, <b>uma linha por dia</b>. A chave de cada registro é <b>data + campanha + conteúdo + origem</b>: importar o mesmo arquivo de novo não soma os resultados — linhas idênticas são ignoradas e linhas alteradas substituem as anteriores.</p>
      <p class="small muted">Campanha, conteúdo e origem devem ter o mesmo nome cadastrado no sistema (ou o ID).</p>`,
    fields: [
      { key: 'date', label: 'Data', required: true, aliases: ['data', 'dia', 'date', 'iniciodosrelatorios', 'day'] }, { key: 'campaign', label: 'Campanha', required: true, aliases: ['campanha', 'nomedacampanha', 'campaign'] },
      { key: 'content', label: 'Conteúdo / anúncio', aliases: ['conteudo', 'anuncio', 'nomedoanuncio', 'ad'] }, { key: 'source', label: 'Origem', aliases: ['origem', 'plataforma', 'source'] },
      { key: 'spend', label: 'Investimento', aliases: ['valorusado', 'investimento', 'gasto', 'custo', 'spend', 'cost'] }, { key: 'impressions', label: 'Impressões', aliases: ['impressoes', 'impressions', 'impr'] },
      { key: 'reach', label: 'Alcance', aliases: ['alcance', 'reach'] }, { key: 'clicks', label: 'Cliques', aliases: ['cliquesnolink', 'cliques', 'clicks'] }, { key: 'conversations', label: 'Conversas iniciadas', aliases: ['conversas', 'mensagens', 'conversations'] },
    ],
    statusInfo: { novo: ['Novo', 'green'], substitui: ['Substituirá o existente', 'amber'], igual: ['Já importado (igual)', ''], repetido_no_arquivo: ['Repetido no arquivo (vale a última)', 'amber'], erro: ['Com erro', 'red'] },
    previewCols: [['Data', r => F.date(r.data.date)], ['Campanha', r => esc((byId('campaigns', r.data.campaign_id) || {}).name || '—')], ['Conteúdo', r => esc((byId('contents', r.data.content_id) || {}).title || '—')],
      ['Investimento', r => F.brl(r.data.spend)], ['Impr.', r => F.int(r.data.impressions)], ['Cliques', r => F.int(r.data.clicks)], ['Conversas', r => F.int(r.data.conversations)]],
    afterCommit: () => dataChanged(),
    summary: r => `<div class="empty"><b>Importação concluída.</b>${r.novos} novo(s) · ${r.substituidos} substituído(s) · ${r.ignorados} ignorado(s) (iguais ou repetidos) · ${r.erros} com erro</div>`,
  });
}
async function costsModal() {
  const list = await GET('/api/costs');
  const m = modal({ title: 'Outros custos de aquisição (para o CAC completo)', size: 'wide', body: raw(`<p class="small muted" style="margin-top:0">Cadastre custos de marketing e vendas além da mídia (produção de conteúdo, ferramentas, horas da equipe comercial dedicadas a novos clientes etc.). O CAC completo só é calculado quando houver custos no período.</p>
    <div class="actions mb"><button class="btn primary sm" id="addcost">+ Registrar custo</button></div>
    <table class="t"><thead><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th>Campanha</th><th class="num">Valor</th><th></th></tr></thead><tbody>${list.map(c => `<tr><td>${F.date(c.date)}</td><td>${c.category === 'vendas' ? 'Vendas' : 'Marketing'}</td><td>${esc(c.description || '')}</td><td class="small">${esc(c.campaign || 'Geral')}</td><td class="num">${F.brl(c.amount)}</td><td class="right"><button class="btn sm danger" data-delc="${c.id}">Excluir</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhum custo cadastrado.</td></tr>'}</tbody></table>`) });
  $('#addcost', m.el).onclick = () => formModal({ title: 'Registrar custo', fields: [{ name: 'date', label: 'Data (competência)', type: 'date', value: today(), required: true }, { name: 'category', label: 'Categoria', type: 'select', options: mapOpts({ marketing: 'Marketing', vendas: 'Vendas' }, 'marketing') },
    { name: 'description', label: 'Descrição', full: true, required: true }, { name: 'amount', label: 'Valor (R$)', type: 'money', required: true }, { name: 'campaign_id', label: 'Campanha (opcional)', type: 'select', options: opts(listOf('campaigns'), '', { empty: 'Geral' }) }],
  onSubmit: async v => { await POST('/api/costs', v); m.close(); costsModal(); dataChanged(); } });
  $$('[data-delc]', m.el).forEach(b => { b.onclick = async () => { if (await confirmDlg('Excluir este custo?', { danger: true, ok: 'Excluir' })) { await DEL('/api/costs/' + b.dataset.delc).catch(fail); m.close(); costsModal(); } }; });
}

// ---------- conteúdos ----------
function contentForm(k = {}) {
  const fields = [
    { name: 'title', label: 'Título', required: true, full: true }, { name: 'theme', label: 'Tema', placeholder: 'Ex.: INSS da obra' }, { name: 'url', label: 'Link do conteúdo / destino', placeholder: 'https://…' },
    { name: 'channel', label: 'Canal', type: 'list', items: CHANNELS }, { name: 'format', label: 'Formato', type: 'list', items: FORMATS },
    { name: 'published_at', label: 'Data de publicação', type: 'date' }, { name: 'service_id', label: 'Serviço divulgado', type: 'select', options: opts(listOf('services', k.service_id), k.service_id, { empty: 'Selecione…' }) },
    { name: 'hook', label: 'Gancho utilizado', type: 'list', items: S.boot.hooks || [], full: true, placeholder: 'Ex.: Regularizar depois pode sair mais caro do que planejar antes', help: 'Use o mesmo texto para comparar conteúdos com o mesmo gancho.' },
    { name: 'cta', label: 'CTA utilizado', type: 'list', items: listOf('ctas').map(c => c.name), placeholder: 'Ex.: Agende uma reunião' },
    { name: 'campaign_id', label: 'Campanha relacionada', type: 'select', options: opts(listOf('campaigns', k.campaign_id), k.campaign_id, { empty: 'Nenhuma (orgânico avulso)' }) },
    { name: 'is_ad', label: 'É anúncio pago', type: 'checkbox' },
    { section: 'Link rastreável (parâmetros UTM)' },
    { name: 'utm_source', label: 'utm_source', placeholder: 'instagram' }, { name: 'utm_medium', label: 'utm_medium', placeholder: 'social / cpc' },
    { name: 'utm_campaign', label: 'utm_campaign', placeholder: 'inss-obra-out26' }, { name: 'utm_content', label: 'utm_content', placeholder: 'reels-regularizar-depois' },
  ];
  formModal({ title: k.id ? 'Editar conteúdo' : 'Novo conteúdo', size: 'wide', values: k, fields,
    extraFoot: raw('<span class="small muted" style="margin-right:auto" id="utm-prev"></span>'),
    onMount: (m, form) => {
      const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const prev = () => {
        const v = readForm(form); if (!v.url) { $('#utm-prev', m.el).textContent = ''; return; }
        try { const u = new URL(/^https?:/.test(v.url) ? v.url : 'https://' + v.url); ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(x => { if (v[x]) u.searchParams.set(x, v[x]); }); $('#utm-prev', m.el).textContent = 'Link: ' + u.toString(); } catch (e) { $('#utm-prev', m.el).textContent = 'Link inválido'; }
      };
      form.addEventListener('input', prev); prev();
      form.elements.title.addEventListener('blur', () => { if (!form.elements.utm_content.value) form.elements.utm_content.value = slug(form.elements.title.value); prev(); });
      form.elements.campaign_id.addEventListener('change', () => { const c = byId('campaigns', form.elements.campaign_id.value); if (c && !form.elements.utm_campaign.value) form.elements.utm_campaign.value = slug(c.name); if (c && !form.elements.service_id.value && c.service_id) form.elements.service_id.value = c.service_id; prev(); });
      form.elements.channel.addEventListener('change', () => { if (!form.elements.utm_source.value) form.elements.utm_source.value = slug(form.elements.channel.value); prev(); });
    },
    onSubmit: async v => { if (k.id) await PUT('/api/contents/' + k.id, v); else await POST('/api/contents', v); await refreshBoot(); toast('Conteúdo salvo.'); dataChanged(); } });
}

route('/conteudos', async (main, p, alive) => {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const focus = params.get('id');
  S.contModel = S.contModel || 'first';
  const edit = can('admin', 'marketing');
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Conteúdos, ganchos e CTAs</h1><p>Cadastre cada conteúdo com gancho, CTA e link rastreável. A tabela mostra o que cada um gerou do clique à venda.</p></div>
    <div class="actions"><button class="btn" data-go="#/analises">Comparar ganchos e CTAs</button><button class="btn" data-download="/api/export/conteudos">${icon('download')}Exportar</button>${edit ? `<button class="btn primary" id="new">${icon('plus')}Novo conteúdo</button>` : ''}</div></div>
    <div class="filters"><label class="f"><span>Buscar</span><input id="q" placeholder="Título, tema, gancho ou CTA"></label><label class="f"><span>Campanha</span><select id="fc"><option value="">Todas</option>${opts(S.boot.campaigns)}</select></label>
      <label class="f"><span>Atribuição</span><select id="model">${mapOpts({ first: 'Primeira origem do contato', opp: 'Última interação antes da oportunidade' }, S.contModel)}</select></label>
      <p class="small muted" style="flex:2;margin:0">Resultados de todo o histórico. Cliques do link próprio são anônimos; leads só contam quando o contato foi identificado e vinculado ao conteúdo.</p></div>
    <div class="card" id="list"></div>`;
  if (edit) $('#new', main).onclick = () => contentForm();
  let rows = [];
  const draw = () => {
    const q = $('#q', main).value.toLowerCase(); const fc = $('#fc', main).value;
    const list = rows.filter(k => !k.archived && (!fc || String(k.campaign_id) === fc) && (!q || [k.title, k.theme, k.hook, k.cta].some(x => (x || '').toLowerCase().includes(q))));
    $('#list', main).innerHTML = list.length ? `<div class="table-wrap"><table class="t"><thead><tr><th style="min-width:260px">Conteúdo</th><th style="min-width:220px">Gancho / CTA</th><th class="num">Invest.</th><th class="num">Cliques</th><th class="num">Conversas</th><th class="num">Leads</th><th class="num">Qualif.</th><th class="num">Reuniões</th><th class="num">Vendas</th><th class="num">Valor fechado</th><th>Amostra</th><th></th></tr></thead><tbody>
      ${list.map(k => { const s = k.stats || {}; return `<tr id="k${k.id}" ${String(k.id) === focus ? 'style="outline:2px solid var(--orange)"' : ''}><td><b>${esc(k.title)}</b><div class="small muted">${esc([k.channel, k.format, F.date(k.published_at)].filter(Boolean).join(' · '))}</div><div class="small faint">${esc(k.campaign || 'Sem campanha')} · ${esc(k.service || '')}</div></td>
        <td class="small" style="max-width:260px">${esc(k.hook || '—')}<div class="muted">CTA: ${esc(k.cta || '—')}</div></td>
        <td class="num">${s.spend === null || s.spend === undefined ? '—' : F.brl(s.spend)}</td><td class="num">${F.int(s.clicks)}${k.own_clicks ? `<div class="small faint">${k.own_clicks} no link próprio</div>` : ''}</td><td class="num">${F.int(s.conversations)}</td>
        <td class="num">${s.leads || 0}</td><td class="num">${s.qualified || 0}</td><td class="num">${s.meetings || 0}</td><td class="num">${s.won || 0}</td><td class="num">${F.brl(s.one || 0)}${s.monthly ? `<div class="small">${F.brl(s.monthly)}/mês</div>` : ''}</td>
        <td class="small">${s.sample ? `<span class="chip ${s.sample.level === 'ok' ? 'green' : s.sample.level === 'pequena' ? 'amber' : ''}">${s.sample.level === 'ok' ? 'suficiente' : s.sample.level}</span>` : ''}</td>
        <td class="nowrap right"><button class="btn sm" data-link="${k.id}">Links</button> ${edit ? `<button class="btn sm" data-edit="${k.id}">Editar</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : '<div class="empty"><b>Nenhum conteúdo cadastrado.</b>Exemplo: um Reels sobre INSS da obra com o gancho "Regularizar depois pode sair mais caro do que planejar antes" e o CTA "Agende uma reunião".</div>';
    $$('[data-edit]', main).forEach(b => { b.onclick = () => contentForm(rows.find(k => k.id === Number(b.dataset.edit))); });
    $$('[data-link]', main).forEach(b => { b.onclick = () => linksModal(rows.find(k => k.id === Number(b.dataset.link))); });
    if (focus && $('#k' + focus, main)) $('#k' + focus, main).scrollIntoView({ block: 'center' });
  };
  $('#q', main).oninput = draw; $('#fc', main).onchange = draw; $('#model', main).onchange = e => { S.contModel = e.target.value; load(); };
  async function load() { rows = await GET('/api/contents?model=' + S.contModel); if (alive()) draw(); }
  S.refreshPage = load; await load();
});
function linksModal(k) {
  const short = location.origin + '/r/' + k.short_code;
  modal({ title: 'Links de ' + k.title, body: raw(`<p><b>Link com UTMs</b></p>${k.tracked_url ? `<div class="copy-row"><code class="inline">${esc(k.tracked_url)}</code><button class="btn sm" data-copy="${esc(k.tracked_url)}">Copiar</button></div>` : '<p class="muted">Informe o link de destino no cadastro do conteúdo.</p>'}
    <p class="mt"><b>Link curto rastreável</b> — conta cliques anônimos e redireciona para o link com UTMs</p>
    ${k.tracked_url ? `<div class="copy-row"><code class="inline">${esc(short)}</code><button class="btn sm" data-copy="${esc(short)}">Copiar</button></div>` : ''}
    <p class="small muted mt-s">${S.mode === 'demo' ? 'No modo demonstração o link curto não registra cliques (só funciona para conteúdos reais). ' : ''}Para funcionar fora deste computador, o sistema precisa estar publicado em um endereço na internet. Cliques registrados: ${k.own_clicks}. O clique não identifica a pessoa.</p>`),
    onMount: m => $$('[data-copy]', m.el).forEach(b => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copiado.')); }) });
}

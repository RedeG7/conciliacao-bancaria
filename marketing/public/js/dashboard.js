'use strict';
/* Painel integrado: todos os números vêm de /api/analytics/dashboard, calculados dos registros salvos. */

const DASH_DEFAULT = () => { const p = periodPresets().d30; return { preset: 'd30', from: p[1], to: p[2], source_id: '', campaign_id: '', content_id: '', service_id: '', owner_id: '', kind: '', model: 'first', view: 'activity' }; };

function filterBar(f, { showView = true, showModel = true, showKind = true, showContent = true, showOwner = true } = {}) {
  const P = periodPresets(); const users = S.boot.users || [];
  return `<div class="filters" id="fbar">
    <label class="f"><span>Período</span><select name="preset">${Object.entries(P).map(([k, v]) => `<option value="${k}" ${f.preset === k ? 'selected' : ''}>${v[0]}</option>`).join('')}<option value="custom" ${f.preset === 'custom' ? 'selected' : ''}>Personalizado</option></select></label>
    <label class="f" style="max-width:150px"><span>De</span><input type="date" name="from" value="${esc(f.from)}"></label>
    <label class="f" style="max-width:150px"><span>Até</span><input type="date" name="to" value="${esc(f.to)}"></label>
    <label class="f"><span>Origem</span><select name="source_id"><option value="">Todas</option>${opts(S.boot.sources, f.source_id)}<option value="0" ${f.source_id === '0' ? 'selected' : ''}>Não identificado</option></select></label>
    <label class="f"><span>Campanha</span><select name="campaign_id"><option value="">Todas</option>${opts(S.boot.campaigns, f.campaign_id)}<option value="0" ${f.campaign_id === '0' ? 'selected' : ''}>Sem campanha</option></select></label>
    ${showContent ? `<label class="f"><span>Conteúdo</span><select name="content_id"><option value="">Todos</option>${opts(S.boot.contents, f.content_id, { label: x => x.title })}</select></label>` : ''}
    <label class="f"><span>Serviço</span><select name="service_id"><option value="">Todos</option>${opts(S.boot.services, f.service_id)}</select></label>
    ${showOwner ? `<label class="f"><span>Responsável</span><select name="owner_id"><option value="">Todos</option>${opts(users, f.owner_id)}<option value="0" ${f.owner_id === '0' ? 'selected' : ''}>Sem responsável</option></select></label>` : ''}
    ${showKind ? `<label class="f"><span>Tipo de contato</span><select name="kind"><option value="">Todos</option>${mapOpts(LBL.kind, f.kind)}</select></label>` : ''}
    ${showModel ? `<label class="f"><span>Atribuição de vendas</span><select name="model"><option value="first" ${f.model === 'first' ? 'selected' : ''}>Primeira origem do contato</option><option value="opp" ${f.model === 'opp' ? 'selected' : ''}>Última interação antes da oportunidade</option></select></label>` : ''}
    ${showView ? `<div><div class="small muted" style="font-weight:600;margin-bottom:4px">Visão</div><div class="seg" id="view-seg"><button type="button" data-v="activity" class="${f.view === 'activity' ? 'on' : ''}">Atividade no período</button><button type="button" data-v="cohort" class="${f.view === 'cohort' ? 'on' : ''}">Coorte de leads</button></div></div>` : ''}
  </div>`;
}
function wireFilterBar(root, f, onChange) {
  const bar = $('#fbar', root);
  bar.addEventListener('change', e => {
    const n = e.target.name; if (!n) return;
    if (n === 'preset') { if (e.target.value !== 'custom') { const p = periodPresets()[e.target.value]; f.from = p[1]; f.to = p[2]; } f.preset = e.target.value; }
    else { f[n] = e.target.value; if (n === 'from' || n === 'to') f.preset = 'custom'; }
    onChange();
  });
  const seg = $('#view-seg', bar); if (seg) seg.onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; f.view = b.dataset.v; onChange(); };
}
function viewExplain(f) {
  return f.view === 'cohort'
    ? `<b>Coorte de leads:</b> considera apenas os leads captados entre ${F.date(f.from)} e ${F.date(f.to)} e mostra o que aconteceu com eles até hoje (qualificação, reuniões, propostas, vendas e recebimentos).`
    : `<b>Atividade no período:</b> conta cada evento pela data em que ocorreu entre ${F.date(f.from)} e ${F.date(f.to)} — mesmo que o lead tenha sido captado antes. Para ver a conversão dos leads captados no período, use "Coorte de leads".`;
}
async function savedFiltersUi(root, view, f, apply) {
  const box = $('#saved', root); if (!box) return;
  const list = await GET('/api/saved-filters?view=' + view).catch(() => []);
  box.innerHTML = `<select class="input" id="sf-sel" style="width:auto;min-width:170px"><option value="">Filtros salvos (${list.length})</option>${list.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
    <button class="btn sm" id="sf-save">Salvar filtro</button>${list.length ? '<button class="btn sm" id="sf-del" title="Excluir filtro selecionado">Excluir</button>' : ''}`;
  $('#sf-sel', box).onchange = e => { const x = list.find(i => String(i.id) === e.target.value); if (x) { const p = JSON.parse(x.params); if (p.preset && p.preset !== 'custom') { const pp = periodPresets()[p.preset]; if (pp) { p.from = pp[1]; p.to = pp[2]; } } apply(p); } };
  $('#sf-save', box).onclick = () => formModal({ title: 'Salvar filtro', fields: [{ name: 'name', label: 'Nome do filtro', required: true, full: true, placeholder: 'Ex.: INSS da obra — últimos 90 dias' }],
    intro: H`<p class="small muted" style="margin-top:0">Períodos predefinidos (ex.: "Últimos 30 dias") são recalculados quando o filtro é aplicado.</p>`,
    onSubmit: async v => { await POST('/api/saved-filters', { view, name: v.name, params: f }); toast('Filtro salvo.'); savedFiltersUi(root, view, f, apply); } });
  if ($('#sf-del', box)) $('#sf-del', box).onclick = async () => { const id = $('#sf-sel', box).value; if (!id) return toast('Selecione um filtro salvo.', { err: true }); await DEL('/api/saved-filters/' + id); savedFiltersUi(root, view, f, apply); };
}

route('/painel', async (main, p, alive) => {
  S.dash = S.dash || DASH_DEFAULT();
  const f = S.dash;
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Painel integrado</h1><p>Marketing e comercial a partir dos dados registrados. Clique em qualquer indicador para ver os registros e a fórmula.</p></div>
    <div class="actions" id="saved"></div></div>${filterBar(f)}<div class="callout navy small mb" id="explain"></div><div id="dash"></div>`;
  const load = async () => {
    $('#explain', main).innerHTML = viewExplain(f);
    const box = $('#dash', main); box.style.opacity = .5;
    const q = Object.assign({}, f); delete q.preset;
    const d = await GET('/api/analytics/dashboard?' + qs(q));
    if (!alive()) return; box.style.opacity = 1; S.dashData = d; drawDash(box, d);
  };
  // redesenha a barra (presets alteram datas) e reaplica os eventos
  const rewire = () => { $('#fbar', main).outerHTML = filterBar(f); wireFilterBar(main, f, () => { rewire(); load(); }); };
  wireFilterBar(main, f, () => { rewire(); load(); });
  savedFiltersUi(main, 'painel', f, nf => { Object.assign(f, DASH_DEFAULT(), nf); rewire(); load(); });
  S.refreshPage = load;
  await load();
});

function drawDash(box, d) {
  const K = Object.fromEntries(d.kpis.map(k => [k.key, k]));
  const fsSteps = [['leads', 'Leads'], ['qual', 'Qualificados'], ['done', 'Reuniões realizadas'], ['props', 'Propostas'], ['won', 'Vendas']];
  const strip = `<div class="funnel-strip">${fsSteps.map(([k, l], i) => {
    const prev = i ? K[fsSteps[i - 1][0]].value : null; const conv = i && prev ? (K[k].value / prev) * 100 : null;
    return `<div class="fs-step" data-kpi="${k}" tabindex="0">${i ? `<span class="fs-arrow" title="Conversão da etapa anterior">${conv === null ? '—' : F.pct(conv)}</span>` : ''}<div class="lbl">${l}</div><div class="val">${F.int(K[k].value)}</div><div class="foot">${k === 'leads' ? 'contatos identificados' : k === 'won' ? ([K.wonOne.value ? F.brl(K.wonOne.value) : '', K.wonMonthly.value ? F.brl(K.wonMonthly.value) + '/mês' : ''].filter(Boolean).join(' + ') || 'sem valor fechado') : '&nbsp;'}</div></div>`;
  }).join('')}</div>
  <p class="small muted" style="margin:-8px 0 12px">As setas mostram a relação entre etapas consecutivas ${d.filters.view === 'activity' ? '(na visão de atividade, eventos do período podem vir de leads de períodos anteriores — use a coorte para taxa de conversão real)' : '(leads da coorte)'}.</p>`;
  const kcard = k => { const x = K[k]; if (!x) return ''; const na = x.value === null || x.value === undefined;
    return `<button class="kpi" data-kpi="${k}" title="${esc(x.formula)}"><span class="lbl">${esc(x.label)}<span class="i">ⓘ</span></span><span class="val ${na ? 'na' : ''}">${na ? 'Sem dados' : esc(F.val(x.value, x.fmt))}</span>${x.note ? `<span class="note">${esc(x.note)}</span>` : ''}</button>`; };
  const group = (t, keys) => `<div class="kpi-group"><h3>${t}</h3><div class="kpis">${keys.map(kcard).join('')}</div></div>`;
  const ev = d.evolution;
  const xFmt = b => (ev.gran === 'month' ? b.slice(5, 7) + '/' + b.slice(0, 4) : F.date(b).slice(0, 5));
  const srcRows = d.bySource.filter(r => r.leads || r.won || r.spend);
  const campRows = d.byCampaign.filter(r => r.leads || r.won || r.spend);
  const tbl = (rows, kind) => rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>${kind}</th><th class="num">Invest.</th><th class="num">Leads</th><th class="num">Qualif.</th><th class="num">Reuniões</th><th class="num">Vendas</th><th class="num">Valor único</th><th class="num">CPL médio</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="click" data-brk="${kind}" data-key="${esc(r.key)}"><td><b>${esc(r.label)}</b>${r.sample.level !== 'ok' ? `<div class="small faint">${esc(r.sample.level === 'insuficiente' ? 'amostra insuficiente' : 'amostra pequena')}</div>` : ''}</td><td class="num">${r.spend === null ? '—' : F.brl(r.spend)}</td><td class="num">${r.leads}</td><td class="num">${r.qualified} <span class="small faint">${F.pct(r.qual_rate)}</span></td><td class="num">${r.meetings}</td><td class="num">${r.won}</td><td class="num">${F.brl(r.one)}${r.monthly ? `<div class="small">${F.brl(r.monthly)}/mês</div>` : ''}</td><td class="num">${F.brl(r.cpl)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Sem dados no período.</div>';
  const bn = d.bottleneck;
  box.innerHTML = `${strip}
  ${d.noNext.length ? `<div class="callout red mb" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span><b>${d.noNext.length} oportunidade(s) abertas sem retorno agendado</b> (sem próxima ação ou com prazo vencido).</span><button class="btn sm" data-list="noNext">Ver lista</button></div>` : ''}
  ${d.unknownSales ? `<div class="callout mb small">${d.unknownSales} venda(s) do recorte estão sem origem identificada e aparecem como "Não identificado".</div>` : ''}
  ${group('Mídia e alcance', ['spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'conversations'])}
  ${group('Leads e atendimento', ['leads', 'qual', 'sched', 'done', 'props'])}
  ${group('Oportunidades e vendas', ['open', 'won', 'lost', 'conv', 'cycle'])}
  ${group('Valores (contratado x recebido)', ['openPropOne', 'wonOne', 'wonMonthly', 'revenue'])}
  ${group('Custos e retorno (custo médio atribuído)', ['cpl', 'cpql', 'cpc_client', 'cac', 'roas', 'roasContract'])}
  <div class="grid g2 mt">
    <div class="card"><div class="card-head"><h2>Evolução</h2><span class="sub">por ${ev.gran === 'day' ? 'dia' : ev.gran === 'week' ? 'semana' : 'mês'}, data de cada evento</span></div><div class="card-body">
      ${lineChart({ labels: ev.buckets, xFmt, series: [{ name: 'Leads', values: ev.leads, color: '#001044', area: true }, { name: 'Qualificados', values: ev.qual, color: '#ef6406' }, { name: 'Vendas', values: ev.won, color: '#12804a' }] })}
      <div class="mt-s">${lineChart({ labels: ev.buckets, xFmt, height: 140, yFmt: v => F.brl(v).replace(',00', ''), series: [{ name: 'Investimento em mídia', values: ev.spend, color: '#2457c5', area: true, fmt: F.brl }] })}</div></div></div>
    <div class="card"><div class="card-head"><h2>Do clique anônimo ao cliente</h2></div><div class="card-body">
      <div class="chain">${d.identification.map(x => `<div class="link"><b>${x.value === null ? '—' : F.int(x.value)}</b>${esc(x.label)}<br><span>${esc(x.note)}</span></div>`).join('')}</div>
      <p class="small muted mt-s">Cliques e conversas das plataformas são contagens anônimas. Uma pessoa só passa a ser contato quando se identifica (formulário, conversa ou atendimento). O sistema não identifica nominalmente quem clicou.</p>
      <h3 class="mt">Motivos de perda</h3>${barsHtml(d.losses.map(l => ({ label: l.reason, value: l.count, extra: `(${F.pct(l.pct)})`, reason: l.reason })), { color: 'o', attrs: r => `data-loss="${esc(r.reason)}"` })}
      <p class="small muted">${d.losses.reduce((a, l) => a + l.count, 0)} perda(s) consideradas.</p></div></div>
  </div>
  <div class="grid g2 mt">
    <div class="card"><div class="card-head"><h2>Desempenho por origem</h2><span class="sub">clique para ver os registros</span></div>${tbl(srcRows, 'source')}</div>
    <div class="card"><div class="card-head"><h2>Desempenho por campanha</h2></div>${tbl(campRows, 'campaign')}</div>
  </div>
  <div class="grid g2 mt">
    <div class="card"><div class="card-head"><h2>Funil por etapa e gargalos</h2><span class="sub">${d.filters.view === 'cohort' ? 'oportunidades dos leads da coorte' : 'oportunidades criadas no período'}</span></div><div class="card-body stage-funnel">
      ${d.funnel.map((s, i) => { const max = Math.max(1, d.funnel[0].reached); const isBn = bn && bn.from === s.name;
        return `<div class="row ${isBn ? 'bn' : ''}" data-stage="${i}"><span>${esc(s.name)}</span><span class="track" style="background:var(--line-2);height:14px;border-radius:4px;overflow:hidden"><span style="display:block;height:100%;width:${s.reached / max * 100}%;background:${s.kind === 'won' ? 'var(--green)' : 'var(--navy)'}"></span></span><span class="num"><b>${s.reached}</b></span><span class="num small conv extra">${s.conv_next === null ? '' : '→ ' + F.pct(s.conv_next)}</span></div>`; }).join('')}
      ${bn ? `<div class="callout red mt-s small"><b>Maior gargalo observado:</b> de "${esc(bn.from)}" para "${esc(bn.to)}" avançaram ${F.pct(bn.conv)} (${bn.n} oportunidades na etapa de origem). ${bn.n < 10 ? 'Amostra pequena — trate como indício.' : ''}</div>` : '<p class="small muted">Sem volume suficiente para apontar gargalo (mínimo 3 oportunidades por etapa).</p>'}
      <h3 class="mt">Tempo médio na etapa atual (oportunidades abertas)</h3>
      <table class="t mt-s"><tbody>${d.timeInStage.map(t => `<tr><td>${esc(t.stage)}</td><td class="num">${t.count} aberta(s)</td><td class="num">${F.days(t.avg_days)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><div class="card-head"><h2>Metas do período</h2><span class="sub">configuradas em Configurações › Metas</span></div><div class="card-body">
      ${d.goals.length ? d.goals.map(g => `<div class="mb"><div style="display:flex;justify-content:space-between;gap:8px"><span><b>${esc(g.name || g.metric_label)}</b> <span class="small muted">${esc(g.service)} · ${F.date(g.period_start)} a ${F.date(g.period_end)}</span></span><span class="num"><b>${esc(['valor_unico', 'mensalidade', 'receita'].includes(g.metric) ? F.brl(g.actual) : F.int(g.actual))}</b> de ${esc(['valor_unico', 'mensalidade', 'receita'].includes(g.metric) ? F.brl(g.target) : F.int(g.target))}</span></div>
        <div class="progress mt-s"><div style="width:${Math.min(100, g.pct || 0)}%;background:${g.pct >= 100 ? 'var(--green)' : 'var(--orange)'}"></div></div><div class="small muted">${F.pct(g.pct)} da meta</div></div>`).join('') : `<div class="empty">Nenhuma meta cadastrada para este período.${can('admin') ? '<br><br><button class="btn sm" data-go="#/configuracoes/metas">Cadastrar metas</button>' : ''}</div>`}
    </div></div>
  </div>`;

  $$('[data-kpi]', box).forEach(el => { el.onclick = () => kpiModal(d, el.dataset.kpi); });
  $$('[data-list=noNext]', box).forEach(el => { el.onclick = () => modal({ title: 'Oportunidades sem retorno agendado', size: 'wide', body: raw(recordsTable(d.noNext)) }); });
  $$('[data-brk]', box).forEach(el => { el.onclick = () => breakdownModal(el.dataset.brk, el.dataset.key, d); });
  $$('[data-loss]', box).forEach(el => { el.onclick = () => { const l = d.losses.find(x => x.reason === el.dataset.loss); modal({ title: 'Perdas: ' + l.reason, size: 'wide', body: raw(recordsTable(l.records)) }); }; });
  $$('[data-stage]', box).forEach(el => { el.onclick = () => { const s = d.funnel[Number(el.dataset.stage)]; modal({ title: `Chegaram à etapa "${s.name}"`, size: 'wide', body: raw(`<p class="small muted">Oportunidades que alcançaram esta etapa ou uma posterior.</p>${recordsTable(s.records)}`) }); }; });
}
function kpiModal(d, key) {
  const k = d.kpis.find(x => x.key === key); const recs = d.records[k.records] || [];
  const body = `<div class="card pad mb"><div class="small muted">Valor</div><div style="font-size:26px;font-weight:800;color:var(--navy)">${k.value === null || k.value === undefined ? 'Sem dados' : esc(F.val(k.value, k.fmt))}</div>
    <div class="mt-s"><b>Como é calculado:</b> ${esc(k.formula)}</div>
    <table class="t mt-s"><tbody>${(k.inputs || []).map(([l, v, fm]) => `<tr><td>${esc(l)}</td><td class="num"><b>${v === null || v === undefined ? '—' : esc(F.val(v, fm || 'int'))}</b></td></tr>`).join('')}</tbody></table>
    ${k.note ? `<p class="callout small mt-s">${esc(k.note)}</p>` : ''}
    <p class="small muted mt-s">Período: ${F.date(d.filters.from)} a ${F.date(d.filters.to)} · Visão: ${d.filters.view === 'cohort' ? 'coorte de leads' : 'atividade no período'} · Atribuição: ${d.filters.model === 'first' ? 'primeira origem do contato' : 'última interação antes da oportunidade'}.</p></div>
    <h3 class="mb">Registros considerados (${recs.length})</h3>${recordsTable(recs)}`;
  const m = modal({ title: k.label, size: 'wide', body: raw(body) });
  m.el.addEventListener('click', e => { if (e.target.closest('[data-open-contact],[data-go]')) m.close(); });
}
async function breakdownModal(by, key, d) {
  const q = Object.assign({}, S.dash, { by }); delete q.preset;
  const r = await GET('/api/analytics/compare?' + qs(q)); const row = r.rows.find(x => String(x.key) === String(key)); if (!row) return;
  const leadsRecs = row.ids.leads.map(id => ({ t: 'c', id, name: '…' }));
  // Busca nomes pelos registros já carregados do painel quando possível
  const known = new Map([...d.records.leads].map(x => [x.id, x]));
  const opps = new Map([...d.records.won, ...d.records.lost, ...d.records.done].map(x => [x.id, x]));
  const body = `<p class="small muted">${esc(row.sample.text)}</p>
    <h3 class="mt">Leads (${row.leads})</h3>${recordsTable(row.ids.leads.map(id => known.get(id) || { t: 'c', id, name: 'Contato #' + id, date: null, src: '', camp: '' }))}
    <h3 class="mt">Vendas (${row.won})</h3>${recordsTable(row.ids.won.map(id => opps.get(id)).filter(Boolean), { empty: 'Nenhuma venda.' })}
    <h3 class="mt">Perdas (${row.lost})</h3>${recordsTable(row.ids.lost.map(id => opps.get(id)).filter(Boolean), { empty: 'Nenhuma perda.' })}`;
  void leadsRecs;
  const m = modal({ title: row.label, size: 'wide', body: raw(body) });
  m.el.addEventListener('click', e => { if (e.target.closest('[data-open-contact]')) m.close(); });
}

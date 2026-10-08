'use strict';
/* Comparações (conteúdo, gancho, CTA, campanha, origem, serviço, responsável), perdas, atribuição,
   "O que melhorar" e integrações. */

const BY_LABEL = { content: 'Conteúdo', hook: 'Gancho', cta: 'CTA', campaign: 'Campanha', source: 'Origem', service: 'Serviço', owner: 'Responsável' };

route('/analises', async (main, p, alive) => {
  S.an = S.an || Object.assign(DASH_DEFAULT(), { preset: 'd90', from: periodPresets().d90[1], view: 'cohort', tab: 'compare', by: 'hook', lossBy: 'campaign' });
  const f = S.an;
  const tabs = [['compare', 'Comparar conteúdos, ganchos e CTAs'], ['losses', 'Perdas e objeções'], ['attr', 'Atribuição de vendas']];
  const draw = () => {
    main.innerHTML = `<div class="page-head"><div class="grow"><h1>Comparações e perdas</h1><p>O que gera volume, o que gera oportunidades qualificadas e vendas — e por que os leads não avançam.</p></div><div class="actions" id="saved"></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${f.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${filterBar(f, { showContent: f.tab !== 'compare', showModel: f.tab !== 'attr' })}<div class="callout navy small mb">${viewExplain(f)}</div><div id="an"></div>`;
    $$('[data-t]', main).forEach(b => { b.onclick = () => { f.tab = b.dataset.t; draw(); }; });
    wireFilterBar(main, f, () => draw());
    savedFiltersUi(main, 'analises', f, nf => { Object.assign(f, nf); draw(); });
    ({ compare: drawCompare, losses: drawLosses, attr: drawAttr })[f.tab]($('#an', main), f, alive);
  };
  S.refreshPage = draw; draw();
});
const qf = f => { const q = Object.assign({}, f); delete q.preset; delete q.tab; delete q.lossBy; return q; };

async function drawCompare(box, f, alive) {
  box.innerHTML = '<div class="empty">Calculando…</div>';
  const r = await GET('/api/analytics/compare?' + qs(qf(f))); if (!alive()) return;
  const rows = r.rows;
  const hasSpend = rows.some(x => x.spend);
  const volume = [...rows].filter(x => x.key !== 0).sort((a, b) => b.leads - a.leads).slice(0, 8);
  const quality = [...rows].filter(x => x.key !== 0 && x.leads).sort((a, b) => (b.qual_rate || 0) - (a.qual_rate || 0)).slice(0, 8);
  box.innerHTML = `<div class="filters"><div><div class="small muted" style="font-weight:600;margin-bottom:4px">Comparar por</div><div class="seg" id="by">${Object.entries(BY_LABEL).map(([k, l]) => `<button data-v="${k}" class="${f.by === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <button class="btn sm" style="margin-left:auto" data-download="/api/export/comparacao?${esc(qs(Object.assign(qf(f), { by: f.by })))}">${icon('download')}Exportar CSV</button></div>
    <div class="grid g2 mb">
      <div class="card"><div class="card-head"><h3>Quem gera volume</h3><span class="sub">leads identificados</span></div><div class="card-body">${barsHtml(volume.map(x => ({ label: x.label, value: x.leads, extra: `· ${x.won} venda(s)` })))}</div></div>
      <div class="card"><div class="card-head"><h3>Quem gera leads qualificados</h3><span class="sub">% qualificados (n = leads)</span></div><div class="card-body">${barsHtml(quality.map(x => ({ label: x.label, value: x.qual_rate, extra: `(n=${x.leads})` })), { fmt: F.pct, color: 'o' })}</div></div>
    </div>
    <div class="card"><div class="card-head"><h2>${BY_LABEL[f.by]}: do clique à venda</h2><span class="sub">${r.total_leads} lead(s) no recorte. Amostras abaixo de 10 leads não permitem conclusões.</span></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>${BY_LABEL[f.by]}</th>${f.by === 'content' ? '<th>Gancho / CTA</th>' : ''}${hasSpend ? '<th class="num">Invest.</th>' : ''}<th class="num">Cliques</th><th class="num">Conversas</th><th class="num">Leads</th><th class="num">Clique→lead</th><th class="num">Qualif.</th><th class="num">Reuniões</th><th class="num">Propostas</th><th class="num">Vendas</th><th class="num">Valor fechado</th>${hasSpend ? '<th class="num">CPL médio</th><th class="num">Custo/qualif.</th><th class="num">Mídia/cliente</th>' : ''}<th>Amostra</th></tr></thead><tbody>
    ${rows.map(x => `<tr><td><b>${esc(x.label)}</b>${x.campaign ? `<div class="small faint">${esc(x.campaign)}</div>` : ''}</td>${f.by === 'content' ? `<td class="small" style="max-width:240px">${esc(x.hook || '—')}<div class="muted">CTA: ${esc(x.cta || '—')}</div></td>` : ''}
      ${hasSpend ? `<td class="num">${x.spend === null ? '—' : F.brl(x.spend)}</td>` : ''}<td class="num">${F.int(x.clicks)}</td><td class="num">${F.int(x.conversations)}</td><td class="num"><b>${x.leads}</b></td><td class="num">${F.pct(x.click_to_lead)}</td>
      <td class="num">${x.qualified} <span class="small faint">${F.pct(x.qual_rate)}</span></td><td class="num">${x.meetings}</td><td class="num">${x.proposals}</td><td class="num">${x.won}</td><td class="num">${F.brl(x.one)}${x.monthly ? `<div class="small">${F.brl(x.monthly)}/mês</div>` : ''}</td>
      ${hasSpend ? `<td class="num">${F.brl(x.cpl)}</td><td class="num">${F.brl(x.cpql)}</td><td class="num">${F.brl(x.cpa)}</td>` : ''}<td class="small"><span class="chip ${x.sample.level === 'ok' ? 'green' : x.sample.level === 'pequena' ? 'amber' : ''}" title="${esc(x.sample.text)}">${x.sample.level === 'ok' ? 'suficiente' : x.sample.level}</span></td></tr>`).join('') || '<tr><td colspan="15" class="empty">Sem dados no recorte.</td></tr>'}</tbody></table></div></div>
    <p class="small muted mt-s">Investimento por ${BY_LABEL[f.by].toLowerCase()} só aparece quando as métricas foram registradas nesse nível (ex.: gasto por conteúdo). Investimento lançado só na campanha aparece em "Sem ${f.by === 'hook' ? 'gancho' : f.by === 'cta' ? 'CTA' : 'conteúdo'} identificado". Custos são médias atribuídas.</p>`;
  $('#by', box).onclick = e => { const b = e.target.closest('[data-v]'); if (b) { f.by = b.dataset.v; drawCompare(box, f, alive); } };
}

async function drawLosses(box, f, alive) {
  box.innerHTML = '<div class="empty">Calculando…</div>';
  const r = await GET('/api/analytics/losses?' + qs(Object.assign(qf(f), { by: f.lossBy }))); if (!alive()) return;
  const used = r.reasons.filter(re => r.rows.some(x => x.counts[re.id]));
  const max = Math.max(1, ...r.rows.flatMap(x => Object.values(x.counts)));
  box.innerHTML = `<div class="filters"><div><div class="small muted" style="font-weight:600;margin-bottom:4px">Cruzar motivos com</div><div class="seg" id="lby">${['campaign', 'content', 'hook', 'cta', 'service', 'source', 'owner'].map(k => `<button data-v="${k}" class="${f.lossBy === k ? 'on' : ''}">${BY_LABEL[k]}</button>`).join('')}</div></div>
    <span class="small muted" style="margin-left:auto">${r.total} perda(s) no recorte. ${esc(r.sample.text)}</span></div>
    <div class="card mb"><div class="card-head"><h2>Motivos de perda × ${BY_LABEL[f.lossBy].toLowerCase()}</h2></div>
    ${r.rows.length ? `<div class="table-wrap"><table class="t matrix"><thead><tr><th>${BY_LABEL[f.lossBy]}</th><th class="num">Perdas</th>${used.map(re => `<th class="center" style="white-space:normal;min-width:90px">${esc(re.name)}</th>`).join('')}</tr></thead><tbody>
      ${r.rows.map(x => `<tr><td><b>${esc(x.label)}</b></td><td class="num">${x.total}</td>${used.map(re => { const n = x.counts[re.id] || 0; return `<td class="cell">${n ? `<span style="background:rgba(239,100,6,${0.12 + 0.6 * n / max});font-weight:700">${n}</span>` : '<span class="faint">·</span>'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhuma perda no recorte.</div>'}</div>
    <div class="grid g2">
      <div class="card"><div class="card-head"><h2>Objeções registradas em perdas</h2><span class="chip">${r.objections.length}</span></div><div class="card-body">
        ${r.objections.length ? `<table class="t"><tbody>${r.objections.map(o => `<tr class="click" data-open-contact="${o.contact_id}" data-opp="${o.opp_id}"><td>“${esc(o.text)}”<div class="small muted">${esc(o.name || '')} · ${esc(o.reason)}</div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhuma objeção registrada.</div>'}
        ${r.otherObjections.length ? `<h3 class="mt">Objeções em oportunidades abertas ou ganhas</h3><table class="t mt-s"><tbody>${r.otherObjections.map(o => `<tr class="click" data-open-contact="${o.contact_id}" data-opp="${o.opp_id}"><td>“${esc(o.text)}”<div class="small muted">${esc(o.name || '')} · ${statusChip(o.status)}</div></td></tr>`).join('')}</tbody></table>` : ''}</div></div>
      <div class="card"><div class="card-head"><h2>Possibilidade de retomada</h2><span class="chip">${r.retake.length}</span><span class="sub">perdidas com data para retomar</span></div>${recordsTable(r.retake, { empty: 'Nenhuma retomada agendada.' })}</div>
    </div>
    <p class="small muted mt-s">Separe as causas para agir no lugar certo: preço e orçamento (oferta/proposta), urgência e entendimento do valor (conteúdo e abordagem), serviço incompatível (segmentação do marketing) e "não respondeu" (acompanhamento comercial).</p>`;
  $('#lby', box).onclick = e => { const b = e.target.closest('[data-v]'); if (b) { f.lossBy = b.dataset.v; drawLosses(box, f, alive); } };
}

async function drawAttr(box, f, alive) {
  const r = await GET('/api/analytics/attribution?' + qs(qf(f))); if (!alive()) return;
  const t = (m, title, desc) => `<div class="card"><div class="card-head"><h2>${title}</h2></div><div class="card-body"><p class="small muted" style="margin-top:0">${desc}</p>
    <table class="t"><thead><tr><th>Campanha / origem</th><th class="num">Vendas</th><th class="num">Valor único</th><th class="num">Mensalidades</th></tr></thead><tbody>
    ${m.rows.map(x => `<tr><td>${esc(x.label)}</td><td class="num">${x.won}</td><td class="num">${F.brl(x.one)}</td><td class="num">${x.monthly ? F.brl(x.monthly) + '/mês' : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhuma venda no período.</td></tr>'}</tbody>
    <tfoot><tr><td>Total (cada venda contada uma vez)</td><td class="num">${m.total_won}</td><td class="num">${F.brl(m.total_one)}</td><td class="num">${m.total_monthly ? F.brl(m.total_monthly) + '/mês' : '—'}</td></tr></tfoot></table></div></div>`;
  box.innerHTML = `<div class="grid g2">${t(r.models.first, 'Primeira origem conhecida', 'Cada venda vai para a primeira campanha/origem pela qual o contato chegou. Mostra o que <b>atrai</b> clientes.')}
    ${t(r.models.opp, 'Última interação antes da oportunidade', 'Cada venda vai para a origem registrada na oportunidade (a última interação conhecida quando ela foi aberta). Mostra o que <b>converte</b> em atendimento.')}</div>
    <p class="callout small mt">Os dois relatórios usam as mesmas vendas fechadas entre ${F.date(f.from)} e ${F.date(f.to)}. Não some os totais dos dois modelos: é a mesma receita vista de dois ângulos. Vendas sem origem registrada aparecem como "Não identificado".</p>`;
}

// ---------- o que melhorar ----------
route('/melhorar', async (main, p, alive) => {
  S.imp = S.imp || Object.assign(DASH_DEFAULT(), { preset: 'd90', from: periodPresets().d90[1], view: 'cohort' });
  const f = S.imp;
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>O que melhorar</h1><p>Observações geradas a partir dos dados registrados. <b>Fatos</b> são números; <b>hipóteses</b> e <b>testes</b> são sugestões para investigar — correlação não prova causa.</p></div></div>
    ${filterBar(f, { showView: false, showKind: false, showOwner: false })}<div id="imp"></div>`;
  const load = async () => {
    const q = qf(f); const r = await GET('/api/analytics/improve?' + qs(q)); if (!alive()) return;
    const sev = { urgente: 'red', 'atenção': 'amber', informativo: 'blue', positivo: 'green' };
    $('#imp', main).innerHTML = `<p class="callout navy small mb">Período analisado: leads captados entre ${F.date(r.filters.from)} e ${F.date(r.filters.to)} (coorte), mais a situação atual do funil. ${esc(r.note)}</p>
      ${r.items.length ? r.items.map(i => `<div class="insight"><div class="top"><span class="chip ${sev[i.severity]}">${esc(i.severity)}</span><span class="chip navy">${esc(i.area)}</span><b>${esc(i.title)}</b></div>
        <div class="row"><span>Fato observado</span><span>${esc(i.fact)}</span></div>
        ${i.hypothesis ? `<div class="row"><span>Hipótese</span><span>${esc(i.hypothesis)}</span></div>` : ''}
        <div class="row"><span>Teste / ação</span><span>${esc(i.test)}</span></div>
        <div class="row"><span>Base</span><span class="small muted">${esc(i.sample ? i.sample.text : '')} ${esc(i.rule || '')} ${i.ids ? `<button class="btn link small" data-ids="${i.ids.join(',')}">ver oportunidades</button>` : ''}</span></div></div>`).join('')
        : '<div class="empty"><b>Nenhuma observação com os dados atuais.</b>As regras precisam de volume mínimo (ex.: 100 cliques, 10 leads, 5 propostas) para não sugerir conclusões com poucos registros.</div>'}`;
    $$('[data-ids]', main).forEach(b => { b.onclick = async () => {
      const ids = b.dataset.ids.split(',').map(Number); const cards = await GET('/api/opportunities?closed_days=all');
      const recs = cards.filter(c => ids.includes(c.id)).map(c => ({ t: 'o', id: c.id, contact_id: c.contact_id, name: c.name, company: c.company, service: c.service || '—', stage: (byId('stages', c.stage_id) || {}).name, status: c.status, value: c.estimated_value, date: c.next_action_date, next_action: c.next_action, next_action_date: c.next_action_date }));
      const m = modal({ title: 'Oportunidades', size: 'wide', body: raw(recordsTable(recs)) }); m.el.addEventListener('click', e => { if (e.target.closest('[data-open-contact]')) m.close(); });
    }; });
  };
  const rewire = () => { $('#fbar', main).outerHTML = filterBar(f, { showView: false, showKind: false, showOwner: false }); wireFilterBar(main, f, () => { rewire(); load(); }); };
  wireFilterBar(main, f, () => { rewire(); load(); });
  S.refreshPage = load; await load();
});

// ---------- integrações ----------
route('/integracoes', async (main, p, alive) => {
  const list = await GET('/api/integrations'); if (!alive()) return;
  const chip = s => s === 'ativo' ? '<span class="chip green">Ativo</span>' : s === 'credenciais' ? '<span class="chip amber">Credenciais informadas</span>' : '<span class="chip">Não conectado</span>';
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Integrações</h1><p>Situação real de cada conexão. Nada aqui é simulado: sem integração configurada, os dados entram por cadastro manual ou importação CSV e <b>não são em tempo real</b>.</p></div></div>
    ${list.map(i => `<div class="card mb"><div class="card-head"><h2>${esc(i.name)}</h2>${chip(i.status)}${i.implemented ? '<span class="chip navy">Implementado no sistema</span>' : '<span class="chip">Estrutura preparada — depende de configuração externa</span>'}</div><div class="card-body">
      <p style="margin-top:0">${esc(i.what)}</p><p class="small"><b>Situação:</b> ${esc(i.statusLabel)}</p>
      <h3 class="mt-s">O que é necessário</h3><ul class="small">${i.needs.map(n => `<li>${esc(n)}</li>`).join('')}</ul><p class="small muted"><b>Custos externos:</b> ${esc(i.cost)}</p>
      ${i.key === 'form' ? `<details class="small"><summary>Como enviar dados do formulário</summary><p>Envie um <code class="inline">POST</code> para <code class="inline">${esc(location.origin)}/api/webhooks/form</code> com o cabeçalho <code class="inline">X-Webhook-Token</code> e um JSON com: <code class="inline">nome, telefone, email, empresa, cidade, servico, mensagem, origem, campanha, conteudo, utm_source, utm_medium, utm_campaign, utm_content, utm_term</code>. Contatos existentes (mesmo telefone ou e-mail) recebem uma nova interação em vez de um cadastro duplicado.</p></details>` : ''}
    </div></div>`).join('')}`;
});

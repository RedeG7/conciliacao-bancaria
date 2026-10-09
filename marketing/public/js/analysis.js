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
  const admin = S.me.user.role === 'admin';
  const canSync = admin || S.me.user.role === 'marketing';
  const metaForm = () => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin:10px 0;max-width:760px">
      <label class="f">ID da conta de anúncios<input id="meta-acc" placeholder="ex.: act_1234567890 ou 1234567890" autocomplete="off"></label>
      <label class="f">Token de acesso (usuário do sistema)<input id="meta-tok" type="password" placeholder="cole o token aqui" autocomplete="off"></label></div>
    <button class="btn primary sm" id="meta-connect">Conectar e buscar 30 dias</button>`;
  const chip = s => s === 'ativo' ? '<span class="chip green">Ativo</span>' : s === 'credenciais' ? '<span class="chip amber">Credenciais informadas</span>' : '<span class="chip">Não conectado</span>';
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Integrações</h1><p>Situação real de cada conexão. Nada aqui é simulado: sem integração configurada, os dados entram por cadastro manual ou importação CSV e <b>não são em tempo real</b>.</p></div></div>
    ${list.map(i => `<div class="card mb"><div class="card-head"><h2>${esc(i.name)}</h2>${chip(i.status)}${i.implemented ? '<span class="chip navy">Implementado no sistema</span>' : '<span class="chip">Estrutura preparada — depende de configuração externa</span>'}</div><div class="card-body">
      <p style="margin-top:0">${esc(i.what)}</p><p class="small"><b>Situação:</b> ${esc(i.statusLabel)}</p>
      <h3 class="mt-s">O que é necessário</h3><ul class="small">${i.needs.map(n => `<li>${esc(n)}</li>`).join('')}</ul><p class="small muted"><b>Custos externos:</b> ${esc(i.cost)}</p>
      ${i.key === 'form' ? formBox(i) : ''}${i.key === 'meta' ? metaBox(i) : ''}${i.key === 'google' ? googleBox(i) : ''}
    </div></div>`).join('')}`;
  const show = token => {
    const url = `${location.origin}/api/webhooks/form`;
    $('#form-token-out', main).innerHTML = `<div class="callout"><b>Copie agora — este código não será mostrado de novo.</b><br>
      Código: <code class="inline">${esc(token)}</code><br>
      Endereço: <code class="inline">${esc(url)}?token=${esc(token)}</code><br>
      <span class="small">Ou envie para <code class="inline">${esc(url)}</code> com o cabeçalho <code class="inline">X-Webhook-Token: ${esc(token)}</code>.</span></div>`;
  };
  const gen = $('#form-token-gen', main); const off = $('#form-token-off', main);
  if (gen) gen.onclick = async () => {
    if (gen.dataset.has === '1' && !(await confirmDlg('Gerar um novo código? O código atual deixa de funcionar e o site precisa ser atualizado.', { ok: 'Gerar novo código' }))) return;
    const r = await POST('/api/integrations/form-token'); show(r.token); toast('Código do formulário gerado.');
    gen.dataset.has = '1'; gen.textContent = 'Gerar novo código';
  };
  if (off) off.onclick = async () => {
    if (!(await confirmDlg('Desativar o formulário? Os envios do site deixam de entrar no sistema.', { danger: true, ok: 'Desativar' }))) return;
    await DEL('/api/integrations/form-token'); toast('Formulário desativado.'); render();
  };
  const meta = list.find(i => i.key === 'meta');
  if (meta) {
    const wireConnect = () => { const b = $('#meta-connect', main); if (b) b.onclick = async () => {
      b.disabled = true; b.textContent = 'Conectando…';
      try { const r = await POST('/api/integrations/meta', { account_id: $('#meta-acc', main).value, token: $('#meta-tok', main).value });
        toast(`Meta Ads conectado: ${r.linhas} linhas lidas (${r.novos} novas, ${r.atualizados} atualizadas).`); render(); }
      catch (x) { toast(x.message, { err: true }); b.disabled = false; b.textContent = 'Conectar e buscar 30 dias'; } }; };
    wireConnect();
    const sync = $('#meta-sync', main); if (sync) sync.onclick = async () => {
      sync.disabled = true; sync.textContent = 'Sincronizando…';
      try { const r = await POST('/api/integrations/meta/sync', { days: 30 }); toast(`Sincronizado: ${r.linhas} linhas (${r.novos} novas, ${r.atualizados} atualizadas).`); render(); }
      catch (x) { toast(x.message, { err: true }); render(); } };
    const swap = $('#meta-swap', main); if (swap) swap.onclick = () => { $('#meta-swap-area', main).innerHTML = metaForm(); wireConnect(); };
    const off = $('#meta-off', main); if (off) off.onclick = async () => {
      if (!(await confirmDlg('Desconectar o Meta Ads? As métricas já importadas continuam; só param as novas sincronizações.', { danger: true, ok: 'Desconectar' }))) return;
      await DEL('/api/integrations/meta'); toast('Meta Ads desconectado.'); render(); };
  }
  const goo = list.find(i => i.key === 'google');
  if (goo) {
    const wireG = () => { const b = $('#g-connect', main); if (b) b.onclick = async () => {
      b.disabled = true;
      try { const r = await POST('/api/integrations/google/start', { customer_id: $('#g-cid', main).value, login_customer_id: $('#g-login', main).value }); location.href = r.url; }
      catch (x) { toast(x.message, { err: true }); b.disabled = false; } }; };
    wireG();
    const gs = $('#g-sync', main); if (gs) gs.onclick = async () => {
      gs.disabled = true; gs.textContent = 'Sincronizando…';
      try { const r = await POST('/api/integrations/google/sync', { days: 30 }); toast(`Sincronizado: ${r.linhas} linhas (${r.novos} novas, ${r.atualizados} atualizadas).`); render(); }
      catch (x) { toast(x.message, { err: true }); render(); } };
    const gw = $('#g-swap', main); if (gw) gw.onclick = () => { $('#g-swap-area', main).innerHTML = googleForm(); wireG(); };
    const go = $('#g-off', main); if (go) go.onclick = async () => {
      if (!(await confirmDlg('Desconectar o Google Ads? As métricas já importadas continuam; só param as novas sincronizações.', { danger: true, ok: 'Desconectar' }))) return;
      await DEL('/api/integrations/google'); toast('Google Ads desconectado.'); render(); };
  }
  function googleForm() {
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin:10px 0;max-width:760px">
      <label class="f">ID do cliente Google Ads<input id="g-cid" placeholder="ex.: 123-456-7890" autocomplete="off"></label>
      <label class="f">ID da conta administradora (MCC) — opcional<input id="g-login" placeholder="só se a conta for gerida por uma MCC" autocomplete="off"></label></div>
      <button class="btn primary sm" id="g-connect">Conectar com Google</button>`;
  }
  function googleBox(i) {
    const g = i.google || {};
    const when = d => d ? new Date(d).toLocaleString('pt-BR') : '—';
    const how = `<details class="small" style="margin-top:10px"><summary>Como conectar</summary><ol>
      <li>Ache o <b>ID do cliente</b> no canto superior direito do Google Ads (formato 123-456-7890).</li>
      <li>Se a conta é gerenciada por uma conta administradora (MCC) e o acesso é por ela, informe também o ID da MCC.</li>
      <li>Clique em <b>Conectar com Google</b> e entre com uma conta Google que tenha acesso a essa conta de anúncios; aceite a permissão do Google Ads.</li>
      <li>Você volta para esta tela e o sistema já busca os últimos 30 dias. O acesso fica guardado cifrado e só vale para este escritório.</li></ol></details>`;
    if (!g.platformReady) return '<p class="small muted">A integração Google Ads ainda precisa ser habilitada no servidor (credenciais da plataforma, uma vez só). Fale com a RedeG7.</p>';
    if (!g.connected) return admin ? `${googleForm()}${how}` : '<p class="small muted">Só administradores conectam o Google Ads.</p>';
    return `<div class="callout small"><b>Cliente:</b> ${esc(g.customer_id)} &nbsp;·&nbsp; <b>Última sincronização:</b> ${esc(when(g.last_sync))}${g.last_count !== null && g.last_count !== undefined ? ` (${esc(String(g.last_count))} linhas)` : ''}
      ${g.last_error ? `<br><b style="color:#b42318">Erro na última tentativa:</b> ${esc(g.last_error)}` : ''}</div>
      <div class="row" style="gap:8px;margin:10px 0">${canSync ? '<button class="btn primary sm" id="g-sync">Sincronizar agora (30 dias)</button>' : ''}
      ${admin ? '<button class="btn sm" id="g-swap">Trocar conta</button><button class="btn sm" id="g-off">Desconectar</button>' : ''}</div>
      <div id="g-swap-area"></div>${admin ? how : ''}`;
  }
  function metaBox(i) {
    const m = i.meta || {};
    const when = d => d ? new Date(d).toLocaleString('pt-BR') : '—';
    const how = `<details class="small" style="margin-top:10px"><summary>Como gerar o token e achar o ID da conta</summary><ol>
      <li>Entre em <b>business.facebook.com</b> › Configurações do negócio (Business Settings).</li>
      <li>Em <b>Usuários › Usuários do sistema</b>, clique em <b>Adicionar</b>, dê um nome (ex.: "Hub Marketing") e escolha a função <b>Funcionário</b>.</li>
      <li>Com o usuário do sistema selecionado, clique em <b>Atribuir ativos</b> › <b>Contas de anúncios</b>, marque a conta e dê a permissão <b>Ver desempenho</b> (ou Gerenciar campanhas).</li>
      <li>Em <b>Contas › Apps</b>, crie (ou use) um app do tipo Empresa e atribua esse app ao usuário do sistema.</li>
      <li>Ainda no usuário do sistema, clique em <b>Gerar novo token</b>, escolha o app, validade <b>Nunca expira</b> e marque a permissão <b>ads_read</b>. Copie o token.</li>
      <li>O <b>ID da conta de anúncios</b> está no Gerenciador de Anúncios (número ao lado do nome da conta, ou em Configurações do negócio › Contas de anúncios).</li>
      <li>Cole os dois aqui e clique em <b>Conectar</b>. O token fica guardado cifrado e só vale para este escritório.</li></ol></details>`;
    if (!m.connected) return admin ? `${metaForm()}${how}` : '<p class="small muted">Só administradores conectam o Meta Ads.</p>';
    return `<div class="callout small"><b>Conta:</b> ${esc(m.account_id)} &nbsp;·&nbsp; <b>Última sincronização:</b> ${esc(when(m.last_sync))}${m.last_count !== null && m.last_count !== undefined ? ` (${esc(String(m.last_count))} linhas)` : ''}
      ${m.last_error ? `<br><b style="color:#b42318">Erro na última tentativa:</b> ${esc(m.last_error)}` : ''}</div>
      <div class="row" style="gap:8px;margin:10px 0">${canSync ? '<button class="btn primary sm" id="meta-sync">Sincronizar agora (30 dias)</button>' : ''}
      ${admin ? '<button class="btn sm" id="meta-swap">Trocar token/conta</button><button class="btn sm" id="meta-off">Desconectar</button>' : ''}</div>
      <div id="meta-swap-area"></div>${admin ? how : ''}`;
  }
  function formBox(i) {
    const has = i.status === 'ativo';
    return `${admin ? `<div class="row" style="gap:8px;margin:10px 0"><button class="btn primary sm" id="form-token-gen" data-has="${has ? 1 : 0}">${has ? 'Gerar novo código' : 'Gerar código'}</button>${has ? '<button class="btn sm" id="form-token-off">Desativar</button>' : ''}</div>` : '<p class="small muted">Só administradores geram o código do formulário.</p>'}
      <div id="form-token-out"></div>
      <details class="small"><summary>Como enviar dados do formulário</summary><p>Envie um <code class="inline">POST</code> para <code class="inline">${esc(location.origin)}/api/webhooks/form?token=SEU_CÓDIGO</code> (ou com o cabeçalho <code class="inline">X-Webhook-Token</code>) e um JSON com: <code class="inline">nome, telefone, email, empresa, cidade, servico, mensagem, origem, campanha, conteudo, utm_source, utm_medium, utm_campaign, utm_content, utm_term</code>. Contatos existentes (mesmo telefone ou e-mail) recebem uma nova interação em vez de um cadastro duplicado. Os leads entram no escritório dono do código.</p></details>`;
  }
});

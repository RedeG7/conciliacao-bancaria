'use strict';
/* Ficha do contato/oportunidade, cadastro rápido de lead e movimentação de etapas. */

function dataChanged() { if (S.refreshPage) S.refreshPage(); refreshAlerts(); }

function touchFields(v = {}) {
  return [
    { section: 'Origem (de onde veio este contato)' },
    { name: 'source_id', label: 'Origem', type: 'select', options: opts(listOf('sources', v.source_id), v.source_id, { empty: 'Não identificado' }) },
    { name: 'type', label: 'Tipo de interação', type: 'select', options: mapOpts(LBL.touch, v.type || 'atendimento') },
    { name: 'campaign_id', label: 'Campanha', type: 'select', options: opts(listOf('campaigns', v.campaign_id), v.campaign_id, { empty: 'Não identificada' }) },
    { name: 'content_id', label: 'Conteúdo / anúncio', type: 'select', options: opts(listOf('contents', v.content_id), v.content_id, { empty: 'Não identificado', label: x => x.title }) },
    { name: 'occurred_at', label: 'Data da interação', type: 'date', value: v.occurred_at || today() },
    { name: 'note', label: 'Observação da interação', placeholder: 'Ex.: respondeu ao Reels pelo direct' },
    { section: 'UTMs (preencha quando estiverem disponíveis)' },
    { name: 'utm_source', label: 'utm_source', value: v.utm_source }, { name: 'utm_medium', label: 'utm_medium', value: v.utm_medium },
    { name: 'utm_campaign', label: 'utm_campaign', value: v.utm_campaign }, { name: 'utm_content', label: 'utm_content', value: v.utm_content },
  ];
}
// conteúdo escolhido preenche campanha; campanha filtra conteúdos
function wireOrigin(form) {
  const camp = form.elements.campaign_id; const cont = form.elements.content_id; if (!camp || !cont) return;
  const all = listOf('contents');
  const refill = () => { const cur = cont.value; const list = camp.value ? all.filter(c => String(c.campaign_id) === camp.value) : all; cont.innerHTML = opts(list, cur, { empty: 'Não identificado', label: x => x.title }); };
  camp.addEventListener('change', refill);
  cont.addEventListener('change', () => { const c = all.find(x => String(x.id) === cont.value); if (c && c.campaign_id && !camp.value) { camp.value = c.campaign_id; refill(); cont.value = c.id; } });
}
function oppFields(v = {}, { withNext = true } = {}) {
  const sellers = (S.boot.users || []).filter(u => u.active);
  const f = [
    { name: 'service_id', label: 'Serviço de interesse', type: 'select', options: opts(listOf('services', v.service_id), v.service_id, { empty: 'Selecione…' }) },
    { name: 'owner_id', label: 'Responsável comercial', type: 'select', required: true, options: opts(sellers, v.owner_id || (can('comercial', 'admin') ? S.me.user.id : ''), { empty: 'Selecione…' }) },
    { name: 'estimated_value', label: 'Valor estimado (R$)', type: 'money', value: v.estimated_value },
    { name: 'urgency', label: 'Urgência', type: 'select', options: mapOpts(LBL.urgency, v.urgency || 'desconhecida') },
    { name: 'need', label: 'Necessidade principal', type: 'textarea', value: v.need, full: true, placeholder: 'O que o cliente precisa resolver?' },
    { name: 'difficulty', label: 'Dificuldade relatada', type: 'textarea', value: v.difficulty, full: true },
    { name: 'deadline', label: 'Prazo do cliente', value: v.deadline, placeholder: 'Ex.: até o fim da obra, 30 dias' },
    { name: 'budget_range', label: 'Faixa de orçamento', value: v.budget_range, placeholder: 'Ex.: até R$ 5 mil / não informou' },
  ];
  if (withNext) f.push({ name: 'next_action', label: 'Próxima ação', required: true, value: v.next_action || 'Fazer primeiro contato' }, { name: 'next_action_date', label: 'Prazo da próxima ação', type: 'date', required: true, value: v.next_action_date || today() });
  return f;
}

// ---------- novo lead ----------
function newContactModal(prefill = {}) {
  const sellers = (S.boot.users || []).filter(u => u.active);
  const fields = [
    { section: 'Contato' },
    { name: 'name', label: 'Nome', required: true }, { name: 'phone', label: 'Telefone / WhatsApp', type: 'tel', placeholder: '(62) 99999-9999' },
    { name: 'email', label: 'E-mail', type: 'email' }, { name: 'company', label: 'Empresa' }, { name: 'city', label: 'Cidade' },
    { name: 'kind', label: 'Tipo de contato', type: 'select', options: mapOpts(LBL.kind, prefill.kind || 'cliente_potencial') },
    { name: 'profile', label: 'Perfil', type: 'select', options: mapOpts(LBL.profile, prefill.profile, 'Não informado') },
    { name: 'decision_maker', label: 'Participa da decisão?', type: 'select', options: mapOpts(LBL.decision, 'desconhecido') },
    { name: 'captured_at', label: 'Data de captação', type: 'date', value: today() },
    { name: 'contact_owner_id', label: 'Responsável pelo contato', type: 'select', options: opts(sellers, can('comercial', 'admin') ? S.me.user.id : '', { empty: 'Sem responsável' }) },
    ...touchFields({ type: 'atendimento' }),
    { section: 'Oportunidade comercial' },
    { name: 'create_opp', label: 'Criar oportunidade no funil para este contato', type: 'checkbox', value: true, full: true },
    ...oppFields({}),
  ];
  formModal({ title: 'Novo lead / contato', size: 'wide', submit: 'Salvar contato', fields, values: prefill,
    intro: H`<p class="muted small" style="margin-top:0">Telefone ou e-mail é obrigatório e usado para evitar cadastros duplicados. Dados desconhecidos podem ficar em branco.</p>`,
    onMount: (m, form) => {
      wireOrigin(form);
      const toggle = () => { const on = form.elements.create_opp.checked; ['service_id', 'owner_id', 'estimated_value', 'urgency', 'need', 'difficulty', 'deadline', 'budget_range', 'next_action', 'next_action_date'].forEach(n => { form.elements[n].closest('label').style.display = on ? '' : 'none'; }); };
      form.elements.create_opp.onchange = toggle;
      form.elements.kind.onchange = () => { form.elements.create_opp.checked = form.elements.kind.value !== 'parceiro'; toggle(); };
    },
    onSubmit: async (v, m) => saveNewContact(v, m, false) });
}
async function saveNewContact(v, m, force) {
  const contact = { name: v.name, phone: v.phone, email: v.email, company: v.company, city: v.city, kind: v.kind, profile: v.profile, decision_maker: v.decision_maker, captured_at: v.captured_at, owner_id: v.contact_owner_id || (v.create_opp ? v.owner_id : '') };
  const touch = { source_id: v.source_id, campaign_id: v.campaign_id, content_id: v.content_id, type: v.type, occurred_at: v.occurred_at, note: v.note, utm_source: v.utm_source, utm_medium: v.utm_medium, utm_campaign: v.utm_campaign, utm_content: v.utm_content };
  const opp = v.create_opp ? { create: true, service_id: v.service_id, owner_id: v.owner_id, estimated_value: v.estimated_value, urgency: v.urgency, need: v.need, difficulty: v.difficulty, deadline: v.deadline, budget_range: v.budget_range, next_action: v.next_action, next_action_date: v.next_action_date } : null;
  if (opp && (!opp.owner_id || !opp.next_action || !opp.next_action_date)) throw new Error('Para criar a oportunidade, informe responsável, próxima ação e prazo.');
  try {
    const r = await POST('/api/contacts', { contact, touch, opp, force });
    toast('Contato salvo.', { action: { label: 'Abrir ficha', fn: () => openContact(r.id, r.oppId) } }); dataChanged(); return true;
  } catch (e) {
    if (e.status !== 409) throw e;
    const d = e.data.duplicates;
    const dm = modal({ title: 'Possível contato duplicado', body: H`<p>${e.data.error}</p>
      <table class="t"><thead><tr><th>Nome</th><th>Telefone</th><th>E-mail</th><th></th></tr></thead><tbody>${d.map(x => H`<tr><td><b>${x.name}</b>${x.archived ? raw(' <span class="chip">arquivado</span>') : ''}<div class="small muted">${x.company || ''}</div></td><td>${x.phone || '—'}</td><td>${x.email || '—'}</td>
      <td class="nowrap"><button class="btn sm" data-open="${x.id}">Abrir</button> <button class="btn sm primary" data-addopp="${x.id}">Nova oportunidade aqui</button></td></tr>`)}</tbody></table>
      <p class="small muted">Um contato pode ter várias oportunidades. Prefira adicionar uma nova oportunidade ao cadastro existente.</p>`,
      foot: H`<button class="btn" data-close>Voltar</button><button class="btn" data-force>Criar mesmo assim</button>` });
    dm.el.onclick = async ev => {
      const o = ev.target.closest('[data-open]'); const a = ev.target.closest('[data-addopp]');
      if (o) { dm.close(); m.close(); openContact(Number(o.dataset.open)); }
      if (a) { dm.close(); m.close(); const id = Number(a.dataset.addopp); await POST('/api/touchpoints', Object.assign({ contact_id: id }, touch)).catch(() => {}); newOppModal(id, opp || {}); }
      if (ev.target.closest('[data-force]')) { dm.close(); try { await saveNewContact(v, m, true); m.close(); } catch (x) { fail(x); } }
    };
    return false;
  }
}
function newOppModal(contactId, prefill = {}) {
  const stages = listOf('stages').filter(s => s.kind === 'open');
  const fields = oppFields(prefill);
  if (can('admin', 'comercial')) fields.unshift({ name: 'stage_id', label: 'Etapa inicial', type: 'select', options: opts(stages, stages[0] && stages[0].id) });
  fields.push({ section: 'Origem desta oportunidade' }, { name: 'origin_mode', label: 'Origem', type: 'select', full: true, options: '<option value="last">Usar a última interação registrada do contato</option><option value="manual">Informar manualmente</option>' },
    { name: 'source_id', label: 'Origem', type: 'select', options: opts(listOf('sources'), '', { empty: 'Não identificado' }) },
    { name: 'campaign_id', label: 'Campanha', type: 'select', options: opts(listOf('campaigns'), '', { empty: 'Não identificada' }) },
    { name: 'content_id', label: 'Conteúdo', type: 'select', full: true, options: opts(listOf('contents'), '', { empty: 'Não identificado', label: x => x.title }) });
  formModal({ title: 'Nova oportunidade', size: 'wide', fields, values: prefill, onMount: (m, form) => {
    wireOrigin(form);
    const t = () => ['source_id', 'campaign_id', 'content_id'].forEach(n => { form.elements[n].closest('label').style.display = form.elements.origin_mode.value === 'manual' ? '' : 'none'; });
    form.elements.origin_mode.onchange = t; t();
  }, onSubmit: async v => {
    const body = Object.assign({}, v, { contact_id: contactId });
    if (v.origin_mode !== 'manual') { delete body.source_id; delete body.campaign_id; delete body.content_id; }
    const r = await POST('/api/opportunities', body); toast('Oportunidade criada.'); dataChanged(); openContact(contactId, r.id);
  } });
}

// ---------- movimentação ----------
async function moveOpp(opp, stageId) {
  const st = byId('stages', stageId); if (!st) return null;
  if (st.kind === 'won') return wonModal(opp, stageId);
  if (st.kind === 'lost') return lostModal(opp, stageId);
  const r = await POST(`/api/opportunities/${opp.id}/move`, { stage_id: stageId });
  toast(`Movida para "${st.name}".`, { action: { label: 'Atualizar próxima ação', fn: () => nextActionModal(r) } });
  dataChanged(); return r;
}
function nextActionModal(opp) {
  formModal({ title: 'Próxima ação', fields: [{ name: 'next_action', label: 'Próxima ação', required: true, value: opp.next_action, full: true }, { name: 'next_action_date', label: 'Prazo', type: 'date', required: true, value: opp.next_action_date && opp.next_action_date >= today() ? opp.next_action_date : today() }],
    onSubmit: async v => { await PUT('/api/opportunities/' + opp.id, v); toast('Próxima ação atualizada.'); dataChanged(); } });
}
function wonModal(opp, stageId) {
  return new Promise(res => {
    let done = false;
    formModal({ title: 'Registrar venda (ganho)', submit: 'Confirmar ganho',
      intro: H`<p class="callout navy small" style="margin-top:0">Pagamento único e mensalidade são registrados separadamente. O total do contrato só é calculado quando você informa a quantidade de meses. A receita recebida é registrada depois, em "Recebimentos".</p><br>`,
      fields: [
        { name: 'won_at', label: 'Data do fechamento', type: 'date', required: true, value: today() },
        { name: 'service_id', label: 'Serviço contratado', type: 'select', required: true, options: opts(listOf('services', opp.service_id), opp.service_id, { empty: 'Selecione…' }) },
        { name: 'contract_type', label: 'Tipo de contrato', type: 'select', required: true, full: true, options: mapOpts(LBL.contract, 'unico') },
        { name: 'one_time_value', label: 'Valor do pagamento único (R$)', type: 'money', value: opp.estimated_value },
        { name: 'monthly_value', label: 'Valor da mensalidade (R$/mês)', type: 'money' },
        { name: 'contract_months', label: 'Meses de vigência (opcional)', type: 'number', attrs: 'min="1"', help: 'Necessário para calcular o valor total do contrato.' },
        { name: 'win_factors', label: 'O que contribuiu para o fechamento?', type: 'textarea', full: true, help: 'Retorno para o marketing: o que convenceu o cliente.' },
      ],
      onMount: (m, form) => { const t = () => { const ty = form.elements.contract_type.value; form.elements.one_time_value.closest('label').style.display = ty === 'mensal' ? 'none' : ''; ['monthly_value', 'contract_months'].forEach(n => { form.elements[n].closest('label').style.display = ty === 'unico' ? 'none' : ''; }); }; form.elements.contract_type.onchange = t; t(); },
      onSubmit: async v => { const r = await POST(`/api/opportunities/${opp.id}/move`, { stage_id: stageId, won: v }); done = true; toast('Venda registrada.'); dataChanged(); res(r); },
      onClose: () => { if (!done) res(null); },
    });
  });
}
function lostModal(opp, stageId) {
  return new Promise(res => {
    let done = false;
    formModal({ title: 'Registrar perda', submit: 'Confirmar perda', fields: [
      { name: 'loss_reason_id', label: 'Motivo principal', type: 'select', required: true, full: true, options: opts(listOf('loss_reasons'), '', { empty: 'Selecione…' }) },
      { name: 'objection', label: 'Objeção apresentada (nas palavras do cliente)', type: 'textarea', full: true, value: opp.objection },
      { name: 'loss_detail', label: 'Detalhes da perda', type: 'textarea', full: true, help: 'Por que desistiu? O lead tinha perfil? Houve falha no acompanhamento?' },
      { name: 'lost_at', label: 'Data da perda', type: 'date', value: today() },
      { name: 'retake_date', label: 'Retomar contato em (opcional)', type: 'date' },
    ], onSubmit: async v => { const r = await POST(`/api/opportunities/${opp.id}/move`, { stage_id: stageId, lost: v }); done = true; toast('Perda registrada.'); dataChanged(); res(r); },
    onClose: () => { if (!done) res(null); } });
  });
}

// ---------- ficha ----------
let drawerState = null;
async function openContact(id, oppId, tab) {
  closeDrawer(true);
  const ov = document.createElement('div'); ov.className = 'drawer-ov'; ov.onclick = () => closeDrawer();
  const dr = document.createElement('aside'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-label', 'Ficha do contato');
  dr.innerHTML = '<div class="drawer-body"><div class="empty">Carregando…</div></div>';
  document.body.append(ov, dr);
  drawerState = { id, oppId, tab: tab || (oppId ? 'opp' : null), el: dr, ov };
  document.addEventListener('keydown', drawerKey);
  await loadDrawer();
}
function drawerKey(e) { if (e.key === 'Escape' && !document.querySelector('.overlay')) closeDrawer(); }
function closeDrawer(silent) {
  if (!drawerState) return; drawerState.el.remove(); drawerState.ov.remove(); drawerState = null; document.removeEventListener('keydown', drawerKey);
}
async function loadDrawer() {
  const st = drawerState; if (!st) return;
  let d; try { d = await GET('/api/contacts/' + st.id); } catch (e) { st.el.innerHTML = `<div class="drawer-body"><div class="empty">${esc(e.message)}</div></div>`; return; }
  if (drawerState !== st) return;
  st.data = d;
  if (!st.tab) st.tab = d.opportunities.length ? 'opp' : 'dados';
  if (!st.oppId && d.opportunities.length) st.oppId = (d.opportunities.find(o => o.status === 'open') || d.opportunities[0]).id;
  const c = d.contact;
  const tabs = [['opp', `Oportunidades (${d.opportunities.length})`], ['dados', 'Dados do contato'], ['origem', `Origem e interações (${d.touchpoints.length})`], ['notas', `Anotações e tarefas (${d.notes.length + d.tasks.filter(t => !t.done_at).length})`], ['hist', 'Histórico']];
  st.el.innerHTML = `<div class="drawer-head"><span class="avatar" style="width:42px;height:42px;background:var(--orange);font-size:15px">${esc(initials(c.name))}</span>
      <div style="flex:1;min-width:0"><h2>${esc(c.name)}</h2><div class="sub">${esc([c.company, c.city, LBL.profile[c.profile]].filter(Boolean).join(' · ') || 'Sem empresa informada')}</div>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${kindChip(c.kind)}${c.archived ? '<span class="chip">Arquivado</span>' : ''}${c.phone ? `<span class="chip navy">${esc(c.phone)}</span>` : ''}${c.email ? `<span class="chip navy">${esc(c.email)}</span>` : ''}</div></div>
      <div class="actions"><button class="btn sm" data-a="edit">Editar</button><button class="btn sm primary" data-a="newopp">+ Oportunidade</button><button class="x-btn" data-a="close" aria-label="Fechar">×</button></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${st.tab === k ? 'on' : ''}" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
    <div class="drawer-body" id="dbody"></div>`;
  st.el.querySelector('[data-a=close]').onclick = () => closeDrawer();
  st.el.querySelector('[data-a=edit]').onclick = () => editContactModal(c);
  st.el.querySelector('[data-a=newopp]').onclick = () => newOppModal(c.id);
  $$('[data-tab]', st.el).forEach(b => { b.onclick = () => { st.tab = b.dataset.tab; loadDrawer(); }; });
  const body = $('#dbody', st.el);
  ({ opp: tabOpp, dados: tabDados, origem: tabOrigem, notas: tabNotas, hist: tabHist })[st.tab](body, d, st);
}
const reloadDrawer = () => { if (drawerState) loadDrawer(); dataChanged(); };

function tabOpp(body, d, st) {
  if (!d.opportunities.length) { body.innerHTML = `<div class="empty"><b>Nenhuma oportunidade</b>Este contato ainda não tem oportunidade comercial.<br><br><button class="btn primary" id="no-opp">Criar oportunidade</button></div>`; $('#no-opp').onclick = () => newOppModal(d.contact.id); return; }
  const o = d.opportunities.find(x => x.id === st.oppId) || d.opportunities[0]; st.oppId = o.id;
  const stages = listOf('stages', o.stage_id);
  const commercial = can('admin', 'comercial');
  const sw = d.opportunities.length > 1 ? `<div class="actions mb">${d.opportunities.map(x => `<button class="btn sm ${x.id === o.id ? 'navy' : ''}" data-opp-sel="${x.id}">${esc((byId('services', x.service_id) || {}).name || 'Sem serviço')} · ${esc(LBL.oppStatus[x.status])}</button>`).join('')}</div>` : '';
  const late = o.status === 'open' && o.next_action_date && o.next_action_date < today();
  const days = daysSince(o.stage_entered_at);
  body.innerHTML = `${sw}
  <div class="card pad mb">
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <label class="f" style="min-width:220px;flex:1">Etapa do funil<select id="stage-sel" ${commercial ? '' : 'disabled'}>${opts(stages, o.stage_id)}</select></label>
      <div><div class="small muted">Situação</div>${statusChip(o.status)} ${qualChip(o.qual_status)}</div>
      <div><div class="small muted">Na etapa há</div><b>${F.days(days)}</b></div>
      <div><div class="small muted">Responsável</div><b>${esc(o.owner || 'Sem responsável')}</b></div>
      <div><div class="small muted">Valor</div><b>${o.status === 'won' ? `${o.one_time_value ? F.brl(o.one_time_value) : ''}${o.monthly_value ? ` ${F.brl(o.monthly_value)}/mês` : ''}` : F.brl(o.estimated_value)}</b></div>
    </div>
    ${o.status === 'open' ? `<div class="mt-s ${late ? 'callout red' : !o.next_action_date ? 'callout' : 'callout navy'}" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <div style="flex:1"><b>Próxima ação:</b> ${esc(o.next_action || 'não definida')} ${o.next_action_date ? `— prazo ${F.date(o.next_action_date)}` : ''} ${late ? '<span class="chip red">Atrasada</span>' : ''}</div>
      <button class="btn sm" id="next-btn">Atualizar</button></div>` : ''}
    ${commercial ? `<div class="actions mt-s">${o.status === 'open' ? `<button class="btn sm success" id="won-btn">Marcar como ganha</button><button class="btn sm danger" id="lost-btn">Marcar como perdida</button>` : `<button class="btn sm" id="reopen-btn">Reabrir oportunidade</button>`}</div>` : '<p class="small muted mt-s">Perfil Marketing: visualização e edição de informações; a movimentação de etapas é feita pelo comercial.</p>'}
  </div>
  ${o.status === 'won' ? `<div class="card mb"><div class="card-head"><h3>Venda</h3><span class="chip green">Ganha em ${F.date(o.won_at)}</span></div><div class="card-body">
    <dl class="kv"><dt>Tipo de contrato</dt><dd>${esc(LBL.contract[o.contract_type] || '—')}</dd><dt>Pagamento único</dt><dd>${F.brl(o.one_time_value)}</dd><dt>Mensalidade</dt><dd>${o.monthly_value ? F.brl(o.monthly_value) + '/mês' : '—'}</dd>
    <dt>Vigência</dt><dd>${o.contract_months ? o.contract_months + ' meses' : 'Não informada'}</dd>
    <dt>Valor total do contrato</dt><dd>${o.monthly_value && !o.contract_months ? '<span class="muted">Não calculado: informe a vigência.</span>' : F.brl((o.one_time_value || 0) + (o.monthly_value || 0) * (o.contract_months || 0))}</dd>
    <dt>O que contribuiu</dt><dd>${esc(o.win_factors || '—')}</dd></dl>
    <h3 class="mt">Recebimentos (receita recebida)</h3>
    <table class="t mt-s"><thead><tr><th>Data</th><th class="num">Valor</th><th>Observação</th><th></th></tr></thead><tbody>
    ${o.payments.map(p => `<tr><td>${F.date(p.date)}</td><td class="num">${F.brl(p.amount)}</td><td>${esc(p.note || '')}</td><td class="right">${commercial ? `<button class="btn sm danger" data-delpay="${p.id}">Excluir</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nenhum recebimento registrado.</td></tr>'}</tbody>
    <tfoot><tr><td>Total recebido</td><td class="num">${F.brl(o.payments.reduce((a, p) => a + p.amount, 0))}</td><td colspan="2"></td></tr></tfoot></table>
    ${commercial ? '<button class="btn sm primary mt-s" id="add-pay">+ Registrar recebimento</button>' : ''}</div></div>` : ''}
  ${o.status === 'lost' ? `<div class="card mb"><div class="card-head"><h3>Perda</h3><span class="chip red">Perdida em ${F.date(o.lost_at)}</span></div><div class="card-body">
    <dl class="kv"><dt>Motivo</dt><dd><b>${esc(o.loss_reason || '—')}</b></dd><dt>Objeção</dt><dd>${esc(o.objection || '—')}</dd><dt>Detalhes</dt><dd>${esc(o.loss_detail || '—')}</dd><dt>Retomar em</dt><dd>${F.date(o.retake_date)}</dd></dl></div></div>` : ''}
  <div class="card mb"><div class="card-head"><h3>Qualificação</h3>${qualChip(o.qual_status)}<span class="sub">${o.qual.manual ? 'Ajustada manualmente' : 'Calculada pelos critérios'}</span></div><div class="card-body" id="qual-box"></div></div>
  <div class="card mb"><div class="card-head"><h3>Atendimento e retorno ao marketing</h3></div><div class="card-body"><form id="opp-form">${formHtml(oppFormFields(o), o)}</form>
    <div class="actions mt-s"><button class="btn primary" id="save-opp">Salvar alterações</button><span class="err-msg" id="opp-err"></span></div></div></div>
  <div class="card mb"><div class="card-head"><h3>Propostas</h3></div><div class="card-body">
    <table class="t"><thead><tr><th>Enviada em</th><th class="num">Valor único</th><th class="num">Mensalidade</th><th>Situação</th><th>Observação</th><th></th></tr></thead><tbody>
    ${o.proposals.map(p => `<tr><td>${F.date(p.sent_at)}</td><td class="num">${F.brl(p.one_time_value)}</td><td class="num">${p.monthly_value ? F.brl(p.monthly_value) : '—'}</td><td>${commercial ? `<select class="input" data-pstatus="${p.id}" style="padding:3px 6px">${mapOpts({ enviada: 'Enviada', aceita: 'Aceita', recusada: 'Recusada' }, p.status)}</select>` : esc(p.status)}</td><td>${esc(p.note || '')}</td><td class="right">${commercial ? `<button class="btn sm danger" data-delprop="${p.id}">Excluir</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhuma proposta registrada.</td></tr>'}</tbody></table>
    ${commercial ? '<button class="btn sm primary mt-s" id="add-prop">+ Registrar proposta</button>' : ''}</div></div>
  <div class="card mb"><div class="card-head"><h3>Histórico de etapas</h3></div><div class="card-body"><ul class="timeline">
    ${o.history.map(h => `<li><b>${esc(h.from_name ? h.from_name + ' → ' : '')}${esc(h.to_name)}</b> ${h.note ? `<span class="muted">(${esc(h.note)})</span>` : ''}<div class="when">${F.dt(h.at)} · ${esc(h.user || 'sistema')}</div></li>`).join('')}</ul></div></div>`;

  $$('[data-opp-sel]', body).forEach(b => { b.onclick = () => { st.oppId = Number(b.dataset.oppSel); loadDrawer(); }; });
  const ss = $('#stage-sel', body);
  if (ss) ss.onchange = async () => { try { const r = await moveOpp(o, Number(ss.value)); if (!r) ss.value = o.stage_id; reloadDrawer(); } catch (e) { fail(e); ss.value = o.stage_id; } };
  if ($('#next-btn', body)) $('#next-btn', body).onclick = () => nextActionModal(o);
  if ($('#won-btn', body)) $('#won-btn', body).onclick = async () => { const s = listOf('stages').find(x => x.kind === 'won'); if (await wonModal(o, s.id)) reloadDrawer(); };
  if ($('#lost-btn', body)) $('#lost-btn', body).onclick = async () => { const s = listOf('stages').find(x => x.kind === 'lost'); if (await lostModal(o, s.id)) reloadDrawer(); };
  if ($('#reopen-btn', body)) $('#reopen-btn', body).onclick = async () => {
    const open = listOf('stages').filter(x => x.kind === 'open');
    formModal({ title: 'Reabrir oportunidade', intro: H`<p class="small muted" style="margin-top:0">Os dados de fechamento/perda serão limpos. A mudança fica registrada no histórico.</p>`, fields: [{ name: 'stage_id', label: 'Voltar para a etapa', type: 'select', options: opts(open, open[open.length - 1].id), full: true }],
      onSubmit: async v => { await POST(`/api/opportunities/${o.id}/move`, { stage_id: v.stage_id, note: 'Reaberta' }); reloadDrawer(); } });
  };
  renderQual($('#qual-box', body), o);
  wireOrigin($('#opp-form', body));
  $('#save-opp', body).onclick = async () => {
    try { await PUT('/api/opportunities/' + o.id, readForm($('#opp-form', body))); toast('Oportunidade atualizada.'); reloadDrawer(); } catch (e) { $('#opp-err', body).textContent = e.message; }
  };
  if ($('#add-prop', body)) $('#add-prop', body).onclick = () => formModal({ title: 'Registrar proposta', fields: [
    { name: 'sent_at', label: 'Enviada em', type: 'date', value: today(), required: true }, { name: 'status', label: 'Situação', type: 'select', options: mapOpts({ enviada: 'Enviada', aceita: 'Aceita', recusada: 'Recusada' }, 'enviada') },
    { name: 'one_time_value', label: 'Valor único (R$)', type: 'money' }, { name: 'monthly_value', label: 'Mensalidade (R$/mês)', type: 'money' },
    { name: 'followup_date', label: 'Data de retorno combinada', type: 'date', help: 'Vira a próxima ação da oportunidade.' }, { name: 'note', label: 'Observação', full: true }],
  onSubmit: async v => { await POST('/api/proposals', Object.assign(v, { opp_id: o.id })); toast('Proposta registrada.'); reloadDrawer(); } });
  $$('[data-pstatus]', body).forEach(s => { s.onchange = async () => { await PUT('/api/proposals/' + s.dataset.pstatus, { status: s.value }).catch(fail); reloadDrawer(); }; });
  $$('[data-delprop]', body).forEach(b => { b.onclick = async () => { if (await confirmDlg('Excluir esta proposta?', { danger: true, ok: 'Excluir' })) { await DEL('/api/proposals/' + b.dataset.delprop).catch(fail); reloadDrawer(); } }; });
  if ($('#add-pay', body)) $('#add-pay', body).onclick = () => formModal({ title: 'Registrar recebimento', fields: [{ name: 'date', label: 'Data do recebimento', type: 'date', value: today(), required: true }, { name: 'amount', label: 'Valor recebido (R$)', type: 'money', required: true }, { name: 'note', label: 'Observação', full: true, placeholder: 'Ex.: entrada, 1ª mensalidade' }],
    onSubmit: async v => { await POST('/api/payments', Object.assign(v, { opp_id: o.id })); toast('Recebimento registrado.'); reloadDrawer(); } });
  $$('[data-delpay]', body).forEach(b => { b.onclick = async () => { if (await confirmDlg('Excluir este recebimento?', { danger: true, ok: 'Excluir' })) { await DEL('/api/payments/' + b.dataset.delpay).catch(fail); reloadDrawer(); } }; });
}
function oppFormFields(o) {
  const f = oppFields(o, { withNext: false }).filter(x => !(x.name === 'owner_id' && !can('admin', 'comercial')));
  f.push({ name: 'objection', label: 'Dúvidas ou objeções apresentadas', type: 'textarea', full: true },
    { name: 'feedback', label: 'Retorno ao marketing (tinha perfil? por que avançou ou desistiu?)', type: 'textarea', full: true });
  if (o.status === 'won') f.push({ name: 'win_factors', label: 'O que contribuiu para o fechamento?', type: 'textarea', full: true });
  if (o.status === 'lost') f.push({ name: 'loss_reason_id', label: 'Motivo da perda', type: 'select', options: opts(listOf('loss_reasons', o.loss_reason_id), o.loss_reason_id) }, { name: 'retake_date', label: 'Retomar em', type: 'date' }, { name: 'loss_detail', label: 'Detalhes da perda', type: 'textarea', full: true });
  f.push({ section: 'Origem desta oportunidade (modelo "última interação antes da oportunidade")' },
    { name: 'source_id', label: 'Origem', type: 'select', options: opts(listOf('sources', o.source_id), o.source_id, { empty: 'Não identificado' }) },
    { name: 'campaign_id', label: 'Campanha', type: 'select', options: opts(listOf('campaigns', o.campaign_id), o.campaign_id, { empty: 'Não identificada' }) },
    { name: 'content_id', label: 'Conteúdo / anúncio', type: 'select', full: true, options: opts(listOf('contents', o.content_id), o.content_id, { empty: 'Não identificado', label: x => x.title }) });
  if (can('admin', 'comercial')) {
    f.push({ section: 'Marcos do atendimento (preenchidos ao mover as etapas; ajuste se necessário)' },
      { name: 'first_contact_at', label: 'Primeiro contato', type: 'date' }, { name: 'meeting_scheduled_at', label: 'Reunião agendada em', type: 'date' },
      { name: 'meeting_done_at', label: 'Reunião realizada em', type: 'date' }, { name: 'proposal_sent_at', label: 'Proposta enviada em', type: 'date' });
    if (o.status === 'won') f.push({ name: 'won_at', label: 'Data do fechamento', type: 'date' }, { name: 'contract_type', label: 'Tipo de contrato', type: 'select', options: mapOpts(LBL.contract, o.contract_type) },
      { name: 'one_time_value', label: 'Pagamento único (R$)', type: 'money' }, { name: 'monthly_value', label: 'Mensalidade (R$/mês)', type: 'money' }, { name: 'contract_months', label: 'Meses de vigência', type: 'number' });
  }
  return f;
}
function renderQual(box, o) {
  const crit = listOf('qual_criteria').filter(c => !c.archived);
  const ans = Object.assign({}, o.qual.answers);
  const draw = () => {
    box.innerHTML = `${crit.map(c => `<div class="qual-row"><div><b>${esc(c.name)}</b> ${c.required ? '<span class="chip navy">obrigatório</span>' : '<span class="chip">complementar</span>'}<div class="small muted">${esc(c.help || '')}</div></div>
      <div class="seg" data-crit="${c.id}">${['sim', 'nao', 'desconhecido'].map(v => `<button type="button" class="${v} ${(ans[c.id] || 'desconhecido') === v ? 'on' : ''}" data-v="${v}">${v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : 'Desconhecido'}</button>`).join('')}</div></div>`).join('')}
      <div class="callout navy mt-s small"><b>Justificativa automática:</b> ${esc(o.qual.auto.summary)} Informação desconhecida não é tratada como incompatibilidade.</div>
      <div class="mt-s" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <label class="f check"><input type="checkbox" id="q-manual" ${o.qual.manual ? 'checked' : ''}> Ajustar classificação manualmente</label>
        <label class="f" style="min-width:170px"><span>Classificação manual</span><select id="q-status" ${o.qual.manual ? '' : 'disabled'}>${mapOpts(LBL.qual, o.qual_status)}</select></label>
        <label class="f" style="flex:1;min-width:220px"><span>Motivo do ajuste</span><input id="q-note" value="${esc(o.qual.note || o.qual_note || '')}" ${o.qual.manual ? '' : 'disabled'}></label>
        <button class="btn sm primary" id="q-save">Salvar ajuste</button></div>`;
    $$('[data-crit]', box).forEach(g => g.onclick = async e => {
      const b = e.target.closest('[data-v]'); if (!b) return; ans[g.dataset.crit] = b.dataset.v;
      try { const r = await PUT('/api/opportunities/' + o.id, { qual_answers: ans }); o.qual = r.qual; o.qual_status = r.qual_status; draw(); dataChanged(); const head = box.closest('.card').querySelector('.card-head'); head.querySelector('.chip').outerHTML = qualChip(r.qual_status); } catch (x) { fail(x); }
    });
    $('#q-manual', box).onchange = e => { $('#q-status', box).disabled = !e.target.checked; $('#q-note', box).disabled = !e.target.checked; };
    $('#q-save', box).onclick = async () => {
      try { await PUT('/api/opportunities/' + o.id, { qual_answers: ans, qual_manual: $('#q-manual', box).checked, qual_status: $('#q-status', box).value, qual_note: $('#q-note', box).value }); toast('Qualificação salva.'); reloadDrawer(); } catch (x) { fail(x); }
    };
  };
  draw();
}
function tabDados(body, d) {
  const c = d.contact;
  body.innerHTML = `<div class="card pad"><dl class="kv">
    <dt>Nome</dt><dd>${esc(c.name)}</dd><dt>Telefone</dt><dd>${esc(c.phone || '—')}</dd><dt>E-mail</dt><dd>${esc(c.email || '—')}</dd><dt>Empresa</dt><dd>${esc(c.company || '—')}</dd><dt>Cidade</dt><dd>${esc(c.city || '—')}</dd>
    <dt>Tipo de contato</dt><dd>${kindChip(c.kind)}</dd><dt>Perfil</dt><dd>${esc(LBL.profile[c.profile] || 'Não informado')}${c.profile_other ? ' — ' + esc(c.profile_other) : ''}</dd>
    <dt>Participa da decisão</dt><dd>${esc(LBL.decision[c.decision_maker] || 'Desconhecido')}</dd><dt>Responsável</dt><dd>${esc(c.owner || 'Sem responsável')}</dd>
    <dt>Captado em</dt><dd>${F.date(c.captured_at)}</dd><dt>Cadastrado em</dt><dd>${F.dt(c.created_at)}</dd><dt>Observações</dt><dd>${esc(c.notes || '—')}</dd></dl>
    <div class="actions mt"><button class="btn" id="ed">Editar dados</button><button class="btn ${c.archived ? '' : 'danger'}" id="arch">${c.archived ? 'Reativar contato' : 'Arquivar contato'}</button></div></div>`;
  $('#ed', body).onclick = () => editContactModal(c);
  $('#arch', body).onclick = async () => { if (await confirmDlg(c.archived ? 'Reativar este contato?' : 'Arquivar este contato? Ele sai das listas, mas continua nos relatórios históricos.')) { await POST(`/api/contacts/${c.id}/archive`, { archived: !c.archived }).catch(fail); reloadDrawer(); } };
}
function editContactModal(c) {
  const sellers = (S.boot.users || []).filter(u => u.active || u.id === c.owner_id);
  formModal({ title: 'Editar contato', size: 'wide', values: c, fields: [
    { name: 'name', label: 'Nome', required: true }, { name: 'phone', label: 'Telefone / WhatsApp', type: 'tel' }, { name: 'email', label: 'E-mail', type: 'email' }, { name: 'company', label: 'Empresa' }, { name: 'city', label: 'Cidade' },
    { name: 'kind', label: 'Tipo de contato', type: 'select', options: mapOpts(LBL.kind, c.kind) }, { name: 'profile', label: 'Perfil', type: 'select', options: mapOpts(LBL.profile, c.profile, 'Não informado') },
    { name: 'profile_other', label: 'Perfil (detalhe)' }, { name: 'decision_maker', label: 'Participa da decisão?', type: 'select', options: mapOpts(LBL.decision, c.decision_maker) },
    { name: 'captured_at', label: 'Data de captação', type: 'date' }, { name: 'owner_id', label: 'Responsável', type: 'select', options: opts(sellers, c.owner_id, { empty: 'Sem responsável' }) },
    { name: 'notes', label: 'Observações', type: 'textarea', full: true }],
  onSubmit: async v => {
    try { await PUT('/api/contacts/' + c.id, v); } catch (e) { if (e.status === 409 && await confirmDlg(`${e.message} (${e.data.duplicates.map(x => x.name).join(', ')}). Salvar mesmo assim?`)) await PUT('/api/contacts/' + c.id, Object.assign(v, { force: true })); else throw e; }
    toast('Contato atualizado.'); reloadDrawer();
  } });
}
function tabOrigem(body, d) {
  const t0 = d.touchpoints[0];
  body.innerHTML = `<div class="callout navy mb"><b>Primeira origem conhecida:</b> ${t0 ? esc([t0.source || 'Não identificado', t0.campaign, t0.content].filter(Boolean).join(' › ')) + ' em ' + F.date(t0.occurred_at) : 'Não identificado'}
      <div class="small muted">A primeira interação é preservada para o relatório de "primeira origem". Novas interações não a substituem.</div></div>
    <div class="actions mb"><button class="btn primary sm" id="add-t">+ Registrar interação</button></div>
    <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Data</th><th>Tipo</th><th>Origem</th><th>Campanha / conteúdo</th><th>Gancho / CTA</th><th>UTMs</th><th></th></tr></thead><tbody>
    ${d.touchpoints.map((t, i) => `<tr><td class="nowrap">${F.date(t.occurred_at)} ${i === 0 ? '<span class="chip orange">1ª</span>' : ''}</td><td>${esc(LBL.touch[t.type] || t.type)}${t.note ? `<div class="small muted">${esc(t.note)}</div>` : ''}</td><td>${esc(t.source || 'Não identificado')}</td>
      <td>${esc(t.campaign || '—')}<div class="small muted">${esc(t.content || '')}</div></td><td class="small">${esc(t.hook || '—')}${t.cta ? `<div class="muted">CTA: ${esc(t.cta)}</div>` : ''}</td>
      <td class="small">${esc(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].filter(k => t[k]).map(k => k.slice(4) + '=' + t[k]).join(' · ') || '—')}</td>
      <td class="nowrap right"><button class="btn sm" data-edt="${t.id}">Editar</button> <button class="btn sm danger" data-delt="${t.id}">Excluir</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nenhuma interação registrada: origem "Não identificado".</td></tr>'}</tbody></table></div></div>`;
  const edit = t => formModal({ title: t ? 'Editar interação' : 'Registrar interação', size: 'wide', fields: touchFields(t || { type: 'conversa' }).filter(f => !f.section || true), values: t || {}, onMount: (m, f) => wireOrigin(f),
    onSubmit: async v => { if (t) await PUT('/api/touchpoints/' + t.id, v); else await POST('/api/touchpoints', Object.assign(v, { contact_id: d.contact.id })); toast('Interação salva.'); reloadDrawer(); } });
  $('#add-t', body).onclick = () => edit(null);
  $$('[data-edt]', body).forEach(b => { b.onclick = () => edit(d.touchpoints.find(t => t.id === Number(b.dataset.edt))); });
  $$('[data-delt]', body).forEach(b => { b.onclick = async () => { if (await confirmDlg('Excluir esta interação? Se for a primeira, a primeira origem do contato muda.', { danger: true, ok: 'Excluir' })) { await DEL('/api/touchpoints/' + b.dataset.delt).catch(fail); reloadDrawer(); } }; });
}
function tabNotas(body, d, st) {
  const users = (S.boot.users || []).filter(u => u.active);
  body.innerHTML = `<div class="grid g2">
    <div><div class="card pad"><h3>Nova anotação</h3><textarea class="input mt-s" id="note-txt" rows="3" placeholder="Resumo da conversa, documentos pedidos, combinados…"></textarea>
      <div class="actions mt-s"><button class="btn primary sm" id="note-add">Adicionar anotação</button></div></div>
      <ul class="timeline mt">${d.notes.map(n => `<li>${esc(n.body).replace(/\n/g, '<br>')}<div class="when">${F.dt(n.created_at)} · ${esc(n.user || '')}</div></li>`).join('') || '<li class="muted">Sem anotações.</li>'}</ul></div>
    <div><div class="card pad"><h3>Nova tarefa</h3><form id="task-form" class="mt-s">${formHtml([{ name: 'title', label: 'Tarefa', required: true, full: true, placeholder: 'Ex.: Enviar lista de documentos' }, { name: 'due_date', label: 'Prazo', type: 'date', value: today() }, { name: 'owner_id', label: 'Responsável', type: 'select', options: opts(users, S.me.user.id) }])}</form>
      <div class="actions mt-s"><button class="btn primary sm" id="task-add">Criar tarefa</button></div></div>
      <div class="card mt"><table class="t"><tbody>${d.tasks.map(t => `<tr><td style="width:28px"><input type="checkbox" data-done="${t.id}" ${t.done_at ? 'checked' : ''} aria-label="Concluir"></td><td>${t.done_at ? `<s>${esc(t.title)}</s>` : esc(t.title)}<div class="small muted">${esc(t.owner || '')}</div></td><td class="nowrap">${F.date(t.due_date)} ${!t.done_at && t.due_date && t.due_date < today() ? '<span class="chip red">Atrasada</span>' : ''}</td></tr>`).join('') || '<tr><td class="muted">Sem tarefas.</td></tr>'}</tbody></table></div></div></div>`;
  $('#note-add', body).onclick = async () => { const v = $('#note-txt', body).value.trim(); if (!v) return; await POST('/api/notes', { contact_id: d.contact.id, opp_id: st.oppId, body: v }).catch(fail); reloadDrawer(); };
  $('#task-add', body).onclick = async () => { const v = readForm($('#task-form', body)); if (!v.title) return toast('Descreva a tarefa.', { err: true }); await POST('/api/tasks', Object.assign(v, { contact_id: d.contact.id, opp_id: st.oppId })).catch(fail); reloadDrawer(); };
  $$('[data-done]', body).forEach(c => { c.onchange = async () => { await PUT('/api/tasks/' + c.dataset.done, { done: c.checked }).catch(fail); reloadDrawer(); }; });
}
function tabHist(body, d) {
  body.innerHTML = `<div class="card pad"><ul class="timeline">${d.log.map(l => { let det = ''; try { const x = JSON.parse(l.details || 'null'); if (x) det = x.campos ? 'Campos: ' + x.campos.join(', ') : Object.entries(x).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · '); } catch (e) { /* */ }
    return `<li><b>${esc(l.action)}</b> ${l.entity === 'oportunidade' ? `<span class="muted">(oportunidade #${l.entity_id})</span>` : ''}<div class="small">${esc(det)}</div><div class="when">${F.dt(l.at)} · ${esc(l.user_name || '')}</div></li>`; }).join('') || '<li class="muted">Sem registros.</li>'}</ul></div>`;
}

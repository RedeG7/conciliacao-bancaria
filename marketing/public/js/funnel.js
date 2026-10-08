'use strict';
/* Funil comercial (Kanban) com arrastar e soltar. Cada movimentação é salva e registrada no histórico. */

route('/funil', async (main, p, alive) => {
  S.funnel = S.funnel || { owner_id: '', service_id: '', source_id: '', campaign_id: '', kind: '', q: '', overdue: '', closed_days: '30' };
  const f = S.funnel; const users = S.boot.users || [];
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Funil comercial</h1><p>Arraste os cartões entre as etapas. Ganho e perda pedem os dados do fechamento. Cada mudança registra data, responsável e histórico.</p></div>
    <div class="actions"><span id="saved"></span><button class="btn" data-download="/api/export/oportunidades">${icon('download')}Exportar CSV</button><button class="btn primary" id="new-lead">${icon('plus')}Novo lead</button></div></div>
    <div class="filters" id="ff">
      <label class="f"><span>Buscar</span><input name="q" value="${esc(f.q)}" placeholder="Nome ou empresa"></label>
      <label class="f"><span>Responsável</span><select name="owner_id"><option value="">Todos</option>${opts(users, f.owner_id)}<option value="0">Sem responsável</option></select></label>
      <label class="f"><span>Serviço</span><select name="service_id"><option value="">Todos</option>${opts(S.boot.services, f.service_id)}</select></label>
      <label class="f"><span>Origem</span><select name="source_id"><option value="">Todas</option>${opts(S.boot.sources, f.source_id)}<option value="0">Não identificado</option></select></label>
      <label class="f"><span>Campanha</span><select name="campaign_id"><option value="">Todas</option>${opts(S.boot.campaigns, f.campaign_id)}</select></label>
      <label class="f"><span>Tipo de contato</span><select name="kind"><option value="">Todos</option>${mapOpts(LBL.kind, f.kind)}</select></label>
      <label class="f"><span>Fechadas</span><select name="closed_days">${mapOpts({ 30: 'Últimos 30 dias', 90: 'Últimos 90 dias', all: 'Todas' }, f.closed_days)}</select></label>
      <label class="f check" style="flex:0 0 auto;max-width:none"><input type="checkbox" name="overdue" ${f.overdue ? 'checked' : ''}> Só atrasadas / sem próxima ação</label>
    </div>
    <div class="board-wrap"><div class="board" id="board"></div></div>`;
  $('#new-lead', main).onclick = () => newContactModal();
  let t;
  $('#ff', main).addEventListener('input', e => { const el = e.target; f[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value; clearTimeout(t); t = setTimeout(load, el.name === 'q' ? 250 : 0); });
  savedFiltersUi(main, 'funil', f, nf => { Object.assign(f, nf); render(); });
  let cards = [];
  async function load() {
    cards = await GET('/api/opportunities?' + qs(f));
    if (!alive()) return; draw();
  }
  function draw() {
    const stages = listOf('stages').filter(s => !s.archived).sort((a, b) => a.sort - b.sort);
    const board = $('#board', main);
    board.innerHTML = stages.map(s => {
      const cs = cards.filter(c => c.stage_id === s.id);
      const sum = cs.reduce((a, c) => a + (s.kind === 'won' ? (c.one_time_value || 0) : (c.estimated_value || 0)), 0);
      const mon = s.kind === 'won' ? cs.reduce((a, c) => a + (c.monthly_value || 0), 0) : 0;
      return `<section class="col ${s.kind}" data-stage="${s.id}" aria-label="${esc(s.name)}"><div class="col-head"><div class="t1"><span>${esc(s.name)}</span><span class="chip">${cs.length}</span></div>
        <div class="t2"><span>${s.kind === 'won' ? 'Valor único fechado' : s.kind === 'lost' ? 'Valor estimado perdido' : 'Valor estimado'}</span><b>${F.brl(sum)}</b></div>${mon ? `<div class="t2"><span>Mensalidades</span><b>${F.brl(mon)}/mês</b></div>` : ''}</div>
        <div class="col-body">${cs.map(cardHtml).join('') || '<div class="small faint center" style="padding:14px 4px">Arraste um cartão para cá</div>'}</div></section>`;
    }).join('');
    wireDnD(board);
  }
  function cardHtml(c) {
    const days = daysSince(c.stage_entered_at);
    const late = c.overdue || c.overdue_tasks > 0;
    let next = '';
    if (c.status === 'open') next = c.no_next ? `<div class="next none"><b>Sem próxima ação</b> — defina o próximo passo</div>`
      : `<div class="next ${c.overdue ? 'late' : ''}">${c.overdue ? '<b>Atrasada:</b> ' : '<b>Próx.:</b> '}${esc(c.next_action)} · ${F.date(c.next_action_date)}</div>`;
    if (c.status === 'lost') next = `<div class="next late">Motivo: ${esc(c.loss_reason || '—')}</div>`;
    if (c.status === 'won') next = `<div class="next" style="background:var(--green-soft);color:var(--green)">Ganha em ${F.date(c.won_at)}</div>`;
    return `<article class="kcard ${late && c.status === 'open' ? 'overdue' : ''}" draggable="${can('admin', 'comercial')}" data-id="${c.id}" tabindex="0" aria-label="${esc(c.name)}">
      <div class="nm">${esc(c.name)}</div>${c.company ? `<div class="co">${esc(c.company)}</div>` : ''}
      <div class="meta">${c.service ? `<span class="chip navy">${esc(c.service)}</span>` : '<span class="chip">Serviço não informado</span>'}${qualChip(c.qual_status)}${c.kind !== 'cliente_potencial' ? kindChip(c.kind) : ''}</div>
      <div class="ln" title="${esc(c.source)}">Origem: <b>${esc(c.source)}</b></div>
      ${c.campaign || c.content ? `<div class="ln" title="${esc([c.campaign, c.content].filter(Boolean).join(' › '))}">${c.content ? 'Conteúdo' : 'Campanha'}: <b>${esc(c.content || c.campaign)}</b></div>` : ''}
      ${next}
      <div class="foot"><span class="small"><span class="avatar" style="width:20px;height:20px;font-size:9px;display:inline-grid;vertical-align:middle">${esc(initials(userName(c.owner_id)))}</span> ${esc(userName(c.owner_id))}</span>
        <span class="small muted" title="Tempo nesta etapa">${days === null ? '' : days + 'd na etapa'}</span></div>
      <div class="foot" style="border-top:none;margin-top:2px;padding-top:0"><span class="val">${c.status === 'won' ? F.brl(c.one_time_value) + (c.monthly_value ? ` <span class="small">+ ${F.brl(c.monthly_value)}/mês</span>` : '') : F.brl(c.estimated_value)}</span>
        ${c.overdue_tasks ? `<span class="chip red">${c.overdue_tasks} tarefa(s) atrasada(s)</span>` : c.open_tasks ? `<span class="chip">${c.open_tasks} tarefa(s)</span>` : ''}</div></article>`;
  }
  function wireDnD(board) {
    let dragId = null;
    // rolagem automática ao arrastar perto das bordas do quadro
    const wrap = board.parentElement;
    wrap.ondragover = e => { const r = wrap.getBoundingClientRect(); if (e.clientX > r.right - 80) wrap.scrollLeft += 18; else if (e.clientX < r.left + 80) wrap.scrollLeft -= 18; };
    $$('.kcard', board).forEach(el => {
      el.addEventListener('click', () => { const c = cards.find(x => x.id === Number(el.dataset.id)); openContact(c.contact_id, c.id, 'opp'); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') el.click(); });
      el.addEventListener('dragstart', e => { dragId = Number(el.dataset.id); el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId)); });
      el.addEventListener('dragend', () => { el.classList.remove('dragging'); $$('.col', board).forEach(c => c.classList.remove('drag-over')); });
    });
    $$('.col', board).forEach(col => {
      col.addEventListener('dragover', e => { if (dragId === null) return; e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
      col.addEventListener('drop', async e => {
        e.preventDefault(); col.classList.remove('drag-over');
        const id = dragId; dragId = null; const c = cards.find(x => x.id === id); const to = Number(col.dataset.stage);
        if (!c || c.stage_id === to) return;
        const prev = c.stage_id; const st = byId('stages', to);
        if (st.kind === 'open') { c.stage_id = to; c.stage_entered_at = new Date().toISOString(); draw(); }
        try { const r = await moveOpp({ id: c.id, service_id: c.service_id, estimated_value: c.estimated_value, next_action: c.next_action, next_action_date: c.next_action_date }, to); if (!r) { c.stage_id = prev; draw(); } else load(); }
        catch (x) { c.stage_id = prev; draw(); fail(x); }
      });
    });
  }
  S.refreshPage = load;
  await load();
});

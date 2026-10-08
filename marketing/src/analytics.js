'use strict';
// Motor de indicadores. Tudo é calculado a partir dos registros salvos — nada é estimado ou inventado.
const L = require('./logic');

const NONE = 0; // chave para "Não identificado"
const MIN_SAMPLE = 10; // abaixo disso: amostra insuficiente
const SMALL_SAMPLE = 30; // abaixo disso: amostra pequena

function load(db) {
  const all = sql => db.prepare(sql).all();
  const d = {
    contacts: all('SELECT * FROM contacts'),
    touch: all('SELECT * FROM touchpoints ORDER BY occurred_at, id'),
    opps: all('SELECT * FROM opportunities WHERE archived = 0'),
    history: all('SELECT * FROM stage_history ORDER BY at, id'),
    metrics: all('SELECT * FROM metrics'),
    costs: all('SELECT * FROM other_costs'),
    payments: all('SELECT * FROM payments'),
    proposals: all('SELECT * FROM proposals'),
    campaigns: all('SELECT * FROM campaigns'),
    contents: all('SELECT * FROM contents'),
    sources: all('SELECT * FROM sources'),
    services: all('SELECT * FROM services'),
    stages: all('SELECT * FROM stages ORDER BY sort'),
    reasons: all('SELECT * FROM loss_reasons'),
    tasks: all('SELECT * FROM tasks'),
    clicks: all('SELECT content_id, substr(at,1,10) AS day FROM link_clicks'),
    goals: all('SELECT * FROM goals ORDER BY period_start'),
  };
  const by = (arr, k = 'id') => new Map(arr.map(x => [x[k], x]));
  d.contactById = by(d.contacts); d.campById = by(d.campaigns); d.contById = by(d.contents);
  d.srcById = by(d.sources); d.svcById = by(d.services); d.stageById = by(d.stages); d.reasonById = by(d.reasons);
  d.oppById = by(d.opps);
  d.firstTouch = new Map(); d.touchByContact = new Map();
  for (const t of d.touch) {
    if (!d.firstTouch.has(t.contact_id)) d.firstTouch.set(t.contact_id, t);
    if (!d.touchByContact.has(t.contact_id)) d.touchByContact.set(t.contact_id, []);
    d.touchByContact.get(t.contact_id).push(t);
  }
  d.oppsByContact = new Map();
  for (const o of d.opps) { if (!d.oppsByContact.has(o.contact_id)) d.oppsByContact.set(o.contact_id, []); d.oppsByContact.get(o.contact_id).push(o); }
  for (const arr of d.oppsByContact.values()) arr.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  d.histByOpp = new Map();
  for (const h of d.history) { if (!d.histByOpp.has(h.opp_id)) d.histByOpp.set(h.opp_id, []); d.histByOpp.get(h.opp_id).push(h); }
  return d;
}

// ---------- atribuição ----------
function attrOfTouch(t, d) {
  if (!t) return { source_id: NONE, campaign_id: NONE, content_id: NONE };
  let campaign_id = t.campaign_id || NONE;
  if (!campaign_id && t.content_id && d.contById.get(t.content_id)) campaign_id = d.contById.get(t.content_id).campaign_id || NONE;
  return { source_id: t.source_id || NONE, campaign_id, content_id: t.content_id || NONE };
}
function contactAttr(c, d) { return attrOfTouch(d.firstTouch.get(c.id), d); }
function oppAttr(o, d, model) {
  if (model === 'first') return contactAttr(d.contactById.get(o.contact_id) || { id: -1 }, d);
  let campaign_id = o.campaign_id || NONE;
  if (!campaign_id && o.content_id && d.contById.get(o.content_id)) campaign_id = d.contById.get(o.content_id).campaign_id || NONE;
  return { source_id: o.source_id || NONE, campaign_id, content_id: o.content_id || NONE };
}
function contactService(c, d) {
  const os = d.oppsByContact.get(c.id);
  if (os && os.length && os[0].service_id) return os[0].service_id;
  const a = contactAttr(c, d);
  const k = a.content_id && d.contById.get(a.content_id); if (k && k.service_id) return k.service_id;
  const cp = a.campaign_id && d.campById.get(a.campaign_id); if (cp && cp.service_id) return cp.service_id;
  return NONE;
}
function contactOwner(c, d) { const os = d.oppsByContact.get(c.id); return (os && os[0] && os[0].owner_id) || c.owner_id || NONE; }
function metricService(m, d) {
  const k = m.content_id && d.contById.get(m.content_id); if (k && k.service_id) return k.service_id;
  const cp = m.campaign_id && d.campById.get(m.campaign_id); return (cp && cp.service_id) || NONE;
}

// ---------- filtros ----------
function normFilters(q) {
  const t = L.today();
  const f = {
    from: q.from || L.addDays(t, -29), to: q.to || t,
    source_id: q.source_id === undefined || q.source_id === '' ? null : Number(q.source_id),
    campaign_id: q.campaign_id === undefined || q.campaign_id === '' ? null : Number(q.campaign_id),
    content_id: q.content_id === undefined || q.content_id === '' ? null : Number(q.content_id),
    service_id: q.service_id === undefined || q.service_id === '' ? null : Number(q.service_id),
    owner_id: q.owner_id === undefined || q.owner_id === '' ? null : Number(q.owner_id),
    kind: q.kind || null,
    model: q.model === 'opp' ? 'opp' : 'first',
    view: q.view === 'cohort' ? 'cohort' : 'activity',
  };
  if (f.from > f.to) [f.from, f.to] = [f.to, f.from];
  return f;
}
const inR = (date, f) => !!date && date >= f.from && date <= f.to;
const ld = s => L.localDate(s);

function attrMatch(a, f) {
  if (f.source_id !== null && a.source_id !== f.source_id) return false;
  if (f.campaign_id !== null && a.campaign_id !== f.campaign_id) return false;
  if (f.content_id !== null && a.content_id !== f.content_id) return false;
  return true;
}
function filterContacts(d, f) {
  return d.contacts.filter(c => {
    if (f.kind && c.kind !== f.kind) return false;
    if (!attrMatch(contactAttr(c, d), f)) return false;
    if (f.service_id !== null && contactService(c, d) !== f.service_id) return false;
    if (f.owner_id !== null && contactOwner(c, d) !== f.owner_id) return false;
    return true;
  });
}
function filterOpps(d, f) {
  return d.opps.filter(o => {
    const c = d.contactById.get(o.contact_id);
    if (!c) return false;
    if (f.kind && c.kind !== f.kind) return false;
    if (!attrMatch(oppAttr(o, d, f.model), f)) return false;
    if (f.service_id !== null && (o.service_id || NONE) !== f.service_id) return false;
    if (f.owner_id !== null && (o.owner_id || NONE) !== f.owner_id) return false;
    return true;
  });
}
function filterMetrics(d, f) {
  return d.metrics.filter(m => inR(m.date, f)
    && (f.source_id === null || (m.source_id || NONE) === f.source_id)
    && (f.campaign_id === null || (m.campaign_id || NONE) === f.campaign_id)
    && (f.content_id === null || (m.content_id || NONE) === f.content_id)
    && (f.service_id === null || metricService(m, d) === f.service_id));
}

// ---------- utilidades ----------
const sum = (arr, fn) => arr.reduce((a, x) => a + (Number(fn(x)) || 0), 0);
const div = (a, b) => (b ? a / b : null);
function sampleNote(n) {
  if (n < MIN_SAMPLE) return { level: 'insuficiente', text: `Amostra insuficiente (${n} registro${n === 1 ? '' : 's'}): não tire conclusões.` };
  if (n < SMALL_SAMPLE) return { level: 'pequena', text: `Amostra pequena (${n} registros): trate como indício, não como conclusão.` };
  return { level: 'ok', text: `${n} registros na base.` };
}
function nameOf(map, id, fallback = 'Não identificado') {
  if (!id) return fallback; const x = map.get(id); return x ? (x.name || x.title) : fallback;
}

// Resumos para listagem (drill-down)
function recContact(c, d) {
  const a = contactAttr(c, d);
  return { t: 'c', id: c.id, name: c.name, company: c.company, date: c.captured_at || ld(c.created_at),
    src: nameOf(d.srcById, a.source_id), camp: a.campaign_id ? nameOf(d.campById, a.campaign_id) : null };
}
function recOpp(o, d, dateField, extra) {
  const c = d.contactById.get(o.contact_id) || {};
  const st = d.stageById.get(o.stage_id);
  return Object.assign({ t: 'o', id: o.id, contact_id: o.contact_id, name: c.name, company: c.company,
    service: nameOf(d.svcById, o.service_id, '—'), stage: st ? st.name : '—', status: o.status,
    value: o.estimated_value, one: o.one_time_value, monthly: o.monthly_value,
    date: dateField ? (o[dateField] && ld(o[dateField])) : ld(o.created_at) }, extra || {});
}

function maxReachedSort(o, d) {
  let max = -1;
  const hs = d.histByOpp.get(o.id) || [];
  const ids = hs.map(h => h.to_stage_id).concat([o.stage_id]);
  for (const id of ids) { const s = d.stageById.get(id); if (s && s.kind !== 'lost' && s.sort > max) max = s.sort; }
  return max;
}

// ================= DASHBOARD =================
function dashboard(db, q) {
  const d = load(db);
  const f = normFilters(q);
  const T = L.today();
  const contactsF = filterContacts(d, f);
  const oppsF = filterOpps(d, f);
  const oppIdSet = new Set(oppsF.map(o => o.id));
  const leads = contactsF.filter(c => inR(c.captured_at || ld(c.created_at), f));
  const leadIdSet = new Set(leads.map(c => c.id));
  const mets = filterMetrics(d, f);
  const cohort = f.view === 'cohort';
  const cohortOpps = oppsF.filter(o => leadIdSet.has(o.contact_id));

  // eventos conforme a visão escolhida
  let qualOpps, schedOpps, doneOpps, propOpps, wonOpps, lostOpps, pays, convBase;
  if (cohort) {
    qualOpps = cohortOpps.filter(o => o.qual_status === 'qualificado');
    schedOpps = cohortOpps.filter(o => o.meeting_scheduled_at);
    doneOpps = cohortOpps.filter(o => o.meeting_done_at);
    propOpps = cohortOpps.filter(o => o.proposal_sent_at);
    wonOpps = cohortOpps.filter(o => o.status === 'won');
    lostOpps = cohortOpps.filter(o => o.status === 'lost');
    const ids = new Set(cohortOpps.map(o => o.id));
    pays = d.payments.filter(p => ids.has(p.opp_id));
    convBase = cohortOpps;
  } else {
    qualOpps = oppsF.filter(o => o.qual_status === 'qualificado' && inR(o.qualified_at, f));
    schedOpps = oppsF.filter(o => inR(o.meeting_scheduled_at, f));
    doneOpps = oppsF.filter(o => inR(o.meeting_done_at, f));
    propOpps = oppsF.filter(o => inR(o.proposal_sent_at, f));
    wonOpps = oppsF.filter(o => o.status === 'won' && inR(o.won_at, f));
    lostOpps = oppsF.filter(o => o.status === 'lost' && inR(o.lost_at, f));
    pays = d.payments.filter(p => oppIdSet.has(p.opp_id) && inR(p.date, f));
    convBase = wonOpps.concat(lostOpps);
  }
  // leads qualificados = contatos distintos com oportunidade qualificada
  const qualContactIds = [...new Set(qualOpps.map(o => o.contact_id))];
  const qualContacts = qualContactIds.map(id => d.contactById.get(id)).filter(Boolean);

  const openOpps = oppsF.filter(o => o.status === 'open' && ld(o.created_at) <= f.to);
  const openProps = openOpps.filter(o => o.proposal_sent_at);
  const propValue = o => {
    const ps = d.proposals.filter(p => p.opp_id === o.id && p.status !== 'recusada').sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    return ps[0] ? { one: ps[0].one_time_value || 0, monthly: ps[0].monthly_value || 0, from: 'proposta' } : { one: o.estimated_value || 0, monthly: 0, from: 'estimado' };
  };

  // mídia
  const spend = sum(mets, m => m.spend);
  const impressions = sum(mets, m => m.impressions);
  const reach = sum(mets, m => m.reach);
  const clicks = sum(mets, m => m.clicks);
  const conversations = sum(mets, m => m.conversations);
  const hasImp = mets.some(m => m.impressions !== null); const hasClicks = mets.some(m => m.clicks !== null);
  const ownClicks = d.clicks.filter(c => inR(c.day, f) && (f.content_id === null || c.content_id === f.content_id)
    && (f.campaign_id === null || (d.contById.get(c.content_id) || {}).campaign_id === f.campaign_id)).length;

  // atribuição a campanhas com investimento
  const paidCamps = new Set(); const spendByCamp = new Map();
  for (const m of mets) if ((m.spend || 0) > 0) { paidCamps.add(m.campaign_id || NONE); spendByCamp.set(m.campaign_id || NONE, (spendByCamp.get(m.campaign_id || NONE) || 0) + m.spend); }
  paidCamps.delete(NONE);
  const leadsPaid = leads.filter(c => paidCamps.has(contactAttr(c, d).campaign_id));
  const qualPaid = qualContacts.filter(c => paidCamps.has(contactAttr(c, d).campaign_id));
  const wonPaid = wonOpps.filter(o => paidCamps.has(oppAttr(o, d, f.model).campaign_id));
  const paysPaid = pays.filter(p => { const o = d.oppById.get(p.opp_id); return o && paidCamps.has(oppAttr(o, d, f.model).campaign_id); });
  const costsF = d.costs.filter(c => inR(c.date, f) && (f.campaign_id === null || c.campaign_id === f.campaign_id)
    && (f.source_id === null && f.content_id === null && f.service_id === null || c.campaign_id));
  const otherCosts = sum(costsF, c => c.amount);

  const oneWon = sum(wonOpps, o => o.one_time_value); const monWon = sum(wonOpps, o => o.monthly_value);
  const totalWithMonths = wonOpps.every(o => !o.monthly_value || o.contract_months)
    ? sum(wonOpps, o => (o.one_time_value || 0) + (o.monthly_value || 0) * (o.contract_months || 0)) : null;
  const revenue = sum(pays, p => p.amount);

  const R = {
    leads: leads.map(c => recContact(c, d)),
    qual: qualContacts.map(c => recContact(c, d)),
    sched: schedOpps.map(o => recOpp(o, d, 'meeting_scheduled_at')),
    done: doneOpps.map(o => recOpp(o, d, 'meeting_done_at')),
    props: propOpps.map(o => recOpp(o, d, 'proposal_sent_at')),
    open: openOpps.map(o => recOpp(o, d, 'created_at')),
    openProps: openProps.map(o => { const v = propValue(o); return recOpp(o, d, 'proposal_sent_at', { one: v.one, monthly: v.monthly, valueFrom: v.from }); }),
    won: wonOpps.map(o => recOpp(o, d, 'won_at')),
    lost: lostOpps.map(o => recOpp(o, d, 'lost_at', { reason: nameOf(d.reasonById, o.loss_reason_id, '—') })),
    pays: pays.map(p => { const o = d.oppById.get(p.opp_id) || {}; const c = d.contactById.get(o.contact_id) || {}; return { t: 'p', id: p.id, opp_id: p.opp_id, contact_id: o.contact_id, name: c.name, date: p.date, amount: p.amount, note: p.note }; }),
    spend: groupMetricRecs(mets, d),
    leadsPaid: leadsPaid.map(c => recContact(c, d)),
    qualPaid: qualPaid.map(c => recContact(c, d)),
    wonPaid: wonPaid.map(o => recOpp(o, d, 'won_at')),
    costs: costsF.map(c => ({ t: 'x', id: c.id, date: c.date, name: c.description, category: c.category, amount: c.amount })),
  };

  const paidSpend = [...paidCamps].reduce((a, id) => a + (spendByCamp.get(id) || 0), 0);
  const unattributedSpend = spend - paidSpend; // investimento sem campanha vinculada
  const k = (key, label, value, fmt, formula, inputs, records, note) => ({ key, label, value, fmt, formula, inputs, records, note });
  const pct = (a, b) => div(a * 100, b);

  const kpis = [
    k('spend', 'Investimento em mídia', mets.length ? spend : null, 'brl', 'Soma do investimento registrado nas métricas de campanha no período.',
      [['Registros de métricas', mets.length], ['Investimento', spend, 'brl']], 'spend', mets.length ? null : 'Nenhuma métrica registrada no período.'),
    k('impressions', 'Impressões', hasImp ? impressions : null, 'int', 'Soma das impressões registradas.', [['Registros', mets.length]], 'spend', hasImp ? null : 'Sem dados de impressões.'),
    k('reach', 'Alcance (soma dos registros)', mets.some(m => m.reach !== null) ? reach : null, 'int',
      'Soma dos alcances registrados. NÃO representa pessoas únicas: a mesma pessoa pode ser contada em dias ou campanhas diferentes.',
      [['Registros', mets.length]], 'spend', 'Não equivale a pessoas únicas.'),
    k('clicks', 'Cliques (plataformas)', hasClicks ? clicks : null, 'int', 'Soma dos cliques registrados nas métricas. Cliques são anônimos.', [['Registros', mets.length], ['Cliques no link rastreável próprio', ownClicks]], 'spend', null),
    k('ctr', 'CTR', hasImp && hasClicks ? pct(clicks, impressions) : null, 'pct', 'CTR = cliques ÷ impressões × 100', [['Cliques', clicks], ['Impressões', impressions]], 'spend'),
    k('cpc', 'CPC', hasClicks ? div(spend, clicks) : null, 'brl', 'CPC = investimento em mídia ÷ cliques', [['Investimento', spend, 'brl'], ['Cliques', clicks]], 'spend'),
    k('conversations', 'Conversas iniciadas', mets.some(m => m.conversations !== null) ? conversations : null, 'int', 'Soma das conversas iniciadas informadas pelas plataformas (anônimas até a identificação).', [['Registros', mets.length]], 'spend'),
    k('leads', 'Leads captados', leads.length, 'int', 'Contatos identificados com data de captação no período (respeitando os filtros).', [['Contatos', leads.length]], 'leads'),
    k('qual', 'Leads qualificados', qualContacts.length, 'int',
      cohort ? 'Leads captados no período que têm ao menos uma oportunidade classificada como Qualificada.' : 'Contatos distintos com oportunidade qualificada no período (data da qualificação).',
      [['Contatos qualificados', qualContacts.length], ['Leads captados', leads.length], ['Taxa', pct(qualContacts.length, leads.length), 'pct']], 'qual'),
    k('sched', 'Reuniões agendadas', schedOpps.length, 'int', 'Oportunidades com data de reunião agendada ' + (cohort ? '(leads da coorte).' : 'no período.'), [['Oportunidades', schedOpps.length]], 'sched'),
    k('done', 'Reuniões realizadas', doneOpps.length, 'int', 'Oportunidades com reunião realizada ' + (cohort ? '(leads da coorte).' : 'no período.'), [['Oportunidades', doneOpps.length], ['Comparecimento', pct(doneOpps.length, schedOpps.length), 'pct']], 'done'),
    k('props', 'Propostas enviadas', propOpps.length, 'int', 'Oportunidades com proposta enviada ' + (cohort ? '(leads da coorte).' : 'no período.'), [['Oportunidades', propOpps.length]], 'props'),
    k('open', 'Oportunidades abertas (situação atual)', openOpps.length, 'int', 'Oportunidades em aberto hoje, criadas até o fim do período.', [['Abertas', openOpps.length]], 'open'),
    k('won', 'Oportunidades ganhas', wonOpps.length, 'int', cohort ? 'Oportunidades dos leads da coorte fechadas como ganhas (até hoje).' : 'Oportunidades com data de fechamento (ganho) no período.', [['Ganhas', wonOpps.length]], 'won'),
    k('lost', 'Oportunidades perdidas', lostOpps.length, 'int', cohort ? 'Oportunidades dos leads da coorte marcadas como perdidas.' : 'Oportunidades marcadas como perdidas no período.', [['Perdidas', lostOpps.length]], 'lost'),
    k('openPropOne', 'Propostas em aberto — valor único', sum(R.openProps, r => r.one), 'brl', 'Soma do valor único da última proposta (ou valor estimado, se não houver proposta registrada) das oportunidades abertas com proposta enviada. Não é receita.',
      [['Oportunidades', openProps.length], ['Mensalidades propostas (separado)', sum(R.openProps, r => r.monthly), 'brl']], 'openProps'),
    k('wonOne', 'Contratos fechados — valor único', oneWon, 'brl', 'Soma dos pagamentos únicos contratados nas oportunidades ganhas.', [['Ganhas', wonOpps.length]], 'won'),
    k('wonMonthly', 'Contratos fechados — mensalidades', monWon, 'brl', 'Soma das mensalidades contratadas (valor por mês). Não é somada ao valor único.',
      [['Ganhas com mensalidade', wonOpps.filter(o => o.monthly_value).length],
        ['Valor total estimado (único + mensal × meses informados)', totalWithMonths, 'brl']], 'won',
      totalWithMonths === null ? 'Total do contrato não calculado: há mensalidades sem prazo informado.' : null),
    k('revenue', 'Receita recebida', revenue, 'brl', 'Soma dos recebimentos registrados ' + (cohort ? 'das oportunidades da coorte.' : 'com data no período.') + ' Diferente de valor contratado.', [['Recebimentos', pays.length]], 'pays'),
    k('conv', 'Conversão comercial', pct(wonOpps.length, convBase.length), 'pct',
      cohort ? 'Conversão = oportunidades ganhas ÷ oportunidades dos leads da coorte × 100' : 'Conversão = ganhas ÷ (ganhas + perdidas no período) × 100',
      [['Ganhas', wonOpps.length], ['Consideradas no recorte', convBase.length]], 'won', sampleNote(convBase.length).level !== 'ok' ? sampleNote(convBase.length).text : null),
    k('cycle', 'Tempo médio até o fechamento', wonOpps.length ? div(sum(wonOpps, o => L.daysBetween(ld(o.created_at), o.won_at)), wonOpps.length) : null, 'days',
      'Média de dias entre a criação da oportunidade e a data do fechamento (ganho).', [['Vendas consideradas', wonOpps.length],
        ['Média desde a captação do lead (dias)', wonOpps.length ? div(sum(wonOpps, o => L.daysBetween((d.contactById.get(o.contact_id) || {}).captured_at || ld(o.created_at), o.won_at)), wonOpps.length) : null, 'num']], 'won'),
    k('cpl', 'Custo por lead (CPL)', paidSpend && leadsPaid.length ? div(paidSpend, leadsPaid.length) : null, 'brl',
      'CPL = investimento das campanhas com mídia ÷ leads atribuídos a essas campanhas. Custo médio atribuído — não é o custo exato de cada lead.',
      [['Investimento atribuível', paidSpend, 'brl'], ['Leads atribuídos', leadsPaid.length], ['Investimento sem campanha vinculada (fora do cálculo)', unattributedSpend, 'brl']], 'leadsPaid',
      !paidSpend ? 'Sem investimento registrado em campanhas.' : !leadsPaid.length ? 'Nenhum lead atribuído às campanhas com investimento.' : null),
    k('cpql', 'Custo por lead qualificado', paidSpend && qualPaid.length ? div(paidSpend, qualPaid.length) : null, 'brl',
      'Investimento das campanhas com mídia ÷ leads qualificados atribuídos a elas (custo médio atribuído).', [['Investimento atribuível', paidSpend, 'brl'], ['Qualificados atribuídos', qualPaid.length]], 'qualPaid'),
    k('cpc_client', 'Custo de mídia por cliente', paidSpend && wonPaid.length ? div(paidSpend, wonPaid.length) : null, 'brl',
      'Investimento em mídia ÷ clientes adquiridos atribuídos às campanhas com investimento (modelo: ' + (f.model === 'first' ? 'primeira origem' : 'origem da oportunidade') + ').',
      [['Investimento atribuível', paidSpend, 'brl'], ['Clientes atribuídos', wonPaid.length]], 'wonPaid'),
    k('cac', 'CAC completo', costsF.length && wonOpps.length ? div(spend + otherCosts, wonOpps.length) : null, 'brl',
      'CAC = (investimento em mídia + outros custos de marketing e vendas) ÷ novos clientes do recorte.',
      [['Mídia', spend, 'brl'], ['Outros custos cadastrados', otherCosts, 'brl'], ['Novos clientes', wonOpps.length]], 'costs',
      !costsF.length ? 'Não calculado: cadastre os custos de marketing e vendas do período em Campanhas › Outros custos.' : null),
    k('roas', 'ROAS sobre receita recebida', paidSpend && paysPaid.length ? div(sum(paysPaid, p => p.amount), paidSpend) : null, 'x',
      'ROAS = receita RECEBIDA de clientes atribuídos às campanhas com mídia ÷ investimento dessas campanhas. Propostas em aberto não entram.',
      [['Receita recebida atribuída', sum(paysPaid, p => p.amount), 'brl'], ['Investimento atribuível', paidSpend, 'brl']], 'pays'),
    k('roasContract', 'Retorno sobre valor contratado (único)', paidSpend && wonPaid.length ? div(sum(wonPaid, o => o.one_time_value), paidSpend) : null, 'x',
      'Valor único contratado por clientes atribuídos ÷ investimento atribuível. Usa valor contratado, não receita recebida; mensalidades ficam fora.',
      [['Valor único contratado atribuído', sum(wonPaid, o => o.one_time_value), 'brl'], ['Investimento atribuível', paidSpend, 'brl']], 'wonPaid'),
  ];

  // funil de etapas
  const funnelBase = cohort ? cohortOpps : oppsF.filter(o => inR(ld(o.created_at), f));
  const stagesSeq = d.stages.filter(s => !s.archived && s.kind !== 'lost');
  const reachedSort = new Map(funnelBase.map(o => [o.id, maxReachedSort(o, d)]));
  const funnel = stagesSeq.map((s, i) => {
    const ids = funnelBase.filter(o => reachedSort.get(o.id) >= s.sort);
    return { stage_id: s.id, name: s.name, kind: s.kind, reached: ids.length, records: ids.map(o => recOpp(o, d, 'created_at')) };
  });
  funnel.forEach((s, i) => { s.conv_next = i < funnel.length - 1 ? div(funnel[i + 1].reached * 100, s.reached) : null; });
  let bottleneck = null;
  funnel.forEach((s, i) => { if (s.conv_next !== null && s.reached >= 3 && (!bottleneck || s.conv_next < bottleneck.conv)) bottleneck = { from: s.name, to: funnel[i + 1].name, conv: s.conv_next, n: s.reached }; });

  // tempo nas etapas (situação atual)
  const nowIso = L.nowIso();
  const timeInStage = d.stages.filter(s => s.kind === 'open' && !s.archived).map(s => {
    const os = openOpps.filter(o => o.stage_id === s.id);
    const avg = os.length ? sum(os, o => (new Date(nowIso) - new Date(o.stage_entered_at || o.created_at)) / 86400000) / os.length : null;
    return { stage: s.name, count: os.length, avg_days: avg };
  });

  // motivos de perda
  const lossMap = new Map();
  for (const o of lostOpps) { const key = o.loss_reason_id || NONE; if (!lossMap.has(key)) lossMap.set(key, []); lossMap.get(key).push(o); }
  const losses = [...lossMap.entries()].map(([id, os]) => ({ reason: nameOf(d.reasonById, id, 'Sem motivo'), count: os.length, pct: div(os.length * 100, lostOpps.length), records: os.map(o => recOpp(o, d, 'lost_at', { objection: o.objection })) }))
    .sort((a, b) => b.count - a.count);

  // evolução
  const days = L.daysBetween(f.from, f.to) + 1;
  const gran = days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
  const bucketOf = date => {
    if (gran === 'day') return date;
    if (gran === 'month') return date.slice(0, 7);
    const dt = new Date(date + 'T12:00:00Z'); const wd = (dt.getUTCDay() + 6) % 7; return L.addDays(date, -wd);
  };
  const buckets = []; const seen = new Set();
  for (let x = f.from; x <= f.to; x = L.addDays(x, 1)) { const b = bucketOf(x); if (!seen.has(b)) { seen.add(b); buckets.push(b); } }
  const series = { leads: {}, qual: {}, won: {}, spend: {} };
  const inc = (s, date, v = 1) => { if (date && inR(date, f)) { const b = bucketOf(date); s[b] = (s[b] || 0) + v; } };
  leads.forEach(c => inc(series.leads, c.captured_at || ld(c.created_at)));
  const qualFirst = new Map();
  oppsF.filter(o => o.qual_status === 'qualificado' && o.qualified_at).forEach(o => { const p = qualFirst.get(o.contact_id); if (!p || o.qualified_at < p) qualFirst.set(o.contact_id, o.qualified_at); });
  qualFirst.forEach(dt => inc(series.qual, dt));
  oppsF.filter(o => o.status === 'won').forEach(o => inc(series.won, o.won_at));
  mets.forEach(m => inc(series.spend, m.date, m.spend || 0));
  const evolution = { gran, buckets, leads: buckets.map(b => series.leads[b] || 0), qual: buckets.map(b => series.qual[b] || 0), won: buckets.map(b => series.won[b] || 0), spend: buckets.map(b => series.spend[b] || 0) };

  // desempenho por origem e por campanha
  const bySource = breakdown(d, f, 'source');
  const byCampaign = breakdown(d, f, 'campaign');

  // oportunidades sem retorno agendado
  const noNext = openOpps.filter(o => !o.next_action_date || o.next_action_date < T)
    .map(o => recOpp(o, d, 'created_at', { next_action: o.next_action, next_action_date: o.next_action_date, overdue: !!o.next_action_date }));

  // cadeia de identificação
  const touchConv = d.touch.filter(t => t.type === 'conversa' && inR(t.occurred_at, f) && leadIdSet.has(t.contact_id)).length;
  const identification = [
    { label: 'Cliques anônimos (plataformas)', value: hasClicks ? clicks : null, note: 'Sem identificação de quem clicou.' },
    { label: 'Cliques no link rastreável próprio', value: ownClicks, note: 'Anônimos. Contados pelo link /r/ do sistema.' },
    { label: 'Conversas iniciadas (plataformas)', value: mets.some(m => m.conversations !== null) ? conversations : null, note: 'Informadas pelas plataformas; anônimas até a identificação.' },
    { label: 'Contatos identificados', value: leads.length, note: 'Formulário, atendimento ou cadastro manual.' },
    { label: 'Conversas registradas com contatos', value: touchConv, note: 'Interações do tipo "conversa" registradas na ficha.' },
    { label: 'Oportunidades comerciais', value: (cohort ? cohortOpps : oppsF.filter(o => inR(ld(o.created_at), f))).length, note: cohort ? 'Dos leads da coorte.' : 'Criadas no período.' },
    { label: 'Clientes com venda concluída', value: wonOpps.length, note: cohort ? 'Dos leads da coorte.' : 'Fechadas no período.' },
  ];

  const unknownSales = wonOpps.filter(o => oppAttr(o, d, f.model).source_id === NONE).length;

  return { filters: f, kpis, records: R, funnel, bottleneck, timeInStage, losses, evolution, bySource, byCampaign, noNext, identification,
    unknownSales, goals: goalsProgress(d, f), generated_at: L.nowIso() };
}

function groupMetricRecs(mets, d) {
  const g = new Map();
  for (const m of mets) {
    const key = `${m.campaign_id || 0}|${m.content_id || 0}|${m.source_id || 0}`;
    if (!g.has(key)) g.set(key, { t: 'm', campaign: nameOf(d.campById, m.campaign_id, 'Sem campanha'), campaign_id: m.campaign_id,
      content: m.content_id ? nameOf(d.contById, m.content_id) : '—', source: nameOf(d.srcById, m.source_id), days: 0, spend: 0, impressions: 0, clicks: 0, conversations: 0, first: m.date, last: m.date });
    const r = g.get(key); r.days++; r.spend += m.spend || 0; r.impressions += m.impressions || 0; r.clicks += m.clicks || 0; r.conversations += m.conversations || 0;
    if (m.date < r.first) r.first = m.date; if (m.date > r.last) r.last = m.date;
  }
  return [...g.values()].sort((a, b) => b.spend - a.spend);
}

// ================= COMPARAÇÕES / QUEBRAS =================
const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function groupers(d, model, by) {
  const cont = id => (id ? d.contById.get(id) : null);
  switch (by) {
    case 'source': return { c: c => contactAttr(c, d).source_id, o: o => oppAttr(o, d, model).source_id, m: m => m.source_id || NONE, label: k => nameOf(d.srcById, k) };
    case 'campaign': return { c: c => contactAttr(c, d).campaign_id, o: o => oppAttr(o, d, model).campaign_id, m: m => m.campaign_id || NONE, label: k => nameOf(d.campById, k, 'Sem campanha identificada') };
    case 'content': return { c: c => contactAttr(c, d).content_id, o: o => oppAttr(o, d, model).content_id, m: m => m.content_id || NONE, label: k => nameOf(d.contById, k, 'Sem conteúdo identificado') };
    case 'hook': case 'cta': {
      const fld = by; const labels = new Map();
      const key = id => { const k = cont(id); if (!k || !k[fld]) return NONE; const n = norm(k[fld]); labels.set(n, k[fld].trim()); return n; };
      return { c: c => key(contactAttr(c, d).content_id), o: o => key(oppAttr(o, d, model).content_id), m: m => key(m.content_id), label: k => (k === NONE ? `Sem ${by === 'hook' ? 'gancho' : 'CTA'} identificado` : labels.get(k) || k) };
    }
    case 'service': return { c: c => contactService(c, d), o: o => o.service_id || NONE, m: m => metricService(m, d), label: k => nameOf(d.svcById, k, 'Serviço não informado') };
    case 'owner': return { c: c => contactOwner(c, d), o: o => o.owner_id || NONE, m: () => NONE, label: k => (k === NONE ? 'Sem responsável' : null) };
    default: throw L.httpErr(400, 'Agrupamento inválido.');
  }
}

function breakdown(d, f, by) {
  const g = groupers(d, f.model, by);
  const contacts = filterContacts(d, f);
  const opps = filterOpps(d, f);
  const mets = filterMetrics(d, f);
  const cohort = f.view === 'cohort';
  const leads = contacts.filter(c => inR(c.captured_at || ld(c.created_at), f));
  const leadIds = new Set(leads.map(c => c.id));
  const rows = new Map();
  const row = k => {
    if (!rows.has(k)) rows.set(k, { key: k, label: g.label(k), spend: 0, impressions: 0, clicks: 0, conversations: 0, hasMetrics: false,
      leads: [], qual: new Set(), meetings: [], props: [], won: [], lost: [], one: 0, monthly: 0, revenue: 0 });
    return rows.get(k);
  };
  for (const m of mets) { const r = row(g.m(m)); r.hasMetrics = true; r.spend += m.spend || 0; r.impressions += m.impressions || 0; r.clicks += m.clicks || 0; r.conversations += m.conversations || 0; }
  for (const c of leads) row(g.c(c)).leads.push(c.id);
  const evOpps = cohort ? opps.filter(o => leadIds.has(o.contact_id)) : opps;
  for (const o of evOpps) {
    const r = row(g.o(o));
    if (o.qual_status === 'qualificado' && (cohort || inR(o.qualified_at, f))) r.qual.add(o.contact_id);
    if (o.meeting_done_at && (cohort || inR(o.meeting_done_at, f))) r.meetings.push(o.id);
    if (o.proposal_sent_at && (cohort || inR(o.proposal_sent_at, f))) r.props.push(o.id);
    if (o.status === 'won' && (cohort || inR(o.won_at, f))) { r.won.push(o.id); r.one += o.one_time_value || 0; r.monthly += o.monthly_value || 0; }
    if (o.status === 'lost' && (cohort || inR(o.lost_at, f))) r.lost.push(o.id);
  }
  const oppG = new Map(evOpps.map(o => [o.id, g.o(o)]));
  for (const p of d.payments) { if (oppG.has(p.opp_id) && (cohort || inR(p.date, f))) row(oppG.get(p.opp_id)).revenue += p.amount || 0; }
  return [...rows.values()].map(r => {
    const n = r.leads.length; const q = r.qual.size;
    return {
      key: r.key, label: r.label, hasMetrics: r.hasMetrics,
      spend: r.hasMetrics ? r.spend : null, impressions: r.hasMetrics ? r.impressions : null, clicks: r.hasMetrics ? r.clicks : null, conversations: r.hasMetrics ? r.conversations : null,
      leads: n, qualified: q, meetings: r.meetings.length, proposals: r.props.length, won: r.won.length, lost: r.lost.length,
      one: r.one, monthly: r.monthly, revenue: r.revenue,
      qual_rate: div(q * 100, n), click_to_lead: r.hasMetrics && r.clicks ? div(n * 100, r.clicks) : null,
      cpl: r.spend && n ? r.spend / n : null, cpql: r.spend && q ? r.spend / q : null, cpa: r.spend && r.won.length ? r.spend / r.won.length : null,
      sample: sampleNote(n), ids: { leads: r.leads, qual: [...r.qual], meetings: r.meetings, won: r.won, lost: r.lost },
    };
  }).sort((a, b) => (b.leads - a.leads) || ((b.spend || 0) - (a.spend || 0)));
}

function compare(db, q) {
  const d = load(db); const f = normFilters(q);
  const by = q.by || 'content';
  const rows = breakdown(d, f, by);
  if (by === 'owner') { const users = require('./db').auth.prepare('SELECT id, name FROM users').all(); rows.forEach(r => { if (r.label === null) r.label = (users.find(u => u.id === r.key) || {}).name || 'Usuário removido'; }); }
  if (by === 'content') rows.forEach(r => { const k = d.contById.get(r.key); if (k) Object.assign(r, { hook: k.hook, cta: k.cta, channel: k.channel, format: k.format, published_at: k.published_at, campaign: nameOf(d.campById, k.campaign_id, '—') }); });
  return { filters: f, by, rows, total_leads: sum(rows, r => r.leads) };
}

// ================= PERDAS =================
function losses(db, q) {
  const d = load(db); const f = normFilters(q);
  const by = q.by || 'campaign';
  const g = groupers(d, f.model, by);
  const contacts = filterContacts(d, f); const leadIds = new Set(contacts.filter(c => inR(c.captured_at || ld(c.created_at), f)).map(c => c.id));
  const opps = filterOpps(d, f).filter(o => o.status === 'lost' && (f.view === 'cohort' ? leadIds.has(o.contact_id) : inR(o.lost_at, f)));
  const reasons = d.reasons.filter(r => !r.archived || opps.some(o => o.loss_reason_id === r.id));
  const users = require('./db').auth.prepare('SELECT id, name FROM users').all();
  const label = k => { const l = g.label(k); return l === null ? ((users.find(u => u.id === k) || {}).name || 'Usuário') : l; };
  const m = new Map();
  for (const o of opps) {
    const k = g.o(o);
    if (!m.has(k)) m.set(k, { key: k, label: label(k), total: 0, counts: {}, objections: [] });
    const r = m.get(k); r.total++; r.counts[o.loss_reason_id || 0] = (r.counts[o.loss_reason_id || 0] || 0) + 1;
    if (o.objection || o.loss_detail) r.objections.push({ opp_id: o.id, contact_id: o.contact_id, name: (d.contactById.get(o.contact_id) || {}).name, reason: nameOf(d.reasonById, o.loss_reason_id, '—'), objection: o.objection, detail: o.loss_detail, retake: o.retake_date });
  }
  const objections = opps.filter(o => o.objection).map(o => ({ text: o.objection, reason: nameOf(d.reasonById, o.loss_reason_id, '—'), name: (d.contactById.get(o.contact_id) || {}).name, opp_id: o.id, contact_id: o.contact_id }));
  // objeções registradas também em oportunidades abertas/ganhas (retorno do comercial)
  const otherObj = filterOpps(d, f).filter(o => o.status !== 'lost' && o.objection && inR(ld(o.updated_at || o.created_at), f))
    .map(o => ({ text: o.objection, status: o.status, name: (d.contactById.get(o.contact_id) || {}).name, opp_id: o.id, contact_id: o.contact_id }));
  const retake = d.opps.filter(o => o.status === 'lost' && o.retake_date).sort((a, b) => a.retake_date.localeCompare(b.retake_date))
    .map(o => recOpp(o, d, 'lost_at', { retake_date: o.retake_date, reason: nameOf(d.reasonById, o.loss_reason_id, '—') }));
  return { filters: f, by, reasons: reasons.map(r => ({ id: r.id, name: r.name })), rows: [...m.values()].sort((a, b) => b.total - a.total),
    total: opps.length, sample: sampleNote(opps.length), objections, otherObjections: otherObj, retake };
}

// ================= ATRIBUIÇÃO =================
function attribution(db, q) {
  const d = load(db); const f = normFilters(q);
  const out = {};
  for (const model of ['first', 'opp']) {
    const ff = Object.assign({}, f, { model, source_id: null, campaign_id: null, content_id: null });
    const won = filterOpps(d, ff).filter(o => o.status === 'won' && inR(o.won_at, ff));
    const m = new Map();
    for (const o of won) {
      const a = oppAttr(o, d, model);
      const key = a.campaign_id ? 'c' + a.campaign_id : a.source_id ? 's' + a.source_id : 'none';
      const label = a.campaign_id ? nameOf(d.campById, a.campaign_id) : a.source_id ? nameOf(d.srcById, a.source_id) + ' (sem campanha)' : 'Não identificado';
      if (!m.has(key)) m.set(key, { key, label, won: 0, one: 0, monthly: 0, ids: [] });
      const r = m.get(key); r.won++; r.one += o.one_time_value || 0; r.monthly += o.monthly_value || 0; r.ids.push(o.id);
    }
    out[model] = { rows: [...m.values()].sort((a, b) => b.one - a.one || b.won - a.won), total_won: won.length, total_one: sum(won, o => o.one_time_value), total_monthly: sum(won, o => o.monthly_value) };
  }
  return { filters: f, models: out };
}

// ================= METAS =================
const GOAL_METRICS = {
  leads: 'Leads captados', qualificados: 'Leads qualificados', reunioes: 'Reuniões realizadas', propostas: 'Propostas enviadas',
  vendas: 'Vendas (oportunidades ganhas)', valor_unico: 'Valor único contratado (R$)', mensalidade: 'Mensalidades contratadas (R$/mês)', receita: 'Receita recebida (R$)',
};
function goalActual(d, g) {
  const f = normFilters({ from: g.period_start, to: g.period_end, service_id: g.service_id || '' });
  const opps = filterOpps(d, f);
  switch (g.metric) {
    case 'leads': return filterContacts(d, f).filter(c => inR(c.captured_at || ld(c.created_at), f)).length;
    case 'qualificados': return new Set(opps.filter(o => o.qual_status === 'qualificado' && inR(o.qualified_at, f)).map(o => o.contact_id)).size;
    case 'reunioes': return opps.filter(o => inR(o.meeting_done_at, f)).length;
    case 'propostas': return opps.filter(o => inR(o.proposal_sent_at, f)).length;
    case 'vendas': return opps.filter(o => o.status === 'won' && inR(o.won_at, f)).length;
    case 'valor_unico': return sum(opps.filter(o => o.status === 'won' && inR(o.won_at, f)), o => o.one_time_value);
    case 'mensalidade': return sum(opps.filter(o => o.status === 'won' && inR(o.won_at, f)), o => o.monthly_value);
    case 'receita': { const ids = new Set(opps.map(o => o.id)); return sum(d.payments.filter(p => ids.has(p.opp_id) && inR(p.date, f)), p => p.amount); }
    default: return null;
  }
}
function goalsProgress(d, f) {
  return d.goals.filter(g => g.period_start <= f.to && g.period_end >= f.from).map(g => {
    const actual = goalActual(d, g);
    return { id: g.id, name: g.name, metric: g.metric, metric_label: GOAL_METRICS[g.metric], service: g.service_id ? nameOf(d.svcById, g.service_id) : 'Todos os serviços',
      period_start: g.period_start, period_end: g.period_end, target: g.target, actual, pct: div(actual * 100, g.target) };
  });
}
function goalsList(db) { const d = load(db); return d.goals.map(g => Object.assign({}, g, { actual: goalActual(d, g), metric_label: GOAL_METRICS[g.metric] })); }

// ================= O QUE MELHORAR =================
function improve(db, q) {
  const d = load(db);
  const f = normFilters(Object.assign({ view: 'cohort' }, q, { from: q.from || L.addDays(L.today(), -89) }));
  const items = [];
  const fmtPct = v => (v === null ? '—' : v.toFixed(1).replace('.', ',') + '%');
  const add = (o) => items.push(o);

  const contentRows = breakdown(d, f, 'content').filter(r => r.key !== NONE);
  const campRows = breakdown(d, f, 'campaign').filter(r => r.key !== NONE);
  for (const r of contentRows.concat(campRows)) {
    const kind = contentRows.includes(r) ? 'Conteúdo' : 'Campanha';
    if (r.clicks >= 100 && r.click_to_lead !== null && r.click_to_lead < 2) add({
      area: 'Marketing', severity: 'atenção', title: `${kind} com muitos cliques e poucos contatos: ${r.label}`,
      fact: `${r.clicks.toLocaleString('pt-BR')} cliques registrados e ${r.leads} contato(s) identificado(s) (${fmtPct(r.click_to_lead)} dos cliques).`,
      hypothesis: 'O caminho entre o clique e o contato pode ter atrito (página, link da bio, formulário) ou o CTA pode não deixar claro o próximo passo.',
      test: 'Testar um CTA de menor esforço (ex.: "Envie a palavra OBRA") ou simplificar o destino do link, mantendo o mesmo gancho para comparar.',
      sample: sampleNote(r.leads), rule: 'Regra: ≥ 100 cliques e < 2% de contatos sobre cliques.' });
    if (r.leads >= MIN_SAMPLE && r.qual_rate !== null && r.qual_rate < 30) add({
      area: 'Marketing', severity: 'atenção', title: `${kind} atrai muitos contatos fora do perfil: ${r.label}`,
      fact: `${r.leads} leads e ${r.qualified} qualificado(s) (${fmtPct(r.qual_rate)}).`,
      hypothesis: 'O gancho pode estar amplo demais (ex.: "INSS" atrair quem busca aposentadoria em vez de INSS da obra).',
      test: 'Testar um gancho que nomeie o público e a situação (ex.: "Para quem está construindo ou terminou uma obra…") e comparar a taxa de qualificação.',
      sample: sampleNote(r.leads), rule: 'Regra: ≥ 10 leads e < 30% qualificados.' });
    if (r.proposals >= 5 && div(r.won * 100, r.proposals) < 20) add({
      area: 'Comercial', severity: 'atenção', title: `${kind} com muitas propostas e poucos fechamentos: ${r.label}`,
      fact: `${r.proposals} propostas e ${r.won} venda(s).`,
      hypothesis: 'Pode haver desalinhamento entre a expectativa criada pelo conteúdo e a proposta (preço, escopo ou entendimento do valor).',
      test: 'Revisar as objeções registradas desses leads e testar um roteiro de reunião que explique o passo a passo antes do preço.',
      sample: sampleNote(r.proposals), rule: 'Regra: ≥ 5 propostas e < 20% de fechamento.' });
  }
  // conteúdos com maior taxa de "serviço incompatível"
  const incompatible = d.reasons.find(x => /incompat/i.test(x.name));
  if (incompatible) {
    const opps = filterOpps(d, f).filter(o => o.status === 'lost' && o.loss_reason_id === incompatible.id);
    const by = new Map();
    for (const o of opps) { const k = oppAttr(o, d, f.model).content_id; if (k) by.set(k, (by.get(k) || 0) + 1); }
    for (const [k, n] of by) {
      const total = filterOpps(d, f).filter(o => oppAttr(o, d, f.model).content_id === k).length;
      if (n >= 3 && n / total >= 0.3) add({ area: 'Marketing', severity: 'atenção', title: `Conteúdo traz pessoas buscando outro serviço: ${nameOf(d.contById, k)}`,
        fact: `${n} de ${total} oportunidades deste conteúdo foram perdidas por "${incompatible.name}".`,
        hypothesis: 'O tema ou as palavras usadas podem estar sendo associados a outro assunto.',
        test: 'Testar título e gancho com termos específicos (CNO, SERO, CND da obra) e acompanhar a mesma métrica.', sample: sampleNote(total), rule: 'Regra: ≥ 3 perdas por serviço incompatível e ≥ 30% do conteúdo.' });
    }
  }
  // processo comercial (situação atual)
  const all = filterOpps(d, Object.assign({}, f, { from: '0000-01-01', to: L.today() }));
  const open = all.filter(o => o.status === 'open');
  const firstStage = d.stages.filter(s => s.kind === 'open' && !s.archived)[0];
  const noAttend = open.filter(o => !o.first_contact_at && firstStage && o.stage_id === firstStage.id && (Date.now() - new Date(o.created_at)) > 86400000);
  if (noAttend.length) add({ area: 'Comercial', severity: 'urgente', title: 'Leads sem primeiro atendimento há mais de 24 horas',
    fact: `${noAttend.length} oportunidade(s) continuam na primeira etapa sem registro de contato.`, hypothesis: null,
    test: 'Distribuir os leads e registrar o primeiro contato no mesmo dia.', ids: noAttend.map(o => o.id), rule: 'Situação atual.' });
  const propStage = d.stages.find(s => s.milestone === 'proposal');
  const propNoReturn = open.filter(o => o.proposal_sent_at && (!o.next_action_date || o.next_action_date < L.today()));
  if (propNoReturn.length) add({ area: 'Comercial', severity: 'urgente', title: 'Propostas sem retorno agendado',
    fact: `${propNoReturn.length} oportunidade(s) com proposta enviada sem próxima ação ou com prazo vencido.`, hypothesis: null,
    test: 'Agendar retorno para cada proposta' + (propStage ? ` (etapa "${propStage.name}")` : '') + '.', ids: propNoReturn.map(o => o.id), rule: 'Situação atual.' });
  const sched = all.filter(o => inR(o.meeting_scheduled_at, f));
  const noShow = sched.filter(o => !o.meeting_done_at && o.status !== 'open');
  if (sched.length >= 5 && noShow.length / sched.length >= 0.3) add({ area: 'Comercial', severity: 'atenção', title: 'Reuniões agendadas que não acontecem',
    fact: `${noShow.length} de ${sched.length} reuniões agendadas no período não foram realizadas antes do encerramento da oportunidade.`,
    hypothesis: 'Pode faltar confirmação próxima da data ou o lead pode ter agendado sem entender o objetivo da reunião.',
    test: 'Testar confirmação no dia anterior com um resumo do que será tratado.', sample: sampleNote(sched.length), rule: 'Regra: ≥ 5 agendadas e ≥ 30% não realizadas.' });
  // objeção mais frequente
  const lost = all.filter(o => o.status === 'lost' && inR(o.lost_at, f));
  if (lost.length >= 5) {
    const cnt = new Map(); lost.forEach(o => cnt.set(o.loss_reason_id, (cnt.get(o.loss_reason_id) || 0) + 1));
    const [rid, n] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    const nm = nameOf(d.reasonById, rid, 'Sem motivo');
    const tips = { 'Preço': 'Testar apresentar o diagnóstico e o passo a passo antes do valor; registrar a objeção exata para comparar.',
      'Não compreendeu o valor do serviço': 'Testar conteúdos que expliquem o processo com um caso didático; levar o mesmo exemplo para a reunião.',
      'Não respondeu após tentativas': 'Revisar a cadência de retorno e o canal usado (WhatsApp x ligação).',
      'Sem urgência': 'Testar conteúdos sobre prazos e consequências de deixar para depois, sem prometer economia.' };
    add({ area: 'Marketing e Comercial', severity: 'informativo', title: `Motivo de perda mais frequente: ${nm}`,
      fact: `${n} de ${lost.length} perdas no período (${fmtPct(n * 100 / lost.length)}).`, hypothesis: 'Indica um ponto a investigar nos conteúdos e na abordagem — não prova a causa.',
      test: tips[nm] || 'Ler as objeções detalhadas e definir um teste específico.', sample: sampleNote(lost.length), rule: 'Regra: ≥ 5 perdas no período.' });
  }
  const wonP = all.filter(o => o.status === 'won' && inR(o.won_at, f));
  const unk = wonP.filter(o => oppAttr(o, d, f.model).source_id === NONE);
  if (wonP.length && unk.length / wonP.length >= 0.2) add({ area: 'Processo', severity: 'atenção', title: 'Vendas sem origem identificada',
    fact: `${unk.length} de ${wonP.length} vendas do período não têm origem registrada.`, hypothesis: 'Sem origem, não é possível saber quais ações geram contratos.',
    test: 'Perguntar e registrar "como nos conheceu" no primeiro atendimento.', ids: unk.map(o => o.id), rule: 'Regra: ≥ 20% das vendas sem origem.' });
  // destaques positivos (sempre como indício)
  const best = contentRows.filter(r => r.leads >= MIN_SAMPLE).sort((a, b) => (b.qual_rate || 0) - (a.qual_rate || 0))[0];
  if (best && best.qual_rate >= 50) add({ area: 'Marketing', severity: 'positivo', title: `Conteúdo com boa taxa de qualificação: ${best.label}`,
    fact: `${best.qualified} de ${best.leads} leads qualificados (${fmtPct(best.qual_rate)}).`,
    hypothesis: 'O gancho e o CTA podem estar atraindo o público certo — correlação, não prova.',
    test: 'Produzir uma variação mantendo o gancho e mudando apenas um elemento (formato ou CTA) para confirmar.', sample: sampleNote(best.leads), rule: 'Regra: ≥ 10 leads e ≥ 50% qualificados.' });

  const order = { urgente: 0, 'atenção': 1, informativo: 2, positivo: 3 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);
  return { filters: f, items, note: 'Fatos são números calculados dos registros. Hipóteses e testes são sugestões para investigar; correlação não prova causa.' };
}

// ================= ALERTAS =================
function alerts(db, userId) {
  const d = load(db); const T = L.today();
  const open = d.opps.filter(o => o.status === 'open');
  const firstStage = d.stages.filter(s => s.kind === 'open' && !s.archived)[0];
  const mine = o => !userId || o.owner_id === userId;
  const r = o => recOpp(o, d, 'created_at', { next_action: o.next_action, next_action_date: o.next_action_date, owner_id: o.owner_id });
  return {
    noAttend: open.filter(o => !o.first_contact_at && firstStage && o.stage_id === firstStage.id && (Date.now() - new Date(o.created_at)) > 86400000).map(r),
    propNoReturn: open.filter(o => o.proposal_sent_at && (!o.next_action_date || o.next_action_date < T)).map(r),
    overdueNext: open.filter(o => o.next_action_date && o.next_action_date < T).map(r),
    noNext: open.filter(o => !o.next_action_date || !o.next_action).map(r),
    overdueTasks: d.tasks.filter(t => !t.done_at && t.due_date && t.due_date < T).map(t => ({ id: t.id, title: t.title, due_date: t.due_date, opp_id: t.opp_id, contact_id: t.contact_id, owner_id: t.owner_id, name: (d.contactById.get(t.contact_id) || {}).name })),
    retakeDue: d.opps.filter(o => o.status === 'lost' && o.retake_date && o.retake_date <= L.addDays(T, 7)).map(r),
    mineOnly: !!userId, _mine: mine,
  };
}

module.exports = { dashboard, compare, losses, attribution, improve, alerts, goalsList, GOAL_METRICS, load, contactAttr, oppAttr, sampleNote };

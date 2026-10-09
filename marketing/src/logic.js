'use strict';
// Regras de negócio compartilhadas (servidor e dados de demonstração).

const TZ = 'America/Sao_Paulo';

function nowIso() { return new Date().toISOString(); }

// Data local (America/Sao_Paulo) no formato AAAA-MM-DD
function localDate(d) {
  if (!d) return null;
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
}
function today() { return localDate(new Date()); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { // datas AAAA-MM-DD
  if (!a || !b) return null;
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

function normPhone(p) {
  if (!p) return '';
  let d = String(p).replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11 && d[0] === '0') d = d.slice(1);
  return d.length >= 8 ? d : '';
}
function normEmail(e) {
  if (!e) return '';
  const s = String(e).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/R\$\s?/i, '').replace(/\s/g, '');
  if (s === '') return null;
  // aceita 1.234,56 / 1234,56 / 1234.56
  if (s.includes(',') ) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : null;
}
function parseDateBR(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

// Classificação de qualificação: dado ausente = desconhecido, nunca "não".
function computeQualification(answers, criteria) {
  const a = answers || {};
  const reasons = [];
  let anyNo = false; let allReqYes = true; let reqCount = 0;
  for (const c of criteria.filter(c => !c.archived)) {
    const v = a[c.id] || 'desconhecido';
    const label = v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : 'Desconhecido';
    reasons.push({ id: c.id, name: c.name, required: !!c.required, value: v, label });
    if (c.required) {
      reqCount++;
      if (v === 'nao') anyNo = true;
      if (v !== 'sim') allReqYes = false;
    }
  }
  let status = 'em_analise';
  let summary;
  if (anyNo) { status = 'nao_qualificado'; summary = 'Ao menos um critério obrigatório foi marcado como "Não".'; }
  else if (reqCount && allReqYes) { status = 'qualificado'; summary = 'Todos os critérios obrigatórios foram confirmados.'; }
  else { summary = 'Faltam informações em critérios obrigatórios — classificação pendente (não significa incompatibilidade).'; }
  return { status, summary, reasons };
}

const QUAL_LABEL = { qualificado: 'Qualificado', nao_qualificado: 'Não qualificado', em_analise: 'Em análise' };

const MILESTONE_FIELD = {
  first_contact: 'first_contact_at',
  meeting_scheduled: 'meeting_scheduled_at',
  meeting_done: 'meeting_done_at',
  proposal: 'proposal_sent_at',
};

// Move uma oportunidade para outra etapa, registrando histórico e marcos.
function moveOpp(db, oppId, toStageId, userId, extra = {}, at = nowIso()) {
  const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppId);
  if (!opp) throw httpErr(404, 'Oportunidade não encontrada.');
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(toStageId);
  if (!stage) throw httpErr(400, 'Etapa inválida.');
  if (opp.stage_id === stage.id && !extra.force) return opp;
  const dateLocal = localDate(at);
  const sets = { stage_id: stage.id, stage_entered_at: at, updated_at: nowIso() };

  if (stage.kind === 'won') {
    const w = extra.won || {};
    const one = num(w.one_time_value); const mon = num(w.monthly_value);
    if (!w.won_at) throw httpErr(400, 'Informe a data de fechamento.');
    if (!w.service_id) throw httpErr(400, 'Informe o serviço contratado.');
    if (!w.contract_type) throw httpErr(400, 'Informe o tipo de contrato.');
    if (w.contract_type === 'unico' && !(one > 0)) throw httpErr(400, 'Informe o valor do pagamento único.');
    if (w.contract_type === 'mensal' && !(mon > 0)) throw httpErr(400, 'Informe o valor da mensalidade.');
    if (w.contract_type === 'misto' && !(one > 0 && mon > 0)) throw httpErr(400, 'Informe o valor único e a mensalidade.');
    Object.assign(sets, {
      status: 'won', won_at: w.won_at, service_id: Number(w.service_id), contract_type: w.contract_type,
      one_time_value: w.contract_type === 'mensal' ? null : one, monthly_value: w.contract_type === 'unico' ? null : mon,
      contract_months: w.contract_months ? Number(w.contract_months) : null, win_factors: w.win_factors || opp.win_factors,
      lost_at: null, loss_reason_id: null, loss_detail: null, retake_date: null,
    });
  } else if (stage.kind === 'lost') {
    const l = extra.lost || {};
    if (!l.loss_reason_id) throw httpErr(400, 'Informe o motivo da perda.');
    Object.assign(sets, {
      status: 'lost', lost_at: l.lost_at || dateLocal, loss_reason_id: Number(l.loss_reason_id), loss_detail: l.loss_detail || null,
      objection: l.objection || opp.objection, retake_date: l.retake_date || null,
      won_at: null, contract_type: null, one_time_value: null, monthly_value: null, contract_months: null,
    });
  } else {
    sets.status = 'open';
    if (opp.status !== 'open') Object.assign(sets, {
      won_at: null, contract_type: null, one_time_value: null, monthly_value: null, contract_months: null,
      lost_at: null, loss_reason_id: null, loss_detail: null, retake_date: null,
    });
    const f = MILESTONE_FIELD[stage.milestone];
    if (f && !opp[f]) sets[f] = dateLocal;
  }
  // ao sair da primeira etapa, considera-se que houve o primeiro atendimento
  const first = db.prepare("SELECT id FROM stages WHERE archived = 0 AND kind = 'open' ORDER BY sort LIMIT 1").get();
  if (first && stage.id !== first.id && !opp.first_contact_at && !sets.first_contact_at) sets.first_contact_at = dateLocal;

  const cols = Object.keys(sets);
  db.prepare(`UPDATE opportunities SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map(c => sets[c]), oppId);
  db.prepare('INSERT INTO stage_history (opp_id, from_stage_id, to_stage_id, user_id, at, note) VALUES (?,?,?,?,?,?)')
    .run(oppId, opp.stage_id, stage.id, userId || null, at, extra.note || null);
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(oppId);
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = {
  TZ, nowIso, localDate, today, addDays, daysBetween, normPhone, normEmail, num, parseDateBR,
  computeQualification, QUAL_LABEL, moveOpp, httpErr, MILESTONE_FIELD,
};

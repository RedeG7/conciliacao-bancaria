'use strict';
/* Núcleo da interface: API, formatação, componentes e roteamento. */
const S = { me: null, boot: null, mode: 'real', page: null };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- API ----------
async function api(method, url, body) {
  const opt = { method, headers: { 'X-R4U': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null; try { data = await r.json(); } catch (e) { /* sem corpo */ }
  if (!r.ok) {
    if (r.status === 401 && !url.includes('/login')) { showLogin(); }
    const e = new Error((data && data.error) || 'Falha na comunicação com o servidor.'); e.status = r.status; e.data = data; throw e;
  }
  return data;
}
const GET = (u) => api('GET', u); const POST = (u, b) => api('POST', u, b || {}); const PUT = (u, b) => api('PUT', u, b || {}); const DEL = (u) => api('DELETE', u);
const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

// ---------- HTML seguro ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raw = s => ({ __raw: String(s) });
function H(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v && v.__raw !== undefined) out += v.__raw;
      else if (Array.isArray(v)) out += v.map(x => (x && x.__raw !== undefined ? x.__raw : esc(x))).join('');
      else if (v === null || v === undefined || v === false) out += '';
      else out += esc(v);
    }
  });
  return raw(out);
}
const R = h => (h && h.__raw !== undefined ? h.__raw : esc(h));

// ---------- formatação (pt-BR) ----------
const NF = { brl: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }), int: new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }), dec: new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }) };
const F = {
  brl: v => (v === null || v === undefined || isNaN(v) ? '—' : NF.brl.format(v)),
  int: v => (v === null || v === undefined || isNaN(v) ? '—' : NF.int.format(v)),
  num: v => (v === null || v === undefined || isNaN(v) ? '—' : NF.dec.format(v)),
  pct: v => (v === null || v === undefined || isNaN(v) ? '—' : NF.dec.format(v) + '%'),
  x: v => (v === null || v === undefined || isNaN(v) ? '—' : NF.dec.format(v).replace(/^/, '') + 'x'),
  days: v => (v === null || v === undefined || isNaN(v) ? '—' : NF.dec.format(v) + (Math.round(v) === 1 ? ' dia' : ' dias')),
  date: s => { if (!s) return '—'; const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return s; if (String(s).length > 10) return F.dt(s); return `${m[3]}/${m[2]}/${m[1]}`; },
  dt: s => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); },
  val: (v, fmt) => (F[fmt] || F.int)(v),
};
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function daysSince(iso) { if (!iso) return null; return Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000)); }
const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase();

// ---------- rótulos ----------
const LBL = {
  kind: { cliente_potencial: 'Cliente potencial', parceiro: 'Parceiro de indicação', interessado_curso: 'Interessado em curso' },
  profile: { construtor: 'Construtor', incorporador: 'Incorporador', engenheiro: 'Engenheiro', arquiteto: 'Arquiteto', advogado: 'Advogado', proprietario: 'Proprietário de obra', investidor: 'Investidor / empresário', outro: 'Outro' },
  urgency: { alta: 'Alta', media: 'Média', baixa: 'Baixa', desconhecida: 'Desconhecida' },
  decision: { sim: 'Sim', nao: 'Não', desconhecido: 'Desconhecido' },
  qual: { qualificado: 'Qualificado', nao_qualificado: 'Não qualificado', em_analise: 'Em análise' },
  campStatus: { planejada: 'Planejada', ativa: 'Ativa', pausada: 'Pausada', encerrada: 'Encerrada' },
  touch: { formulario: 'Formulário', conversa: 'Conversa', atendimento: 'Atendimento', indicacao: 'Indicação', evento: 'Evento', contato_direto: 'Contato direto', importacao: 'Importação', outro: 'Outro' },
  contract: { unico: 'Pagamento único', mensal: 'Mensalidade', misto: 'Único + mensalidade' },
  oppStatus: { open: 'Em aberto', won: 'Ganha', lost: 'Perdida' },
  role: { admin: 'Administrador', marketing: 'Marketing', comercial: 'Comercial' },
  sourceKind: { pago: 'Mídia paga', organico: 'Orgânico', indicacao: 'Indicação', evento: 'Evento', direto: 'Contato direto', outro: 'Outro' },
};
const CHANNELS = ['Instagram', 'Facebook', 'Meta Ads', 'Google', 'Google Ads', 'YouTube', 'E-mail', 'WhatsApp', 'Site', 'Evento', 'Outro'];
const FORMATS = ['Reels', 'Stories', 'Carrossel', 'Post', 'Anúncio', 'Página', 'Vídeo', 'E-mail', 'Live', 'Outro'];
function qualChip(s) { if (!s) return ''; const c = s === 'qualificado' ? 'green' : s === 'nao_qualificado' ? 'red' : 'amber'; return `<span class="chip ${c}">${esc(LBL.qual[s] || s)}</span>`; }
function statusChip(s) { return s === 'won' ? '<span class="chip green">Ganha</span>' : s === 'lost' ? '<span class="chip red">Perdida</span>' : '<span class="chip blue">Em aberto</span>'; }
function kindChip(k) { const c = k === 'parceiro' ? 'navy' : k === 'interessado_curso' ? 'orange' : 'blue'; return `<span class="chip ${c}">${esc(LBL.kind[k] || k)}</span>`; }

// ---------- listas ----------
const can = (...roles) => S.me && roles.includes(S.me.user.role);
function listOf(name, current) { return (S.boot[name] || []).filter(x => !x.archived || String(x.id) === String(current)); }
function opts(items, selected, { empty = null, label = x => x.name || x.title, value = x => x.id } = {}) {
  let o = empty !== null ? `<option value="">${esc(empty)}</option>` : '';
  for (const it of items) { const v = value(it); o += `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(label(it))}${it.archived ? ' (arquivado)' : ''}</option>`; }
  return o;
}
function mapOpts(map, selected, empty) { return opts(Object.entries(map).map(([id, name]) => ({ id, name })), selected, { empty: empty === undefined ? null : empty }); }
const userName = id => { const u = (S.boot.users || []).find(x => x.id === id); return u ? u.name : (id ? 'Usuário' : 'Sem responsável'); };
const byId = (list, id) => (S.boot[list] || []).find(x => x.id === Number(id));

// ---------- toasts ----------
function toast(msg, o = {}) {
  let box = $('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast' + (o.err ? ' err' : ''); t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (o.action) { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = o.action.label; b.onclick = () => { t.remove(); o.action.fn(); }; t.appendChild(b); }
  box.appendChild(t); setTimeout(() => t.remove(), o.ms || (o.action ? 8000 : 3800));
}
const fail = e => toast(e.message || String(e), { err: true });

// ---------- modal ----------
function modal({ title, body = '', foot = '', size = '', onMount, onClose }) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="x-btn" data-close aria-label="Fechar">×</button></div>
    <div class="modal-body">${R(body)}</div>${foot ? `<div class="modal-foot">${R(foot)}</div>` : ''}</div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape' && document.querySelectorAll('.overlay').length && ov === [...document.querySelectorAll('.overlay')].pop()) close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) ov._down = true; });
  ov.addEventListener('click', e => { if ((e.target === ov && ov._down) || e.target.closest('[data-close]')) close(); ov._down = false; });
  const m = { el: ov.querySelector('.modal'), close, body: ov.querySelector('.modal-body') };
  onMount && onMount(m);
  const first = ov.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea'); if (first) setTimeout(() => { if (!ov.contains(document.activeElement)) first.focus(); }, 30);
  return m;
}
function confirmDlg(msg, { ok = 'Confirmar', danger = false } = {}) {
  return new Promise(res => {
    let done = false;
    const m = modal({ title: 'Confirmação', body: H`<p>${msg}</p>`, foot: H`<button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${ok}</button>`,
      onClose: () => { if (!done) res(false); } });
    m.el.querySelector('[data-ok]').onclick = () => { done = true; m.close(); res(true); };
  });
}

// ---------- formulários ----------
// campo: {name, label, type, options(html), required, help, full, placeholder, value, attrs, section}
function fieldHtml(f, v) {
  if (f.section) return `<div class="form-sec">${esc(f.section)}</div>`;
  const val = v !== undefined && v !== null ? v : (f.value ?? '');
  const req = f.required ? ' required' : '';
  const reqMark = f.required ? ' <span class="req">*</span>' : '';
  const cls = 'f' + (f.full ? ' full' : '') + (f.type === 'checkbox' ? ' check' : '');
  const help = f.help ? `<span class="help">${esc(f.help)}</span>` : '';
  const a = f.attrs || '';
  let input;
  switch (f.type) {
    case 'select': input = `<select name="${f.name}"${req} ${a}>${f.options}</select>`; break;
    case 'textarea': input = `<textarea name="${f.name}"${req} placeholder="${esc(f.placeholder || '')}" ${a}>${esc(val)}</textarea>`; break;
    case 'checkbox': return `<label class="${cls}"><input type="checkbox" name="${f.name}" ${val ? 'checked' : ''} ${a}> ${esc(f.label)}${help}</label>`;
    case 'money': input = `<input name="${f.name}" inputmode="decimal" placeholder="${esc(f.placeholder || '0,00')}" value="${esc(val === '' ? '' : String(val).replace('.', ','))}"${req} ${a}>`; break;
    case 'list': input = `<input name="${f.name}" list="dl-${f.name}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"${req} ${a}><datalist id="dl-${f.name}">${(f.items || []).map(x => `<option value="${esc(x)}">`).join('')}</datalist>`; break;
    default: input = `<input type="${f.type || 'text'}" name="${f.name}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"${req} ${a}>`;
  }
  return `<label class="${cls}"><span>${esc(f.label)}${reqMark}</span>${input}${help}</label>`;
}
function formHtml(fields, values = {}) { return `<div class="form-grid">${fields.map(f => fieldHtml(f, values[f.name])).join('')}</div>`; }
function readForm(root) {
  const o = {};
  $$('input, select, textarea', root).forEach(el => { if (!el.name) return; o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
  return o;
}
function formModal({ title, fields, values = {}, submit = 'Salvar', size = '', onSubmit, intro = '', onMount, extraFoot = '', onClose }) {
  return modal({ title, size, onClose, body: raw(`${R(intro)}<form novalidate>${formHtml(fields, values)}<p class="err-msg" data-err></p></form>`),
    foot: raw(`${R(extraFoot)}<button class="btn" data-close type="button">Cancelar</button><button class="btn primary" data-submit type="button">${esc(submit)}</button>`),
    onMount: m => {
      const form = m.el.querySelector('form');
      const go = async () => {
        const missing = fields.filter(f => f.required && !f.section).filter(f => { const el = form.elements[f.name]; return el && !el.value.trim(); });
        if (missing.length) { m.el.querySelector('[data-err]').textContent = 'Preencha: ' + missing.map(f => f.label).join(', ') + '.'; form.elements[missing[0].name].focus(); return; }
        const btn = m.el.querySelector('[data-submit]'); btn.disabled = true;
        try { const r = await onSubmit(readForm(form), m); if (r !== false) m.close(); } catch (e) { m.el.querySelector('[data-err]').textContent = e.message; } finally { btn.disabled = false; }
      };
      m.el.querySelector('[data-submit]').onclick = go;
      form.addEventListener('submit', e => { e.preventDefault(); go(); });
      form.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); go(); } });
      onMount && onMount(m, form);
    } });
}

// ---------- tabela de registros (drill-down) ----------
function recordsTable(recs, { empty = 'Nenhum registro.' } = {}) {
  if (!recs || !recs.length) return `<div class="empty">${esc(empty)}</div>`;
  const t = recs[0].t;
  if (t === 'c') return `<div class="table-wrap"><table class="t"><thead><tr><th>Contato</th><th>Empresa</th><th>Captado em</th><th>Primeira origem</th><th>Campanha</th></tr></thead><tbody>
    ${recs.map(r => `<tr class="click" data-open-contact="${r.id}"><td><b>${esc(r.name)}</b></td><td>${esc(r.company || '—')}</td><td>${F.date(r.date)}</td><td>${esc(r.src)}</td><td>${esc(r.camp || '—')}</td></tr>`).join('')}</tbody></table></div>`;
  if (t === 'o') return `<div class="table-wrap"><table class="t"><thead><tr><th>Contato</th><th>Serviço</th><th>Etapa</th><th>Data</th><th class="num">Valor</th><th>Detalhe</th></tr></thead><tbody>
    ${recs.map(r => `<tr class="click" data-open-contact="${r.contact_id}" data-opp="${r.id}"><td><b>${esc(r.name)}</b><div class="small muted">${esc(r.company || '')}</div></td><td>${esc(r.service)}</td><td>${esc(r.stage)} ${r.status !== 'open' ? statusChip(r.status) : ''}</td><td>${F.date(r.date)}</td>
      <td class="num">${r.one || r.monthly ? `${r.one ? F.brl(r.one) : ''}${r.monthly ? `<div class="small">${F.brl(r.monthly)}/mês</div>` : ''}` : F.brl(r.value)}${r.valueFrom === 'estimado' ? '<div class="small faint">estimado</div>' : ''}</td>
      <td class="small">${esc([r.reason, r.objection, r.next_action ? `Próx.: ${r.next_action} (${F.date(r.next_action_date)})` : (r.next_action_date === null && r.overdue === false ? 'Sem próxima ação' : ''), r.retake_date ? 'Retomar em ' + F.date(r.retake_date) : ''].filter(Boolean).join(' · '))}</td></tr>`).join('')}</tbody></table></div>`;
  if (t === 'p') return `<div class="table-wrap"><table class="t"><thead><tr><th>Cliente</th><th>Data</th><th class="num">Valor recebido</th><th>Observação</th></tr></thead><tbody>
    ${recs.map(r => `<tr class="click" data-open-contact="${r.contact_id}" data-opp="${r.opp_id}"><td>${esc(r.name)}</td><td>${F.date(r.date)}</td><td class="num">${F.brl(r.amount)}</td><td>${esc(r.note || '')}</td></tr>`).join('')}</tbody></table></div>`;
  if (t === 'm') return `<div class="table-wrap"><table class="t"><thead><tr><th>Campanha</th><th>Conteúdo</th><th>Origem</th><th>Período</th><th class="num">Dias</th><th class="num">Investimento</th><th class="num">Impressões</th><th class="num">Cliques</th><th class="num">Conversas</th></tr></thead><tbody>
    ${recs.map(r => `<tr class="${r.campaign_id ? 'click' : ''}" ${r.campaign_id ? `data-go="#/campanhas/${r.campaign_id}"` : ''}><td>${esc(r.campaign)}</td><td>${esc(r.content)}</td><td>${esc(r.source)}</td><td class="nowrap">${F.date(r.first)} a ${F.date(r.last)}</td><td class="num">${r.days}</td><td class="num">${F.brl(r.spend)}</td><td class="num">${F.int(r.impressions)}</td><td class="num">${F.int(r.clicks)}</td><td class="num">${F.int(r.conversations)}</td></tr>`).join('')}</tbody></table></div>`;
  if (t === 'x') return `<div class="table-wrap"><table class="t"><thead><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th class="num">Valor</th></tr></thead><tbody>
    ${recs.map(r => `<tr><td>${F.date(r.date)}</td><td>${r.category === 'vendas' ? 'Vendas' : 'Marketing'}</td><td>${esc(r.name || '')}</td><td class="num">${F.brl(r.amount)}</td></tr>`).join('')}</tbody></table></div>`;
  return '';
}
function oppsByIds(ids) { return ids; }

// ---------- gráficos ----------
function lineChart({ labels, series, height = 230, yFmt = F.int, xFmt = x => x }) {
  const W = 760, Hh = height, P = { l: 52, r: 14, t: 12, b: 28 };
  const all = series.flatMap(s => s.values); const max = Math.max(1, ...all);
  const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / p) * p; })();
  const x = i => P.l + (labels.length <= 1 ? (W - P.l - P.r) / 2 : (i * (W - P.l - P.r)) / (labels.length - 1));
  const y = v => P.t + (Hh - P.t - P.b) * (1 - v / nice);
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = nice * k / 4; g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1f6"/><text x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(yFmt(v))}</text>`; }
  const step = Math.ceil(labels.length / 10);
  labels.forEach((l, i) => { if (i % step === 0 || i === labels.length - 1) g += `<text x="${x(i)}" y="${Hh - 8}" text-anchor="middle">${esc(xFmt(l))}</text>`; });
  for (const s of series) {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    if (s.area) g += `<polygon points="${P.l},${y(0)} ${pts} ${x(s.values.length - 1)},${y(0)}" fill="${s.color}" opacity=".08"/>`;
    g += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    s.values.forEach((v, i) => { g += `<circle cx="${x(i)}" cy="${y(v)}" r="${labels.length > 40 ? 0 : 3}" fill="${s.color}"/>`; });
  }
  // zonas de hover
  labels.forEach((l, i) => {
    const w = (W - P.l - P.r) / Math.max(1, labels.length - 1);
    const tip = esc(xFmt(l)) + ' — ' + series.map(s => `${esc(s.name)}: ${esc((s.fmt || yFmt)(s.values[i]))}`).join(' · ');
    g += `<rect x="${x(i) - w / 2}" y="${P.t}" width="${w}" height="${Hh - P.t - P.b}" fill="transparent" data-tip="${tip}"/>`;
  });
  return `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
    <svg class="chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Gráfico de evolução">${g}</svg>`;
}
function barsHtml(rows, { fmt = F.int, color = '', attrs = () => '' } = {}) {
  if (!rows.length) return '<div class="empty">Sem dados no período.</div>';
  const max = Math.max(1, ...rows.map(r => r.value || 0));
  return `<div class="bars">${rows.map(r => `<div class="bar-row" ${attrs(r)}><span class="lab" title="${esc(r.label)}">${esc(r.label)}</span><span class="track"><span class="fill ${color}" style="display:block;width:${Math.max(1, (r.value || 0) / max * 100)}%"></span></span><span class="num small"><b>${esc(fmt(r.value))}</b>${r.extra ? ' ' + esc(r.extra) : ''}</span></div>`).join('')}</div>`;
}
document.addEventListener('mousemove', e => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  let tip = $('.chart-tip');
  if (!t) { if (tip) tip.remove(); return; }
  if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.appendChild(tip); }
  tip.innerHTML = t.getAttribute('data-tip'); tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY - 34) + 'px';
});

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [';', ',', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true; else if (c === delim) { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter(r => r.some(x => String(x).trim() !== ''));
  return { header: (clean.shift() || []).map(h => h.trim()), rows: clean };
}
const normKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
function guessMapping(header, fields) {
  const map = {};
  for (const f of fields) { const i = header.findIndex(h => f.aliases.some(a => normKey(h) === normKey(a) || normKey(h).includes(normKey(a)))); map[f.key] = i >= 0 ? i : ''; }
  return map;
}
function download(path) { const a = document.createElement('a'); a.href = path; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
function readFileText(file) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { let t = fr.result; if (t.includes('\uFFFD')) { const fr2 = new FileReader(); fr2.onload = () => res(fr2.result); fr2.readAsText(file, 'windows-1252'); } else res(t); }; fr.onerror = rej; fr.readAsText(file, 'utf-8'); }); }

// ---------- períodos ----------
function periodPresets() {
  const t = today(); const [y, m] = t.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const pm = m === 1 ? [y - 1, 12] : [y, m - 1];
  const pFirst = `${pm[0]}-${String(pm[1]).padStart(2, '0')}-01`; const pLast = addDays(first, -1);
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return {
    mes: ['Este mês', first, t], mes_ant: ['Mês passado', pFirst, pLast], d30: ['Últimos 30 dias', addDays(t, -29), t], d90: ['Últimos 90 dias', addDays(t, -89), t],
    tri: ['Este trimestre', `${y}-${String(q).padStart(2, '0')}-01`, t], ano: ['Este ano', `${y}-01-01`, t], d365: ['Últimos 12 meses', addDays(t, -364), t],
  };
}

// ---------- roteamento ----------
const ROUTES = [];
function route(pattern, fn, nav) { ROUTES.push({ re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, nav }); }
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
async function render() {
  const h = (location.hash || '#/painel').slice(1).split('?')[0];
  const r = ROUTES.find(x => x.re.test(h)) || ROUTES[0];
  const params = (h.match(r.re) || {}).groups || {};
  $$('.nav a').forEach(a => a.classList.toggle('active', h.startsWith(a.getAttribute('href').slice(1))));
  $('.sidebar') && $('.sidebar').classList.remove('open');
  const main = $('#content'); main.innerHTML = '<div class="empty">Carregando…</div>';
  S.page = h; const token = Symbol(); S.renderToken = token;
  try { await r.fn(main, params, () => S.renderToken === token); } catch (e) { if (e.status !== 401) main.innerHTML = `<div class="empty"><b>Não foi possível carregar.</b>${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);

// atalhos globais
document.addEventListener('click', e => {
  const c = e.target.closest('[data-open-contact]');
  if (c) { e.preventDefault(); openContact(Number(c.dataset.openContact), c.dataset.opp ? Number(c.dataset.opp) : null); return; }
  const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); go(g.dataset.go); return; }
  const dl = e.target.closest('[data-download]'); if (dl) { e.preventDefault(); download(dl.dataset.download); }
});

function icon(name) {
  const p = {
    dash: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>', funnel: '<path d="M3 4h18l-7 9v6l-4 2v-8z"/>', users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-6"/>',
    task: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>', megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14"/>',
    content: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 8l6 4-6 4z"/>', chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>', bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
    plug: '<path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15 1.6 1.6 0 0 0 2 14H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 8.8 3.3 1.6 1.6 0 0 0 10 2a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>', download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>', menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  }[name] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

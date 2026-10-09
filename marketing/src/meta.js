'use strict';
// Integração Meta Ads (Facebook/Instagram): lê as métricas diárias de cada anúncio
// pela Marketing API (endpoint /insights) e grava em metrics, sem duplicar
// (mesma chave data + campanha + conteúdo + origem da importação CSV).
// Configuração POR ESCRITÓRIO em settings 'meta:<escritório>': id da conta de
// anúncios e token (cifrado com AES-256-GCM; chave derivada de SSO_SECRET).
const crypto = require('crypto');
const L = require('./logic');
const { auth, dataDb } = require('./db');

const GRAPH = () => (process.env.META_GRAPH_URL || 'https://graph.facebook.com/v23.0').replace(/\/+$/, '');
const SOURCE_NAME = 'Meta Ads (Instagram/Facebook pago)';
const CONV_ACTION = 'onsite_conversion.messaging_conversation_started_7d';

const key = () => crypto.createHash('sha256').update('meta-cred:' + (process.env.SSO_SECRET || 'sem-segredo')).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const cfgKey = office => 'meta:' + (office || '');
function getConfig(office) {
  const r = auth.prepare('SELECT value FROM settings WHERE key = ?').get(cfgKey(office));
  try { return r ? JSON.parse(r.value) : null; } catch (e) { return null; }
}
function saveConfig(office, cfg) {
  auth.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(cfgKey(office), JSON.stringify(cfg));
}
function removeConfig(office) { auth.prepare('DELETE FROM settings WHERE key = ?').run(cfgKey(office)); }

// visão pública (sem token) para a tela de Integrações
function publicConfig(office) {
  const c = getConfig(office);
  return c ? { connected: true, account_id: c.account_id, last_sync: c.last_sync || null, last_error: c.last_error || null, last_count: c.last_count ?? null } : { connected: false };
}

const normAccount = v => { const s = String(v || '').trim().replace(/^act_/i, ''); return /^\d{5,25}$/.test(s) ? 'act_' + s : null; };

async function graphGet(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(e.message ? `Meta: ${e.message}${e.code ? ` (código ${e.code})` : ''}` : `Meta respondeu ${r.status}`);
  }
  return j;
}

async function fetchInsights(accountId, token, since, until) {
  const params = new URLSearchParams({
    level: 'ad', time_increment: '1', limit: '500', access_token: token,
    time_range: JSON.stringify({ since, until }),
    fields: 'date_start,campaign_name,ad_name,spend,impressions,reach,clicks,actions',
  });
  let url = `${GRAPH()}/${accountId}/insights?${params}`;
  const rows = [];
  for (let page = 0; url && page < 200; page++) {
    const j = await graphGet(url);
    rows.push(...(j.data || []));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return rows;
}

function findOrCreate(db, table, col, name, extra) {
  const r = db.prepare(`SELECT id FROM ${table} WHERE lower(${col}) = lower(?) ORDER BY archived, id LIMIT 1`).get(name);
  if (r) return r.id;
  const o = Object.assign({ [col]: name }, extra);
  const k = Object.keys(o);
  return Number(db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => o[x])).lastInsertRowid);
}

// Converte as linhas da Meta em métricas do escritório. Campanha e anúncio que
// ainda não existem no sistema são criados (campanha ativa no canal Meta Ads;
// anúncio como conteúdo pago dessa campanha).
function storeRows(db, rows) {
  const now = L.nowIso();
  const sourceId = findOrCreate(db, 'sources', 'name', SOURCE_NAME, { kind: 'pago', sort: 99 });
  const agg = new Map();
  for (const r of rows) {
    if (!r.date_start) continue;
    const campaignName = (r.campaign_name || 'Campanha sem nome (Meta)').slice(0, 200);
    const campaignId = findOrCreate(db, 'campaigns', 'name', campaignName, { channel: 'Meta Ads', status: 'ativa', created_at: now, updated_at: now });
    const adName = (r.ad_name || '').slice(0, 200);
    const contentId = adName ? findOrCreate(db, 'contents', 'title', adName, {
      campaign_id: campaignId, channel: 'Meta Ads', is_ad: 1, short_code: crypto.randomBytes(5).toString('base64url'), created_at: now, updated_at: now,
    }) : null;
    const k = `${r.date_start}|${campaignId}|${contentId || 0}|${sourceId}`;
    const conv = (r.actions || []).filter(a => a.action_type === CONV_ACTION).reduce((s, a) => s + Number(a.value || 0), 0);
    const cur = agg.get(k) || { ukey: k, date: r.date_start, campaign_id: campaignId, content_id: contentId, source_id: sourceId, spend: 0, impressions: 0, reach: 0, clicks: 0, conversations: 0 };
    cur.spend = Math.round((cur.spend + Number(r.spend || 0)) * 100) / 100;
    cur.impressions += Number(r.impressions || 0); cur.reach += Number(r.reach || 0);
    cur.clicks += Number(r.clicks || 0); cur.conversations += conv;
    agg.set(k, cur);
  }
  let novos = 0; let atualizados = 0;
  db.exec('BEGIN');
  try {
    for (const m of agg.values()) {
      const ex = db.prepare('SELECT * FROM metrics WHERE ukey = ?').get(m.ukey);
      if (ex) {
        if (['spend', 'impressions', 'reach', 'clicks', 'conversations'].every(f => (ex[f] ?? null) === m[f])) continue;
        db.prepare('UPDATE metrics SET spend = ?, impressions = ?, reach = ?, clicks = ?, conversations = ?, origin = ?, updated_at = ? WHERE id = ?')
          .run(m.spend, m.impressions, m.reach, m.clicks, m.conversations, 'meta', now, ex.id);
        atualizados++;
      } else {
        db.prepare('INSERT INTO metrics (ukey, date, campaign_id, content_id, source_id, spend, impressions, reach, clicks, conversations, origin, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(m.ukey, m.date, m.campaign_id, m.content_id, m.source_id, m.spend, m.impressions, m.reach, m.clicks, m.conversations, 'meta', now);
        novos++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { linhas: rows.length, novos, atualizados };
}

// Sincroniza os últimos `days` dias (a Meta ajusta números recentes, por isso
// sempre relê uma janela e não só o dia anterior).
async function syncOffice(office, days = 7) {
  const cfg = getConfig(office);
  if (!cfg) throw new Error('Meta Ads não conectado neste escritório.');
  const until = L.today(); const since = L.addDays(until, -(days - 1));
  try {
    const rows = await fetchInsights(cfg.account_id, decrypt(cfg.token_enc), since, until);
    const r = storeRows(dataDb('real', office), rows);
    saveConfig(office, Object.assign(cfg, { last_sync: L.nowIso(), last_error: null, last_count: r.linhas }));
    return Object.assign({ since, until }, r);
  } catch (e) {
    saveConfig(office, Object.assign(cfg, { last_error: String(e.message || e).slice(0, 500), last_error_at: L.nowIso() }));
    throw e;
  }
}

// Conecta: valida o formato, confere o token lendo a conta e já traz 30 dias.
async function connect(office, accountIdRaw, token) {
  const accountId = normAccount(accountIdRaw);
  if (!accountId) throw new Error('Informe o ID da conta de anúncios (só números, com ou sem "act_").');
  if (!token || String(token).trim().length < 20) throw new Error('Informe o token de acesso da Meta.');
  token = String(token).trim();
  await graphGet(`${GRAPH()}/${accountId}?fields=name,account_status&access_token=${encodeURIComponent(token)}`);
  saveConfig(office, { account_id: accountId, token_enc: encrypt(token), connected_at: L.nowIso() });
  return syncOffice(office, 30);
}

// Sincronização automática de todos os escritórios conectados.
function startScheduler(hours = Number(process.env.META_SYNC_HOURS || 6)) {
  const run = async () => {
    for (const r of auth.prepare("SELECT key FROM settings WHERE key LIKE 'meta:%'").all()) {
      const office = r.key.slice(5) || null;
      try { await syncOffice(office, 7); } catch (e) { console.error('[meta]', office, e.message); }
    }
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, hours * 3600 * 1000).unref();
}

module.exports = { publicConfig, connect, syncOffice, removeConfig, startScheduler, normAccount, storeRows };

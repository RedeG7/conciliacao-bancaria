'use strict';
// Integração Meta Ads (Facebook/Instagram): lê as métricas diárias de cada anúncio
// pela Marketing API (endpoint /insights) e grava em metrics, sem duplicar
// (mesma chave data + campanha + conteúdo + origem da importação CSV).
// Configuração POR ESCRITÓRIO em settings 'meta:<escritório>': id da conta de
// anúncios e token (cifrado com AES-256-GCM; chave derivada de SSO_SECRET).
const L = require('./logic');
const { dataDb } = require('./db');

const GRAPH = () => (process.env.META_GRAPH_URL || 'https://graph.facebook.com/v23.0').replace(/\/+$/, '');
const SOURCE_NAME = 'Meta Ads (Instagram/Facebook pago)';
const CONV_ACTION = 'onsite_conversion.messaging_conversation_started_7d';

const ads = require('./adsync');
const { encrypt, decrypt } = ads;
const store = ads.configStore('meta');
const getConfig = office => store.get(office);
const saveConfig = (office, cfg) => store.save(office, cfg);
const removeConfig = office => store.remove(office);

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

// Linhas da Meta -> formato comum (conversas = conversas iniciadas por mensagem)
function storeRows(db, rows) {
  return ads.storeRows(db, rows.map(r => ({
    date: r.date_start, campaign: r.campaign_name || 'Campanha sem nome (Meta)', content: r.ad_name || '',
    spend: r.spend, impressions: r.impressions, reach: r.reach || 0, clicks: r.clicks,
    conversations: (r.actions || []).filter(a => a.action_type === CONV_ACTION).reduce((s, a) => s + Number(a.value || 0), 0),
  })), { sourceName: SOURCE_NAME, channel: 'Meta Ads', origin: 'meta' });
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
    for (const office of store.offices()) {
      try { await syncOffice(office, 7); } catch (e) { console.error('[meta]', office, e.message); }
    }
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, hours * 3600 * 1000).unref();
}

module.exports = { publicConfig, connect, syncOffice, removeConfig, startScheduler, normAccount, storeRows };

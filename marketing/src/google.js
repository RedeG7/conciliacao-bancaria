'use strict';
// Integração Google Ads: lê, por dia, campanha e grupo de anúncios, o gasto,
// impressões e cliques (Google Ads API, GAQL via googleAds:searchStream) e grava
// nas métricas do escritório sem duplicar.
//
// Credenciais da PLATAFORMA (no .env do servidor, criadas uma vez pela RedeG7):
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET
//   (opcional GOOGLE_ADS_LOGIN_CUSTOMER_ID = conta administradora MCC)
// Por ESCRITÓRIO (settings 'google:<escritório>'): ID do cliente Google Ads e o
// refresh token (cifrado) obtido no botão "Conectar com Google" (OAuth).
const crypto = require('crypto');
const L = require('./logic');
const { dataDb } = require("./db");
const ads = require('./adsync');

const store = ads.configStore('google');
const env = k => process.env[k] || '';
const AUTH_URL = () => env('GOOGLE_OAUTH_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = () => env('GOOGLE_OAUTH_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
const API_URL = () => (env('GOOGLE_ADS_API_URL') || 'https://googleads.googleapis.com').replace(/\/+$/, '');
// versões da API saem de linha em ~1 ano: tenta da mais nova para a mais antiga
// (ou só a de GOOGLE_ADS_API_VERSION) e guarda a que respondeu
const VERSIONS = () => (env('GOOGLE_ADS_API_VERSION') ? [env('GOOGLE_ADS_API_VERSION')] : ['v24', 'v23', 'v22', 'v21']);
let workingVersion = null;

const platformReady = () => !!(env('GOOGLE_ADS_DEVELOPER_TOKEN') && env('GOOGLE_ADS_CLIENT_ID') && env('GOOGLE_ADS_CLIENT_SECRET'));
const normCustomer = v => { const s = String(v || '').replace(/\D/g, ''); return s.length === 10 ? s : null; };
const fmtCustomer = s => s ? `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}` : '';

function publicConfig(office) {
  const c = store.get(office);
  const base = { platformReady: platformReady() };
  return c && c.refresh_enc
    ? Object.assign(base, { connected: true, customer_id: fmtCustomer(c.customer_id), last_sync: c.last_sync || null, last_error: c.last_error || null, last_count: c.last_count ?? null })
    : Object.assign(base, { connected: false });
}

// ---------- OAuth ("Conectar com Google") ----------
const pending = new Map(); // state -> { office, customer, login, exp }
function startOAuth(office, customerRaw, loginRaw, redirectUri) {
  if (!platformReady()) throw new Error('A integração Google Ads ainda não foi habilitada no servidor (credenciais da plataforma). Fale com a RedeG7.');
  const customer = normCustomer(customerRaw);
  if (!customer) throw new Error('Informe o ID do cliente Google Ads (10 dígitos, ex.: 123-456-7890).');
  const login = loginRaw ? normCustomer(loginRaw) : null;
  if (loginRaw && !login) throw new Error('ID da conta administradora (MCC) inválido — 10 dígitos.');
  const state = crypto.randomBytes(24).toString('hex');
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  pending.set(state, { office, customer, login, redirectUri, exp: Date.now() + 15 * 60 * 1000 });
  const q = new URLSearchParams({ client_id: env('GOOGLE_ADS_CLIENT_ID'), redirect_uri: redirectUri, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords', access_type: 'offline', prompt: 'consent', state });
  return `${AUTH_URL()}?${q}`;
}

async function postForm(url, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Google: ${j.error_description || j.error || 'resposta ' + r.status}`);
  return j;
}

async function finishOAuth(state, code) {
  const p = pending.get(state); pending.delete(state);
  if (!p || p.exp < Date.now()) throw new Error('A autorização expirou. Clique em "Conectar com Google" de novo.');
  const t = await postForm(TOKEN_URL(), { code, client_id: env('GOOGLE_ADS_CLIENT_ID'), client_secret: env('GOOGLE_ADS_CLIENT_SECRET'), redirect_uri: p.redirectUri, grant_type: 'authorization_code' });
  if (!t.refresh_token) throw new Error('O Google não devolveu o acesso permanente (refresh token). Tente de novo e aceite todas as permissões.');
  store.save(p.office, { customer_id: p.customer, login_customer_id: p.login, refresh_enc: ads.encrypt(t.refresh_token), connected_at: L.nowIso() });
  return p.office;
}

// ---------- leitura das métricas ----------
async function accessToken(cfg) {
  const t = await postForm(TOKEN_URL(), { client_id: env('GOOGLE_ADS_CLIENT_ID'), client_secret: env('GOOGLE_ADS_CLIENT_SECRET'), refresh_token: ads.decrypt(cfg.refresh_enc), grant_type: 'refresh_token' });
  return t.access_token;
}

async function searchStream(cfg, token, query) {
  const login = cfg.login_customer_id || normCustomer(env('GOOGLE_ADS_LOGIN_CUSTOMER_ID'));
  const headers = { Authorization: `Bearer ${token}`, 'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'), 'Content-Type': 'application/json' };
  if (login) headers['login-customer-id'] = login;
  const versions = workingVersion ? [workingVersion] : VERSIONS();
  let lastErr = null;
  for (const v of versions) {
    const r = await fetch(`${API_URL()}/${v}/customers/${cfg.customer_id}/googleAds:searchStream`, { method: 'POST', headers, body: JSON.stringify({ query }) });
    const j = await r.json().catch(() => null);
    if (r.status === 404 && !workingVersion) { lastErr = new Error(`Google Ads API ${v} indisponível`); continue; } // versão fora do ar: tenta a próxima
    if (!r.ok) {
      const e = Array.isArray(j) ? j[0] && j[0].error : j && j.error;
      const detail = e && e.details && e.details[0] && e.details[0].errors && e.details[0].errors[0];
      throw new Error(`Google Ads: ${(detail && detail.message) || (e && e.message) || 'resposta ' + r.status}`);
    }
    workingVersion = v;
    return (Array.isArray(j) ? j : [j]).flatMap(b => (b && b.results) || []);
  }
  throw lastErr || new Error('Google Ads API indisponível');
}

async function syncOffice(office, days = 7) {
  const cfg = store.get(office);
  if (!cfg || !cfg.refresh_enc) throw new Error('Google Ads não conectado neste escritório.');
  if (!platformReady()) throw new Error('A integração Google Ads não está habilitada no servidor.');
  const until = L.today(); const since = L.addDays(until, -(days - 1));
  try {
    const token = await accessToken(cfg);
    const results = await searchStream(cfg, token,
      `SELECT segments.date, campaign.name, ad_group.name, metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0`);
    const rows = results.map(x => ({
      date: x.segments && x.segments.date, campaign: x.campaign && x.campaign.name, content: x.adGroup && x.adGroup.name,
      spend: Number((x.metrics && x.metrics.costMicros) || 0) / 1e6, impressions: x.metrics && x.metrics.impressions, clicks: x.metrics && x.metrics.clicks,
    }));
    const r = ads.storeRows(dataDb('real', office), rows, { sourceName: 'Google Ads', channel: 'Google Ads', origin: 'google' });
    store.save(office, Object.assign(cfg, { last_sync: L.nowIso(), last_error: null, last_count: r.linhas }));
    return Object.assign({ since, until }, r);
  } catch (e) {
    store.save(office, Object.assign(cfg, { last_error: String(e.message || e).slice(0, 500), last_error_at: L.nowIso() }));
    throw e;
  }
}

function startScheduler(hours = Number(process.env.GOOGLE_SYNC_HOURS || process.env.META_SYNC_HOURS || 6)) {
  const run = async () => {
    if (!platformReady()) return;
    for (const office of store.offices()) {
      try { await syncOffice(office, 7); } catch (e) { console.error('[google]', office, e.message); }
    }
  };
  setTimeout(run, 90 * 1000).unref();
  setInterval(run, hours * 3600 * 1000).unref();
}

module.exports = { publicConfig, startOAuth, finishOAuth, syncOffice, removeConfig: o => store.remove(o), startScheduler, platformReady };

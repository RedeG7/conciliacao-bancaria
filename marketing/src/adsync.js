'use strict';
// Partes comuns das integrações de anúncios (Meta Ads, Google Ads): cifra das
// credenciais, configuração por escritório em settings e gravação das métricas
// sem duplicar (mesma chave data + campanha + conteúdo + origem da importação CSV).
const crypto = require('crypto');
const L = require('./logic');
const { auth } = require('./db');

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

// configuração por escritório: settings '<prefixo>:<escritório>'
function configStore(prefix) {
  const k = office => `${prefix}:${office || ''}`;
  return {
    get(office) { const r = auth.prepare('SELECT value FROM settings WHERE key = ?').get(k(office)); try { return r ? JSON.parse(r.value) : null; } catch (e) { return null; } },
    save(office, cfg) { auth.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k(office), JSON.stringify(cfg)); },
    remove(office) { auth.prepare('DELETE FROM settings WHERE key = ?').run(k(office)); },
    offices() { return auth.prepare('SELECT key FROM settings WHERE key LIKE ?').all(prefix + ':%').map(r => r.key.slice(prefix.length + 1) || null); },
  };
}

function findOrCreate(db, table, col, name, extra) {
  const r = db.prepare(`SELECT id FROM ${table} WHERE lower(${col}) = lower(?) ORDER BY archived, id LIMIT 1`).get(name);
  if (r) return r.id;
  const o = Object.assign({ [col]: name }, extra);
  const k = Object.keys(o);
  return Number(db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => o[x])).lastInsertRowid);
}

// rows: [{ date, campaign, content, spend, impressions, reach, clicks, conversations }]
// Campanha/conteúdo que ainda não existem são criados (conteúdo = anúncio pago).
function storeRows(db, rows, { sourceName, channel, origin }) {
  const now = L.nowIso();
  const sourceId = findOrCreate(db, 'sources', 'name', sourceName, { kind: 'pago', sort: 99 });
  const agg = new Map();
  for (const r of rows) {
    if (!r.date) continue;
    const campaignName = String(r.campaign || `Campanha sem nome (${channel})`).slice(0, 200);
    const campaignId = findOrCreate(db, 'campaigns', 'name', campaignName, { channel, status: 'ativa', created_at: now, updated_at: now });
    const contentName = String(r.content || '').slice(0, 200);
    const contentId = contentName ? findOrCreate(db, 'contents', 'title', contentName, {
      campaign_id: campaignId, channel, is_ad: 1, short_code: crypto.randomBytes(5).toString('base64url'), created_at: now, updated_at: now,
    }) : null;
    const k = `${r.date}|${campaignId}|${contentId || 0}|${sourceId}`;
    const cur = agg.get(k) || { ukey: k, date: r.date, campaign_id: campaignId, content_id: contentId, source_id: sourceId, spend: 0, impressions: 0, reach: null, clicks: 0, conversations: null };
    cur.spend = Math.round((cur.spend + Number(r.spend || 0)) * 100) / 100;
    cur.impressions += Number(r.impressions || 0); cur.clicks += Number(r.clicks || 0);
    if (r.reach !== undefined && r.reach !== null) cur.reach = (cur.reach || 0) + Number(r.reach || 0);
    if (r.conversations !== undefined && r.conversations !== null) cur.conversations = (cur.conversations || 0) + Number(r.conversations || 0);
    agg.set(k, cur);
  }
  let novos = 0; let atualizados = 0;
  db.exec('BEGIN');
  try {
    for (const m of agg.values()) {
      const ex = db.prepare('SELECT * FROM metrics WHERE ukey = ?').get(m.ukey);
      if (ex) {
        if (['spend', 'impressions', 'reach', 'clicks', 'conversations'].every(f => (ex[f] ?? null) === (m[f] ?? null))) continue;
        db.prepare('UPDATE metrics SET spend = ?, impressions = ?, reach = ?, clicks = ?, conversations = ?, origin = ?, updated_at = ? WHERE id = ?')
          .run(m.spend, m.impressions, m.reach, m.clicks, m.conversations, origin, now, ex.id);
        atualizados++;
      } else {
        db.prepare('INSERT INTO metrics (ukey, date, campaign_id, content_id, source_id, spend, impressions, reach, clicks, conversations, origin, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(m.ukey, m.date, m.campaign_id, m.content_id, m.source_id, m.spend, m.impressions, m.reach, m.clicks, m.conversations, origin, now);
        novos++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { linhas: rows.length, novos, atualizados };
}

module.exports = { encrypt, decrypt, configStore, storeRows };

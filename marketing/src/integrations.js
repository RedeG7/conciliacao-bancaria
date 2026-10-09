'use strict';
// Integrações externas. Apenas o recebimento de formulários (webhook) e o link rastreável próprio
// estão implementados. Meta Ads, Google Ads e WhatsApp Business dependem de contas e credenciais
// oficiais — sem elas o sistema mostra "Não conectado" e NÃO simula sincronização.
const crypto = require('crypto');
const L = require('./logic');

function trackedUrl(c) {
  if (!c || !c.url) return null;
  try {
    const u = new URL(c.url);
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) if (c[k] && !u.searchParams.has(k)) u.searchParams.set(k, c[k]);
    return u.toString();
  } catch (e) { return c.url; }
}

function status(req, opts = {}) {
  const env = process.env;
  const has = (...k) => k.every(x => !!env[x]);
  // código do escritório (gerado em Integrações) ou, legado, o código único do servidor
  const formReady = !!opts.formToken || has('FORM_WEBHOOK_TOKEN');
  return [
    {
      key: 'form', name: 'Formulários do site / landing pages (webhook)', implemented: true,
      status: formReady ? 'ativo' : 'nao_conectado',
      statusLabel: formReady ? 'Ativo — aguardando envios' : 'Não conectado',
      what: 'Recebe envios de formulário em POST /api/webhooks/form, cria ou atualiza o contato (verificando telefone e e-mail), registra a origem com as UTMs e abre uma oportunidade na primeira etapa. Grava sempre nos dados reais do escritório dono do código.',
      needs: ['Um administrador gera o código do escritório aqui mesmo (botão "Gerar código") — cada escritório tem o seu, e os leads de cada código entram só nele.', 'O site ou a ferramenta de formulário envia os campos para o endereço do sistema com o código (cabeçalho X-Webhook-Token ou ?token= na URL).'],
      cost: 'Sem custo do sistema. Exige o sistema publicado em um endereço acessível pela internet.',
    },
    {
      key: 'shortlink', name: 'Link rastreável próprio (/r/código)', implemented: true, status: 'ativo', statusLabel: 'Ativo',
      what: 'Cada conteúdo cadastrado ganha um link curto. O clique é contado de forma anônima (sem IP e sem identificar a pessoa) e redireciona para o destino com as UTMs.',
      needs: ['Para uso externo, o sistema precisa estar publicado em um domínio próprio (ex.: crm.seudominio.com.br).'], cost: 'Sem custo do sistema.',
    },
    {
      key: 'meta', name: 'Meta Ads (Facebook/Instagram)', implemented: false,
      status: has('META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID') ? 'credenciais' : 'nao_conectado',
      statusLabel: has('META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID') ? 'Credenciais informadas — sincronização ainda não implementada' : 'Não conectado',
      what: 'Estrutura preparada: as métricas importadas ficam por data, campanha, conteúdo e origem, sem duplicar. A leitura automática pela Marketing API ainda não foi implementada; use a importação CSV exportada do Gerenciador de Anúncios.',
      needs: ['Conta no Meta Business (Business Manager) com a conta de anúncios.', 'Aplicativo no Meta for Developers e token de acesso com permissão ads_read.', 'Pode exigir verificação da empresa e revisão do aplicativo pela Meta.', 'Leads de formulário instantâneo exigem também leads_retrieval e páginas vinculadas.'],
      cost: 'A API não é cobrada; os anúncios seguem cobrados normalmente pela Meta.',
    },
    {
      key: 'google', name: 'Google Ads', implemented: false,
      status: has('GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID') ? 'credenciais' : 'nao_conectado',
      statusLabel: has('GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID') ? 'Credenciais informadas — sincronização ainda não implementada' : 'Não conectado',
      what: 'Estrutura preparada como no Meta Ads. Enquanto não houver integração, exporte o relatório do Google Ads em CSV e importe em Campanhas › Importar métricas.',
      needs: ['Conta de administrador (MCC) do Google Ads.', 'Developer token aprovado pelo Google (o nível básico exige solicitação).', 'Projeto no Google Cloud com OAuth (Client ID e Secret) e autorização da conta.'],
      cost: 'A API não é cobrada; os anúncios seguem cobrados pelo Google.',
    },
    {
      key: 'whatsapp', name: 'WhatsApp Business', implemented: false,
      status: has('WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID') ? 'credenciais' : 'nao_conectado',
      statusLabel: has('WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID') ? 'Credenciais informadas — recebimento ainda não implementado' : 'Não conectado',
      what: 'Hoje as conversas são registradas manualmente na ficha (interação do tipo "Conversa"). A integração oficial permitiria registrar automaticamente o início de conversas identificadas.',
      needs: ['WhatsApp Business Platform (Cloud API) da Meta — o aplicativo comum do WhatsApp Business não oferece essa integração.', 'Empresa verificada no Meta Business, número dedicado e token permanente.', 'Endereço público HTTPS para receber eventos (webhook).'],
      cost: 'A Meta cobra por conversa/mensagem conforme a categoria; pode haver custo de provedor (BSP) se usado.',
    },
  ];
}

// db: banco do escritório dono do código (o servidor já conferiu o código e escolheu o banco)
function receiveForm(req, res, db, owner = null) {
  const p = Object.assign({}, req.body || {});
  const g = (...k) => { for (const x of k) if (p[x]) return String(p[x]).trim(); return null; };
  const name = g('nome', 'name'); const phone = g('telefone', 'phone', 'whatsapp'); const email = g('email', 'e-mail');
  const phone_norm = L.normPhone(phone) || null; const email_norm = L.normEmail(email) || null;
  if (!name || (!phone_norm && !email_norm)) return res.status(400).json({ error: 'Envie nome e telefone ou e-mail.' });
  const lookup = (table, col, v) => { if (!v) return null; const r = db.prepare(`SELECT id FROM ${table} WHERE ${/^\d+$/.test(v) ? 'id = ?' : `lower(${col}) = lower(?)`}`).get(/^\d+$/.test(v) ? Number(v) : v); return r ? r.id : null; };
  const now = L.nowIso(); const today = L.today();
  db.exec('BEGIN');
  try {
    let c = db.prepare('SELECT * FROM contacts WHERE (phone_norm IS NOT NULL AND phone_norm = ?) OR (email_norm IS NOT NULL AND email_norm = ?) ORDER BY archived, id LIMIT 1').get(phone_norm || '#', email_norm || '#');
    let created = false;
    if (!c) {
      const id = db.prepare(`INSERT INTO contacts (name, phone, phone_norm, email, email_norm, company, city, kind, decision_maker, captured_at, owner_id, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(name, phone, phone_norm, email, email_norm, g('empresa', 'company'), g('cidade', 'city'),
        /curso/i.test(g('tipo', 'interesse') || '') ? 'interessado_curso' : 'cliente_potencial', 'desconhecido', today, owner, g('mensagem', 'message'), now, now).lastInsertRowid;
      c = { id: Number(id) }; created = true;
    }
    const source_id = lookup('sources', 'name', g('origem', 'source_id')) || lookup('sources', 'name', 'Site / formulário');
    db.prepare(`INSERT INTO touchpoints (contact_id, occurred_at, type, source_id, campaign_id, content_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id, today, 'formulario', source_id, lookup('campaigns', 'name', g('campanha_id', 'campanha')), lookup('contents', 'title', g('conteudo_id', 'conteudo')),
      g('utm_source'), g('utm_medium'), g('utm_campaign'), g('utm_content'), g('utm_term'), [g('formulario', 'form'), g('mensagem', 'message')].filter(Boolean).join(' — ') || 'Formulário', now);
    const first = db.prepare("SELECT id FROM stages WHERE kind = 'open' AND archived = 0 ORDER BY sort LIMIT 1").get();
    const openOpp = db.prepare("SELECT id FROM opportunities WHERE contact_id = ? AND status = 'open'").get(c.id);
    let oppId = openOpp ? openOpp.id : null;
    if (!oppId) {
      const t = db.prepare('SELECT * FROM touchpoints WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
      oppId = Number(db.prepare(`INSERT INTO opportunities (contact_id, service_id, stage_id, owner_id, status, need, source_id, campaign_id, content_id, next_action, next_action_date, stage_entered_at, qual_answers, qual_status, created_at, updated_at)
        VALUES (?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?)`).run(c.id, lookup('services', 'name', g('servico', 'service')), first.id, owner, g('mensagem', 'message'), t.source_id, t.campaign_id, t.content_id,
        'Fazer primeiro contato (formulário)', today, now, '{}', 'em_analise', now, now).lastInsertRowid);
      db.prepare('INSERT INTO stage_history (opp_id, from_stage_id, to_stage_id, at, note) VALUES (?,?,?,?,?)').run(oppId, null, first.id, now, 'Criada por formulário');
    }
    db.prepare('INSERT INTO audit (user_name, action, entity, entity_id, details, at) VALUES (?,?,?,?,?,?)').run('formulário', created ? 'contato criado via formulário' : 'interação via formulário', 'contato', c.id, null, now);
    db.exec('COMMIT');
    res.json({ ok: true, contact_id: c.id, opportunity_id: oppId, created });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

module.exports = { trackedUrl, status, receiveForm, sha };

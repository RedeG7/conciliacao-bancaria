'use strict';
// Teste do fluxo completo via API, em banco temporário: node test/fluxo.test.js
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r4u-'));
process.env.FORM_WEBHOOK_TOKEN = 'token-de-teste';
process.removeAllListeners('warning');
const app = require('../src/server');
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const jar = {};
async function call(who, method, url, body, extra = {}) {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-R4U': '1', Cookie: jar[who] || '' }, extra), body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { d = t; }
  return { status: r.status, data: d };
}
const ok = (r, msg) => { assert.ok(r.status < 300, `${msg}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const T = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
(async () => {
  ok(await call('a', 'POST', '/api/setup', { name: 'Admin', email: 'admin@teste.com', password: 'senha12345' }), 'setup');
  ok(await call('a', 'POST', '/api/login', { email: 'admin@teste.com', password: 'senha12345' }), 'login');
  assert.equal((await call('x', 'GET', '/api/contacts')).status, 401, 'sem login bloqueia');
  ok(await call('a', 'POST', '/api/users', { name: 'Mkt', email: 'mkt@teste.com', role: 'marketing', password: 'senha12345' }), 'cria marketing');
  ok(await call('m', 'POST', '/api/login', { email: 'mkt@teste.com', password: 'senha12345' }), 'login marketing');
  const boot = ok(await call('a', 'GET', '/api/bootstrap'), 'boot');
  const svc = boot.services[0].id; const meta = boot.sources.find(s => s.name.startsWith('Meta')).id;
  const won = boot.stages.find(s => s.kind === 'won').id; const lost = boot.stages.find(s => s.kind === 'lost').id;
  const proposalStage = boot.stages.find(s => s.milestone === 'proposal').id;
  const me = ok(await call('a', 'GET', '/api/me'), 'me').user.id;

  const camp = ok(await call('m', 'POST', '/api/campaigns', { name: 'Campanha teste', service_id: svc, status: 'ativa', budget_planned: '1000', start_date: T }), 'campanha').id;
  const cont = ok(await call('m', 'POST', '/api/contents', { title: 'Reels teste', hook: 'Regularizar depois pode sair mais caro do que planejar antes', cta: 'Agende uma reunião', campaign_id: camp, url: 'real4u.com.br' }), 'conteúdo').id;
  // métricas: importação repetida não soma
  const rows = [{ date: T, campaign: 'Campanha teste', content: 'Reels teste', spend: '200,00', impressions: '10000', clicks: '100' }];
  ok(await call('m', 'POST', '/api/metrics/import/commit', { rows }), 'import 1');
  const again = ok(await call('m', 'POST', '/api/metrics/import/commit', { rows }), 'import 2');
  assert.equal(again.ignorados, 1, 'reimportação igual é ignorada');
  ok(await call('m', 'POST', '/api/metrics/import/commit', { rows: [Object.assign({}, rows[0], { spend: '250' })] }), 'import 3');
  assert.equal(ok(await call('a', 'GET', '/api/metrics'), 'metrics').length, 1, 'uma linha por chave');

  const c1 = ok(await call('a', 'POST', '/api/contacts', { contact: { name: 'Lead Um', phone: '(62) 99999-0001' }, touch: { source_id: meta, campaign_id: camp, content_id: cont }, opp: { create: true, service_id: svc, owner_id: me, next_action: 'Ligar', next_action_date: T, estimated_value: '5000' } }), 'lead 1');
  const c2 = ok(await call('a', 'POST', '/api/contacts', { contact: { name: 'Lead Dois', email: 'dois@teste.com' }, touch: { source_id: meta, campaign_id: camp, content_id: cont }, opp: { create: true, service_id: svc, owner_id: me, next_action: 'Ligar', next_action_date: T } }), 'lead 2');
  assert.equal((await call('a', 'POST', '/api/contacts', { contact: { name: 'Dup', phone: '62999990001' } })).status, 409, 'duplicidade por telefone');
  assert.equal((await call('m', 'POST', `/api/opportunities/${c1.oppId}/move`, { stage_id: proposalStage })).status, 403, 'marketing não move etapa');
  ok(await call('a', 'POST', `/api/opportunities/${c1.oppId}/move`, { stage_id: proposalStage }), 'move proposta');
  assert.equal((await call('a', 'POST', `/api/opportunities/${c1.oppId}/move`, { stage_id: won, won: { won_at: T, service_id: svc } })).status, 400, 'ganho exige tipo de contrato');
  ok(await call('a', 'POST', `/api/opportunities/${c1.oppId}/move`, { stage_id: won, won: { won_at: T, service_id: svc, contract_type: 'misto', one_time_value: '3000', monthly_value: '500' } }), 'ganho');
  ok(await call('a', 'POST', '/api/payments', { opp_id: c1.oppId, amount: '1500', date: T }), 'recebimento');
  assert.equal((await call('a', 'POST', `/api/opportunities/${c2.oppId}/move`, { stage_id: lost, lost: {} })).status, 400, 'perda exige motivo');
  ok(await call('a', 'POST', `/api/opportunities/${c2.oppId}/move`, { stage_id: lost, lost: { loss_reason_id: boot.loss_reasons[0].id, objection: 'Caro' } }), 'perda');

  const d = ok(await call('a', 'GET', `/api/analytics/dashboard?from=${T}&to=${T}`), 'painel');
  const K = Object.fromEntries(d.kpis.map(k => [k.key, k.value]));
  assert.equal(K.spend, 250); assert.equal(K.leads, 2); assert.equal(K.won, 1); assert.equal(K.lost, 1);
  assert.equal(K.wonOne, 3000); assert.equal(K.wonMonthly, 500); assert.equal(K.revenue, 1500);
  assert.equal(K.cpl, 125); assert.equal(K.cpc_client, 250); assert.equal(K.roas, 6); assert.equal(K.props, 1);
  assert.equal(K.cac, null, 'CAC só com custos cadastrados');
  const cmp = ok(await call('a', 'GET', `/api/analytics/compare?by=hook&from=${T}&to=${T}&view=cohort`), 'compare');
  const h = cmp.rows.find(r => r.label.startsWith('Regularizar depois')); assert.equal(h.leads, 2); assert.equal(h.won, 1);
  const at = ok(await call('a', 'GET', `/api/analytics/attribution?from=${T}&to=${T}`), 'atribuição');
  assert.equal(at.models.first.total_one, 3000); assert.equal(at.models.opp.total_one, 3000);
  // webhook de formulário
  assert.equal((await call('w', 'POST', '/api/webhooks/form', { nome: 'X', telefone: '62911112222' }, { 'X-Webhook-Token': 'errado' })).status, 401, 'token inválido');
  const wf = ok(await call('w', 'POST', '/api/webhooks/form', { nome: 'Lead Site', telefone: '62911112222', utm_source: 'google' }, { 'X-Webhook-Token': 'token-de-teste' }), 'webhook');
  const wf2 = ok(await call('w', 'POST', '/api/webhooks/form', { nome: 'Lead Site', telefone: '(62) 91111-2222' }, { 'X-Webhook-Token': 'token-de-teste' }), 'webhook 2');
  assert.equal(wf.contact_id, wf2.contact_id, 'formulário repetido não duplica contato');
  // demo separado
  ok(await call('a', 'POST', '/api/mode', { mode: 'demo' }), 'modo demo');
  const demoContacts = ok(await call('a', 'GET', '/api/contacts'), 'contatos demo');
  assert.ok(demoContacts.every(c => c.name.includes('fictício')), 'demo só tem dados fictícios');
  ok(await call('a', 'POST', '/api/mode', { mode: 'real' }), 'modo real');
  assert.equal(ok(await call('a', 'GET', '/api/contacts'), 'contatos reais').length, 3, 'dados reais intactos');
  console.log('OK — fluxo completo validado (campanha → conteúdo → lead → oportunidade → venda/perda → indicadores).');
  srv.close(); process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); srv.close(); process.exit(1); });

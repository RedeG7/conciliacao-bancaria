'use strict';
// Dados FICTÍCIOS para o modo demonstração. Ficam em demo.db, separados dos dados reais.
// Nenhum número aqui representa resultados da Real 4U.
const L = require('./logic');

function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

function seed(db) {
  const { auth } = require('./db');
  const r = rng(42);
  const pick = a => a[Math.floor(r() * a.length)];
  const users = auth.prepare("SELECT id, role FROM users WHERE active = 1").all();
  const sellers = users.filter(u => u.role !== 'marketing').map(u => u.id);
  const owners = sellers.length ? sellers : (users.length ? users.map(u => u.id) : [null]);
  const T = L.today();
  const day = n => L.addDays(T, n);
  const iso = d => d + 'T13:00:00.000Z';

  const svcRows = db.prepare('SELECT id, name FROM services').all();
  const svc = new Proxy({}, { get: (_, k) => (svcRows.find(s => s.name.includes(k)) || {}).id || null });
  const src = Object.fromEntries(db.prepare('SELECT id, name FROM sources').all().map(s => [s.name, s.id]));
  const stages = db.prepare('SELECT * FROM stages ORDER BY sort').all();
  const stageBy = m => stages.find(s => s.milestone === m);
  const openStages = stages.filter(s => s.kind === 'open');
  const reasons = db.prepare('SELECT id, name FROM loss_reasons').all();
  const reason = n => reasons.find(x => x.name.startsWith(n)).id;
  const crit = db.prepare('SELECT * FROM qual_criteria').all();

  db.exec('BEGIN');
  try {
    const camp = (name, channel, service, status, s, e, budget, objective, audience) => db.prepare(
      `INSERT INTO campaigns (name, objective, channel, service_id, start_date, end_date, status, budget_planned, audience, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, objective, channel, service, s, e, status, budget, audience, iso(s)).lastInsertRowid;
    const c1 = camp('Exemplo — INSS da obra (Reels patrocinado)', 'Meta Ads', svc['Regularização'], 'ativa', day(-100), day(20), 3000,
      'Gerar reuniões para regularização de obra', 'Proprietários de obra e construtores PF em Goiás');
    const c2 = camp('Exemplo — Google Busca: regularizar obra', 'Google Ads', svc['Regularização'], 'ativa', day(-80), null, 2400,
      'Captar quem já procura regularização', 'Buscas por CNO, SERO, CND de obra');
    const c3 = camp('Exemplo — Holding patrimonial (orgânico)', 'Instagram', svc['Holdings'], 'encerrada', day(-110), day(-20), 0,
      'Educar sobre organização patrimonial', 'Empresários e investidores');
    const c4 = camp('Exemplo — Curso INSS da Obra', 'Meta Ads', svc['Curso'], 'pausada', day(-60), day(-10), 800,
      'Vender turmas do curso', 'Engenheiros, arquitetos e técnicos');

    const cont = (title, channel, format, pub, service, hook, cta, campaign, isAd, theme) => {
      const code = 'demo' + Math.floor(r() * 1e8).toString(36);
      return db.prepare(`INSERT INTO contents (title, theme, url, channel, format, published_at, service_id, hook, cta, campaign_id, is_ad,
        utm_source, utm_medium, utm_campaign, utm_content, short_code, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(title, theme, 'https://exemplo.invalid/' + code, channel, format, pub, service, hook, cta, campaign, isAd,
          channel.toLowerCase(), isAd ? 'cpc' : 'social', 'exemplo', code, code, iso(pub)).lastInsertRowid;
    };
    const k1 = cont('Exemplo — Reels: regularizar depois sai mais caro', 'Instagram', 'Reels', day(-98), svc['Regularização'],
      'Regularizar depois pode sair mais caro do que planejar antes', 'Agende uma reunião', c1, 1, 'INSS da obra');
    const k2 = cont('Exemplo — Reels: o que é aferição no SERO', 'Instagram', 'Reels', day(-70), svc['Regularização'],
      'Você sabe o que acontece na aferição da sua obra?', 'Envie a palavra OBRA', c1, 1, 'INSS da obra');
    const k3 = cont('Exemplo — Anúncio Google: regularização de obra', 'Google', 'Anúncio', day(-80), svc['Regularização'],
      'Regularize sua obra com orientação especializada', 'Fale com nossa equipe', c2, 1, 'INSS da obra');
    const k4 = cont('Exemplo — Carrossel: holding vale a pena?', 'Instagram', 'Carrossel', day(-105), svc['Holdings'],
      'Holding não é só para quem é rico', 'Clique no link da bio', c3, 0, 'Holding');
    const k5 = cont('Exemplo — Stories: aposentadoria e INSS', 'Instagram', 'Stories', day(-50), svc['Regularização'],
      'Tudo sobre o seu INSS', 'Clique no link da bio', c1, 1, 'INSS (tema amplo)');
    const k6 = cont('Exemplo — Reels: curso prático INSS da obra', 'Instagram', 'Reels', day(-58), svc['Curso'],
      'Aprenda a regularizar obras do zero', 'Solicite uma simulação', c4, 1, 'Curso');

    // Métricas diárias (fictícias)
    const metric = db.prepare(`INSERT INTO metrics (ukey, date, campaign_id, content_id, source_id, spend, impressions, reach, clicks, conversations, origin, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'manual',?)`);
    const series = [[c1, k1, -98, 0, 22, src['Meta Ads (Instagram/Facebook pago)']], [c1, k2, -70, 0, 18, src['Meta Ads (Instagram/Facebook pago)']],
      [c1, k5, -50, -20, 25, src['Meta Ads (Instagram/Facebook pago)']], [c2, k3, -80, 0, 28, src['Google Ads']], [c4, k6, -58, -10, 15, src['Meta Ads (Instagram/Facebook pago)']]];
    for (const [cid, kid, from, to, avg, sid] of series) {
      for (let d = from; d <= to; d++) {
        const date = day(d);
        const spend = Math.round((avg * (0.6 + r() * 0.8)) * 100) / 100;
        const imp = Math.round(spend * (55 + r() * 40));
        const clicks = Math.round(imp * (kid === k5 ? 0.03 : 0.012) * (0.6 + r() * 0.8));
        metric.run(`${date}|${cid}|${kid}|${sid}`, date, cid, kid, sid, spend, imp, Math.round(imp * 0.75), clicks,
          Math.round(clicks * (0.05 + r() * 0.08)), iso(date));
      }
    }
    // custos de aquisição não-mídia (fictícios), para demonstrar o CAC completo
    for (let m = 0; m < 4; m++) {
      db.prepare('INSERT INTO other_costs (date, category, description, amount, created_at) VALUES (?,?,?,?,?)')
        .run(day(-30 * m - 5), 'marketing', 'Exemplo — produção de vídeos', 600, iso(day(-30 * m - 5)));
      db.prepare('INSERT INTO other_costs (date, category, description, amount, created_at) VALUES (?,?,?,?,?)')
        .run(day(-30 * m - 5), 'vendas', 'Exemplo — horas do comercial dedicadas a novos leads', 900, iso(day(-30 * m - 5)));
    }

    const first = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Fábio', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Karina', 'Lucas',
      'Mariana', 'Nelson', 'Olívia', 'Paulo', 'Renata', 'Sérgio', 'Tatiane', 'Vinícius'];
    const last = ['Alves', 'Barros', 'Campos', 'Dias', 'Esteves', 'Freitas', 'Gomes', 'Lima', 'Moraes', 'Nunes', 'Prado', 'Rocha'];
    const companies = ['Construtora Fictícia Alfa', 'Incorporadora Exemplo Beta', 'Obras Demo Gama', null, null, 'Engenharia Teste Delta', null];
    const cities = ['Goiânia', 'Aparecida de Goiânia', 'Anápolis', 'Senador Canedo', 'Trindade'];
    const profiles = ['proprietario', 'construtor', 'incorporador', 'engenheiro', 'arquiteto', 'investidor', 'advogado'];

    const routes = [ // [peso, fonte, campanha, conteúdo, serviço, chance qualificar, tipo]
      [18, 'Meta Ads (Instagram/Facebook pago)', c1, k1, 'Regularização', 0.7, 'cliente_potencial'],
      [10, 'Meta Ads (Instagram/Facebook pago)', c1, k2, 'Regularização', 0.6, 'cliente_potencial'],
      [12, 'Meta Ads (Instagram/Facebook pago)', c1, k5, 'Regularização', 0.15, 'cliente_potencial'],
      [12, 'Google Ads', c2, k3, 'Regularização', 0.65, 'cliente_potencial'],
      [6, 'Instagram (orgânico)', c3, k4, 'Holdings', 0.6, 'cliente_potencial'],
      [6, 'Meta Ads (Instagram/Facebook pago)', c4, k6, 'Curso', 0.7, 'interessado_curso'],
      [6, 'Indicação de parceiro', null, null, 'Contabilidade', 0.85, 'cliente_potencial'],
      [3, 'Evento', null, null, 'PTS', 0.6, 'cliente_potencial'],
      [4, 'Contato direto / telefone', null, null, 'Regularização', 0.5, 'cliente_potencial'],
      [3, 'Indicação de cliente', null, null, 'Holdings', 0.8, 'parceiro'],
    ];
    const totalW = routes.reduce((a, x) => a + x[0], 0);
    const pickRoute = () => { let x = r() * totalW; for (const rt of routes) { if ((x -= rt[0]) < 0) return rt; } return routes[0]; };

    const insContact = db.prepare(`INSERT INTO contacts (name, phone, phone_norm, email, email_norm, company, city, kind, profile, decision_maker, captured_at, owner_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insTouch = db.prepare(`INSERT INTO touchpoints (contact_id, occurred_at, type, source_id, campaign_id, content_id, utm_source, utm_medium, utm_campaign, utm_content, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const insOpp = db.prepare(`INSERT INTO opportunities (contact_id, title, service_id, stage_id, owner_id, status, estimated_value, need, difficulty, urgency, budget_range,
      source_id, campaign_id, content_id, next_action, next_action_date, stage_entered_at, qual_answers, qual_status, qualified_at, created_at)
      VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const N = 90;
    for (let i = 0; i < N; i++) {
      const rt = pickRoute();
      const [, sname, cid, kid, sv, qchance, kind] = rt;
      const ago = -Math.floor(r() * 100) - 1;
      const capDate = day(ago);
      const nm = `${pick(first)} ${pick(last)} (fictício)`;
      const phone = '(62) 9' + String(Math.floor(1e7 + r() * 8.9e7)).slice(0, 8).replace(/(\d{4})(\d{4})/, '$1-$2');
      const email = nm.split(' ')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '') + i + '@exemplo.invalid';
      const owner = pick(owners);
      const cId = Number(insContact.run(nm, phone, L.normPhone(phone), email, email, pick(companies), pick(cities), kind, pick(profiles),
        pick(['sim', 'sim', 'nao', 'desconhecido']), capDate, owner, iso(capDate)).lastInsertRowid);
      insTouch.run(cId, capDate, cid ? 'formulario' : 'atendimento', src[sname], cid, kid,
        cid ? sname.split(' ')[0].toLowerCase() : null, cid ? 'cpc' : null, cid ? 'exemplo' : null, null, iso(capDate));
      if (kind === 'parceiro' && r() < 0.6) continue; // nem todo parceiro gera oportunidade

      const qualified = r() < qchance;
      const isRetire = kid === k5 && !qualified;
      const answers = {};
      crit.forEach(c => { answers[c.id] = qualified ? 'sim' : (r() < 0.5 ? 'desconhecido' : 'sim'); });
      if (!qualified && r() < 0.8) answers[crit[1].id] = 'nao';
      const q = L.computeQualification(answers, crit);
      const serviceId = svc[sv];
      const est = sv === 'Curso' ? 890 : sv === 'Contabilidade' ? 2500 : sv === 'Holdings' ? 9000 : sv === 'PTS' ? 12000 : 3500 + Math.round(r() * 6) * 500;
      const oId = insOpp.run(cId, null, serviceId, openStages[0].id, owner, est,
        isRetire ? 'Procura aposentadoria (não é INSS de obra)' : pick(['Regularizar obra concluída', 'Emitir CND da obra', 'Organizar patrimônio da família', 'Reduzir carga tributária da construtora', 'Aprender o processo de aferição']),
        pick(['Não sabe por onde começar', 'Recebeu cobrança alta', 'Banco exige documentação', 'Prazo do financiamento', null]),
        pick(['alta', 'media', 'baixa', 'desconhecida']), pick(['Até R$ 5 mil', 'R$ 5 a 15 mil', 'Não informou']),
        src[sname], cid, kid, 'Fazer primeiro contato', L.addDays(capDate, 1), iso(capDate), JSON.stringify(answers), q.status,
        q.status === 'qualificado' ? L.addDays(capDate, 2) : null, iso(capDate)).lastInsertRowid;
      db.prepare('INSERT INTO stage_history (opp_id, from_stage_id, to_stage_id, user_id, at) VALUES (?,?,?,?,?)').run(oId, null, openStages[0].id, owner, iso(capDate));

      // progressão fictícia
      let d = capDate; const step = () => { d = L.addDays(d, 1 + Math.floor(r() * 5)); return d > T ? null : d; };
      const path = [];
      const advance = qualified ? 0.8 : 0.35;
      for (let s = 1; s < openStages.length; s++) {
        if (r() > (s === 1 ? 0.92 : advance)) break;
        if (!qualified && s > 2) break;
        path.push(openStages[s]);
      }
      let ended = false;
      for (const st of path) { const dd = step(); if (!dd) { ended = true; break; } L.moveOpp(db, oId, st.id, owner, {}, iso(dd)); }
      const reached = path.length;
      if (ended) continue;
      const dd = step(); if (!dd) continue;
      const o = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(oId);
      if (qualified && reached >= 5 && r() < 0.55) {
        const type = sv === 'Contabilidade' ? 'mensal' : sv === 'PTS' ? 'misto' : 'unico';
        const w = { won_at: dd, service_id: serviceId, contract_type: type,
          one_time_value: type === 'mensal' ? null : Math.round(est * (0.85 + r() * 0.3)),
          monthly_value: type === 'unico' ? null : (sv === 'PTS' ? 1200 : est), contract_months: type === 'unico' ? null : 12,
          win_factors: pick(['Reunião esclareceu o passo a passo', 'Urgência do financiamento', 'Indicação de confiança', 'Simulação mostrou o caminho']) };
        L.moveOpp(db, oId, stageBy('won').id, owner, { won: w }, iso(dd));
        if (type !== 'mensal') db.prepare('INSERT INTO payments (opp_id, date, amount, note, created_at) VALUES (?,?,?,?,?)')
          .run(oId, L.addDays(dd, 3) > T ? T : L.addDays(dd, 3), Math.round((w.one_time_value || 0) * 0.5), 'Exemplo — entrada (50%)', iso(dd));
        if (type !== 'unico') db.prepare('INSERT INTO payments (opp_id, date, amount, note, created_at) VALUES (?,?,?,?,?)')
          .run(oId, L.addDays(dd, 5) > T ? T : L.addDays(dd, 5), w.monthly_value, 'Exemplo — 1ª mensalidade', iso(dd));
      } else if (r() < (qualified ? 0.35 : 0.75)) {
        const rs = isRetire ? reason('Serviço incompatível') : !qualified ? pick([reason('Serviço incompatível'), reason('Não respondeu'), reason('Sem urgência')])
          : reached >= 5 ? pick([reason('Preço'), reason('Preço'), reason('Escolheu'), reason('Não compreendeu'), reason('Sem orçamento')])
            : pick([reason('Não respondeu'), reason('Sem urgência'), reason('Projeto adiado')]);
        const obj = pick(['Achou o valor alto para o momento', 'Pensava que o contador da empresa já fazia isso', 'Quer resolver só depois da obra', 'Queria só tirar uma dúvida', null]);
        L.moveOpp(db, oId, stageBy('lost').id, owner, { lost: { loss_reason_id: rs, loss_detail: isRetire ? 'Buscava aposentadoria pelo INSS' : null, objection: obj, retake_date: r() < 0.3 ? L.addDays(T, 30) : null, lost_at: dd } }, iso(dd));
      } else {
        // permanece aberta: próxima ação (algumas atrasadas)
        const next = r() < 0.3 ? L.addDays(T, -Math.ceil(r() * 6)) : L.addDays(T, Math.ceil(r() * 7));
        db.prepare('UPDATE opportunities SET next_action = ?, next_action_date = ? WHERE id = ?')
          .run(['Fazer primeiro contato', 'Mandar mensagem de acompanhamento', 'Confirmar informações de qualificação', 'Ligar para confirmar reunião', 'Enviar proposta', 'Retornar sobre a proposta', 'Negociar condições'][Math.min(reached, 6)], r() < 0.12 ? null : next, oId);
        if (o && r() < 0.5) db.prepare('INSERT INTO tasks (opp_id, contact_id, title, due_date, owner_id, created_at) VALUES (?,?,?,?,?,?)')
          .run(oId, cId, 'Exemplo — retornar contato', next, owner, L.nowIso());
      }
      if (reached >= 5 && o) {
        db.prepare('INSERT INTO proposals (opp_id, sent_at, one_time_value, status, created_at) VALUES (?,?,?,?,?)')
          .run(oId, o.proposal_sent_at || dd, est, 'enviada', L.nowIso());
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { seed };

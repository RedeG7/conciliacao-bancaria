'use strict';
/* Configurações: listas editáveis, metas, usuários, logo, auditoria e modo demonstração. */

const MILESTONES = { '': 'Nenhum', first_contact: 'Primeiro contato', meeting_scheduled: 'Reunião agendada', meeting_done: 'Reunião realizada', proposal: 'Proposta enviada' };
const LIST_DEF = {
  servicos: { list: 'services', title: 'Serviços', desc: 'Opções do campo "Serviço" em contatos, oportunidades, campanhas e conteúdos. Arquive os que deixarem de ser oferecidos — o histórico é preservado.', cols: [['description', 'Descrição', 'text']] },
  etapas: { list: 'stages', title: 'Etapas do funil', desc: 'Renomeie, reordene, crie ou arquive etapas. "Marco" indica qual data é registrada automaticamente quando a oportunidade entra na etapa (usado nos indicadores de reuniões e propostas). As etapas de ganho e perda são fixas.', cols: [['milestone', 'Marco registrado', 'milestone']] },
  perdas: { list: 'loss_reasons', title: 'Motivos de perda', desc: 'Motivos disponíveis ao marcar uma oportunidade como perdida.', cols: [] },
  origens: { list: 'sources', title: 'Origens', desc: 'De onde os contatos chegam. Inclua indicação, evento e contato direto. Dados desconhecidos aparecem como "Não identificado".', cols: [['kind', 'Tipo', 'sourceKind']] },
  ctas: { list: 'ctas', title: 'CTAs', desc: 'Sugestões do campo CTA nos conteúdos (o campo também aceita texto livre).', cols: [] },
  qualificacao: { list: 'qual_criteria', title: 'Critérios de qualificação', desc: 'Obrigatórios: todos "Sim" → Qualificado; algum "Não" → Não qualificado; algum "Desconhecido" → Em análise. Complementares aparecem na ficha mas não decidem a classificação. O comercial pode ajustar manualmente com justificativa.', cols: [['help', 'Orientação', 'text'], ['required', 'Obrigatório', 'bool']] },
};

route('/configuracoes', (main) => go('#/configuracoes/servicos'));
route('/configuracoes/:tab', async (main, p, alive) => {
  const admin = can('admin');
  const tabs = [['servicos', 'Serviços'], ['etapas', 'Etapas do funil'], ['perdas', 'Motivos de perda'], ['origens', 'Origens'], ['ctas', 'CTAs'], ['qualificacao', 'Qualificação'], ['metas', 'Metas'],
    ...(admin ? [['usuarios', 'Usuários e perfis'], ['logo', 'Logo'], ['auditoria', 'Registro de alterações']] : []), ['demo', 'Modo demonstração']];
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Configurações</h1><p>${admin ? 'Somente administradores alteram listas, metas e usuários.' : 'Visualização. Alterações são feitas pelo administrador.'}</p></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/configuracoes/${k}" class="${p.tab === k ? 'on' : ''}">${l}</a>`).join('')}</div><div id="cfg"></div>`;
  const box = $('#cfg', main);
  S.refreshPage = null;
  if (LIST_DEF[p.tab]) return listEditor(box, LIST_DEF[p.tab], admin);
  if (p.tab === 'metas') return goalsEditor(box, admin, alive);
  if (p.tab === 'usuarios' && admin) return usersEditor(box);
  if (p.tab === 'logo' && admin) return logoEditor(box);
  if (p.tab === 'auditoria' && admin) return auditView(box);
  if (p.tab === 'demo') return demoView(box, admin);
  box.innerHTML = '<div class="empty">Seção indisponível.</div>';
});

function listEditor(box, def, admin) {
  const items = (S.boot[def.list] || []).slice().sort((a, b) => a.sort - b.sort || a.id - b.id);
  const cell = (it, [key, , type]) => {
    if (type === 'bool') return `<input type="checkbox" data-k="${key}" ${it[key] ? 'checked' : ''} ${admin ? '' : 'disabled'}>`;
    if (type === 'milestone') return it.kind !== 'open' ? `<span class="chip ${it.kind === 'won' ? 'green' : 'red'}">${it.kind === 'won' ? 'Ganho' : 'Perda'}</span>` : `<select class="input" data-k="${key}" ${admin ? '' : 'disabled'}>${mapOpts(MILESTONES, it[key] || '')}</select>`;
    if (type === 'sourceKind') return `<select class="input" data-k="${key}" ${admin ? '' : 'disabled'}>${mapOpts(LBL.sourceKind, it[key] || 'outro')}</select>`;
    return `<input class="input" data-k="${key}" value="${esc(it[key] || '')}" ${admin ? '' : 'disabled'}>`;
  };
  const isStages = def.list === 'stages';
  box.innerHTML = `<div class="card"><div class="card-head"><h2>${def.title}</h2><span class="sub">${def.desc}</span></div><div class="table-wrap"><table class="t"><thead><tr>${isStages && admin ? '<th>Ordem</th>' : ''}<th>Nome</th>${def.cols.map(c => `<th>${c[1]}</th>`).join('')}<th>Situação</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
    ${items.map((it, i) => `<tr data-id="${it.id}" ${it.archived ? 'style="opacity:.6"' : ''}>${isStages && admin ? `<td class="nowrap">${it.kind === 'open' ? `<button class="btn sm" data-mv="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button> <button class="btn sm" data-mv="1" ${!items[i + 1] || items[i + 1].kind !== 'open' ? 'disabled' : ''} aria-label="Descer">↓</button>` : ''}</td>` : ''}
      <td><input class="input" data-k="name" value="${esc(it.name)}" ${admin ? '' : 'disabled'}></td>${def.cols.map(c => `<td>${cell(it, c)}</td>`).join('')}
      <td>${it.archived ? '<span class="chip">Arquivado</span>' : '<span class="chip green">Ativo</span>'}</td>
      ${admin ? `<td class="nowrap right"><button class="btn sm primary" data-save>Salvar</button> ${!(isStages && it.kind !== 'open') ? `<button class="btn sm" data-arch>${it.archived ? 'Reativar' : 'Arquivar'}</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>
    ${admin ? `<div class="card-body"><div class="actions"><input class="input" id="new-name" placeholder="Nome do novo item" style="max-width:360px"><button class="btn primary" id="add">Adicionar</button></div>${isStages ? '<p class="small muted">Novas etapas entram antes das etapas de fechamento; use as setas para posicionar.</p>' : ''}</div>` : ''}</div>`;
  if (!admin) return;
  const reload = async () => { await refreshBoot(); listEditor(box, def, admin); };
  $$('tr[data-id]', box).forEach(tr => {
    const id = Number(tr.dataset.id); const it = items.find(x => x.id === id);
    const save = async extra => {
      const v = {}; $$('[data-k]', tr).forEach(el => { v[el.dataset.k] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value; });
      try { await PUT(`/api/lists/${def.list}/${id}`, Object.assign(v, extra || {})); toast('Salvo.'); reload(); } catch (e) { fail(e); }
    };
    const sb = $('[data-save]', tr); if (sb) sb.onclick = () => save();
    const ab = $('[data-arch]', tr); if (ab) ab.onclick = () => save({ archived: it.archived ? 0 : 1 });
    $$('[data-mv]', tr).forEach(b => { b.onclick = async () => {
      const open = items.filter(x => x.kind === 'open'); const idx = open.findIndex(x => x.id === id); const j = idx + Number(b.dataset.mv);
      [open[idx], open[j]] = [open[j], open[idx]]; await POST('/api/lists/stages/reorder', { ids: open.map(x => x.id) }).catch(fail); reload();
    }; });
  });
  $('#add', box).onclick = async () => { const name = $('#new-name', box).value.trim(); if (!name) return; try { await POST(`/api/lists/${def.list}`, { name }); toast('Adicionado.'); reload(); } catch (e) { fail(e); } };
}

async function goalsEditor(box, admin, alive) {
  const list = await GET('/api/goals'); if (!alive()) return;
  const money = m => ['valor_unico', 'mensalidade', 'receita'].includes(m);
  box.innerHTML = `<div class="card"><div class="card-head"><h2>Metas por período e serviço</h2><span class="sub">Nenhuma meta é pré-definida. Cadastre os alvos que a Real 4U decidir; o realizado é calculado pelos registros.</span>${admin ? '<button class="btn primary sm" id="addg" style="margin-left:auto">+ Nova meta</button>' : ''}</div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Meta</th><th>Indicador</th><th>Serviço</th><th>Período</th><th class="num">Alvo</th><th class="num">Realizado</th><th>Progresso</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
    ${list.map(g => { const pct = g.target ? g.actual / g.target * 100 : null; return `<tr><td><b>${esc(g.name || '—')}</b></td><td>${esc(g.metric_label)}</td><td>${esc(g.service_id ? (byId('services', g.service_id) || {}).name : 'Todos')}</td><td class="nowrap">${F.date(g.period_start)} a ${F.date(g.period_end)}</td>
      <td class="num">${money(g.metric) ? F.brl(g.target) : F.int(g.target)}</td><td class="num">${money(g.metric) ? F.brl(g.actual) : F.int(g.actual)}</td><td style="min-width:140px"><div class="progress"><div style="width:${Math.min(100, pct || 0)}%;background:${pct >= 100 ? 'var(--green)' : 'var(--orange)'}"></div></div><span class="small">${F.pct(pct)}</span></td>
      ${admin ? `<td><button class="btn sm danger" data-del="${g.id}">Excluir</button></td>` : ''}</tr>`; }).join('') || `<tr><td colspan="8" class="empty">Nenhuma meta cadastrada.</td></tr>`}</tbody></table></div></div>`;
  if (!admin) return;
  $('#addg', box).onclick = () => { const P = periodPresets().mes; formModal({ title: 'Nova meta', fields: [
    { name: 'name', label: 'Nome (opcional)', full: true }, { name: 'metric', label: 'Indicador', type: 'select', required: true, full: true, options: mapOpts(S.boot.goalMetrics, 'leads') },
    { name: 'service_id', label: 'Serviço', type: 'select', options: opts(listOf('services'), '', { empty: 'Todos os serviços' }) }, { name: 'target', label: 'Alvo', type: 'money', required: true, placeholder: '' },
    { name: 'period_start', label: 'Início do período', type: 'date', required: true, value: P[1] }, { name: 'period_end', label: 'Fim do período', type: 'date', required: true, value: addDays(addDays(P[1].slice(0, 8) + '28', 4).slice(0, 8) + '01', -1) }],
  onSubmit: async v => { await POST('/api/goals', v); goalsEditor(box, admin, alive); } }); };
  $$('[data-del]', box).forEach(b => { b.onclick = async () => { if (await confirmDlg('Excluir esta meta?', { danger: true, ok: 'Excluir' })) { await DEL('/api/goals/' + b.dataset.del).catch(fail); goalsEditor(box, admin, alive); } }; });
}

async function usersEditor(box) {
  const users = await GET('/api/users');
  box.innerHTML = `<div class="card"><div class="card-head"><h2>Usuários e perfis</h2><button class="btn primary sm" id="addu" style="margin-left:auto">+ Novo usuário</button></div>
    <div class="card-body small muted"><b>Administrador:</b> tudo, incluindo usuários, listas, metas, logo e registro de alterações. <b>Marketing:</b> campanhas, conteúdos, métricas, custos e cadastro de leads; visualiza o funil sem mover etapas. <b>Comercial:</b> contatos, oportunidades, etapas, propostas, vendas, perdas, recebimentos e tarefas; visualiza campanhas e conteúdos.</div>
    <table class="t"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${esc(LBL.role[u.role])}</td><td>${u.active ? '<span class="chip green">Ativo</span>' : '<span class="chip">Inativo</span>'}</td><td class="right"><button class="btn sm" data-ed="${u.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#addu', box).onclick = () => formModal({ title: 'Novo usuário', fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'email', label: 'E-mail', type: 'email', required: true }, { name: 'role', label: 'Perfil', type: 'select', options: mapOpts(LBL.role, 'comercial') }, { name: 'password', label: 'Senha provisória (mín. 8)', type: 'text', required: true, help: 'O usuário deverá trocá-la no primeiro acesso.' }],
    onSubmit: async v => { await POST('/api/users', v); await refreshBoot(); usersEditor(box); } });
  $$('[data-ed]', box).forEach(b => { b.onclick = () => { const u = users.find(x => x.id === Number(b.dataset.ed)); formModal({ title: 'Editar usuário', values: u, fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'role', label: 'Perfil', type: 'select', options: mapOpts(LBL.role, u.role) }, { name: 'active', label: 'Ativo', type: 'checkbox', value: !!u.active }, { name: 'password', label: 'Redefinir senha (opcional)', help: 'Deixe em branco para manter.' }],
    onSubmit: async v => { await PUT('/api/users/' + u.id, Object.assign(v, { active: v.active ? 1 : 0 })); await refreshBoot(); usersEditor(box); } }); }; });
}

function logoEditor(box) {
  box.innerHTML = `<div class="card"><div class="card-head"><h2>Logo oficial</h2></div><div class="card-body">
    <p>Envie o arquivo oficial da logo (bússola + REAL 4U). Ele é exibido exatamente como enviado — proporções, desenho e cores preservados — no menu lateral e na tela de entrada. Prefira SVG ou PNG com fundo transparente, em versão clara para fundo azul-marinho.</p>
    <div style="background:var(--navy);padding:18px;border-radius:10px;max-width:320px;min-height:80px;display:flex;align-items:center">${S.boot.hasLogo ? `<img src="/api/logo?v=${Date.now()}" alt="Logo atual" style="max-width:100%;max-height:60px;object-fit:contain">` : `<span style="color:#fff;font-weight:800;font-size:20px">${esc(officeLabel())}</span> <span class="small" style="color:#9fb0dc;margin-left:8px">(nome do escritório, até enviar a logo)</span>`}</div>
    <div class="actions mt"><input type="file" id="logo-f" accept="image/png,image/jpeg,image/svg+xml,image/webp">${S.boot.hasLogo ? '<button class="btn danger" id="logo-del">Remover logo</button>' : ''}</div></div></div>`;
  $('#logo-f', box).onchange = e => { const file = e.target.files[0]; if (!file) return; if (file.size > 3e6) return toast('Arquivo acima de 3 MB.', { err: true });
    const fr = new FileReader(); fr.onload = async () => { try { await POST('/api/logo', { dataUrl: fr.result }); S.logoV = Date.now(); await refreshBoot(); shell(); render(); toast('Logo atualizada.'); } catch (x) { fail(x); } }; fr.readAsDataURL(file); };
  if ($('#logo-del', box)) $('#logo-del', box).onclick = async () => { await DEL('/api/logo'); await refreshBoot(); shell(); render(); };
}

async function auditView(box) {
  const rows = await GET('/api/audit');
  box.innerHTML = `<div class="card"><div class="card-head"><h2>Registro de alterações</h2><span class="sub">últimos 500 eventos ${S.mode === 'demo' ? 'do modo demonstração' : 'dos dados reais'}</span><button class="btn sm" style="margin-left:auto" data-download="/api/export/auditoria">${icon('download')}Exportar</button></div>
    <div class="table-wrap" style="max-height:65vh"><table class="t"><thead><tr><th>Data/hora</th><th>Usuário</th><th>Ação</th><th>Item</th><th>Detalhes</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="nowrap">${F.dt(r.at)}</td><td>${esc(r.user_name || '')}</td><td>${esc(r.action)}</td><td class="small">${esc(r.entity || '')} ${r.entity_id ? '#' + r.entity_id : ''}</td><td class="small" style="max-width:420px;word-break:break-word">${esc((r.details || '').slice(0, 300))}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function demoView(box, admin) {
  box.innerHTML = `<div class="card"><div class="card-head"><h2>Modo demonstração</h2>${S.mode === 'demo' ? '<span class="chip amber">Ativo nesta sessão</span>' : ''}</div><div class="card-body">
    <p>O modo demonstração usa um banco de dados separado, com contatos, campanhas e resultados <b>fictícios</b> (marcados com "Exemplo" e "(fictício)"). Serve para treinar a equipe e conhecer os relatórios. Nada do que é feito nele afeta os dados reais, e nenhum número da demonstração representa resultados da Real 4U.</p>
    <div class="actions"><button class="btn ${S.mode === 'demo' ? '' : 'primary'}" id="toggle">${S.mode === 'demo' ? 'Voltar aos dados reais' : 'Abrir modo demonstração'}</button>
    ${admin && S.mode === 'demo' ? '<button class="btn danger" id="reset">Recriar dados fictícios</button>' : ''}</div></div></div>`;
  $('#toggle', box).onclick = () => switchMode(S.mode === 'demo' ? 'real' : 'demo');
  if ($('#reset', box)) $('#reset', box).onclick = async () => { if (await confirmDlg('Apagar e recriar todos os dados fictícios da demonstração?', { danger: true, ok: 'Recriar' })) { await POST('/api/demo/reset'); await refreshBoot(); render(); toast('Dados de demonstração recriados.'); } };
}

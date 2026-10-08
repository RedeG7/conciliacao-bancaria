'use strict';
/* Estrutura do aplicativo: login, menu lateral, barra superior, pesquisa, alertas e modo demonstração. */

function brandHtml(dark = true) {
  // Espaço reservado para a logo oficial. Enquanto não for enviada, aparece apenas o nome "Real 4U".
  if (S.boot && S.boot.hasLogo || S.hasLogo) return `<img src="/api/logo?v=${S.logoV || 0}" alt="Real 4U">`;
  return `<div class="wordmark" style="color:${dark ? '#fff' : 'var(--navy)'}">Real 4U</div>`;
}

async function refreshBoot() { S.boot = await GET('/api/bootstrap'); S.hasLogo = S.boot.hasLogo; }

function showLogin() {
  S.me = null;
  fetch('/api/logo', { method: 'HEAD' }).then(r => { S.hasLogo = r.ok; renderLogin(); }).catch(renderLogin);
}
async function renderLogin() {
  let needsSetup = false; try { needsSetup = (await GET('/api/setup-status')).needsSetup; } catch (e) { /* */ }
  $('#root').innerHTML = `<div class="login">
    <div class="side"><div><div class="brand-slot">${brandHtml(true)}</div><div class="accent"></div>
      <p>Marketing e comercial em um só lugar: de onde vêm os contatos, quais conteúdos geram oportunidades qualificadas e o que acontece até o fechamento.</p></div>
      <p class="small" style="color:#8193c4">Real 4U Contabilidade e Consultoria</p></div>
    <div class="panel">${needsSetup ? `
      <form id="setup"><h1>Primeiro acesso</h1><p class="muted">Crie o usuário administrador. Depois ele poderá cadastrar a equipe de marketing e comercial.</p>
        <label class="f">Nome<input name="name" required autocomplete="name"></label>
        <label class="f">E-mail<input name="email" type="email" required autocomplete="email"></label>
        <label class="f">Senha (mín. 8 caracteres)<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
        <p class="err-msg"></p><button class="btn primary" type="submit">Criar administrador</button></form>` : `
      <form id="login"><h1>Entrar</h1><p class="muted">Use o e-mail e a senha cadastrados pelo administrador.</p>
        <label class="f">E-mail<input name="email" type="email" required autocomplete="username"></label>
        <label class="f">Senha<input name="password" type="password" required autocomplete="current-password"></label>
        <p class="err-msg"></p><button class="btn primary" type="submit">Entrar</button></form>`}</div></div>`;
  const form = $('#login') || $('#setup');
  form.querySelector('input').focus();
  form.onsubmit = async e => {
    e.preventDefault(); const v = readForm(form); const err = form.querySelector('.err-msg'); err.textContent = '';
    try {
      if (form.id === 'setup') { await POST('/api/setup', v); }
      await POST('/api/login', { email: v.email, password: v.password });
      boot();
    } catch (x) { err.textContent = x.message; }
  };
}

async function boot() {
  try { S.me = await GET('/api/me'); } catch (e) { return showLogin(); }
  S.mode = S.me.mode;
  await refreshBoot();
  shell();
  if (S.me.user.must_change) setTimeout(() => changePassword(true), 300);
  render(); refreshAlerts();
}

function shell() {
  const u = S.me.user;
  const nav = (href, ic, label, extra = '') => `<a href="${href}">${icon(ic)}<span>${label}</span>${extra}</a>`;
  $('#root').innerHTML = `<div class="app">
    <aside class="sidebar" aria-label="Menu principal">
      <div class="brand">${brandHtml(true)}<div class="sub">Marketing &amp; Comercial</div></div>
      <nav class="nav">
        ${nav('#/painel', 'dash', 'Painel')}
        <div class="group">Comercial</div>
        ${nav('#/funil', 'funnel', 'Funil comercial')}
        ${nav('#/contatos', 'users', 'Contatos')}
        ${nav('#/tarefas', 'task', 'Tarefas', '<span class="badge hidden" id="nav-tasks"></span>')}
        <div class="group">Marketing</div>
        ${nav('#/campanhas', 'megaphone', 'Campanhas')}
        ${nav('#/conteudos', 'content', 'Conteúdos, ganchos e CTAs')}
        <div class="group">Análise</div>
        ${nav('#/analises', 'chart', 'Comparações e perdas')}
        ${nav('#/melhorar', 'bulb', 'O que melhorar')}
        <div class="group">Sistema</div>
        ${nav('#/integracoes', 'plug', 'Integrações')}
        ${nav('#/configuracoes', 'gear', 'Configurações')}
      </nav>
      <div class="foot">Perfil: ${esc(LBL.role[u.role])}<br>Dados ${S.mode === 'demo' ? '<b style="color:#ffb27a">FICTÍCIOS (demo)</b>' : 'reais'}</div>
    </aside>
    <div class="main">
      ${S.mode === 'demo' ? `<div class="demo-banner" role="alert">MODO DEMONSTRAÇÃO — todos os dados exibidos são fictícios e ficam separados dos dados reais. <button class="btn sm" id="leave-demo">Voltar aos dados reais</button></div>` : ''}
      <header class="topbar">
        <button class="icon-btn menu-btn" id="menu-btn" aria-label="Abrir menu">${icon('menu')}</button>
        <div class="search">${icon('search')}<input id="gsearch" placeholder="Pesquisar contato, telefone, e-mail, empresa, campanha ou conteúdo…" autocomplete="off" aria-label="Pesquisa global"><div class="search-results hidden" id="gsearch-res"></div></div>
        <div class="top-actions">
          <button class="btn primary" id="quick-add">${icon('plus')}<span>Novo lead</span></button>
          <button class="icon-btn" id="alerts-btn" aria-label="Alertas">${icon('bell')}<span class="dot hidden" id="alerts-dot"></span></button>
          <div class="user-chip" id="user-btn" tabindex="0"><span class="avatar">${esc(initials(u.name))}</span><span class="who"><b>${esc(u.name)}</b>${esc(LBL.role[u.role])}</span></div>
        </div>
      </header>
      <main class="content" id="content"></main>
    </div></div>`;
  $('#menu-btn').onclick = () => $('.sidebar').classList.toggle('open');
  $('#quick-add').onclick = () => newContactModal();
  $('#alerts-btn').onclick = showAlerts;
  $('#user-btn').onclick = userMenu;
  if ($('#leave-demo')) $('#leave-demo').onclick = () => switchMode('real');
  setupSearch();
}

async function switchMode(mode) {
  await POST('/api/mode', { mode });
  S.mode = mode; await refreshBoot(); shell(); render(); refreshAlerts();
  toast(mode === 'demo' ? 'Modo demonstração: dados fictícios.' : 'Dados reais.');
}

function userMenu(e) {
  closeDropdowns();
  const r = $('#user-btn').getBoundingClientRect();
  const dd = document.createElement('div'); dd.className = 'dropdown'; dd.style.top = (r.bottom + 6) + 'px'; dd.style.right = (innerWidth - r.right) + 'px'; dd.style.position = 'fixed';
  dd.innerHTML = `<div class="small muted" style="padding:6px 10px">${esc(S.me.user.email)}</div><hr>
    <button data-a="mode">${S.mode === 'demo' ? 'Voltar aos dados reais' : 'Abrir modo demonstração (dados fictícios)'}</button>
    <button data-a="pass">Alterar minha senha</button><hr><button data-a="out">Sair</button>`;
  document.body.appendChild(dd); e.stopPropagation();
  dd.onclick = async ev => {
    const a = ev.target.dataset.a; dd.remove();
    if (a === 'mode') switchMode(S.mode === 'demo' ? 'real' : 'demo');
    if (a === 'pass') changePassword();
    if (a === 'out') { await POST('/api/logout'); showLogin(); }
  };
}
function closeDropdowns() { $$('.dropdown').forEach(d => d.remove()); }
document.addEventListener('click', e => { if (!e.target.closest('.dropdown')) closeDropdowns(); if (!e.target.closest('.search')) { const r = $('#gsearch-res'); r && r.classList.add('hidden'); } });

function changePassword(forced) {
  formModal({ title: forced ? 'Defina uma nova senha' : 'Alterar senha', intro: forced ? H`<p class="callout">Sua senha foi definida pelo administrador. Escolha uma senha pessoal.</p><br>` : '',
    fields: [{ name: 'current', label: 'Senha atual', type: 'password', required: true, full: true }, { name: 'password', label: 'Nova senha (mín. 8 caracteres)', type: 'password', required: true, full: true }],
    onSubmit: async v => { await POST('/api/me/password', v); toast('Senha alterada.'); } });
}

// ---------- pesquisa global ----------
function setupSearch() {
  const inp = $('#gsearch'); const box = $('#gsearch-res'); let timer; let items = []; let sel = -1;
  const open = it => { box.classList.add('hidden'); inp.value = '';
    if (it.type === 'contato') openContact(it.id); else if (it.type === 'campanha') go('#/campanhas/' + it.id); else go('#/conteudos?id=' + it.id); };
  inp.oninput = () => { clearTimeout(timer); timer = setTimeout(async () => {
    const q = inp.value.trim(); if (q.length < 2) { box.classList.add('hidden'); return; }
    items = await GET('/api/search?' + qs({ q })); sel = -1;
    box.innerHTML = items.length ? items.map((it, i) => `<div class="item" data-i="${i}"><div class="type">${esc(it.type)}</div><b>${esc(it.label)}</b><div class="small muted">${esc(it.sub || '')}</div></div>`).join('') : '<div class="item muted">Nada encontrado.</div>';
    box.classList.remove('hidden');
  }, 220); };
  box.onclick = e => { const el = e.target.closest('[data-i]'); if (el) open(items[Number(el.dataset.i)]); };
  inp.onkeydown = e => {
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; $$('.item', box).forEach((x, i) => x.classList.toggle('sel', i === sel)); }
    if (e.key === 'Enter' && sel >= 0) open(items[sel]);
    if (e.key === 'Escape') box.classList.add('hidden');
  };
}

// ---------- alertas ----------
async function refreshAlerts() {
  try {
    const a = await GET('/api/alerts'); S.alerts = a;
    const n = a.noAttend.length + a.propNoReturn.length + a.overdueNext.length + a.overdueTasks.length;
    const dot = $('#alerts-dot'); if (dot) { dot.textContent = n; dot.classList.toggle('hidden', !n); }
    const mine = a.overdueTasks.filter(t => t.owner_id === S.me.user.id).length; const b = $('#nav-tasks');
    if (b) { b.textContent = mine; b.classList.toggle('hidden', !mine); b.title = 'Suas tarefas atrasadas'; }
  } catch (e) { /* */ }
}
function showAlerts() {
  const a = S.alerts || { noAttend: [], propNoReturn: [], overdueNext: [], overdueTasks: [], noNext: [], retakeDue: [] };
  const sec = (title, list, desc, cls = 'red') => `<div class="card mb"><div class="card-head"><h3>${esc(title)}</h3><span class="chip ${list.length ? cls : ''}">${list.length}</span><span class="sub">${esc(desc)}</span></div>
    ${list.length ? recordsTable(list.slice(0, 50)) : '<div class="empty">Nenhum item.</div>'}</div>`;
  const tasks = `<div class="card mb"><div class="card-head"><h3>Tarefas atrasadas</h3><span class="chip ${a.overdueTasks.length ? 'red' : ''}">${a.overdueTasks.length}</span></div>
    ${a.overdueTasks.length ? `<table class="t"><tbody>${a.overdueTasks.slice(0, 50).map(t => `<tr class="click" ${t.contact_id ? `data-open-contact="${t.contact_id}" ${t.opp_id ? `data-opp="${t.opp_id}"` : ''}` : 'data-go="#/tarefas"'}><td><span class="chip red">Atrasada</span> ${esc(t.title)}</td><td>${esc(t.name || '')}</td><td>${F.date(t.due_date)}</td><td>${esc(userName(t.owner_id))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhuma tarefa atrasada.</div>'}</div>`;
  const m = modal({ title: 'Alertas de acompanhamento', size: 'wide', body: raw(
    sec('Leads sem atendimento', a.noAttend, 'Na primeira etapa há mais de 24 h, sem primeiro contato.') +
    sec('Propostas sem retorno agendado', a.propNoReturn, 'Proposta enviada e sem próxima ação válida.') +
    sec('Próximas ações vencidas', a.overdueNext, 'Prazo da próxima ação já passou.') + tasks +
    sec('Sem próxima ação definida', a.noNext, 'Toda oportunidade precisa de responsável, etapa e próxima ação.', 'amber') +
    sec('Retomadas previstas (próximos 7 dias)', a.retakeDue, 'Oportunidades perdidas com data de retomada.', 'blue')) });
  m.el.addEventListener('click', e => { if (e.target.closest('[data-open-contact],[data-go]')) m.close(); });
}

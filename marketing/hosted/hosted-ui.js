'use strict';
/* Ajustes da interface para a versão hospedada no Claude (carregado depois de app.js e antes da inicialização). */
(function () {
  const R = window.R4U;
  // chamadas à API vão para o servidor que roda nesta página
  api = async function (method, url, body) {
    const r = await R.request(method, url, body);
    if (r.status >= 400) {
      const d = r.body && typeof r.body === 'object' ? r.body : null;
      const e = new Error((d && d.error) || 'Falha ao processar a solicitação.'); e.status = r.status; e.data = d; throw e;
    }
    return r.body;
  };
  // exportações: o arquivo é entregue pelo próprio Claude (o navegador pede confirmação)
  download = async function (path) {
    try {
      const r = await R.request('GET', path);
      if (r.status >= 400) throw new Error((r.body && r.body.error) || 'Falha ao exportar.');
      const name = ((r.headers['content-disposition'] || '').match(/filename="([^"]+)"/) || [])[1] || 'real4u.csv';
      const dl = window.claude ? await window.claude.use('downloads') : null;
      if (!dl) throw new Error('O download não está disponível nesta visualização.');
      await dl.save({ filename: name, data: String(r.body) });
      toast('Arquivo pronto: ' + name);
    } catch (e) { if (!e || e.code !== 'cancelled') fail(e); }
  };
  brandHtml = function (dark = true) {
    if (R.logo) return `<img src="${esc(R.logo)}" alt="Real 4U">`;
    return `<div class="wordmark" style="color:${dark ? '#fff' : 'var(--navy)'}">Real 4U</div>`;
  };
  const baseRefresh = refreshBoot;
  refreshBoot = async function () { await baseRefresh(); S.boot.hasLogo = !!R.logo; };
  showLogin = function () {
    $('#root').innerHTML = `<div class="login"><div class="side"><div>${brandHtml(true)}<div class="accent"></div><p>Marketing e comercial em um só lugar.</p></div><span></span></div>
      <div class="panel"><div style="max-width:420px"><h1>Acesso pela conta do Claude</h1><p class="muted">Abra este sistema pelo link compartilhado, entrando com sua conta do Claude. Se o problema continuar, peça ao administrador para conferir o compartilhamento.</p></div></div></div>`;
  };
  changePassword = function () { toast('O acesso é feito pela sua conta do Claude; não há senha neste sistema.'); };
  userMenu = function (e) {
    closeDropdowns();
    const r = $('#user-btn').getBoundingClientRect();
    const dd = document.createElement('div'); dd.className = 'dropdown'; dd.style.top = (r.bottom + 6) + 'px'; dd.style.right = (innerWidth - r.right) + 'px'; dd.style.position = 'fixed';
    dd.innerHTML = `<div class="small muted" style="padding:6px 10px">Conectado pela conta do Claude</div><hr>
      ${R.error ? '' : `<button data-a="mode">${S.mode === 'demo' ? 'Voltar aos dados reais' : 'Abrir modo demonstração (dados fictícios)'}</button>`}`;
    document.body.appendChild(dd); e.stopPropagation();
    dd.onclick = ev => { const a = ev.target.dataset.a; dd.remove(); if (a === 'mode') switchMode(S.mode === 'demo' ? 'real' : 'demo'); };
  };
  // usuários: pessoas que abriram o sistema pelo compartilhamento do Claude
  usersEditor = async function (box) {
    const users = await GET('/api/users');
    box.innerHTML = `<div class="card"><div class="card-head"><h2>Usuários e perfis</h2></div>
      <div class="card-body small"><p style="margin-top:0"><b>Como adicionar alguém:</b> use o botão <b>Compartilhar</b> do Claude neste sistema e convide a pessoa como <b>Colaborador</b> (Contributor). Ela aparece nesta lista depois de abrir o link pela primeira vez. Quem for convidado só como Leitor consegue ver, mas não salvar.</p>
      <p class="muted">Perfis: <b>Administrador</b> altera listas, metas, perfis e logo; <b>Marketing</b> cuida de campanhas, conteúdos e métricas e não move etapas do funil; <b>Comercial</b> move oportunidades, registra propostas, vendas e perdas. Quem chega sem perfil definido entra como Comercial. Os perfis organizam a rotina dentro do sistema; quem pode ver ou editar os dados é definido pelo compartilhamento do Claude.</p></div>
      <table class="t"><thead><tr><th>Nome</th><th>Perfil</th><th>Situação</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td><b>${esc(u.name)}</b>${u.id === S.me.user.id ? ' <span class="chip">você</span>' : ''}</td><td><select class="input" data-role="${u.id}" style="width:auto">${mapOpts(LBL.role, u.role)}</select></td>
        <td><label class="f check"><input type="checkbox" data-active="${u.id}" ${u.active ? 'checked' : ''}> Ativo</label></td><td class="right"><button class="btn sm primary" data-save="${u.id}">Salvar</button></td></tr>`).join('')}</tbody></table></div>`;
    $$('[data-save]', box).forEach(b => { b.onclick = async () => {
      const id = b.dataset.save;
      try { await PUT('/api/users/' + id, { role: $(`[data-role="${id}"]`, box).value, active: $(`[data-active="${id}"]`, box).checked ? 1 : 0 }); await refreshBoot(); toast('Perfil salvo.'); usersEditor(box); } catch (e) { fail(e); }
    }; });
  };
  const baseLogo = logoEditor;
  logoEditor = function (box) {
    baseLogo(box);
    const img = box.querySelector('img'); if (img && R.logo) img.src = R.logo;
    const f = $('#logo-f', box); if (f) f.onchange = e => { const file = e.target.files[0]; if (!file) return;
      const fr = new FileReader(); fr.onload = async () => { try { await POST('/api/logo', { dataUrl: fr.result }); await refreshBoot(); shell(); render(); toast('Logo atualizada.'); } catch (x) { fail(x); } }; fr.readAsDataURL(file); };
    const p = box.querySelector('.card-body p'); if (p) p.insertAdjacentHTML('beforeend', ' Nesta versão o arquivo deve ter até cerca de 170 KB (SVG costuma ser o menor).');
  };
  linksModal = function (k) {
    modal({ title: 'Links de ' + k.title, body: raw(`<p><b>Link com UTMs</b></p>${k.tracked_url ? `<div class="copy-row"><code class="inline">${esc(k.tracked_url)}</code><button class="btn sm" data-copy="${esc(k.tracked_url)}">Copiar</button></div>` : '<p class="muted">Informe o link de destino no cadastro do conteúdo.</p>'}
      <p class="small muted mt-s">Use este link no conteúdo ou anúncio. Os cliques são contados pelas plataformas (Meta, Google, Instagram) e entram aqui pela importação ou pelo registro manual de métricas. O link curto com contagem própria exige a versão com servidor.</p>`),
      onMount: m => $$('[data-copy]', m.el).forEach(b => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copiado.')).catch(() => toast('Selecione o texto e copie manualmente.', { err: true })); }) });
  };
  const baseShell = shell;
  shell = function () {
    baseShell();
    if (R.error) $('.main').insertAdjacentHTML('afterbegin', '<div class="demo-banner" role="alert">Não foi possível acessar o banco de dados compartilhado (abra pelo link do Claude, com sua conta). Exibindo apenas a demonstração com dados fictícios.</div>');
    else if (S.mode === 'demo') { const b = $('.demo-banner'); if (b) b.firstChild.textContent = 'MODO DEMONSTRAÇÃO — dados fictícios, separados dos reais. Alterações feitas aqui não são salvas. '; }
    else if (!R.canWrite) $('.main').insertAdjacentHTML('afterbegin', '<div class="demo-banner" role="alert">Seu acesso a este sistema é somente leitura. Peça ao administrador para compartilhar com você como Colaborador.</div>');
    if (R.error) { const l = $('#leave-demo'); if (l) l.remove(); }
  };
  document.addEventListener('DOMContentLoaded', () => {});
  const root = document.getElementById('root');
  root.innerHTML = '<div class="empty" style="padding-top:20vh"><b>Real 4U</b>Carregando o sistema…</div>';
  R.init().then(() => boot()).catch(e => { root.innerHTML = `<div class="empty" style="padding-top:20vh"><b>Não foi possível iniciar.</b>${esc(e && e.message || e)}</div>`; console.error(e); });
})();

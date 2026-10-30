'use strict';
// Comportamentos das telas (sem framework): modo escuro, tela cheia, busca no
// menu, linhas repetidas dos formulários, copiar link, confirmação de ações e
// busca + paginação das tabelas.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const salvar = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sem storage */ } };

  $('#modoEscuro')?.addEventListener('click', () => {
    const escuro = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = escuro ? 'light' : 'dark';
    salvar('tema', document.documentElement.dataset.theme);
  });
  $('#telaCheia')?.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()));
  $('#abrirMenu')?.addEventListener('click', () => $('#lateral').classList.toggle('aberto'));

  $('#buscaMenu')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $$('.lateral nav a').forEach(a => { a.hidden = q && !a.dataset.busca.includes(q); });
  });

  document.addEventListener('click', e => {
    const add = e.target.closest('.adicionar-linha');
    if (add) {
      const modelo = document.getElementById(add.dataset.alvo);
      let alvo = modelo.previousElementSibling;
      if (alvo && !alvo.classList.contains('repetidor')) alvo = alvo.querySelector('.repetidor');
      alvo.appendChild(modelo.content.cloneNode(true));
    }
    const rem = e.target.closest('.remover-linha');
    if (rem) rem.closest('.linha-rep').remove();
    const cp = e.target.closest('[data-copiar]');
    if (cp) {
      const inp = document.getElementById(cp.dataset.copiar);
      (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).catch(() => { inp.classList.remove('oculto'); inp.select(); document.execCommand('copy'); });
      const t = cp.textContent; cp.textContent = 'Copiado!'; setTimeout(() => { cp.textContent = t; }, 1500);
    }
  });
  document.addEventListener('submit', e => {
    const botao = e.submitter;
    const msg = (botao && botao.dataset.confirmar) || e.target.dataset.confirmar;
    if (msg && !confirm(msg)) return e.preventDefault();
    // data-pedir: pergunta um texto (ex.: motivo do cancelamento) e manda no 1º campo oculto
    const pedir = e.target.dataset.pedir;
    if (pedir) {
      const v = prompt(pedir);
      if (v === null) return e.preventDefault();
      e.target.querySelector('input[type=hidden]').value = v;
    }
  });

  // abas dentro da tela (data-aba -> data-painel); o #aba fica no endereço
  const abrirAba = k => {
    const bt = document.querySelector(`.abas-form [data-aba="${k}"]`);
    if (!bt) return;
    $$('.abas-form [data-aba]').forEach(b => b.classList.toggle('ativo', b === bt));
    $$('[data-painel]').forEach(p => { p.hidden = p.dataset.painel !== k; });
  };
  document.addEventListener('click', e => {
    const bt = e.target.closest('.abas-form [data-aba]');
    if (bt) { abrirAba(bt.dataset.aba); history.replaceState(null, '', '#' + bt.dataset.aba); }
  });
  if (location.hash) abrirAba(location.hash.slice(1));
  // campo obrigatório escondido numa aba: mostra a aba antes do aviso do navegador
  document.addEventListener('invalid', e => {
    const p = e.target.closest('[data-painel]');
    if (p && p.hidden) abrirAba(p.dataset.painel);
  }, true);

  $$('.ler-arquivo').forEach(inp => inp.addEventListener('change', () => {
    const f = inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { document.getElementById(inp.dataset.alvo).value = r.result; };
    r.readAsText(f, 'utf-8');
  }));

  // certificado: o arquivo vai em base64 num campo oculto do formulário
  $$('.ler-arquivo-b64').forEach(inp => inp.addEventListener('change', () => {
    const f = inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      document.getElementById(inp.dataset.alvo).value = String(r.result).split(',')[1] || '';
      document.getElementById(inp.dataset.nome).value = f.name;
    };
    r.readAsDataURL(f);
  }));

  // tabelas: busca e paginação no navegador
  $$('.tabela-topo').forEach(topo => {
    const card = topo.parentElement;
    const linhas = $$('tbody tr', card).filter(tr => !tr.classList.contains('vazio'));
    const pag = $('.paginacao', card);
    let pagina = 1;
    const render = () => {
      const q = $('.busca-tabela', topo).value.trim().toLowerCase();
      const por = Number($('.por-pagina', topo).value);
      const vis = linhas.filter(tr => !q || tr.textContent.toLowerCase().includes(q));
      const total = Math.max(1, Math.ceil(vis.length / por));
      pagina = Math.min(pagina, total);
      linhas.forEach(tr => { tr.hidden = true; });
      vis.slice((pagina - 1) * por, pagina * por).forEach(tr => { tr.hidden = false; });
      pag.innerHTML = '';
      const info = document.createElement('span');
      info.textContent = `${vis.length} registro(s) · página ${pagina} de ${total}`;
      pag.appendChild(info);
      [['‹', pagina - 1], ['›', pagina + 1]].forEach(([t, p]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'botao sec pequeno'; b.textContent = t; b.disabled = p < 1 || p > total;
        b.onclick = () => { pagina = p; render(); };
        pag.appendChild(b);
      });
    };
    $('.busca-tabela', topo).addEventListener('input', () => { pagina = 1; render(); });
    $('.por-pagina', topo).addEventListener('change', () => { pagina = 1; render(); });
    render();
  });
})();

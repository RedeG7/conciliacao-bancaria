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

  // abas do menu: ficam como a pessoa deixou ao trocar de tela
  const lerAbertos = () => { try { return JSON.parse(localStorage.getItem('menuAberto') || '[]'); } catch (e) { return []; } };
  const grupos = $$('.lateral .grupo');
  const temAtivo = d => !!$('a.ativo', d);
  $$('.lateral .grupo > summary').forEach(s => s.addEventListener('click', () => {
    const d = s.parentElement, g = d.dataset.grupo;
    const abertos = lerAbertos().filter(x => x !== g);
    if (!d.open) abertos.push(g); // o clique ainda vai abrir
    salvar('menuAberto', JSON.stringify(abertos));
  }));

  $('#buscaMenu')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $$('.lateral nav a').forEach(a => { a.hidden = q && !a.dataset.busca.includes(q); });
    // a busca abre as abas sem mudar a escolha salva; ao limpar, ela volta
    const abertos = lerAbertos();
    grupos.forEach(d => {
      const achou = $$('a', d).some(a => !a.hidden);
      d.hidden = !achou;
      d.open = q ? achou : abertos.includes(d.dataset.grupo) || temAtivo(d);
    });
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

  // dica dos gráficos, ao passar o mouse ou tocar
  let dica;
  const mostraDica = e => {
    const alvo = e.target.closest?.('[data-dica]');
    if (!alvo) { if (dica) dica.hidden = true; return; }
    if (!dica) { dica = document.createElement('div'); dica.id = 'dicaGrafico'; document.body.append(dica); }
    dica.hidden = false; dica.textContent = alvo.dataset.dica;
    dica.style.left = `${Math.min(e.clientX + 12, innerWidth - dica.offsetWidth - 8)}px`;
    dica.style.top = `${Math.max(e.clientY - dica.offsetHeight - 10, 8)}px`;
  };
  document.addEventListener('pointermove', mostraDica);
  document.addEventListener('pointerdown', mostraDica);

  // 9box: busca, departamento e quadrante escolhido filtram o quadro e os números
  $$('[data-box9]').forEach(box => {
    const busca = $('.box9-busca', box), depto = $('.box9-depto', box), limpar = $('.box9-limpar', box), status = $('.box9-status', box);
    const quadros = $$('.box9-q', box), pessoas = $$('.box9-pessoa', box), linhas = $$('tbody tr[data-q]', box), dlg = $('dialog', box);
    const num = v => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
    const simples = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const ATENCAO = ['Insuficientes', 'Verificar situação', 'Trabalhar valores'];
    let escolhido = '';
    const render = () => {
      const q = simples(busca.value.trim()), d = depto.value;
      const passa = el => (!q || simples(el.dataset.nome).includes(q)) && (!d || el.dataset.depto === d);
      const visiveis = [];
      quadros.forEach(sec => {
        const noQuadro = $$('.box9-pessoa', sec).filter(b => { const ok = passa(b); b.parentElement.hidden = !ok; return ok; });
        $('.box9-conta', sec).textContent = noQuadro.length;
        $('.box9-vazio', sec).hidden = noQuadro.length > 0;
        sec.classList.toggle('apagado', Boolean(escolhido) && sec.dataset.q !== escolhido);
        $('.box9-titulo', sec).setAttribute('aria-pressed', String(sec.dataset.q === escolhido));
        if (!escolhido || sec.dataset.q === escolhido) visiveis.push(...noQuadro);
      });
      linhas.forEach(tr => { tr.hidden = !passa(tr) || (Boolean(escolhido) && tr.dataset.q !== escolhido); });
      const n = visiveis.length, conta = f => visiveis.filter(f).length;
      const media = k => (n ? num(visiveis.reduce((s, b) => s + Number(b.dataset[k]), 0) / n) : '-');
      const valores = { total: n, destaques: conta(b => b.dataset.quadrante === 'Destaques'), atencao: conta(b => ATENCAO.includes(b.dataset.quadrante)), medias: `${media('c')} · ${media('d')}` };
      $$('[data-box9-n]', box).forEach(el => { el.textContent = valores[el.dataset.box9N]; });
      limpar.hidden = !q && !d && !escolhido;
      status.textContent = `${n} de ${pessoas.length} ${pessoas.length === 1 ? 'pessoa' : 'pessoas'}${escolhido ? ` em ${escolhido}` : ''}`;
    };
    busca.addEventListener('input', render);
    depto.addEventListener('change', render);
    limpar.addEventListener('click', () => { busca.value = ''; depto.value = ''; escolhido = ''; render(); });
    box.addEventListener('click', e => {
      const t = e.target.closest('.box9-titulo');
      if (t) { const q = t.closest('.box9-q').dataset.q; escolhido = escolhido === q ? '' : q; render(); return; }
      const b = e.target.closest('.box9-pessoa');
      if (!b) return;
      const d = b.dataset, campo = (k, v) => { $(`[data-campo="${k}"]`, dlg).textContent = v; };
      campo('iniciais', $('i', b).textContent); campo('nome', d.nome); campo('funcao', `${d.cargo} · ${d.depto}`); campo('quadrante', d.quadrante); campo('c', num(d.c)); campo('d', num(d.d));
      ['c', 'd'].forEach(k => { $(`[data-barra="${k}"]`, dlg).style.width = `${(Number(d[k]) / 5) * 100}%`; });
      $$('a[data-link]', dlg).forEach(a => { const u = d[a.dataset.link]; a.hidden = !u; if (u) a.href = u; });
      dlg.showModal();
    });
    $('.box9-fechar', dlg).addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    render();
  });

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

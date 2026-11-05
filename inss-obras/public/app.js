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
  // menu lateral: recolher (fica só com os ícones) e grupos fechados; lembra as escolhas
  const recolhido = () => document.documentElement.dataset.menu === 'recolhido';
  let fechados = [];
  try { fechados = JSON.parse(localStorage.getItem('grupos-fechados') || '[]'); } catch (e) { /* sem storage */ }
  const grupos = $$('.lateral details.grupo');
  // recolhido mostra todos os ícones; expandido volta os grupos que a pessoa fechou
  // (o grupo da tela atual fica sempre aberto)
  const aplicarGrupos = () => grupos.forEach(d => { d.open = recolhido() || !fechados.includes(d.dataset.grupo) || !!d.querySelector('a.ativo'); });
  aplicarGrupos();
  grupos.forEach(d => d.addEventListener('toggle', () => {
    if (recolhido()) return;
    fechados = fechados.filter(g => g !== d.dataset.grupo).concat(d.open ? [] : [d.dataset.grupo]);
    salvar('grupos-fechados', JSON.stringify(fechados));
  }));
  const alternarMenu = () => {
    if (recolhido()) delete document.documentElement.dataset.menu; else document.documentElement.dataset.menu = 'recolhido';
    salvar('menu', recolhido() ? 'recolhido' : '');
    aplicarGrupos();
  };
  $('#recolherMenu')?.addEventListener('click', alternarMenu);
  // com o menu recolhido, o logo também expande
  $('#logoMenu')?.addEventListener('click', () => { if (recolhido()) alternarMenu(); });
  // ☰ da barra de cima: no computador recolhe/expande; no celular abre o menu por cima
  $('#abrirMenu')?.addEventListener('click', () => {
    if (matchMedia('(min-width: 861px)').matches) alternarMenu();
    else $('#lateral').classList.toggle('aberto');
  });

  // botão de favorito (Tabela VAU): clicar aqui não faz nada, é para arrastar
  $$('[data-favorito]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); alert('Arraste este botão para a barra de favoritos. Clicar aqui não faz nada.'); }));

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
    r.onload = () => {
      document.getElementById(inp.dataset.alvo).value = r.result;
      if (inp.dataset.nome) document.getElementById(inp.dataset.nome).value = f.name;
    };
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

  // aviso pequeno embaixo de um campo (preenchimento automático)
  const avisoCampo = (inp, msg, erro) => {
    let a = inp.parentElement.querySelector('.aviso-campo');
    if (!a) { a = document.createElement('small'); a.className = 'aviso-campo'; inp.after(a); }
    a.textContent = msg || ''; a.classList.toggle('erro', !!erro);
  };
  const preencher = (form, nome, valor) => {
    const el = nome && form.querySelector(`[name="${nome}"]`);
    if (!el || valor === undefined || valor === null || valor === '') return;
    el.value = valor;
  };
  // CEP -> endereço (ViaCEP); data-cep diz em quais campos do formulário cada parte entra
  $$('[data-cep]').forEach(inp => inp.addEventListener('change', async () => {
    const cep = inp.value.replace(/\D/g, '');
    if (cep.length !== 8) return avisoCampo(inp, cep ? 'CEP deve ter 8 dígitos.' : '', !!cep);
    avisoCampo(inp, 'Buscando endereço...');
    try {
      const r = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
      if (r.erro) return avisoCampo(inp, 'CEP não encontrado.', true);
      const m = JSON.parse(inp.dataset.cep), f = inp.form;
      preencher(f, m.rua, r.logradouro); preencher(f, m.bairro, r.bairro); preencher(f, m.cidade, r.localidade);
      preencher(f, m.uf, r.uf); preencher(f, m.ibge, r.ibge);
      inp.value = `${cep.slice(0, 5)}-${cep.slice(5)}`;
      avisoCampo(inp, 'Endereço preenchido pelo CEP.');
      f.querySelector(`[name="${m.numero}"]`)?.focus();
    } catch (e) { avisoCampo(inp, 'Não foi possível consultar o CEP agora.', true); }
  }));
  // CPF/CNPJ: CPF é validado (dígitos); CNPJ busca razão social, contato e endereço (BrasilAPI)
  const cpfValido = c => {
    if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
    const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
  };
  $$('[data-doc]').forEach(inp => inp.addEventListener('change', async () => {
    const d = inp.value.replace(/\D/g, ''), f = inp.form;
    if (d.length === 11) return avisoCampo(inp, cpfValido(d) ? 'CPF válido.' : 'CPF inválido: confira os números.', !cpfValido(d));
    if (d.length !== 14) return avisoCampo(inp, d ? 'Informe 11 dígitos (CPF) ou 14 (CNPJ).' : '', !!d);
    avisoCampo(inp, 'Buscando CNPJ na Receita...');
    try {
      const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${d}`);
      if (!resp.ok) return avisoCampo(inp, 'CNPJ não encontrado.', true);
      const r = await resp.json();
      preencher(f, 'tipo', 'PJ'); preencher(f, 'nome', r.razao_social); preencher(f, 'fantasia', r.nome_fantasia);
      preencher(f, 'email', (r.email || '').toLowerCase()); preencher(f, 'telefone', r.ddd_telefone_1);
      preencher(f, 'cep', r.cep); preencher(f, 'rua', [r.descricao_tipo_de_logradouro, r.logradouro].filter(Boolean).join(' '));
      preencher(f, 'numero', r.numero); preencher(f, 'complemento', r.complemento); preencher(f, 'bairro', r.bairro);
      preencher(f, 'cidade', r.municipio); preencher(f, 'uf', r.uf);
      avisoCampo(inp, `Dados de ${r.razao_social} preenchidos pela Receita.`);
    } catch (e) { avisoCampo(inp, 'Não foi possível consultar o CNPJ agora.', true); }
  }));

  // andamento do envio ao eSocial: consulta a situação a cada 3 segundos até
  // sair o recibo ou o erro
  const telaEnvio = $('.envio-esocial');
  if (telaEnvio) {
    const ordem = ['enviando', 'processando', 'recebido'];
    const pintar = j => {
      const pos = ordem.indexOf(j.status);
      $$('.etapas-envio li', telaEnvio).forEach((li, i) => {
        li.className = j.status === 'erro' ? (i <= Math.max(pos, 0) ? 'erro' : '') : (i < pos || j.status === 'recebido' ? 'feito' : i === pos ? 'atual' : '');
      });
      $('#envioEtapa').textContent = (j.etapa || '') + (j.protocolo ? ` · protocolo ${j.protocolo}` : '');
      $('#envioRecibo').hidden = j.status !== 'recebido';
      $('#envioReciboNum').textContent = j.recibo || '';
      const m = $('#envioMensagem');
      m.hidden = !j.mensagem; m.textContent = j.mensagem || ''; m.className = j.status === 'erro' ? 'aviso erro' : 'aviso alerta';
      $('#envioTentar').hidden = j.status !== 'erro';
    };
    const consultar = async () => {
      try {
        const j = await (await fetch(`/esocial/envios/${telaEnvio.dataset.envio}.json`)).json();
        pintar(j);
        if (j.status === 'recebido' || j.status === 'erro') return;
      } catch (e) { /* tenta de novo */ }
      setTimeout(consultar, 3000);
    };
    if (!['recebido', 'erro'].includes(telaEnvio.dataset.status)) setTimeout(consultar, 1500);
  }

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

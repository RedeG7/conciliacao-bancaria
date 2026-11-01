/* Extrator da Tabela VAU (SERO / e-CAC) — bookmarklet do inssobras.
   Uso: logado no e-CAC, abra o SERO e clique no favorito. Baixa um JSON pronto para importar. */
(async function () {
  var URL_VAU = 'https://www3.cav.receita.fazenda.gov.br/sero/exibirTabelaVAU.jsf';
  var PADROES = ['casa_popular', 'comercial_salas_lojas', 'conj_habitacional_popular', 'edificio_garagens',
                 'galpao_industrial', 'residencial_multifamiliar', 'residencial_unifamiliar'];

  /* O SERO roda num iframe de outro domínio dentro do e-CAC; a extração precisa estar na página do próprio SERO. */
  if (location.pathname.indexOf('/sero/') === -1) {
    if (confirm('Vou abrir a tela "Consultar Tabela VAU" do SERO. Depois que ela carregar, clique no favorito de novo.\n\n' +
                'Se aparecer a tela de login, entre no e-CAC primeiro.')) location.href = URL_VAU;
    return;
  }
  var selAno = document.getElementById('ano'), selUf = document.getElementById('uf'),
      vsEl = document.getElementById('javax.faces.ViewState');
  if (!selAno || !selUf || !vsEl) {
    location.href = location.origin + '/sero/exibirTabelaVAU.jsf';
    return;
  }
  if (window.__vauRodando) return;
  window.__vauRodando = true;

  var anos = Array.prototype.map.call(selAno.options, function (o) { return o.value; });
  var ufs = Array.prototype.map.call(selUf.options, function (o) { return o.value; });
  var vs = vsEl.value, registros = [], falhas = [], feitos = 0, total = anos.length * ufs.length;

  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#fff;border:2px solid #1351b4;' +
    'border-radius:8px;padding:14px 18px;font:14px Arial,sans-serif;color:#222;box-shadow:0 4px 16px rgba(0,0,0,.25);min-width:280px';
  document.body.appendChild(box);
  function status(html) { box.innerHTML = '<b>Tabela VAU — inssobras</b><br>' + html; }

  function num(s) { return Number(String(s).trim().replace(/\./g, '').replace(',', '.')); }

  async function consulta(ano, uf) {
    var corpo = new URLSearchParams({ formPrincipal: 'formPrincipal', ano: ano, uf: uf, btBuscar: 'Buscar', 'javax.faces.ViewState': vs });
    var r = await fetch(location.origin + '/sero/exibirTabelaVAU.jsf', {
      method: 'POST', body: corpo, credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    var novo = doc.getElementById('javax.faces.ViewState');
    if (novo) vs = novo.value;
    var tabela = Array.prototype.find.call(doc.querySelectorAll('table'), function (t) { return /Casa popular/i.test(t.textContent); });
    if (!tabela) {
      if (/login|sess[aã]o expirada|acesso negado/i.test(doc.body ? doc.body.textContent : '')) throw new Error('sessão expirada');
      return [];  /* ano/UF sem valores publicados */
    }
    var linhas = [];
    tabela.querySelectorAll('tr').forEach(function (tr) {
      var c = Array.prototype.map.call(tr.querySelectorAll('td'), function (td) { return td.textContent.trim(); });
      if (c.length >= 9 && /^\d{2}\/\d{4}$/.test(c[0])) {
        var reg = { competencia: c[0].slice(3) + '-' + c[0].slice(0, 2), uf: c[1] };
        PADROES.forEach(function (p, i) { reg[p] = num(c[i + 2]); });
        linhas.push(reg);
      }
    });
    return linhas;
  }

  try {
    for (var a = 0; a < anos.length; a++) {
      for (var u = 0; u < ufs.length; u++) {
        var ok = false;
        for (var t = 0; t < 3 && !ok; t++) {
          try { registros = registros.concat(await consulta(anos[a], ufs[u])); ok = true; }
          catch (e) {
            if (e.message === 'sessão expirada') throw e;
            await new Promise(function (s) { setTimeout(s, 1500); });
          }
        }
        if (!ok) falhas.push(anos[a] + '/' + ufs[u]);
        feitos++;
        status('Consultando ' + anos[a] + ' · ' + ufs[u] + '<br>' + feitos + ' de ' + total + ' · ' + registros.length + ' linhas');
        await new Promise(function (s) { setTimeout(s, 300); });
      }
    }
    if (!registros.length) throw new Error('nenhum valor encontrado');

    registros.sort(function (x, y) { return x.competencia.localeCompare(y.competencia) || x.uf.localeCompare(y.uf); });
    var comps = registros.map(function (r) { return r.competencia; });
    var ini = comps[0], fim = comps[comps.length - 1];
    var json = JSON.stringify({ fonte: 'RFB e-CAC SERO - Consultar Tabela VAU', extraido_em: new Date().toISOString(),
                                unidade: 'R$/m2', registros: registros });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.download = 'tabela_vau_sero_' + ini + '_a_' + fim + '.json';
    document.body.appendChild(link); link.click();

    status('<span style="color:#168821">✔ Concluído</span><br>' + registros.length + ' linhas · ' + ini + ' a ' + fim +
           '<br>Arquivo baixado: <b>' + link.download + '</b><br>Importe na página Tabela VAU do inssobras.' +
           (falhas.length ? '<br><span style="color:#b30000">Sem resposta: ' + falhas.join(', ') + ' — rode de novo.</span>' : ''));
  } catch (e) {
    status('<span style="color:#b30000">✖ ' + e.message + '</span><br>Entre no e-CAC de novo e clique no favorito.');
  } finally {
    window.__vauRodando = false;
    var fechar = document.createElement('a');
    fechar.textContent = 'fechar'; fechar.href = '#';
    fechar.style.cssText = 'display:block;margin-top:8px;text-align:right;color:#1351b4';
    fechar.onclick = function (ev) { ev.preventDefault(); box.remove(); };
    box.appendChild(fechar);
  }
})();

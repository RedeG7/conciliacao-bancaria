'use strict';
/* Contatos (lista, filtros, importação CSV com prévia e duplicidades) e Tarefas. */

route('/contatos', async (main, p, alive) => {
  S.cf = S.cf || { q: '', kind: '', profile: '', source_id: '', campaign_id: '', owner_id: '', archived: '0' };
  const f = S.cf; const users = S.boot.users || [];
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Contatos</h1><p>Clientes potenciais, parceiros de indicação e interessados em curso. Um contato pode ter várias oportunidades.</p></div>
    <div class="actions"><span id="saved"></span>${can('admin', 'comercial') ? `<button class="btn" data-download="/api/export/contatos">${icon('download')}Exportar CSV</button>` : ''}
    <button class="btn" id="imp">${icon('upload')}Importar CSV</button><button class="btn primary" id="new">${icon('plus')}Novo contato</button></div></div>
    <div class="tabs" id="ktabs">${[['', 'Todos'], ['cliente_potencial', 'Clientes potenciais'], ['parceiro', 'Parceiros de indicação'], ['interessado_curso', 'Interessados em curso']].map(([k, l]) => `<button data-k="${k}" class="${f.kind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="filters" id="cf">
      <label class="f" style="max-width:320px;flex:2"><span>Buscar</span><input name="q" value="${esc(f.q)}" placeholder="Nome, empresa, e-mail, telefone ou cidade"></label>
      <label class="f"><span>Perfil</span><select name="profile"><option value="">Todos</option>${mapOpts(LBL.profile, f.profile)}</select></label>
      <label class="f"><span>Primeira origem</span><select name="source_id"><option value="">Todas</option>${opts(S.boot.sources, f.source_id)}<option value="0" ${f.source_id === '0' ? 'selected' : ''}>Não identificado</option></select></label>
      <label class="f"><span>Campanha</span><select name="campaign_id"><option value="">Todas</option>${opts(S.boot.campaigns, f.campaign_id)}</select></label>
      <label class="f"><span>Responsável</span><select name="owner_id"><option value="">Todos</option>${opts(users, f.owner_id)}<option value="0">Sem responsável</option></select></label>
      <label class="f"><span>Situação</span><select name="archived">${mapOpts({ 0: 'Ativos', 1: 'Arquivados' }, f.archived)}</select></label>
    </div><div class="card" id="list"></div>`;
  $('#new', main).onclick = () => newContactModal({ kind: f.kind || 'cliente_potencial' });
  $('#imp', main).onclick = importContactsWizard;
  $('#ktabs', main).onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; f.kind = b.dataset.k; $$('#ktabs button', main).forEach(x => x.classList.toggle('on', x === b)); load(); };
  let t; $('#cf', main).addEventListener('input', e => { f[e.target.name] = e.target.value; clearTimeout(t); t = setTimeout(load, e.target.name === 'q' ? 250 : 0); });
  savedFiltersUi(main, 'contatos', f, nf => { Object.assign(f, nf); render(); });
  async function load() {
    const rows = await GET('/api/contacts?' + qs(f)); if (!alive()) return;
    $('#list', main).innerHTML = rows.length ? `<div class="card-head"><span class="sub">${rows.length} contato(s)</span></div><div class="table-wrap"><table class="t"><thead><tr><th>Contato</th><th>Tipo / perfil</th><th>Telefone / e-mail</th><th>Primeira origem</th><th>Captado em</th><th>Oportunidades</th><th>Qualificação</th><th>Responsável</th></tr></thead><tbody>
      ${rows.slice(0, 1000).map(c => `<tr class="click" data-open-contact="${c.id}"><td><b>${esc(c.name)}</b><div class="small muted">${esc([c.company, c.city].filter(Boolean).join(' · '))}</div></td>
        <td>${kindChip(c.kind)}<div class="small muted">${esc(LBL.profile[c.profile] || '')}</div></td><td class="small">${esc(c.phone || '')}<div class="muted">${esc(c.email || '')}</div></td>
        <td class="small"><b>${esc(c.source)}</b>${c.campaign ? `<div class="muted">${esc(c.campaign)}</div>` : ''}${c.content ? `<div class="faint">${esc(c.content)}</div>` : ''}</td><td>${F.date(c.captured_at)}</td>
        <td class="small">${c.opps ? `${c.open_opps} aberta(s)${c.won_opps ? ` · <span class="chip green">${c.won_opps} ganha(s)</span>` : ''}` : '<span class="muted">nenhuma</span>'}</td><td>${qualChip(c.qual)}</td><td class="small">${esc(userName(c.owner_id))}</td></tr>`).join('')}</tbody></table></div>${rows.length > 1000 ? '<p class="small muted center">Mostrando os 1.000 mais recentes. Refine os filtros.</p>' : ''}`
      : `<div class="empty"><b>Nenhum contato encontrado.</b>Cadastre um novo lead ou importe uma planilha CSV.</div>`;
  }
  S.refreshPage = load;
  await load();
});

// ---------- assistente genérico de importação CSV ----------
function importWizard({ title, fields, previewUrl, commitUrl, intro, options = '', statusInfo, previewCols, rowAction, afterCommit, summary }) {
  const st = { header: [], rows: [], map: {}, preview: null };
  const m = modal({ title, size: 'xwide', body: raw('<div id="wz"></div>'), foot: raw('<button class="btn" data-close>Fechar</button><button class="btn hidden" id="wz-back">Voltar</button><button class="btn primary" id="wz-next">Continuar</button>') });
  const wz = $('#wz', m.el); const next = $('#wz-next', m.el); const back = $('#wz-back', m.el);
  let step = 1;
  const draw = () => {
    back.classList.toggle('hidden', step === 1);
    if (step === 1) {
      next.textContent = 'Continuar'; next.disabled = !st.rows.length;
      wz.innerHTML = `${R(intro)}<div class="card pad mt"><label class="f"><span>Arquivo CSV (separado por ponto e vírgula ou vírgula)</span><input type="file" id="wz-file" accept=".csv,text/csv,.txt"></label>
        <p class="small muted">Colunas esperadas (os nomes podem variar; você confirma a correspondência no próximo passo): ${fields.map(f => `<code class="inline">${esc(f.label)}</code>`).join(' ')}</p>
        ${st.rows.length ? `<p class="callout navy small">${st.rows.length} linha(s) lida(s) com ${st.header.length} coluna(s).</p>` : ''}</div>`;
      $('#wz-file', wz).onchange = async e => { const file = e.target.files[0]; if (!file) return; const txt = await readFileText(file); const r = parseCSV(txt); st.header = r.header; st.rows = r.rows; st.map = guessMapping(r.header, fields); draw(); };
    } else if (step === 2) {
      next.textContent = 'Gerar prévia'; next.disabled = false;
      wz.innerHTML = `<p>Confirme qual coluna do arquivo corresponde a cada campo do sistema.</p><div class="form-grid">${fields.map(f => `<label class="f"><span>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</span><select data-map="${f.key}"><option value="">— não importar —</option>${st.header.map((h, i) => `<option value="${i}" ${String(st.map[f.key]) === String(i) ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`).join('')}</div>
        <h3 class="mt">Amostra do arquivo</h3><div class="table-wrap"><table class="t"><thead><tr>${st.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${st.rows.slice(0, 4).map(r => `<tr>${st.header.map((h, i) => `<td class="small">${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      $$('[data-map]', wz).forEach(s => { s.onchange = () => { st.map[s.dataset.map] = s.value; }; });
    } else if (step === 3) {
      const p = st.preview; next.textContent = 'Confirmar importação'; next.disabled = false;
      wz.innerHTML = `<div class="actions mb">${Object.entries(p.counts).map(([k, n]) => `<span class="chip ${statusInfo[k] ? statusInfo[k][1] : ''}">${esc(statusInfo[k] ? statusInfo[k][0] : k)}: ${n}</span>`).join('')}</div>${R(options)}
        <div class="table-wrap" style="max-height:52vh"><table class="t"><thead><tr><th>#</th><th>Situação</th>${previewCols.map(c => `<th>${esc(c[0])}</th>`).join('')}<th>Ação</th></tr></thead><tbody>
        ${p.rows.map(r => `<tr><td class="small">${r.index + 2}</td><td><span class="chip ${(statusInfo[r.status] || [])[1] || ''}">${esc((statusInfo[r.status] || [r.status])[0])}</span>${(r.errors || []).map(e => `<div class="small" style="color:var(--red)">${esc(e)}</div>`).join('')}${(r.warnings || []).map(e => `<div class="small" style="color:var(--amber)">${esc(e)}</div>`).join('')}</td>
          ${previewCols.map(c => `<td class="small">${R(c[1](r))}</td>`).join('')}<td>${rowAction ? R(rowAction(r)) : ''}</td></tr>`).join('')}</tbody></table></div>`;
    } else {
      next.classList.add('hidden'); back.classList.add('hidden');
      wz.innerHTML = R(summary(st.result));
    }
  };
  next.onclick = async () => {
    try {
      if (step === 1) { step = 2; }
      else if (step === 2) {
        const miss = fields.filter(f => f.required && st.map[f.key] === ''); if (miss.length) return toast('Indique a coluna de: ' + miss.map(f => f.label).join(', '), { err: true });
        st.mapped = st.rows.map(r => Object.fromEntries(fields.map(f => [f.key, st.map[f.key] === '' || st.map[f.key] === undefined ? '' : (r[Number(st.map[f.key])] || '').trim()])));
        next.disabled = true; st.preview = await POST(previewUrl, { rows: st.mapped }); step = 3;
      } else if (step === 3) {
        next.disabled = true;
        const actions = Object.fromEntries($$('[data-act]', wz).map(s => [s.dataset.act, s.value]));
        const optsVals = readForm($('#wz-opts', wz) || document.createElement('div'));
        st.result = await POST(commitUrl, Object.assign({ rows: st.preview.rows.map(r => Object.assign({}, st.mapped[r.index], { index: r.index, data: r.data, action: actions[r.index] || r.action, match_id: r.matches && r.matches[0] ? r.matches[0].id : null })) }, optsVals));
        step = 4; afterCommit && afterCommit(st.result);
      }
      draw();
    } catch (e) { next.disabled = false; fail(e); }
  };
  back.onclick = () => { step = Math.max(1, step - 1); draw(); };
  draw();
}

function importContactsWizard() {
  const users = (S.boot.users || []).filter(u => u.active);
  importWizard({
    title: 'Importar contatos (CSV)', previewUrl: '/api/contacts/import/preview', commitUrl: '/api/contacts/import/commit',
    intro: H`<p>Envie uma planilha exportada em CSV. Antes de gravar, o sistema mostra uma prévia e verifica duplicidades por <b>telefone</b> e <b>e-mail</b> — no arquivo e no cadastro.</p>`,
    fields: [
      { key: 'name', label: 'Nome', required: true, aliases: ['nome', 'name', 'contato', 'cliente'] }, { key: 'phone', label: 'Telefone', aliases: ['telefone', 'celular', 'whatsapp', 'fone', 'phone'] },
      { key: 'email', label: 'E-mail', aliases: ['email', 'e-mail', 'mail'] }, { key: 'company', label: 'Empresa', aliases: ['empresa', 'company', 'razao'] }, { key: 'city', label: 'Cidade', aliases: ['cidade', 'city', 'municipio'] },
      { key: 'kind', label: 'Tipo de contato', aliases: ['tipo'], help: 'cliente / parceiro / curso' }, { key: 'profile', label: 'Perfil', aliases: ['perfil', 'profissao', 'cargo'] },
      { key: 'captured_at', label: 'Data de captação', aliases: ['data', 'captado', 'criado', 'datacadastro'], help: 'dd/mm/aaaa' }, { key: 'source', label: 'Origem', aliases: ['origem', 'fonte', 'source'], help: 'Nome igual ao cadastrado em Origens' },
      { key: 'campaign', label: 'Campanha', aliases: ['campanha', 'campaign'] }, { key: 'content', label: 'Conteúdo', aliases: ['conteudo', 'anuncio', 'content'] }, { key: 'service', label: 'Serviço', aliases: ['servico', 'interesse', 'service'] },
      { key: 'utm_source', label: 'utm_source', aliases: ['utmsource'] }, { key: 'utm_medium', label: 'utm_medium', aliases: ['utmmedium'] }, { key: 'utm_campaign', label: 'utm_campaign', aliases: ['utmcampaign'] }, { key: 'utm_content', label: 'utm_content', aliases: ['utmcontent'] },
      { key: 'notes', label: 'Observações', aliases: ['observacao', 'obs', 'notas', 'mensagem'] },
    ],
    statusInfo: { novo: ['Novo', 'green'], duplicado: ['Já cadastrado', 'amber'], repetido_no_arquivo: ['Repetido no arquivo', 'amber'], erro: ['Com erro', 'red'] },
    options: raw(`<div class="card pad mb" id="wz-opts"><div class="form-grid">${fieldHtml({ name: 'create_opps', label: 'Criar oportunidade na primeira etapa para cada contato novo', type: 'checkbox', value: true, full: true })}${fieldHtml({ name: 'owner_id', label: 'Responsável para os novos contatos', type: 'select', options: opts(users, can('comercial', 'admin') ? S.me.user.id : '', { empty: 'Sem responsável' }) })}</div>
      <p class="small muted">Para "Já cadastrado", escolha <b>Atualizar existente</b> (preenche apenas campos vazios e registra a nova interação) ou <b>Ignorar</b>.</p></div>`),
    previewCols: [['Nome', r => esc(r.data.name)], ['Telefone / e-mail', r => esc([r.data.phone, r.data.email].filter(Boolean).join(' · '))], ['Empresa', r => esc(r.data.company || '')],
      ['Coincide com', r => (r.matches || []).map(x => `<b>${esc(x.name)}</b> <span class="muted">${esc(x.phone || x.email || '')}</span>`).join('<br>') + (r.inFile !== null && r.inFile !== undefined ? `linha ${r.inFile + 2} do arquivo` : '')]],
    rowAction: r => r.status === 'erro' ? '<span class="muted small">não será importada</span>'
      : `<select class="input" data-act="${r.index}" style="padding:3px 6px">${r.status === 'duplicado' ? mapOpts({ atualizar: 'Atualizar existente', ignorar: 'Ignorar', criar: 'Criar novo mesmo assim' }, 'atualizar') : r.status === 'repetido_no_arquivo' ? mapOpts({ ignorar: 'Ignorar', criar: 'Criar mesmo assim' }, 'ignorar') : mapOpts({ criar: 'Criar', ignorar: 'Ignorar' }, 'criar')}</select>`,
    afterCommit: () => dataChanged(),
    summary: r => `<div class="empty"><b>Importação concluída.</b>${r.criados} criado(s) · ${r.atualizados} atualizado(s) · ${r.ignorados} ignorado(s)${r.erros.length ? ` · ${r.erros.length} com erro` : ''}</div>`,
  });
}

// ---------- tarefas ----------
route('/tarefas', async (main, p, alive) => {
  S.tf = S.tf || { scope: 'mine', status: 'open' };
  const f = S.tf; const users = (S.boot.users || []).filter(u => u.active);
  main.innerHTML = `<div class="page-head"><div class="grow"><h1>Tarefas e lembretes</h1><p>Prazos de retorno, documentos e follow-ups. Tarefas atrasadas aparecem em vermelho e nos alertas.</p></div>
    <div class="actions"><button class="btn" data-download="/api/export/tarefas">${icon('download')}Exportar CSV</button><button class="btn primary" id="new">${icon('plus')}Nova tarefa</button></div></div>
    <div class="filters"><div class="seg" id="sc"><button data-v="mine" class="${f.scope === 'mine' ? 'on' : ''}">Minhas</button><button data-v="all" class="${f.scope === 'all' ? 'on' : ''}">Toda a equipe</button></div>
      <div class="seg" id="ss"><button data-v="open" class="${f.status === 'open' ? 'on' : ''}">Pendentes</button><button data-v="done" class="${f.status === 'done' ? 'on' : ''}">Concluídas</button><button data-v="" class="${!f.status ? 'on' : ''}">Todas</button></div></div>
    <div class="card" id="list"></div>`;
  $('#sc', main).onclick = e => { const b = e.target.closest('[data-v]'); if (b) { f.scope = b.dataset.v; render(); } };
  $('#ss', main).onclick = e => { const b = e.target.closest('[data-v]'); if (b) { f.status = b.dataset.v; render(); } };
  $('#new', main).onclick = () => formModal({ title: 'Nova tarefa', fields: [{ name: 'title', label: 'Tarefa', required: true, full: true }, { name: 'due_date', label: 'Prazo', type: 'date', value: today() }, { name: 'owner_id', label: 'Responsável', type: 'select', options: opts(users, S.me.user.id) }],
    intro: H`<p class="small muted" style="margin-top:0">Para vincular a um contato, crie a tarefa pela ficha do contato.</p>`, onSubmit: async v => { await POST('/api/tasks', v); load(); } });
  async function load() {
    const rows = await GET('/api/tasks?' + qs(f)); if (!alive()) return;
    const T = today();
    const groups = [['Atrasadas', rows.filter(t => t.overdue)], ['Hoje', rows.filter(t => !t.done_at && t.due_date === T)], ['Próximas', rows.filter(t => !t.done_at && (!t.due_date || t.due_date > T))], ['Concluídas', rows.filter(t => t.done_at)]].filter(g => g[1].length);
    $('#list', main).innerHTML = groups.length ? groups.map(([g, list]) => `<div class="card-head"><h3>${g}</h3><span class="chip ${g === 'Atrasadas' ? 'red' : ''}">${list.length}</span></div><table class="t"><tbody>${list.map(t => `<tr>
      <td style="width:30px"><input type="checkbox" data-done="${t.id}" ${t.done_at ? 'checked' : ''} aria-label="Concluir tarefa"></td>
      <td>${t.done_at ? `<s>${esc(t.title)}</s>` : `<b>${esc(t.title)}</b>`} ${t.overdue ? '<span class="chip red">Atrasada</span>' : ''}</td>
      <td>${t.contact_id ? `<a href="#" data-open-contact="${t.contact_id}" ${t.opp_id ? `data-opp="${t.opp_id}"` : ''}>${esc(t.contact_name || 'Contato')}</a>` : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${F.date(t.due_date)}</td><td>${esc(t.owner || '')}</td><td class="right"><button class="btn sm danger" data-del="${t.id}">Excluir</button></td></tr>`).join('')}</tbody></table>`).join('')
      : '<div class="empty"><b>Nenhuma tarefa.</b>Tudo em dia.</div>';
    $$('[data-done]', main).forEach(c => { c.onchange = async () => { await PUT('/api/tasks/' + c.dataset.done, { done: c.checked }).catch(fail); load(); refreshAlerts(); }; });
    $$('[data-del]', main).forEach(b => { b.onclick = async () => { if (await confirmDlg('Excluir esta tarefa?', { danger: true, ok: 'Excluir' })) { await DEL('/api/tasks/' + b.dataset.del).catch(fail); load(); } }; });
  }
  S.refreshPage = load; await load();
});

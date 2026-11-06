'use strict';
// Motor dos cadastros: lê e valida formulários, monta o formulário e formata
// as colunas a partir de src/modelos.js, sempre respeitando o papel do usuário.
const R = require('./db');
const { KINDS, rotulo, MESES } = require('./modelos');
const { ve } = require('./acesso');
const { dataValida } = require('./datas');
const { html, raw, brl, n2, dataBr, select, campo } = require('./views');

const um = v => (Array.isArray(v) ? v[0] : v);
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const MAX_TEXTO = 5000;

// "1.234,56", "1234,56" e "1234.56" viram 1234.56
function numero(txt) {
  const s = String(txt).trim().replace(/^R\$\s*/, '');
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : null;
}
// "8:30" e "8,5" viram 8.5 horas
function horas(txt) {
  const m = String(txt).trim().match(/^(\d{1,4}):([0-5]\d)$/);
  const v = m ? Number(m[1]) + Number(m[2]) / 60 : numero(txt);
  return v === null || v < 0 ? null : v;
}
function hhmm(v) {
  const min = Math.round(Number(v) * 60);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
// aceita data do formulário (AAAA-MM-DD) e de planilha (DD/MM/AAAA)
function data(txt) {
  const s = String(txt).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : s;
  return dataValida(iso) ? iso : null;
}

// Contexto por requisição: nomes das referências e consultas usadas nas colunas.
function contexto(office, papel) {
  const cache = new Map();
  const todos = kind => {
    if (!cache.has(kind)) cache.set(kind, new Map(R.listar(office, kind, { inativos: true }).map(r => [r.id, r])));
    return cache.get(kind);
  };
  const c = {
    office, papel, novoToken: R.novoToken,
    listar: (kind, o) => R.listar(office, kind, o),
    registro: (kind, id) => todos(kind).get(Number(id)),
    nome: (kind, id) => { const r = todos(kind).get(Number(id)); return r ? rotulo(KINDS[kind], r) : ''; },
    saldoBanco(id) {
      if (!c._saldo) {
        c._saldo = new Map();
        for (const l of R.listar(office, 'banco_horas')) c._saldo.set(l.colaborador_id, (c._saldo.get(l.colaborador_id) || 0) + (l.tipo === 'Débito' ? -1 : 1) * (l.horas || 0));
      }
      return `${n2(c._saldo.get(id) || 0)}h`;
    },
    respostas: id => Number(R.db.prepare('SELECT COUNT(*) n FROM respostas WHERE office = ? AND pesquisa_id = ?').get(office, id).n),
    ultimaResposta: id => R.db.prepare('SELECT MAX(criado_em) d FROM respostas WHERE office = ? AND pesquisa_id = ?').get(office, id).d,
  };
  return c;
}

// Lê o formulário. Campos que o papel não vê ficam como estavam (nunca são
// apagados por quem não os enxerga). Com parcial, só os campos enviados mudam.
function lerForm(k, body, c, atual = null, { parcial = false } = {}) {
  const dados = atual ? R.soDados(atual) : {};
  const erros = [];
  for (const f of k.campos) {
    if (f.interno || !ve(c.papel, f.cl) || (parcial && !(f.n in body))) continue;
    if (f.t === 'refs') {
      const antes = atual?.[f.n] || [];
      const ids = [...new Set([].concat(body[f.n] ?? []).map(Number))];
      if (ids.some(id => !antes.includes(id) && !R.obter(c.office, f.ref, id))) erros.push(`${f.r}: registro não encontrado.`);
      dados[f.n] = ids.length ? ids : null;
      continue;
    }
    const bruto = String(um(body[f.n]) ?? '').trim();
    if (!bruto) {
      if (f.req) erros.push(`Preencha: ${f.r}.`);
      dados[f.n] = null;
      continue;
    }
    if (bruto.length > MAX_TEXTO) { erros.push(`${f.r}: texto longo demais.`); continue; }
    let v = bruto;
    if (f.t === 'data') {
      v = data(bruto);
      if (!v) erros.push(`${f.r}: data inválida.`);
    } else if (f.t === 'numero' || f.t === 'dinheiro') {
      v = numero(bruto);
      if (v === null) erros.push(`${f.r}: número inválido.`);
      else if (f.inteiro && !Number.isInteger(v)) erros.push(`${f.r}: use um número inteiro.`);
      else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) erros.push(`${f.r}: fora do limite permitido.`);
    } else if (f.t === 'horas') {
      v = horas(bruto);
      if (v === null) erros.push(`${f.r}: use o formato hh:mm.`);
    } else if (f.t === 'opcao') {
      // a planilha pode vir com outra caixa ou sem acento; o valor antigo do registro continua aceito
      const ok = f.op.map(o => String(Array.isArray(o) ? o[0] : o));
      const achado = ok.find(o => norm(o) === norm(bruto));
      if (achado) v = achado;
      else if (bruto !== atual?.[f.n]) erros.push(`${f.r}: opção inválida.`);
    } else if (f.t === 'sim') {
      if (bruto !== '1' && bruto !== '0') erros.push(`${f.r}: opção inválida.`);
      v = bruto === '1';
    } else if (f.t === 'ref') {
      // só aceita registro do próprio escritório e do cadastro certo
      v = Number(bruto);
      // (o vínculo que já existia continua valendo se o outro registro foi apagado)
      if (v !== atual?.[f.n] && !R.obter(c.office, f.ref, v)) erros.push(`${f.r}: registro não encontrado.`);
    } else if (f.t === 'email' && !/^[^@\s]+@[^@\s]+$/.test(bruto)) erros.push(`${f.r}: e-mail inválido.`);
    dados[f.n] = v;
  }
  if (k.fixar) k.fixar(dados, atual, c);
  if (!erros.length) {
    if (k.validar) erros.push(...k.validar(dados, c, atual));
    if (k.unico && k.unico.every(n => dados[n] != null) && c.listar(k.kind).some(o => o.id !== atual?.id && k.unico.every(n => o[n] === dados[n]))) {
      erros.push(`Já existe ${k.singular} com ${k.unico.map(n => k.campos.find(f => f.n === n).r.toLowerCase()).join(' e ')} iguais.`);
    }
  }
  return { dados, erros };
}

// nomes dos campos que mudaram (a auditoria não guarda os valores)
function mudancas(k, antes, depois) {
  return k.campos.filter(f => JSON.stringify(antes[f.n] ?? null) !== JSON.stringify(depois[f.n] ?? null)).map(f => f.r).join(', ');
}

// ---------------------------------------------------------------- exibição
function valor(f, v, c) {
  if (v === null || v === undefined || v === '') return '';
  if (f.t === 'data') return dataBr(v);
  if (f.t === 'dinheiro') return brl(v);
  if (f.t === 'numero') return n2(v);
  if (f.t === 'sim') return v ? 'Sim' : 'Não';
  if (f.t === 'horas') return hhmm(v);
  if (f.t === 'ref') return c.nome(f.ref, v);
  if (f.t === 'refs') return v.map(id => c.nome(f.ref, id)).join(', ');
  if (f.t === 'opcao' && Array.isArray(f.op[0])) return (f.op.find(o => String(o[0]) === String(v)) || [])[1] || v;
  return v;
}

// colunas que o papel pode ver: [{rotulo, texto(registro)}]
function colunas(k, c) {
  return k.colunas.flatMap(col => {
    if (typeof col === 'object') return [{ rotulo: col.r, texto: r => col.v(r, c) }];
    const f = k.campos.find(x => x.n === col);
    return ve(c.papel, f.cl) ? [{ rotulo: f.r, texto: r => valor(f, r[f.n], c) }] : [];
  });
}

function ordenar(k, linhas) {
  return k.ordem ? [...linhas].sort((a, b) => String(a[k.ordem] ?? '').localeCompare(String(b[k.ordem] ?? ''), 'pt-BR')) : linhas;
}

function opcoesRef(c, f, atual, comVazio = true) {
  const lista = c.listar(f.ref);
  const ativos = f.ref === 'colaborador' ? lista.filter(r => r.situacao !== 'Inativo') : lista;
  const v = Number(atual) || 0;
  const op = ordenar({ ordem: f.ref === 'colaborador' ? 'nome' : null }, ativos).map(r => [r.id, rotulo(KINDS[f.ref], r)]);
  if (v && !op.some(o => o[0] === v)) op.push([v, c.nome(f.ref, v)]); // desligado ou apagado, mas já vinculado aqui
  return comVazio ? [['', '- selecione -'], ...op] : op;
}

function entrada(f, v, c, { multi = false } = {}) {
  const req = f.req ? 'required' : '';
  if (f.t === 'longo') return html`<textarea name="${f.n}" rows="4" ${raw(req)}>${v ?? ''}</textarea>`;
  if (f.t === 'opcao') {
    const antigo = v && !f.op.some(o => String(Array.isArray(o) ? o[0] : o) === String(v)) ? [v] : [];
    return select(f.n, [['', '- selecione -'], ...f.op, ...antigo], v, req);
  }
  if (f.t === 'sim') return select(f.n, [['0', 'Não'], ['1', 'Sim']], v === true || v === '1' ? '1' : '0');
  if (f.t === 'refs') {
    const sel = new Set([].concat(v ?? []).map(String));
    return html`<select name="${f.n}" multiple size="6">${opcoesRef(c, f, null, false).map(([i, t]) => html`<option value="${i}" ${sel.has(String(i)) ? 'selected' : ''}>${t}</option>`)}</select>`;
  }
  if (f.t === 'horas') return html`<input name="${f.n}" value="${typeof v === 'number' ? hhmm(v) : v ?? ''}" placeholder="00:00" inputmode="numeric" ${raw(req)}>`;
  if (f.t === 'ref' && multi) {
    const sel = new Set((Array.isArray(v) ? v : [v]).map(String));
    return html`<select name="${f.n}" multiple size="8" required>${opcoesRef(c, f, null, false).map(([i, t]) => html`<option value="${i}" ${sel.has(String(i)) ? 'selected' : ''}>${t}</option>`)}</select>`;
  }
  if (f.t === 'ref') return select(f.n, opcoesRef(c, f, v), v, req);
  const num = typeof v === 'number' ? String(v).replace('.', ',') : v;
  const tipo = { data: 'date', email: 'email', tel: 'tel' }[f.t] || 'text';
  const extra = f.t === 'numero' || f.t === 'dinheiro' ? 'inputmode="decimal"' : '';
  return html`<input name="${f.n}" type="${tipo}" value="${num ?? ''}" ${raw(extra)} ${raw(req)}>`;
}

const grade = (campos, d, c, k, novo) => html`<div class="grade">${campos.map(f =>
  campo(f.r + (f.req || f.obrig ? ' *' : ''), entrada(f, d[f.n], c, { multi: novo && k.multi === f.n }), f.t === 'longo' ? 'largo' : ''))}</div>`;

// formulário do cadastro; só leitura = campos travados, sem botão de salvar
function formulario(k, d, c, { acao, erros = [], somenteLeitura = false, novo = false, ficha = '' }) {
  const campos = k.campos.filter(f => !f.interno && ve(c.papel, f.cl));
  const corpo = k.secoes
    ? html`<div class="abas-form">${k.secoes.map((s, i) => html`<button type="button" data-aba="s${i}" class="${i ? '' : 'ativo'}">${s}</button>`)}</div>
      ${k.secoes.map((s, i) => html`<div data-painel="s${i}" ${i ? raw('hidden') : ''}>${grade(campos.filter(f => f.s === s), d, c, k, novo)}</div>`)}`
    : grade(campos, d, c, k, novo);
  return html`${erros.length ? html`<div class="aviso erro"><ul>${erros.map(e => html`<li>${e}</li>`)}</ul></div>` : ''}
  <form method="post" action="${acao}" class="card"><fieldset ${somenteLeitura ? raw('disabled') : ''}>
    ${ficha ? html`<input type="hidden" name="ficha" value="${ficha}">` : ''}
    ${corpo}</fieldset>
    <div class="acoes">${somenteLeitura ? '' : html`<button class="botao">Salvar</button>`}
      <a class="botao sec" href="${ficha ? `/cad/colaboradores/${ficha}/ficha` : `/cad/${k.slug}`}">Voltar</a></div>
  </form>`;
}

// CSV para Excel brasileiro; célula que começa com = + - @ vira texto, senão a
// planilha a executaria como fórmula
function csv(cabecalhos, linhas) {
  const cel = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[cabecalhos, ...linhas].map(l => l.map(cel).join(';')).join('\r\n')}\r\n`;
}

function exportar(k, c) {
  const campos = k.campos.filter(f => !f.interno && ve(c.papel, f.cl));
  return csv(campos.map(f => f.r), ordenar(k, c.listar(k.kind)).map(r => campos.map(f => valor(f, r[f.n], c))));
}

module.exports = { um, norm, numero, horas, hhmm, data, contexto, lerForm, mudancas, valor, colunas, ordenar, formulario, csv, exportar, MESES };

'use strict';
// Importação de colaboradores por CSV (ex.: a planilha exportada da plataforma
// atual). Reconhece as colunas pelo rótulo do campo, sem diferenciar acentos ou
// maiúsculas. CPF já cadastrado atualiza só as colunas presentes; os demais
// viram cadastro novo. Departamento, cargo, filial e unidade que ainda não
// existem são criados pelo nome.
const R = require('./db');
const { KINDS, rotulo } = require('./modelos');
const { lerForm } = require('./crud');
const { ve } = require('./acesso');

const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// separador detectado na 1ª linha (; ou ,); aspas podem conter o separador e quebra de linha
function parseCsv(texto) {
  const t = String(texto).replace(/^﻿/, '');
  const prim = t.split(/\r?\n/, 1)[0] || '';
  const sep = (prim.match(/;/g) || []).length >= (prim.match(/,/g) || []).length ? ';' : ',';
  const linhas = []; let lin = [], cel = '', aspas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (aspas) {
      if (ch === '"' && t[i + 1] === '"') { cel += '"'; i++; } else if (ch === '"') aspas = false; else cel += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) { lin.push(cel); cel = ''; }
    else if (ch === '\n') { lin.push(cel); linhas.push(lin); lin = []; cel = ''; }
    else if (ch !== '\r') cel += ch;
  }
  if (cel || lin.length) { lin.push(cel); linhas.push(lin); }
  return linhas.filter(l => l.some(c => c.trim()));
}

function modelo() {
  const k = KINDS.colaborador;
  const nomes = ['nome', 'cpf', 'nascimento', 'email', 'data_admissao', 'departamento_id', 'cargo_id', 'unidade_id', 'tipo_contrato', 'salario'];
  return `﻿${nomes.map(n => k.campos.find(f => f.n === n).r).join(';')}\r\n`;
}

function importar(texto, c, usuario) {
  const k = KINDS.colaborador;
  const linhas = parseCsv(texto);
  if (linhas.length < 2) return { criados: 0, atualizados: 0, ignoradas: [], erros: ['A planilha precisa do cabeçalho e de pelo menos uma linha.'] };
  const campos = new Map();
  for (const f of k.campos) if (!f.interno && ve(c.papel, f.cl)) { campos.set(norm(f.r), f); campos.set(norm(f.n), f); }
  const cab = linhas[0].map(h => campos.get(norm(h)) || null);
  const ignoradas = linhas[0].filter((h, i) => !cab[i]);
  if (!cab.some(f => f?.n === 'nome') && !cab.some(f => f?.n === 'cpf')) {
    return { criados: 0, atualizados: 0, ignoradas, erros: ['A planilha precisa ter a coluna Nome completo ou CPF.'] };
  }
  const refs = {}; // kind -> nome normalizado -> id
  const refId = (kind, nome) => {
    refs[kind] ||= new Map(R.listar(c.office, kind).map(r => [norm(rotulo(KINDS[kind], r)), r.id]));
    const n = norm(nome);
    if (!refs[kind].has(n)) refs[kind].set(n, R.criar(c.office, kind, { nome: nome.trim() }, usuario));
    return refs[kind].get(n);
  };
  const res = { criados: 0, atualizados: 0, ignoradas, erros: [] };
  linhas.slice(1).forEach((lin, i) => {
    const num = i + 2;
    try {
      R.tx(() => {
        const body = {};
        cab.forEach((f, j) => {
          if (!f) return;
          let v = (lin[j] ?? '').trim();
          if (f.t === 'ref' && v) {
            if (f.ref === 'colaborador') return; // superior direto não se resolve por nome
            v = refId(f.ref, v);
          }
          if (f.t === 'sim' && v) v = /^(s|sim|1|true)$/i.test(v) ? '1' : '0';
          body[f.n] = v;
        });
        const cpf = body.cpf ? String(body.cpf).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : '';
        const atual = cpf ? c.listar('colaborador').find(o => o.cpf === cpf) : null;
        const { dados, erros } = lerForm(k, body, c, atual || null, { parcial: Boolean(atual) });
        if (erros.length) throw new Error(erros.join(' '));
        if (atual) { R.atualizar(c.office, k.kind, atual.id, dados); res.atualizados++; } else { R.criar(c.office, k.kind, dados, usuario); res.criados++; }
      });
    } catch (e) {
      // a transação desfez a linha, inclusive um departamento criado por ela
      for (const kind of Object.keys(refs)) delete refs[kind];
      res.erros.push(`Linha ${num}: ${e.message}`);
    }
  });
  return res;
}

module.exports = { parseCsv, importar, modelo };

'use strict';
// Importação por CSV de qualquer cadastro, inclusive o arquivo que o próprio
// sistema exporta. Reconhece as colunas pelo rótulo do campo, sem diferenciar
// acentos ou maiúsculas. Registro já existente atualiza só as colunas presentes
// (colaborador pelo CPF; os demais pelos campos únicos ou pelo nome); os outros
// viram cadastro novo. Departamento, cargo, filial e unidade que ainda não
// existem são criados pelo nome; as demais referências precisam já existir.
const R = require('./db');
const { KINDS, rotulo } = require('./modelos');
const { lerForm, norm } = require('./crud');
const { ve } = require('./acesso');

const CRIA_PELO_NOME = ['departamento', 'cargo', 'filial', 'unidade'];

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

const camposDe = (k, c) => k.campos.filter(f => !f.interno && ve(c.papel, f.cl));

function modelo(k = KINDS.colaborador, c = null) {
  if (k.kind === 'colaborador') {
    const nomes = ['nome', 'cpf', 'nascimento', 'genero', 'email', 'data_admissao', 'departamento_id', 'cargo_id', 'unidade_id', 'tipo_contrato', 'salario'];
    return `﻿${nomes.map(n => k.campos.find(f => f.n === n).r).join(';')}\r\n`;
  }
  return `﻿${camposDe(k, c).map(f => f.r).join(';')}\r\n`;
}

// o que identifica um registro já existente, além do CPF do colaborador
function chaveDe(k) {
  if (k.unico) return k.unico;
  return k.kind !== 'colaborador' && k.campos.some(f => f.n === 'nome') ? ['nome'] : null;
}

function importar(texto, c, usuario, k = KINDS.colaborador) {
  const linhas = parseCsv(texto);
  if (linhas.length < 2) return { criados: 0, atualizados: 0, ignoradas: [], erros: ['A planilha precisa do cabeçalho e de pelo menos uma linha.'] };
  const colab = k.kind === 'colaborador';
  const campos = new Map();
  for (const f of camposDe(k, c)) for (const nome of [f.r, f.n, ...(f.alias || [])]) campos.set(norm(nome), f);
  const cab = linhas[0].map(h => campos.get(norm(h.replace(/^\s*\*\s*/, ''))) || null);
  const ignoradas = linhas[0].filter((h, i) => !cab[i]);
  if (colab && !cab.some(f => f?.n === 'nome') && !cab.some(f => f?.n === 'cpf')) {
    return { criados: 0, atualizados: 0, ignoradas, erros: ['A planilha precisa ter a coluna Nome completo ou CPF.'] };
  }
  if (!cab.some(Boolean)) return { criados: 0, atualizados: 0, ignoradas, erros: ['Nenhuma coluna da planilha foi reconhecida. Baixe o modelo para ver os nomes.'] };

  const refs = {}; // kind -> nome normalizado -> ids
  const mapaRef = kind => {
    if (!refs[kind]) {
      refs[kind] = new Map();
      for (const r of R.listar(c.office, kind)) {
        const n = norm(rotulo(KINDS[kind], r));
        refs[kind].set(n, [...(refs[kind].get(n) || []), r.id]);
      }
    }
    return refs[kind];
  };
  const refId = (kind, nome, f) => {
    const n = norm(nome), mapa = mapaRef(kind);
    if (!mapa.has(n)) {
      if (!CRIA_PELO_NOME.includes(kind)) throw new Error(`${f.r}: "${nome}" não encontrado.`);
      mapa.set(n, [R.criar(c.office, kind, { nome: nome.trim() }, usuario)]);
    }
    if (mapa.get(n).length > 1) throw new Error(`${f.r}: há mais de um "${nome}".`);
    return mapa.get(n)[0];
  };
  const opcao = (f, v) => (Array.isArray(f.op[0]) ? (f.op.find(o => norm(o[1]) === norm(v)) || [v])[0] : v);
  const chave = chaveDe(k);
  const res = { criados: 0, atualizados: 0, ignoradas, erros: [] };
  const superiores = []; // o superior pode estar numa linha mais abaixo do arquivo

  linhas.slice(1).forEach((lin, i) => {
    const num = i + 2;
    try {
      R.tx(() => {
        const body = {};
        let superior = '';
        cab.forEach((f, j) => {
          if (!f) return;
          let v = (lin[j] ?? '').trim();
          if (colab && f.n === 'superior_id') { superior = v; return; }
          if (f.t === 'ref' && v) v = refId(f.ref, v, f);
          if (f.t === 'refs') v = v ? v.split(',').map(x => refId(f.ref, x.trim(), f)) : [];
          if (f.t === 'opcao' && v) v = opcao(f, v);
          if (f.t === 'sim' && v) v = /^(s|sim|1|true)$/i.test(v) ? '1' : '0';
          body[f.n] = v;
        });
        const cpf = body.cpf ? String(body.cpf).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : '';
        let atual = colab && cpf ? c.listar('colaborador').find(o => o.cpf === cpf) : null;
        if (!colab) {
          // compara o valor já lido do formulário, como a regra de duplicidade; sem
          // campo único, só a linha idêntica conta como a mesma (reimportar não duplica)
          const { dados } = lerForm(k, body, c, null);
          const igual = (a, b) => (typeof a === 'string' && typeof b === 'string' ? norm(a) === norm(b) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
          const nomes = chave || camposDe(k, c).map(f => f.n);
          if (!chave || chave.every(n => dados[n] != null)) atual = c.listar(k.kind).find(o => nomes.every(n => igual(dados[n], o[n]))) || null;
        }
        const { dados, erros } = lerForm(k, body, c, atual || null, { parcial: Boolean(atual) });
        if (erros.length) throw new Error(erros.join(' '));
        let id = atual?.id;
        if (atual) { R.atualizar(c.office, k.kind, atual.id, dados); res.atualizados++; } else { id = R.criar(c.office, k.kind, dados, usuario); res.criados++; }
        if (superior) superiores.push({ id, superior, num });
      });
    } catch (e) {
      // a transação desfez a linha, inclusive um departamento criado por ela
      for (const kind of Object.keys(refs)) delete refs[kind];
      res.erros.push(`Linha ${num}: ${e.message}`);
    }
  });

  for (const { id, superior, num } of superiores) {
    delete refs.colaborador;
    const ids = mapaRef('colaborador').get(norm(superior)) || [];
    if (ids.length !== 1) { res.erros.push(`Linha ${num}: superior direto "${superior}" ${ids.length ? 'tem mais de um cadastro' : 'não encontrado'}.`); continue; }
    const p = R.obter(c.office, 'colaborador', id);
    R.atualizar(c.office, 'colaborador', id, { ...R.soDados(p), superior_id: ids[0] });
  }
  return res;
}

module.exports = { parseCsv, importar, modelo };

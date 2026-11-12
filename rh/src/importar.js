'use strict';
// Importação por CSV de qualquer cadastro, inclusive o arquivo que o próprio
// sistema exporta. Reconhece as colunas pelo rótulo do campo, sem diferenciar
// acentos ou maiúsculas. Registro já existente atualiza só as colunas presentes
// (colaborador pelo CPF; os demais pelos campos únicos ou pelo nome); os outros
// viram cadastro novo. Departamento, cargo, filial e unidade que ainda não
// existem são criados pelo nome, assim como grupos de competências; as demais
// referências precisam já existir. Lista na mesma célula: separada por | ou vírgula.
const R = require('./db');
const { KINDS, rotulo } = require('./modelos');
const { lerForm, norm } = require('./crud');
const { ve } = require('./acesso');
const { quadrante } = require('./metricas');

const CRIA_PELO_NOME = ['departamento', 'cargo', 'filial', 'unidade', 'grupo_competencia'];

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
          if (f.t === 'refs') v = v ? v.split(v.includes('|') ? '|' : ',').filter(x => x.trim()).map(x => refId(f.ref, x.trim(), f)) : [];
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

// ---------------------------------------------------------------- avaliações da Sólides
// Uma linha por competência avaliada. Vira uma avaliação por pessoa no ciclo do
// ano, com as notas guardadas em itens. A Sólides dá notas de 1 a 5; o RH guarda de
// 0 a 10, então cada nota é multiplicada por 2. Competências técnicas formam o Desempenho
// e as comportamentais o Comportamento, os dois eixos do 9box; sem esses grupos,
// Desempenho é a média ponderada de todas as notas.
const coluna = (cab, nome) => cab.findIndex(h => norm(h) === norm(nome));
const ehAvaliacaoSolides = texto => {
  const cab = parseCsv(String(texto).split(/\r?\n/, 1)[0])[0] || [];
  return coluna(cab, 'Nome avaliado') >= 0 && coluna(cab, 'Competência') >= 0 && coluna(cab, 'Nota') >= 0;
};
const dataIso = s => { const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

function importarAvaliacoes(texto, c, usuario) {
  const [cab, ...linhas] = parseCsv(texto);
  const col = Object.fromEntries(Object.entries({ avaliado: 'Nome avaliado', avaliador: 'Nome avaliador', grupo: 'Grupo de competência', competencia: 'Competência', peso: 'Peso da competência', nota: 'Nota', auto: 'Auto avaliação', comentario: 'Comentário por competência', geral: 'Comentário geral' }).map(([k, n]) => [k, coluna(cab, n)]));
  const iData = coluna(cab, 'Data da avaliação'), iResp = cab.map(norm).lastIndexOf(norm('Data da avaliação'));
  const res = { criados: 0, atualizados: 0, ignoradas: [], erros: [], destino: 'avaliacoes' };
  const validas = linhas.filter(l => norm(l[col.auto] ?? '') !== 'sim' && Number(l[col.nota]) >= 1 && Number(l[col.nota]) <= 5);
  if (!validas.length) { res.erros.push('Nenhuma nota de avaliador encontrada no arquivo.'); return res; }
  const inicios = validas.map(l => dataIso(l[iData])).filter(Boolean).sort(), fins = validas.map(l => dataIso(l[iResp])).filter(Boolean).sort();
  const ano = (inicios[0] || fins[0] || '').slice(0, 4);
  if (!ano) { res.erros.push('O arquivo não traz a data da avaliação.'); return res; }

  const pessoas = new Map();
  for (const l of validas) {
    const n = norm(l[col.avaliado]);
    pessoas.set(n, [...(pessoas.get(n) || []), l]);
  }
  const colabs = R.listar(c.office, 'colaborador');
  R.tx(() => {
    const titulo = `Avaliação de Desempenho ${ano}`;
    const inicio = inicios[0] || fins[0], fim = fins[fins.length - 1] || inicio;
    const ciclo = R.listar(c.office, 'ciclo').find(x => norm(x.titulo) === norm(titulo));
    const cicloId = ciclo?.id ?? R.criar(c.office, 'ciclo', { titulo, inicio, fim, status: 'Encerrado' }, usuario);
    const avaliacoes = R.listar(c.office, 'avaliacao');
    for (const [n, ls] of pessoas) {
      const achados = colabs.filter(p => norm(p.nome) === n);
      if (achados.length !== 1) { res.erros.push(`${ls[0][col.avaliado]}: ${achados.length ? 'há mais de um cadastro' : 'não está em Colaboradores'}.`); continue; }
      const itens = ls.map(l => ({ grupo: l[col.grupo].trim(), competencia: l[col.competencia].trim(), peso: Number(l[col.peso]) || 1, nota: Number(l[col.nota]) * 2, comentario: l[col.comentario].trim().replace(/^-$/, '') }));
      const mediaDe = l => (l.length ? Math.round((l.reduce((s, i) => s + i.nota * i.peso, 0) / l.reduce((s, i) => s + i.peso, 0)) * 100) / 100 : null);
      const doGrupo = re => mediaDe(itens.filter(i => re.test(norm(i.grupo))));
      const atual = avaliacoes.find(a => a.ciclo_id === cicloId && a.colaborador_id === achados[0].id);
      const dados = { ...(atual ? R.soDados(atual) : { potencial: null }), ciclo_id: cicloId, colaborador_id: achados[0].id, desempenho: doGrupo(/tecnic/) ?? mediaDe(itens),
        avaliador: [...new Set(ls.map(l => l[col.avaliador].trim()))].join(', '), data_resposta: ls.map(l => dataIso(l[iResp])).filter(Boolean).sort().pop() || null,
        comentario: (ls[0][col.geral] || '').trim() || null, itens };
      dados.potencial = doGrupo(/comportament/) ?? dados.potencial;
      if (atual) { R.atualizar(c.office, 'avaliacao', atual.id, dados); res.atualizados++; } else { R.criar(c.office, 'avaliacao', dados, usuario); res.criados++; }
    }
  });
  return res;
}

// ---------------------------------------------------------------- 9box da Sólides
// Uma linha por pessoa, com os dois eixos de 0 a 100 (no RH, de 0 a 10). Completa a avaliação mais
// recente de cada uma, que precisa já existir: o arquivo não traz as datas do ciclo.
const singular = s => norm(s).replace(/s$/, '');
const ehNoveBoxSolides = texto => {
  const cab = parseCsv(String(texto).split(/\r?\n/, 1)[0])[0] || [];
  return ['Nome do Avaliado', 'Comportamento', 'Desempenho', 'Quadrante'].every(n => coluna(cab, n) >= 0);
};

function importarNoveBox(texto, c) {
  const [cab, ...linhas] = parseCsv(texto);
  const col = n => coluna(cab, n);
  const res = { criados: 0, atualizados: 0, ignoradas: [], erros: [], destino: 'avaliacoes' };
  const colabs = R.listar(c.office, 'colaborador'), avaliacoes = R.listar(c.office, 'avaliacao');
  R.tx(() => {
    for (const l of linhas) {
      const nome = l[col('Nome do Avaliado')].trim();
      const [comportamento, desempenho] = ['Comportamento', 'Desempenho'].map(n => Math.round(Number(l[col(n)]) * 10) / 100);
      if (!(comportamento >= 0 && comportamento <= 10 && desempenho >= 0 && desempenho <= 10)) { res.erros.push(`${nome}: notas fora da escala de 0 a 100.`); continue; }
      const achados = colabs.filter(p => norm(p.nome) === norm(nome));
      if (achados.length !== 1) { res.erros.push(`${nome}: ${achados.length ? 'há mais de um cadastro' : 'não está em Colaboradores'}.`); continue; }
      const atual = avaliacoes.find(a => a.colaborador_id === achados[0].id);
      if (!atual) { res.erros.push(`${nome}: importe antes o arquivo de notas da avaliação.`); continue; }
      R.atualizar(c.office, 'avaliacao', atual.id, { ...R.soDados(atual), desempenho, potencial: comportamento });
      res.atualizados++;
      const noArquivo = l[col('Quadrante')].trim(), noRh = quadrante(comportamento, desempenho);
      if (singular(noArquivo) !== singular(noRh)) res.erros.push(`${nome}: salvo, mas o arquivo diz "${noArquivo}" e o RH calculou "${noRh}".`);
    }
  });
  return res;
}

module.exports = { parseCsv, importar, modelo, ehAvaliacaoSolides, importarAvaliacoes, ehNoveBoxSolides, importarNoveBox };

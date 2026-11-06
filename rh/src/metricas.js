'use strict';
// Indicadores: funções puras sobre as listas de registros.
const { addMeses, addDias, anosEntre, diasEntre } = require('./datas');

// [[rótulo, quantidade], ...] do maior para o menor
function contar(linhas, chave, vazio = 'Não informado') {
  const m = new Map();
  for (const l of linhas) { const k = chave(l) || vazio; m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'pt-BR'));
}
const media = l => (l.length ? l.reduce((s, x) => s + x, 0) / l.length : 0);

function resumoQuadro(colaboradores, hoje) {
  const ativos = colaboradores.filter(c => c.situacao === 'Ativo');
  return {
    ativos, total: colaboradores.length,
    bloqueados: colaboradores.filter(c => c.situacao === 'Bloqueado').length,
    inativos: colaboradores.filter(c => c.situacao === 'Inativo').length,
    emExperiencia: ativos.filter(c => c.fim_experiencia && c.fim_experiencia >= hoje).length,
    idadeMedia: media(ativos.filter(c => c.nascimento).map(c => anosEntre(c.nascimento, hoje))),
    tempoMedio: media(ativos.filter(c => c.data_admissao).map(c => diasEntre(c.data_admissao, hoje) / 365.25)),
  };
}

// desligamentos dos últimos N meses; rotatividade = desligados no período sobre
// o quadro médio (média entre o quadro no início do período e o de hoje)
function resumoDesligamentos(desligamentos, colaboradores, hoje, meses = 12) {
  const desde = addDias(addMeses(hoje, -meses), 1);
  const lista = desligamentos.filter(d => d.data >= desde && d.data <= hoje);
  const porId = new Map(colaboradores.map(c => [c.id, c]));
  const tempoCasa = d => { const a = porId.get(d.colaborador_id)?.data_admissao; return a ? diasEntre(a, d.data) : null; };
  const quadroAtual = colaboradores.filter(c => c.situacao !== 'Inativo').length;
  // quadro no início do período = hoje + quem saiu - quem entrou no período
  const entradas = colaboradores.filter(c => c.data_admissao >= desde).length;
  const quadroInicial = Math.max(0, quadroAtual + lista.length - entradas);
  const quadroMedio = (quadroAtual + quadroInicial) / 2;
  return {
    lista, total: lista.length, desde,
    menosDeUmAno: lista.filter(d => { const t = tempoCasa(d); return t !== null && t < 365; }).length,
    valorRescisao: lista.reduce((s, d) => s + (d.valor_rescisao || 0), 0),
    taxa: quadroMedio ? (lista.length / quadroMedio) * 100 : 0,
  };
}

// matriz 3x3: nota 1-2 = baixo, 3 = médio, 4-5 = alto
const faixa = n => (n <= 2 ? 0 : n === 3 ? 1 : 2);
const QUADRANTES = [ // linha = potencial (de cima para baixo: alto, médio, baixo), coluna = desempenho
  ['Enigma', 'Crescimento', 'Talento de destaque'],
  ['Atenção', 'Base consistente', 'Alto desempenho'],
  ['Risco', 'Eficaz no limite', 'Especialista'],
];
function matriz(avaliacoes) {
  const m = QUADRANTES.map(l => l.map(nome => ({ nome, itens: [] })));
  for (const a of avaliacoes) m[2 - faixa(a.potencial)][faixa(a.desempenho)].itens.push(a);
  return m;
}

// eNPS = % promotores (9-10) - % detratores (0-6), sobre as notas da pergunta
function enps(notas) {
  if (!notas.length) return null;
  const prom = notas.filter(n => n >= 9).length, det = notas.filter(n => n <= 6).length;
  return Math.round(((prom - det) / notas.length) * 100);
}

// avaliados sem PDI em andamento, do menor desempenho para o maior; as listas
// vêm do registro mais novo para o mais antigo, então vale a última avaliação
function avaliadosSemPdi(colaboradores, avaliacoes, pdis) {
  const comPdi = new Set(pdis.filter(p => p.status !== 'Finalizado').map(p => p.colaborador_id));
  const ultima = new Map();
  for (const a of avaliacoes) if (!ultima.has(a.colaborador_id)) ultima.set(a.colaborador_id, a);
  return colaboradores.filter(c => c.situacao !== 'Inativo' && ultima.has(c.id) && !comPdi.has(c.id))
    .map(colaborador => ({ colaborador, avaliacao: ultima.get(colaborador.id) }))
    .sort((a, b) => a.avaliacao.desempenho - b.avaliacao.desempenho);
}

module.exports = { avaliadosSemPdi, contar, media, resumoQuadro, resumoDesligamentos, matriz, enps };

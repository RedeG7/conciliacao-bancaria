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

// 9box: abaixo de 2,5 = baixo; de 2,5 a 4 = médio; acima de 4 = alto. São os cortes
// que reproduzem os quadrantes da Sólides (50% e 80% da nota máxima). O comportamento
// fica guardado no campo potencial, que era o eixo vertical da matriz.
const faixa = n => (n < 2.5 ? 0 : n <= 4 ? 1 : 2);
const QUADRANTES = [ // linha = comportamento (de cima para baixo: alto, médio, baixo), coluna = desempenho
  ['Desenvolver técnica', 'Aprimorar técnica', 'Destaques'],
  ['Verificar situação', 'Aprimorar comportamento e técnica', 'Aprimorar comportamento'],
  ['Insuficientes', 'Trabalhar valores', 'Desenvolver comportamento'],
];
const quadrante = (comportamento, desempenho) => QUADRANTES[2 - faixa(comportamento)][faixa(desempenho)];
function matriz(avaliacoes) {
  // tom: 0 (comportamento e desempenho baixos) a 4 (os dois altos)
  const m = QUADRANTES.map((l, i) => l.map((nome, j) => ({ nome, tom: 2 - i + j, itens: [] })));
  for (const a of avaliacoes.filter(x => x.potencial != null)) m[2 - faixa(a.potencial)][faixa(a.desempenho)].itens.push(a);
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

// Visão Geral: situação do PDI vista por quem acompanha. Atraso vem antes da
// revisão, porque é o que pede ação primeiro.
const PDI_SITUACOES = ['Em andamento', 'Concluídos', 'Atrasados', 'Aguardando aprovação'];
function situacaoPdi(p, hoje) {
  if (p.status === 'Finalizado') return 'Concluídos';
  if (p.entrega && p.entrega < hoje) return 'Atrasados';
  return p.status === 'Em revisão' ? 'Aguardando aprovação' : 'Em andamento';
}

// pendente = ativo, admitido até o fim do ciclo e sem avaliação; só em ciclo aberto
function pendentesAvd(ciclo, colaboradores, avaliacoes) {
  if (ciclo.status !== 'Aberto') return [];
  const feitos = new Set(avaliacoes.map(a => a.colaborador_id));
  return colaboradores.filter(c => c.situacao === 'Ativo' && !feitos.has(c.id) && (!c.data_admissao || c.data_admissao <= ciclo.fim));
}

// média de desempenho por grupo, da maior para a menor
function mediasPor(avaliacoes, grupoDe) {
  const grupos = new Map();
  for (const a of avaliacoes) grupos.set(grupoDe(a), [...(grupos.get(grupoDe(a)) || []), a.desempenho]);
  return [...grupos].map(([g, n]) => [g, media(n)]).sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])));
}

module.exports = { avaliadosSemPdi, contar, media, resumoQuadro, resumoDesligamentos, matriz, quadrante, enps, PDI_SITUACOES, situacaoPdi, pendentesAvd, mediasPor };

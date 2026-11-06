'use strict';
// Perfil comportamental: questionário próprio da RedeG7 e cálculo, em funções
// puras. São 24 afirmações, 6 para cada um dos 4 estilos, respondidas de 1 a 5.
// Não é teste psicológico nem instrumento validado: serve de apoio à conversa
// com a pessoa e nunca como critério único de contratação ou desligamento.
const ESTILOS = {
  realizador: {
    nome: 'Realizador', resumo: 'Foco em resultado, decisão rápida e iniciativa.',
    fortes: ['Assume a frente de problemas', 'Decide com agilidade', 'Mantém o foco na meta'],
    cuidados: ['Pode atropelar quem precisa de mais tempo', 'Pode decidir sem ouvir o suficiente'],
    gestao: 'Combine o objetivo e dê autonomia para chegar nele.',
  },
  conector: {
    nome: 'Conector', resumo: 'Foco em pessoas, comunicação e influência.',
    fortes: ['Cria relações com facilidade', 'Comunica e engaja o grupo', 'Traz energia ao ambiente'],
    cuidados: ['Pode perder detalhes e prazos', 'Pode se dispersar em muitas frentes'],
    gestao: 'Dê espaço para interagir e combine prazos com clareza.',
  },
  constante: {
    nome: 'Constante', resumo: 'Foco em estabilidade, cooperação e continuidade.',
    fortes: ['Sustenta a rotina com regularidade', 'Coopera e apoia o time', 'Tem paciência para ensinar'],
    cuidados: ['Pode resistir a mudanças repentinas', 'Pode evitar conversas difíceis'],
    gestao: 'Antecipe as mudanças e explique o motivo de cada uma.',
  },
  criterioso: {
    nome: 'Criterioso', resumo: 'Foco em qualidade, método e precisão.',
    fortes: ['Analisa antes de agir', 'Percebe erros e riscos', 'Segue padrões e procedimentos'],
    cuidados: ['Pode demorar a decidir', 'Pode se prender a detalhes de pouco impacto'],
    gestao: 'Passe informações completas e defina o nível de qualidade esperado.',
  },
};
const CHAVES = Object.keys(ESTILOS);

// a ordem alterna os estilos para a pessoa não perceber o grupo de cada frase
const QUESTOES = [
  ['realizador', 'Gosto de assumir o controle quando há um problema para resolver.'],
  ['conector', 'Gosto de conhecer pessoas novas.'],
  ['constante', 'Prefiro uma rotina previsível a dias cheios de imprevistos.'],
  ['criterioso', 'Confiro meu trabalho mais de uma vez antes de entregar.'],
  ['realizador', 'Prefiro decidir rápido a esperar ter todas as informações.'],
  ['conector', 'Consigo convencer as pessoas com facilidade.'],
  ['constante', 'Sou paciente quando alguém precisa de mais tempo.'],
  ['criterioso', 'Sigo regras e procedimentos mesmo quando ninguém está olhando.'],
  ['realizador', 'Metas desafiadoras me deixam mais motivado(a).'],
  ['conector', 'Fico à vontade falando para um grupo de pessoas.'],
  ['constante', 'Procuro manter a harmonia quando há conflito no time.'],
  ['criterioso', 'Busco dados e fatos antes de tomar uma decisão.'],
  ['realizador', 'Não me incomodo em discordar para defender um resultado.'],
  ['conector', 'Costumo animar o ambiente ao meu redor.'],
  ['constante', 'Prefiro mudanças graduais a mudanças repentinas.'],
  ['criterioso', 'Gosto de planejar as etapas em detalhes antes de começar.'],
  ['realizador', 'Costumo tomar a iniciativa sem esperar que me peçam.'],
  ['conector', 'Prefiro trabalhar com outras pessoas a trabalhar sozinho(a).'],
  ['constante', 'Costumo ajudar os colegas antes mesmo de me pedirem.'],
  ['criterioso', 'Percebo erros que outras pessoas não notam.'],
  ['realizador', 'Sinto-me bem competindo para alcançar um objetivo.'],
  ['conector', 'Expresso o que penso e sinto com facilidade.'],
  ['constante', 'Termino o que comecei antes de passar para outra tarefa.'],
  ['criterioso', 'Prefiro fazer certo a fazer rápido.'],
].map(([estilo, texto]) => ({ estilo, texto }));

const ESCALA = [[1, 'Discordo totalmente'], [2, 'Discordo'], [3, 'Em parte'], [4, 'Concordo'], [5, 'Concordo totalmente']];
const ORDEM_FAIXAS = ['Baixo', 'Médio', 'Alto'];
const faixa = v => (v >= 70 ? 'Alto' : v >= 40 ? 'Médio' : 'Baixo');
const SECUNDARIO_ATE = 10; // pontos abaixo do principal para contar como 2º estilo

// respostas de 1 a 5, na ordem de QUESTOES; null se faltar ou houver valor inválido
function pontuar(respostas) {
  if (respostas.length !== QUESTOES.length || respostas.some(n => !Number.isInteger(n) || n < 1 || n > 5)) return null;
  const pontos = {};
  for (const e of CHAVES) {
    const notas = respostas.filter((_, i) => QUESTOES[i].estilo === e);
    pontos[e] = Math.round(((notas.reduce((s, n) => s + n, 0) / notas.length - 1) / 4) * 100);
  }
  const [principal, seg] = [...CHAVES].sort((a, b) => pontos[b] - pontos[a]);
  return { pontos, principal, secundario: pontos[principal] - pontos[seg] <= SECUNDARIO_ATE ? seg : null };
}

const nomePerfil = p => (p?.principal ? [p.principal, p.secundario].filter(Boolean).map(e => ESTILOS[e].nome).join(' e ') : '');
// o que se espera de um estilo: forte nele, moderado nos demais
const alvo = estilo => Object.fromEntries(CHAVES.map(e => [e, e === estilo ? 80 : 45]));
// aderência de 0 a 100: quanto menor a distância média entre os pontos, maior
function aderencia(a, b) {
  return Math.round(100 - CHAVES.reduce((s, e) => s + Math.abs(a[e] - b[e]), 0) / CHAVES.length);
}
function mediaPontos(lista) {
  return Object.fromEntries(CHAVES.map(e => [e, lista.length ? Math.round(lista.reduce((s, p) => s + p.pontos[e], 0) / lista.length) : 0]));
}

module.exports = { ESTILOS, CHAVES, QUESTOES, ESCALA, ORDEM_FAIXAS, faixa, pontuar, nomePerfil, alvo, aderencia, mediaPontos };

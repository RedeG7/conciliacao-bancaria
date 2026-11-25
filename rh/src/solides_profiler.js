'use strict';
// Importação dos resultados do Profiler da Sólides para os perfis do RH.
// Recebe, por pessoa, os percentuais dos 4 estilos, níveis de energia,
// indicadores e habilidades como a Sólides calcula, e grava num registro
// "perfil" já respondido. Os 4 estilos da Sólides viram os 4 estilos daqui:
// executor = Realizador, comunicador = Conector, planejador = Constante,
// analista = Criterioso. Os pontos (0 a 100) saem dos percentuais: o estilo
// mais forte vale 80 e os outros ficam na mesma proporção.
const P = require('./comportamental');

const DE_PARA = { executor: 'realizador', comunicador: 'conector', planejador: 'constante', analista: 'criterioso' };
const INDICADORES = [
  ['nivelenergia', 'Energia'], ['nivelestress', 'Estresse'], ['ia_nivel', 'Aproveitamento'], ['moral_nivel', 'Moral'],
  ['nivelip', 'Positividade'], ['amplitude_nivel', 'Amplitude'], ['niveltempo', 'Tempo de resposta'], ['flex_nivel', 'Flexibilidade'],
  ['nivel_incitab', 'Incitabilidade'], ['nivel_energperfil', 'Energia do perfil'],
];
const HABILIDADES = [
  ['orientadorsultado', 'Orientação a resultado'], ['proatividade', 'Proatividade'], ['automotivacao', 'Automotivação'], ['multitarefas', 'Multitarefas'],
  ['dinamismo', 'Dinamismo'], ['dominancia', 'Dominância'], ['rigorosidade', 'Rigor'], ['extroversao', 'Extroversão'],
  ['sociabilidade', 'Sociabilidade'], ['relac_interpes', 'Relacionamento interpessoal'], ['orientadorelacionamento', 'Orientação a relacionamento'], ['tolerancia', 'Tolerância'],
  ['empatia', 'Empatia'], ['capac_ouvir', 'Capacidade de ouvir'], ['planejamento', 'Planejamento'], ['concentracao', 'Concentração'],
  ['condescendencia', 'Condescendência'], ['organizacao', 'Organização'], ['detalhismo', 'Detalhismo'], ['perfil_tecnico', 'Perfil técnico'],
];
const SECUNDARIO_ATE = 10;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const sem = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const dataIso = s => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);

// converte os dados de uma pessoa (formato da Sólides) nos campos do perfil
function converter(x) {
  const pct = {}, energia = {}, natural = {}, adaptado = {};
  for (const [de, para] of Object.entries(DE_PARA)) {
    pct[para] = num(x.percentuais?.[de]);
    energia[para] = num(x.energia?.[de]);
    const d = x.detalhado?.[de];
    natural[para] = Array.isArray(d) ? num(d[0]) : null;
    adaptado[para] = Array.isArray(d) ? num(d[1]) : null;
  }
  if (P.CHAVES.some(e => pct[e] == null || pct[e] < 0)) return null;
  const max = Math.max(...P.CHAVES.map(e => pct[e]));
  if (!(max > 0)) return null;
  const pontos = Object.fromEntries(P.CHAVES.map(e => [e, Math.round((pct[e] / max) * 80)]));
  const [principal, seg] = [...P.CHAVES].sort((a, b) => pct[b] - pct[a]);
  const secundario = pontos[principal] - pontos[seg] <= SECUNDARIO_ATE ? seg : null;
  const indicadores = Object.fromEntries(INDICADORES.map(([k]) => [k, num(x.indicadores?.[k])]).filter(([, v]) => v != null));
  const habilidades = Object.fromEntries(HABILIDADES.map(([k]) => [k, num(x.habilidades?.[k])]).filter(([, v]) => v != null).map(([k, v]) => [k, Math.round(v)]));
  return {
    pontos, principal, secundario,
    solides: {
      id: num(x.id), letra: String(x.letra || '').slice(0, 10), percentuais: pct, energia, natural, adaptado, indicadores, habilidades,
      tempo: num(x.tempo), cargo: String(x.cargo || '').trim().slice(0, 200), departamento: String(x.departamento || '').trim().slice(0, 200),
    },
  };
}

// monta o plano: para cada pessoa, o perfil que será criado ou atualizado e o colaborador vinculado
function planejar(pessoas, { colaboradores, perfis }) {
  const porNome = new Map(), porEmail = new Map();
  for (const c of colaboradores) {
    porNome.set(sem(c.nome), c);
    for (const e of [c.email, c.email_corporativo]) if (e) porEmail.set(sem(e), c);
  }
  return pessoas.map(x => {
    const nome = String(x.nome || '').trim().replace(/\s+/g, ' ').slice(0, 200), email = String(x.email || '').trim().toLowerCase().slice(0, 200);
    const conv = converter(x);
    if (!nome || !conv) return { nome, email, erro: 'Dados incompletos.' };
    const colab = porEmail.get(sem(email)) || porNome.get(sem(nome)) || null;
    // só reaproveita perfil já importado da Sólides ou ainda aguardando resposta:
    // um questionário respondido aqui nunca é sobrescrito
    const livres = perfis.filter(p => p.origem === 'Sólides' || p.status === 'Aguardando');
    const perfil = livres.find(p => p.solides?.id && p.solides.id === conv.solides.id)
      || livres.find(p => email && sem(p.email) === sem(email))
      || (colab ? livres.find(p => p.colaborador_id === colab.id) : null) || null;
    return { nome, email, colab, perfil, conv, resposta: dataIso(x.resposta), envio: dataIso(x.envio) };
  });
}

// dados do registro "perfil" a gravar para um item do plano
function dadosPerfil(item, atual = {}) {
  return {
    ...atual,
    nome: atual.nome || item.nome, email: atual.email || item.email, vinculo: item.colab ? 'Colaborador' : atual.vinculo || 'Colaborador',
    colaborador_id: item.colab?.id ?? atual.colaborador_id ?? null,
    status: 'Respondido', origem: 'Sólides',
    data_envio: atual.data_envio || item.envio || item.resposta, data_resposta: item.resposta || atual.data_resposta,
    pontos: item.conv.pontos, principal: item.conv.principal, secundario: item.conv.secundario, solides: item.conv.solides,
  };
}

module.exports = { DE_PARA, INDICADORES, HABILIDADES, converter, planejar, dadosPerfil };

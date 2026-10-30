'use strict';
// Tabelas de parâmetros do cálculo (Cadastros). Nenhum percentual fica no código
// dos simuladores (src/calc.js): tudo é lido daqui, da tabela "params" do banco.
//
// Os valores iniciais (seed) são um PONTO DE PARTIDA para o time fiscal conferir
// contra a IN RFB nº 2.021/2021 e alterações - todos nascem com a observação
// "validar com o fiscal" e podem ser trocados na tela Cadastros > Parâmetros.
// VAU e Selic não têm valor inicial: são publicados mensalmente (RFB / BCB) e
// entram pela importação de CSV.

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

const DESTINACOES = [
  'Residência unifamiliar', 'Residência multifamiliar', 'Edifício de garagens', 'Galpão industrial',
  'Conjunto habitacional popular', 'Comercial', 'Casa popular',
];
const TIPOS_OBRA = ['Alvenaria', 'Madeira', 'Mista', 'Alvenaria interesse social', 'Madeira/mista interesse social'];
const CATEGORIAS = ['Obra nova', 'Acréscimo', 'Demolição', 'Reforma'];
const AREAS_COMPLEMENTARES = ['Quadra', 'Piscina', 'Garagem', 'Posto de combustível'];
const REGIMES = ['Simples Nacional', 'Lucro Presumido', 'Lucro Real', 'Desoneração (CPRB)'];

const VALIDAR = 'Valor inicial - validar com o fiscal (IN RFB 2.021/2021)';

// colunas: quais campos a tabela usa além de "valor" (uf, chave, vigencia)
const TABELAS = {
  vau: {
    titulo: 'VAU por UF × destinação', unidade: 'R$/m²', colunas: ['uf', 'chave', 'vigencia'],
    rotuloChave: 'Destinação', opcoesChave: DESTINACOES, importavel: true,
    ajuda: 'Valor Unitário (R$/m²) publicado mensalmente pela RFB. CSV: uf;destinação;vigência(AAAA-MM);valor',
  },
  selic: {
    titulo: 'Taxa Selic mensal', unidade: '% no mês', colunas: ['chave'], rotuloChave: 'Mês (AAAA-MM)', importavel: true,
    ajuda: 'Selic acumulada no mês (Receita Federal / BCB). CSV: mês(AAAA-MM);percentual',
  },
  categoria: {
    titulo: '% de área por categoria', unidade: '% da área', colunas: ['chave'], rotuloChave: 'Categoria', opcoesChave: CATEGORIAS,
    ajuda: 'Percentual da área da destinação considerado no custo, conforme a categoria da obra.',
    seed: [['Obra nova', 100], ['Acréscimo', 100], ['Reforma', 35], ['Demolição', 10]],
  },
  tipo_obra: {
    titulo: '% de mão de obra por tipo de obra (material)', unidade: '% do COD', colunas: ['chave'], rotuloChave: 'Tipo de obra', opcoesChave: TIPOS_OBRA,
    ajuda: 'Percentual do Custo da Obra por Destinação (COD) que vira RMT (remuneração da mão de obra total).',
    seed: [['Alvenaria', 20], ['Madeira', 15], ['Mista', 15], ['Alvenaria interesse social', 20], ['Madeira/mista interesse social', 15]],
  },
  fator_social: {
    titulo: 'Fator social (somente pessoa física)', unidade: '%', colunas: ['chave'], rotuloChave: 'Área até (m²)',
    ajuda: 'Faixas pela área total da obra: a RMT da pessoa física é multiplicada pelo percentual da primeira faixa que comporta a área.',
    seed: [['100', 20], ['200', 40], ['300', 55], ['400', 70], ['999999999', 90]],
  },
  area_complementar: {
    titulo: '% de equivalência das áreas complementares', unidade: '% da área', colunas: ['chave'], rotuloChave: 'Área | coberta/descoberta',
    opcoesChave: AREAS_COMPLEMENTARES.flatMap(a => [`${a} | coberta`, `${a} | descoberta`]),
    ajuda: 'Percentual da área complementar somado à área da obra (avaliado pela destinação principal).',
    seed: AREAS_COMPLEMENTARES.flatMap(a => [[`${a} | coberta`, 50], [`${a} | descoberta`, 25]]),
  },
  concreto_usinado: {
    titulo: '% de redução por concreto usinado (UF × destinação)', unidade: '% do COD', colunas: ['uf', 'chave'], rotuloChave: 'Destinação',
    opcoesChave: DESTINACOES, aceitaCuringa: true,
    ajuda: 'Redução do COD quando a destinação usou concreto usinado. Use * em UF/destinação para valer para todas.',
    seed: [['*', '*', 5]],
  },
  pre_moldado: {
    titulo: 'Pré-moldados / pré-fabricados', unidade: '%', colunas: ['chave'], rotuloChave: 'Parâmetro',
    opcoesChave: ['Limite mínimo das NFs (% do COD)', 'Redução da RMT'],
    ajuda: 'Quando as NFs de pré-moldados atingem o limite do COD, a RMT é reduzida pelo percentual de redução.',
    seed: [['Limite mínimo das NFs (% do COD)', 40], ['Redução da RMT', 70]],
  },
  aliquota: {
    titulo: 'Alíquotas sobre a RMT', unidade: '%', colunas: ['chave'], rotuloChave: 'Contribuição',
    ajuda: 'Somadas e aplicadas sobre a remuneração apurada para estimar o INSS da obra.',
    seed: [['Patronal (CPP)', 20], ['GILRAT/RAT', 3], ['Terceiros', 5.8], ['Segurados', 8]],
  },
  fator_ajuste: {
    titulo: 'Fator de ajuste (eSocial / GFIP / GPS)', unidade: '%', colunas: ['chave'], rotuloChave: 'Parâmetro',
    opcoesChave: ['Remuneração mínima declarada (% da RMT)', 'Redução da diferença apurada'],
    ajuda: 'Se a remuneração declarada atingir o mínimo da RMT, a diferença a recolher é reduzida pelo percentual de redução.',
    seed: [['Remuneração mínima declarada (% da RMT)', 50], ['Redução da diferença apurada', 100]],
  },
  regime: {
    titulo: '% de retenção por regime de tributação (PJ NF)', unidade: '% da base', colunas: ['chave'], rotuloChave: 'Regime', opcoesChave: REGIMES,
    ajuda: 'Alíquota de retenção sobre a base da nota fiscal de serviço (cessão de mão de obra / empreitada).',
    seed: [['Simples Nacional', 11], ['Lucro Presumido', 11], ['Lucro Real', 11], ['Desoneração (CPRB)', 3.5]],
  },
  servico_pj: {
    titulo: '% de base por serviço específico (PJ NF)', unidade: '% da NF', colunas: ['chave'], rotuloChave: 'Serviço',
    ajuda: 'Base de cálculo da retenção como percentual do valor da nota, conforme o serviço contratado.',
    seed: [['Somente mão de obra', 100], ['Mão de obra com material/equipamento (sem discriminar)', 50],
      ['Pavimentação asfáltica', 10], ['Terraplenagem, aterro, sondagem', 15], ['Drenagem', 50], ['Obras de arte (pontes, viadutos)', 45]],
  },
  parcelamento: {
    titulo: 'Parcelamento e-CAC', unidade: '', colunas: ['chave'], rotuloChave: 'Parâmetro',
    opcoesChave: ['Máximo de parcelas', 'Juros no mês do pagamento (%)', 'Parcela mínima PF (R$)', 'Parcela mínima PJ (R$)'],
    ajuda: 'Parcelamento ordinário: parcelas corrigidas pela Selic acumulada + juros no mês do pagamento.',
    seed: [['Máximo de parcelas', 60], ['Juros no mês do pagamento (%)', 1], ['Parcela mínima PF (R$)', 200], ['Parcela mínima PJ (R$)', 500]],
  },
  dctf: {
    titulo: 'DCTFWeb - encargos da folha da obra', unidade: '', colunas: ['chave'], rotuloChave: 'Parâmetro',
    opcoesChave: ['CPP (%)', 'Dia de vencimento', 'Multa de mora ao dia (%)', 'Multa de mora máxima (%)', 'Juros no mês do pagamento (%)',
      'MAED ao mês (%)', 'MAED máxima (%)', 'MAED mínima (R$)', 'Início da obrigatoriedade (AAAAMM)'],
    ajuda: 'Quadro de cálculo do envio DCTFWeb: CPP sobre a remuneração; competência vencida leva multa de mora, Selic acumulada e MAED.',
    seed: [['CPP (%)', 20], ['Dia de vencimento', 20], ['Multa de mora ao dia (%)', 0.33], ['Multa de mora máxima (%)', 20],
      ['Juros no mês do pagamento (%)', 1], ['MAED ao mês (%)', 2], ['MAED máxima (%)', 20], ['MAED mínima (R$)', 200],
      ['Início da obrigatoriedade (AAAAMM)', 202110]],
  },
  decadencia: {
    titulo: 'Decadência', unidade: 'anos', colunas: ['chave'], rotuloChave: 'Parâmetro', opcoesChave: ['Prazo decadencial (anos)'],
    ajuda: 'Competências com mais anos que este prazo (contados do 1º dia do exercício seguinte) não são exigíveis.',
    seed: [['Prazo decadencial (anos)', 5]],
  },
};

module.exports = { TABELAS, UFS, DESTINACOES, TIPOS_OBRA, CATEGORIAS, AREAS_COMPLEMENTARES, REGIMES, VALIDAR };

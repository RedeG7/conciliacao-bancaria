'use strict';
// Todos os cadastros do RH: campos, colunas da lista e regras de cada um. As
// telas (lista, formulário, exportação) saem daqui, em src/crud.js.
//
// Campo: F(nome, rótulo, tipo, opções). Tipos: texto, longo, data, numero,
// dinheiro, email, tel, opcao (op: lista), sim (Sim/Não), ref (ref: outro kind).
// Opções: req (obrigatório), cl (classe sensível, ver src/acesso.js), s (seção
// do formulário), min/max, interno (não aparece no formulário).
const { addDias } = require('./datas');

const F = (n, r, t = 'texto', o = {}) => ({ n, r, t, ...o });

const MESES = [['1', 'Janeiro'], ['2', 'Fevereiro'], ['3', 'Março'], ['4', 'Abril'], ['5', 'Maio'], ['6', 'Junho'], ['7', 'Julho'], ['8', 'Agosto'], ['9', 'Setembro'], ['10', 'Outubro'], ['11', 'Novembro'], ['12', 'Dezembro']];
const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const ENPS_PADRAO = 'De 0 a 10, o quanto você recomendaria esta empresa como um bom lugar para trabalhar?';

function cpfValido(cpf) {
  const c = String(cpf).replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}
const formataCpf = cpf => String(cpf).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

const nomeSe = 'Dados pessoais', endSe = 'Endereço', conSe = 'Contatos', ctrSe = 'Dados contratuais', docSe = 'Documentos', adiSe = 'Dados adicionais';

const colaborador = {
  kind: 'colaborador', slug: 'colaboradores', titulo: 'Colaboradores', singular: 'colaborador', icone: '👤', ordem: 'nome', ficha: true,
  desc: 'Cadastro completo, situação e histórico de cada pessoa.',
  secoes: [nomeSe, endSe, conSe, ctrSe, docSe, adiSe],
  abas: { campo: 'situacao', valores: ['Ativo', 'Bloqueado', 'Inativo'], padrao: 'Ativo' },
  campos: [
    F('situacao', 'Situação', 'texto', { interno: true }),
    F('nome', 'Nome completo', 'texto', { req: true, s: nomeSe }),
    F('nome_social', 'Nome social', 'texto', { s: nomeSe }),
    F('nascimento', 'Data de nascimento', 'data', { s: nomeSe }),
    F('genero', 'Gênero', 'opcao', { s: nomeSe, cl: 'pessoal', op: ['Feminino', 'Masculino', 'Não binário', 'Prefiro não informar'] }),
    F('raca', 'Raça/etnia', 'opcao', { s: nomeSe, cl: 'pessoal', op: ['Amarela', 'Branca', 'Indígena', 'Parda', 'Preta', 'Prefiro não informar'] }),
    F('pcd', 'Pessoa com deficiência', 'sim', { s: nomeSe, cl: 'pessoal' }),
    F('estado_civil', 'Estado civil', 'opcao', { s: nomeSe, cl: 'pessoal', op: ['Solteiro(a)', 'Casado(a)', 'União estável', 'Divorciado(a)', 'Viúvo(a)'] }),
    F('escolaridade', 'Escolaridade', 'opcao', { s: nomeSe, cl: 'pessoal', op: ['Fundamental', 'Médio', 'Técnico', 'Superior incompleto', 'Superior completo', 'Pós-graduação', 'Mestrado', 'Doutorado'] }),
    F('mae', 'Nome da mãe', 'texto', { s: nomeSe, cl: 'pessoal' }),
    F('pai', 'Nome do pai', 'texto', { s: nomeSe, cl: 'pessoal' }),
    F('cep', 'CEP', 'texto', { s: endSe, cl: 'pessoal' }), F('logradouro', 'Logradouro', 'texto', { s: endSe, cl: 'pessoal' }),
    F('numero', 'Número', 'texto', { s: endSe, cl: 'pessoal' }), F('complemento', 'Complemento', 'texto', { s: endSe, cl: 'pessoal' }),
    F('bairro', 'Bairro', 'texto', { s: endSe, cl: 'pessoal' }), F('cidade', 'Cidade', 'texto', { s: endSe, cl: 'pessoal' }),
    F('uf', 'UF', 'opcao', { s: endSe, cl: 'pessoal', op: UFS }),
    F('email', 'E-mail corporativo', 'email', { s: conSe }), F('email_pessoal', 'E-mail pessoal', 'email', { s: conSe, cl: 'pessoal' }),
    F('celular', 'Celular', 'tel', { s: conSe, cl: 'pessoal' }), F('telefone', 'Telefone', 'tel', { s: conSe, cl: 'pessoal' }),
    F('contato_emergencia', 'Contato de emergência', 'texto', { s: conSe, cl: 'pessoal' }),
    F('data_admissao', 'Data de admissão', 'data', { req: true, s: ctrSe }),
    F('departamento_id', 'Departamento', 'ref', { ref: 'departamento', s: ctrSe }),
    F('cargo_id', 'Cargo', 'ref', { ref: 'cargo', s: ctrSe }),
    F('filial_id', 'Filial', 'ref', { ref: 'filial', s: ctrSe }),
    F('unidade_id', 'Unidade', 'ref', { ref: 'unidade', s: ctrSe }),
    F('tipo_contrato', 'Tipo de contrato', 'opcao', { s: ctrSe, op: ['CLT', 'Estágio', 'Aprendiz', 'Temporário', 'Prazo determinado', 'Autônomo', 'PJ', 'Sócio'] }),
    F('turno', 'Turno', 'opcao', { s: ctrSe, op: ['Manhã', 'Tarde', 'Noite', 'Integral', 'Escala'] }),
    F('matricula', 'Matrícula', 'texto', { s: ctrSe }),
    F('superior_id', 'Superior direto', 'ref', { ref: 'colaborador', s: ctrSe }),
    F('salario', 'Salário', 'dinheiro', { s: ctrSe, cl: 'salario', min: 0 }),
    F('fim_experiencia', 'Fim da experiência', 'data', { s: ctrSe }),
    F('fim_contrato', 'Fim do contrato', 'data', { s: ctrSe }),
    F('periculosidade', 'Periculosidade', 'sim', { s: ctrSe }), F('insalubridade', 'Insalubridade', 'sim', { s: ctrSe }),
    F('cpf', 'CPF', 'texto', { s: docSe, cl: 'pessoal' }), F('rg', 'RG', 'texto', { s: docSe, cl: 'pessoal' }),
    F('cnh', 'CNH', 'texto', { s: docSe, cl: 'pessoal' }), F('titulo_eleitor', 'Título de eleitor', 'texto', { s: docSe, cl: 'pessoal' }),
    F('pis', 'PIS', 'texto', { s: docSe, cl: 'pessoal' }), F('ctps', 'CTPS', 'texto', { s: docSe, cl: 'pessoal' }),
    F('matricula_esocial', 'Matrícula eSocial', 'texto', { s: docSe, cl: 'pessoal' }),
    F('banco', 'Banco', 'texto', { s: docSe, cl: 'pessoal' }), F('agencia', 'Agência', 'texto', { s: docSe, cl: 'pessoal' }),
    F('conta', 'Conta', 'texto', { s: docSe, cl: 'pessoal' }), F('pix', 'Chave Pix', 'texto', { s: docSe, cl: 'pessoal' }),
    F('observacoes', 'Observações', 'longo', { s: adiSe }),
  ],
  colunas: ['nome', 'cargo_id', 'departamento_id', 'data_admissao', 'salario',
    { r: 'Banco de horas', v: (r, c) => c.saldoBanco(r.id) }],
  fixar(d, atual) {
    if (!atual) d.situacao = 'Ativo';
    if (d.cpf) d.cpf = formataCpf(d.cpf);
  },
  validar(d, c, atual) {
    const e = [];
    if (d.cpf && !cpfValido(d.cpf)) e.push('CPF inválido.');
    if (d.cpf && c.listar('colaborador', { inativos: true }).some(o => o.cpf === d.cpf && o.id !== atual?.id)) e.push('Já existe colaborador com este CPF.');
    return e;
  },
};

const simples = (kind, slug, titulo, singular, icone, campos, extra = {}) => ({
  kind, slug, titulo, singular, icone, campos, colunas: campos.map(c => c.n), ordem: campos[0].n, ...extra,
});
const colab = (o = {}) => F('colaborador_id', 'Colaborador', 'ref', { ref: 'colaborador', req: true, ...o });

const KINDS_LISTA = [
  colaborador,
  simples('departamento', 'departamentos', 'Departamentos', 'departamento', '🏬', [F('nome', 'Nome', 'texto', { req: true }), F('localizacao', 'Localização'), F('telefone', 'Telefone', 'tel')]),
  simples('cargo', 'cargos', 'Cargos', 'cargo', '🧩', [F('nome', 'Nome', 'texto', { req: true }), F('senioridade', 'Senioridade', 'opcao', { op: ['Estagiário', 'Assistente', 'Júnior', 'Pleno', 'Sênior', 'Coordenação', 'Gerência', 'Diretoria'] }), F('cbo', 'CBO'), F('piso', 'Piso salarial', 'dinheiro', { cl: 'salario', min: 0 })]),
  simples('filial', 'filiais', 'Filiais', 'filial', '🏢', [F('nome', 'Nome', 'texto', { req: true }), F('cnpj', 'CNPJ')]),
  simples('unidade', 'unidades', 'Unidades', 'unidade', '📍', [F('nome', 'Nome', 'texto', { req: true })]),
  simples('motivo_demissao', 'motivos-demissao', 'Motivos de demissão', 'motivo', '📝', [F('nome', 'Motivo', 'texto', { req: true })]),
  {
    kind: 'desligamento', slug: 'desligamentos', titulo: 'Desligamentos', singular: 'desligamento', icone: '🚪', novoBloqueado: true,
    desc: 'Lance pelo botão "Desligar" na ficha do colaborador.',
    campos: [colab(), F('data', 'Data do desligamento', 'data', { req: true }), F('motivo_id', 'Motivo', 'ref', { ref: 'motivo_demissao' }),
      F('tipo', 'Tipo', 'opcao', { req: true, op: ['Voluntário', 'Involuntário', 'Acordo', 'Fim de contrato'] }),
      F('valor_rescisao', 'Valor da rescisão', 'dinheiro', { cl: 'salario', min: 0 }), F('obs', 'Observação', 'longo')],
    colunas: ['colaborador_id', 'data', 'tipo', 'motivo_id', 'valor_rescisao'],
  },
  {
    kind: 'ocorrencia', slug: 'registros', titulo: 'Registros', singular: 'registro', icone: '🗂️',
    desc: 'Faltas, atrasos, promoções, advertências e outras ocorrências.',
    campos: [colab(), F('data', 'Data', 'data', { req: true }),
      F('tipo', 'Tipo', 'opcao', { req: true, op: ['Falta/Ausência', 'Atraso', 'Promoção', 'Falha/Erro', 'Ideia/Contribuição', 'Recontratação', 'Advertência', 'Suspensão', 'Subperformance', 'Folga', 'Outros'] }),
      F('classificacao', 'Classificação', 'opcao', { req: true, op: ['Positivo', 'Negativo', 'Neutro'] }),
      F('quantidade', 'Valor/qtd/horas', 'numero', { min: 0 }), F('comentario', 'Comentário', 'longo')],
    colunas: ['data', 'colaborador_id', 'tipo', 'classificacao', 'quantidade'], resumo: ['classificacao', 'tipo'],
  },
  {
    kind: 'feedback', slug: 'feedbacks', titulo: 'Feedbacks', singular: 'feedback', icone: '💬',
    campos: [colab(), F('data', 'Data', 'data', { req: true }), F('classificacao', 'Classificação', 'opcao', { req: true, op: ['Positivo', 'Construtivo', 'Neutro'] }), F('texto', 'Feedback', 'longo', { req: true })],
    colunas: ['data', 'colaborador_id', 'classificacao', { r: 'Autor', v: r => r.criado_por }], resumo: ['classificacao'],
  },
  {
    kind: 'ferias', slug: 'ferias', titulo: 'Férias', singular: 'férias', icone: '🏖️',
    desc: 'Programação e histórico, por período aquisitivo.',
    campos: [colab(), F('aquisitivo_inicio', 'Período aquisitivo: início', 'data', { req: true }), F('aquisitivo_fim', 'Período aquisitivo: fim', 'data', { req: true }),
      F('inicio', 'Início do gozo', 'data', { req: true }), F('dias', 'Dias', 'numero', { req: true, min: 1, max: 30, inteiro: true }),
      F('abono_dias', 'Dias vendidos (abono)', 'numero', { min: 0, max: 10, inteiro: true }),
      F('status', 'Status', 'opcao', { req: true, op: ['Programada', 'Aprovada', 'Gozada', 'Cancelada'] }),
      F('fim', 'Fim do gozo', 'data', { interno: true }), F('obs', 'Observação', 'longo')],
    colunas: ['colaborador_id', 'inicio', 'fim', 'dias', 'status'],
    fixar(d) { if (d.inicio && d.dias) d.fim = addDias(d.inicio, d.dias - 1); },
    validar: d => (d.aquisitivo_inicio && d.aquisitivo_fim && d.aquisitivo_fim < d.aquisitivo_inicio ? ['O fim do período aquisitivo não pode ser antes do início.'] : []),
  },
  {
    kind: 'banco_horas', slug: 'banco-de-horas', titulo: 'Banco de horas', singular: 'lançamento', icone: '⏱️',
    campos: [colab(), F('data', 'Data', 'data', { req: true }), F('tipo', 'Tipo', 'opcao', { req: true, op: ['Crédito', 'Débito'] }), F('horas', 'Horas', 'numero', { req: true, min: 0 }), F('motivo', 'Motivo')],
    colunas: ['data', 'colaborador_id', 'tipo', 'horas', 'motivo'],
  },
  {
    kind: 'saude', slug: 'registro-de-saude', titulo: 'Registro de saúde', singular: 'registro de saúde', icone: '🩺', cl: 'saude',
    desc: 'Dado sensível (LGPD): só aparece para quem tem acesso a saúde.',
    campos: [colab(), F('tipo_exame', 'Tipo de exame', 'opcao', { req: true, op: ['Admissional', 'Periódico', 'Retorno ao trabalho', 'Mudança de função', 'Demissional', 'Atestado'] }),
      F('procedimento', 'Procedimento'), F('cid', 'CID-10'), F('data', 'Data', 'data', { req: true }), F('dias_afastamento', 'Dias de afastamento', 'numero', { min: 0, inteiro: true }),
      F('proximo_exame', 'Próximo exame', 'data'), F('obs', 'Observação', 'longo')],
    colunas: ['data', 'colaborador_id', 'tipo_exame', 'dias_afastamento', 'proximo_exame'],
  },
  {
    kind: 'dependente', slug: 'dependentes', titulo: 'Dependentes', singular: 'dependente', icone: '👨‍👩‍👧', cl: 'pessoal', semMenu: true,
    campos: [colab(), F('nome', 'Nome', 'texto', { req: true }), F('parentesco', 'Parentesco', 'opcao', { op: ['Filho(a)', 'Cônjuge', 'Pai/Mãe', 'Outro'] }), F('nascimento', 'Nascimento', 'data'), F('cpf', 'CPF')],
    colunas: ['nome', 'parentesco', 'nascimento'],
  },
  simples('checklist', 'checklists', 'Checklists', 'tópico', '✅', [F('titulo', 'Tópico', 'texto', { req: true }), F('etapa', 'Etapa', 'opcao', { req: true, op: ['Contratação', 'Demissão'] })]),
  simples('grupo_competencia', 'grupos-competencias', 'Grupos de competências', 'grupo', '🧠', [F('nome', 'Nome', 'texto', { req: true }), F('categoria', 'Eixo na matriz', 'opcao', { op: ['Desempenho', 'Potencial'] })]),
  simples('competencia', 'competencias', 'Competências', 'competência', '🎯', [F('nome', 'Nome', 'texto', { req: true }), F('grupo_id', 'Grupo', 'ref', { ref: 'grupo_competencia' }), F('peso', 'Peso', 'numero', { min: 0 }), F('descricao', 'Descrição', 'longo')], { colunas: ['nome', 'grupo_id', 'peso'] }),
  {
    kind: 'ciclo', slug: 'ciclos-avaliacao', titulo: 'Ciclos de avaliação', singular: 'ciclo', icone: '🔄',
    campos: [F('titulo', 'Título', 'texto', { req: true }), F('inicio', 'Início', 'data', { req: true }), F('fim', 'Fim', 'data', { req: true }), F('status', 'Status', 'opcao', { req: true, op: ['Aberto', 'Encerrado'] })],
    colunas: ['titulo', 'inicio', 'fim', 'status'],
    validar: d => (d.inicio && d.fim && d.fim < d.inicio ? ['O fim do ciclo não pode ser antes do início.'] : []),
  },
  {
    kind: 'avaliacao', slug: 'avaliacoes', titulo: 'Avaliações', singular: 'avaliação', icone: '⭐', unico: ['ciclo_id', 'colaborador_id'],
    desc: 'Notas de 1 a 5, que alimentam a matriz de potencial e a análise de performance.',
    campos: [F('ciclo_id', 'Ciclo', 'ref', { ref: 'ciclo', req: true }), colab(),
      F('desempenho', 'Desempenho (1 a 5)', 'numero', { req: true, min: 1, max: 5, inteiro: true }), F('potencial', 'Potencial (1 a 5)', 'numero', { req: true, min: 1, max: 5, inteiro: true }),
      F('comentario', 'Comentário', 'longo')],
    colunas: ['ciclo_id', 'colaborador_id', 'desempenho', 'potencial'],
  },
  {
    kind: 'meta', slug: 'metas', titulo: 'Cadastro de metas', singular: 'meta', icone: '🏁',
    campos: [F('codigo', 'Código', 'texto', { req: true }), F('descricao', 'Descrição', 'texto', { req: true }), F('mes', 'Mês', 'opcao', { req: true, op: MESES }), F('ano', 'Ano', 'numero', { req: true, min: 2000, max: 2100, inteiro: true }), F('valor', 'Valor da meta', 'numero', { req: true, min: 0 })],
    colunas: ['codigo', 'descricao', 'mes', 'ano', 'valor'], rotulo: r => `${r.codigo} - ${r.descricao}`,
  },
  {
    kind: 'meta_colaborador', slug: 'controle-de-metas', titulo: 'Controle de metas', singular: 'vínculo de meta', icone: '📈', multi: 'colaborador_id', unico: ['meta_id', 'colaborador_id'],
    campos: [F('meta_id', 'Meta', 'ref', { ref: 'meta', req: true }), colab(), F('obtido', 'Valor obtido', 'numero', { min: 0 })],
    colunas: ['meta_id', 'colaborador_id', 'obtido', { r: 'Atingido', v: (r, c) => { const m = c.registro('meta', r.meta_id); return m?.valor ? `${Math.round(((r.obtido || 0) / m.valor) * 100)}%` : '-'; } }],
  },
  {
    kind: 'pdi', slug: 'pdi', titulo: 'PDI', singular: 'PDI', icone: '🌱', abas: { campo: 'status', valores: ['Aberto', 'Em revisão', 'Finalizado'] },
    desc: 'Plano de desenvolvimento individual.',
    campos: [colab(), F('titulo', 'Título', 'texto', { req: true }), F('superior_id', 'Superior', 'ref', { ref: 'colaborador' }), F('inicio', 'Início', 'data', { req: true }), F('entrega', 'Entrega', 'data', { req: true }),
      F('progresso', 'Progresso (%)', 'numero', { min: 0, max: 100, inteiro: true }), F('status', 'Status', 'opcao', { req: true, op: ['Aberto', 'Em revisão', 'Finalizado'] }), F('acoes', 'Ações combinadas', 'longo')],
    colunas: ['colaborador_id', 'titulo', 'superior_id', 'inicio', 'entrega', 'progresso'],
  },
  {
    kind: 'treinamento', slug: 'treinamentos', titulo: 'Treinamentos', singular: 'treinamento', icone: '🎓',
    campos: [F('titulo', 'Título', 'texto', { req: true }), F('categoria', 'Categoria'), F('modalidade', 'Modalidade', 'opcao', { op: ['Presencial', 'On-line', 'Híbrido'] }), F('instrutor', 'Instrutor'),
      F('inicio', 'Início', 'data'), F('fim', 'Fim', 'data'), F('carga_horaria', 'Carga horária', 'numero', { min: 0 }), F('investimento', 'Investimento', 'dinheiro', { min: 0, cl: 'salario' }),
      F('status', 'Status', 'opcao', { req: true, op: ['Planejado', 'Em andamento', 'Concluído', 'Cancelado'] })],
    colunas: ['titulo', 'categoria', 'inicio', 'carga_horaria', 'investimento', 'status'],
  },
  {
    kind: 'participacao', slug: 'participantes-treinamento', titulo: 'Participantes', singular: 'participante', icone: '🙋', multi: 'colaborador_id', unico: ['treinamento_id', 'colaborador_id'],
    desc: 'Quem fez cada treinamento.',
    campos: [F('treinamento_id', 'Treinamento', 'ref', { ref: 'treinamento', req: true }), colab(), F('status', 'Status', 'opcao', { req: true, op: ['Inscrito', 'Concluiu', 'Faltou'] }), F('nota', 'Nota', 'numero', { min: 0, max: 10 })],
    colunas: ['treinamento_id', 'colaborador_id', 'status', 'nota'],
  },
  {
    kind: 'pesquisa', slug: 'pesquisas', titulo: 'Pesquisas', singular: 'pesquisa', icone: '📋',
    desc: 'Clima e eNPS por link anônimo: nenhuma resposta fica ligada a uma pessoa.',
    campos: [F('titulo', 'Título', 'texto', { req: true }), F('categoria', 'Categoria', 'opcao', { req: true, op: ['Clima', 'eNPS', 'Outra'] }), F('status', 'Status', 'opcao', { req: true, op: ['Rascunho', 'Aberta', 'Encerrada'] }),
      F('disponivel_em', 'Disponível a partir de', 'data'), F('perguntas', 'Perguntas (uma por linha, nota de 0 a 10)', 'longo'), F('token', 'Link', 'texto', { interno: true })],
    colunas: ['titulo', 'categoria', 'status', 'disponivel_em', { r: 'Respostas', v: (r, c) => c.respostas(r.id) }],
    acoes: r => [[`/pesquisas/${r.id}`, 'Resultados']],
    fixar(d, atual, c) {
      if (!d.token) d.token = c.novoToken();
      if (d.categoria === 'eNPS' && !String(d.perguntas || '').trim()) d.perguntas = ENPS_PADRAO;
    },
    validar(d, c, atual) {
      const e = [];
      if (!String(d.perguntas || '').trim()) e.push('Escreva ao menos uma pergunta.');
      if (String(d.perguntas || '').split('\n').filter(l => l.trim()).length > 30) e.push('No máximo 30 perguntas.');
      if (atual && atual.perguntas !== d.perguntas && c.respostas(atual.id) > 0) e.push('As perguntas não podem mudar depois da primeira resposta.');
      return e;
    },
  },
  {
    kind: 'beneficio', slug: 'beneficios', titulo: 'Benefícios', singular: 'benefício', icone: '🎁',
    campos: [F('nome', 'Nome', 'texto', { req: true }), F('tipo', 'Tipo', 'opcao', { op: ['Alimentação', 'Refeição', 'Transporte', 'Saúde', 'Odontológico', 'Seguro de vida', 'Educação', 'Outro'] }), F('valor', 'Valor', 'dinheiro', { min: 0, cl: 'salario' }),
      F('periodicidade', 'Periodicidade', 'opcao', { op: ['Mensal', 'Anual', 'Única'] }), F('valor_descontado', 'Valor descontado', 'dinheiro', { min: 0, cl: 'salario' })],
    colunas: ['nome', 'tipo', 'valor', 'periodicidade', 'valor_descontado'],
  },
  {
    kind: 'beneficiario', slug: 'beneficiarios', titulo: 'Beneficiários', singular: 'beneficiário', icone: '🤝', multi: 'colaborador_id', unico: ['beneficio_id', 'colaborador_id'],
    campos: [F('beneficio_id', 'Benefício', 'ref', { ref: 'beneficio', req: true }), colab(), F('inicio', 'Início', 'data'), F('fim', 'Fim', 'data')],
    colunas: ['beneficio_id', 'colaborador_id', 'inicio', 'fim'],
  },
  {
    kind: 'faturamento', slug: 'faturamentos', titulo: 'Faturamentos', singular: 'faturamento', icone: '💰', cl: 'salario', unico: ['ano', 'mes'],
    desc: 'Faturamento mensal, base do indicador de produtividade.',
    campos: [F('ano', 'Ano', 'numero', { req: true, min: 2000, max: 2100, inteiro: true }), F('mes', 'Mês', 'opcao', { req: true, op: MESES }), F('valor', 'Valor', 'dinheiro', { req: true, min: 0 })],
    colunas: ['ano', 'mes', 'valor'],
  },
];

const KINDS = Object.fromEntries(KINDS_LISTA.map(k => [k.kind, k]));
const porSlug = slug => KINDS_LISTA.find(k => k.slug === slug);
const rotulo = (k, r) => (k.rotulo ? k.rotulo(r) : r.nome || r.titulo || `#${r.id}`);

// abas da ficha do colaborador
const HISTORICO = ['ocorrencia', 'feedback', 'ferias', 'banco_horas', 'saude', 'dependente', 'avaliacao', 'meta_colaborador', 'pdi', 'participacao', 'beneficiario', 'desligamento'];

module.exports = { KINDS, KINDS_LISTA, porSlug, rotulo, HISTORICO, MESES, ENPS_PADRAO, cpfValido, formataCpf };

'use strict';
// Avisos do Painel. Função pura: recebe os dados e a data de hoje, para os
// testes não dependerem do relógio.
const { addDias, addMeses, anosEntre, proximoAniversario } = require('./datas');

const ANTECEDENCIA_PADRAO = { experiencia: 15, contrato: 30, aniversario: 7, exame: 30, ferias: 60, pdi: 15, avaliacao: 15 };

function alertas(d, dias, hoje) {
  const saida = [];
  const janela = (data, n) => data && data <= addDias(hoje, n);
  const add = (tipo, data, texto, link) => saida.push({ tipo, data, texto, link, vencido: data < hoje });
  const ativos = d.colaboradores.filter(c => c.situacao !== 'Inativo');
  const ficha = c => `/cad/colaboradores/${c.id}/ficha`;

  for (const c of ativos) {
    if (c.fim_experiencia && c.fim_experiencia >= hoje && janela(c.fim_experiencia, dias.experiencia)) add('Experiência', c.fim_experiencia, `Fim da experiência de ${c.nome}`, ficha(c));
    if (c.fim_contrato && janela(c.fim_contrato, dias.contrato)) add('Contrato', c.fim_contrato, `Fim do contrato de ${c.nome}`, ficha(c));
    if (c.nascimento) {
      const prox = proximoAniversario(c.nascimento, hoje);
      if (janela(prox, dias.aniversario)) add('Aniversário', prox, c.nome, ficha(c));
    }
    // último período aquisitivo completo sem férias lançadas: o limite para
    // conceder é 12 meses depois do fim dele (CLT, art. 134)
    if (c.data_admissao && anosEntre(c.data_admissao, hoje) >= 1) {
      const anos = anosEntre(c.data_admissao, hoje);
      const inicio = addMeses(c.data_admissao, (anos - 1) * 12);
      const fim = addDias(addMeses(c.data_admissao, anos * 12), -1);
      const lancadas = d.ferias.some(f => f.colaborador_id === c.id && f.status !== 'Cancelada' && f.aquisitivo_inicio <= fim && f.aquisitivo_fim >= inicio);
      const limite = addMeses(fim, 12);
      if (!lancadas && janela(limite, dias.ferias)) add('Férias', limite, `Férias de ${c.nome} sem programação (período até ${fim.split('-').reverse().join('/')})`, ficha(c));
    }
  }
  const ids = new Set(ativos.map(c => c.id));
  const nome = id => d.colaboradores.find(c => c.id === id)?.nome || '';
  if (d.saude) { // só chega aqui para quem tem acesso a saúde
    const ultimo = new Map();
    for (const s of d.saude) if (s.proximo_exame && (!ultimo.has(s.colaborador_id) || s.proximo_exame > ultimo.get(s.colaborador_id))) ultimo.set(s.colaborador_id, s.proximo_exame);
    for (const [id, data] of ultimo) if (ids.has(id) && janela(data, dias.exame)) add('Exame', data, `Exame de ${nome(id)}`, `/cad/colaboradores/${id}/ficha`);
  }
  for (const p of d.pdis) if (p.status !== 'Finalizado' && ids.has(p.colaborador_id) && janela(p.entrega, dias.pdi)) add('PDI', p.entrega, `PDI "${p.titulo}" de ${nome(p.colaborador_id)}`, `/cad/pdi/${p.id}`);
  for (const a of d.ciclos) if (a.status === 'Aberto' && janela(a.fim, dias.avaliacao)) add('Avaliação', a.fim, `Fim do ciclo "${a.titulo}"`, `/cad/ciclos-avaliacao/${a.id}`);
  return saida.sort((a, b) => a.data.localeCompare(b.data));
}

module.exports = { alertas, ANTECEDENCIA_PADRAO };

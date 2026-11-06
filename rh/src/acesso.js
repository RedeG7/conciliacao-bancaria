'use strict';
// Papéis de acesso dentro do RH. Administrador do escritório e super
// administrador do Hub são sempre "admin"; os demais usuários começam em
// "leitura" (sem dados pessoais, salários nem saúde) até um admin mudar o papel
// em Configurações > Usuários e papéis.
//
// Cada campo sensível de src/modelos.js tem uma classe (cl):
//   salario = remuneração e valores  |  pessoal = documentos, banco, diversidade
//   saude   = exames, CID e afastamentos  |  perfil = perfil comportamental
const PAPEIS = {
  admin: { rotulo: 'Responsável (acesso total)', edita: true, apaga: true, configura: true, classes: ['salario', 'pessoal', 'saude', 'perfil'] },
  editor: { rotulo: 'Edita, mas não apaga', edita: true, apaga: false, configura: false, classes: ['salario', 'pessoal', 'saude', 'perfil'] },
  sem_salario: { rotulo: 'Edita, sem ver salários', edita: true, apaga: false, configura: false, classes: ['pessoal', 'saude', 'perfil'] },
  leitura: { rotulo: 'Apenas visualização', edita: false, apaga: false, configura: false, classes: [] },
};

const ve = (papel, cl) => !cl || PAPEIS[papel].classes.includes(cl);
const pode = (papel, acao) => Boolean(PAPEIS[papel]?.[acao]);

module.exports = { PAPEIS, ve, pode };

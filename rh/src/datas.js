'use strict';
// Datas no formato AAAA-MM-DD, sem hora: a conta é sempre em UTC para o horário
// de verão ou o fuso do servidor não mudarem o dia.
const d = iso => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
const iso = dt => dt.toISOString().slice(0, 10);

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDias = (s, n) => { const x = d(s); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
// 31/01 + 1 mês = 28 ou 29/02 (último dia do mês, sem pular para março)
function addMeses(s, n) {
  const x = d(s), dia = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  const ultimo = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(dia, ultimo));
  return iso(x);
}
const diasEntre = (a, b) => Math.round((d(b) - d(a)) / 864e5);
function anosEntre(a, b) {
  const x = d(a), y = d(b);
  let n = y.getUTCFullYear() - x.getUTCFullYear();
  if (y.getUTCMonth() < x.getUTCMonth() || (y.getUTCMonth() === x.getUTCMonth() && y.getUTCDate() < x.getUTCDate())) n -= 1;
  return n;
}
function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const x = d(s);
  return !Number.isNaN(x.getTime()) && iso(x) === s;
}
// próxima ocorrência de um dia/mês (aniversário) a partir de "base"
function proximoAniversario(nascimento, base) {
  const [, m, dia] = String(nascimento).split('-');
  const ano = Number(base.slice(0, 4));
  const este = `${ano}-${m}-${dia}`;
  const valido = dataValida(este) ? este : `${ano}-03-01`; // 29/02 em ano comum
  if (valido >= base) return valido;
  const prox = `${ano + 1}-${m}-${dia}`;
  return dataValida(prox) ? prox : `${ano + 1}-03-01`;
}

module.exports = { hoje, addDias, addMeses, diasEntre, anosEntre, dataValida, proximoAniversario };

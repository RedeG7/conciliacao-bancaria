'use strict';
// Preenchimento das tabelas de parâmetros a partir de fontes oficiais.
//
// Selic: API pública do Banco Central (SGS), série 4390 - "Taxa de juros -
// Selic acumulada no mês" (% a.m.), a mesma usada pela Receita para os juros
// de tributos pagos em atraso. Atualiza sozinha uma vez por dia
// (index.js) e pelo botão em Cadastros > Parâmetros > Selic.
//
// VAU: não tem API pública (só aparece no SERO, com login no e-CAC). Aqui fica
// o leitor do texto copiado da tela "Consultar Tabela VAU" do SERO: reconhece
// a destinação e o valor de cada linha.
const { db, gravarParam } = require('./db');
const { DESTINACOES } = require('./params');

const SELIC_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.4390/dados';
const SELIC_DESDE = '01/01/2016';
const OBS_BCB = 'Banco Central (SGS 4390)';

const gravar = (tabela, linha, usuario) => gravarParam(tabela, linha, usuario);

// Busca a série e grava os meses já encerrados (o mês corrente ainda não tem a
// taxa fechada). Devolve { gravados, ultimo }.
async function atualizarSelic({ fetchFn = fetch, hoje = new Date(), usuario = 'Banco Central' } = {}) {
  const ate = `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
  const resp = await fetchFn(`${SELIC_URL}?formato=json&dataInicial=${SELIC_DESDE}&dataFinal=${ate}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'SimuladorINSSObras/1.0' }, signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Banco Central respondeu ${resp.status}`);
  const dados = await resp.json();
  if (!Array.isArray(dados)) throw new Error('Resposta inesperada do Banco Central');
  const mesAtual = hoje.toISOString().slice(0, 7);
  const linhas = dados.map(d => {
    const [, m, a] = String(d.data || '').split('/');
    return { chave: `${a}-${m}`, valor: Number(String(d.valor).replace(',', '.')) };
  }).filter(l => /^\d{4}-\d{2}$/.test(l.chave) && l.chave < mesAtual && Number.isFinite(l.valor));
  db.exec('BEGIN');
  try {
    for (const l of linhas) gravar('selic', { chave: l.chave, valor: l.valor, obs: OBS_BCB }, usuario);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { gravados: linhas.length, ultimo: linhas.length ? linhas[linhas.length - 1].chave : null };
}

// atualização automática: ao subir (depois de 1 minuto) e a cada 24 horas
function agendarSelic() {
  const rodar = () => atualizarSelic().then(r => console.log(`Selic atualizada pelo Banco Central: ${r.gravados} meses (último ${r.ultimo})`))
    .catch(e => console.error('Falha ao atualizar a Selic pelo Banco Central:', e.message));
  setTimeout(rodar, 60e3).unref();
  setInterval(rodar, 24 * 3600e3).unref();
}

// ---------------------------------------------------------------- VAU colada do SERO
const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// palavras que identificam cada destinação no texto do SERO (a mais específica primeiro)
const CHAVES_DESTINO = [
  ['multifamiliar', 'Residência multifamiliar'], ['unifamiliar', 'Residência unifamiliar'],
  ['garage', 'Edifício de garagens'], ['galpao', 'Galpão industrial'],
  ['conj', 'Conjunto habitacional popular'], ['habitacional', 'Conjunto habitacional popular'],
  ['casa popular', 'Casa popular'], ['comercia', 'Comercial'],
];
const VALOR = /(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2}|\d+\.\d{2})(?!.*\d)/;
const destinoDe = linha => { const t = sem(linha); const c = CHAVES_DESTINO.find(([k]) => t.includes(k)); return c ? c[1] : null; };
const valorDe = linha => { const m = sem(linha).replace(/r\$\s*/g, '').match(VALOR); return m ? Number(m[1].includes(',') ? m[1].replace(/\./g, '').replace(',', '.') : m[1]) : null; };

// Devolve [{ destinacao, valor }]. Aceita a destinação e o valor na mesma linha
// ou o valor na linha seguinte (tabela copiada em colunas).
function lerVauColada(texto) {
  const linhas = String(texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const achados = new Map();
  for (let i = 0; i < linhas.length; i++) {
    const dest = destinoDe(linhas[i]);
    if (!dest || achados.has(dest)) continue;
    let valor = valorDe(linhas[i].replace(/^.*?(unifamiliar|multifamiliar|garagens?|industrial|popular|comercial)/i, ''));
    if (valor === null && i + 1 < linhas.length && !destinoDe(linhas[i + 1])) valor = valorDe(linhas[i + 1]);
    if (valor !== null && valor > 0) achados.set(dest, valor);
  }
  return DESTINACOES.filter(d => achados.has(d)).map(d => ({ destinacao: d, valor: achados.get(d) }));
}

// office '' = padrão da plataforma; id do escritório = ajuste só dele
function importarVauColada({ uf, vigencia, texto, office = '' }, usuario) {
  const itens = lerVauColada(texto);
  for (const i of itens) gravar('vau', { office, uf, chave: i.destinacao, vigencia, valor: i.valor, obs: 'Colado do SERO' }, usuario);
  return itens;
}

module.exports = { atualizarSelic, agendarSelic, lerVauColada, importarVauColada, OBS_BCB };

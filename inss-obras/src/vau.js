'use strict';
// Tabela VAU (SERO / RFB) - importação em lote no formato do "módulo VAU"
// (vau_modulo: JSON/CSV extraído da consulta "Tabela VAU" do e-CAC).
//
// Entrada (registros "largos", um por competência + UF):
//   JSON: {"registros": [{"competencia": "2026-01", "uf": "GO", "casa_popular": 1456.86, ...}]}
//   CSV : separador ';', decimal ',', competência AAAA-MM ou MM/AAAA, uma coluna por padrão
// Grava em params (tabela 'vau', vigência = competência, chave = destinação) com
// upsert por (competência, UF, padrão). Se qualquer registro for inválido, nada
// é gravado. Cada importação fica em vau_importacao.
// (A API de importação automática do módulo, api_vau.py, ainda não é publicada.)
const { db, tx, nowIso, gravarParam, paramReader } = require('./db');
const { UFS } = require('./params');

// padrões construtivos do SERO -> destinações do simulador
const PADROES = {
  casa_popular: 'Casa popular',
  comercial_salas_lojas: 'Comercial',
  conj_habitacional_popular: 'Conjunto habitacional popular',
  edificio_garagens: 'Edifício de garagens',
  galpao_industrial: 'Galpão industrial',
  residencial_multifamiliar: 'Residência multifamiliar',
  residencial_unifamiliar: 'Residência unifamiliar',
};
const FONTE = 'RFB e-CAC SERO';
const MAX_BYTES = 2_000_000; // a tabela inteira (2021-06 em diante) tem ~440 KB

db.exec(`CREATE TABLE IF NOT EXISTS vau_importacao (
  id INTEGER PRIMARY KEY AUTOINCREMENT, executado_em TEXT NOT NULL, origem TEXT NOT NULL, arquivo TEXT,
  office TEXT NOT NULL DEFAULT '', usuario TEXT, registros INTEGER NOT NULL, comp_inicio TEXT, comp_fim TEXT)`);

function competencia(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1]}`;
  throw new Error(`competência inválida: ${JSON.stringify(v)}`);
}
function valor(v) {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  let s = String(v ?? '').replace('R$', '').trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  const n = Number(s);
  if (!s || !Number.isFinite(n)) throw new Error(`valor inválido: ${JSON.stringify(v)}`);
  return Math.round(n * 100) / 100;
}

// JSON ou CSV -> registros largos
function lerRegistros(conteudo, nome = '') {
  const t = String(conteudo || '').replace(/^﻿/, '');
  if (nome.toLowerCase().endsWith('.json') || /^\s*[{[]/.test(t)) {
    const d = JSON.parse(t);
    return Array.isArray(d) ? d : d.registros || [];
  }
  const linhas = t.split(/\r?\n/).filter(l => l.trim());
  if (!linhas.length) return [];
  const cab = linhas[0].split(';').map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
  return linhas.slice(1).map(l => {
    const cel = l.split(';').map(c => c.trim().replace(/^"|"$/g, ''));
    const r = Object.fromEntries(cab.map((c, i) => [c, cel[i]]));
    if (r.mes !== undefined && r.competencia === undefined) r.competencia = r.mes;
    return r;
  });
}

// registros largos -> linhas (competencia, uf, destinacao, valor), validando tudo
function paraLinhas(registros) {
  const linhas = [], erros = [];
  registros.forEach((r, i) => {
    try {
      if (!r || typeof r !== 'object') throw new Error('registro vazio');
      const comp = competencia(r.competencia);
      const uf = String(r.uf ?? '').trim().toUpperCase();
      if (!UFS.includes(uf)) throw new Error(`UF inválida: ${JSON.stringify(r.uf)}`);
      const doRegistro = [];
      for (const [padrao, destinacao] of Object.entries(PADROES)) {
        if (r[padrao] === undefined || r[padrao] === null || r[padrao] === '') throw new Error(`coluna ausente: ${padrao}`);
        const v = valor(r[padrao]);
        if (!(v > 0)) throw new Error(`${padrao} com valor não positivo`);
        doRegistro.push({ competencia: comp, uf, padrao, destinacao, valor: v });
      }
      linhas.push(...doRegistro);
    } catch (e) {
      erros.push(`registro ${i + 1}: ${e.message}`);
    }
  });
  return { linhas, erros };
}

// office '' = padrão da plataforma; id do escritório = ajuste só dele
function importar({ conteudo, nome = '', origem = 'upload', office = '', usuario = '' }) {
  let registros;
  try { registros = lerRegistros(conteudo, nome); } catch (e) { return { registros: 0, erros: [`arquivo ilegível: ${e.message}`] }; }
  const { linhas, erros } = paraLinhas(registros);
  if (erros.length) return { registros: 0, erros };   // a tabela precisa ficar íntegra: nada é gravado
  if (!linhas.length) return { registros: 0, erros: ['arquivo sem registros'] };
  const comps = [...new Set(linhas.map(l => l.competencia))].sort();
  const ufs = [...new Set(linhas.map(l => l.uf))];
  tx(() => {
    for (const l of linhas) gravarParam('vau', { office, uf: l.uf, chave: l.destinacao, vigencia: l.competencia, valor: l.valor, obs: FONTE }, usuario || origem);
    db.prepare('INSERT INTO vau_importacao (executado_em, origem, arquivo, office, usuario, registros, comp_inicio, comp_fim) VALUES (?,?,?,?,?,?,?,?)')
      .run(nowIso(), origem, String(nome).slice(0, 200), office, usuario, linhas.length, comps[0], comps[comps.length - 1]);
  });
  return { registros: linhas.length, competencias: comps.length, ufs: ufs.length, inicio: comps[0], fim: comps[comps.length - 1], erros: [] };
}

const ultimaCompetencia = (office = '') => db.prepare("SELECT MAX(vigencia) AS c FROM params WHERE tabela = 'vau' AND (office = '' OR office = ?)").get(office).c || null;
const historico = (office = '', n = 10) => db.prepare("SELECT * FROM vau_importacao WHERE office = '' OR office = ? ORDER BY id DESC LIMIT ?").all(office, n);

// tabela "larga" (como no e-CAC): uma linha por competência + UF
function consultaLarga(office, { uf, ano } = {}) {
  const P = paramReader(office);
  const linhas = {};
  for (const r of P.list('vau')) {
    if (uf && r.uf !== uf) continue;
    if (ano && !r.vigencia.startsWith(`${ano}-`)) continue;
    const k = `${r.vigencia}|${r.uf}`;
    (linhas[k] ||= { competencia: r.vigencia, uf: r.uf })[r.chave] = r.valor;
  }
  return Object.values(linhas).sort((a, b) => (a.competencia + a.uf).localeCompare(b.competencia + b.uf));
}

module.exports = { PADROES, lerRegistros, paraLinhas, importar, ultimaCompetencia, historico, consultaLarga, MAX_BYTES };

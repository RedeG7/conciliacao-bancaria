'use strict';
// Gerador de PDF mínimo, sem dependência: páginas A4, texto em Helvetica
// (WinAnsi, cobre os acentos do português), retângulos, linhas e polígonos.
// Coordenadas em pontos a partir do canto superior esquerdo da página.
const A4 = { w: 595.28, h: 841.89 };

// largura aproximada de cada caractere em Helvetica (em fração do corpo)
function larguraChar(c, negrito) {
  let w;
  if (' '.includes(c)) w = 0.278;
  else if ('il.,:;\'|!Ijítì'.includes(c)) w = 0.24;
  else if ('frt()[]-/ºª'.includes(c)) w = 0.34;
  else if ('mwMW'.includes(c)) w = 0.86;
  else if (/[0-9]/.test(c)) w = 0.556;
  else if (/[A-ZÀ-Ý]/.test(c)) w = 0.68;
  else w = 0.53;
  return negrito ? w * 1.06 : w;
}
const larguraTexto = (s, corpo, negrito = false) => [...String(s)].reduce((t, c) => t + larguraChar(c, negrito), 0) * corpo;

// caracteres fora do Latin-1 viram o equivalente mais próximo
const TROCAS = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '·', ' ': ' ' };
function literal(s) {
  const bytes = [...String(s)].map(c => TROCAS[c] ?? c).join('');
  let out = '';
  for (const c of bytes) {
    const n = c.charCodeAt(0);
    if (c === '\\' || c === '(' || c === ')') out += `\\${c}`;
    else if (n < 32) out += ' ';
    else if (n > 255) out += '?';
    else if (n > 126) out += `\\${n.toString(8).padStart(3, '0')}`;
    else out += c;
  }
  return `(${out})`;
}
// "#rrggbb" -> "r g b"
const cor = hex => {
  const h = String(hex).replace('#', '');
  return [0, 2, 4].map(i => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
};
const f = n => Number(n).toFixed(2);

class Pdf {
  constructor() { this.paginas = []; this.atual = null; }
  pagina() { this.atual = []; this.paginas.push(this.atual); return this; }
  y(v) { return A4.h - v; }
  ret(x, y, w, h, preenche) { this.atual.push(`${cor(preenche)} rg ${f(x)} ${f(this.y(y + h))} ${f(w)} ${f(h)} re f`); return this; }
  linha(x1, y1, x2, y2, traco = '#cccccc', espessura = 0.6, tracejado = false) {
    this.atual.push(`${tracejado ? '[3 3] 0 d ' : ''}${cor(traco)} RG ${espessura} w ${f(x1)} ${f(this.y(y1))} m ${f(x2)} ${f(this.y(y2))} l S${tracejado ? ' [] 0 d' : ''}`);
    return this;
  }
  // pontos: [[x, y], ...]; preenche e/ou traça
  poligono(pontos, { preenche = null, traco = null, espessura = 1, tracejado = false } = {}) {
    const caminho = pontos.map(([x, y], i) => `${f(x)} ${f(this.y(y))} ${i ? 'l' : 'm'}`).join(' ') + ' h';
    const op = preenche && traco ? 'B' : preenche ? 'f' : 'S';
    this.atual.push(`${tracejado ? '[3 3] 0 d ' : ''}${preenche ? `${cor(preenche)} rg ` : ''}${traco ? `${cor(traco)} RG ${espessura} w ` : ''}${caminho} ${op}${tracejado ? ' [] 0 d' : ''}`);
    return this;
  }
  // y é a linha de base do texto
  texto(x, y, s, { corpo = 10, negrito = false, cor: c = '#1d2733', alinha = 'esq' } = {}) {
    const w = larguraTexto(s, corpo, negrito);
    const x0 = alinha === 'dir' ? x - w : alinha === 'centro' ? x - w / 2 : x;
    this.atual.push(`BT /${negrito ? 'F2' : 'F1'} ${corpo} Tf ${cor(c)} rg ${f(x0)} ${f(this.y(y))} Td ${literal(s)} Tj ET`);
    return this;
  }
  // quebra em linhas que cabem na largura
  quebrar(s, corpo, largura, negrito = false) {
    const linhas = [];
    for (const par of String(s ?? '').split(/\n/)) {
      let atual = '';
      for (const p of par.split(/\s+/).filter(Boolean)) {
        const tenta = atual ? `${atual} ${p}` : p;
        if (atual && larguraTexto(tenta, corpo, negrito) > largura) { linhas.push(atual); atual = p; } else atual = tenta;
      }
      linhas.push(atual);
    }
    return linhas;
  }
  gerar() {
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const catalogo = add(''), paginasId = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = this.paginas.map(ops => {
      const conteudo = ops.join('\n');
      const c = add(`<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`);
      return add(`<< /Type /Page /Parent ${paginasId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`);
    });
    objs[catalogo - 1] = `<< /Type /Catalog /Pages ${paginasId} 0 R >>`;
    objs[paginasId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const pos = [];
    objs.forEach((o, i) => { pos.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${pos.map(p => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

module.exports = { Pdf, A4, larguraTexto, literal };

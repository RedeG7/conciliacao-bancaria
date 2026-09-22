#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Conciliacao Bancaria - RedeG7 Solucoes em TI
=============================================

Confere item a item o extrato/fluxo de caixa (OFX/CSV/PDF) contra o razao
contabil de uma conta banco, usa o balancete para mapear os codigos internos
das contas (sistema Dominio - Thomson Reuters) e gera:

  1. Espelho de conciliacao (Markdown)
  2. Memoria de conferencia (CSV)
  3. Arquivo de importacao Dominio - leiaute "Lancamentos Contabeis
     (Partida Simples/Multiplas) (3.1)" - 10 colunas, separador ';',
     decimal ',', sem cabecalho, latin-1, CRLF.

Uso basico
----------
    python conciliacao_bancaria.py \
        --extrato extrato_jan.ofx \
        --razao razao_banco.csv \
        --balancete balancete.csv \
        --conta-contabil "BANCO INTER 36267404-3" \
        --competencia 01-2026 \
        --saldo-inicial-razao 15234.50 \
        --saldo-inicial-extrato 15234.50 \
        --out-dir ./saida

Competencia e sempre relativa ao balancete: se --competencia for omitido, o
script tenta detectar automaticamente (formato MM-AAAA) a partir do proprio
texto do balancete informado. Use --listar-contas-balancete <arquivo> para
ver todas as contas mapeadas (e quais parecem ser conta banco/caixa) antes
de decidir o valor de --conta-contabil.

Modo demonstracao (sem arquivos reais, gera dados sinteticos e roda o
pipeline inteiro de ponta a ponta para voce ver o resultado):

    python conciliacao_bancaria.py --demo --out-dir ./saida_demo

Formatos aceitos
-----------------
- Extrato: .ofx (padrao bancario), .csv (colunas data/valor/descricao,
  nomes flexiveis - veja `_AUTO_HEADERS` abaixo), .pdf (texto extraido via
  pdfplumber, heuristica generica - ajuste `parse_pdf_generic` por banco
  se necessario).
- Razao contabil: mesmos formatos do extrato (csv/pdf) - representa os
  lancamentos ja escriturados na conta banco.
- Balancete: .csv ou .pdf com colunas/celulas "codigo interno",
  "classificacao" (ex. 1.1.1.02.00004) e "nome da conta".

Nao ha dependencias obrigatorias fora da biblioteca padrao. pdfplumber e
usado apenas se voce apontar um arquivo .pdf (import feito sob demanda).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Modelos de dados
# ---------------------------------------------------------------------------

@dataclass
class Movimento:
    data: dt.date
    valor: float  # positivo = entrada (credito no banco), negativo = saida
    descricao: str
    origem: str  # "extrato" ou "razao"
    conta_debito: Optional[str] = None
    conta_credito: Optional[str] = None
    status: str = "pendente"  # "OK" | "pendente" | "conta_nao_identificada"
    categoria: Optional[str] = None
    origem_ocr: bool = False  # True quando lido via OCR (PDF sem texto embutido)
    alerta_valor: Optional[str] = None  # motivo pra revisar manualmente este valor (ex.: saldo nao bate)


@dataclass
class ContaBalancete:
    codigo: str
    classificacao: str
    nome: str


# ---------------------------------------------------------------------------
# Parsers de extrato / razao
# ---------------------------------------------------------------------------

_AUTO_HEADERS = {
    "data": ["data", "date", "dt", "data_lancamento", "data lancamento"],
    "valor": ["valor", "value", "amount", "vl", "valor (r$)", "valor(r$)"],
    "descricao": [
        "descricao", "descrição", "historico", "histórico", "memo",
        "complemento", "description", "detalhe",
    ],
}


def _find_col(fieldnames: List[str], candidates: List[str]) -> Optional[str]:
    norm = {f.strip().lower(): f for f in fieldnames}
    for cand in candidates:
        if cand in norm:
            return norm[cand]
    return None


def _parse_valor_br(raw: str) -> float:
    """Aceita '1.234,56', '1234.56', '-85,00', 'R$ 85,00' etc."""
    s = raw.strip().replace("R$", "").replace(" ", "")
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    if "," in s and "." in s:
        # formato BR: milhar com ponto, decimal com virgula
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        v = float(s)
    except ValueError:
        raise ValueError(f"Nao consegui converter valor: {raw!r}")
    return -v if neg else v


def _parse_data_br(raw: str) -> dt.date:
    raw = raw.strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%Y%m%d", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Nao consegui converter data: {raw!r}")


def parse_csv_movimentos(
    path: str,
    origem: str,
    col_data: Optional[str] = None,
    col_valor: Optional[str] = None,
    col_descricao: Optional[str] = None,
    encoding: str = "utf-8-sig",
    delimiter: Optional[str] = None,
) -> List[Movimento]:
    """Le um CSV de extrato ou razao com deteccao automatica de colunas."""
    text = Path(path).read_text(encoding=encoding, errors="replace")
    if delimiter is None:
        delimiter = ";" if text.count(";") > text.count(",") else ","

    reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
    if not reader.fieldnames:
        raise ValueError(f"CSV sem cabecalho reconhecivel: {path}")

    dcol = col_data or _find_col(reader.fieldnames, _AUTO_HEADERS["data"])
    vcol = col_valor or _find_col(reader.fieldnames, _AUTO_HEADERS["valor"])
    hcol = col_descricao or _find_col(reader.fieldnames, _AUTO_HEADERS["descricao"])

    if not (dcol and vcol):
        raise ValueError(
            f"Nao identifiquei colunas de data/valor em {path}. "
            f"Cabecalhos encontrados: {reader.fieldnames}. "
            "Informe --col-data/--col-valor explicitamente."
        )

    movimentos = []
    for row in reader:
        raw_data, raw_valor = row.get(dcol), row.get(vcol)
        if not raw_data or not raw_valor:
            continue
        try:
            data = _parse_data_br(raw_data)
            valor = _parse_valor_br(raw_valor)
        except ValueError:
            continue
        desc = (row.get(hcol) or "").strip() if hcol else ""
        movimentos.append(Movimento(data=data, valor=valor, descricao=desc, origem=origem))
    return movimentos


_OFX_TRN_RE = re.compile(r"<STMTTRN>(.*?)</STMTTRN>", re.DOTALL | re.IGNORECASE)
_OFX_TAG_RE = re.compile(r"<(\w+)>([^<\r\n]*)")


def parse_ofx(path: str, origem: str = "extrato", encoding: str = "latin-1") -> List[Movimento]:
    """Parser OFX leve via regex (evita dependencia externa). Cobre o
    subconjunto usado por extratos bancarios BR: DTPOSTED, TRNAMT, MEMO/NAME."""
    raw = Path(path).read_text(encoding=encoding, errors="replace")
    movimentos = []
    for block in _OFX_TRN_RE.findall(raw):
        fields = {m.group(1).upper(): m.group(2).strip() for m in _OFX_TAG_RE.finditer(block)}
        dtposted = fields.get("DTPOSTED", "")
        trnamt = fields.get("TRNAMT", "")
        if not dtposted or not trnamt:
            continue
        data = dt.datetime.strptime(dtposted[:8], "%Y%m%d").date()
        valor = float(trnamt)
        desc = fields.get("MEMO") or fields.get("NAME") or ""
        movimentos.append(Movimento(data=data, valor=valor, descricao=desc, origem=origem))
    if not movimentos:
        raise ValueError(f"Nenhuma <STMTTRN> encontrada em {path} - confirme que e um OFX valido.")
    return movimentos


_PDF_LINHA_DATA_VALOR_RE = re.compile(
    r"(\d{2}/\d{2}/\d{4})\s+(.+?)\s+(-?\(?R?\$?\s?-?\d{1,3}(?:\.\d{3})*,\d{2}\)?)\s*$"
)

# checkpoints de saldo (nao sao lancamentos) que por acaso batem no mesmo
# padrao "data ... valor" de varios bancos (ex.: "DD/MM/AAAA Saldo do dia
# R$ X,XX") - excluidos de qualquer parser de linha unica, senao viram
# transacoes fantasma com o valor do saldo em vez do lancamento.
_LINHA_CHECKPOINT_RE = re.compile(
    r"\bsaldo\s+(total\s+)?(do\s+dia|anterior|final|inicial|em\s+conta|dispon[íi]vel|bloqueado)\b",
    re.IGNORECASE,
)

_PDF_DIA_EXTENSO_RE = re.compile(
    r"^(?P<dia>\d{1,2})\s+de\s+(?P<mes>[A-Za-zçÇãÃéÉêÊ]+)\s+de\s+(?P<ano>\d{4})\b",
    re.IGNORECASE,
)

_PDF_TRANSACAO_TIPO_RE = re.compile(
    r'^(?P<tipo>[^":]+):\s*"(?P<desc>.*?)"\s+(?P<sinal>-)?R\$\s*(?P<valor>[\d.]+,\d{2})\s+-?R\$\s*[\d.,]+\s*$'
)
_PDF_TRANSACAO_SEM_TIPO_RE = re.compile(
    r'^"(?P<desc>.*?)"\s+(?P<sinal>-)?R\$\s*(?P<valor>[\d.]+,\d{2})\s+-?R\$\s*[\d.,]+\s*$'
)
# algumas linhas do Inter nao tem nem "Tipo:" nem aspas na descricao (ex.:
# "DARF NUMERADO -R$ 85.908,75 -R$ 87.277,16", "Estorno Pagamento de
# titulo R$ 4.044,00 R$ 5.536,36") - sem esse padrao essas transacoes
# somem silenciosamente (nao batem em nenhum dos outros 2). A checagem
# "R$" not in desc evita que a linha de resumo do topo ("R$ 8.249,13 R$
# 8.249,13 R$ 0,00") vire uma transacao fantasma caso o guard de
# data_atual (linha antes de qualquer cabecalho de dia) nao seja suficiente.
_PDF_TRANSACAO_SIMPLES_RE = re.compile(
    r'^(?P<desc>[^":]+?)\s+(?P<sinal>-)?R\$\s*(?P<valor>[\d.]+,\d{2})\s+-?R\$\s*[\d.,]+\s*$'
)


def _parse_pdf_linhas_data_valor(paginas_texto: List[str], origem: str) -> List[Movimento]:
    """Layout 'DD/MM/AAAA  descricao....  valor' numa unica linha (comum em
    relatorios/extratos tabulares simples)."""
    movimentos = []
    for texto in paginas_texto:
        for line in texto.splitlines():
            line = line.strip()
            if _LINHA_CHECKPOINT_RE.search(line):
                continue
            m = _PDF_LINHA_DATA_VALOR_RE.search(line)
            if not m:
                continue
            data = _parse_data_br(m.group(1))
            desc = m.group(2).strip()
            valor = _parse_valor_br(m.group(3))
            movimentos.append(Movimento(data=data, valor=valor, descricao=desc, origem=origem))
    return movimentos


def _parse_pdf_extrato_dia_agrupado(paginas_texto: List[str], origem: str) -> List[Movimento]:
    """Layout tipo Banco Inter: um cabecalho 'D de Mes de AAAA ... Saldo do
    dia: ...' seguido de N linhas de transacao (sem data propria - a data e
    a do cabecalho do dia vigente). Cada linha de transacao traz
    'Tipo: "descricao" +/-R$ valor  R$ saldo_apos'; quando uma linha e
    cortada entre paginas e perde o prefixo 'Tipo:', ainda e recuperada pelo
    padrao alternativo (so a descricao entre aspas + valor)."""
    movimentos = []
    data_atual: Optional[dt.date] = None
    for texto in paginas_texto:
        for line in texto.splitlines():
            line = line.strip()

            m_dia = _PDF_DIA_EXTENSO_RE.match(line)
            if m_dia:
                mes = _MESES_PT.get(m_dia.group("mes").lower())
                if mes:
                    try:
                        data_atual = dt.date(int(m_dia.group("ano")), mes, int(m_dia.group("dia")))
                    except ValueError:
                        pass
                continue

            m_trans = _PDF_TRANSACAO_TIPO_RE.match(line) or _PDF_TRANSACAO_SEM_TIPO_RE.match(line)
            if not m_trans:
                m_simples = _PDF_TRANSACAO_SIMPLES_RE.match(line)
                if m_simples and "R$" not in m_simples.group("desc"):
                    m_trans = m_simples
            if m_trans and data_atual:
                sinal = m_trans.group("sinal") or ""
                valor = _parse_valor_br(f"{sinal}{m_trans.group('valor')}")
                tipo = m_trans.groupdict().get("tipo")
                desc = f"{tipo.strip()}: {m_trans.group('desc').strip()}" if tipo else m_trans.group("desc").strip()
                movimentos.append(Movimento(data=data_atual, valor=valor, descricao=desc, origem=origem))
    return movimentos


_NU_MESES = {
    "JAN": 1, "FEV": 2, "MAR": 3, "ABR": 4, "MAI": 5, "JUN": 6,
    "JUL": 7, "AGO": 8, "SET": 9, "OUT": 10, "NOV": 11, "DEZ": 12,
}
_NU_DIA_TOTAL_RE = re.compile(
    r"^(?P<dia>\d{1,2})\s+(?P<mes>[A-ZÇ]{3})\s+(?P<ano>\d{4})\s+"
    r"Total\s+de\s+(?P<tipo>entradas|sa[íi]das)\s+[+-]\s*[\d.,]+\s*$",
    re.IGNORECASE,
)
_NU_TOTAL_RE = re.compile(
    r"^Total\s+de\s+(?P<tipo>entradas|sa[íi]das)\s+[+-]\s*[\d.,]+\s*$", re.IGNORECASE,
)
_NU_SALDO_DIA_RE = re.compile(r"^Saldo do dia\b", re.IGNORECASE)
_NU_LINHA_VALOR_RE = re.compile(r"^(?P<desc>.+?)\s+(?P<valor>\d{1,3}(?:\.\d{3})*,\d{2})\s*$")


def _parse_pdf_nubank(paginas_texto: List[str], origem: str) -> List[Movimento]:
    """Layout do extrato PDF do Nubank PJ: bloco por dia 'DD MES AAAA Total
    de entradas/saidas +/-total', com um sub-cabecalho 'Total de
    entradas/saidas' repetido quando o dia tem os dois tipos - o sinal de
    cada lancamento (nao vem escrito na linha) e o da secao vigente
    (entradas=positivo, saidas=negativo). 'Saldo do dia' e um checkpoint,
    nao uma transacao. Processa todas as paginas como um unico fluxo (nao
    ha garantia de que um dia sempre feche exatamente na quebra de
    pagina)."""
    todas_linhas: List[str] = []
    for texto in paginas_texto:
        todas_linhas.extend(texto.splitlines())

    movimentos: List[Movimento] = []
    data_atual: Optional[dt.date] = None
    sinal_atual = 1

    for linha in todas_linhas:
        linha = linha.strip()
        if not linha:
            continue

        m_dia = _NU_DIA_TOTAL_RE.match(linha)
        if m_dia:
            mes = _NU_MESES.get(m_dia.group("mes").upper())
            if mes:
                try:
                    data_atual = dt.date(int(m_dia.group("ano")), mes, int(m_dia.group("dia")))
                except ValueError:
                    data_atual = None
            sinal_atual = 1 if m_dia.group("tipo").lower().startswith("entrada") else -1
            continue

        m_tot = _NU_TOTAL_RE.match(linha)
        if m_tot:
            sinal_atual = 1 if m_tot.group("tipo").lower().startswith("entrada") else -1
            continue

        if _NU_SALDO_DIA_RE.match(linha):
            continue

        m_val = _NU_LINHA_VALOR_RE.match(linha)
        if m_val and data_atual:
            desc = m_val.group("desc").strip()
            if _LINHA_CHECKPOINT_RE.search(desc):
                continue
            valor = sinal_atual * _parse_valor_br(m_val.group("valor"))
            movimentos.append(Movimento(data=data_atual, valor=valor, descricao=desc, origem=origem))
    return movimentos


_C6_ANO_RE = re.compile(
    r"\bde\s+(?:janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|"
    r"outubro|novembro|dezembro)\s+de\s+(\d{4})\b", re.IGNORECASE,
)
_C6_LINHA_RE = re.compile(
    r"^\d{2}/\d{2}\s+(?P<dia>\d{2})/(?P<mes>\d{2})\s+(?P<desc>.+?)\s+"
    r"(?P<sinal>-)?R\$\s*(?P<valor>\d{1,3}(?:\.\d{3})*,\d{2})\s*$"
)


def _parse_pdf_c6(paginas_texto: List[str], origem: str) -> List[Movimento]:
    """Layout do extrato PDF do C6 Bank: uma linha por lancamento 'DD/MM
    DD/MM [Tipo] Descricao [-]R$ valor' (a 2a data e a 'data contabil',
    igual a primeira na pratica) - sem sinal explicito quando e credito.
    O ano nao aparece na linha da transacao, so no cabecalho do periodo
    ('...ate DD de MES de AAAA'), entao e extraido uma vez do texto todo
    e aplicado a todos os lancamentos."""
    texto_completo = "\n".join(paginas_texto)
    m_ano = _C6_ANO_RE.search(texto_completo)
    ano = int(m_ano.group(1)) if m_ano else dt.date.today().year

    movimentos: List[Movimento] = []
    for texto in paginas_texto:
        for linha in texto.splitlines():
            linha = linha.strip()
            if not linha:
                continue
            m = _C6_LINHA_RE.match(linha)
            if not m:
                continue
            try:
                data = dt.date(ano, int(m.group("mes")), int(m.group("dia")))
            except ValueError:
                continue
            sinal = m.group("sinal") or ""
            valor = _parse_valor_br(f"{sinal}{m.group('valor')}")
            desc = m.group("desc").strip()
            movimentos.append(Movimento(data=data, valor=valor, descricao=desc, origem=origem))
    return movimentos


_CORA_DIA_RE = re.compile(r"^(?P<dia>\d{2})/(?P<mes>\d{2})/(?P<ano>\d{4})\s+Saldo do dia\b", re.IGNORECASE)
_CORA_LINHA_RE = re.compile(
    r"^(?P<desc>.+?)\s+(?P<sinal>[+-])\s*R\$\s*(?P<valor>\d{1,3}(?:\.\d{3})*,\d{2})\s*$"
)


def _parse_pdf_cora(paginas_texto: List[str], origem: str) -> List[Movimento]:
    """Layout do extrato PDF da Cora: ordem cronologica REVERSA (mais
    recente primeiro), agrupado por dia via a linha 'DD/MM/AAAA Saldo do
    dia R$ valor' (um checkpoint - o saldo e o do FINAL daquele dia, nao
    uma transacao). As transacoes do dia vem logo depois, cada uma com
    sinal explicito (+/- antes de R$). Um bloco de dia pode continuar
    depois de uma quebra de pagina, entao processa tudo como um so
    fluxo (sem resetar a data a cada pagina)."""
    movimentos: List[Movimento] = []
    data_atual: Optional[dt.date] = None
    for texto in paginas_texto:
        for linha in texto.splitlines():
            linha = linha.strip()
            if not linha:
                continue
            m_dia = _CORA_DIA_RE.match(linha)
            if m_dia:
                try:
                    data_atual = dt.date(int(m_dia.group("ano")), int(m_dia.group("mes")), int(m_dia.group("dia")))
                except ValueError:
                    data_atual = None
                continue
            m = _CORA_LINHA_RE.match(linha)
            if m and data_atual:
                sinal = m.group("sinal")
                valor = _parse_valor_br(f"{'-' if sinal == '-' else ''}{m.group('valor')}")
                desc = m.group("desc").strip()
                movimentos.append(Movimento(data=data_atual, valor=valor, descricao=desc, origem=origem))
    return movimentos


_SICOOB_ANO_RE = re.compile(r"Periodo:\s*\d{2}/\d{2}/(\d{4})", re.IGNORECASE)
# decimais aceita 2-3 digitos: OCR as vezes gruda um digito extra depois da
# virgula (ex.: "3.631,517" em vez de "3.631,51") - sem essa tolerancia o
# regex simplesmente nao bate e a transacao inteira some, virando texto de
# continuacao da transacao anterior (silencioso e muito pior que sinalizar
# pra conferencia manual - ver _sicoob_valor_com_alerta).
_SICOOB_LINHA_RE = re.compile(
    r"^(?P<dia>\d{2})/(?P<mes>\d{2})(?:/(?P<ano>\d{4}))?\s+"
    r"(?P<desc>.+?)\s+"
    r"(?:R\$\s*)?(?P<valor>\d{1,3}(?:\.\d{3})*,\d{2,3})?(?P<cd>[CD])?\s*$"
)
_SICOOB_VALOR_SOLTO_RE = re.compile(r"^(?P<valor>\d{1,3}(?:\.\d{3})*,\d{2,3})(?P<cd>[CD])\s*$")


def _sicoob_valor_com_alerta(valor_str: str) -> Tuple[float, Optional[str]]:
    """Converte o valor lido, tolerando o digito extra apos a virgula que o
    OCR as vezes gruda (ver comentario acima) - usa so os 2 primeiros
    digitos decimais (nunca inventa qual e o valor certo) e devolve um
    alerta pra revisao manual quando isso acontece."""
    inteiro, _, decimais = valor_str.rpartition(",")
    if len(decimais) > 2:
        valor = _parse_valor_br(f"{inteiro},{decimais[:2]}")
        alerta = (
            f"⚠️ OCR: valor lido com dígito(s) extra(s) após a vírgula ('{valor_str}') - "
            f"usei os 2 primeiros decimais ({decimais[:2]}); confira contra o extrato original."
        )
        return valor, alerta
    return _parse_valor_br(valor_str), None


def _parse_pdf_sicoob(paginas_linhas: List[List[str]], origem: str) -> List[Movimento]:
    """Layout do extrato PDF do Sicoob (SISBR): cada lancamento comeca numa
    linha 'DD/MM[/AAAA] [documento] descricao [R$] valorC|D' (credito/
    debito colado no valor, sem espaco) e pode continuar em linhas soltas
    seguintes (favorecido, CNPJ, finalidade) ate a proxima data. Cobre as
    2 variantes reais vistas: com ano e sem 'R$' (extrato com texto
    embutido), e so 'DD/MM' com 'R$' (comum quando o extrato precisa de
    OCR - nesse caso o ano vem do cabecalho 'Periodo: ...'). Quando a
    descricao e longa, o valor as vezes quebra pra uma linha propria (ex.:
    'R$' no fim de uma linha, digito+C/D sozinho na seguinte) - tratado
    via o estado `pendente`. Linhas 'SALDO DO DIA'/'SALDO ANTERIOR'/
    'SALDO BLOQUEADO' sao checkpoints, nao transacoes."""
    texto_completo = "\n".join("\n".join(linhas) for linhas in paginas_linhas)
    m_ano = _SICOOB_ANO_RE.search(texto_completo)
    ano_padrao = int(m_ano.group(1)) if m_ano else dt.date.today().year

    movimentos: List[Movimento] = []
    for linhas in paginas_linhas:
        mov_atual: Optional[Movimento] = None
        pendente: Optional[Movimento] = None

        for linha in linhas:
            linha = linha.strip()
            if not linha:
                continue

            if pendente is not None:
                m_val = _SICOOB_VALOR_SOLTO_RE.match(linha)
                if m_val:
                    valor, alerta = _sicoob_valor_com_alerta(m_val.group("valor"))
                    if m_val.group("cd").upper() == "D":
                        valor = -valor
                    pendente.valor = valor
                    pendente.alerta_valor = alerta
                    mov_atual = pendente
                    pendente = None
                    continue
                pendente = None

            m = _SICOOB_LINHA_RE.match(linha)
            if m:
                ano = int(m.group("ano")) if m.group("ano") else ano_padrao
                try:
                    data = dt.date(ano, int(m.group("mes")), int(m.group("dia")))
                except ValueError:
                    continue
                desc = m.group("desc").strip()
                if _LINHA_CHECKPOINT_RE.search(desc):
                    mov_atual = None
                    continue
                if m.group("valor") and m.group("cd"):
                    valor, alerta = _sicoob_valor_com_alerta(m.group("valor"))
                    if m.group("cd").upper() == "D":
                        valor = -valor
                    mov_atual = Movimento(
                        data=data, valor=valor, descricao=desc, origem=origem, alerta_valor=alerta,
                    )
                    movimentos.append(mov_atual)
                else:
                    # o valor ficou pra proxima linha (descricao empurrou
                    # o numero pra fora da largura da coluna no OCR)
                    mov_atual = None
                    pendente = Movimento(data=data, valor=0.0, descricao=desc, origem=origem)
                    movimentos.append(pendente)
                continue

            if mov_atual is not None and len(linha) > 2:
                mov_atual.descricao = f"{mov_atual.descricao} {linha}".strip()
    return movimentos


_PAGBANK_SALDO_DIA_RE = re.compile(r"^\d{2}/\d{2}/\d{4}\s+Saldo do dia\b", re.IGNORECASE)
_PAGBANK_LINHA_RE = re.compile(
    r"^\d{2}/\d{2}/\d{4}\s+(?P<desc>.*?)\s*(?P<sinal>-)?R\$\s*(?P<valor>\d{1,3}(?:\.\d{3})*,\d{2})\s*$"
)


def _parse_pdf_pagbank(paginas_texto: List[str], origem: str) -> List[Movimento]:
    """Layout do extrato PDF do PagBank: uma linha por lancamento
    'DD/MM/AAAA descricao [-]R$ valor'. Usa um regex proprio (em vez do
    padrao tabular generico) porque o "R$" e obrigatorio aqui - sem isso,
    quando a descricao vem vazia na mesma linha (ex.: descricao longa que
    quebrou pra linha anterior), o "-" do sinal e engolido junto com a
    descricao e o valor perde o sinal negativo. Alem disso cada dia tem
    uma linha extra 'DD/MM/AAAA Saldo do dia R$ valor', que bate no MESMO
    padrao e precisa ser excluida explicitamente (checkpoint, nao
    transacao)."""
    movimentos: List[Movimento] = []
    for texto in paginas_texto:
        linha_anterior = ""
        for linha in texto.splitlines():
            linha = linha.strip()
            if not linha:
                continue
            if _PAGBANK_SALDO_DIA_RE.match(linha):
                linha_anterior = linha
                continue
            m = _PAGBANK_LINHA_RE.match(linha)
            if not m:
                linha_anterior = linha
                continue
            data = _parse_data_br(linha[:10])
            desc = m.group("desc").strip() or linha_anterior
            sinal = m.group("sinal") or ""
            valor = _parse_valor_br(f"{sinal}{m.group('valor')}")
            movimentos.append(Movimento(data=data, valor=valor, descricao=desc, origem=origem))
            linha_anterior = linha
    return movimentos


_CEF_DATA_CHEIA_RE = re.compile(r"^(?P<data>\d{2}/\d{2}/\d{4})\s*(?P<resto>.*)$")
_CEF_DATA_HORA_RE = re.compile(r"^\d{2}/\d{2}\s+\d{2}:\d{2}\s*(?P<resto>.*)$")
_CEF_VALOR_FINAL_RE = re.compile(
    r"^(?P<pre>.*?)"
    r"(?P<sinal>-)?\s*R\$\s*(?P<valor>\d{1,3}(?:\.\d{3})*,\d{2})\s+"
    r"R\$\s*(?P<saldo>\d{1,3}(?:\.\d{3})*,\d{2})\s*(?P<saldo_cd>[CD])\s*$",
    re.IGNORECASE,
)
_CEF_DOC_PREFIXO_RE = re.compile(r"^\d{4,}\s+")


def _parse_pdf_gerenciador_caixa(paginas_linhas: List[List[str]], origem: str) -> List[Movimento]:
    """Layout do 'Gerenciador CAIXA' (extrato PDF do internet banking da
    Caixa): cada lancamento ocupa 2-3 linhas visuais (data | documento +
    historico + valor + saldo | data efetiva + resto do historico). Via
    OCR essas linhas as vezes saem reagrupadas de forma imprevisivel (o
    inicio do historico pode aparecer ANTES da propria linha da data, o
    numero do documento pode colar em qualquer uma delas) - por isso o
    parser funciona como uma maquina de estados: acumula texto de
    descricao solto num buffer, guarda a ultima data vista, e so fecha
    UMA transacao quando encontra o padrao final '[-] R$ valor R$ saldo
    [C|D]' - juntando o buffer acumulado + o que sobrar antes do valor
    naquela mesma linha como descricao. A linha 'SALDO DIA' (so um valor,
    sem 'Valor' de lancamento) e um checkpoint, nao uma transacao.

    O proprio 'Saldo' impresso em cada linha e aproveitado como conferencia
    cruzada (saldo atual - saldo anterior deve bater com o valor lido desta
    transacao): quando OCR erra um digito do VALOR, o saldo geralmente
    continua certo (fonte/posicao diferente), entao a divergencia aponta
    exatamente qual lancamento revisar - em vez de pedir para conferir tudo
    as cegas. Usa o proprio saldo impresso como nova referencia a cada
    passo, pra um unico erro nao contaminar todas as comparacoes seguintes."""
    movimentos: List[Movimento] = []
    saldo_anterior: Optional[float] = None
    for linhas in paginas_linhas:
        data_atual: Optional[dt.date] = None
        desc_buffer: List[str] = []

        for linha in linhas:
            linha = linha.strip()
            if not linha or "saldo dia" in linha.lower():
                if "saldo dia" in linha.lower():
                    desc_buffer = []
                continue

            m_de = _CEF_DATA_HORA_RE.match(linha)
            if m_de:
                resto = m_de.group("resto").strip()
                if resto:
                    desc_buffer.append(resto)
                continue

            m_dt = _CEF_DATA_CHEIA_RE.match(linha)
            if m_dt:
                data_atual = _parse_data_br(m_dt.group("data"))
                linha = m_dt.group("resto").strip()
                if not linha:
                    continue

            m_val = _CEF_VALOR_FINAL_RE.match(linha)
            if m_val and data_atual:
                pre = _CEF_DOC_PREFIXO_RE.sub("", m_val.group("pre").strip(), count=1).strip()
                desc = " ".join(desc_buffer + ([pre] if pre else [])).strip()
                sinal = m_val.group("sinal") or ""
                valor = _parse_valor_br(f"{sinal}{m_val.group('valor')}")
                saldo_atual = _parse_valor_br(m_val.group("saldo"))
                if m_val.group("saldo_cd").upper() == "D":
                    saldo_atual = -saldo_atual

                alerta = None
                if saldo_anterior is not None:
                    delta = round(saldo_atual - saldo_anterior, 2)
                    if abs(delta - valor) > 0.01:
                        alerta = (
                            f"⚠️ OCR: valor lido ({fmt_money(valor)}) nao bate com a variacao do "
                            f"saldo impresso ({fmt_money(delta)}) - confira este lancamento no "
                            "extrato original."
                        )
                saldo_anterior = saldo_atual

                movimentos.append(Movimento(
                    data=data_atual, valor=valor, descricao=desc or "(sem descricao)", origem=origem,
                    alerta_valor=alerta,
                ))
                desc_buffer = []
                continue

            if len(linha) > 3:
                desc_buffer.append(_CEF_DOC_PREFIXO_RE.sub("", linha, count=1))
    return movimentos


_ITAU_DATA_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
_ITAU_VALOR_RE = re.compile(r"^-?\d{1,3}(?:\.\d{3})*,\d{2}$")


def _parse_pdf_itau(path: str, origem: str) -> List[Movimento]:
    """Layout do extrato PDF do Itau ('Lancamentos do periodo'): tabela de
    5 colunas (Data | Lancamentos | Razao Social | CNPJ/CPF | Valor (R$) |
    Saldo (R$)) onde as colunas de texto (Lancamentos e Razao Social)
    quebram de forma INDEPENDENTE quando o conteudo e comprido, sem
    relacao com quantas linhas a outra coluna precisa - simples
    extract_text() sequencial embaralha lancamentos vizinhos (rouba um
    pedaco de descricao do lancamento errado). Usa as COORDENADAS X de
    cada palavra (via extract_words) pra saber exatamente de qual coluna
    ela e, apoiado nas proprias posicoes do cabecalho da tabela (robusto
    a pequenas variacoes de layout entre extratos). Uma linha-ancora e
    reconhecida por ter uma Data (coluna 1) E um Valor (coluna Valor) na
    mesma altura; se o lancamento coube todo numa linha so (tem texto
    tanto em Lancamentos quanto em Razao Social na propria ancora), nao
    busca continuacao - senao, "rouba" a linha imediatamente acima e/ou
    abaixo (que devem ter conteudo so nas colunas de texto, nunca uma
    Data propria) pra completar a descricao."""
    import pdfplumber  # type: ignore

    with pdfplumber.open(path) as pdf:
        x_lanc = x_razao = x_cnpj = x_valor = x_saldo = None
        for page in pdf.pages:
            palavras_cabecalho = page.extract_words()
            data_word = next((w for w in palavras_cabecalho if w["text"] == "Data"), None)
            if data_word:
                cabecalho = {w["text"]: w["x0"] for w in palavras_cabecalho if abs(w["top"] - data_word["top"]) < 2}
                if "Lançamentos" in cabecalho and "Razão" in cabecalho and "Valor" in cabecalho and "Saldo" in cabecalho:
                    x_lanc = cabecalho["Lançamentos"]
                    x_razao = cabecalho["Razão"]
                    x_cnpj = cabecalho.get("CNPJ/CPF", x_razao + 100)
                    x_valor = cabecalho["Valor"]
                    x_saldo = cabecalho["Saldo"]
                    break
        if x_lanc is None:
            return []  # cabecalho nao encontrado - nao e este layout

        # numeros negativos (sinal "-") ficam um pouco mais largos e podem
        # comecar alguns pixels antes do x0 "oficial" da coluna Valor (que
        # veio da palavra do cabecalho, sem sinal) - folga validada contra
        # o CNPJ/CPF mais largo do documento (nunca passa de x1 ~440, bem
        # longe da coluna de valor) pra nao arriscar capturar coluna errada.
        x_valor_tolerante = x_valor - 15
        x_saldo_tolerante = x_saldo - 15

        movimentos: List[Movimento] = []
        for page in pdf.pages:
            palavras = page.extract_words()
            bandas: List[Tuple[float, list]] = []
            for w in sorted(palavras, key=lambda w: w["top"]):
                if bandas and abs(w["top"] - bandas[-1][0]) < 2:
                    bandas[-1][1].append(w)
                else:
                    bandas.append([w["top"], [w]])

            def _texto_colunas(ws: list) -> str:
                relevantes = [w for w in ws if x_lanc <= w["x0"] < x_valor_tolerante]
                return " ".join(w["text"] for w in sorted(relevantes, key=lambda w: w["x0"]))

            for i, (_top, banda) in enumerate(bandas):
                data_word = next(
                    (w for w in banda if w["x0"] < x_lanc and _ITAU_DATA_RE.match(w["text"])), None
                )
                valor_word = next(
                    (w for w in banda if x_valor_tolerante <= w["x0"] < x_saldo_tolerante
                     and _ITAU_VALOR_RE.match(w["text"])), None
                )
                if not data_word or not valor_word:
                    continue
                meio = _texto_colunas(banda)
                if _LINHA_CHECKPOINT_RE.search(meio):
                    continue
                tem_lancamento = any(x_lanc <= w["x0"] < x_razao for w in banda)
                tem_razao_social = any(x_razao <= w["x0"] < x_cnpj for w in banda)
                autossuficiente = tem_lancamento and tem_razao_social

                partes = []
                if not autossuficiente and i - 1 >= 0:
                    _, banda_anterior = bandas[i - 1]
                    tem_data_propria = any(
                        w["x0"] < x_lanc and _ITAU_DATA_RE.match(w["text"]) for w in banda_anterior
                    )
                    if not tem_data_propria:
                        txt = _texto_colunas(banda_anterior)
                        if txt:
                            partes.append(txt)
                if meio:
                    partes.append(meio)
                if not autossuficiente and i + 1 < len(bandas):
                    _, banda_proxima = bandas[i + 1]
                    tem_data_propria = any(
                        w["x0"] < x_lanc and _ITAU_DATA_RE.match(w["text"]) for w in banda_proxima
                    )
                    if not tem_data_propria:
                        txt = _texto_colunas(banda_proxima)
                        if txt:
                            partes.append(txt)
                desc = " ".join(partes).strip()
                if not desc:
                    continue
                data = _parse_data_br(data_word["text"])
                valor = _parse_valor_br(valor_word["text"])
                movimentos.append(Movimento(data=data, valor=valor, descricao=desc, origem=origem))
        return movimentos


def _ocr_linhas_por_pagina(path: str) -> List[List[str]]:
    """Renderiza cada pagina do PDF (via PyMuPDF, sem depender de poppler) e
    roda OCR (Tesseract), reconstruindo a ordem visual linha a linha pelas
    coordenadas de cada palavra reconhecida - usado como ultimo recurso
    quando o PDF nao tem NENHUM texto embutido (comum em extratos gerados
    por 'Imprimir em PDF' do navegador, que desenham o texto em vez de
    incorpora-lo como caracteres de verdade)."""
    try:
        import pytesseract  # type: ignore
        from pytesseract import Output  # type: ignore
        import fitz  # type: ignore  # PyMuPDF
        from PIL import Image  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "Este PDF nao tem texto embutido (foi provavelmente gerado por 'Imprimir em PDF') - "
            "a leitura via OCR requer pytesseract + PyMuPDF + Pillow (pip install pytesseract "
            "pymupdf pillow) e o binario tesseract-ocr instalado no servidor."
        ) from exc

    try:
        doc = fitz.open(path)
        paginas: List[List[str]] = []
        for page in doc:
            pix = page.get_pixmap(dpi=300)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

            # extratos "impressos em PDF" as vezes desenham o conteudo
            # girado (texto na vertical) mesmo sem nenhuma flag /Rotate no
            # PDF - detecta e corrige antes do OCR, ou o Tesseract le tudo
            # embaralhado (tenta ler texto vertical como se fosse horizontal).
            try:
                osd = pytesseract.image_to_osd(img, output_type=Output.DICT)
                rotacao = int(osd.get("rotate", 0))
            except Exception:
                rotacao = 0
            if rotacao:
                img = img.rotate(-rotacao, expand=True)

            dados = pytesseract.image_to_data(img, lang="por", output_type=Output.DICT)

            palavras = []
            for i, texto in enumerate(dados["text"]):
                texto = texto.strip()
                if not texto:
                    continue
                palavras.append({
                    "texto": texto,
                    "x": dados["left"][i],
                    "y": dados["top"][i] + dados["height"][i] / 2,
                })

            palavras.sort(key=lambda p: p["y"])
            linhas_pagina: List[List[dict]] = []
            tolerancia_y = 10
            for p in palavras:
                if linhas_pagina and abs(p["y"] - linhas_pagina[-1][0]["y"]) <= tolerancia_y:
                    linhas_pagina[-1].append(p)
                else:
                    linhas_pagina.append([p])

            paginas.append([
                " ".join(w["texto"] for w in sorted(linha, key=lambda w: w["x"]))
                for linha in linhas_pagina
            ])
        return paginas
    except ImportError:
        raise
    except Exception as exc:
        raise ValueError(
            f"Falha ao rodar OCR em {path}: {exc}. Confira se o tesseract-ocr (e o pacote de "
            "idioma portugues, tesseract-ocr-por) estao instalados no servidor."
        ) from exc


# deteccao de banco pelo texto do proprio extrato, pra despachar direto pro
# parser certo - evita que o padrao tabular generico (ou o de outro banco)
# capture algumas linhas de forma ambigua/errada antes de chegar no parser
# realmente feito pra aquele layout (ex.: "Saldo do dia" do PagBank bate no
# padrao generico e viraria uma transacao fantasma se o generico rodasse
# primeiro). Cada marcador e checado em ordem contra o texto inteiro do
# documento (minusculo); o primeiro que bater manda chamar o parser
# especifico. Se nenhum bater, cai pros parsers genericos/heuristicos.
_MARCADORES_BANCO: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"\bnubank\b"), "nubank"),
    (re.compile(r"\bc6\s*bank\b"), "c6"),
    (re.compile(r"\bcora\s*scfi\b"), "cora"),
    (re.compile(r"pagseguro|\bpagbank\b"), "pagbank"),
    (re.compile(r"\bsicoob\b"), "sicoob"),
    (re.compile(r"gerenciador\s*caixa|caixa\s*econ[oô]mica\s*federal"), "caixa"),
    (re.compile(r"itau\.com\.br|ita[uú]\s+unibanco"), "itau"),
]


def parse_pdf_generic(path: str, origem: str = "extrato") -> List[Movimento]:
    """Le o PDF e despacha pro parser certo: primeiro tenta identificar o
    banco pelo proprio texto do extrato (Nubank, C6, Cora, PagBank/
    PagSeguro, Sicoob, Gerenciador CAIXA, Itau), cada um com layout dedicado;
    se nenhum bater, cai nos padroes genericos (tabular 'DD/MM/AAAA
    descricao valor' numa linha, extrato agrupado por dia tipo Banco
    Inter, e por fim o layout da Caixa de novo como ultimo recurso, ja
    que seu padrao - dois valores 'R$' no fim da linha - dificilmente
    bate por engano em outro banco). Se o PDF nao tiver NENHUM texto
    embutido (comum em extratos "impressos em PDF" pelo navegador, onde
    o texto vira desenho vetorial em vez de caracteres), cai para OCR
    antes de qualquer uma dessas tentativas. Ajuste/estenda os parsers
    _parse_pdf_* para outros bancos."""
    try:
        import pdfplumber  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "Leitura de PDF requer pdfplumber. Instale com: pip install pdfplumber"
        ) from exc

    with pdfplumber.open(path) as pdf:
        paginas_texto = [page.extract_text() or "" for page in pdf.pages]

    usado_ocr = False
    if not "".join(paginas_texto).strip():
        paginas_linhas = _ocr_linhas_por_pagina(path)
        usado_ocr = True
    else:
        paginas_linhas = [texto.splitlines() for texto in paginas_texto]

    paginas_texto_reconstruido = ["\n".join(linhas) for linhas in paginas_linhas]
    texto_completo = "\n".join(paginas_texto_reconstruido).lower()

    banco = next((nome for regex, nome in _MARCADORES_BANCO if regex.search(texto_completo)), None)

    movimentos: List[Movimento] = []
    if banco == "nubank":
        movimentos = _parse_pdf_nubank(paginas_texto_reconstruido, origem)
    elif banco == "c6":
        movimentos = _parse_pdf_c6(paginas_texto_reconstruido, origem)
    elif banco == "cora":
        movimentos = _parse_pdf_cora(paginas_texto_reconstruido, origem)
    elif banco == "pagbank":
        movimentos = _parse_pdf_pagbank(paginas_texto_reconstruido, origem)
    elif banco == "sicoob":
        movimentos = _parse_pdf_sicoob(paginas_linhas, origem)
    elif banco == "caixa":
        movimentos = _parse_pdf_gerenciador_caixa(paginas_linhas, origem)
    elif banco == "itau":
        movimentos = _parse_pdf_itau(path, origem)

    if not movimentos:
        movimentos = _parse_pdf_linhas_data_valor(paginas_texto_reconstruido, origem)
    if not movimentos:
        movimentos = _parse_pdf_extrato_dia_agrupado(paginas_texto_reconstruido, origem)
    if not movimentos:
        movimentos = _parse_pdf_gerenciador_caixa(paginas_linhas, origem)

    if not movimentos:
        dica_ocr = (
            " O PDF nao tinha texto embutido e foi lido via OCR - se o layout for diferente dos "
            "bancos ja suportados, pode ser necessario ajustar o parser."
            if usado_ocr else ""
        )
        raise ValueError(
            f"Nenhuma linha reconhecida em {path}.{dica_ocr} O layout deste PDF nao bate com "
            "nenhum dos padroes conhecidos - ajuste parse_pdf_generic() para este formato."
        )

    if usado_ocr:
        for mov in movimentos:
            mov.origem_ocr = True

    return movimentos


def parse_movimentos(path: str, origem: str, **kwargs) -> List[Movimento]:
    ext = Path(path).suffix.lower()
    if ext == ".ofx":
        return parse_ofx(path, origem=origem)
    if ext == ".csv":
        return parse_csv_movimentos(path, origem=origem, **kwargs)
    if ext == ".pdf":
        return parse_pdf_generic(path, origem=origem)
    raise ValueError(f"Extensao nao suportada: {ext} ({path})")


# ---------------------------------------------------------------------------
# Parser do balancete (mapeamento de codigos internos)
# ---------------------------------------------------------------------------

_BAL_LINE_RE = re.compile(
    r"^\s*(?P<codigo>\d+)\s+(?P<classif>\d+(?:\.\d+)+)\s+(?P<nome>.+?)\s*$"
)

_TOKEN_MONETARIO_RE = re.compile(r"^\(?-?\d{1,3}(?:\.\d{3})*,\d{2}\)?[DC]?$", re.IGNORECASE)

# usado quando so da pra recuperar codigo+classificacao de uma linha de
# balancete com sobreposicao de texto complexa demais - o nome real fica
# ilegivel, mas ainda assim marcamos com esse texto (nunca inventando um
# nome) pra conta aparecer na lista pra vincular por codigo. O CODIGO entra
# no proprio texto do nome pra cada conta recuperada ficar com um nome
# UNICO (nunca repetido entre contas diferentes) - sem isso,
# localizar_conta() (usada pra resolver a conta banco escolhida na tela)
# acha varias contas com o mesmo nome exato e desiste (match ambiguo),
# fazendo a conta banco "sumir" (vira None) e nenhuma contrapartida
# aplicada consegue ser gravada.
NOME_ILEGIVEL_BALANCETE_PREFIXO = "⚠️ Nome não identificado"


def _nome_ilegivel_balancete(codigo: str) -> str:
    return f"{NOME_ILEGIVEL_BALANCETE_PREFIXO} (conta {codigo} - texto sobreposto no PDF de origem, confira o balancete)"


def _limpar_nome_conta(nome: str) -> str:
    """Balancetes reais em PDF trazem saldo anterior/debito/credito/saldo
    atual na mesma linha do nome da conta. Remove esses tokens monetarios
    do final, preservando o nome (inclusive numeros que fazem parte dele,
    como numero de conta/agencia, que nao tem cara de valor monetario)."""
    tokens = nome.split()
    while len(tokens) > 1 and _TOKEN_MONETARIO_RE.match(tokens[-1]):
        tokens.pop()
    return " ".join(tokens).strip() or nome.strip()


def _reparar_linhas_balancete_sobrepostas(page, linhas_texto: List[str]) -> List[str]:
    """Alguns balancetes em PDF tem, em certas linhas (normalmente contas
    com nome mais longo, ex. "BANCO C6 BANK"), DUAS cadeias de texto
    desenhadas sobrepostas no mesmo trecho horizontal: uma com os digitos
    do codigo/classificacao (fonte mais estreita) e outra com "BANCO
    <nome>" (fonte mais larga). A extracao sequencial por posicao X
    intercala os caracteres das duas cadeias, produzindo lixo tipo 'BAN13
    C32O 1C.16.1 .B02A.0N0K008BANCO C6 BANK...' - o codigo some da lista
    de contas do balancete sem aviso nenhum (a linha simplesmente nao
    bate em _BAL_LINE_RE). Como as duas fontes tem largura de caractere
    bem diferente (digitos ~3px, letras ~5px neste tipo de PDF), da pra
    separar as duas cadeias por largura e reconstruir cada uma
    corretamente. So repara quando acha, nos chars da pagina, um grupo
    cuja reconstrucao NATURAL (sem separar por largura) bate exatamente
    com a linha problematica - isso confirma que e o grupo certo antes de
    tentar consertar (nunca inventa um codigo: se o resultado reparado
    nao bater no padrao esperado, a linha original fica como estava e
    simplesmente nao entra na lista de contas, do jeito que ja era)."""
    def _juntar_com_espacos(chars: list, limiar: float = 1.5) -> str:
        """Reconstroi o texto na ordem X, inserindo um espaco sempre que o
        vao ate o proximo char for maior que `limiar` - os espacos LITERAIS
        capturados (glifo ' ') sao ambiguos na zona de sobreposicao (podem
        pertencer a qualquer uma das 2 cadeias por terem largura estreita,
        misturando com os digitos), entao sao descartados e recalculados
        aqui a partir do espacamento real entre os caracteres de CADA
        cadeia separadamente."""
        partes = []
        anterior = None
        for c in chars:
            if c["text"] == " ":
                continue
            if anterior is not None and c["x0"] - anterior["x1"] > limiar:
                partes.append(" ")
            partes.append(c["text"])
            anterior = c
        return "".join(partes)

    try:
        chars_por_linha: Dict[int, list] = {}
        for c in page.chars:
            chave = round(c["top"])
            chars_por_linha.setdefault(chave, []).append(c)
    except Exception:
        return linhas_texto

    resultado = list(linhas_texto)
    pendentes = {i for i, l in enumerate(linhas_texto) if l.strip() and not _BAL_LINE_RE.match(l)}
    if not pendentes:
        return resultado

    codigos_recuperados: List[str] = []

    for chars_linha in chars_por_linha.values():
        chars_ordenados = sorted(chars_linha, key=lambda c: c["x0"])
        texto_natural = "".join(c["text"] for c in chars_ordenados).strip()
        if not texto_natural:
            continue
        # extract_text() insere espacos sinteticos entre grupos de
        # caracteres com base no espacamento visual, que nao correspondem
        # a nenhum char real - compara ignorando espacos dos dois lados
        # pra achar o grupo certo de qualquer forma.
        chave_natural = re.sub(r"\s+", "", texto_natural)
        for i in list(pendentes):
            if re.sub(r"\s+", "", linhas_texto[i]) != chave_natural:
                continue
            prefixo = [c for c in chars_ordenados if c["x0"] < 100]
            resto = [c for c in chars_ordenados if c["x0"] >= 100]
            reparada = False
            if prefixo and resto:
                # precisa das DUAS condicoes pra entrar no fluxo do
                # codigo/classificacao - largura ESTREITA (fonte do
                # codigo, ~3.3px nesse tipo de balancete) E ser
                # digito/ponto. So a largura nao basta: um hifen dentro
                # do nome da conta (ex.: "MATERIA-PRIMA") tem largura
                # parecida com a de um digito nessa fonte e contaminaria
                # o codigo se entrasse so por largura. So o conteudo
                # tambem nao basta: um digito que faz parte do NOME (ex.:
                # o "6" de "C6 Bank") pode cair dentro da mesma faixa X
                # do codigo por acaso, mas e desenhado na fonte LARGA do
                # nome (bem mais largo que os digitos do codigo) - exigir
                # as duas evita tanto contaminar o codigo com um hifen
                # quanto com um digito que na verdade e parte do nome.
                estreitos = sorted(
                    (c for c in prefixo
                     if (c["text"].isdigit() or c["text"] == ".") and (c["x1"] - c["x0"]) < 4.5),
                    key=lambda c: c["x0"],
                )
                largos = sorted(
                    (c for c in prefixo if c["text"] != " " and c not in estreitos),
                    key=lambda c: c["x0"],
                )
                if estreitos and largos:
                    texto_estreito = _juntar_com_espacos(estreitos)
                    texto_resto = _juntar_com_espacos(sorted(resto, key=lambda c: c["x0"]))
                    linha_reparada = f"{texto_estreito} {texto_resto}".strip()
                    if _BAL_LINE_RE.match(linha_reparada):
                        resultado[i] = linha_reparada
                        reparada = True
            if not reparada:
                # Sobreposicao complexa demais pra separar codigo/nome com
                # confianca (ex.: a cadeia do nome comeca ANTES do codigo,
                # nao so depois) - mas os digitos do codigo/classificacao,
                # tomados so entre si (ignorando as letras intercaladas),
                # mantem a ordem e o espacamento reais entre eles, entao
                # ainda da pra recuperar SO codigo+classificacao com
                # confianca (o nome, esse sim, fica ilegivel e marcado como
                # tal - nunca inventado). Sem isso a conta simplesmente
                # sumiria da lista pra vincular, sem nenhum aviso.
                digitos = [
                    c for c in chars_ordenados
                    if c["text"] != " " and (c["text"].isdigit() or c["text"] == ".")
                ]
                tokens = _juntar_com_espacos(digitos).split()
                if (
                    len(tokens) >= 2 and tokens[0].isdigit()
                    and re.match(r"^\d+(\.\d+)+$", tokens[1])
                ):
                    linha_reparada = f"{tokens[0]} {tokens[1]} {_nome_ilegivel_balancete(tokens[0])}"
                    if _BAL_LINE_RE.match(linha_reparada):
                        resultado[i] = linha_reparada
                        codigos_recuperados.append(tokens[0])
            pendentes.discard(i)
            break

    if codigos_recuperados:
        # print() puro (sem passar pelo NOME_ILEGIVEL_BALANCETE, que tem
        # emoji) pra nao depender da codificacao do console/log onde o app
        # estiver rodando - o aviso COM emoji continua aparecendo pro
        # usuario normalmente, so nao no nome da conta em si.
        print(f"!!! {len(codigos_recuperados)} conta(s) do balancete tem nome de conta comprido "
              "demais e ficou sobreposto no PDF de origem - o codigo foi recuperado mas o nome "
              "nao pode ser lido com confianca (aparece marcado como nao identificado na lista "
              "de contas). Confira o nome real no balancete original antes de vincular: "
              + ", ".join(codigos_recuperados))

    return resultado


def parse_balancete(path: str) -> List[ContaBalancete]:
    """Aceita CSV com colunas (codigo, classificacao, conta) ou texto/PDF
    com linhas no padrao '<codigo> <classificacao> <nome da conta>'."""
    ext = Path(path).suffix.lower()
    contas: List[ContaBalancete] = []

    if ext == ".csv":
        text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
        delimiter = ";" if text.count(";") > text.count(",") else ","
        linhas = text.splitlines()
        # balancetes reais costumam ter 1+ linhas de titulo/competencia antes
        # do cabecalho da tabela - procura a linha que parece ser o cabecalho
        idx_header = 0
        for i, linha in enumerate(linhas):
            if re.search(r"\bcod", linha, re.IGNORECASE) and delimiter in linha:
                idx_header = i
                break
        reader = csv.DictReader(linhas[idx_header:], delimiter=delimiter)
        fieldnames = reader.fieldnames or []
        ccod = _find_col(fieldnames, ["codigo", "código", "cod", "codigo interno"])
        cclass = _find_col(fieldnames, ["classificacao", "classificação", "classif"])
        cnome = _find_col(fieldnames, ["conta", "nome", "descricao", "descrição"])
        if not (ccod and cnome):
            raise ValueError(f"Balancete CSV sem colunas codigo/conta reconheciveis: {fieldnames}")
        for row in reader:
            codigo = (row.get(ccod) or "").strip()
            if not codigo:
                continue
            contas.append(ContaBalancete(
                codigo=codigo,
                classificacao=(row.get(cclass) or "").strip(),
                nome=(row.get(cnome) or "").strip(),
            ))
        return contas

    if ext == ".pdf":
        try:
            import pdfplumber  # type: ignore
        except ImportError as exc:
            raise ImportError("Leitura de balancete PDF requer pdfplumber.") from exc
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                linhas = _reparar_linhas_balancete_sobrepostas(page, text.splitlines())
                for line in linhas:
                    m = _BAL_LINE_RE.match(line)
                    if m:
                        contas.append(ContaBalancete(
                            codigo=m.group("codigo"),
                            classificacao=m.group("classif"),
                            nome=_limpar_nome_conta(m.group("nome")),
                        ))
        if not contas:
            raise ValueError(f"Nenhuma linha de balancete reconhecida em {path}.")
        return contas

    raise ValueError(f"Extensao de balancete nao suportada: {ext}")


def localizar_conta(contas: List[ContaBalancete], termo: str) -> Optional[ContaBalancete]:
    """Busca por substring (case-insensitive) no nome da conta. Nao inventa
    codigo: retorna None se nao achar match claro (skill exige confirmacao)."""
    termo_norm = termo.strip().lower()
    achados = [c for c in contas if termo_norm in c.nome.lower()]
    if len(achados) == 1:
        return achados[0]
    if len(achados) > 1:
        # match exato de nome desempata
        exatos = [c for c in achados if c.nome.lower() == termo_norm]
        if len(exatos) == 1:
            return exatos[0]
    return None


_TERMOS_CONTA_BANCO = ["banco", "caixa", "conta corrente", " cc ", "aplica", "poupan"]


def contas_provaveis_banco(contas: List[ContaBalancete]) -> List[ContaBalancete]:
    """Filtra do balancete as contas que provavelmente sao disponibilidades
    (banco/caixa/aplicacao) por palavra-chave no nome. E apenas uma sugestao
    para popular a lista de escolha - o usuario sempre confirma qual conta e
    a conta banco correta, o balancete e sempre a fonte de verdade."""
    return [c for c in contas if any(t in f" {c.nome.lower()} " for t in _TERMOS_CONTA_BANCO)]


# ---------------------------------------------------------------------------
# Identificacao automatica da conta banco: cruza o proprio extrato com o
# balancete, para nao depender de o usuario escolher/lancar manualmente.
# ---------------------------------------------------------------------------

_BANCOS_CONHECIDOS = [
    "banco do brasil", "bradesco", "itau", "itaú", "santander", "caixa economica federal",
    "caixa econômica federal", "nubank", "inter", "sicoob", "sicredi", "safra", "original",
    "banco pan", "banrisul", "pagseguro", "pagbank", "mercado pago", "stone", "c6 bank",
    "btg pactual", "neon", "next", "modal", "will bank", "caixa",
]


def extrair_identificador_banco(path: str) -> Optional[str]:
    """Tenta achar o nome do banco a partir do proprio extrato: campo ORG do
    OFX, ou nome de banco conhecido no texto/nome do arquivo (PDF/CSV)."""
    ext = Path(path).suffix.lower()
    if ext == ".ofx":
        raw = Path(path).read_text(encoding="latin-1", errors="replace")
        m = re.search(r"<ORG>([^<\r\n]+)", raw, re.IGNORECASE)
        if m:
            org = m.group(1).strip().lower()
            for nome in _BANCOS_CONHECIDOS:
                if nome in org:
                    return nome
        texto = raw
    else:
        texto = extrair_texto_arquivo(path)

    busca = f"{Path(path).stem} {texto}".lower()
    for nome in _BANCOS_CONHECIDOS:
        if nome in busca:
            return nome
    return None


def detectar_conta_banco(extrato_path: str, contas: List[ContaBalancete]) -> Optional[ContaBalancete]:
    """Cruza o banco identificado no extrato com as contas de disponibilidades
    do balancete. So devolve resultado quando ha exatamente UM match
    inequivoco - em caso de duvida, devolve None e o usuario confirma
    (nunca inventa qual conta e a correta)."""
    ident = extrair_identificador_banco(extrato_path)
    if not ident:
        return None
    candidatas = contas_provaveis_banco(contas) or contas
    achados = [c for c in candidatas if ident in c.nome.lower()]
    if len(achados) == 1:
        return achados[0]
    return None


# ---------------------------------------------------------------------------
# Deteccao de competencia a partir do proprio arquivo do balancete
# ---------------------------------------------------------------------------

_MESES_PT = {
    "janeiro": 1, "fevereiro": 2, "marco": 3, "março": 3, "abril": 4, "maio": 5,
    "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10,
    "novembro": 11, "dezembro": 12,
}

_COMPETENCIA_EXPLICITA_RE = re.compile(
    r"(?:compet[êe]ncia|per[íi]odo|referente\s+a|m[êe]s\s*/?\s*ano)\D{0,15}?"
    r"(\d{1,2})\s*[/\-]\s*(\d{4})",
    re.IGNORECASE,
)
_MES_NOME_RE = re.compile(
    r"\b(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|"
    r"outubro|novembro|dezembro)\s*(?:/|de)?\s*(20\d{2})\b",
    re.IGNORECASE,
)
_DATA_GENERICA_RE = re.compile(r"\b(0[1-9]|1[0-2])[/\-](20\d{2})\b")


def extrair_texto_arquivo(path: str) -> str:
    """Extrai texto bruto de um arquivo (CSV/texto direto, PDF via pdfplumber)
    para uso em heuristicas como deteccao de competencia."""
    ext = Path(path).suffix.lower()
    if ext == ".pdf":
        try:
            import pdfplumber  # type: ignore
        except ImportError:
            return ""
        partes = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                partes.append(page.extract_text() or "")
        return "\n".join(partes)
    return Path(path).read_text(encoding="utf-8-sig", errors="replace")


def detectar_competencia(texto: str) -> Optional[str]:
    """Tenta achar a competencia (MM-AAAA) no texto do balancete: primeiro
    por mencao explicita ('Competencia 01/2026', 'Periodo 01/2026'), depois
    por nome de mes + ano, depois por qualquer data MM/AAAA no documento."""
    m = _COMPETENCIA_EXPLICITA_RE.search(texto)
    if m:
        mes, ano = int(m.group(1)), m.group(2)
        if 1 <= mes <= 12:
            return f"{mes:02d}-{ano}"

    m = _MES_NOME_RE.search(texto)
    if m:
        mes_nome = m.group(1).lower().replace("ç", "c")
        mes = _MESES_PT.get(mes_nome) or _MESES_PT.get(m.group(1).lower())
        if mes:
            return f"{mes:02d}-{m.group(2)}"

    m = _DATA_GENERICA_RE.search(texto)
    if m:
        return f"{m.group(1)}-{m.group(2)}"

    return None


# ---------------------------------------------------------------------------
# Classificacao heuristica de pendencias (NAO decide conta sozinha - so sugere
# uma PALAVRA-CHAVE para buscar no balancete; a confirmacao final e humana)
# ---------------------------------------------------------------------------

_REGRAS_CATEGORIA = [
    (re.compile(r"tarifa|manuten[cç][aã]o\s*cc|pacote\s*servi", re.I), "Tarifa bancaria", "Tarifas"),
    (re.compile(r"\biof\b", re.I), "IOF", "IOF"),
    (re.compile(r"juros.*aplic|rendiment|cdb|rdb", re.I), "Rendimento aplicacao", "Receita financeira"),
    (re.compile(r"pix\b", re.I), "PIX", None),
    (re.compile(r"cheque", re.I), "Cheque", None),
    (re.compile(r"folha|sal[aá]rio|d[eé]cimo", re.I), "Folha de pagamento", "Salarios a pagar"),
    (re.compile(r"darf|das\b|fgts|inss|imposto|tribut", re.I), "Tributo", "Impostos a recolher"),
    (re.compile(r"empr[eé]stimo|financiamento|parcela", re.I), "Emprestimo/financiamento", "Emprestimos"),
    (re.compile(r"estorno|devolu", re.I), "Estorno/devolucao", None),
]


def classificar(desc: str) -> Tuple[Optional[str], Optional[str]]:
    for regex, categoria, termo_busca in _REGRAS_CATEGORIA:
        if regex.search(desc):
            return categoria, termo_busca
    return None, None


# ---------------------------------------------------------------------------
# Motor de match (multiset por dia, com janela de tolerancia de dias)
# ---------------------------------------------------------------------------

def _centavos(v: float) -> int:
    return round(v * 100)


def conciliar(
    extrato: List[Movimento],
    razao: List[Movimento],
    dias_tolerancia: int = 0,
) -> Tuple[List[Tuple[Movimento, Movimento]], List[Movimento], List[Movimento]]:
    """Casa movimentos do extrato com o razao por (data +/- tolerancia, valor).
    Retorna (pares_casados, pendentes_lado_banco, pendentes_lado_razao)."""

    razao_restante = list(razao)
    pareados: List[Tuple[Movimento, Movimento]] = []
    pendentes_banco: List[Movimento] = []

    for mov_e in sorted(extrato, key=lambda m: m.data):
        candidato_idx = None
        for delta in range(0, dias_tolerancia + 1):
            for sinal in ((0,) if delta == 0 else (delta, -delta)):
                data_alvo = mov_e.data + dt.timedelta(days=sinal)
                for i, mov_r in enumerate(razao_restante):
                    if mov_r.data == data_alvo and _centavos(mov_r.valor) == _centavos(mov_e.valor):
                        candidato_idx = i
                        break
                if candidato_idx is not None:
                    break
            if candidato_idx is not None:
                break

        if candidato_idx is not None:
            mov_r = razao_restante.pop(candidato_idx)
            mov_e.status = "OK"
            mov_r.status = "OK"
            pareados.append((mov_e, mov_r))
        else:
            pendentes_banco.append(mov_e)

    return pareados, pendentes_banco, razao_restante


# ---------------------------------------------------------------------------
# Geracao dos entregaveis
# ---------------------------------------------------------------------------

def fmt_money(v: float) -> str:
    s = f"{abs(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"-R$ {s}" if v < 0 else f"R$ {s}"


def gerar_espelho_md(
    conta_nome: str,
    competencia: str,
    saldo_inicial_razao: float,
    saldo_inicial_extrato: float,
    pareados: List[Tuple[Movimento, Movimento]],
    pendentes_banco: List[Movimento],
    pendentes_razao: List[Movimento],
    saldo_final_razao: float,
    saldo_final_extrato: float,
    aviso_ocr: bool = False,
) -> str:
    linhas = []
    linhas.append(f"# Conciliacao Bancaria - {conta_nome}")
    linhas.append(f"Periodo: {competencia}\n")
    if aviso_ocr:
        linhas.append(
            "> ⚠️ **ATENCAO**: parte destes lancamentos foi lida via OCR (o PDF original nao "
            "tinha texto embutido). OCR pode errar digitos em valores monetarios - confira "
            "cada valor abaixo contra o extrato original antes de confiar neles ou importar "
            "no Dominio.\n"
        )
    linhas.append(f"Saldo inicial razao: {fmt_money(saldo_inicial_razao)}  ===  "
                   f"Saldo inicial extrato: {fmt_money(saldo_inicial_extrato)}  "
                   f"{'(conferido)' if _centavos(saldo_inicial_razao) == _centavos(saldo_inicial_extrato) else '(!!! DIVERGENTE !!!)'}\n")

    linhas.append("## Itens casados (extrato = razao)")
    linhas.append("| Data | Descricao | Valor |")
    linhas.append("|---|---|---:|")
    for mov_e, _ in sorted(pareados, key=lambda p: p[0].data):
        marca = " ⚠️" if mov_e.alerta_valor else ""
        linhas.append(f"| {mov_e.data:%d/%m/%Y} | {mov_e.descricao}{marca} | {fmt_money(mov_e.valor)} |")

    linhas.append("\n## Pendencias lado banco (no extrato, falta lancar no razao)")
    if pendentes_banco:
        linhas.append("| Data | Descricao | Valor | Categoria sugerida | Debito | Credito |")
        linhas.append("|---|---|---:|---|---|---|")
        for mov in sorted(pendentes_banco, key=lambda m: m.data):
            marca = " ⚠️" if mov.alerta_valor else ""
            linhas.append(
                f"| {mov.data:%d/%m/%Y} | {mov.descricao}{marca} | {fmt_money(mov.valor)} | "
                f"{mov.categoria or '-'} | {mov.conta_debito or '**A CONFIRMAR**'} | "
                f"{mov.conta_credito or '**A CONFIRMAR**'} |"
            )
    else:
        linhas.append("_Nenhuma._")

    todos_com_alerta = [
        m for m in list(pendentes_banco) + [p[0] for p in pareados] + list(pendentes_razao)
        if m.alerta_valor
    ]
    if todos_com_alerta:
        linhas.append("\n## ⚠️ Lancamentos com valor a conferir (OCR)")
        linhas.append(
            "O valor lido nao bateu com a variacao do saldo impresso no extrato original - "
            "confira estes especificamente antes de importar:"
        )
        for mov in sorted(todos_com_alerta, key=lambda m: m.data):
            linhas.append(f"- {mov.data:%d/%m/%Y} — {mov.descricao} — {fmt_money(mov.valor)}")

    linhas.append("\n## Pendencias lado razao (cheques/depositos em transito - nao aparecem ainda no extrato)")
    if pendentes_razao:
        linhas.append("| Data | Descricao | Valor |")
        linhas.append("|---|---|---:|")
        for mov in sorted(pendentes_razao, key=lambda m: m.data):
            linhas.append(f"| {mov.data:%d/%m/%Y} | {mov.descricao} | {fmt_money(mov.valor)} |")
    else:
        linhas.append("_Nenhuma._")

    cheques_pendentes = sum(m.valor for m in pendentes_razao if m.valor < 0)
    depositos_transito = sum(m.valor for m in pendentes_razao if m.valor > 0)
    saldo_conciliado = saldo_final_razao - cheques_pendentes + depositos_transito
    diferenca = round(saldo_conciliado - saldo_final_extrato, 2)

    linhas.append("\n## Fechamento de saldo")
    linhas.append(f"- Saldo final razao: {fmt_money(saldo_final_razao)}")
    linhas.append(f"- (+) Cheques pendentes: {fmt_money(-cheques_pendentes)}")
    linhas.append(f"- (-) Depositos em transito: {fmt_money(depositos_transito)}")
    linhas.append(f"- = Saldo conciliado: {fmt_money(saldo_conciliado)}")
    linhas.append(f"- Saldo final extrato: {fmt_money(saldo_final_extrato)}")
    status = "OK - fechou com tolerancia ZERO" if diferenca == 0 else f"!!! DIFERENCA DE {fmt_money(diferenca)} - INVESTIGAR !!!"
    linhas.append(f"- **DIFERENCA: {fmt_money(diferenca)} -> {status}**")

    return "\n".join(linhas)


def gerar_memoria_csv(path: str, todos: List[Movimento]) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["data", "origem", "descricao", "valor", "status", "categoria", "conta_debito", "conta_credito"])
        for mov in sorted(todos, key=lambda m: (m.data, m.origem)):
            w.writerow([
                mov.data.strftime("%d/%m/%Y"), mov.origem, mov.descricao,
                f"{mov.valor:.2f}".replace(".", ","), mov.status,
                mov.categoria or "", mov.conta_debito or "", mov.conta_credito or "",
            ])


def gerar_importacao_dominio(
    path: str,
    lancamentos: List[Movimento],
    cod_historico_padrao: str = "",
    empresa_codigo: str = "",
) -> int:
    """Gera o TXT no leiaute Dominio 'Lancamentos Contabeis (Partida
    Simples/Multiplas) (3.1)': 10 colunas ';', decimal ',', sem cabecalho,
    latin-1, CRLF. So inclui lancamentos com conta_debito E conta_credito
    ja confirmadas contra o balancete (nunca inventa codigo).

    `empresa_codigo` (o "Codigo da empresa no Dominio" informado na tela) e
    gravado na coluna "Codigo Matriz/Filial" - a unica coluna do leiaute
    oficial que identifica a empresa/filial do lancamento. So preenche
    quando o cliente NAO tem matriz/filiais cadastradas separadamente no
    Dominio; se tiver, o codigo correto de cada filial deve prevalecer.

    Retorna a quantidade de linhas gravadas."""
    prontos = [m for m in lancamentos if m.conta_debito and m.conta_credito]
    linhas = []
    for mov in sorted(prontos, key=lambda m: m.data):
        valor = f"{abs(mov.valor):.2f}".replace(".", ",")
        complemento = mov.descricao.replace(";", ",")
        campos = [
            mov.data.strftime("%d/%m/%Y"),
            mov.conta_debito,
            mov.conta_credito,
            valor,
            cod_historico_padrao,
            complemento,
            "1",  # Inicia Lote - partida simples: sempre 1
            empresa_codigo,  # Codigo Matriz/Filial = codigo da empresa no Dominio
            "",   # Centro de Custo Debito
            "",   # Centro de Custo Credito
        ]
        linhas.append(";".join(campos))

    with open(path, "wb") as f:
        conteudo = "\r\n".join(linhas)
        if linhas:
            conteudo += "\r\n"
        f.write(conteudo.encode("latin-1", errors="replace"))
    return len(prontos)


# ---------------------------------------------------------------------------
# Pipeline principal
# ---------------------------------------------------------------------------

@dataclass
class ResultadoProcessamento:
    """Estado intermediario da conciliacao, ANTES de gravar arquivos - permite
    a interface aplicar uma correcao de contrapartida em massa (ex.: todo
    pagamento sem fornecedor identificado -> conta X) e so entao gerar os
    entregaveis, sem reprocessar extrato/razao/balancete do zero."""
    competencia: str
    contas: List[ContaBalancete]
    conta_banco: Optional[ContaBalancete]
    conta_contabil_nome: str
    extrato: List[Movimento]
    razao: List[Movimento]
    pareados: List[Tuple[Movimento, Movimento]]
    pendentes_banco: List[Movimento]
    pendentes_razao: List[Movimento]
    saldo_inicial_razao: float
    saldo_inicial_extrato: float


def processar(
    extrato_path: str,
    balancete_path: str,
    conta_contabil_nome: str,
    saldo_inicial_razao: float,
    saldo_inicial_extrato: float,
    razao_path: Optional[str] = None,
    competencia: Optional[str] = None,
    dias_tolerancia: int = 0,
    col_data: Optional[str] = None,
    col_valor: Optional[str] = None,
    col_descricao: Optional[str] = None,
) -> ResultadoProcessamento:
    """Le extrato/razao/balancete, concilia item a item e classifica as
    pendencias - sem gravar nada em disco ainda. Se `competencia` vier vazio/
    None, tenta detectar automaticamente a partir do texto do proprio
    balancete (que e sempre a referencia).

    `razao_path` e opcional: sem razao previa (ex. cliente novo, nada ainda
    escriturado no periodo), todo item do extrato vira pendencia de
    lancamento - o balancete continua sendo a fonte para mapear as contas."""
    print(f"[1/6] Lendo extrato: {extrato_path}")
    extrato = parse_movimentos(extrato_path, origem="extrato",
                                col_data=col_data, col_valor=col_valor, col_descricao=col_descricao)
    print(f"      {len(extrato)} movimentos.")

    if razao_path:
        print(f"[2/6] Lendo razao: {razao_path}")
        razao = parse_movimentos(razao_path, origem="razao",
                                  col_data=col_data, col_valor=col_valor, col_descricao=col_descricao)
        print(f"      {len(razao)} lancamentos.")
    else:
        print("[2/6] Razao nao informada - todos os itens do extrato serao tratados "
              "como pendentes de lancamento (nada a comparar).")
        razao = []

    print(f"[3/6] Lendo balancete: {balancete_path}")
    contas = parse_balancete(balancete_path)
    print(f"      {len(contas)} contas mapeadas.")

    if not competencia or not competencia.strip():
        print("[4/6] Competencia nao informada - detectando a partir do balancete...")
        competencia = detectar_competencia(extrair_texto_arquivo(balancete_path))
        if not competencia:
            raise ValueError(
                "Nao foi possivel detectar a competencia a partir do balancete. "
                "Informe manualmente no formato MM-AAAA."
            )
        print(f"      Competencia detectada: {competencia}")
    else:
        competencia = competencia.strip()
        print(f"[4/6] Competencia informada: {competencia}")

    conta_banco = localizar_conta(contas, conta_contabil_nome)
    if conta_banco:
        print(f"      Conta banco identificada: {conta_banco.codigo} - {conta_banco.nome}")
    else:
        print(f"      !!! ATENCAO: nao encontrei '{conta_contabil_nome}' no balancete de forma inequivoca. "
              "Contrapartidas de banco ficarao em aberto para confirmacao manual.")

    print("[5/6] Conciliando item a item...")
    pareados, pendentes_banco, pendentes_razao = conciliar(extrato, razao, dias_tolerancia=dias_tolerancia)
    print(f"      Casados: {len(pareados)} | Pendentes banco: {len(pendentes_banco)} | Pendentes razao: {len(pendentes_razao)}")

    print("[6/6] Classificando pendencias e sugerindo contrapartidas...")
    for mov in pendentes_banco:
        categoria, termo_busca = classificar(mov.descricao)
        mov.categoria = categoria
        if conta_banco:
            if mov.valor >= 0:
                mov.conta_credito = conta_banco.codigo if mov.valor < 0 else None
                mov.conta_debito = conta_banco.codigo if mov.valor >= 0 else None
            else:
                mov.conta_credito = conta_banco.codigo
        contrapartida = localizar_conta(contas, termo_busca) if termo_busca else None
        if contrapartida:
            if mov.valor >= 0:
                mov.conta_credito = contrapartida.codigo
            else:
                mov.conta_debito = contrapartida.codigo
        else:
            mov.status = "conta_nao_identificada"

    return ResultadoProcessamento(
        competencia=competencia,
        contas=contas,
        conta_banco=conta_banco,
        conta_contabil_nome=conta_contabil_nome,
        extrato=extrato,
        razao=razao,
        pareados=pareados,
        pendentes_banco=pendentes_banco,
        pendentes_razao=pendentes_razao,
        saldo_inicial_razao=saldo_inicial_razao,
        saldo_inicial_extrato=saldo_inicial_extrato,
    )


def aplicar_contrapartida_padrao(
    pendentes_banco: List[Movimento],
    conta_banco: Optional[ContaBalancete],
    conta_saida_codigo: Optional[str] = None,
    conta_entrada_codigo: Optional[str] = None,
) -> int:
    """Aplica, de uma vez so, um codigo de conta padrao escolhido pelo
    usuario as pendencias que ainda estao sem contrapartida especifica
    identificada (ex.: todo 'Pix enviado'/'Pagamento efetuado' para
    fornecedor nao cadastrado -> debita Fornecedores; todo recebimento sem
    identificacao -> credita Adiantamento de Clientes/Outras obrigacoes).
    So mexe em quem ainda esta 'conta_nao_identificada' - nunca sobrescreve
    uma contrapartida ja resolvida especificamente. Retorna quantos itens
    foram resolvidos."""
    if not conta_banco:
        return 0
    aplicados = 0
    for mov in pendentes_banco:
        if mov.status != "conta_nao_identificada":
            continue
        if mov.valor < 0 and conta_saida_codigo:
            mov.conta_debito = conta_saida_codigo
            mov.conta_credito = conta_banco.codigo
            mov.categoria = mov.categoria or "Pagamento (conta padrao aplicada)"
            mov.status = "pendente"
            aplicados += 1
        elif mov.valor >= 0 and conta_entrada_codigo:
            mov.conta_credito = conta_entrada_codigo
            mov.conta_debito = conta_banco.codigo
            mov.categoria = mov.categoria or "Recebimento (conta padrao aplicada)"
            mov.status = "pendente"
            aplicados += 1
    return aplicados


def gerar_saidas(
    out_dir: str,
    resultado: ResultadoProcessamento,
    empresa_codigo: str = "",
    cod_historico: str = "",
) -> Dict[str, object]:
    """Grava os 3 entregaveis (espelho, memoria, importacao Dominio) a
    partir de um ResultadoProcessamento (ja com eventuais correcoes de
    contrapartida aplicadas). Retorna os caminhos e metricas do resultado."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    saldo_final_razao = resultado.saldo_inicial_razao + sum(m.valor for m in resultado.razao)
    saldo_final_extrato = resultado.saldo_inicial_extrato + sum(m.valor for m in resultado.extrato)
    todos_movs = resultado.extrato + resultado.razao
    aviso_ocr = any(m.origem_ocr for m in todos_movs)
    qtd_alertas_valor = sum(1 for m in todos_movs if m.alerta_valor)

    espelho = gerar_espelho_md(
        conta_nome=resultado.conta_contabil_nome,
        competencia=resultado.competencia,
        saldo_inicial_razao=resultado.saldo_inicial_razao,
        saldo_inicial_extrato=resultado.saldo_inicial_extrato,
        pareados=resultado.pareados,
        pendentes_banco=resultado.pendentes_banco,
        pendentes_razao=resultado.pendentes_razao,
        saldo_final_razao=saldo_final_razao,
        saldo_final_extrato=saldo_final_extrato,
        aviso_ocr=aviso_ocr,
    )
    espelho_path = out / f"espelho_{resultado.competencia}.md"
    espelho_path.write_text(espelho, encoding="utf-8")

    todos = resultado.extrato + resultado.razao
    memoria_path = out / f"memoria_{resultado.competencia}.csv"
    gerar_memoria_csv(str(memoria_path), todos)

    import_path = out / f"importacao_dominio_{empresa_codigo or 'empresa'}_{resultado.competencia}.txt"
    qtd_prontos = gerar_importacao_dominio(
        str(import_path), resultado.pendentes_banco,
        cod_historico_padrao=cod_historico, empresa_codigo=empresa_codigo,
    )

    sem_conta = [m for m in resultado.pendentes_banco if m.status == "conta_nao_identificada"]

    print("\n===== RESUMO =====")
    print(f"Espelho:              {espelho_path}")
    print(f"Memoria CSV:          {memoria_path}")
    print(f"Importacao Dominio:   {import_path} ({qtd_prontos} lancamentos prontos)")
    if sem_conta:
        print(f"\n!!! {len(sem_conta)} pendencia(s) SEM contrapartida identificada no balancete "
              "- NAO foram incluidas no arquivo de importacao. Confirme manualmente:")
        for mov in sem_conta:
            print(f"    - {mov.data:%d/%m/%Y}  {mov.descricao}  {fmt_money(mov.valor)}")
    print("\nLembrete: confira o codigo de historico usado (\"{}\") contra a tabela "
          "de historicos padrao do Dominio do escritorio antes de importar.".format(cod_historico or "<em branco>"))

    return {
        "espelho_path": espelho_path,
        "memoria_path": memoria_path,
        "import_path": import_path,
        "qtd_prontos": qtd_prontos,
        "sem_conta": sem_conta,
        "aviso_ocr": aviso_ocr,
        "qtd_alertas_valor": qtd_alertas_valor,
        "saldo_final_razao": saldo_final_razao,
        "saldo_final_extrato": saldo_final_extrato,
    }


def executar(
    extrato_path: str,
    balancete_path: str,
    conta_contabil_nome: str,
    saldo_inicial_razao: float,
    saldo_inicial_extrato: float,
    out_dir: str,
    razao_path: Optional[str] = None,
    competencia: Optional[str] = None,
    empresa_codigo: str = "",
    dias_tolerancia: int = 0,
    cod_historico: str = "",
    col_data: Optional[str] = None,
    col_valor: Optional[str] = None,
    col_descricao: Optional[str] = None,
) -> str:
    """Pipeline completo (CLI): processa e ja grava os entregaveis, sem
    correcao de contrapartida em massa (isso e feito pela interface, que usa
    `processar` + `aplicar_contrapartida_padrao` + `gerar_saidas` separados).
    Retorna a competencia efetivamente usada."""
    resultado = processar(
        extrato_path=extrato_path,
        balancete_path=balancete_path,
        conta_contabil_nome=conta_contabil_nome,
        saldo_inicial_razao=saldo_inicial_razao,
        saldo_inicial_extrato=saldo_inicial_extrato,
        razao_path=razao_path,
        competencia=competencia,
        dias_tolerancia=dias_tolerancia,
        col_data=col_data,
        col_valor=col_valor,
        col_descricao=col_descricao,
    )
    gerar_saidas(out_dir, resultado, empresa_codigo=empresa_codigo, cod_historico=cod_historico)
    return resultado.competencia


# ---------------------------------------------------------------------------
# Modo demo (dados sinteticos, sem depender de arquivos reais)
# ---------------------------------------------------------------------------

def _gerar_demo(tmpdir: Path) -> Dict[str, str]:
    extrato_csv = tmpdir / "extrato_demo.csv"
    razao_csv = tmpdir / "razao_demo.csv"
    balancete_csv = tmpdir / "balancete_demo.csv"

    extrato_csv.write_text(
        "data;descricao;valor\n"
        "02/01/2026;PIX RECEBIDO JOAO SILVA;5000,00\n"
        "03/01/2026;TARIFA MANUTENCAO CONTA;-25,00\n"
        "05/01/2026;IOF APLICACAO;-12,30\n"
        "07/01/2026;JUROS APLICACAO CDB;85,40\n"
        "10/01/2026;PAGAMENTO FORNECEDOR ABC LTDA;-1500,00\n"
        "15/01/2026;PIX RECEBIDO SEM IDENTIFICACAO;800,00\n",
        encoding="utf-8",
    )

    razao_csv.write_text(
        "data;descricao;valor\n"
        "02/01/2026;RECEBIMENTO CLIENTE JOAO SILVA;5000,00\n"
        "10/01/2026;PAGTO FORNECEDOR ABC LTDA;-1500,00\n"
        "28/01/2026;CHEQUE 12345 FORNECEDOR XYZ;-1200,00\n",
        encoding="utf-8",
    )

    balancete_csv.write_text(
        "Balancete de Verificacao - Empresa Demo LTDA - Competencia 01/2026\n"
        "codigo;classificacao;conta\n"
        "1270;1.1.1.02.00004;BANCO DEMO 12345-6\n"
        "200;1.1.2.01.00001;CLIENTES A RECEBER\n"
        "300;2.1.1.01.00001;FORNECEDORES\n"
        "361;3.2.3.04.00008;TARIFAS BANCARIAS\n"
        "362;3.2.3.04.00009;IOF\n"
        "150;3.1.1.01.00001;RECEITA FINANCEIRA\n"
        "555;2.1.5.01.00001;OUTRAS OBRIGACOES A REGULARIZAR\n",
        encoding="utf-8",
    )

    return {
        "extrato": str(extrato_csv),
        "razao": str(razao_csv),
        "balancete": str(balancete_csv),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Conciliacao bancaria automatizada com geracao de arquivo Dominio.")
    ap.add_argument("--extrato", help="Caminho do extrato/fluxo de caixa (.ofx/.csv/.pdf)")
    ap.add_argument("--razao", default=None,
                     help="Caminho do razao contabil da conta banco (.csv/.pdf). Opcional: sem razao, "
                          "todo item do extrato vira pendencia de lancamento (basta ter o balancete).")
    ap.add_argument("--balancete", help="Caminho do balancete (.csv/.pdf)")
    ap.add_argument("--conta-contabil", default="", help="Nome/trecho da conta banco a localizar no balancete")
    ap.add_argument("--competencia", default=None,
                     help="Formato MM-AAAA (ex: 01-2026). Se omitido, tenta detectar automaticamente "
                          "a partir do texto do proprio balancete.")
    ap.add_argument("--listar-contas-balancete", default=None, metavar="PATH",
                     help="So lista as contas encontradas em PATH (balancete) e sai - util para achar "
                          "o nome exato a usar em --conta-contabil.")
    ap.add_argument("--saldo-inicial-razao", type=float, default=0.0)
    ap.add_argument("--saldo-inicial-extrato", type=float, default=0.0)
    ap.add_argument("--empresa-codigo", default="", help="Codigo da empresa no Dominio (so para nome do arquivo)")
    ap.add_argument("--out-dir", default="./saida_conciliacao")
    ap.add_argument("--dias-tolerancia", type=int, default=0, help="Janela de dias para casar data (ex: cheques)")
    ap.add_argument("--cod-historico", default="", help="Codigo de historico padrao do Dominio (confirme antes de usar)")
    ap.add_argument("--col-data", default=None)
    ap.add_argument("--col-valor", default=None)
    ap.add_argument("--col-descricao", default=None)
    ap.add_argument("--demo", action="store_true", help="Roda com dados sinteticos, ignora --extrato/--razao/--balancete")

    args = ap.parse_args()

    if args.listar_contas_balancete:
        contas = parse_balancete(args.listar_contas_balancete)
        provaveis = {c.codigo for c in contas_provaveis_banco(contas)}
        print(f"{len(contas)} conta(s) no balancete ({args.listar_contas_balancete}):\n")
        for c in contas:
            marca = " <- provavel conta banco/caixa" if c.codigo in provaveis else ""
            print(f"  {c.codigo:>8}  {c.classificacao:<18}  {c.nome}{marca}")
        return

    if args.demo:
        tmpdir = Path(args.out_dir) / "_demo_input"
        tmpdir.mkdir(parents=True, exist_ok=True)
        paths = _gerar_demo(tmpdir)
        executar(
            extrato_path=paths["extrato"],
            razao_path=paths["razao"],
            balancete_path=paths["balancete"],
            conta_contabil_nome="BANCO DEMO 12345-6",
            competencia=args.competencia,
            saldo_inicial_razao=10000.00,
            saldo_inicial_extrato=10000.00,
            out_dir=args.out_dir,
            empresa_codigo=args.empresa_codigo or "demo",
            dias_tolerancia=args.dias_tolerancia,
            cod_historico=args.cod_historico,
        )
        return

    faltando = [n for n in ("extrato", "balancete", "conta_contabil") if not getattr(args, n)]
    if faltando:
        ap.error(f"Argumentos obrigatorios ausentes: {', '.join(faltando)} (ou use --demo)")

    executar(
        extrato_path=args.extrato,
        razao_path=args.razao,
        balancete_path=args.balancete,
        conta_contabil_nome=args.conta_contabil,
        competencia=args.competencia,
        saldo_inicial_razao=args.saldo_inicial_razao,
        saldo_inicial_extrato=args.saldo_inicial_extrato,
        out_dir=args.out_dir,
        empresa_codigo=args.empresa_codigo,
        dias_tolerancia=args.dias_tolerancia,
        cod_historico=args.cod_historico,
        col_data=args.col_data,
        col_valor=args.col_valor,
        col_descricao=args.col_descricao,
    )


if __name__ == "__main__":
    main()

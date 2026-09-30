"""Regras puras (sem Playwright) do RPA NF GO: padronização do arquivo
baixado da SEFAZ-GO, contagem de XMLs dentro do ZIP, leitura da quantidade
de notas mostrada na tela de resultado, conferência portal × ZIP e montagem
dos nomes/pastas de destino.

Separado de portal.py de propósito: dá pra testar tudo isso sem navegador,
e a tela do Hub (que não tem Playwright instalado) também usa os nomes de
pasta daqui pra montar o .zip "Baixar tudo" na mesma estrutura que o
worker grava em disco.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

PASTA_RAIZ = "RPA NF GO"
_CARACTERES_INVALIDOS = str.maketrans({c: "_" for c in '/\\:*?"<>|'})


# ---------------------------------------------------------------------------
# Nomes e pastas
# ---------------------------------------------------------------------------

def competencia_pasta(mm_aaaa: str) -> str:
    """'08/2026' -> '082026' (padrão de pasta/arquivo pedido pelo escritório)."""
    return (mm_aaaa or "").replace("/", "") or "sem-competencia"


def nome_pasta_empresa(codigo: str, razao_social: str = "") -> str:
    razao = (razao_social or "").strip()
    nome = f"{codigo} - {razao}" if razao else str(codigo)
    return nome.translate(_CARACTERES_INVALIDOS).strip()


def nome_zip(tipo: str, mm_aaaa: str) -> str:
    """ENTRADA_082026.zip / SAIDA_082026.zip"""
    return f"{tipo.upper()}_{competencia_pasta(mm_aaaa)}.zip"


def nome_evidencia(tipo: str, mm_aaaa: str) -> str:
    """ENTRADA_082026_consulta.png - print da tela de resultado (tem o total
    de notas que a SEFAZ encontrou), salvo junto com o ZIP."""
    return f"{tipo.upper()}_{competencia_pasta(mm_aaaa)}_consulta.png"


def pasta_relativa(codigo: str, razao_social: str, mm_aaaa: str, tipo: str) -> str:
    """'RPA NF GO/21 - EMPRESA/082026/ENTRADA' - mesma estrutura no disco
    (worker local) e no .zip "Baixar tudo" da tela do Hub."""
    return "/".join([
        PASTA_RAIZ, nome_pasta_empresa(codigo, razao_social), competencia_pasta(mm_aaaa), tipo.upper(),
    ])


# ---------------------------------------------------------------------------
# Arquivo baixado
# ---------------------------------------------------------------------------

class ArquivoInvalido(Exception):
    pass


def padronizar_download(conteudo: bytes, nome_original: str = "") -> bytes:
    """Garante que o que vai ser salvo é um .zip válido: se a SEFAZ entregar
    um XML solto (consulta com 1 nota só, por exemplo), embrulha num zip com
    o nome original; se não for nem zip nem XML (página de erro HTML, arquivo
    vazio), levanta ArquivoInvalido em vez de salvar lixo com nome de ZIP."""
    if not conteudo:
        raise ArquivoInvalido("arquivo baixado está vazio (0 bytes)")
    if zipfile.is_zipfile(io.BytesIO(conteudo)):
        return conteudo
    inicio = conteudo[:512].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if inicio.startswith(b"<?xml") or inicio.startswith(b"<nfeproc") or inicio.startswith(b"<nfe"):
        nome = Path(nome_original or "nota.xml").name
        if not nome.lower().endswith(".xml"):
            nome += ".xml"
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(nome, conteudo)
        return buffer.getvalue()
    if inicio.startswith(b"<!doctype html") or inicio.startswith(b"<html"):
        raise ArquivoInvalido("o portal devolveu uma página HTML em vez do arquivo (sessão expirada?)")
    raise ArquivoInvalido("arquivo baixado não é ZIP nem XML")


def _iterar_xmls(zf: zipfile.ZipFile, profundidade: int = 0):
    """Percorre os XMLs do zip, entrando em zip dentro de zip (1 nível já
    visto em portais estaduais que separam por modelo/mês)."""
    for nome in zf.namelist():
        if nome.endswith("/"):
            continue
        minusculo = nome.lower()
        if minusculo.endswith(".xml"):
            yield nome, zf.read(nome)
        elif minusculo.endswith(".zip") and profundidade < 2:
            try:
                with zipfile.ZipFile(io.BytesIO(zf.read(nome))) as interno:
                    yield from _iterar_xmls(interno, profundidade + 1)
            except zipfile.BadZipFile:
                continue


def contar_xmls(conteudo_zip: bytes) -> dict:
    """{'total': N, 'notas': N, 'eventos': N}. "Baixar documentos e eventos"
    traz também os XMLs de evento (cancelamento, carta de correção,
    manifestação) - só 'notas' (XML com <infNFe>) é comparável com o total
    que a SEFAZ mostra na tela de resultado."""
    total = notas = eventos = 0
    try:
        with zipfile.ZipFile(io.BytesIO(conteudo_zip)) as zf:
            for _nome, xml in _iterar_xmls(zf):
                total += 1
                if b"<infNFe" in xml or b":infNFe" in xml:
                    notas += 1
                else:
                    eventos += 1
    except zipfile.BadZipFile as exc:
        raise ArquivoInvalido("ZIP corrompido (download incompleto?)") from exc
    return {"total": total, "notas": notas, "eventos": eventos}


# ---------------------------------------------------------------------------
# Tela de resultado
# ---------------------------------------------------------------------------

_TEXTOS_SEM_RESULTADO = [
    "nenhum registro", "nenhum documento", "nenhuma nota", "nenhum resultado",
    "não foram encontrad", "nao foram encontrad", "não foi encontrad", "nao foi encontrad",
    "não existem", "nao existem", "não há documentos", "nao ha documentos",
]

# Ordem importa: do padrão mais específico pro mais genérico. Todos
# capturam o número em "n" (pode vir com separador de milhar: 1.234).
_PADROES_QUANTIDADE = [
    re.compile(r"(?:exibindo|mostrando|registros?)\s+\d+\s*(?:a|-|até|ate)\s*\d+\s+de\s+(?:um\s+total\s+de\s+)?(?P<n>\d[\d.]*)", re.I),
    re.compile(r"(?P<n>\d[\d.]*)\s+(?:registros?|documentos?|notas?(?:\s+fiscais)?|nf-?es?|resultados?|arquivos?)\s+(?:foram\s+)?(?:encontrad|localizad|retornad)", re.I),
    re.compile(r"(?:total|quantidade)\s+(?:de\s+)?(?:registros?|documentos?|notas?(?:\s+fiscais)?|nf-?es?|resultados?|arquivos?)\s*(?:encontrad[oa]s?|localizad[oa]s?)?\s*[:=\-]?\s*(?P<n>\d[\d.]*)(?![\d,])", re.I),
    re.compile(r"(?:encontrad[oa]s?|localizad[oa]s?)\s*[:=\-]?\s*(?P<n>\d[\d.]*)(?![\d,])", re.I),
    # "Total: 15" solto - o lookahead evita pegar valor monetário
    # ("Valor Total: 1.234,56" não casa)
    re.compile(r"\btotal\s*[:=]\s*(?P<n>\d+)(?![\d.,])", re.I),
]


def sem_resultado(texto_tela: str) -> bool:
    minusculo = (texto_tela or "").lower()
    return any(t in minusculo for t in _TEXTOS_SEM_RESULTADO)


def extrair_quantidade(texto_tela: str) -> int | None:
    """Total de notas que a SEFAZ diz ter encontrado, lido do texto da tela
    de resultado. None se nenhum padrão bater - aí o print (evidência) é a
    única fonte e a linha fica marcada pra conferência manual."""
    for padrao in _PADROES_QUANTIDADE:
        m = padrao.search(texto_tela or "")
        if m:
            return int(m.group("n").replace(".", ""))
    return None


def conferir(qtd_portal: int | None, contagem: dict) -> tuple[str, str]:
    """Compara o total da tela com os XMLs de nota do ZIP. Retorna
    (status, observacao): 'OK' | 'INCOMPLETO' | 'CONFERIR'.
      - INCOMPLETO: ZIP tem MENOS notas que a SEFAZ mostrou (download
        cortado/parcial) - vira ERRO na fila, pra dar pra reprocessar.
      - CONFERIR: quantidade da tela não foi lida, ou ZIP tem mais notas
        que a tela (não é perda de dado, mas vale olhar o print)."""
    notas = contagem["notas"]
    if qtd_portal is None:
        return "CONFERIR", f"Quantidade da tela não identificada automaticamente — ZIP tem {notas} nota(s); conferir o print."
    if notas < qtd_portal:
        return "INCOMPLETO", f"Download incompleto: SEFAZ mostrou {qtd_portal} nota(s), ZIP tem {notas}."
    if notas > qtd_portal:
        return "CONFERIR", f"ZIP tem {notas} nota(s), SEFAZ mostrou {qtd_portal} — conferir o print."
    return "OK", ""

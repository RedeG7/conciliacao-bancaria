"""Leitura da planilha de empresas (.xlsx) enviada pela tela do hub.

Mesmo padrao de rpa/issweb/planilha.py: a planilha vira bytes numa linha de
rpa_execucoes (auditoria/reprocesso) e cada empresa vira uma linha em
rpa_empresas. Diferencas:
  - cobre DOIS municipios no mesmo portal (Goiania e Aparecida de Goiania),
    entao filtra por uma lista em vez de um municipio unico, e Município
    aqui é OBRIGATÓRIO (o worker precisa saber qual sessão/caminho do
    portal usar por empresa - ver rpa/issnet/portal.py PORTAL_URLS).
  - não tem coluna "Obrigação": diferente do issweb, o issnet decide
    sozinho REST x DMS por empresa (gera o Livro Fiscal de Serviços
    Prestados primeiro; só processa Serviços Contratados se vier sem
    movimento - ver rpa/issnet/processar.py), não é escolha da planilha.
"""

import unicodedata
from io import BytesIO

from openpyxl import load_workbook

COLUNAS_OBRIGATORIAS = ["Código da Empresa", "CNPJ/CPF", "Município"]
COLUNA_RAZAO_SOCIAL = "Razão Social"


def _sem_acento(texto: str) -> str:
    """Remove acentos (NFKD + descarta marcas de combinação) - usado só
    pra COMPARAR município, nunca pra guardar (ver _normalizar_municipio).
    Bug real confirmado numa planilha do usuário: 15 de 18 empresas de
    Goiânia vinham digitadas como "GOIANIA" (sem circunflexo) em vez de
    "GOIÂNIA" - a comparação exata antiga descartava elas silenciosamente
    da lista, sem nenhum aviso (só "3 empresas encontradas" em vez de 18)."""
    return unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")


# Chave: município sem acento (pra comparar tolerando planilha digitada
# sem acento) -> valor: grafia CANÔNICA com acento, que é a mesma usada
# como chave em rpa/issnet/urls.py PORTAL_URLS - guardar qualquer coisa
# diferente disso faria o login por município falhar depois ("município
# desconhecido para issnet") mesmo a empresa tendo sido aceita aqui.
_MUNICIPIOS_ALVO = {
    _sem_acento("GOIÂNIA"): "GOIÂNIA",
    _sem_acento("APARECIDA DE GOIÂNIA"): "APARECIDA DE GOIÂNIA",
}


class PlanilhaInvalida(Exception):
    pass


def _mapear_cabecalho(ws) -> dict:
    return {str(c.value).strip(): i for i, c in enumerate(ws[1], start=1) if c.value}


def ler_empresas(conteudo: bytes) -> list[dict]:
    """Retorna [{'codigo', 'cnpj_cpf', 'obrigacao', 'municipio'}] só das
    linhas cujo Município seja Goiânia ou Aparecida de Goiânia. 'obrigacao'
    fica sempre vazio aqui (não vem da planilha, ver módulo docstring).
    Levanta PlanilhaInvalida com mensagem clara se faltar alguma coluna
    obrigatória."""
    try:
        wb = load_workbook(BytesIO(conteudo))
    except Exception as exc:
        raise PlanilhaInvalida(f"Não foi possível abrir o arquivo como planilha Excel (.xlsx): {exc}") from exc

    ws = wb.active
    mapa = _mapear_cabecalho(ws)

    faltando = [c for c in COLUNAS_OBRIGATORIAS if c not in mapa]
    if faltando:
        raise PlanilhaInvalida(
            f"Faltam colunas obrigatórias na planilha: {', '.join(faltando)}. "
            f"Colunas encontradas: {', '.join(mapa.keys()) or '(nenhuma)'}."
        )

    empresas = []
    for linha in range(2, ws.max_row + 1):
        codigo = ws.cell(row=linha, column=mapa["Código da Empresa"]).value
        if not codigo:
            continue

        municipio_bruto = str(ws.cell(row=linha, column=mapa["Município"]).value or "").strip().upper()
        municipio = _MUNICIPIOS_ALVO.get(_sem_acento(municipio_bruto))
        if municipio is None:
            continue

        razao_social = ""
        if COLUNA_RAZAO_SOCIAL in mapa:
            razao_social = str(ws.cell(row=linha, column=mapa[COLUNA_RAZAO_SOCIAL]).value or "").strip()

        empresas.append({
            "codigo": str(codigo).strip(),
            "cnpj_cpf": str(ws.cell(row=linha, column=mapa["CNPJ/CPF"]).value or "").strip(),
            "obrigacao": "",
            "municipio": municipio,
            "razao_social": razao_social,
        })

    if not empresas:
        raise PlanilhaInvalida(
            "Nenhuma empresa de Goiânia/Aparecida de Goiânia encontrada na planilha "
            "(confira a coluna Município e se há linhas preenchidas)."
        )
    return empresas

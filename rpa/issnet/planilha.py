"""Leitura da planilha de empresas (.xlsx) enviada pela tela do hub.

Mesmo padrao de rpa/issweb/planilha.py: a planilha vira bytes numa linha de
rpa_execucoes (auditoria/reprocesso) e cada empresa vira uma linha em
rpa_empresas. Diferencas:
  - cobre DOIS municipios no mesmo portal (Goiania e Aparecida de Goiania).
    Município NÃO é coluna obrigatória — a Rotina já diz que é "ISS Net
    Online", então o sistema tenta os dois municípios sozinho por empresa
    (mesmo padrão do issweb tentando "Mobiliário" e depois "Contribuinte" -
    ver rpa/issnet/processar.py). Se a planilha tiver a coluna Município
    preenchida, usamos só como DICA de qual cidade tentar primeiro
    (evita uma tentativa desnecessária), nunca como exigência.
  - não tem coluna "Obrigação": diferente do issweb, o issnet decide
    sozinho REST x DMS por empresa (gera o Livro Fiscal de Serviços
    Prestados primeiro; só processa Serviços Contratados se vier sem
    movimento - ver rpa/issnet/processar.py), não é escolha da planilha.
"""

from io import BytesIO

from openpyxl import load_workbook

COLUNAS_OBRIGATORIAS = ["Código da Empresa", "CNPJ/CPF"]
COLUNA_MUNICIPIO = "Município"
COLUNA_RAZAO_SOCIAL = "Razão Social"
MUNICIPIOS_ALVO = {"GOIÂNIA", "APARECIDA DE GOIÂNIA"}


class PlanilhaInvalida(Exception):
    pass


def _mapear_cabecalho(ws) -> dict:
    return {str(c.value).strip(): i for i, c in enumerate(ws[1], start=1) if c.value}


def ler_empresas(conteudo: bytes) -> list[dict]:
    """Retorna [{'codigo', 'cnpj_cpf', 'obrigacao', 'municipio'}] com todas
    as linhas com código preenchido. 'municipio' vem vazio ("") quando a
    planilha não informa (ou informa algo fora de Goiânia/Aparecida de
    Goiânia) — nesse caso o worker tenta os dois municípios por empresa
    (ver rpa/issnet/processar.py). Quando a coluna Município vem preenchida
    com um valor reconhecido, guardamos como dica pra tentar primeiro.
    'obrigacao' fica sempre vazio aqui (não vem da planilha, ver módulo
    docstring). Levanta PlanilhaInvalida com mensagem clara se faltar
    alguma coluna obrigatória."""
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

        municipio = ""
        if COLUNA_MUNICIPIO in mapa:
            municipio_bruto = str(ws.cell(row=linha, column=mapa[COLUNA_MUNICIPIO]).value or "").strip().upper()
            if municipio_bruto in MUNICIPIOS_ALVO:
                municipio = municipio_bruto

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
            "Nenhuma empresa encontrada na planilha (confira se há linhas com "
            "Código da Empresa preenchido)."
        )
    return empresas

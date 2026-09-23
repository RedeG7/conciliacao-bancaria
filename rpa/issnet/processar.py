"""Processamento de uma empresa no ISS Net Online (Goiânia/Aparecida de
Goiânia) — chamado pelo worker via rpa.registry.processar_empresa.

Regra de negócio confirmada com o usuário (diferente do issweb, onde
REST/DMS vêm prontos da planilha): para cada empresa, gera primeiro o
Livro Fiscal de Serviços Prestados (DMS) da competência. Se vier COM
movimento, baixa também o zip de XMLs das notas do período. Se vier SEM
movimento, processa Serviços Contratados (REST) no lugar. Nunca os dois.

Município NÃO é exigido da planilha (confirmado com o usuário): como a
Rotina já é "ISS Net Online", o sistema tenta os dois municípios sozinho
por empresa — mesmo padrão do issweb tentando "Mobiliário" e depois
"Contribuinte" em trocar_contribuinte(). Se a planilha trouxer uma dica de
município, tenta essa primeiro (economiza uma tentativa); senão tenta
Goiânia e depois Aparecida de Goiânia, nessa ordem.

Detecção de "tem movimento" via texto extraído do PDF (pdfplumber) — ainda
não validada ao vivo contra um PDF com movimento de verdade (só vimos o
caso vazio, ver rpa/issnet/portal.py). Ajustar _tem_movimento() se o
padrão real divergir do esperado aqui.
"""

import re

import pdfplumber
from playwright.sync_api import Page

from rpa.issnet import portal

_RE_TOTAL_REGISTROS = re.compile(r"Total\s+Registros:?\s*(\d+)", re.IGNORECASE)


def _validar_pdf(conteudo: bytes) -> None:
    if not conteudo:
        raise portal.ErroPortal("[gerar_pdf] PDF gerado está vazio (0 bytes)")
    if conteudo[:4] != b"%PDF":
        raise portal.ErroPortal("[gerar_pdf] arquivo não parece ser um PDF válido (assinatura ausente)")


def _tem_movimento(pdf_bytes: bytes) -> bool:
    """Lê 'Total Registros: N' do Livro Fiscal — N == 0 (ou campo ausente
    de tão vazio) é o caso 'sem movimento' confirmado ao vivo (empresa
    Balder Construtora, Aparecida de Goiânia, 08/2026: grade de documentos
    vazia, 'Total Registros:' sem número ao lado)."""
    import io
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        texto = "\n".join(pagina.extract_text() or "" for pagina in pdf.pages)
    match = _RE_TOTAL_REGISTROS.search(texto)
    if not match:
        return False
    return int(match.group(1)) > 0


MUNICIPIOS_ORDEM_PADRAO = ["GOIÂNIA", "APARECIDA DE GOIÂNIA"]


def _entrar_na_empresa(page: Page, empresa: dict) -> str:
    """Tenta logar+selecionar a empresa em cada município candidato, na
    ordem: dica da planilha (se houver) primeiro, depois a ordem padrão.
    Retorna o município que funcionou, ou levanta o ErroPortal da última
    tentativa se nenhum município encontrar a empresa."""
    dica = empresa.get("municipio") or ""
    candidatos = [dica] + [m for m in MUNICIPIOS_ORDEM_PADRAO if m != dica] if dica else list(MUNICIPIOS_ORDEM_PADRAO)

    ultimo_erro: Exception | None = None
    for municipio in candidatos:
        try:
            portal.login(page, municipio)
            portal.selecionar_empresa(page, empresa["cnpj_cpf"])
            return municipio
        except portal.ErroPortal as exc:
            ultimo_erro = exc
            continue
    raise ultimo_erro or portal.ErroPortal(
        f"[selecionar_empresa] empresa {empresa['cnpj_cpf']} não encontrada em nenhum município tentado"
    )


def processar_empresa(page: Page, empresa: dict, competencia: dict) -> dict:
    """empresa: {'codigo', 'cnpj_cpf', 'municipio'} — 'municipio' pode vir
    vazio (planilha não exige mais essa coluna, ver módulo docstring).
    Retorna {'status': 'CONCLUIDO', 'movimento', 'pdf': bytes, 'pdf_nome',
    'xml_zip': bytes|None, 'xml_zip_nome': str} ou levanta
    portal.ErroPortal (o worker captura e marca a linha como ERRO).

    Faz o login aqui (não em rpa.registry.fazer_login) porque cada empresa
    pode pertencer a um município diferente dentro do mesmo lote, e
    Goiânia/Aparecida de Goiânia são sessões/caminhos separados no mesmo
    domínio — troca de sessão por empresa quando o município muda ou
    quando a primeira tentativa não encontra a empresa."""
    codigo = empresa["codigo"]

    municipio = _entrar_na_empresa(page, empresa)

    pdf_dms = portal.gerar_livro_fiscal(page, "prestados", competencia["data_inicial"], competencia["data_final"])
    _validar_pdf(pdf_dms)
    tem_movimento = _tem_movimento(pdf_dms)

    pdf_nome = f"{codigo} DMS {competencia['mm_aaaa_arquivo']}.pdf"

    if tem_movimento:
        xml_zip = portal.exportar_xml_competencia(page, competencia["data_inicial"], competencia["data_final"])
        xml_zip_nome = f"{codigo} XML {competencia['mm_aaaa_arquivo']}.zip"
        return {
            "status": "CONCLUIDO",
            "movimento": f"DMS com movimento — {municipio.title()}",
            "pdf": pdf_dms,
            "pdf_nome": pdf_nome,
            "xml_zip": xml_zip,
            "xml_zip_nome": xml_zip_nome,
        }

    pdf_rest = portal.gerar_livro_fiscal(page, "contratados", competencia["data_inicial"], competencia["data_final"])
    _validar_pdf(pdf_rest)
    pdf_nome_rest = f"{codigo} REST {competencia['mm_aaaa_arquivo']}.pdf"

    return {
        "status": "CONCLUIDO",
        "movimento": f"DMS sem movimento — REST processado — {municipio.title()}",
        "pdf": pdf_rest,
        "pdf_nome": pdf_nome_rest,
        "xml_zip": None,
        "xml_zip_nome": "",
    }

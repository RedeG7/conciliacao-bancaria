"""Processamento de uma empresa no ISS Net Online (Goiânia/Aparecida de
Goiânia) — chamado pelo worker via rpa.registry.processar_empresa.

Regra de negócio confirmada com o usuário (diferente do issweb, onde
REST/DMS vêm prontos da planilha): para cada empresa, gera primeiro o
Livro Fiscal de Serviços Prestados (DMS) da competência. Se vier COM
movimento, baixa também o zip de XMLs das notas do período. Se vier SEM
movimento, processa Serviços Contratados (REST) no lugar. Nunca os dois.

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


def processar_empresa(page: Page, empresa: dict, competencia: dict) -> dict:
    """empresa: {'codigo', 'cnpj_cpf', 'municipio'}. Retorna
    {'status': 'CONCLUIDO', 'movimento', 'pdf': bytes, 'pdf_nome',
    'xml_zip': bytes|None, 'xml_zip_nome': str} ou levanta
    portal.ErroPortal (o worker captura e marca a linha como ERRO).

    Faz o login aqui (não em rpa.registry.fazer_login) porque cada empresa
    pode pertencer a um município diferente dentro do mesmo lote, e
    Goiânia/Aparecida de Goiânia são sessões/caminhos separados no mesmo
    domínio — troca de sessão por empresa quando o município muda."""
    codigo = empresa["codigo"]
    municipio = empresa["municipio"]

    portal.login(page, municipio)
    portal.selecionar_empresa(page, empresa["cnpj_cpf"])

    pdf_dms = portal.gerar_livro_fiscal(page, "prestados", competencia["data_inicial"], competencia["data_final"])
    _validar_pdf(pdf_dms)
    tem_movimento = _tem_movimento(pdf_dms)

    pdf_nome = f"{codigo} DMS {competencia['mm_aaaa_arquivo']}.pdf"

    if tem_movimento:
        xml_zip = portal.exportar_xml_competencia(page, competencia["data_inicial"], competencia["data_final"])
        xml_zip_nome = f"{codigo} XML {competencia['mm_aaaa_arquivo']}.zip"
        return {
            "status": "CONCLUIDO",
            "movimento": "DMS com movimento",
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
        "movimento": "DMS sem movimento — REST processado",
        "pdf": pdf_rest,
        "pdf_nome": pdf_nome_rest,
        "xml_zip": None,
        "xml_zip_nome": "",
    }

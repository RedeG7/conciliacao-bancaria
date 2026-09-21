"""Processamento de uma empresa (REST/DMS) — chamado pelo worker via
rpa.registry.processar_empresa. Equivalente ao processar_empresa() de
rpa-issweb/fechar_rest_dms.py (script local), mas gerando bytes de PDF em
memória em vez de arquivo, porque o worker não tem disco persistente.
"""

from playwright.sync_api import Page

from rpa.issweb import portal

PORTAL_URL = "https://servicosweb.senadorcanedo.go.gov.br/issweb/home.jsf"


def _validar_pdf(conteudo: bytes) -> None:
    if not conteudo:
        raise portal.ErroPortal("[gerar_pdf] PDF gerado está vazio (0 bytes)")
    if conteudo[:4] != b"%PDF":
        raise portal.ErroPortal("[gerar_pdf] arquivo não parece ser um PDF válido (assinatura ausente)")


def processar_empresa(page: Page, empresa: dict, competencia: dict) -> dict:
    """empresa: {'codigo', 'cnpj_cpf', 'obrigacao'}. Retorna
    {'status': 'CONCLUIDO', 'movimento', 'pdf': bytes, 'pdf_nome'} ou levanta
    portal.ErroPortal (o worker captura e marca a linha como ERRO).

    DMS e REST são fluxos DIFERENTES no portal (confirmado ao vivo com o
    usuário) — não é a mesma declaração com nomes diferentes:
    - DMS: Relatórios > Movimento Econômico (notas fiscais EMITIDAS pela
      empresa como prestadora) — relatório direto, sem abrir/fechar movimento.
    - REST: Declaração > Declaração Tomador (serviços TOMADOS pela empresa) —
      abre/fecha um movimento de verdade.
    """
    codigo = empresa["codigo"]
    obrigacao = empresa["obrigacao"]

    if not portal.trocar_contribuinte(page, empresa["cnpj_cpf"]):
        raise portal.ErroPortal(f"[localizar_empresa] empresa {codigo} não localizada no portal (Mobiliário/Contribuinte)")

    pdf_nome = f"{codigo} {obrigacao.upper()} {competencia['mm_aaaa_arquivo']}.pdf"

    if obrigacao == "DMS":
        pdf_bytes = portal.gerar_pdf_movimento_economico(page, competencia["data_inicial"], competencia["data_final"])
        _validar_pdf(pdf_bytes)
        return {
            "status": "CONCLUIDO",
            "movimento": "Relatório gerado",
            "pdf": pdf_bytes,
            "pdf_nome": pdf_nome,
        }

    com_movimento = portal.consultar_notas_tomadas(page, competencia["data_inicial"], competencia["data_final"])
    tipo = "01" if com_movimento else "03"

    resultado_abertura = portal.abrir_ou_localizar_movimento(page, tipo, competencia)

    if com_movimento and resultado_abertura == "aberto":
        portal.importar_e_aceitar_notas(page)

    portal.fechar_movimento(page, com_movimento)

    pdf_bytes = portal.gerar_pdf(page)
    _validar_pdf(pdf_bytes)

    return {
        "status": "CONCLUIDO",
        "movimento": "Com movimento" if com_movimento else "Sem movimento",
        "pdf": pdf_bytes,
        "pdf_nome": pdf_nome,
    }

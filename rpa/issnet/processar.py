"""Processamento de uma empresa (REST/DMS) no ISS Net Online — chamado pelo
worker via rpa.registry.processar_empresa.

AINDA NÃO VALIDADO AO VIVO (ver rpa/issnet/portal.py). PORTAL_URL é um
placeholder — precisa ser confirmada com o usuário/ao vivo no portal antes de
qualquer execução real.
"""

from playwright.sync_api import Page

from rpa.issnet import portal

PORTAL_URL = "https://TODO-confirmar-url-iss-net-online"


def processar_empresa(page: Page, empresa: dict, competencia: dict) -> dict:
    raise NotImplementedError(
        "[issnet] processamento ainda não validado ao vivo contra o portal real — "
        "ver rpa/issnet/portal.py"
    )

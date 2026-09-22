"""Wrapper Playwright para o portal ISS Net Online (Goiânia/Aparecida de
Goiânia — GO).

AINDA NÃO VALIDADO AO VIVO. Diferente de rpa/issweb/portal.py (que foi
confirmado passo a passo contra o portal real de Senador Canedo), este
módulo só tem a URL e o esqueleto das funções — login/navegação/geração de
PDF ainda precisam ser observados no portal real antes de qualquer execução
de verdade ser enfileirada para este módulo. Levanta NotImplementedError de
propósito em vez de tentar seletores adivinhados, que quebrariam em silêncio
contra um portal fiscal real.
"""

from playwright.sync_api import Page


class ErroPortal(Exception):
    """Falha numa etapa da automacao do portal — nunca aborta o lote inteiro."""


def login(page: Page, cnpj: str, senha: str, portal_url: str) -> None:
    raise NotImplementedError(
        "[issnet] login ainda não validado ao vivo contra o portal real — "
        "ver rpa/issnet/portal.py"
    )

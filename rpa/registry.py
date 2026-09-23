#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Registro dos módulos de RPA disponíveis no hub. Cada módulo declara:
  - id: chave usada em rpa_execucoes.modulo e rpa_credenciais.sistema
  - titulo: nome mostrado na tela
  - tipo_auth: "senha" (padrão, CNPJ+senha do portal) ou "certificado"
    (certificado digital A1 .pfx+senha do certificado) - controla qual
    formulário de credencial a tela mostra e qual função de rpa_core usar
    (ver app_conciliacao.py _tela_rpa_hub e worker abaixo)
  - processar_empresa(page, empresa, competencia) -> dict, de <modulo>/processar.py
    (chamado pelo worker; só o worker importa isso, a tela do Streamlit não
    precisa do Playwright instalado)

Novos módulos (fechamento de folha, guias INSS/FGTS etc.) se plugam aqui,
sem mexer no roteamento de telas do app nem no worker.
"""

from __future__ import annotations

MODULOS = {
    "issweb_rest_dms": {
        "titulo": "Fechamento REST/DMS — ISS Web (Senador Canedo/GO)",
        "sistema_credencial": "issweb_senador_canedo",
        "tipo_auth": "senha",
        "colunas_planilha": ["Código da Empresa", "CNPJ/CPF", "Município (opcional)"],
        "municipio_alvo": "SENADOR CANEDO",
    },
    "issnet_rest_dms": {
        "titulo": "Fechamento REST/DMS — ISS Net Online (Goiânia/Ap. de Goiânia)",
        "sistema_credencial": "issnet_goiania_apgyn",
        "tipo_auth": "certificado",
        "colunas_planilha": ["Código da Empresa", "CNPJ/CPF", "Razão Social (opcional)", "Município (opcional)"],
        "municipio_alvo": "GOIÂNIA / APARECIDA DE GOIÂNIA",
    },
}


def processar_empresa(modulo: str, *args, **kwargs) -> dict:
    """Despacha para <modulo>/processar.py — import tardio (só o worker tem
    Playwright instalado; a tela do Streamlit nunca deve importar isso)."""
    if modulo == "issweb_rest_dms":
        from rpa.issweb import processar
        return processar.processar_empresa(*args, **kwargs)
    if modulo == "issnet_rest_dms":
        from rpa.issnet import processar
        return processar.processar_empresa(*args, **kwargs)
    raise ValueError(f"Módulo de RPA desconhecido: {modulo}")


def preparar_periodo(modulo: str) -> dict:
    """Calcula o período/competência de referência de cada módulo (import
    tardio, mesmo motivo de processar_empresa)."""
    if modulo == "issweb_rest_dms":
        from rpa.issweb.competencia import calcular_competencia_anterior
        return calcular_competencia_anterior()
    if modulo == "issnet_rest_dms":
        from rpa.issnet.competencia import calcular_competencia_anterior
        return calcular_competencia_anterior()
    raise ValueError(f"Módulo de RPA desconhecido: {modulo}")


def ler_empresas(modulo: str, conteudo: bytes) -> list[dict]:
    """Despacha para <modulo>/planilha.py — só openpyxl, sem Playwright, mas
    mantido no mesmo padrão de despacho por módulo para a tela do Streamlit
    nunca precisar importar rpa.issweb diretamente."""
    if modulo == "issweb_rest_dms":
        from rpa.issweb import planilha
        return planilha.ler_empresas(conteudo)
    if modulo == "issnet_rest_dms":
        from rpa.issnet import planilha
        return planilha.ler_empresas(conteudo)
    raise ValueError(f"Módulo de RPA desconhecido: {modulo}")


def obter_credencial(modulo: str, escritorio_id: str) -> dict | None:
    """Busca a credencial certa (senha ou certificado, conforme tipo_auth)
    pra este módulo — só o worker chama isso (rpa_core tem as duas funções,
    a tela do Streamlit lida com o cadastro, não com a leitura cifrada)."""
    from rpa import core
    sistema = MODULOS[modulo]["sistema_credencial"]
    if MODULOS[modulo].get("tipo_auth") == "certificado":
        return core.obter_credencial_certificado(escritorio_id, sistema)
    return core.obter_credencial(escritorio_id, sistema)


def criar_contexto(modulo: str, browser, credencial: dict):
    """Cria o BrowserContext do Playwright pro módulo — só issnet precisa de
    algo diferente do contexto padrão (client_certificates, exigido antes de
    qualquer navegação porque o desafio do certificado acontece no handshake
    TLS, não dá pra configurar depois de já ter aberto uma página)."""
    if modulo == "issnet_rest_dms":
        from rpa.issnet import portal
        return browser.new_context(
            accept_downloads=True,
            client_certificates=[{
                "origin": portal.CERTIFICADO_ORIGIN,
                "pfx": credencial["pfx_bytes"],
                "passphrase": credencial["senha"],
            }],
        )
    return browser.new_context(accept_downloads=True)


def fazer_login(modulo: str, page, credencial: dict) -> None:
    """Despacha para <modulo>/portal.py — cada portal externo tem seu próprio
    fluxo de login (URL, campos, mensagens de erro). credencial é o dict
    retornado por obter_credencial() acima (formato varia por tipo_auth)."""
    if modulo == "issweb_rest_dms":
        from rpa.issweb import portal, processar
        portal.login(page, credencial["cnpj"], credencial["senha"], processar.PORTAL_URL)
        return
    if modulo == "issnet_rest_dms":
        # issnet não loga aqui: cada município (Goiânia/Ap. de Goiânia) é uma
        # sessão/caminho separado no mesmo domínio, então quem loga é
        # processar_empresa() por empresa, trocando de sessão conforme o
        # município mudar entre uma empresa e outra (ver rpa/issnet/portal.py).
        return
    raise ValueError(f"Módulo de RPA desconhecido: {modulo}")

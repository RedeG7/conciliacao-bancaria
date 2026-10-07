#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Registro dos módulos de RPA disponíveis no hub. Cada módulo declara:
  - id: chave usada em rpa_execucoes.modulo e rpa_credenciais.sistema
  - titulo: nome mostrado na tela
  - tipo_auth: "senha" (padrão, CNPJ+senha do portal), "certificado"
    (certificado digital A1 .pfx+senha do certificado) ou
    "certificado_senha" (os dois: certificado A1 apresentado no TLS + CPF e
    senha no formulário do portal - SEFAZ-GO) - controla qual
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
        "colunas_planilha": ["Código da Empresa", "CNPJ/CPF", "Município", "Razão Social (opcional)"],
        "municipio_alvo": "GOIÂNIA / APARECIDA DE GOIÂNIA",
        # automatizado=False: o portal (issnetonline.com.br) tem protecao
        # Cloudflare que bloqueia navegador controlado por automacao
        # (Playwright/CDP) com uma tela "Performing security verification" -
        # confirmado ao vivo, rodando tanto no VPS quanto numa rede
        # residencial/escritorio (ver historico). Nao ha contorno legitimo
        # sem consentimento do proprio portal - fica manual ate a Prefeitura/
        # suporte do ISS Net Online liberar acesso oficial (ver
        # motivo_manual, mostrado na tela do Hub).
        "automatizado": False,
        "motivo_manual": (
            "O portal ISS Net Online tem proteção Cloudflare que bloqueia navegador "
            "controlado por automação (testado do servidor e de uma rede de escritório, "
            "mesmo resultado nas duas). Não é algo que dá pra contornar sem autorização do "
            "próprio portal — fechamento fica manual até a Prefeitura/suporte liberar acesso "
            "oficial para automação."
        ),
    },
    "sefazgo_nfe": {
        "titulo": "RPA NF GO — Download de XML de NF-e (SEFAZ-GO)",
        # certificado A1 do escritório (TLS) - opcional: se o portal não
        # pedir certificado, o login segue só com CPF/senha
        "sistema_credencial": "sefazgo_certificado",
        # CPF + senha do Acesso Restrito (obrigatório) - guardado como uma
        # credencial separada (cnpj = CPF de acesso), ver obter_credencial()
        "sistema_credencial_portal": "sefazgo_portal",
        "tipo_auth": "certificado_senha",
        "colunas_planilha": ["Código da Empresa", "Razão Social", "CNPJ", "Inscrição Estadual"],
        "municipio_alvo": "GOIÁS",
        # o Hub mostra este módulo num card próprio (RPA NF GO), fora da
        # tela "RPA — Fechamento REST/DMS" - ver _APPS_HOME em app_conciliacao.py
        "app_home": "rpa_nfgo",
        # Google Chrome em vez do Chromium do Playwright: a verificação da
        # Cloudflare do formulário "Consulta de Notas Recebidas" passa
        # sozinha no Chrome do escritório e pediu "Verify you are human" no
        # Chromium do servidor (prints da execução real). Só troca o
        # navegador - o robô continua sem clicar/contornar a verificação.
        # Sem Chrome instalado, o worker volta pro Chromium (ver rpa_worker.py).
        "navegador": "chrome",
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
    if modulo == "sefazgo_nfe":
        from rpa.sefazgo_nfe import processar
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
    if modulo == "sefazgo_nfe":
        from rpa.sefazgo_nfe.competencia import calcular_competencia_anterior
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
    if modulo == "sefazgo_nfe":
        from rpa.sefazgo_nfe import planilha
        return planilha.ler_empresas(conteudo)
    raise ValueError(f"Módulo de RPA desconhecido: {modulo}")


def obter_credencial(modulo: str, escritorio_id: str) -> dict | None:
    """Busca a credencial certa (senha ou certificado, conforme tipo_auth)
    pra este módulo — só o worker chama isso (rpa_core tem as duas funções,
    a tela do Streamlit lida com o cadastro, não com a leitura cifrada)."""
    from rpa import core
    sistema = MODULOS[modulo]["sistema_credencial"]
    if MODULOS[modulo].get("tipo_auth") == "certificado_senha":
        # CPF/senha do portal é obrigatório; certificado é opcional
        portal = core.obter_credencial(escritorio_id, MODULOS[modulo]["sistema_credencial_portal"])
        if not portal:
            return None
        certificado = core.obter_credencial_certificado(escritorio_id, sistema)
        return {
            "cpf": portal["cnpj"], "senha_portal": portal["senha"],
            "pfx_bytes": certificado["pfx_bytes"] if certificado else None,
            "senha": certificado["senha"] if certificado else None,
        }
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
    if modulo == "sefazgo_nfe" and credencial.get("pfx_bytes"):
        from rpa.sefazgo_nfe import portal
        return browser.new_context(
            accept_downloads=True,
            client_certificates=[
                {"origin": origem, "pfx": credencial["pfx_bytes"], "passphrase": credencial["senha"]}
                for origem in portal.CERTIFICADO_ORIGINS
            ],
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
    if modulo == "sefazgo_nfe":
        from rpa.sefazgo_nfe import portal
        portal.login(page, credencial["cpf"], credencial["senha_portal"])
        return
    raise ValueError(f"Módulo de RPA desconhecido: {modulo}")

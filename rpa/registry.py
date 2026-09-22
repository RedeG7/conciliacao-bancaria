#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Registro dos módulos de RPA disponíveis no hub. Cada módulo declara:
  - id: chave usada em rpa_execucoes.modulo e rpa_credenciais.sistema
  - titulo: nome mostrado na tela
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
        "colunas_planilha": ["Código da Empresa", "CNPJ/CPF", "Obrigação", "Município"],
        "municipio_alvo": "SENADOR CANEDO",
    },
    "issnet_rest_dms": {
        "titulo": "Fechamento REST/DMS — ISS Net Online (Goiânia/Ap. de Goiânia)",
        "sistema_credencial": "issnet_goiania_apgyn",
        "colunas_planilha": ["Código da Empresa", "CNPJ/CPF", "Obrigação", "Município"],
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


def fazer_login(modulo: str, page, cnpj: str, senha: str) -> None:
    """Despacha para <modulo>/portal.py — cada portal externo tem seu próprio
    fluxo de login (URL, campos, mensagens de erro)."""
    if modulo == "issweb_rest_dms":
        from rpa.issweb import portal, processar
        portal.login(page, cnpj, senha, processar.PORTAL_URL)
        return
    if modulo == "issnet_rest_dms":
        from rpa.issnet import portal, processar
        portal.login(page, cnpj, senha, processar.PORTAL_URL)
        return
    raise ValueError(f"Módulo de RPA desconhecido: {modulo}")

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Worker do hub de RPAs: loop contínuo que faz polling em rpa_execucoes
(Postgres, via rpa.core), processa uma execução por vez com Playwright
headless e despacha para o módulo certo via rpa.registry.

Roda num container separado do app Streamlit (ver Dockerfile.worker e o
serviço rpa_worker em docker-compose.yml) — Chromium não entra na imagem
leve do app, e um lote de várias empresas (minutos) não trava nenhuma
requisição web.

Erro numa empresa nunca aborta a execução inteira (mesma regra do script
local rpa-issweb): captura, marca ERRO na linha, segue para a próxima. Falha
de login é fatal só para aquela execução (sem login não dá pra processar
nenhuma empresa dela) — mas o worker continua vivo para pegar a próxima
execução da fila.
"""

import logging
import time

from playwright.sync_api import sync_playwright

import auth
from rpa import core, registry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rpa_worker")

INTERVALO_POLLING_S = 15


def processar_execucao(execucao: dict) -> None:
    execucao_id = execucao["id"]
    modulo = execucao["modulo"]
    escritorio_id = execucao["escritorio_id"]
    log.info("Execução %s (módulo=%s, escritório=%s): iniciando", execucao_id, modulo, escritorio_id)

    modulo_info = registry.MODULOS[modulo]
    credencial = registry.obter_credencial(modulo, escritorio_id)
    if not credencial:
        core.marcar_execucao_concluida(execucao_id, competencia="", status=core.STATUS_ERRO)
        log.error("Execução %s: sem credencial cadastrada para '%s'", execucao_id, modulo_info["sistema_credencial"])
        return

    if execucao.get("competencia"):
        # competencia escolhida pelo usuario na tela ao criar a execucao
        # (ver app_conciliacao.py _tela_rpa_hub) - prioridade sobre calcular
        # "mes anterior", que so serve de fallback pra execucao antiga sem
        # esse campo preenchido (de antes desta funcionalidade existir).
        mes_str, ano_str = execucao["competencia"].split("/")
        competencia = core.montar_competencia(int(mes_str), int(ano_str))
    else:
        competencia = registry.preparar_periodo(modulo)
    empresas = core.listar_empresas_pendentes(execucao_id)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = registry.criar_contexto(modulo, browser, credencial)
        page = context.new_page()

        try:
            registry.fazer_login(modulo, page, credencial)
        except Exception as exc:
            log.error("Execução %s: falha no login — %s", execucao_id, exc)
            screenshot = None
            try:
                screenshot = page.screenshot(full_page=True)
            except Exception:
                log.warning("Execução %s: não deu pra tirar screenshot da falha de login", execucao_id)
            for empresa in empresas:
                core.atualizar_empresa(
                    empresa["id"], status=core.STATUS_ERRO, erro=str(exc), screenshot_erro=screenshot,
                )
            core.marcar_execucao_concluida(execucao_id, competencia["mm_aaaa"], core.STATUS_ERRO)
            browser.close()
            return

        alguma_concluida = False
        for empresa in empresas:
            log.info("Execução %s: processando empresa %s (%s)", execucao_id, empresa["codigo"], empresa["obrigacao"])
            core.marcar_empresa_status(empresa["id"], core.STATUS_RODANDO)
            try:
                resultado = registry.processar_empresa(modulo, page, empresa, competencia)
                core.atualizar_empresa(
                    empresa["id"], status=core.STATUS_CONCLUIDO,
                    movimento=resultado["movimento"], pdf=resultado["pdf"], pdf_nome=resultado["pdf_nome"],
                    xml_zip=resultado.get("xml_zip"), xml_zip_nome=resultado.get("xml_zip_nome", ""),
                )
                log.info("Execução %s: empresa %s concluída (%s)", execucao_id, empresa["codigo"], resultado["movimento"])
                alguma_concluida = True
            except Exception as exc:
                log.error("Execução %s: empresa %s falhou — %s", execucao_id, empresa["codigo"], exc)
                screenshot = None
                try:
                    screenshot = page.screenshot(full_page=True)
                except Exception:
                    log.warning("Execução %s: empresa %s — não deu pra tirar screenshot do erro", execucao_id, empresa["codigo"])
                core.atualizar_empresa(
                    empresa["id"], status=core.STATUS_ERRO, erro=str(exc), screenshot_erro=screenshot,
                )

        browser.close()

    # CONCLUIDO só se pelo menos uma empresa terminou com sucesso — senão o
    # status agregado ficaria enganoso (ex.: "CONCLUIDO" com 0/4 concluídas).
    status_final = core.STATUS_CONCLUIDO if alguma_concluida else core.STATUS_ERRO
    core.marcar_execucao_concluida(execucao_id, competencia["mm_aaaa"], status_final)
    log.info("Execução %s: finalizada (%s)", execucao_id, status_final)


def loop_principal() -> None:
    log.info("Worker de RPA iniciado — polling a cada %ss", INTERVALO_POLLING_S)
    # auth primeiro: rpa_credenciais/rpa_execucoes tem FK pra escritorios(id)
    # (mesma ordem de _garantir_schema_extra() em app_conciliacao.py). O
    # worker pode subir antes do app ter rodado isso pela primeira vez, então
    # não pode depender de o app já ter criado essas tabelas.
    auth.garantir_schema()
    core.garantir_schema()
    while True:
        execucao = core.reivindicar_proxima_execucao()
        if execucao:
            try:
                processar_execucao(execucao)
            except Exception:
                log.exception("Execução %s: erro inesperado no worker (execução abortada)", execucao["id"])
                core.marcar_execucao_concluida(execucao["id"], competencia="", status=core.STATUS_ERRO)
        else:
            time.sleep(INTERVALO_POLLING_S)


if __name__ == "__main__":
    loop_principal()

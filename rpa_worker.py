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
import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

import auth
from rpa import core, registry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rpa_worker")

INTERVALO_POLLING_S = 15

# WORKER_MODULOS (opcional, lista separada por virgula de ids de modulo -
# ver rpa/registry.py MODULOS): restringe quais modulos ESTA instancia do
# worker processa. Sem essa variavel, pega qualquer modulo pendente (padrao
# de sempre). Existe pra rodar workers em maquinas diferentes por modulo -
# caso de uso real: issnet precisa rodar numa rede residencial/escritorio
# (Cloudflare do portal bloqueia o IP de datacenter do VPS), entao o VPS
# roda com WORKER_MODULOS=issweb_rest_dms (ignora issnet) e um worker local
# separado roda com WORKER_MODULOS=issnet_rest_dms.
_MODULOS_PERMITIDOS = [
    m.strip() for m in os.environ.get("WORKER_MODULOS", "").split(",") if m.strip()
] or None

# RPA_SALVAR_EM_DISCO=1 (opcional): além de gravar no banco, grava os
# arquivos que o módulo devolver em resultado["arquivos"] ({caminho
# relativo: bytes}) numa pasta local - RPA_PASTA_DESTINO, ou a pasta
# informada na tela ao criar a execução (rpa_execucoes.pasta_destino).
# Só faz sentido num worker rodando no PC do escritório (o do VPS não
# enxerga C:\... de ninguém) - por isso é opt-in, desligado por padrão.
_SALVAR_EM_DISCO = os.environ.get("RPA_SALVAR_EM_DISCO", "").strip().lower() in ("1", "true", "sim", "yes")
_PASTA_DESTINO_FIXA = os.environ.get("RPA_PASTA_DESTINO", "").strip()


def _salvar_arquivos_em_disco(execucao: dict, arquivos: dict) -> None:
    if not _SALVAR_EM_DISCO or not arquivos:
        return
    raiz = _PASTA_DESTINO_FIXA or (execucao.get("pasta_destino") or "").strip()
    if not raiz:
        log.warning("Execução %s: RPA_SALVAR_EM_DISCO ligado mas sem pasta de destino — arquivos só no Hub", execucao["id"])
        return
    for relativo, conteudo in arquivos.items():
        destino = Path(raiz).joinpath(*relativo.split("/"))
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(conteudo)
        log.info("Execução %s: gravado %s", execucao["id"], destino)


def _abrir_navegador(pw, modulo_info: dict):
    """Chromium do Playwright por padrão; módulo pode pedir outro canal
    ("chrome" = Google Chrome, "msedge" = Edge) em rpa/registry.py, e
    RPA_NAVEGADOR sobrepõe (ex.: worker local). Se o canal pedido não
    estiver instalado, volta pro Chromium em vez de falhar a execução."""
    canal = (os.environ.get("RPA_NAVEGADOR") or modulo_info.get("navegador") or "").strip()
    if canal and canal != "chromium":
        try:
            return pw.chromium.launch(headless=False, channel=canal)
        except Exception as exc:
            log.warning("Navegador '%s' indisponível (%s) — usando o Chromium do Playwright", canal, str(exc).splitlines()[0])
    return pw.chromium.launch(headless=False)


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
        # headless=False (rodando dentro de um Xvfb - ver Dockerfile.worker):
        # confirmado ao vivo que o issnet tem protecao Cloudflare que trava
        # pra sempre com Chromium headless=True. headed reduz o risco de
        # bloqueio (sem garantia total contra Cloudflare); issweb também
        # roda assim, sem problema conhecido nesse modo.
        browser = _abrir_navegador(pw, modulo_info)
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
        cancelada = False
        for empresa in empresas:
            if core.cancelamento_solicitado(execucao_id):
                qtd = core.cancelar_restantes(execucao_id)
                log.warning("Execução %s: cancelada pelo usuário — %s consulta(s) não processada(s)", execucao_id, qtd)
                cancelada = True
                break
            log.info("Execução %s: processando empresa %s (%s)", execucao_id, empresa["codigo"], empresa["obrigacao"])
            core.marcar_empresa_status(empresa["id"], core.STATUS_RODANDO)
            try:
                resultado = registry.processar_empresa(modulo, page, empresa, competencia)
                # status vem do módulo quando ele mesmo detecta problema sem
                # exceção (ex.: RPA NF GO com ZIP incompleto vira ERRO, mas
                # os arquivos baixados ficam gravados pra conferência)
                status = resultado.get("status") or core.STATUS_CONCLUIDO
                core.atualizar_empresa(
                    empresa["id"], status=status,
                    movimento=resultado.get("movimento", ""), erro=resultado.get("erro", ""),
                    pdf=resultado.get("pdf"), pdf_nome=resultado.get("pdf_nome", ""),
                    xml_zip=resultado.get("xml_zip"), xml_zip_nome=resultado.get("xml_zip_nome", ""),
                    qtd_notas_portal=resultado.get("qtd_notas_portal"), qtd_xml=resultado.get("qtd_xml"),
                    evidencia_png=resultado.get("evidencia_png"), observacao=resultado.get("observacao", ""),
                )
                try:
                    _salvar_arquivos_em_disco(execucao, resultado.get("arquivos") or {})
                except OSError as exc:
                    log.error("Execução %s: empresa %s — falha ao gravar na pasta de destino: %s",
                              execucao_id, empresa["codigo"], exc)
                log.info("Execução %s: empresa %s %s (%s)", execucao_id, empresa["codigo"], status, resultado.get("movimento", ""))
                if status == core.STATUS_CONCLUIDO:
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
    if core.cancelamento_solicitado(execucao_id):
        # pedido chegou durante a última empresa
        core.cancelar_restantes(execucao_id)
        cancelada = True
    # cancelada = ERRO (aparece o Reprocessar para o que não terminou)
    status_final = core.STATUS_CONCLUIDO if alguma_concluida and not cancelada else core.STATUS_ERRO
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
    qtd_orfas = core.recuperar_execucoes_orfas()
    if qtd_orfas:
        log.warning("%s execução(ões) RODANDO órfã(s) de uma instância anterior do worker — voltaram pra fila", qtd_orfas)
    if _MODULOS_PERMITIDOS:
        log.info("WORKER_MODULOS ativo — só processa: %s", ", ".join(_MODULOS_PERMITIDOS))
    while True:
        execucao = core.reivindicar_proxima_execucao(_MODULOS_PERMITIDOS)
        if execucao:
            try:
                processar_execucao(execucao)
            except Exception as exc:
                log.exception("Execução %s: erro inesperado no worker (execução abortada)", execucao["id"])
                # Sem isso, empresas que nem chegaram a ser tentadas
                # (PENDENTE) ou que estavam sendo processadas na hora do
                # crash (RODANDO) ficam presas pra sempre - a execução já
                # não está mais PENDENTE (não seria pega de novo) e
                # "Reprocessar" só aparece pra empresas com ERRO.
                for empresa in core.listar_empresas(execucao["id"]):
                    if empresa["status"] in (core.STATUS_PENDENTE, core.STATUS_RODANDO):
                        core.atualizar_empresa(empresa["id"], status=core.STATUS_ERRO, erro=str(exc))
                core.marcar_execucao_concluida(execucao["id"], competencia="", status=core.STATUS_ERRO)
        else:
            time.sleep(INTERVALO_POLLING_S)


if __name__ == "__main__":
    loop_principal()

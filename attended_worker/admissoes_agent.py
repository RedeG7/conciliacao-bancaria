#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Agente de admissões da sessão RDS: pega as admissões do escritório na fila
do Hub (api.py, /api/admissoes/agente/*), faz o trabalho e devolve o
resultado. Segue skills/cadastro-empregado-dominio/SKILL.md.

Fase preparo (tarefa nova):
  baixa do Hub as mensagens e anexos da solicitação e monta a prévia do
  cadastro -> o Hub deixa a tarefa aguardando a aprovação do DP. Faltou
  dado obrigatório -> "aguardando documentos". Nada é feito no Domínio.
  Como ler é escolhido no Hub (Admissões › Canais e agente › IA), a cada
  tarefa:
    - IA desligada: campos do formulário do Acessórias (sem IA);
    - Claude ou OpenAI: a IA lê a ficha e o ASO anexos, com a chave salva
      no Hub.

Fase gravacao (só depois da aprovação registrada no Hub):
  o Claude opera o Domínio na tela da sessão RDS com os dados APROVADOS
  (só com a Claude ligada no Hub; sem ela, a tarefa volta para o DP
  preencher com a prévia aprovada).
  Nesta versão existe só o MODO CONFERÊNCIA: preenche o cadastro e para
  ANTES de salvar - não salva e não transmite ao eSocial. A tarefa volta ao
  Hub como "bloqueada" explicando que o cadastro está na tela para
  conferência; quem salva é a pessoa do DP.

A janela (gui_admissoes.py) é o jeito normal de rodar. Linha de comando,
para teste (PowerShell, na pasta attended_worker):
    $env:HUB_USUARIO = "agente-rds"
    python admissoes_agent.py --uma-vez
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import admissoes_formulario as formulario
import admissoes_ia as ia
import hub_api

INTERVALO_S = 15
PASTA_PADRAO = Path(r"C:\Dominio")
MODO_CONFERENCIA = "conferencia"

MOTIVO_CONFERENCIA = (
    "Modo conferência: o cadastro foi preenchido no Domínio e NÃO foi salvo nem transmitido. "
    "Confira a tela na sessão RDS e salve manualmente se estiver correto."
)
MOTIVO_SEM_CLAUDE = (
    "Prévia aprovada. O preenchimento automático no Domínio usa a Claude (Canais e agente › IA); "
    "com a leitura atual, cadastre no Domínio com os dados da prévia aprovada."
)


def criar_cliente(leitura: str, chave: str):
    return ia.criar_cliente(chave) if leitura == "claude" else ia.criar_cliente_openai(chave)


class GravacaoNaoLiberada(RuntimeError):
    pass


@dataclass
class Contexto:
    """O que o agente precisa para trabalhar - montado pela janela ou pela
    linha de comando (nos testes, com dublês)."""
    token: str
    tela: Any = None
    criar_ia: Callable[[str, str], Any] = criar_cliente
    pasta: Path = PASTA_PADRAO
    modo: str = MODO_CONFERENCIA
    parar: threading.Event = field(default_factory=threading.Event)
    log: Callable[[str], None] = print
    _clientes: dict = field(default_factory=dict, repr=False)

    def cliente(self, leitura: dict) -> Any:
        """Cliente da IA configurada no Hub (reaproveitado enquanto a chave não muda)."""
        chave = (leitura["leitura"], leitura.get("chave", ""))
        if chave not in self._clientes:
            self._clientes.clear()
            self._clientes[chave] = self.criar_ia(*chave)
        return self._clientes[chave]


def _pasta_tarefa(ctx: Contexto, admissao: dict) -> Path:
    # identificador seguro: só o número da tarefa no Hub (sem nome de pessoa)
    return ctx.pasta / f"admissao-{int(admissao['id'])}"


def preparar(ctx: Contexto, admissao: dict) -> tuple[str, Any]:
    """Fase preparo (passos 1, 2 e 9 da skill). Retorna ("previa", dados)
    para o DP aprovar ou (status, motivo)."""
    empresa = admissao.get("empresa")
    if not empresa or not empresa.get("codigo_dominio"):
        return "blocked", "Empresa não vinculada ao cadastro do Hub (sem código no Domínio)"
    try:
        leitura = hub_api.admissao_leitura(ctx.token)
        material = hub_api.admissao_material(ctx.token, admissao["id"])
    except hub_api.ErroHubApi as exc:
        return "failed", f"Não consegui baixar os documentos pelo Hub: {str(exc)[:200]}"
    if leitura.get("leitura", "formulario") == "formulario":
        ficha = formulario.ler_formulario(material)
        if ficha is None:
            return "awaiting_documents", "Formulário de admissão não encontrado na solicitação (IA desligada no Hub)"
        previa, faltando = formulario.montar_previa(ficha, empresa, material)
        if faltando:
            return "awaiting_documents", "Faltam no formulário: " + ", ".join(faltando)
        return "previa", previa
    if not material.get("documentos"):
        ignorados = len(material.get("ignorados") or [])
        return "awaiting_documents", (
            "Nenhum documento legível (PDF ou imagem) na solicitação"
            + (f" - {ignorados} anexo(s) não puderam ser lidos" if ignorados else "")
        )
    try:
        cliente = ctx.cliente(leitura)
        if leitura["leitura"] == "openai":
            extraido = ia.ler_documentos_openai(cliente, material, empresa, leitura.get("modelo") or "gpt-5")
        else:
            extraido = ia.ler_documentos(cliente, material, empresa)
    except ia.ErroIA as exc:
        return "failed", f"Leitura dos documentos: {exc}"
    previa, faltando = ia.montar_previa(extraido, empresa, material)
    if faltando:
        return "awaiting_documents", "Faltam nos documentos: " + ", ".join(faltando)
    return "previa", previa


def gravar(ctx: Contexto, admissao: dict) -> tuple[str, str]:
    """Fase gravacao, só com a prévia aprovada. Retorna (status, motivo)."""
    if not admissao.get("liberado_para_gravar") or not admissao.get("previa_aprovada"):
        # o Hub nunca manda fase gravacao sem aprovação; se mandar, não grava
        raise GravacaoNaoLiberada("Tarefa sem aprovação registrada no Hub")
    if ctx.modo != MODO_CONFERENCIA:
        # salvar/transmitir de verdade ainda não existe nesta versão
        return "blocked", "Modo de gravação não disponível nesta versão do agente"
    try:
        leitura = hub_api.admissao_leitura(ctx.token)
    except hub_api.ErroHubApi as exc:
        return "failed", f"Não consegui consultar o Hub: {str(exc)[:200]}"
    if leitura.get("leitura") != "claude":
        return "blocked", MOTIVO_SEM_CLAUDE
    if ctx.tela is None:
        return "blocked", "Agente sem acesso à tela da sessão RDS"
    resultado, motivo = ia.operar_dominio(
        ctx.cliente(leitura), ctx.tela, admissao["previa_aprovada"], _pasta_tarefa(ctx, admissao), ctx.parar, ctx.log,
    )
    if resultado == "preenchido":
        return "blocked", MOTIVO_CONFERENCIA
    return "blocked", motivo or "Operação no Domínio não concluída"


def processar(ctx: Contexto, admissao: dict) -> str:
    """Executa uma tarefa reservada e informa o resultado ao Hub."""
    if admissao.get("fase") == "gravacao":
        try:
            status, texto = gravar(ctx, admissao)
        except GravacaoNaoLiberada as exc:
            hub_api.admissao_status(ctx.token, admissao["id"], "blocked", str(exc))
            return "blocked"
        if status == "completed":
            hub_api.admissao_status(ctx.token, admissao["id"], "completed", protocolo=texto)
        else:
            hub_api.admissao_status(ctx.token, admissao["id"], status, texto)
        return status

    acao, dados = preparar(ctx, admissao)
    if acao == "previa":
        hub_api.admissao_previa(ctx.token, admissao["id"], dados)
        return "awaiting_approval"
    hub_api.admissao_status(ctx.token, admissao["id"], acao, dados)
    return acao


def rodar_uma(ctx: Contexto) -> Optional[str]:
    """Reserva e processa uma tarefa; None se a fila está vazia."""
    admissao = hub_api.admissao_proxima(ctx.token)
    if not admissao:
        return None
    ctx.log(f"Admissão nº {admissao['id']} ({admissao['fase']}) - começando")
    try:
        resultado = processar(ctx, admissao)
    except Exception as exc:
        # nunca deixa a tarefa presa como reservada: devolve como falha
        try:
            hub_api.admissao_status(ctx.token, admissao["id"], "failed",
                                    f"Erro inesperado no agente: {type(exc).__name__}")
        except hub_api.ErroHubApi:
            pass
        raise
    # sem dados pessoais no log: só número e resultado
    ctx.log(f"Admissão nº {admissao['id']} ({admissao['fase']}): {resultado}")
    return resultado


def main() -> int:
    parser = argparse.ArgumentParser(description="Agente de admissões (sessão RDS)")
    parser.add_argument("--uma-vez", action="store_true", help="processa no máximo uma tarefa e sai")
    args = parser.parse_args()

    if os.environ.get("HUB_API_URL"):
        hub_api.BASE_URL = os.environ["HUB_API_URL"].rstrip("/")
    usuario = os.environ.get("HUB_USUARIO") or input("Usuário do Hub: ").strip()
    senha = os.environ.get("HUB_SENHA") or getpass.getpass("Senha do Hub: ")
    token = hub_api.login(usuario, senha)["token"]
    from tela import Tela
    ctx = Contexto(token=token, tela=Tela())
    print(f"Conectado em {hub_api.BASE_URL} como {usuario}. Aguardando admissões...")

    while True:
        try:
            rodar_uma(ctx)
        except hub_api.ErroHubApi as exc:
            print(f"Erro: {exc}", file=sys.stderr)
        if args.uma_vez:
            return 0
        time.sleep(INTERVALO_S)


if __name__ == "__main__":
    sys.exit(main())

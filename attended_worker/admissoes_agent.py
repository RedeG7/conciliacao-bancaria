#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Agente de admissões da sessão RDS: pega as admissões do escritório na fila
do Hub (api.py, /api/admissoes/agente/*) e devolve o resultado.

Segue skills/cadastro-empregado-dominio/SKILL.md. NESTA VERSÃO ELE NÃO MEXE
NO DOMÍNIO: a automação da tela (passos 4 a 8 da skill) ainda não existe,
então toda tarefa reservada volta como "blocked" explicando isso - nada é
preenchido, salvo nem transmitido. Quando a automação existir, ela entra
em `preparar()` (monta a prévia, sem salvar) e em `gravar()` (só com
`liberado_para_gravar`, que o Hub só manda depois da aprovação do DP).

Uso (PowerShell, na pasta attended_worker):
    $env:HUB_USUARIO = "agente-rds"          # conta do Hub só para o agente
    python admissoes_agent.py                 # pede a senha
    python admissoes_agent.py --uma-vez       # processa uma tarefa e sai
Opcional: $env:HUB_API_URL = "http://127.0.0.1:8000/api" (teste local).
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
import time

import hub_api

INTERVALO_S = 15
MOTIVO_SEM_INTEGRACAO = (
    "Automação do Domínio ainda não implementada no agente - nada foi preenchido, "
    "salvo ou transmitido. Faça o cadastro manualmente ou aguarde a integração."
)


class GravacaoNaoLiberada(RuntimeError):
    pass


def preparar(admissao: dict) -> tuple[str, dict | str]:
    """Fase preparo (passos 1 a 9 da skill, sem salvar). Retorna
    ("previa", dados) para mandar ao DP aprovar ou (status, motivo)."""
    return "blocked", MOTIVO_SEM_INTEGRACAO


def gravar(admissao: dict) -> tuple[str, str]:
    """Fase gravacao: salvar no Domínio e transmitir, só com a prévia
    aprovada. Retorna (status, motivo_ou_protocolo)."""
    if not admissao.get("liberado_para_gravar") or not admissao.get("previa_aprovada"):
        # o Hub nunca manda fase gravacao sem aprovação; se mandar, não grava
        raise GravacaoNaoLiberada("Tarefa sem aprovação registrada no Hub")
    return "blocked", MOTIVO_SEM_INTEGRACAO


def processar(token: str, admissao: dict) -> str:
    """Executa uma tarefa reservada e informa o resultado ao Hub."""
    if admissao.get("fase") == "gravacao":
        try:
            status, texto = gravar(admissao)
        except GravacaoNaoLiberada as exc:
            hub_api.admissao_status(token, admissao["id"], "blocked", str(exc))
            return "blocked"
        if status == "completed":
            hub_api.admissao_status(token, admissao["id"], "completed", protocolo=texto)
        else:
            hub_api.admissao_status(token, admissao["id"], status, texto)
        return status

    acao, dados = preparar(admissao)
    if acao == "previa":
        hub_api.admissao_previa(token, admissao["id"], dados)
        return "awaiting_approval"
    hub_api.admissao_status(token, admissao["id"], acao, dados)
    return acao


def main() -> int:
    parser = argparse.ArgumentParser(description="Agente de admissões (sessão RDS)")
    parser.add_argument("--uma-vez", action="store_true", help="processa no máximo uma tarefa e sai")
    args = parser.parse_args()

    if os.environ.get("HUB_API_URL"):
        hub_api.BASE_URL = os.environ["HUB_API_URL"].rstrip("/")
    usuario = os.environ.get("HUB_USUARIO") or input("Usuário do Hub: ").strip()
    senha = os.environ.get("HUB_SENHA") or getpass.getpass("Senha do Hub: ")
    token = hub_api.login(usuario, senha)["token"]
    print(f"Conectado em {hub_api.BASE_URL} como {usuario}. Aguardando admissões...")

    while True:
        try:
            admissao = hub_api.admissao_proxima(token)
            if admissao:
                resultado = processar(token, admissao)
                # sem dados pessoais no console: só id e resultado
                print(f"Admissão {admissao['id']} ({admissao['fase']}): {resultado}")
        except hub_api.ErroHubApi as exc:
            print(f"Erro: {exc}", file=sys.stderr)
        if args.uma_vez:
            return 0
        time.sleep(INTERVALO_S)


if __name__ == "__main__":
    sys.exit(main())

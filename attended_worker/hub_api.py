#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cliente HTTP da API do Hub (ver api.py, na raiz do repositório) - login
com usuário/senha (os mesmos do site), sem precisar de chave SSH nem
acesso direto ao Postgres do VPS. Substitui o mecanismo antigo (túnel SSH
+ attended_worker/prod.env), que exigia uma configuração manual só
possível em máquinas com a chave de deploy do escritório - agora qualquer
usuário do Hub consegue sincronizar, só com o próprio login.

O token retornado pelo login é o MESMO tipo de sessão usada pelo cookie
do navegador (auth.criar_sessao) - 30 dias de validade, revogável. Fica
salvo localmente (ver gui.py _salvar_config) pra não pedir senha de novo
a cada execução."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Optional

import requests

try:
    # usa os certificados do Windows (não só os do Python): em PC com
    # antivírus/proxy que inspeciona HTTPS, o certificado do site chega
    # assinado por uma raiz que só o Windows conhece - sem isso a conexão
    # falha com erro de SSL mesmo com a internet funcionando
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

from requests.adapters import HTTPAdapter  # noqa: E402
from urllib3.util.retry import Retry  # noqa: E402

BASE_URL = "https://hub.redeg7.com/api"
TIMEOUT_PADRAO_S = 20
TIMEOUT_UPLOAD_S = 90


# repete sozinho falhas de conexão rápidas (rede oscilando, Hub reiniciando
# no deploy) antes de desistir - só conexão/leitura, nunca uma resposta 4xx
_sessao = requests.Session()
_sessao.mount("https://", HTTPAdapter(max_retries=Retry(
    total=4, connect=4, read=2, status=0, backoff_factor=1, allowed_methods=None, raise_on_status=False,
)))


def _erro_conexao(exc: Exception) -> "ErroHubApi":
    """Mensagem com o motivo real (SSL, DNS, tempo esgotado...) - só "confira
    a internet" não ajudava a descobrir o problema."""
    motivo = str(exc)
    if "CERTIFICATE_VERIFY_FAILED" in motivo or "SSLError" in type(exc).__name__ or "SSL" in motivo:
        dica = "certificado de segurança recusado (antivírus/proxy inspecionando HTTPS?)"
    elif "NameResolution" in motivo or "getaddrinfo" in motivo:
        dica = "não achou o endereço (DNS/internet)"
    elif "timed out" in motivo.lower() or "Timeout" in type(exc).__name__:
        dica = "tempo esgotado (internet lenta ou Hub fora do ar)"
    elif "refused" in motivo.lower() or "10061" in motivo:
        dica = "conexão recusada (Hub reiniciando? tente de novo em 1 minuto)"
    else:
        dica = "falha de conexão"
    return ErroHubApi(f"[hub] não consegui conectar em {BASE_URL} - {dica}. Detalhe: {type(exc).__name__}: {motivo[:300]}")


class ErroHubApi(Exception):
    """Falha ao falar com a API do Hub - credencial inválida, sessão
    expirada, licença bloqueada, ou problema de rede/servidor."""


def _tratar_resposta(r: requests.Response) -> dict:
    if r.status_code == 401:
        detalhe = r.json().get("detail", "não autorizado") if r.headers.get("content-type", "").startswith("application/json") else "não autorizado"
        raise ErroHubApi(f"[hub] {detalhe} - faça login de novo")
    if r.status_code >= 400:
        detalhe = r.json().get("detail", r.text) if r.headers.get("content-type", "").startswith("application/json") else r.text
        raise ErroHubApi(f"[hub] erro {r.status_code}: {detalhe}")
    return r.json()


def login(usuario: str, senha: str) -> dict:
    """Retorna {'token', 'escritorio_id', 'nome'} ou levanta ErroHubApi se
    usuário/senha estiverem errados."""
    try:
        r = _sessao.post(f"{BASE_URL}/login", json={"usuario": usuario, "senha": senha}, timeout=TIMEOUT_PADRAO_S)
    except requests.RequestException as exc:
        raise _erro_conexao(exc) from exc
    return _tratar_resposta(r)


def _cabecalho(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def verificar_licenca(token: str) -> bool:
    try:
        r = _sessao.get(f"{BASE_URL}/licenca", headers=_cabecalho(token), timeout=TIMEOUT_PADRAO_S)
    except requests.RequestException as exc:
        raise _erro_conexao(exc) from exc
    return bool(_tratar_resposta(r)["liberado"])


def execucao_pendente(token: str, modulo: str) -> dict:
    """Retorna {'execucao_id': int|None, 'empresas': [{'id','codigo','cnpj_cpf'}]}."""
    try:
        r = _sessao.get(
            f"{BASE_URL}/execucao-pendente", params={"modulo": modulo},
            headers=_cabecalho(token), timeout=TIMEOUT_PADRAO_S,
        )
    except requests.RequestException as exc:
        raise _erro_conexao(exc) from exc
    return _tratar_resposta(r)


def marcar_rodando(token: str, empresa_id: int) -> None:
    r = _sessao.post(f"{BASE_URL}/empresas/{empresa_id}/rodando", headers=_cabecalho(token), timeout=TIMEOUT_PADRAO_S)
    _tratar_resposta(r)


def concluir_empresa(
    token: str, empresa_id: int, movimento: str,
    pdf_path: Optional[Path] = None, xml_path: Optional[Path] = None,
) -> None:
    body = {
        "movimento": movimento,
        "pdf_base64": base64.b64encode(pdf_path.read_bytes()).decode() if pdf_path else None,
        "pdf_nome": pdf_path.name if pdf_path else "",
        "xml_zip_base64": base64.b64encode(xml_path.read_bytes()).decode() if xml_path else None,
        "xml_zip_nome": xml_path.name if xml_path else "",
    }
    r = _sessao.post(
        f"{BASE_URL}/empresas/{empresa_id}/concluir", headers=_cabecalho(token),
        json=body, timeout=TIMEOUT_UPLOAD_S,
    )
    _tratar_resposta(r)


def erro_empresa(token: str, empresa_id: int, erro: str) -> None:
    r = _sessao.post(
        f"{BASE_URL}/empresas/{empresa_id}/erro", headers=_cabecalho(token),
        json={"erro": erro}, timeout=TIMEOUT_PADRAO_S,
    )
    _tratar_resposta(r)


def concluir_execucao(token: str, execucao_id: int, competencia: str, status: str) -> None:
    r = _sessao.post(
        f"{BASE_URL}/execucoes/{execucao_id}/concluir", headers=_cabecalho(token),
        json={"competencia": competencia, "status": status}, timeout=TIMEOUT_PADRAO_S,
    )
    _tratar_resposta(r)


# ---------------------------------------------------------------------------
# RPA NF GO (attended_worker/nfgo_attended.py)
# ---------------------------------------------------------------------------

def _post(token: str, caminho: str, corpo: Optional[dict] = None, timeout: int = TIMEOUT_PADRAO_S) -> dict:
    try:
        r = _sessao.post(f"{BASE_URL}{caminho}", headers=_cabecalho(token), json=corpo or {}, timeout=timeout)
    except requests.RequestException as exc:
        raise _erro_conexao(exc) from exc
    return _tratar_resposta(r)


def iniciar_execucao(token: str, execucao_id: int) -> None:
    _post(token, f"/execucoes/{execucao_id}/iniciar")


def situacao_execucao(token: str, execucao_id: int) -> dict:
    """{'status', 'cancelar_solicitado'} - o programa confere antes de cada
    consulta se alguém clicou em "Cancelar processamento" no Hub."""
    try:
        r = _sessao.get(f"{BASE_URL}/execucoes/{execucao_id}/situacao", headers=_cabecalho(token), timeout=TIMEOUT_PADRAO_S)
    except requests.RequestException as exc:
        raise _erro_conexao(exc) from exc
    return _tratar_resposta(r)


def interromper_execucao(token: str, execucao_id: int, motivo: str) -> None:
    _post(token, f"/execucoes/{execucao_id}/interromper", {"motivo": motivo})


def concluir_consulta_nfgo(
    token: str, empresa_id: int, *, status: str, movimento: str, erro: str = "",
    zip_path: Optional[Path] = None, evidencia_png: Optional[bytes] = None,
    qtd_notas_portal: Optional[int] = None, qtd_xml: Optional[int] = None, observacao: str = "",
) -> None:
    corpo = {
        "status": status,
        "movimento": movimento,
        "erro": erro,
        "xml_zip_base64": base64.b64encode(zip_path.read_bytes()).decode() if zip_path else None,
        "xml_zip_nome": zip_path.name if zip_path else "",
        "evidencia_base64": base64.b64encode(evidencia_png).decode() if evidencia_png else None,
        "qtd_notas_portal": qtd_notas_portal,
        "qtd_xml": qtd_xml,
        "observacao": observacao,
    }
    _post(token, f"/empresas/{empresa_id}/concluir", corpo, timeout=TIMEOUT_UPLOAD_S)

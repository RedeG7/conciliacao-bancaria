#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
API HTTP pro script attended (attended_worker/) sincronizar com o Hub sem
precisar de chave SSH nem acesso direto ao Postgres do VPS - só usuário e
senha (os mesmos do login no site), do jeito mais simples possível pra
quem baixa o .exe.

Reaproveita auth.py (login, sessão) e rpa/core.py (execuções/empresas)
tal como já existem pro app Streamlit - essa API só expõe as mesmas
operações por HTTP, sem duplicar lógica de banco.

Roda como um serviço Docker separado (mesma imagem do app, entrypoint
diferente - ver docker-compose.yml), atrás do Caddy em /api/* (ver
Caddyfile) - por isso os response models não incluem nada sensível além
do necessário, e todo endpoint (exceto /login) exige o token da sessão.
"""

from __future__ import annotations

import base64
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import auth
from rpa import core as rpa_core

app = FastAPI(title="Hub RedeG7 - API attended", docs_url=None, redoc_url=None)


@app.on_event("startup")
def _startup() -> None:
    # idempotente (CREATE TABLE IF NOT EXISTS / ALTER ... ADD COLUMN IF NOT
    # EXISTS) - seguro rodar de novo mesmo com o app Streamlit já tendo
    # feito isso; garante que a API funciona sozinha mesmo se um dia rodar
    # antes do app novo (num banco recem-criado, por exemplo).
    auth.garantir_schema()
    rpa_core.garantir_schema()


# ---------------------------------------------------------------------------
# Autenticação
# ---------------------------------------------------------------------------

class LoginBody(BaseModel):
    usuario: str
    senha: str


class LoginResposta(BaseModel):
    token: str
    escritorio_id: str
    nome: str


@app.post("/api/login", response_model=LoginResposta)
def login(body: LoginBody):
    dados = auth.autenticar(body.usuario.strip(), body.senha)
    if not dados or not auth.usuario_esta_ativo(dados):
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos")
    token = auth.criar_sessao(dados["usuario"])
    return LoginResposta(token=token, escritorio_id=dados["escritorio_id"], nome=dados["nome"])


def _usuario_autenticado(authorization: Optional[str]) -> dict:
    """Extrai e valida o token do header 'Authorization: Bearer <token>' -
    reaproveita a MESMA tabela de sessões que o login web usa (30 dias de
    validade, revogável), então uma sessão criada aqui aparece igual a
    uma sessão de navegador pro resto do sistema."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Faltou o token (header Authorization: Bearer <token>)")
    token = authorization.split(" ", 1)[1].strip()
    dados = auth.validar_sessao(token)
    if not dados:
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada - faça login de novo")
    return dados


def _empresa_pertence_ao_escritorio(empresa_id: int, escritorio_id: str) -> dict:
    """Confere que a empresa pedida pertence a uma execução do MESMO
    escritório do token - sem isso, um escritório poderia mexer nos dados
    de outro só adivinhando o id numérico."""
    with auth.conectar() as conn:
        linha = conn.execute("""
            SELECT e.* FROM rpa_empresas e
            JOIN rpa_execucoes x ON x.id = e.execucao_id
            WHERE e.id = %s AND x.escritorio_id = %s
        """, (empresa_id, escritorio_id)).fetchone()
    if not linha:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")
    return linha


# ---------------------------------------------------------------------------
# Licença de uso do script attended
# ---------------------------------------------------------------------------

@app.get("/api/licenca")
def licenca(authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    escritorios = auth.carregar_escritorios()
    dados = escritorios.get(usuario["escritorio_id"])
    if dados is None:
        raise HTTPException(status_code=404, detail="Escritório não encontrado")
    return {"liberado": bool(dados.get("issnet_attended_liberado", True))}


# ---------------------------------------------------------------------------
# Execução pendente + empresas
# ---------------------------------------------------------------------------

@app.get("/api/execucao-pendente")
def execucao_pendente(modulo: str, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    execucoes = rpa_core.listar_execucoes(usuario["escritorio_id"], modulo)
    execucao = next((e for e in execucoes if e["status"] == rpa_core.STATUS_PENDENTE), None)
    if execucao is None:
        return {"execucao_id": None, "empresas": []}
    empresas = rpa_core.listar_empresas_pendentes(execucao["id"])
    return {
        "execucao_id": execucao["id"],
        "empresas": [
            {"id": e["id"], "codigo": e["codigo"], "cnpj_cpf": e["cnpj_cpf"]}
            for e in empresas
        ],
    }


# ---------------------------------------------------------------------------
# Atualização por empresa
# ---------------------------------------------------------------------------

@app.post("/api/empresas/{empresa_id}/rodando")
def empresa_rodando(empresa_id: int, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    _empresa_pertence_ao_escritorio(empresa_id, usuario["escritorio_id"])
    rpa_core.marcar_empresa_status(empresa_id, rpa_core.STATUS_RODANDO)
    return {"ok": True}


class EmpresaConcluirBody(BaseModel):
    movimento: str = ""
    pdf_base64: Optional[str] = None
    pdf_nome: str = ""
    xml_zip_base64: Optional[str] = None
    xml_zip_nome: str = ""


@app.post("/api/empresas/{empresa_id}/concluir")
def empresa_concluir(empresa_id: int, body: EmpresaConcluirBody, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    _empresa_pertence_ao_escritorio(empresa_id, usuario["escritorio_id"])
    rpa_core.atualizar_empresa(
        empresa_id,
        status=rpa_core.STATUS_CONCLUIDO,
        movimento=body.movimento,
        pdf=base64.b64decode(body.pdf_base64) if body.pdf_base64 else None,
        pdf_nome=body.pdf_nome,
        xml_zip=base64.b64decode(body.xml_zip_base64) if body.xml_zip_base64 else None,
        xml_zip_nome=body.xml_zip_nome,
    )
    return {"ok": True}


class EmpresaErroBody(BaseModel):
    erro: str


@app.post("/api/empresas/{empresa_id}/erro")
def empresa_erro(empresa_id: int, body: EmpresaErroBody, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    _empresa_pertence_ao_escritorio(empresa_id, usuario["escritorio_id"])
    rpa_core.atualizar_empresa(empresa_id, status=rpa_core.STATUS_ERRO, erro=body.erro)
    return {"ok": True}


class ExecucaoConcluirBody(BaseModel):
    competencia: str
    status: str


@app.post("/api/execucoes/{execucao_id}/concluir")
def execucao_concluir(execucao_id: int, body: ExecucaoConcluirBody, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    execucao = rpa_core.obter_execucao(execucao_id, usuario["escritorio_id"])
    if execucao is None:
        raise HTTPException(status_code=404, detail="Execução não encontrada")
    rpa_core.marcar_execucao_concluida(execucao_id, body.competencia, body.status)
    return {"ok": True}

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
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Optional

from fastapi import Cookie, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from pydantic import BaseModel

import auth
from rpa import core as rpa_core

app = FastAPI(title="Hub RedeG7 - API attended", docs_url=None, redoc_url=None)

_RAIZ = Path(__file__).resolve().parent
_VERSAO_PATH = _RAIZ / "attended_worker" / "VERSION"
_EXE_PATH = _RAIZ / "attended_worker" / "dist" / "issnet_attended.exe"
# programa do PC do RPA NF GO (attended_worker/gui_nfgo.py) - versão e .exe
# próprios (é um programa separado do ISS Net); o .exe é montado num runner
# Windows no deploy (.github/workflows/deploy.yml) e entra na imagem
_VERSAO_NFGO_PATH = _RAIZ / "attended_worker" / "VERSION_NFGO"
_EXE_NFGO_PATH = _RAIZ / "attended_worker" / "dist" / "nfgo_attended.exe"


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
    try:
        rpa_core.registrar_contato_pc(usuario["escritorio_id"], modulo, usuario.get("usuario") or usuario.get("nome") or "")
    except Exception:
        pass  # só informativo pra tela - nunca derruba a consulta da fila
    execucoes = rpa_core.listar_execucoes(usuario["escritorio_id"], modulo)
    execucao = next((e for e in execucoes if e["status"] == rpa_core.STATUS_PENDENTE), None)
    if execucao is None:
        return {"execucao_id": None, "empresas": []}
    empresas = rpa_core.listar_empresas_pendentes(execucao["id"])
    # campos a mais (obrigacao, razao_social, inscricao_estadual,
    # competencia, pasta_destino): usados pelo programa do RPA NF GO; o do
    # ISS Net só lê id/codigo/cnpj_cpf e ignora o resto
    return {
        "execucao_id": execucao["id"],
        "competencia": execucao.get("competencia") or "",
        "pasta_destino": execucao.get("pasta_destino") or "",
        "empresas": [
            {
                "id": e["id"], "codigo": e["codigo"], "cnpj_cpf": e["cnpj_cpf"],
                "obrigacao": e.get("obrigacao") or "", "razao_social": e.get("razao_social") or "",
                "inscricao_estadual": e.get("inscricao_estadual") or "",
            }
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
    # RPA NF GO (opcionais - o programa do ISS Net não manda):
    # status ERRO = download incompleto (arquivos ficam gravados)
    status: str = rpa_core.STATUS_CONCLUIDO
    erro: str = ""
    qtd_notas_portal: Optional[int] = None
    qtd_xml: Optional[int] = None
    evidencia_base64: Optional[str] = None
    observacao: str = ""


@app.post("/api/empresas/{empresa_id}/concluir")
def empresa_concluir(empresa_id: int, body: EmpresaConcluirBody, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    _empresa_pertence_ao_escritorio(empresa_id, usuario["escritorio_id"])
    status = body.status if body.status in (rpa_core.STATUS_CONCLUIDO, rpa_core.STATUS_ERRO) else rpa_core.STATUS_CONCLUIDO
    rpa_core.atualizar_empresa(
        empresa_id,
        status=status,
        movimento=body.movimento,
        erro=body.erro,
        pdf=base64.b64decode(body.pdf_base64) if body.pdf_base64 else None,
        pdf_nome=body.pdf_nome,
        xml_zip=base64.b64decode(body.xml_zip_base64) if body.xml_zip_base64 else None,
        xml_zip_nome=body.xml_zip_nome,
        qtd_notas_portal=body.qtd_notas_portal,
        qtd_xml=body.qtd_xml,
        evidencia_png=base64.b64decode(body.evidencia_base64) if body.evidencia_base64 else None,
        observacao=body.observacao,
    )
    return {"ok": True}


class EmpresaErroBody(BaseModel):
    erro: str
    # programa do RPA NF GO (opcionais): print da tela na hora do erro e o
    # que já tinha sido lido antes dele, pra grade não ficar vazia
    screenshot_base64: Optional[str] = None
    evidencia_base64: Optional[str] = None
    qtd_notas_portal: Optional[int] = None


@app.post("/api/empresas/{empresa_id}/erro")
def empresa_erro(empresa_id: int, body: EmpresaErroBody, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    _empresa_pertence_ao_escritorio(empresa_id, usuario["escritorio_id"])
    rpa_core.atualizar_empresa(
        empresa_id, status=rpa_core.STATUS_ERRO, erro=body.erro,
        screenshot_erro=base64.b64decode(body.screenshot_base64) if body.screenshot_base64 else None,
        evidencia_png=base64.b64decode(body.evidencia_base64) if body.evidencia_base64 else None,
        qtd_notas_portal=body.qtd_notas_portal,
    )
    return {"ok": True}


def _execucao_do_escritorio(execucao_id: int, escritorio_id: str) -> dict:
    execucao = rpa_core.obter_execucao(execucao_id, escritorio_id)
    if execucao is None:
        raise HTTPException(status_code=404, detail="Execução não encontrada")
    return execucao


@app.post("/api/execucoes/{execucao_id}/iniciar")
def execucao_iniciar(execucao_id: int, authorization: Optional[str] = Header(None)):
    """Programa do PC começou a processar: execução vira RODANDO (assim o
    botão "Cancelar processamento" da tela grava o pedido em vez de
    cancelar na hora, e o programa confere com /situacao)."""
    usuario = _usuario_autenticado(authorization)
    _execucao_do_escritorio(execucao_id, usuario["escritorio_id"])
    with auth.conectar() as conn:
        conn.execute(
            "UPDATE rpa_execucoes SET status = %s, iniciado_em = now() WHERE id = %s",
            (rpa_core.STATUS_RODANDO, execucao_id),
        )
        conn.commit()
    return {"ok": True}


@app.get("/api/execucoes/{execucao_id}/situacao")
def execucao_situacao(execucao_id: int, authorization: Optional[str] = Header(None)):
    usuario = _usuario_autenticado(authorization)
    execucao = _execucao_do_escritorio(execucao_id, usuario["escritorio_id"])
    try:
        rpa_core.registrar_contato_pc(usuario["escritorio_id"], execucao["modulo"], usuario.get("usuario") or "")
    except Exception:
        pass
    return {"status": execucao["status"], "cancelar_solicitado": bool(execucao.get("cancelar_solicitado"))}


@app.get("/api/credencial-nfgo")
def credencial_nfgo(authorization: Optional[str] = Header(None)):
    """CPF + senha do Acesso Restrito da SEFAZ-GO cadastrados na tela do RPA
    NF GO - o programa do PC usa na tela "Este módulo requer nova
    autenticação". Só do escritório do próprio usuário logado; o programa
    guarda só em memória enquanto roda (nunca em disco)."""
    usuario = _usuario_autenticado(authorization)
    cred = rpa_core.obter_credencial(usuario["escritorio_id"], "sefazgo_portal")
    if not cred:
        return {"cpf": "", "senha": ""}
    return {"cpf": cred["cnpj"], "senha": cred["senha"]}


class ExecucaoInterromperBody(BaseModel):
    motivo: str = ""


@app.post("/api/execucoes/{execucao_id}/interromper")
def execucao_interromper(execucao_id: int, body: ExecucaoInterromperBody, authorization: Optional[str] = Header(None)):
    """Cancelamento pedido na tela ou parada do programa (sessão do portal
    perdida etc.): o que não terminou vira ERRO com o motivo e a execução
    fica ERRO - aparece o Reprocessar na tela."""
    usuario = _usuario_autenticado(authorization)
    _execucao_do_escritorio(execucao_id, usuario["escritorio_id"])
    motivo = (body.motivo or rpa_core.MOTIVO_CANCELADO)[:500]
    with auth.conectar() as conn:
        conn.execute(
            "UPDATE rpa_empresas SET status = %s, erro = %s, atualizado_em = now() "
            "WHERE execucao_id = %s AND status IN (%s, %s)",
            (rpa_core.STATUS_ERRO, motivo, execucao_id, rpa_core.STATUS_PENDENTE, rpa_core.STATUS_RODANDO),
        )
        conn.execute(
            "UPDATE rpa_execucoes SET status = %s, concluido_em = now(), cancelar_solicitado = false WHERE id = %s",
            (rpa_core.STATUS_ERRO, execucao_id),
        )
        conn.commit()
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


# ---------------------------------------------------------------------------
# Auto-atualização do script attended - SEM autenticação de propósito: o
# .exe precisa checar/baixar a versão nova antes mesmo de qualquer login
# (e o executável em si não tem nada sensível - quem quiser pode pegar o
# mesmo arquivo pelo botão de download na tela do Hub).
# ---------------------------------------------------------------------------

@app.get("/api/attended/versao")
def attended_versao():
    versao = _VERSAO_PATH.read_text(encoding="utf-8").strip() if _VERSAO_PATH.exists() else "0.0"
    return {"versao": versao}


@app.get("/api/attended-nfgo/versao")
def attended_nfgo_versao():
    versao = _VERSAO_NFGO_PATH.read_text(encoding="utf-8").strip() if _VERSAO_NFGO_PATH.exists() else "0.0"
    return {"versao": versao}


@app.get("/api/attended-nfgo/download")
def attended_nfgo_download():
    if not _EXE_NFGO_PATH.exists():
        raise HTTPException(status_code=404, detail="Executável não encontrado")
    return FileResponse(_EXE_NFGO_PATH, media_type="application/octet-stream", filename="nfgo_attended.exe")


_ZIP_NFGO_CACHE: dict = {}


@app.get("/api/attended-nfgo/download-zip")
def attended_nfgo_download_zip():
    """Mesmo .exe dentro de um .zip - antivírus/firewall de escritório
    costuma cortar no meio (erro 10054) download de .exe feito por programa
    (não pelo navegador); .zip passa. Montado uma vez por versão do .exe e
    servido do disco (FileResponse aceita Range, o programa retoma se cair)."""
    if not _EXE_NFGO_PATH.exists():
        raise HTTPException(status_code=404, detail="Executável não encontrado")
    import tempfile
    import zipfile
    chave = _EXE_NFGO_PATH.stat().st_mtime_ns
    destino = _ZIP_NFGO_CACHE.get(chave)
    if destino is None or not Path(destino).exists():
        destino = str(Path(tempfile.gettempdir()) / f"nfgo_attended_{chave}.zip")
        with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(_EXE_NFGO_PATH, arcname="nfgo_attended.exe")
        _ZIP_NFGO_CACHE.clear()
        _ZIP_NFGO_CACHE[chave] = destino
    return FileResponse(destino, media_type="application/zip", filename="nfgo_attended.zip")


@app.get("/api/attended/download")
def attended_download():
    if not _EXE_PATH.exists():
        raise HTTPException(status_code=404, detail="Executável não encontrado")
    return FileResponse(_EXE_PATH, media_type="application/octet-stream", filename="issnet_attended.exe")


# ---------------------------------------------------------------------------
# Login único no CRM de Marketing (mkt.redeg7.com, pasta marketing/)
# ---------------------------------------------------------------------------
# O card "Marketing & Comercial" da home do Hub aponta pra cá. Com a sessão
# do Hub (cookie "sessao_token", o mesmo do F5 no app Streamlit), gera um
# bilhete assinado (HMAC-SHA256 com MARKETING_SSO_SECRET, que o CRM também
# recebe - ver docker-compose.yml) que vale 60s e redireciona pro CRM, que
# confere o bilhete, cria a sessão dele e entra direto (marketing/src/sso.js).

_SSO_VALIDADE_S = 60


def _app_permitido(dados: dict, app_id: str) -> bool:
    """Mesma regra de _apps_permitidos_efetivos (app_conciliacao.py): lista
    vazia = sem restrição; teto do escritório ∩ refino do usuário."""
    if dados.get("papel") == auth.PAPEL_SUPER_GLOBAL:
        return True
    escritorio = auth.carregar_escritorios().get(dados.get("escritorio_id", ""), {})
    apps_escritorio = escritorio.get("apps_permitidos") or []
    if apps_escritorio and app_id not in apps_escritorio:
        return False
    apps_usuario = dados.get("apps_permitidos") or []
    return not apps_usuario or app_id in apps_usuario


def _bilhete_sso(dados: dict, segredo: str) -> str:
    payload = {
        "sub": dados["usuario"],
        "name": dados.get("nome") or dados["usuario"],
        "admin": dados.get("papel") in (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO),
        # escritorio do usuario: o CRM guarda os dados de cada escritorio
        # separados e so mostra os do escritorio de quem entrou
        "office": dados.get("escritorio_id") or "",
        "exp": int(time.time()) + _SSO_VALIDADE_S,
        "jti": secrets.token_urlsafe(16),
    }
    corpo = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    assinatura = hmac.new(segredo.encode(), corpo.encode(), hashlib.sha256).digest()
    return corpo + "." + base64.urlsafe_b64encode(assinatura).decode().rstrip("=")


@app.get("/api/sso/marketing")
def sso_marketing(sessao_token: Optional[str] = Cookie(None)):
    dominio = os.environ.get("DOMINIO_MARKETING", "")
    segredo = os.environ.get("MARKETING_SSO_SECRET", "")
    if not dominio or not segredo:
        return HTMLResponse("Acesso ao Marketing ainda não configurado no servidor.", status_code=503)
    dados = auth.validar_sessao(sessao_token or "")
    if not dados:
        # sem sessão no Hub: manda pro login do Hub
        return RedirectResponse("/", status_code=302)
    if not _app_permitido(dados, "marketing"):
        return HTMLResponse("Seu usuário não tem acesso ao Marketing & Comercial.", status_code=403)
    auth.registrar_acesso(dados["usuario"], dados.get("escritorio_id"), "Marketing & Comercial")
    return RedirectResponse(f"https://{dominio}/sso?t={_bilhete_sso(dados, segredo)}", status_code=302)

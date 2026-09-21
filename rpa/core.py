#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Infraestrutura comum do hub de RPAs: fila de execucoes/empresas no Postgres
(mesmo banco do resto do app, via auth.conectar()) e armazenamento cifrado
das credenciais de procurador usadas para logar em portais externos.

Diferente das senhas de usuario do app (auth.py, hash PBKDF2 de mao unica),
aqui a senha precisa ser RECUPERAVEL - o worker precisa do texto puro pra
digitar no formulario do portal externo. Por isso e cifrada (Fernet, chave
simetrica em RPA_ENC_KEY), nao "hasheada". Perder RPA_ENC_KEY torna as
credenciais salvas irrecuperaveis (nao ha como "resetar" como senha de
usuario - precisa recadastrar).

Cada modulo do hub (ex.: rpa/issweb) so usa estas funcoes genericas; nao
abre conexao propria nem redefine schema de fila.
"""

from __future__ import annotations

import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

import auth

STATUS_PENDENTE = "PENDENTE"
STATUS_RODANDO = "RODANDO"
STATUS_CONCLUIDO = "CONCLUIDO"
STATUS_ERRO = "ERRO"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def garantir_schema() -> None:
    with auth.conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rpa_credenciais (
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                sistema TEXT NOT NULL,
                cnpj TEXT NOT NULL,
                senha_cifrada BYTEA NOT NULL,
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                atualizado_por TEXT NOT NULL,
                PRIMARY KEY (escritorio_id, sistema)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rpa_execucoes (
                id SERIAL PRIMARY KEY,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                modulo TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'PENDENTE',
                competencia TEXT,
                planilha_original BYTEA NOT NULL,
                planilha_nome TEXT NOT NULL,
                criado_por TEXT NOT NULL,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                iniciado_em TIMESTAMPTZ,
                concluido_em TIMESTAMPTZ
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rpa_empresas (
                id SERIAL PRIMARY KEY,
                execucao_id INTEGER NOT NULL REFERENCES rpa_execucoes(id) ON DELETE CASCADE,
                codigo TEXT NOT NULL,
                cnpj_cpf TEXT NOT NULL,
                obrigacao TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'PENDENTE',
                movimento TEXT,
                pdf BYTEA,
                pdf_nome TEXT,
                erro TEXT,
                atualizado_em TIMESTAMPTZ
            )
        """)
        conn.commit()


# ---------------------------------------------------------------------------
# Cifra/decifra de credenciais
# ---------------------------------------------------------------------------

def _fernet() -> Fernet:
    chave = os.environ.get("RPA_ENC_KEY")
    if not chave:
        raise RuntimeError(
            "RPA_ENC_KEY não configurada. Gere uma com: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" "
            "e defina como variável de ambiente."
        )
    return Fernet(chave.encode("utf-8"))


def salvar_credencial(escritorio_id: str, sistema: str, cnpj: str, senha: str, atualizado_por: str) -> None:
    senha_cifrada = _fernet().encrypt(senha.encode("utf-8"))
    with auth.conectar() as conn:
        conn.execute("""
            INSERT INTO rpa_credenciais (escritorio_id, sistema, cnpj, senha_cifrada, atualizado_por)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (escritorio_id, sistema) DO UPDATE SET
                cnpj = EXCLUDED.cnpj,
                senha_cifrada = EXCLUDED.senha_cifrada,
                atualizado_em = now(),
                atualizado_por = EXCLUDED.atualizado_por
        """, (escritorio_id, sistema, cnpj, senha_cifrada, atualizado_por))
        conn.commit()


def tem_credencial(escritorio_id: str, sistema: str) -> Optional[dict]:
    """Retorna metadados (cnpj, atualizado_em, atualizado_por) sem decifrar a senha —
    usado pela tela pra mostrar 'credencial já cadastrada' sem expor segredo."""
    with auth.conectar() as conn:
        linha = conn.execute(
            "SELECT cnpj, atualizado_em, atualizado_por FROM rpa_credenciais WHERE escritorio_id = %s AND sistema = %s",
            (escritorio_id, sistema),
        ).fetchone()
    return linha


def obter_credencial(escritorio_id: str, sistema: str) -> Optional[dict]:
    """Decifra e retorna {'cnpj', 'senha'} — só o worker deve chamar isso."""
    with auth.conectar() as conn:
        linha = conn.execute(
            "SELECT cnpj, senha_cifrada FROM rpa_credenciais WHERE escritorio_id = %s AND sistema = %s",
            (escritorio_id, sistema),
        ).fetchone()
    if not linha:
        return None
    try:
        senha = _fernet().decrypt(bytes(linha["senha_cifrada"])).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError(
            f"Não foi possível decifrar a credencial de '{sistema}' — RPA_ENC_KEY pode ter mudado."
        ) from exc
    return {"cnpj": linha["cnpj"], "senha": senha}


# ---------------------------------------------------------------------------
# Fila de execucoes
# ---------------------------------------------------------------------------

def criar_execucao(
    escritorio_id: str, modulo: str, planilha_bytes: bytes, planilha_nome: str,
    criado_por: str, empresas: list[dict],
) -> int:
    """Cria a execucao e ja insere as linhas de empresa (status PENDENTE),
    tudo numa transacao so."""
    with auth.conectar() as conn:
        linha = conn.execute("""
            INSERT INTO rpa_execucoes (escritorio_id, modulo, planilha_original, planilha_nome, criado_por)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
        """, (escritorio_id, modulo, planilha_bytes, planilha_nome, criado_por)).fetchone()
        execucao_id = linha["id"]

        for empresa in empresas:
            conn.execute("""
                INSERT INTO rpa_empresas (execucao_id, codigo, cnpj_cpf, obrigacao)
                VALUES (%s, %s, %s, %s)
            """, (execucao_id, empresa["codigo"], empresa["cnpj_cpf"], empresa["obrigacao"]))

        conn.commit()
    return execucao_id


def listar_execucoes(escritorio_id: str, modulo: Optional[str] = None) -> list[dict]:
    with auth.conectar() as conn:
        if modulo:
            linhas = conn.execute(
                "SELECT * FROM rpa_execucoes WHERE escritorio_id = %s AND modulo = %s ORDER BY criado_em DESC",
                (escritorio_id, modulo),
            ).fetchall()
        else:
            linhas = conn.execute(
                "SELECT * FROM rpa_execucoes WHERE escritorio_id = %s ORDER BY criado_em DESC",
                (escritorio_id,),
            ).fetchall()
    return linhas


def obter_execucao(execucao_id: int, escritorio_id: str) -> Optional[dict]:
    """Sempre filtra por escritorio_id tambem, pra um escritorio nao conseguir
    ver a execucao de outro so adivinhando o id."""
    with auth.conectar() as conn:
        linha = conn.execute(
            "SELECT * FROM rpa_execucoes WHERE id = %s AND escritorio_id = %s",
            (execucao_id, escritorio_id),
        ).fetchone()
    return linha


def listar_empresas(execucao_id: int) -> list[dict]:
    with auth.conectar() as conn:
        linhas = conn.execute(
            "SELECT * FROM rpa_empresas WHERE execucao_id = %s ORDER BY id", (execucao_id,)
        ).fetchall()
    return linhas


# ---------------------------------------------------------------------------
# Usadas só pelo worker
# ---------------------------------------------------------------------------

def reivindicar_proxima_execucao() -> Optional[dict]:
    """SELECT...FOR UPDATE SKIP LOCKED: se um dia houver mais de um worker,
    nenhum pega a execucao que o outro ja esta processando."""
    with auth.conectar() as conn:
        linha = conn.execute("""
            SELECT * FROM rpa_execucoes
            WHERE status = %s
            ORDER BY criado_em
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        """, (STATUS_PENDENTE,)).fetchone()
        if linha:
            conn.execute(
                "UPDATE rpa_execucoes SET status = %s, iniciado_em = now() WHERE id = %s",
                (STATUS_RODANDO, linha["id"]),
            )
            conn.commit()
    return linha


def marcar_execucao_concluida(execucao_id: int, competencia: str, status: str) -> None:
    with auth.conectar() as conn:
        conn.execute(
            "UPDATE rpa_execucoes SET status = %s, competencia = %s, concluido_em = now() WHERE id = %s",
            (status, competencia, execucao_id),
        )
        conn.commit()


def listar_empresas_pendentes(execucao_id: int) -> list[dict]:
    with auth.conectar() as conn:
        linhas = conn.execute(
            "SELECT * FROM rpa_empresas WHERE execucao_id = %s AND status = %s ORDER BY id",
            (execucao_id, STATUS_PENDENTE),
        ).fetchall()
    return linhas


def marcar_empresa_status(empresa_id: int, status: str) -> None:
    with auth.conectar() as conn:
        conn.execute(
            "UPDATE rpa_empresas SET status = %s, atualizado_em = now() WHERE id = %s",
            (status, empresa_id),
        )
        conn.commit()


def atualizar_empresa(
    empresa_id: int, status: str, movimento: str = "", erro: str = "",
    pdf: Optional[bytes] = None, pdf_nome: str = "",
) -> None:
    with auth.conectar() as conn:
        conn.execute("""
            UPDATE rpa_empresas
            SET status = %s, movimento = %s, erro = %s, pdf = %s, pdf_nome = %s, atualizado_em = now()
            WHERE id = %s
        """, (status, movimento, erro, pdf, pdf_nome, empresa_id))
        conn.commit()

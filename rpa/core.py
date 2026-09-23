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

import calendar
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
        # certificado_pfx: só usado por módulos com tipo_auth "certificado"
        # (ver rpa/registry.py) - login por certificado digital A1 (.pfx) em
        # vez de usuário/senha. Quando presente, senha_cifrada guarda a senha
        # do PRÓPRIO certificado (cifrada), não a senha do portal.
        conn.execute("""
            ALTER TABLE rpa_credenciais
            ADD COLUMN IF NOT EXISTS certificado_pfx BYTEA
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
        # xml_zip: segundo arquivo opcional por empresa, só usado pelo fluxo
        # condicional do issnet (DMS com movimento também baixa o zip de
        # XMLs das notas do período, além do PDF do Livro Fiscal) - ver
        # rpa/issnet/processar.py. municipio: só o issnet usa (Goiânia e
        # Aparecida de Goiânia são caminhos/sessões separados no mesmo
        # domínio do portal), issweb deixa em branco.
        conn.execute("""
            ALTER TABLE rpa_empresas
            ADD COLUMN IF NOT EXISTS xml_zip BYTEA,
            ADD COLUMN IF NOT EXISTS xml_zip_nome TEXT,
            ADD COLUMN IF NOT EXISTS municipio TEXT
        """)
        # razao_social: opcional, só o issnet captura da planilha (pra nome
        # de pasta "21 - EMPRESA ABC" no zip e no relatorio geral, conforme
        # especificacao) - issweb deixa em branco, mantem so o codigo.
        conn.execute("""
            ALTER TABLE rpa_empresas
            ADD COLUMN IF NOT EXISTS razao_social TEXT
        """)
        # screenshot_erro: print da tela no momento exato da falha (só
        # quando status vira ERRO) - ajuda a diagnosticar sem precisar
        # reproduzir a automação de novo. Nunca gravado em sucesso.
        conn.execute("""
            ALTER TABLE rpa_empresas
            ADD COLUMN IF NOT EXISTS screenshot_erro BYTEA
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


def salvar_credencial_certificado(
    escritorio_id: str, sistema: str, cnpj_titular: str, pfx_bytes: bytes,
    senha_certificado: str, atualizado_por: str,
) -> None:
    """Equivalente a salvar_credencial(), mas para módulos com login por
    certificado digital A1: cifra o próprio arquivo .pfx (em certificado_pfx)
    e a senha do certificado (em senha_cifrada, mesmo campo de sempre)."""
    fernet = _fernet()
    pfx_cifrado = fernet.encrypt(pfx_bytes)
    senha_cifrada = fernet.encrypt(senha_certificado.encode("utf-8"))
    with auth.conectar() as conn:
        conn.execute("""
            INSERT INTO rpa_credenciais (escritorio_id, sistema, cnpj, senha_cifrada, certificado_pfx, atualizado_por)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (escritorio_id, sistema) DO UPDATE SET
                cnpj = EXCLUDED.cnpj,
                senha_cifrada = EXCLUDED.senha_cifrada,
                certificado_pfx = EXCLUDED.certificado_pfx,
                atualizado_em = now(),
                atualizado_por = EXCLUDED.atualizado_por
        """, (escritorio_id, sistema, cnpj_titular, senha_cifrada, pfx_cifrado, atualizado_por))
        conn.commit()


def obter_credencial_certificado(escritorio_id: str, sistema: str) -> Optional[dict]:
    """Decifra e retorna {'cnpj', 'pfx_bytes', 'senha'} - só o worker deve
    chamar isso. Mesmo motivo de InvalidToken de obter_credencial()."""
    with auth.conectar() as conn:
        linha = conn.execute(
            "SELECT cnpj, senha_cifrada, certificado_pfx FROM rpa_credenciais WHERE escritorio_id = %s AND sistema = %s",
            (escritorio_id, sistema),
        ).fetchone()
    if not linha or not linha["certificado_pfx"]:
        return None
    fernet = _fernet()
    try:
        senha = fernet.decrypt(bytes(linha["senha_cifrada"])).decode("utf-8")
        pfx_bytes = fernet.decrypt(bytes(linha["certificado_pfx"]))
    except InvalidToken as exc:
        raise RuntimeError(
            f"Não foi possível decifrar a credencial de '{sistema}' — RPA_ENC_KEY pode ter mudado."
        ) from exc
    return {"cnpj": linha["cnpj"], "pfx_bytes": pfx_bytes, "senha": senha}


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

def montar_competencia(mes: int, ano: int) -> dict:
    """Monta o dict de competencia (mesmo formato de calcular_competencia_anterior
    de cada modulo) a partir de um mes/ano escolhido na tela, em vez de sempre
    "mes anterior" - usado pelo worker quando a execucao ja tem competencia
    gravada (ver criar_execucao/rpa_worker.py)."""
    ultimo_dia = calendar.monthrange(ano, mes)[1]
    return {
        "mm_aaaa": f"{mes:02d}/{ano}",
        "mm_aaaa_arquivo": f"{mes:02d} {ano}",
        "mes": mes,
        "ano": ano,
        "data_inicial": f"01/{mes:02d}/{ano}",
        "data_final": f"{ultimo_dia:02d}/{mes:02d}/{ano}",
    }


def criar_execucao(
    escritorio_id: str, modulo: str, planilha_bytes: bytes, planilha_nome: str,
    criado_por: str, empresas: list[dict], competencia: str,
) -> int:
    """Cria a execucao e ja insere as linhas de empresa (status PENDENTE),
    tudo numa transacao so. competencia (formato "MM/AAAA") e a escolhida
    pelo usuario na tela - gravada ja na criacao pra o worker processar a
    competencia certa mesmo que so pegue a execucao da fila depois (ver
    rpa_worker.py), em vez de recalcular "mes anterior" na hora de rodar."""
    with auth.conectar() as conn:
        linha = conn.execute("""
            INSERT INTO rpa_execucoes (escritorio_id, modulo, planilha_original, planilha_nome, criado_por, competencia)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (escritorio_id, modulo, planilha_bytes, planilha_nome, criado_por, competencia)).fetchone()
        execucao_id = linha["id"]

        for empresa in empresas:
            conn.execute("""
                INSERT INTO rpa_empresas (execucao_id, codigo, cnpj_cpf, obrigacao, municipio, razao_social)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                execucao_id, empresa["codigo"], empresa["cnpj_cpf"], empresa["obrigacao"],
                empresa.get("municipio") or None, empresa.get("razao_social") or None,
            ))

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


def reprocessar_falhas(execucao_id: int) -> int:
    """Volta pra fila (status PENDENTE) só as empresas que ficaram ERRO
    nessa execução, e a execução em si (senão o worker nunca pega ela de
    novo — reivindicar_proxima_execucao só olha status PENDENTE). Empresas
    já CONCLUIDO não são tocadas. Retorna quantas linhas voltaram pra fila."""
    with auth.conectar() as conn:
        linhas = conn.execute(
            "UPDATE rpa_empresas SET status = %s, erro = NULL WHERE execucao_id = %s AND status = %s RETURNING id",
            (STATUS_PENDENTE, execucao_id, STATUS_ERRO),
        ).fetchall()
        if linhas:
            conn.execute(
                "UPDATE rpa_execucoes SET status = %s, concluido_em = NULL WHERE id = %s",
                (STATUS_PENDENTE, execucao_id),
            )
        conn.commit()
    return len(linhas)


def recuperar_execucoes_orfas() -> int:
    """Chamado uma vez no início do worker: qualquer execução ainda
    RODANDO nesse ponto só pode ser de uma instância anterior do worker
    que morreu no meio (deploy, crash, restart do container) - nada mais
    grava RODANDO além do próprio worker em execução. Volta essa execução
    e suas empresas RODANDO/PENDENTE pra fila, pra serem tentadas nesta
    nova instância. Empresas já CONCLUIDO/ERRO não são tocadas. Retorna
    quantas execuções foram recuperadas."""
    with auth.conectar() as conn:
        execucoes = conn.execute(
            "SELECT id FROM rpa_execucoes WHERE status = %s", (STATUS_RODANDO,)
        ).fetchall()
        for execucao in execucoes:
            conn.execute(
                "UPDATE rpa_empresas SET status = %s, erro = NULL WHERE execucao_id = %s AND status IN (%s, %s)",
                (STATUS_PENDENTE, execucao["id"], STATUS_RODANDO, STATUS_PENDENTE),
            )
            conn.execute(
                "UPDATE rpa_execucoes SET status = %s WHERE id = %s",
                (STATUS_PENDENTE, execucao["id"]),
            )
        conn.commit()
    return len(execucoes)


# ---------------------------------------------------------------------------
# Usadas só pelo worker
# ---------------------------------------------------------------------------

def reivindicar_proxima_execucao(modulos_permitidos: Optional[list] = None) -> Optional[dict]:
    """SELECT...FOR UPDATE SKIP LOCKED: se um dia houver mais de um worker,
    nenhum pega a execucao que o outro ja esta processando.

    modulos_permitidos (opcional) restringe quais modulos este worker
    pega - usado quando ha mais de um worker rodando em maquinas diferentes
    (ex.: issnet precisa rodar numa rede que o Cloudflare do portal nao
    bloqueie, entao o worker do VPS ignora esse modulo e so um worker local
    o pega - ver WORKER_MODULOS em rpa_worker.py)."""
    with auth.conectar() as conn:
        if modulos_permitidos:
            linha = conn.execute("""
                SELECT * FROM rpa_execucoes
                WHERE status = %s AND modulo = ANY(%s)
                ORDER BY criado_em
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            """, (STATUS_PENDENTE, modulos_permitidos)).fetchone()
        else:
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
    xml_zip: Optional[bytes] = None, xml_zip_nome: str = "",
    screenshot_erro: Optional[bytes] = None,
) -> None:
    with auth.conectar() as conn:
        conn.execute("""
            UPDATE rpa_empresas
            SET status = %s, movimento = %s, erro = %s, pdf = %s, pdf_nome = %s,
                xml_zip = %s, xml_zip_nome = %s, screenshot_erro = %s, atualizado_em = now()
            WHERE id = %s
        """, (status, movimento, erro, pdf, pdf_nome, xml_zip, xml_zip_nome, screenshot_erro, empresa_id))
        conn.commit()

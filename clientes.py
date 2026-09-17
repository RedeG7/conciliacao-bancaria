#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cadastro de clientes (empresas) por escritorio - cada cliente tem nome e
codigo no Dominio, usado para preencher o campo "Codigo da empresa no
Dominio" na tela de conciliacao por selecao, em vez de digitar toda vez.
Cada escritorio enxerga so os proprios clientes (mesmo isolamento de
usuarios/escritorios do auth.py).
"""

from __future__ import annotations

from typing import List, Optional

import auth


def garantir_schema() -> None:
    with auth.conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS clientes (
                id SERIAL PRIMARY KEY,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                nome TEXT NOT NULL,
                codigo_dominio TEXT NOT NULL,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (escritorio_id, codigo_dominio)
            )
        """)
        conn.commit()


def listar_clientes(escritorio_id: str) -> List[dict]:
    with auth.conectar() as conn:
        linhas = conn.execute(
            "SELECT * FROM clientes WHERE escritorio_id = %s ORDER BY nome", (escritorio_id,)
        ).fetchall()
    return linhas


def criar_cliente(escritorio_id: str, nome: str, codigo_dominio: str) -> "tuple[bool, str]":
    with auth.conectar() as conn:
        existe = conn.execute(
            "SELECT 1 FROM clientes WHERE escritorio_id = %s AND codigo_dominio = %s",
            (escritorio_id, codigo_dominio),
        ).fetchone()
        if existe:
            return False, f"Já existe um cliente com o código '{codigo_dominio}' cadastrado neste escritório."
        conn.execute(
            "INSERT INTO clientes (escritorio_id, nome, codigo_dominio) VALUES (%s, %s, %s)",
            (escritorio_id, nome, codigo_dominio),
        )
        conn.commit()
    return True, f"Cliente '{nome}' cadastrado com sucesso."


def remover_cliente(cliente_id: int, escritorio_id: str) -> bool:
    """Remove um cliente - exige o escritorio_id tambem, pra um admin de um
    escritorio nao conseguir apagar (por id adivinhado) o cliente de outro."""
    with auth.conectar() as conn:
        cur = conn.execute(
            "DELETE FROM clientes WHERE id = %s AND escritorio_id = %s", (cliente_id, escritorio_id)
        )
        ok = cur.rowcount > 0
        conn.commit()
    return ok


def buscar_por_codigo(escritorio_id: str, codigo_dominio: str) -> Optional[dict]:
    with auth.conectar() as conn:
        return conn.execute(
            "SELECT * FROM clientes WHERE escritorio_id = %s AND codigo_dominio = %s",
            (escritorio_id, codigo_dominio),
        ).fetchone()

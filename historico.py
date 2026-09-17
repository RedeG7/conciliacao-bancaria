#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Historico de lancamentos (conciliacoes) rodadas por cada usuario - visivel
para super_admin_global (escolhendo qualquer escritorio) e admin_escritorio
(so o proprio), para acompanhar quem processou o que e quando. Guarda
apenas o essencial: quem, qual empresa e quando - nao duplica o espelho
nem os arquivos gerados (esses continuam so no download da sessao).
"""

from __future__ import annotations

from typing import List, Optional

import auth


def garantir_schema() -> None:
    with auth.conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS historico_conciliacoes (
                id SERIAL PRIMARY KEY,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                usuario TEXT NOT NULL,
                empresa_nome TEXT,
                empresa_codigo TEXT NOT NULL,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.commit()


def registrar(escritorio_id: str, usuario: str, empresa_codigo: str, empresa_nome: Optional[str] = None) -> None:
    with auth.conectar() as conn:
        conn.execute(
            """INSERT INTO historico_conciliacoes (escritorio_id, usuario, empresa_nome, empresa_codigo)
               VALUES (%s, %s, %s, %s)""",
            (escritorio_id, usuario, empresa_nome, empresa_codigo),
        )
        conn.commit()


def listar(escritorio_id: str, limite: int = 300) -> List[dict]:
    with auth.conectar() as conn:
        return conn.execute(
            """SELECT * FROM historico_conciliacoes WHERE escritorio_id = %s
               ORDER BY criado_em DESC LIMIT %s""",
            (escritorio_id, limite),
        ).fetchall()

"""Testes do módulo de Admissões contra um Postgres de TESTE.

Rodar (o banco é apagado a cada teste - nunca aponte para o de produção):

    docker run -d --name hub-test-db -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=hub_test -p 55432:5432 postgres:16-alpine
    $env:TEST_DATABASE_URL = "postgresql://postgres:teste@127.0.0.1:55432/hub_test"
    python -m pytest tests

Sem TEST_DATABASE_URL os testes que usam banco são pulados.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))
sys.path.insert(0, str(RAIZ / "attended_worker"))

_URL = os.environ.get("TEST_DATABASE_URL", "")
if _URL:
    # trava de segurança: o banco é truncado, então o nome precisa dizer "test"
    if "test" not in _URL.rsplit("/", 1)[-1].lower():
        raise RuntimeError("TEST_DATABASE_URL precisa apontar para um banco com 'test' no nome")
    os.environ["DATABASE_URL"] = _URL

ESC_A = "esc-a"
ESC_B = "esc-b"
SENHA = "senha-de-teste-123"


@pytest.fixture(scope="session")
def _schema():
    if not _URL:
        pytest.skip("TEST_DATABASE_URL não definida")
    import admissoes
    import auth
    from rpa import core as rpa_core
    auth.garantir_schema()
    rpa_core.garantir_schema()
    admissoes.garantir_schema()
    return True


@pytest.fixture
def db(_schema):
    """Banco limpo com dois escritórios, uma empresa em cada e os usuários:
    dp_admin (admin do A), dp_user (usuário do A), agente (usuário do A,
    conta do robô), agente_b (usuário do B)."""
    import auth
    import clientes
    with auth.conectar() as conn:
        conn.execute("TRUNCATE admissoes_eventos, admissoes, admissoes_chaves, clientes, sessoes, usuarios, "
                     "escritorios RESTART IDENTITY CASCADE")
        conn.commit()
    auth.criar_escritorio("Escritório A", ESC_A)
    auth.criar_escritorio("Escritório B", ESC_B)
    clientes.criar_cliente(ESC_A, "Padaria Alfa", "101")
    clientes.criar_cliente(ESC_B, "Mercado Beta", "201")
    auth.criar_ou_atualizar_usuario("dp_admin", SENHA, ESC_A, auth.PAPEL_ADMIN_ESCRITORIO)
    auth.criar_ou_atualizar_usuario("dp_user", SENHA, ESC_A, auth.PAPEL_USUARIO)
    auth.criar_ou_atualizar_usuario("agente", SENHA, ESC_A, auth.PAPEL_USUARIO)
    auth.criar_ou_atualizar_usuario("agente_b", SENHA, ESC_B, auth.PAPEL_USUARIO)
    return True

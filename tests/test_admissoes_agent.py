"""Agente da sessão RDS (attended_worker/admissoes_agent.py): nesta versão
ele nunca grava nada e, sem liberação do Hub, se recusa a gravar."""

from __future__ import annotations

import pytest

import admissoes_agent as agente


@pytest.fixture
def chamadas(monkeypatch):
    feitas = []
    monkeypatch.setattr(agente.hub_api, "admissao_status",
                        lambda token, i, status, motivo="", protocolo="": feitas.append(("status", i, status, motivo, protocolo)))
    monkeypatch.setattr(agente.hub_api, "admissao_previa",
                        lambda token, i, previa: feitas.append(("previa", i, previa)))
    return feitas


def test_preparo_sem_integracao_bloqueia_sem_previa(chamadas):
    assert agente.processar("t", {"id": 1, "fase": "preparo"}) == "blocked"
    assert chamadas == [("status", 1, "blocked", agente.MOTIVO_SEM_INTEGRACAO, "")]


def test_gravacao_sem_liberacao_nao_grava(chamadas):
    assert agente.processar("t", {"id": 2, "fase": "gravacao", "liberado_para_gravar": False}) == "blocked"
    assert chamadas[0][2] == "blocked" and "aprovação" in chamadas[0][3]


def test_gravacao_liberada_ainda_nao_conclui_nesta_versao(chamadas):
    adm = {"id": 3, "fase": "gravacao", "liberado_para_gravar": True, "previa_aprovada": {"servico": 1}}
    assert agente.processar("t", adm) == "blocked"
    assert all(c[2] != "completed" for c in chamadas)


def test_previa_pronta_vai_para_aprovacao(chamadas, monkeypatch):
    monkeypatch.setattr(agente, "preparar", lambda a: ("previa", {"servico": 1}))
    assert agente.processar("t", {"id": 4, "fase": "preparo"}) == "awaiting_approval"
    assert chamadas == [("previa", 4, {"servico": 1})]

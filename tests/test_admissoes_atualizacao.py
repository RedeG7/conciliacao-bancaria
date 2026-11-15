"""Atualização do programa do agente ao abrir (attended_worker/gui_admissoes.py):
consulta o Hub antes da janela e troca o .exe no mesmo caminho."""

from __future__ import annotations

import pytest

import gui_admissoes as gui


@pytest.fixture
def exe(tmp_path):
    caminho = tmp_path / "admissoes_agente.exe"
    caminho.write_bytes(b"v1")
    return caminho


def test_versao_nova_troca_o_exe_no_mesmo_caminho(exe):
    avisos = []
    r = gui.atualizar_antes_de_abrir(exe, "1.2", consultar=lambda: "1.3", baixar=lambda: b"v2", aviso=avisos.append)
    assert r == "atualizado" and exe.read_bytes() == b"v2"
    assert (exe.parent / "admissoes_agente.exe.old").read_bytes() == b"v1"
    assert avisos == ["Verificando atualização no Hub...", "Baixando a versão 1.3..."]
    # na próxima abertura a sobra some
    gui.atualizar_antes_de_abrir(exe, "1.3", consultar=lambda: "1.3", baixar=lambda: b"x")
    assert not (exe.parent / "admissoes_agente.exe.old").exists()


def test_em_dia_ou_versao_menor_nao_baixa(exe):
    nunca = lambda: pytest.fail("não deveria baixar")  # noqa: E731
    assert gui.atualizar_antes_de_abrir(exe, "1.3", consultar=lambda: "1.3", baixar=nunca) == "em_dia"
    assert gui.atualizar_antes_de_abrir(exe, "1.10", consultar=lambda: "1.9", baixar=nunca) == "em_dia"
    assert exe.read_bytes() == b"v1"


def test_sem_hub_abre_a_versao_atual(exe):
    def falha():
        raise OSError("sem rede")
    assert gui.atualizar_antes_de_abrir(exe, "1.2", consultar=falha) == "sem_hub"
    # download que falha no meio também não estraga o .exe atual
    assert gui.atualizar_antes_de_abrir(exe, "1.2", consultar=lambda: "1.3", baixar=falha) == "sem_hub"
    assert exe.read_bytes() == b"v1"

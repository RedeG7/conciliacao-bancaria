"""Rotas de Admissões do api.py: chave dos canais, login do agente e a
trava de aprovação vista de fora (o agente nunca consegue aprovar)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import admissoes as adm
import auth
from conftest import ESC_A, ESC_B, SENHA

EVENTO = {"channel": "acessorias", "external_id": "AC-100", "company_ref": "101", "document_refs": ["ficha.pdf"]}


@pytest.fixture
def cli(db):
    import api
    return TestClient(api.app)


@pytest.fixture
def chave(db):
    return adm.gerar_chave_canal(ESC_A, "dp_admin")


def _token(cli, usuario="agente"):
    r = cli.post("/api/login", json={"usuario": usuario, "senha": SENHA})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_evento_exige_chave_valida(cli, chave):
    assert cli.post("/api/admissoes/eventos", json=EVENTO).status_code == 401
    assert cli.post("/api/admissoes/eventos", json=EVENTO, headers={"X-API-Key": "adm_errada"}).status_code == 401


def test_evento_cria_e_deduplica(cli, chave):
    h = {"X-API-Key": chave}
    r1 = cli.post("/api/admissoes/eventos", json=EVENTO, headers=h)
    r2 = cli.post("/api/admissoes/eventos", json=EVENTO, headers=h)
    assert r1.status_code == 202 and r1.json()["duplicate"] is False and r1.json()["status"] == "queued"
    assert r2.status_code == 202 and r2.json() == {**r1.json(), "duplicate": True}


def test_evento_valida_canal_e_tipo(cli, chave):
    h = {"X-API-Key": chave}
    assert cli.post("/api/admissoes/eventos", json={**EVENTO, "channel": "email"}, headers=h).status_code == 422
    assert cli.post("/api/admissoes/eventos", json={**EVENTO, "event_type": "termination"}, headers=h).status_code == 422


def test_chave_do_escritorio_a_so_cria_no_a(cli, chave):
    cli.post("/api/admissoes/eventos", json=EVENTO, headers={"X-API-Key": chave})
    assert len(adm.listar(ESC_A)) == 1 and adm.listar(ESC_B) == []


def test_agente_exige_login(cli):
    assert cli.post("/api/admissoes/agente/proxima").status_code == 401


def test_agente_sem_o_app_liberado_e_barrado(cli):
    with auth.conectar() as conn:
        conn.execute("UPDATE usuarios SET apps_permitidos = %s WHERE usuario = 'agente'", (["conciliacao"],))
        conn.commit()
    assert cli.post("/api/admissoes/agente/proxima", headers=_token(cli)).status_code == 403


def test_fluxo_completo_pela_api(cli, chave):
    cli.post("/api/admissoes/eventos", json=EVENTO, headers={"X-API-Key": chave})
    h = _token(cli)

    r = cli.post("/api/admissoes/agente/proxima", headers=h).json()["admissao"]
    assert r["fase"] == "preparo" and r["liberado_para_gravar"] is False and r["previa_aprovada"] is None
    assert cli.post("/api/admissoes/agente/proxima", headers=h).json()["admissao"] is None

    # no preparo o agente não consegue concluir
    c = cli.post(f"/api/admissoes/agente/{r['id']}/status", json={"status": "completed"}, headers=h)
    assert c.status_code == 409

    p = cli.post(f"/api/admissoes/agente/{r['id']}/previa", json={"previa": {"servico": 1}}, headers=h)
    assert p.status_code == 200 and p.json()["status"] == "awaiting_approval"

    # sem aprovação, nada a gravar
    assert cli.post("/api/admissoes/agente/proxima", headers=h).json()["admissao"] is None

    a = adm.obter(r["id"], ESC_A)
    adm.aprovar(r["id"], ESC_A, "dp_admin", auth.PAPEL_ADMIN_ESCRITORIO, a["previa_hash"])

    g = cli.post("/api/admissoes/agente/proxima", headers=h).json()["admissao"]
    assert g["fase"] == "gravacao" and g["liberado_para_gravar"] is True and g["previa_aprovada"] == {"servico": 1}
    fim = cli.post(f"/api/admissoes/agente/{g['id']}/status",
                   json={"status": "completed", "protocolo": "1.2.3"}, headers=h)
    assert fim.status_code == 200 and fim.json()["status"] == "completed"


def test_nao_existe_rota_de_aprovacao_na_api(cli):
    import api
    caminhos = {r.path for r in api.app.routes}
    assert not any("aprov" in c or "approv" in c or "rejeit" in c for c in caminhos)


def test_agente_de_outro_escritorio_recebe_404(cli, chave):
    cli.post("/api/admissoes/eventos", json=EVENTO, headers={"X-API-Key": chave})
    r = cli.post("/api/admissoes/agente/proxima", headers=_token(cli)).json()["admissao"]
    h_b = _token(cli, "agente_b")
    assert cli.post(f"/api/admissoes/agente/{r['id']}/status",
                    json={"status": "failed", "motivo": "x"}, headers=h_b).status_code == 404
    assert cli.post("/api/admissoes/agente/proxima", headers=h_b).json()["admissao"] is None

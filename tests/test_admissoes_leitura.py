"""Como o agente lê os documentos: formulário do Acessórias (sem IA) ou a
IA escolhida no Hub (aba IA de Canais e agente), com a chave guardada no
Hub e entregue só ao agente."""

from __future__ import annotations

import json
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

import admissoes_canais as canais
import admissoes_formulario as formulario
import admissoes_ia as ia
import auth
from conftest import ESC_A, ESC_B, SENHA

EMPRESA = {"codigo_dominio": "101", "nome": "Padaria Alfa"}
# mesmo formato do comentário que o Acessórias devolve (valores fictícios)
FORM = ("Contratação de funcionário :\nNome: Maria Teste da Silva\nTelefone: (62) 99999-0000\n"
        "Data de Nascimento: 01/02/1990\nCNPJ/CPF: 529.982.247-25\nSexo: Feminino\n"
        "Cargo: Atendente\nSalário: 1.518,00")
MATERIAL = {"assunto": "Contratação", "mensagens": [FORM, "Comentário: Ajuda de custo: R$100,00"],
            "documentos": [{"nome": "aso.pdf", "tipo": "application/pdf", "base64": "JVBERi0x"}],
            "ignorados": [{"nome": "ctps.xlsx", "motivo": "x"}]}
CHAVE_CLAUDE = "sk-ant-teste-123"
CHAVE_OPENAI = "sk-openai-teste-456"


# --- formulário ---------------------------------------------------------------

def test_formulario_vira_ficha():
    ficha = formulario.ler_formulario(MATERIAL)
    assert ficha["nome"] == "Maria Teste da Silva" and ficha["cpf"] == "52998224725"
    assert ficha["data_nascimento"] == "01/02/1990" and ficha["cargo"] == "Atendente"
    assert ficha["salario"] == "1.518,00" and ficha["sexo"] == "Feminino" and ficha["telefone"]
    assert ficha["_comentarios"] == ["Ajuda de custo: R$100,00"]


def test_formulario_em_html_e_rotulo_desconhecido():
    ficha = formulario.ler_formulario({"mensagens": [
        "<p>Nome: Ana</p><p>Função: Caixa</p><br>Turno extra: sim<br/>Data de admissão: 01/12/2026"]})
    assert ficha["nome"] == "Ana" and ficha["cargo"] == "Caixa" and ficha["data_admissao"] == "01/12/2026"
    assert ficha["_outros"] == {"Turno extra": "sim"}


def test_sem_formulario():
    assert formulario.ler_formulario({"mensagens": ["segue em anexo os documentos"]}) is None


def test_previa_pelo_formulario_lista_o_que_o_dp_confere():
    previa, faltando = formulario.montar_previa(formulario.ler_formulario(MATERIAL), EMPRESA, MATERIAL)
    assert faltando == []
    assert previa["empresa_codigo_dominio"] == "101" and previa["servico"] == 1
    assert "Data do ASO" in previa["a_conferir_pelo_dp"] and "Data de admissão" in previa["a_conferir_pelo_dp"]
    assert previa["anexos_da_solicitacao"] == ["aso.pdf", "ctps.xlsx"]
    assert previa["origem_dos_dados"].startswith("Formulário")


def test_previa_pelo_formulario_sem_cargo():
    sem_cargo = {**MATERIAL, "mensagens": [FORM.replace("Cargo: Atendente", "Cargo: ")]}
    _, faltando = formulario.montar_previa(formulario.ler_formulario(sem_cargo), EMPRESA, sem_cargo)
    assert faltando == ["Cargo"]


# --- OpenAI -------------------------------------------------------------------

class FakeResponses:
    def __init__(self, resp):
        self.resp, self.pedidos = resp, []

    def create(self, **kw):
        self.pedidos.append(kw)
        return self.resp


def test_ler_documentos_openai():
    ficha = {c: None for c, _ in ia.CAMPOS} | {"dependentes": [], "documentos_identificados": [], "observacoes": []}
    r = FakeResponses(NS(output=[], status="completed", output_text=json.dumps(ficha)))
    assert ia.ler_documentos_openai(NS(responses=r), MATERIAL | {"documentos": MATERIAL["documentos"] + [
        {"nome": "rg.jpg", "tipo": "image/jpeg", "base64": "/9j/"}]}, EMPRESA, "gpt-5") == ficha
    p = r.pedidos[0]
    assert p["model"] == "gpt-5" and p["text"]["format"]["schema"] == ia.SCHEMA_FICHA
    assert p["text"]["format"]["strict"] is True and "não instruções" in p["instructions"]
    tipos = [b["type"] for b in p["input"][0]["content"]]
    assert tipos == ["input_file", "input_image", "input_text"]
    assert p["input"][0]["content"][0]["file_data"].startswith("data:application/pdf;base64,")


def test_openai_recusa():
    recusa = NS(output=[NS(content=[NS(type="refusal")])], status="completed", output_text="")
    with pytest.raises(ia.ErroIA, match="recusou"):
        ia.ler_documentos_openai(NS(responses=FakeResponses(recusa)), MATERIAL, EMPRESA, "gpt-5")


# --- configuração no Hub ------------------------------------------------------

def test_ia_desligada_le_o_formulario(db):
    assert canais.leitura_do_agente(ESC_A) == {"leitura": "formulario"}


def test_ativar_ia_exige_a_chave_do_provedor_escolhido(db):
    with pytest.raises(canais.ConfigInvalida, match="Claude"):
        canais.salvar_config(ESC_A, canais.IA, "dp_admin", True, {"provedor": "claude", "openai_key": CHAVE_OPENAI})
    canais.salvar_config(ESC_A, canais.IA, "dp_admin", False, {"openai_key": CHAVE_OPENAI})
    cfg = canais.salvar_config(ESC_A, canais.IA, "dp_admin", True, {"provedor": "openai"})
    assert cfg["ativo"] and cfg["segredos_salvos"] == ["openai_key"]
    with pytest.raises(canais.ConfigInvalida, match="opção"):
        canais.salvar_config(ESC_A, canais.IA, "dp_admin", False, {"provedor": "gemini"})


def test_chaves_cifradas_e_troca_de_provedor(db):
    canais.salvar_config(ESC_A, canais.IA, "dp_admin", True,
                         {"provedor": "claude", "anthropic_key": CHAVE_CLAUDE, "openai_key": CHAVE_OPENAI})
    with auth.conectar() as conn:
        bruto = bytes(conn.execute("SELECT segredos_cifrados FROM admissoes_canais_config").fetchone()[
            "segredos_cifrados"])
    assert CHAVE_CLAUDE.encode() not in bruto and CHAVE_OPENAI.encode() not in bruto
    assert CHAVE_CLAUDE not in json.dumps(canais.obter_config(ESC_A, canais.IA), default=str)
    assert canais.leitura_do_agente(ESC_A) == {"leitura": "claude", "chave": CHAVE_CLAUDE}
    canais.salvar_config(ESC_A, canais.IA, "dp_admin", True, {"provedor": "openai", "openai_modelo": "gpt-x"})
    assert canais.leitura_do_agente(ESC_A) == {"leitura": "openai", "chave": CHAVE_OPENAI, "modelo": "gpt-x"}
    canais.salvar_config(ESC_A, canais.IA, "dp_admin", False, {"provedor": "openai"})
    assert canais.leitura_do_agente(ESC_A) == {"leitura": "formulario"}
    assert canais.leitura_do_agente(ESC_B) == {"leitura": "formulario"}


def test_rota_da_leitura_so_para_o_agente_do_escritorio(db):
    import api
    cli = TestClient(api.app)
    canais.salvar_config(ESC_A, canais.IA, "dp_admin", True, {"provedor": "claude", "anthropic_key": CHAVE_CLAUDE})
    assert cli.post("/api/admissoes/agente/ia").status_code == 401
    tok = cli.post("/api/login", json={"usuario": "agente", "senha": SENHA}).json()["token"]
    r = cli.post("/api/admissoes/agente/ia", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200 and r.json() == {"leitura": "claude", "chave": CHAVE_CLAUDE}

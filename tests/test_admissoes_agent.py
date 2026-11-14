"""Agente da sessão RDS (attended_worker/admissoes_agent.py): preparo lê os
documentos e manda a prévia; gravação só com aprovação e, nesta versão,
só em modo conferência (nunca conclui/salva)."""

from __future__ import annotations

import pytest

import admissoes_agent as agente

EMPRESA = {"codigo_dominio": "101", "nome": "Padaria Alfa", "cnpj": "11222333000181"}
MATERIAL = {"assunto": "Admissão", "mensagens": ["segue"], "ignorados": [],
            "documentos": [{"nome": "ficha.pdf", "tipo": "application/pdf", "base64": "JVBERi0x"}]}
FICHA_OK = {
    "nome": "Maria Teste", "cpf": "52998224725", "data_nascimento": "01/02/1990",
    "data_admissao": "01/12/2026", "cargo": "Atendente", "salario": "1.518,00",
    "aso_data": "20/11/2026", "aso_medico_nome": "Dr. Fulano", "aso_medico_crm": "12345",
    "aso_medico_uf": "GO", "dependentes": [], "documentos_identificados": ["Ficha de admissão", "ASO"],
    "observacoes": [],
}


@pytest.fixture
def chamadas(monkeypatch):
    feitas = []
    monkeypatch.setattr(agente.hub_api, "admissao_status",
                        lambda token, i, status, motivo="", protocolo="": feitas.append(("status", i, status, motivo, protocolo)))
    monkeypatch.setattr(agente.hub_api, "admissao_previa",
                        lambda token, i, previa: feitas.append(("previa", i, previa)))
    monkeypatch.setattr(agente.hub_api, "admissao_material", lambda token, i: dict(MATERIAL))
    monkeypatch.setattr(agente.hub_api, "admissao_leitura", lambda token: {"leitura": "claude", "chave": "k"})
    return feitas


@pytest.fixture
def ctx(tmp_path):
    criados = []
    c = agente.Contexto(token="t", tela=object(), pasta=tmp_path, log=lambda m: None,
                        criar_ia=lambda leitura, chave: criados.append((leitura, chave)) or object())
    c.criados = criados
    return c


def _preparo(i=1, empresa=EMPRESA):
    return {"id": i, "fase": "preparo", "empresa": empresa}


def test_preparo_le_documentos_e_manda_previa(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.ia, "ler_documentos", lambda cli, mat, emp: dict(FICHA_OK))
    assert agente.processar(ctx, _preparo()) == "awaiting_approval"
    tipo, i, previa = chamadas[0]
    assert tipo == "previa" and i == 1
    assert previa["empresa_codigo_dominio"] == "101" and previa["servico"] == 1 and previa["cpf"] == "52998224725"


def test_preparo_com_dado_faltando_pede_documentos_sem_dado_pessoal(chamadas, ctx, monkeypatch):
    ficha = {**FICHA_OK, "aso_medico_crm": None, "cpf": "11111111111"}
    monkeypatch.setattr(agente.ia, "ler_documentos", lambda cli, mat, emp: ficha)
    assert agente.processar(ctx, _preparo()) == "awaiting_documents"
    _, _, status, motivo, _ = chamadas[0]
    assert status == "awaiting_documents" and "CRM do médico" in motivo and "CPF válido" in motivo
    assert "Maria" not in motivo and "11111111111" not in motivo


def test_ia_completa_com_o_formulario(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.ia, "ler_documentos", lambda cli, mat, emp: {**FICHA_OK, "cargo": ""})
    monkeypatch.setattr(agente.hub_api, "admissao_material",
                        lambda token, i: {**MATERIAL, "mensagens": ["Nome: Outro Nome" + chr(10) + "Cargo: Atendente"]})
    assert agente.processar(ctx, _preparo()) == "awaiting_approval"
    previa = chamadas[0][2]
    # só preenche o que a IA deixou vazio
    assert previa["cargo"] == "Atendente" and previa["nome"] == "Maria Teste"
    assert previa["campos_vindos_do_formulario"] == ["Cargo"]


def test_preparo_sem_documento_legivel(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.hub_api, "admissao_material",
                        lambda token, i: {**MATERIAL, "documentos": [], "ignorados": [{"nome": "a.xlsx"}]})
    assert agente.processar(ctx, _preparo()) == "awaiting_documents"
    assert "1 anexo" in chamadas[0][3]


def test_preparo_sem_empresa_vinculada_bloqueia(chamadas, ctx):
    assert agente.processar(ctx, _preparo(empresa=None)) == "blocked"
    assert "Empresa" in chamadas[0][3]


def test_preparo_pelo_formulario_sem_ia(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.hub_api, "admissao_leitura", lambda token: {"leitura": "formulario"})
    monkeypatch.setattr(agente.ia, "ler_documentos", lambda *a: pytest.fail("não deveria usar IA"))
    monkeypatch.setattr(agente.hub_api, "admissao_material", lambda token, i: {
        **MATERIAL, "mensagens": ["Nome: Maria Teste\nData de Nascimento: 01/02/1990\nCNPJ/CPF: 529.982.247-25\n"
                                  "Cargo: Atendente\nSalário: 1.518,00"]})
    assert agente.processar(ctx, _preparo()) == "awaiting_approval"
    previa = chamadas[0][2]
    assert previa["cpf"] == "52998224725" and "Data do ASO" in previa["a_conferir_pelo_dp"]
    assert ctx.criados == []


def test_formulario_ausente_pede_documentos(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.hub_api, "admissao_leitura", lambda token: {"leitura": "formulario"})
    assert agente.processar(ctx, _preparo()) == "awaiting_documents"
    assert "Formulário" in chamadas[0][3]


def test_preparo_com_openai(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.hub_api, "admissao_leitura",
                        lambda token: {"leitura": "openai", "chave": "sk-o", "modelo": "gpt-x"})
    usados = []
    monkeypatch.setattr(agente.ia, "ler_documentos_openai",
                        lambda cli, mat, emp, modelo: usados.append(modelo) or dict(FICHA_OK))
    assert agente.processar(ctx, _preparo()) == "awaiting_approval"
    assert usados == ["gpt-x"] and ctx.criados == [("openai", "sk-o")]


def test_cliente_da_ia_reaproveitado_e_trocado_com_a_chave(ctx):
    a = ctx.cliente({"leitura": "claude", "chave": "1"})
    assert ctx.cliente({"leitura": "claude", "chave": "1"}) is a
    ctx.cliente({"leitura": "claude", "chave": "2"})
    assert ctx.criados == [("claude", "1"), ("claude", "2")]


def test_erro_na_leitura_vira_falha(chamadas, ctx, monkeypatch):
    def falha(*a):
        raise agente.ia.ErroIA("API da Anthropic respondeu 529")
    monkeypatch.setattr(agente.ia, "ler_documentos", falha)
    assert agente.processar(ctx, _preparo()) == "failed"


def test_gravacao_sem_liberacao_nao_grava(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.ia, "operar_dominio", lambda *a, **k: pytest.fail("não deveria operar"))
    assert agente.processar(ctx, {"id": 2, "fase": "gravacao", "liberado_para_gravar": False}) == "blocked"
    assert chamadas[0][2] == "blocked" and "aprovação" in chamadas[0][3]


def test_gravacao_conferencia_preenche_e_nunca_conclui(chamadas, ctx, monkeypatch):
    usados = []

    def operar(cli, tela, previa, pasta, parar, log):
        usados.append((previa, pasta))
        return "preenchido", ""

    monkeypatch.setattr(agente.ia, "operar_dominio", operar)
    adm = {"id": 3, "fase": "gravacao", "liberado_para_gravar": True, "previa_aprovada": {"servico": 1}}
    assert agente.processar(ctx, adm) == "blocked"
    assert usados[0][0] == {"servico": 1} and usados[0][1].name == "admissao-3"
    assert chamadas == [("status", 3, "blocked", agente.MOTIVO_CONFERENCIA, "")]


def test_gravacao_bloqueada_no_dominio_repassa_o_motivo(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.ia, "operar_dominio", lambda *a: ("bloqueado", "empregado já cadastrado"))
    adm = {"id": 4, "fase": "gravacao", "liberado_para_gravar": True, "previa_aprovada": {"servico": 1}}
    agente.processar(ctx, adm)
    assert chamadas[0][3] == "empregado já cadastrado"


def test_gravacao_sem_claude_volta_para_o_dp(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.hub_api, "admissao_leitura", lambda token: {"leitura": "formulario"})
    monkeypatch.setattr(agente.ia, "operar_dominio", lambda *a, **k: pytest.fail("não deveria operar"))
    adm = {"id": 6, "fase": "gravacao", "liberado_para_gravar": True, "previa_aprovada": {"servico": 1}}
    assert agente.processar(ctx, adm) == "blocked"
    assert chamadas == [("status", 6, "blocked", agente.MOTIVO_SEM_CLAUDE, "")]


def test_outro_modo_nao_grava_nesta_versao(chamadas, ctx, monkeypatch):
    ctx.modo = "gravar"
    monkeypatch.setattr(agente.ia, "operar_dominio", lambda *a, **k: pytest.fail("não deveria operar"))
    adm = {"id": 5, "fase": "gravacao", "liberado_para_gravar": True, "previa_aprovada": {"servico": 1}}
    assert agente.processar(ctx, adm) == "blocked"


def test_rodar_uma_devolve_falha_se_estourar_erro(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.hub_api, "admissao_proxima", lambda token: _preparo(9))

    def explode(*a):
        raise KeyError("x")

    monkeypatch.setattr(agente.ia, "ler_documentos", explode)
    with pytest.raises(KeyError):
        agente.rodar_uma(ctx)
    assert chamadas[-1][:3] == ("status", 9, "failed")


def test_rodar_uma_fila_vazia(chamadas, ctx, monkeypatch):
    monkeypatch.setattr(agente.hub_api, "admissao_proxima", lambda token: None)
    assert agente.rodar_uma(ctx) is None and chamadas == []

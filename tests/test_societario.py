"""Testes do Hub Societário (societario.py): regras de alerta, licenças,
resumo do dia, filtros, Word, revisão da IA (com cliente falso) e, com
TEST_DATABASE_URL, o fluxo no banco (processo, andamento, lembrete,
licença, revisão) separado por escritório."""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from types import SimpleNamespace

import pytest

import societario as so

HOJE = date(2026, 11, 24)  # terça-feira


def _dt(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, 10, 0, tzinfo=so.FUSO)


def _proc(**kw):
    base = {"id": 1, "numero": "SOC-2026-00001", "tipo": "alteracao", "empresa_nome": "Empresa Alfa LTDA",
            "cnpj": "11222333000181", "responsavel": "ana", "prioridade": "normal", "etapa": so.EM_ELABORACAO,
            "orgao": "Junta Comercial (JUCEG)", "protocolo": None, "descricao": "Saída de sócio",
            "previsao": HOJE + timedelta(days=20), "proxima_verificacao": None, "proxima_acao": None,
            "criado_em": _dt(HOJE - timedelta(days=1)), "ultima_movimentacao": _dt(HOJE - timedelta(days=1))}
    base.update(kw)
    return base


def test_versao_bate_com_as_novidades():
    assert so.NOVIDADES[0][0] == so.VERSAO
    versoes = [tuple(int(x) for x in v.split(".")) for v, _, _ in so.NOVIDADES]
    assert versoes == sorted(versoes, reverse=True) and len(set(versoes)) == len(versoes)


def test_cadastros_coerentes():
    for t in so.TIPOS.values():
        assert t["checklist"] and t["orgao"] in so.ORGAOS
    assert set(so.ETAPAS_KANBAN) <= set(so.ETAPAS)
    assert so.numero_processo(2026, 48) == "SOC-2026-00048"
    assert so.formatar_cnpj("11222333000181") == "11.222.333/0001-81"


def test_dias_uteis():
    sexta = date(2026, 11, 20)
    assert so.dias_uteis_entre(sexta, date(2026, 11, 23)) == 1  # sábado e domingo não contam
    assert so.dias_uteis_entre(sexta, date(2026, 11, 24)) == 2
    assert so.dias_uteis_entre(HOJE, HOJE) == 0


def test_processo_em_dia_sem_alerta():
    assert so.alertas_processo(_proc(), HOJE) == []


def test_exigencia_e_atraso_sao_criticos():
    al = so.alertas_processo(_proc(etapa=so.EM_EXIGENCIA, previsao=HOJE - timedelta(days=2)), HOJE)
    tipos = {a["tipo"]: a["nivel"] for a in al}
    assert tipos["exigencia"] == so.CRITICO and tipos["atrasado"] == so.CRITICO


def test_prazo_proximo_conforme_regras():
    assert [a["tipo"] for a in so.alertas_processo(_proc(previsao=HOJE + timedelta(days=3)), HOJE)] == ["prazo"]
    assert so.alertas_processo(_proc(previsao=HOJE + timedelta(days=6)), HOJE) == []
    # regra do escritório: avisa a partir de 10 dias
    assert so.alertas_processo(_proc(previsao=HOJE + timedelta(days=6)), HOJE, {"prazo_avisos": [10, 2]})


def test_protocolado_verificar_a_cada_dois_dias_uteis():
    p = _proc(etapa=so.PROTOCOLADO, ultima_movimentacao=_dt(date(2026, 11, 20)))  # sexta
    assert so.alertas_processo(p, date(2026, 11, 23)) == []  # segunda: 1 dia útil
    assert [a["tipo"] for a in so.alertas_processo(p, HOJE)] == ["protocolo"]


def test_verificacao_marcada_e_parado():
    p = _proc(proxima_verificacao=HOJE, proxima_acao="Ligar na Junta")
    al = so.alertas_processo(p, HOJE)
    assert al[0]["tipo"] == "verificar" and "Ligar na Junta" in al[0]["texto"]
    parado = so.alertas_processo(_proc(ultima_movimentacao=_dt(HOJE - timedelta(days=5))), HOJE)
    assert [a["tipo"] for a in parado] == ["parado"]


def test_encerrado_nao_alerta():
    p = _proc(etapa=so.CONCLUIDO, previsao=HOJE - timedelta(days=30), ultima_movimentacao=_dt(HOJE - timedelta(days=40)))
    assert so.alertas_processo(p, HOJE) == []


def test_licencas():
    assert so.situacao_licenca(None, HOJE) == so.SEM_VALIDADE
    assert so.situacao_licenca(HOJE - timedelta(days=1), HOJE) == so.VENCIDA
    assert so.situacao_licenca(HOJE + timedelta(days=21), HOJE) == so.A_VENCER
    assert so.situacao_licenca(HOJE + timedelta(days=200), HOJE) == so.VIGENTE
    lic = {"id": 9, "tipo": "alvara", "empresa_nome": "Beta", "validade": HOJE + timedelta(days=5)}
    al = so.alertas_licenca(lic, HOJE)
    assert al and al[0]["nivel"] == so.CRITICO  # dentro do menor aviso (7 dias)
    assert so.alertas_licenca({**lic, "validade": HOJE + timedelta(days=60)}, HOJE)[0]["nivel"] == so.ATENCAO
    assert so.alertas_licenca({**lic, "validade": HOJE + timedelta(days=120)}, HOJE) == []
    # com renovação aberta, a licença para de alertar
    assert so.alertas_licenca({**lic, "processo_renovacao_id": 3}, HOJE) == []


def test_painel_indicadores_e_resumo():
    procs = [_proc(id=1, etapa=so.EM_EXIGENCIA), _proc(id=2, etapa=so.CONCLUIDO, tipo="alvara"),
             _proc(id=3, etapa=so.PROTOCOLADO, responsavel="bruno"), _proc(id=4, etapa=so.CANCELADO)]
    lics = [{"id": 1, "tipo": "bombeiros", "empresa_nome": "Beta", "validade": HOJE - timedelta(days=4),
             "responsavel": "ana"}]
    painel = so.painel_alertas(procs, lics, HOJE)
    assert painel[0]["nivel"] == so.CRITICO
    ind = so.indicadores(procs, HOJE)
    assert (ind["total"], ind["andamento"], ind["pendencias"], ind["concluidos"]) == (3, 2, 1, 1)
    res = so.resumo_do_dia(procs, lics, 2, HOJE, usuario="ana")
    chaves = {k: n for k, _, n in res["itens"]}
    assert chaves["exigencia"] == 1 and chaves["licenca"] == 1 and chaves["revisao"] == 2
    assert "protocolo" not in chaves  # o protocolado é do bruno
    assert res["prioridade"].startswith("resolver as exigências")


def test_filtrar():
    procs = [_proc(id=1), _proc(id=2, empresa_nome="Padaria Gama", cnpj="99888777000166", tipo="alvara",
                                responsavel="bruno", protocolo="GOJ2600012345")]
    assert [p["id"] for p in so.filtrar(procs, busca="padaria")] == [2]
    assert [p["id"] for p in so.filtrar(procs, busca="99.888")] == [2]
    assert [p["id"] for p in so.filtrar(procs, busca="GOJ26")] == [2]
    assert [p["id"] for p in so.filtrar(procs, tipos=["alteracao"])] == [1]
    assert [p["id"] for p in so.filtrar(procs, responsavel="bruno")] == [2]


def test_regras_do_escritorio_por_cima_das_padrao():
    rg = so.regras({"sem_movimentacao_dias": 7, "desconhecida": 1, "prazo_avisos": []})
    assert rg["sem_movimentacao_dias"] == 7 and rg["prazo_avisos"] == so.REGRAS_PADRAO["prazo_avisos"]
    assert "desconhecida" not in rg


def test_word_ida_e_volta():
    texto = "CLÁUSULA TERCEIRA – Capital social\nO capital social será de R$ 100.000,00 & <quotas>."
    docx = so.gerar_docx(texto)
    assert so.extrair_texto("minuta.docx", docx) == texto
    assert so.extrair_texto("a.txt", "Sócio A: R$ 60.000,00".encode("cp1252")) == "Sócio A: R$ 60.000,00"
    with pytest.raises(ValueError):
        so.extrair_texto("a.xls", b"x")


def test_normalizar_e_aplicar_sugestoes():
    res = so.normalizar_revisao({"resumo": "ok", "apontamentos": [
        {"categoria": "ortografia", "gravidade": "baixa", "titulo": "Erro", "trecho": "sosio", "problema": "p",
         "sugestao": "sócio", "acao": "substituir", "texto_novo": "sócio", "fundamento": ""},
        {"categoria": "inventada", "gravidade": "alta", "titulo": "Capital", "trecho": "R$ 90.000,00",
         "problema": "p", "sugestao": "R$ 100.000,00", "acao": "substituir", "texto_novo": "R$ 100.000,00", "fundamento": "CC art. 1.055"},
        {"categoria": "ausente", "gravidade": "media", "titulo": "Foro", "trecho": "", "problema": "p",
         "sugestao": "Fica eleito o foro…", "acao": "substituir", "texto_novo": "Fica eleito o foro…", "fundamento": ""},
    ]})
    aps = res["apontamentos"]
    assert [a["gravidade"] for a in aps] == ["alta", "media", "baixa"]  # mais grave primeiro
    assert aps[0]["categoria"] == "outro" and all(a["status"] == "pendente" for a in aps)
    for a in aps:
        a["status"] = "aceito" if a["titulo"] != "Erro" else "recusado"
    novo, manuais = so.aplicar_sugestoes("O sosio integraliza R$ 90.000,00.", aps)
    assert novo == "O sosio integraliza R$ 100.000,00."  # recusado não muda
    assert [a["titulo"] for a in manuais] == ["Foro"]


class _StreamFalso:
    def __init__(self, resp, pedidos, kw):
        self.resp, pedidos_ = resp, pedidos
        pedidos_.append(kw)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.resp


def _cliente_falso(resp):
    pedidos = []
    msgs = SimpleNamespace(stream=lambda **kw: _StreamFalso(resp, pedidos, kw))
    return SimpleNamespace(beta=SimpleNamespace(messages=msgs)), pedidos


def test_revisar_minuta_com_cliente_falso():
    pytest.importorskip("anthropic")
    saida = {"resumo": "Capital não fecha.", "apontamentos": [
        {"categoria": "capital", "gravidade": "alta", "titulo": "Quotas × capital", "trecho": "R$ 30.000,00",
         "problema": "Soma 90 mil, capital 100 mil.", "sugestao": "R$ 40.000,00", "acao": "substituir", "texto_novo": "R$ 40.000,00", "fundamento": "CC art. 1.055"}]}
    resp = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(saida))])
    cliente, pedidos = _cliente_falso(resp)
    res = so.revisar_minuta("Sócio A: R$ 60.000,00\nSócio B: R$ 30.000,00", "", "alteracao", "ctx", cliente=cliente)
    assert res["apontamentos"][0]["categoria"] == "capital"
    kw = pedidos[0]
    assert kw["model"] == so.MODELO_IA and kw["output_config"]["format"]["schema"] == so.SCHEMA_REVISAO
    assert "<documento>" in kw["messages"][0]["content"] and "Alteração contratual" in kw["messages"][0]["content"]
    recusa = SimpleNamespace(stop_reason="refusal", content=[])
    with pytest.raises(so.ErroIA):
        so.revisar_minuta("texto", "", cliente=_cliente_falso(recusa)[0])
    with pytest.raises(so.ErroIA):
        so.revisar_minuta("   ", "chave")


# ---------------------------------------------------------------- banco


@pytest.fixture
def banco(db):
    import auth
    so.garantir_schema()
    with auth.conectar() as conn:
        conn.execute("TRUNCATE soc_empresas, soc_revisoes, soc_lembretes, soc_anexos, soc_checklist, soc_andamentos, soc_licencas, "
                     "soc_processos, soc_sequencia, soc_config RESTART IDENTITY CASCADE")
        conn.commit()
    return True


def test_fluxo_do_processo_no_banco(banco):
    from conftest import ESC_A, ESC_B
    p = so.criar_processo(ESC_A, "dp_admin", "alteracao", "Empresa Alfa LTDA", "11.222.333/0001-81",
                          responsavel="dp_user", descricao="Saída do sócio B")
    p2 = so.criar_processo(ESC_A, "dp_admin", "alvara", "Padaria Gama")
    pb = so.criar_processo(ESC_B, "agente_b", "baixa", "Mercado Beta")
    ano = datetime.now(so.FUSO).year
    assert (p["numero"], p2["numero"], pb["numero"]) == (f"SOC-{ano}-00001", f"SOC-{ano}-00002", f"SOC-{ano}-00001")
    assert p["cnpj"] == "11222333000181" and p["orgao"] == "Junta Comercial (JUCEG)"

    d = so.obter_processo(ESC_A, p["id"])
    assert len(d["checklist"]) == len(so.TIPOS["alteracao"]["checklist"])
    assert d["andamentos"][0]["titulo"] == "Abertura do processo"
    assert so.obter_processo(ESC_B, p["id"]) is None  # outro escritório não vê

    amanha = datetime.now(so.FUSO).date() + timedelta(days=1)
    so.registrar_andamento(ESC_A, p["id"], "dp_user", "Protocolado na JUCEG", etapa=so.PROTOCOLADO,
                           protocolo="GOJ2600012345", proxima_acao="Verificar retorno", proxima_verificacao=amanha)
    so.marcar_item(ESC_A, d["checklist"][0]["id"], "dp_user", True)
    d = so.obter_processo(ESC_A, p["id"])
    assert d["etapa"] == so.PROTOCOLADO and d["protocolo"] == "GOJ2600012345"
    assert d["andamentos"][1]["etapa_antes"] == so.A_INICIAR and d["andamentos"][1]["etapa_depois"] == so.PROTOCOLADO
    assert d["checklist"][0]["feito"] and d["checklist"][0]["feito_por"] == "dp_user"
    lemb = d["lembretes"][0]
    assert lemb["usuario"] == "dp_user" and lemb["texto"] == "Verificar retorno"

    # o lembrete só aparece no pop-up quando a hora chega
    assert so.lembretes_vencidos(ESC_A, "dp_user") == []
    depois = datetime.combine(amanha, datetime.min.time(), so.FUSO) + timedelta(hours=9)
    assert [l["id"] for l in so.lembretes_vencidos(ESC_A, "dp_user", depois)] == [lemb["id"]]
    so.adiar_lembrete(ESC_A, lemb["id"], depois + timedelta(hours=1))
    assert so.lembretes_vencidos(ESC_A, "dp_user", depois) == []
    so.concluir_lembrete(ESC_A, lemb["id"])
    assert so.listar_lembretes(ESC_A, "dp_user") == []

    # concluir o processo cancela os lembretes pendentes e limpa a próxima verificação
    so.criar_lembrete(ESC_A, "dp_user", depois, "outro", "dp_admin", p["id"])
    so.registrar_andamento(ESC_A, p["id"], "dp_user", "", etapa=so.CONCLUIDO)
    d = so.obter_processo(ESC_A, p["id"])
    assert d["concluido_em"] and d["proxima_verificacao"] is None
    assert all(l["status"] != "pendente" for l in d["lembretes"])

    so.atualizar_dados(ESC_A, p2["id"], "dp_admin", prioridade="urgente", responsavel="dp_user")
    d2 = so.obter_processo(ESC_A, p2["id"])
    assert d2["prioridade"] == "urgente" and d2["andamentos"][-1]["titulo"] == "Dados do processo alterados"
    assert {x["id"] for x in so.listar_processos(ESC_A)} == {p["id"], p2["id"]}


def test_licenca_e_renovacao(banco):
    from conftest import ESC_A
    lid = so.salvar_licenca(ESC_A, "dp_admin", {"empresa_nome": "Padaria Gama", "tipo": "bombeiros",
                                                 "validade": date(2026, 12, 1), "responsavel": "dp_user",
                                                 "numero": "CERCON 123"})
    p = so.abrir_renovacao(ESC_A, lid, "dp_admin")
    assert p["tipo"] == "bombeiros" and p["licenca_id"] == lid and p["responsavel"] == "dp_user"
    lic = so.listar_licencas(ESC_A)[0]
    assert lic["processo_renovacao_id"] == p["id"] and lic["renovacao_numero"] == p["numero"]
    with pytest.raises(ValueError):
        so.abrir_renovacao(ESC_A, lid, "dp_admin")
    so.arquivar_licenca(ESC_A, lid)
    assert so.listar_licencas(ESC_A) == []


def test_revisao_finalizada_vira_anexo(banco):
    from conftest import ESC_A
    p = so.criar_processo(ESC_A, "dp_admin", "alteracao", "Empresa Alfa LTDA")
    texto = "Sócio A: R$ 60.000,00\nSócio B: R$ 30.000,00"
    rid = so.criar_revisao(ESC_A, "dp_admin", "Alteração.docx", texto, p["id"])
    so.gravar_resultado(ESC_A, rid, so.normalizar_revisao({"resumo": "x", "apontamentos": [
        {"categoria": "capital", "gravidade": "alta", "titulo": "Quotas", "trecho": "R$ 30.000,00",
         "problema": "p", "sugestao": "R$ 40.000,00", "acao": "substituir", "texto_novo": "R$ 40.000,00", "fundamento": "f"}]}))
    assert so.revisoes_pendentes(ESC_A) == 1
    so.decidir_apontamento(ESC_A, rid, 1, "aceito")
    out = so.finalizar_revisao(ESC_A, rid, "dp_admin")
    assert "R$ 40.000,00" in out["texto"] and out["aceitos"] == 1
    assert so.obter_revisao(ESC_A, rid)["texto_original"] == texto  # original intacto
    d = so.obter_processo(ESC_A, p["id"])
    an = [a for a in d["anexos"] if a["categoria"] == "minuta_revisada"]
    assert an and so.extrair_texto(an[0]["nome"], so.baixar_anexo(ESC_A, an[0]["id"])["conteudo"]) == out["texto"]
    assert so.revisoes_pendentes(ESC_A) == 0
    assert any(a["titulo"] == "Revisão validada pelo responsável" for a in d["andamentos"])


def test_regras_salvas(banco):
    from conftest import ESC_A
    rg = so.salvar_regras(ESC_A, "dp_admin", {"sem_movimentacao_dias": 5, "protocolado_dias_uteis": 3,
                                              "prazo_avisos": "7, 2", "licenca_avisos": "60,30"})
    assert so.obter_regras(ESC_A) == rg and rg["prazo_avisos"] == [7, 2] and rg["licenca_avisos"] == [60, 30]


# ---------------------------------------------------------------- 1.1: empresas, protocolos, relatórios


def test_somar_dias_uteis():
    sexta = date(2026, 11, 27)
    assert so.somar_dias_uteis(sexta, 2) == date(2026, 12, 1)  # pula o fim de semana
    assert so.dias_uteis_entre(sexta, so.somar_dias_uteis(sexta, 2)) == 2
    assert so.somar_dias_uteis(sexta, 0) == sexta


def test_tipo_andamento():
    assert so.tipo_andamento({"titulo": "Abertura do processo"}) == "abertura"
    assert so.tipo_andamento({"titulo": "Revisão por inteligência artificial"}) == "ia"
    assert so.tipo_andamento({"titulo": "Revisão validada pelo responsável"}) == "ia"
    assert so.tipo_andamento({"titulo": "x", "etapa_depois": so.CONCLUIDO}) == "concluido"
    assert so.tipo_andamento({"titulo": "Exigência da Junta"}) == "exigencia"
    assert so.tipo_andamento({"titulo": "Protocolado", "protocolo": "GO1"}) == "protocolo"
    assert so.tipo_andamento({"titulo": "Documento anexado", "anexo_id": 3}) == "anexo"
    assert so.tipo_andamento({"titulo": "x", "etapa_depois": so.EM_ANALISE}) == "etapa"
    assert so.tipo_andamento({"titulo": "Dados do processo alterados"}) == "dados"
    assert so.tipo_andamento({"titulo": "Liguei para o cliente"}) == "nota"


def test_resumo_empresas():
    procs = [_proc(id=1, numero="SOC-2026-00001", cnpj="11222333000181"),
             _proc(id=2, numero="SOC-2026-00002", cnpj="11.222.333/0001-81", etapa=so.CONCLUIDO),
             _proc(id=3, numero="SOC-2026-00003", cnpj="", empresa_nome="Padaria  Pão Quente"),
             _proc(id=4, numero="SOC-2026-00004", cnpj="", empresa_nome="padaria pao quente", etapa=so.EM_EXIGENCIA),
             _proc(id=5, numero="SOC-2026-00005", cnpj="99888777000166", etapa=so.CANCELADO)]
    lics = [{"id": 9, "empresa_nome": "Empresa Alfa", "cnpj": "11222333000181", "tipo": "alvara",
             "validade": HOJE + timedelta(days=400)},
            # sem CNPJ, mas com o mesmo nome de uma empresa que tem: entra nela
            {"id": 10, "empresa_nome": "EMPRESA ALFA LTDA", "cnpj": "", "tipo": "bombeiros",
             "validade": HOJE + timedelta(days=400)}]
    emps = so.resumo_empresas(procs, lics, HOJE)
    assert len(emps) == 2  # o cancelado não entra; mesma empresa por CNPJ ou pelo nome
    assert emps[0]["empresa"] == "Padaria  Pão Quente" and emps[0]["alertas"] >= 1  # com alerta, primeiro
    alfa = emps[1]
    assert alfa["cnpj"] == "11222333000181" and alfa["ativos"] == 1 and alfa["concluidos"] == 1
    assert [p["id"] for p in alfa["processos"]] == [2, 1] and [l["id"] for l in alfa["licencas"]] == [9, 10]


def test_painel_protocolos():
    antes = HOJE - timedelta(days=6)  # quarta-feira, 4 dias úteis antes de hoje
    procs = [_proc(id=1, numero="SOC-1", etapa=so.PROTOCOLADO, ultima_movimentacao=_dt(antes)),
             _proc(id=2, numero="SOC-2", etapa=so.EM_EXIGENCIA),
             _proc(id=3, numero="SOC-3", etapa=so.EM_ELABORACAO),
             _proc(id=4, numero="SOC-4", etapa=so.PROTOCOLADO, proxima_verificacao=HOJE + timedelta(days=3))]
    ands = [{"processo_id": 1, "criado_em": _dt(antes), "etapa_depois": so.PROTOCOLADO, "protocolo": "GO1"},
            {"processo_id": 4, "criado_em": _dt(HOJE), "etapa_depois": None, "protocolo": "GO4"}]
    lst = so.painel_protocolos(procs, ands, HOJE)
    assert [x["id"] for x in lst] == [2, 1, 4]
    um = lst[1]
    assert um["data_protocolo"] == antes and um["dias_uteis"] == 4 and um["verificar"]
    assert um["verificar_em"] == date(2026, 11, 20)
    assert lst[2]["verificar_em"] == HOJE + timedelta(days=3) and not lst[2]["verificar"]
    assert lst[2]["data_protocolo"] == HOJE


def test_relatorio_produtividade():
    d = lambda n: _dt(HOJE - timedelta(days=n))  # noqa: E731
    procs = [
        _proc(id=1, responsavel="ana", etapa=so.CONCLUIDO, criado_em=d(10), concluido_em=d(2),
              previsao=HOJE - timedelta(days=1)),
        _proc(id=2, responsavel="ana", etapa=so.CONCLUIDO, criado_em=d(40), concluido_em=d(35)),
        _proc(id=3, responsavel="bia", etapa=so.EM_ANALISE, criado_em=d(5), previsao=HOJE - timedelta(days=1)),
        _proc(id=4, responsavel="bia", etapa=so.A_INICIAR, criado_em=d(1)),
        _proc(id=5, responsavel="bia", etapa=so.CANCELADO, criado_em=d(3)),
    ]
    ands = [{"processo_id": 3, "usuario": "bia", "criado_em": d(4), "etapa_depois": so.EM_ANALISE},
            {"processo_id": 1, "usuario": "ana", "criado_em": d(2), "etapa_depois": so.CONCLUIDO},
            {"processo_id": 2, "usuario": "ana", "criado_em": d(50), "etapa_depois": None}]
    rel = so.relatorio_produtividade(procs, ands, HOJE - timedelta(days=29), HOJE, HOJE)
    assert rel["totais"] == {"abertos": 3, "concluidos": 1, "tempo_medio": 8.0, "no_prazo_pct": 100, "andamentos": 2}
    por = {r["responsavel"]: r for r in rel["pessoas"]}
    assert por["ana"]["concluidos"] == 1 and por["ana"]["tempo_medio"] == 8.0 and por["ana"]["ativos"] == 0
    assert por["bia"]["ativos"] == 2 and por["bia"]["atrasados"] == 1 and por["bia"]["andamentos"] == 1
    assert [g["etapa"] for g in rel["gargalos"]] == [so.EM_ANALISE, so.A_INICIAR]
    assert rel["gargalos"][0]["media_dias"] == 4 and rel["mais_parados"][0]["id"] == 3
    assert rel["por_tipo"] == [{"tipo": "Alteração contratual", "concluidos": 1, "tempo_medio": 8.0}]


def test_marcar_trechos():
    texto = "Sócio A: R$ 60\nSócio B: R$ 30"
    aps = [{"trecho": "R$ 30"}, {"trecho": "não existe"}, {"trecho": "Sócio B: R$ 30"}, {"trecho": "Sócio A"},
           {"trecho": ""}]
    partes = so.marcar_trechos(texto, aps)
    assert "".join(t for t, _ in partes) == texto
    assert [(t, i) for t, i in partes if i is not None] == [("Sócio A", 3), ("R$ 30", 0)]


def test_documentos_e_andamentos_no_banco(banco):
    from conftest import ESC_A, ESC_B
    p = so.criar_processo(ESC_A, "dp_admin", "alteracao", "Empresa Alfa LTDA", "11222333000181")
    pb = so.criar_processo(ESC_B, "agente_b", "baixa", "Mercado Beta")
    so.anexar(ESC_A, p["id"], "dp_admin", "minuta.docx", b"abc", categoria="minuta")
    so.anexar(ESC_A, p["id"], "dp_admin", "rg.pdf", b"x" * 10)
    so.anexar(ESC_B, pb["id"], "agente_b", "outro.pdf", b"y")
    docs = so.listar_anexos(ESC_A)
    assert [a["nome"] for a in docs] == ["rg.pdf", "minuta.docx"]
    assert docs[0]["numero"] == p["numero"] and docs[0]["empresa_nome"] == "Empresa Alfa LTDA"
    assert "conteudo" not in docs[0]
    assert {x["id"]: x["n_anexos"] for x in so.listar_processos(ESC_A)} == {p["id"]: 2}
    so.registrar_andamento(ESC_A, p["id"], "dp_user", "Protocolado", etapa=so.PROTOCOLADO, protocolo="GO1")
    ands = so.listar_andamentos(ESC_A)
    assert {a["processo_id"] for a in ands} == {p["id"]} and ands[-1]["protocolo"] == "GO1"
    assert so.listar_andamentos(ESC_A, datetime.now(so.FUSO).date() + timedelta(days=1)) == []


def test_tela_compila():
    # a tela não é exercitada pelos testes; ao menos não pode ter erro de sintaxe
    import pathlib
    import py_compile
    py_compile.compile(str(pathlib.Path(so.__file__).with_name("tela_societario.py")), doraise=True)


# ---------------------------------------------------------------- 1.2: cadastro e busca de empresas


def test_validar_documento():
    assert so.validar_documento("") == ""
    assert so.validar_documento("11.222.333/0001-81") == "11222333000181"
    assert so.validar_documento("529.982.247-25") == "52998224725"
    for ruim in ("11.222.333/0001-82", "111.111.111-11", "123"):
        with pytest.raises(ValueError):
            so.validar_documento(ruim)


def test_unir_empresas():
    proprias = [{"id": 1, "nome": "Nova Padaria (nome pretendido)", "cnpj": None},
                {"id": 2, "nome": "Alfa Comércio", "cnpj": "11222333000181"}]
    hub = [{"nome": "EMPRESA ALFA LTDA", "cnpj": "11222333000181"}, {"nome": "Beta S/A", "cnpj": ""}]
    acess = [{"razao": "Empresa Alfa Ltda", "fantasia": "Alfa", "cnpj": "11222333000181"},
             {"razao": "Gama ME", "fantasia": "Gama Pães", "cnpj": "99888777000166", "situacao": "Ativa"},
             {"razao": "", "fantasia": "", "cnpj": ""}]
    lista = so.unir_empresas(proprias, hub, acess)
    assert [e["nome"] for e in lista] == ["Alfa Comércio", "Beta S/A", "Gama ME", "Nova Padaria (nome pretendido)"]
    alfa = lista[0]
    assert alfa["origens"] == [so.ORIGEM_SOCIETARIO, so.ORIGEM_HUB, so.ORIGEM_ACESSORIAS]
    assert alfa["fantasia"] == "Alfa" and alfa["cadastro_id"] == 2
    assert lista[2]["fantasia"] == "Gama Pães" and lista[2]["origens"] == [so.ORIGEM_ACESSORIAS]
    assert so.rotulo_empresa(lista[3]).endswith("sem CNPJ · Cadastro do Societário")
    assert "11.222.333/0001-81" in so.rotulo_empresa(alfa)


def test_resumo_empresas_com_cadastradas():
    cad = [{"id": 1, "nome": "Nova Padaria", "cnpj": None, "contato": "João"},
           {"id": 2, "nome": "Empresa Alfa LTDA", "cnpj": "11222333000181"}]
    emps = so.resumo_empresas([_proc(id=1)], [], HOJE, cadastradas=cad)
    assert len(emps) == 2
    por_nome = {e["empresa"]: e for e in emps}
    assert por_nome["Nova Padaria"]["processos"] == [] and por_nome["Nova Padaria"]["cadastro"]["contato"] == "João"
    assert len(por_nome["Empresa Alfa LTDA"]["processos"]) == 1 and por_nome["Empresa Alfa LTDA"]["cadastro"]["id"] == 2


def test_cadastro_de_empresas_no_banco(banco):
    from conftest import ESC_A, ESC_B
    e = so.cadastrar_empresa(ESC_A, "dp_admin", "  Nova   Padaria ", "", "João", "62 99999-0000")
    assert e["nome"] == "Nova Padaria" and e["cnpj"] is None and e["contato"] == "João"
    a = so.cadastrar_empresa(ESC_A, "dp_admin", "Alfa", "11.222.333/0001-81")
    assert so.cadastrar_empresa(ESC_A, "dp_user", "Alfa de novo", "11222333000181")["id"] == a["id"]  # sem duplicar
    with pytest.raises(ValueError):
        so.cadastrar_empresa(ESC_A, "dp_admin", "", "")
    with pytest.raises(ValueError):
        so.cadastrar_empresa(ESC_A, "dp_admin", "X", "11.222.333/0001-82")
    so.cadastrar_empresa(ESC_B, "agente_b", "Alfa no outro escritório", "11222333000181")
    assert [x["nome"] for x in so.listar_empresas_cadastradas(ESC_A)] == ["Alfa", "Nova Padaria"]
    so.atualizar_empresa_cadastrada(ESC_A, e["id"], "Nova Padaria LTDA", "529.982.247-25", "Maria")
    with pytest.raises(ValueError):  # CNPJ de outra empresa cadastrada
        so.atualizar_empresa_cadastrada(ESC_A, e["id"], "Nova Padaria LTDA", "11222333000181")
    nova = [x for x in so.listar_empresas_cadastradas(ESC_A) if x["id"] == e["id"]][0]
    assert nova["nome"] == "Nova Padaria LTDA" and nova["cnpj"] == "52998224725" and nova["contato"] == "Maria"


def test_empresas_do_acessorias(banco):
    import obrigacoes
    from conftest import ESC_A
    obrigacoes.garantir_schema()
    with __import__("auth").conectar() as conn:
        conn.execute("DELETE FROM obr_empresas")
        conn.commit()

    class Falso:
        def empresas(self):
            return [{"id_externo": "7", "cnpj": "99888777000166", "razao": "Gama ME", "fantasia": "Gama",
                     "situacao": "Ativa", "regime": None, "raw": {"ID": 7}}]

    assert so.atualizar_empresas_acessorias(ESC_A, Falso()) == 1
    assert [e["razao"] for e in so.empresas_acessorias(ESC_A)] == ["Gama ME"]

    class Quebrado:
        def empresas(self):
            raise obrigacoes.ErroIntegracao("Acessórias recusou o token")

    with pytest.raises(ValueError, match="token"):
        so.atualizar_empresas_acessorias(ESC_A, Quebrado())


def test_proxima_verificacao_com_hora(banco):
    from conftest import ESC_A
    p = so.criar_processo(ESC_A, "dp_admin", "alteracao", "Empresa Hora LTDA", responsavel="dp_user")
    dia = datetime.now(so.FUSO).date() + timedelta(days=3)
    so.registrar_andamento(ESC_A, p["id"], "dp_user", "Protocolado", proxima_verificacao=dia,
                           hora_lembrete=time(14, 30))
    lemb = so.obter_processo(ESC_A, p["id"])["lembretes"][0]
    assert lemb["quando"].astimezone(so.FUSO).replace(tzinfo=None) == datetime.combine(dia, time(14, 30))
    # antes da hora não aparece; na hora, aparece no pop-up
    antes = datetime.combine(dia, time(14, 29), so.FUSO)
    assert so.lembretes_vencidos(ESC_A, "dp_user", antes) == []
    assert len(so.lembretes_vencidos(ESC_A, "dp_user", antes + timedelta(minutes=1))) == 1
    # sem hora, continua às 8h
    so.registrar_andamento(ESC_A, p["id"], "dp_user", "Outro", proxima_verificacao=dia)
    horas = sorted(l["quando"].astimezone(so.FUSO).time() for l in so.obter_processo(ESC_A, p["id"])["lembretes"])
    assert horas == [time(8, 0), time(14, 30)]


def test_anexos_para_revisao():
    t = lambda d: datetime(2026, 11, d, 10, 0, tzinfo=so.FUSO)  # noqa: E731
    anexos = [
        {"id": 1, "processo_id": 7, "nome": "minuta_v1.docx", "categoria": "minuta", "criado_em": t(1)},
        {"id": 2, "processo_id": 7, "nome": "minuta_v2.DOCX", "categoria": "minuta", "criado_em": t(5)},
        {"id": 3, "processo_id": 7, "nome": "rg_socio.jpg", "categoria": "documento", "criado_em": t(6)},
        {"id": 4, "processo_id": 7, "nome": "requerimento.pdf", "categoria": "documento", "criado_em": t(7)},
        {"id": 5, "processo_id": 7, "nome": "minuta_v2_revisada.docx", "categoria": "minuta_revisada",
         "criado_em": t(8)},
        {"id": 6, "processo_id": 9, "nome": "outro.docx", "categoria": "minuta", "criado_em": t(9)},
    ]
    # minuta mais nova primeiro; imagem, revisada e outro processo ficam de fora
    assert [a["id"] for a in so.anexos_para_revisao(anexos, 7)] == [2, 1, 4]
    assert [a["id"] for a in so.anexos_para_revisao(anexos, 7, incluir_revisadas=True)] == [2, 1, 4, 5]
    assert so.anexos_para_revisao(anexos, 99) == []


def test_revisao_do_word_sai_no_layout_original(banco, monkeypatch):
    from conftest import ESC_A
    import minuta_layout
    from test_minuta_layout import HEADER, _docx, _ler
    monkeypatch.setattr(minuta_layout, "docx_para_pdf", lambda dados: b"%PDF-fake")
    p = so.criar_processo(ESC_A, "dp_admin", "alteracao", "Empresa Alfa LTDA")
    original = _docx()
    texto = so.extrair_texto("Alteração.docx", original)
    rid = so.criar_revisao(ESC_A, "dp_admin", "Alteração.docx", texto, p["id"], "Alteração.docx", original)
    so.gravar_resultado(ESC_A, rid, so.normalizar_revisao({"resumo": "x", "apontamentos": [
        {"categoria": "capital", "gravidade": "alta", "titulo": "Quotas", "trecho": "R$ 30.000,00",
         "problema": "p", "sugestao": "R$ 40.000,00", "acao": "substituir", "texto_novo": "R$ 40.000,00", "fundamento": "f"}]}))
    so.decidir_apontamento(ESC_A, rid, 1, "aceito")
    out = so.finalizar_revisao(ESC_A, rid, "dp_admin")
    assert out["layout_original"] and not out["manuais"] and out["pdf"] == b"%PDF-fake"
    assert out["nome"] == "Alteração - revisada.docx" and out["nome_pdf"] == "Alteração - revisada.pdf"
    assert _ler(out["docx"], "word/header1.xml") == HEADER  # cabeçalho do original
    assert "R$ 40.000,00" in so.extrair_texto(out["nome"], out["docx"])
    nomes = sorted(a["nome"] for a in so.obter_processo(ESC_A, p["id"])["anexos"] if a["categoria"] == "minuta_revisada")
    assert nomes == ["Alteração - revisada.docx", "Alteração - revisada.pdf"]


def test_texto_colado_nao_guarda_arquivo(banco):
    from conftest import ESC_A
    rid = so.criar_revisao(ESC_A, "dp_admin", "Texto colado", "abc", None, "nota.txt", b"abc")
    assert so.obter_revisao(ESC_A, rid)["arquivo"] is None


def test_texto_aplicavel_separa_instrucao_do_texto():
    base = {"trecho": "x", "status": "aceito", "sugestao": "Explicação para o colaborador"}
    assert so.texto_aplicavel({**base, "acao": "substituir", "texto_novo": "R$ 1,00"}) == "R$ 1,00"
    assert so.texto_aplicavel({**base, "acao": "remover", "texto_novo": ""}) == ""
    assert so.texto_aplicavel({**base, "acao": "manual", "texto_novo": "algo"}) is None
    assert so.texto_aplicavel({**base, "acao": "incluir", "texto_novo": "Cláusula X"}) is None
    assert so.texto_aplicavel({**base, "acao": "substituir", "texto_novo": "CPF [informar]"}) is None
    assert so.texto_aplicavel({**base, "acao": "substituir", "texto_novo": "RG ________"}) is None
    assert so.texto_aplicavel({**base}) == "Explicação para o colaborador"  # revisão antiga
    aps = [{**base, "id": 1, "trecho": "Remover", "acao": "remover", "texto_novo": ""},
           {**base, "id": 2, "trecho": "valor", "acao": "manual", "texto_novo": ""}]
    novo, manuais = so.aplicar_sugestoes("Remover esta linha. O valor fica.", aps)
    assert novo == " esta linha. O valor fica." and [a["id"] for a in manuais] == [2]


def _docx_modelo() -> bytes:
    import io
    import zipfile
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document '
           'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
           '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>ALTERAÇÃO DE {{EMP</w:t></w:r><w:r><w:rPr><w:b/></w:rPr>'
           '<w:t>RESA}}</w:t></w:r></w:p>'
           '<w:p><w:r><w:t xml:space="preserve">CNPJ {{CNPJ}} · processo {{PROCESSO}} · {{EMPRESA}}</w:t></w:r></w:p>'
           '<w:p><w:r><w:t>Goiânia, {{DATA_EXTENSO}}.</w:t></w:r></w:p></w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", doc)
        z.writestr("word/header1.xml", '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                                       '<w:p><w:r><w:t>{{EMPRESA}}</w:t></w:r></w:p></w:hdr>')
    return buf.getvalue()


def test_modelos_por_tipo_e_padrao(banco):
    from conftest import ESC_A
    m1 = so.salvar_modelo(ESC_A, "dp_admin", "alteracao", "Saída de sócio", "saida.docx", _docx_modelo())
    m2 = so.salvar_modelo(ESC_A, "dp_admin", "alteracao", "", "Aumento de capital.docx", b"x" * 10)
    m3 = so.salvar_modelo(ESC_A, "dp_admin", "baixa", "Distrato", "distrato.pdf", b"%PDF")
    alt = so.listar_modelos(ESC_A, "alteracao")
    assert [m["id"] for m in alt] == [m1, m2] and alt[0]["padrao"] and not alt[1]["padrao"]  # 1º do tipo é o padrão
    assert alt[1]["nome"] == "Aumento de capital"
    so.definir_modelo_padrao(ESC_A, m2)
    assert [m["id"] for m in so.listar_modelos(ESC_A, "alteracao") if m["padrao"]] == [m2]
    so.remover_modelo(ESC_A, m2)  # era o padrão: o que sobrou vira padrão
    assert [(m["id"], m["padrao"]) for m in so.listar_modelos(ESC_A, "alteracao")] == [(m1, True)]
    assert [m["id"] for m in so.listar_modelos(ESC_A)] == [m1, m3]
    with pytest.raises(ValueError):
        so.salvar_modelo(ESC_A, "dp_admin", "alteracao", "x", "planilha.xlsx", b"x")


def test_modelo_anexado_ao_processo_com_campos_preenchidos(banco):
    import io
    import zipfile
    from conftest import ESC_A
    mid = so.salvar_modelo(ESC_A, "dp_admin", "alteracao", "Saída de sócio", "saida.docx", _docx_modelo())
    p = so.criar_processo(ESC_A, "dp_admin", "alteracao", "Empresa Alfa LTDA", "59838249000113")
    so.anexar_modelo(ESC_A, p["id"], "dp_admin", mid)
    d = so.obter_processo(ESC_A, p["id"])
    an = [a for a in d["anexos"] if a["categoria"] == "minuta"]
    assert an and an[0]["nome"] == "Saída de sócio - Empresa Alfa LTDA.docx"
    dados = so.baixar_anexo(ESC_A, an[0]["id"])["conteudo"]
    texto = so.extrair_texto("m.docx", dados)
    assert texto.startswith("ALTERAÇÃO DE Empresa Alfa LTDA\nCNPJ 59.838.249/0001-13 · processo " + p["numero"])
    assert "{{" not in texto and " de 20" in texto
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        assert b"Empresa Alfa LTDA" in z.read("word/header1.xml")
        assert b"<w:b/></w:rPr><w:t" in z.read("word/document.xml")  # negrito do título mantido
    assert any(a["titulo"] == "Modelo do contrato anexado" for a in d["andamentos"])


def test_marcar_trechos_erro_repetido_marca_as_duas_ocorrencias():
    texto = "sem autorização do outro sócio. Depois: sem autorização do outro sócio."
    aps = [{"trecho": "do outro sócio"}, {"trecho": "do outro sócio"}]
    marcados = [(t, i) for t, i in so.marcar_trechos(texto, aps) if i is not None]
    assert marcados == [("do outro sócio", 0), ("do outro sócio", 1)]


def test_extrair_texto_pdf_le_como_o_pymupdf():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    doc.new_page().insert_text((72, 100), "cinquenta mil quotas", fontsize=12)
    assert so.extrair_texto("minuta.pdf", doc.tobytes()) == "cinquenta mil quotas"


def test_gerar_contrato_no_modelo_com_cliente_falso(banco, monkeypatch):
    pytest.importorskip("anthropic")
    from conftest import ESC_A
    from test_minuta_layout import _modelo_docx
    p = so.criar_processo(ESC_A, "dp_admin", "alteracao", "Dominio LTDA", "59838249000113")
    so.salvar_modelo(ESC_A, "dp_admin", "alteracao", "Modelo CWD", "modelo.docx", _modelo_docx())
    mid = so.listar_modelos(ESC_A)[0]["id"]
    saida = {"resumo": "Jessika sai e Thiago entra.", "pendencias": ["RG do Thiago"], "blocos": [
        {"tipo": "titulo", "texto": "ALTERAÇÃO – DOMINIO LTDA", "linhas": []},
        {"tipo": "paragrafo", "texto": "THIAGO, RG [informar: RG], ingressa.", "linhas": []},
        {"tipo": "tabela", "texto": "", "linhas": [["SÓCIO", "QUOTAS"], ["THIAGO", "50.000"]]},
        {"tipo": "inventado", "texto": "vira parágrafo", "linhas": [["x"]]}]}
    resp = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(saida))])
    cliente, pedidos = _cliente_falso(resp)
    monkeypatch.setattr(so.minuta_layout, "docx_para_pdf", lambda d: b"%PDF-falso")
    res = so.gerar_contrato(ESC_A, p["id"], "dp_admin", mid, "Sai a Jessika, entra o Thiago", "contrato.txt",
                            "Contrato social: JESSIKA sócia única.".encode(), "", cliente=cliente,
                            hoje=date(2026, 11, 26))
    kw = pedidos[0]
    assert kw["output_config"]["format"]["schema"] == so.SCHEMA_CONTRATO and kw["system"] == so.SISTEMA_CONTRATO
    msg = kw["messages"][0]["content"]
    assert "<pedido>\nSai a Jessika, entra o Thiago" in msg and "JESSIKA sócia única" in msg
    assert "26 de novembro de 2026" in msg and "59.838.249/0001-13" in msg
    assert res["pendencias"] == ["RG do Thiago"] and res["blocos"][-1]["tipo"] == "paragrafo"
    assert res["blocos"][-1]["linhas"] == [] and res["pdf"] == b"%PDF-falso"
    assert "THIAGO | 50.000" in res["texto"]
    nomes = {a["nome"] for a in so.listar_anexos(ESC_A)}
    assert {"Modelo CWD - Dominio LTDA - gerado pela IA.docx", "Modelo CWD - Dominio LTDA - gerado pela IA.pdf"} <= nomes
    with pytest.raises(ValueError):
        so.gerar_contrato(ESC_A, p["id"], "dp_admin", mid, "  ", "c.txt", b"x", "", cliente=cliente)
    so.salvar_modelo(ESC_A, "dp_admin", "alteracao", "Modelo PDF", "modelo.pdf", b"%PDF")
    mid_pdf = next(m["id"] for m in so.listar_modelos(ESC_A) if m["arquivo_nome"] == "modelo.pdf")
    with pytest.raises(ValueError, match="Word"):
        so.gerar_contrato(ESC_A, p["id"], "dp_admin", mid_pdf, "pedido", "c.txt", b"x", "", cliente=cliente)

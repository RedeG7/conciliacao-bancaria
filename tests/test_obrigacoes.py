"""Testes do Controle de Obrigações (obrigacoes.py) sem banco e sem o
Acessórias: regras de situação/envio, normalização da resposta da API,
indicadores, alertas, relatórios e o conector (com urlopen falso)."""

from __future__ import annotations

import io
import json
import urllib.error
from datetime import date, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

import obrigacoes as ob

HOJE = date(2026, 11, 23)

# formato documentado em https://api.acessorias.com/documentation (Deliveries)
EMPRESA = {"ID": "7", "Identificador": "11.222.333/0001-81", "Razao": "Empresa Alfa Ltda", "Fantasia": "Alfa"}


def _ent(**kw):
    base = {"Nome": "DAS Simples Nacional", "EntCompetencia": "10/2026", "EntDtPrazo": "2026-11-20",
            "EntDtAtraso": "2026-11-21", "EntDtEntrega": "0000-00-00", "EntMulta": "S", "Status": "Pendente",
            "EntGuiaLida": "", "EntLastDH": "2026-11-19 16:02:26", "RespEntrega": "",
            "Config": {"EntID": "555", "Tipo": "O", "ID": "12", "DptoID": "2", "DptoNome": "Fiscal",
                       "RespPrazo": "Ana Paula", "RespPrazoID": "17", "RespEntrega": None, "RespEntregaID": None,
                       "RespPrazoEmail": "ana@x.com", "RespEntregaEmail": None}}
    cfg = kw.pop("Config", None)
    base.update(kw)
    if cfg:
        base["Config"] = {**base["Config"], **cfg}
    return base


def test_versao_bate_com_as_novidades():
    assert ob.NOVIDADES[0][0] == ob.VERSAO
    versoes = [tuple(int(x) for x in v.split(".")) for v, _, _ in ob.NOVIDADES]
    assert versoes == sorted(versoes, reverse=True) and len(set(versoes)) == len(versoes)


def test_ler_datas():
    assert ob.ler_data("0000-00-00") is None and ob.ler_data("") is None and ob.ler_data("lixo") is None
    assert ob.ler_data("2026-11-20") == date(2026, 11, 20)
    assert ob.ler_data("20/11/2026") == date(2026, 11, 20)
    assert ob.ler_data_hora("04/08/2022 14:30:00").hour == 14
    assert ob.somar_meses(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert ob.janela_sincronizacao(HOJE, 3, 2) == (date(2026, 8, 1), date(2027, 1, 31))


@pytest.mark.parametrize("prazo,entrega,status,esperado", [
    (date(2026, 11, 30), None, "Pendente", ob.PENDENTE),
    (date(2026, 11, 20), None, "Pendente", ob.ATRASADA),
    (date(2026, 11, 20), date(2026, 11, 19), "Ent. antecipada", ob.CONCLUIDA_PRAZO),
    (date(2026, 11, 20), date(2026, 11, 20), "Entregue", ob.CONCLUIDA_PRAZO),
    (date(2026, 11, 20), date(2026, 11, 22), "Entregue", ob.CONCLUIDA_ATRASO),
    (None, None, "Pendente", ob.NAO_IDENTIFICADA),  # sem prazo não conta atraso
    (date(2026, 11, 1), None, "Dispensada", ob.DISPENSADA),
])
def test_situacao(prazo, entrega, status, esperado):
    assert ob.situacao(prazo, entrega, status, HOJE) == esperado


def test_comentarios_so_viram_envio_com_evidencia():
    assert ob.classificar_comentario("Marcou manualmente como guia já lida.") == ob.EV_LEITURA
    assert ob.classificar_comentario("Mudou o Status: de Pendente para Dispensada.") == ob.EV_STATUS
    assert ob.classificar_comentario("Enviou a guia para o cliente por e-mail") == ob.EV_ENVIO
    assert ob.classificar_comentario("Anexou o arquivo DAS.pdf") == ob.EV_ANEXO
    assert ob.classificar_comentario("Cliente pediu para ligar amanhã") == ob.EV_OUTRO


def test_envio_cliente():
    quando = datetime(2026, 11, 19, 10, tzinfo=ob.FUSO)
    assert ob.envio_cliente(ob.PENDENTE, "", []) == (ob.ENVIO_NAO_SE_APLICA, None)
    assert ob.envio_cliente(ob.CONCLUIDA_PRAZO, "", [])[0] == ob.ENVIO_AGUARDANDO
    env, ev = ob.envio_cliente(ob.CONCLUIDA_PRAZO, "", [{"tipo": ob.EV_ENVIO, "data": quando, "autor": "Carlos"}])
    assert env == ob.ENVIO_REGISTRADO and ev["autor"] == "Carlos"
    assert ob.envio_cliente(ob.CONCLUIDA_PRAZO, "Guia já acessada/lida", [])[0] == ob.ENVIO_LIDA


def test_normalizar_entrega():
    e = ob.normalizar_entrega(EMPRESA, _ent(
        EntDtEntrega="2026-11-19", Status="Ent. antecipada", RespEntrega="Carlos Silva",
        Config={"RespEntrega": "Carlos Silva", "RespEntregaID": "18"},
        Comentarios=[{"Nome": "Carlos Silva", "Email": None, "Data": "2026-11-19 16:00:00",
                      "Texto": "Enviou a guia ao cliente"}]))
    assert e["chave"] == "ent:555" and e["cnpj"] == "11222333000181" and e["empresa_nome"] == "Empresa Alfa Ltda"
    assert e["prazo"] == date(2026, 11, 20) and e["dt_entrega"] == date(2026, 11, 19)
    assert e["resp_prazo"] == "Ana Paula" and e["resp_entrega"] == "Carlos Silva"
    assert e["departamento_nome"] == "Fiscal" and e["tipo"] == "O" and e["multa"] is True
    assert e["status_origem"] == "Ent. antecipada" and "Comentarios" not in e["raw"]
    assert e["comentarios"][0]["tipo"] == ob.EV_ENVIO
    l = ob.enriquecer(e, HOJE, e["comentarios"])
    assert l["situacao"] == ob.CONCLUIDA_PRAZO and l["envio"] == ob.ENVIO_REGISTRADO
    assert l["envio_por"] == "Carlos Silva"


def test_normalizar_sem_config_tem_chave_estavel_e_prazo_pelo_atraso():
    ent = _ent(EntDtPrazo="", EntDtAtraso="2026-11-21")
    ent.pop("Config")
    a, b = ob.normalizar_entrega(EMPRESA, ent), ob.normalizar_entrega(EMPRESA, dict(ent))
    assert a["chave"] == b["chave"] and a["chave"].startswith("h:")
    assert a["prazo"] == date(2026, 11, 20) and a["resp_prazo"] is None


def test_nome_com_html_vira_so_texto():
    ecac = "<a href='https://cav.receita.fazenda.gov.br/autenticacao/login'> ECAC</a>"
    assert ob.sem_html(ecac) == "ECAC"
    assert ob.sem_html("Folha &amp; Pró-labore") == "Folha & Pró-labore"
    assert ob.sem_html("DAS Simples Nacional") == "DAS Simples Nacional"
    ent = _ent(Nome=ecac)
    assert ob.normalizar_entrega(EMPRESA, ent)["nome"] == "ECAC"
    # sem o ID da entrega, a chave continua a mesma de antes (não duplica o que já foi gravado)
    ent.pop("Config")
    antes = "h:" + __import__("hashlib").sha1("|".join(
        [ob._texto(EMPRESA.get("ID")), ob.so_digitos(EMPRESA.get("Identificador")), ecac, ob._texto(ent.get("EntCompetencia")),
         str(ent.get("EntDtPrazo") or "")]).encode("utf-8")).hexdigest()
    assert ob.normalizar_entrega(EMPRESA, ent)["chave"] == antes
    # linha antiga no banco, ainda com HTML: sai limpa na leitura
    assert ob.enriquecer({"nome": ecac, "prazo": None, "dt_entrega": None}, date(2026, 11, 23))["nome"] == "ECAC"


def _linhas():
    def l(prazo, entrega=None, status="Pendente", resp="Ana Paula", feito_por=None, depto="Fiscal", lida=""):
        e = {"prazo": prazo, "dt_entrega": entrega, "status_origem": status, "resp_prazo": resp,
             "resp_entrega": feito_por, "departamento_nome": depto, "guia_lida": lida, "cnpj": "1",
             "empresa_nome": "Alfa", "nome": "DAS"}
        return ob.enriquecer(e, HOJE, [])
    return [
        l(date(2026, 11, 20), date(2026, 11, 19), "Ent. antecipada", feito_por="Ana Paula", lida="Guia lida"),
        l(date(2026, 11, 20), date(2026, 11, 22), "Entregue", resp="Carlos Silva", feito_por="Carlos Silva"),
        l(date(2026, 11, 20)),                                     # atrasada
        l(date(2026, 11, 25), resp=None, depto="Pessoal"),         # pendente, vence em 2 dias, sem responsável
        l(date(2026, 11, 5), status="Dispensada"),
    ]


def test_indicadores():
    ind = ob.indicadores(_linhas())
    assert ind["total"] == 4 and ind["dispensadas"] == 1
    assert (ind["concluidas"], ind["pendentes"], ind["atrasadas"]) == (2, 1, 1)
    assert ind["cumprimento"] == 25.0  # 1 no prazo de 4 com prazo
    assert ind["aguardando_envio"] == 1 and ind["envios"][ob.ENVIO_LIDA] == 1


def test_por_colaborador():
    g = {x["colaborador"]: x for x in ob.por_colaborador(_linhas())}
    assert g["Ana Paula"]["atribuidas"] == 2 and g["Ana Paula"]["no_prazo"] == 1
    assert g["Ana Paula"]["atrasadas"] == 1 and g["Ana Paula"]["taxa"] == 50.0
    assert g["Carlos Silva"]["com_atraso"] == 1 and g["Carlos Silva"]["entregas_feitas"] == 1
    assert g["Sem responsável"]["pendentes"] == 1


def test_alertas_e_filtros():
    linhas = _linhas()
    agora = datetime(2026, 11, 23, 12, tzinfo=ob.FUSO)
    titulos = [a["titulo"] for a in ob.alertas(linhas, HOJE, 5, agora - timedelta(hours=1), agora)]
    assert "Dados possivelmente desatualizados" not in titulos
    assert "Obrigações em atraso" in titulos and "Vencem nos próximos 5 dias" in titulos
    assert "Pendências sem responsável" in titulos
    velho = ob.alertas(linhas, HOJE, 5, agora - timedelta(hours=30), agora)
    assert velho[0]["titulo"] == "Dados possivelmente desatualizados"
    assert len(ob.filtrar(linhas, departamento="Pessoal")) == 1
    assert len(ob.filtrar(linhas, situacoes=[ob.ATRASADA])) == 1
    assert len(ob.filtrar(linhas, colaborador="Carlos Silva")) == 1
    # cartão "Sem confirmação de envio": concluídas cujo envio não foi registrado
    sem_envio = ob.filtrar(linhas, situacoes=list(ob.CONCLUIDAS), envios=[ob.ENVIO_AGUARDANDO])
    assert len(sem_envio) == ob.indicadores(linhas)["aguardando_envio"]


def test_modo_automatico():
    agora = datetime(2026, 11, 23, 12, tzinfo=ob.FUSO)
    assert ob.modo_automatico({"ultima_sinc_ok": None, "ultima_carga_completa": None}, agora) == ob.SINC_COMPLETA
    ontem = agora - timedelta(days=1)
    assert ob.modo_automatico({"ultima_sinc_ok": ontem, "ultima_carga_completa": ontem}, agora) == ob.SINC_INCREMENTAL
    velho = agora - timedelta(days=3)
    assert ob.modo_automatico({"ultima_sinc_ok": velho, "ultima_carga_completa": velho}, agora) == ob.SINC_COMPLETA


def test_relatorios():
    linhas = [{**l, "id": i} for i, l in enumerate(_linhas())]
    xlsx = ob.gerar_excel(linhas, "Teste")
    assert xlsx[:2] == b"PK"
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(xlsx))
    assert wb.sheetnames == ["Resumo", "Obrigações", "Colaboradores"]
    assert wb["Obrigações"]["P2"].value == "Indisponível na API"
    pdf = ob.gerar_pdf(linhas, "Teste", "Escritório")
    assert pdf[:4] == b"%PDF"


# ---------------------------------------------------------------- conector

class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _falso(respostas: list):
    pedidos = []

    def abrir(req, timeout=None):
        pedidos.append(req)
        r = respostas.pop(0)
        if isinstance(r, int):
            raise urllib.error.HTTPError(req.full_url, r, "erro", {}, None)
        return _Resp(json.dumps(r).encode("utf-8"))
    return abrir, pedidos


def test_conector_pagina_ate_lista_vazia_e_manda_os_parametros():
    abrir, pedidos = _falso([[{**EMPRESA, "Entregas": [_ent()]}], [{**EMPRESA, "Entregas": [_ent(Config={"EntID": "556"})]}], []])
    c = ob.ConectorAcessorias("tok", abrir=abrir, dormir=lambda s: None)
    ents = c.entregas_empresa("11222333000181", date(2026, 11, 1), date(2026, 11, 30))
    assert [e["chave"] for e in ents] == ["ent:555", "ent:556"]
    url = urlparse(pedidos[0].full_url)
    q = parse_qs(url.query, keep_blank_values=True)
    assert url.path == "/deliveries/11222333000181/"
    assert q["DtInitial"] == ["2026-11-01"] and q["DtFinal"] == ["2026-11-30"] and q["Pagina"] == ["1"]
    assert "config" in q and "comments" in q
    assert pedidos[0].headers["Authorization"] == "Bearer tok"
    assert c.requisicoes == 3


def test_conector_incremental_usa_dtlastdh():
    abrir, pedidos = _falso([[]])
    c = ob.ConectorAcessorias("tok", abrir=abrir, dormir=lambda s: None)
    c.entregas_alteradas(datetime(2026, 11, 22, 0, 0, tzinfo=ob.FUSO), date(2026, 8, 1), date(2027, 1, 31))
    q = parse_qs(urlparse(pedidos[0].full_url).query)
    assert urlparse(pedidos[0].full_url).path == "/deliveries/ListAll/"
    assert q["DtLastDH"] == ["2026-11-22 00:00:00"]


def test_conector_espera_no_429_e_trata_erros():
    esperas = []
    abrir, _ = _falso([429, [{"ID": "1", "Nome": "Fiscal"}]])
    c = ob.ConectorAcessorias("tok", abrir=abrir, dormir=esperas.append)
    assert c.departamentos() == [{"id_externo": "1", "nome": "Fiscal", "id_pai": None}]
    assert ob.ConectorAcessorias.ESPERA_429_S in esperas
    abrir, _ = _falso([401])
    with pytest.raises(ob.ErroIntegracao, match="token"):
        ob.ConectorAcessorias("tok", abrir=abrir, dormir=lambda s: None).departamentos()
    abrir, _ = _falso([{"Erro": "DtLastDH inválido"}])
    with pytest.raises(ob.ErroIntegracao, match="DtLastDH"):
        ob.ConectorAcessorias("tok", abrir=abrir, dormir=lambda s: None).departamentos()
    with pytest.raises(ob.ErroIntegracao):
        ob.ConectorAcessorias("")


# ---------------------------------------------------------------- banco (TEST_DATABASE_URL)

class _ConectorFalso:
    """Acessórias de mentira para a sincronização: 2 empresas (1 inativa)."""
    requisicoes = 0

    def __init__(self, entregas_por_cnpj=None, alteradas=None, falha=None):
        self.entregas_por_cnpj = entregas_por_cnpj or {}
        self.alteradas = alteradas or []
        self.falha = falha
        self.pedidos = []

    def departamentos(self):
        return [{"id_externo": "2", "nome": "Fiscal", "id_pai": None}]

    def usuarios(self):
        return [{"id_externo": "17", "nome": "Ana Paula", "email": "ana@x.com", "ativo": True}]

    def empresas(self):
        if self.falha:
            raise ob.ErroIntegracao(self.falha)
        return [{"id_externo": "7", "cnpj": "11222333000181", "razao": "Empresa Alfa Ltda", "fantasia": "Alfa",
                 "situacao": "Ativa", "regime": None, "raw": {"ID": "7"}},
                {"id_externo": "8", "cnpj": "99888777000166", "razao": "Inativa SA", "fantasia": None,
                 "situacao": "Inativa", "regime": None, "raw": None}]

    def entregas_empresa(self, cnpj, ini, fim):
        self.pedidos.append(("empresa", cnpj))
        return [ob.normalizar_entrega(EMPRESA, e) for e in self.entregas_por_cnpj.get(cnpj, [])]

    def entregas_alteradas(self, desde, ini, fim):
        self.pedidos.append(("alteradas", desde))
        return [ob.normalizar_entrega(EMPRESA, e) for e in self.alteradas]


@pytest.fixture
def banco(db):
    ob.garantir_schema()
    return "esc-a"


def test_sincronizacao_completa_e_incremental(banco):
    agora = datetime(2026, 11, 23, 12, tzinfo=ob.FUSO)
    coment = [{"Nome": "Ana Paula", "Email": None, "Data": "2026-11-19 16:00:00", "Texto": "Enviou a guia ao cliente"}]
    c = _ConectorFalso({"11222333000181": [_ent(Comentarios=coment), _ent(Nome="EFD-Reinf", Config={"EntID": "556"})]})
    r = ob.sincronizar(banco, "teste", conector=c, agora=agora)
    assert r["modo"] == ob.SINC_COMPLETA and r["novas"] == 2 and r["eventos"] == 1
    assert c.pedidos == [("empresa", "11222333000181")]  # a inativa não é consultada
    cfg = ob.obter_config(banco)
    assert cfg["ultima_sinc_ok"] and cfg["ultima_carga_completa"]
    assert [e["razao"] for e in ob.listar_empresas(banco)] == ["Empresa Alfa Ltda", "Inativa SA"]

    # de novo, igual: nada novo, comentário não duplica
    r = ob.sincronizar(banco, "teste", modo=ob.SINC_COMPLETA, conector=c, agora=agora)
    assert (r["novas"], r["alteradas"], r["eventos"]) == (0, 0, 0)

    # incremental: a DAS foi entregue e a guia lida
    c2 = _ConectorFalso(alteradas=[_ent(EntDtEntrega="2026-11-24", Status="Entregue", EntGuiaLida="Guia lida",
                                        Config={"RespEntrega": "Ana Paula"})])
    r = ob.sincronizar(banco, "teste", conector=c2, agora=agora + timedelta(hours=1))
    assert r["modo"] == ob.SINC_INCREMENTAL and r["alteradas"] == 1
    assert c2.pedidos[0][0] == "alteradas"

    linhas = ob.carregar(banco, date(2026, 11, 1), date(2026, 11, 30), hoje=HOJE)
    das = next(l for l in linhas if l["nome"] == "DAS Simples Nacional")
    assert das["situacao"] == ob.CONCLUIDA_ATRASO and das["envio"] == ob.ENVIO_LIDA
    d = ob.detalhe(banco, das["id"])
    assert {a["campo"] for a in d["alteracoes"]} >= {"dt_entrega", "status_origem", "guia_lida"}
    assert d["eventos"][0]["tipo"] == ob.EV_ENVIO
    assert len(ob.historico_empresa(banco, "11.222.333/0001-81")) == 2
    assert [h["status"] for h in ob.listar_sincronizacoes(banco)] == [ob.SINC_OK] * 3


def test_sincronizacao_com_erro_nao_mexe_nos_dados(banco):
    agora = datetime(2026, 11, 23, 12, tzinfo=ob.FUSO)
    r = ob.sincronizar(banco, "teste", conector=_ConectorFalso(falha="Acessórias recusou o token"), agora=agora)
    assert "token" in r["erro"]
    assert ob.obter_config(banco)["ultima_sinc_ok"] is None
    assert ob.listar_sincronizacoes(banco)[0]["status"] == ob.SINC_ERRO


def test_config_cifra_o_token(banco):
    ob.salvar_config(banco, "dp_admin", True, "segredo-123", 6, 1)
    cfg = ob.obter_config(banco)
    assert cfg["token_salvo"] and cfg["ativo"] and (cfg["meses_atras"], cfg["meses_frente"]) == (6, 1)
    assert "segredo" not in json.dumps(cfg, default=str)
    assert ob.token(banco) == "segredo-123"
    ob.salvar_config(banco, "dp_admin", True, "")  # em branco mantém
    assert ob.token(banco) == "segredo-123"
    ob.salvar_config(banco, "dp_admin", False, "", apagar_token=True)
    assert ob.token(banco) == "" and not ob.obter_config(banco)["token_salvo"]


def test_conector_respeita_intervalo_entre_chamadas():
    esperas, t = [], [0.0]
    abrir, _ = _falso([[{"id": "1", "nome": "A", "email": "a@x", "status": "Ativo"}], []])
    c = ob.ConectorAcessorias("tok", abrir=abrir, dormir=esperas.append, relogio=lambda: t[0])
    usuarios = c.usuarios()
    assert usuarios[0]["ativo"] is True
    assert esperas and esperas[0] == pytest.approx(ob.ConectorAcessorias.INTERVALO_S)

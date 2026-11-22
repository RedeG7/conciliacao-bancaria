"""Testes da Calculadora RTC (calculadora_rtc.py) - sem banco e sem a API da
Receita: só a montagem do pedido e a leitura da resposta. A resposta usada
aqui é a do exemplo oficial da Receita (docs/exemplos.md do repo
ReceitaFederal/calculadora-rtc-regime-regular), conferida ao vivo na 1.7.2."""

from __future__ import annotations

from datetime import date

import calculadora_rtc as rtc


def test_versao_bate_com_as_novidades():
    # a cada atualização: suba calculadora_rtc.VERSAO e registre a novidade no topo
    assert rtc.NOVIDADES[0][0] == rtc.VERSAO
    versoes = [tuple(int(x) for x in v.split(".")) for v, _, _ in rtc.NOVIDADES]
    assert versoes == sorted(versoes, reverse=True) and len(set(versoes)) == len(versoes)


def test_monta_operacao_2027_com_aliquotas_e_cst_do_cclasstrib():
    itens = [
        {"codigo": "1006.30.21", "cClassTrib": "200003 — Cesta básica", "base": 100, "quantidade": 20, "unidade": "kg"},
        {"codigo": "122011200", "cClassTrib": "200028", "base": "1.200,50"},
        {"codigo": "22030000", "cClassTrib": "000001", "base": 150, "quantidade": 12, "unidade": "LT",
         "is_aliquota": 10},
        {"codigo": "", "cClassTrib": None, "base": 50},          # sem cClassTrib: ignorado
        {"codigo": "", "cClassTrib": "000001", "base": float("nan")},  # sem base: ignorado
    ]
    op = rtc.montar_operacao(date(2027, 3, 10), "GO", 5208707, itens, (8.8, 0.05, 0.05))
    assert op["dhFatoGerador"] == "2027-03-10T12:00:00-03:00"
    assert op["municipio"] == 5208707 and op["uf"] == "GO"
    assert [i["numero"] for i in op["itens"]] == [1, 2, 3]
    a, b, c = op["itens"]
    assert a == {"numero": 1, "cst": "200", "cClassTrib": "200003", "baseCalculo": 100.0, "ncm": "10063021",
                 "quantidade": 20.0, "unidade": "KG",
                 "aliquotasNominais": {"cbs": 8.8, "ibsEstadual": 0.05, "ibsMunicipal": 0.05}}
    assert b["nbs"] == "122011200" and b["baseCalculo"] == 1200.5 and "ncm" not in b
    # com Imposto Seletivo a base de CBS/IBS vem da base do IS + IS (não vai baseCalculo no item)
    assert "baseCalculo" not in c
    assert c["impostoSeletivo"] == {"cst": "000", "cClassTrib": "000001", "baseCalculo": 150.0,
                                    "quantidade": 12.0, "unidade": "LT"}
    assert c["aliquotasNominais"]["impostoSeletivo"] == {"adValorem": 10.0}


def test_2026_nao_manda_aliquotas():
    assert not rtc.aliquotas_obrigatorias(date(2026, 12, 31))
    assert rtc.aliquotas_obrigatorias(date(2027, 1, 1))
    op = rtc.montar_operacao(date(2026, 6, 1), "GO", 5208707, [{"cClassTrib": "000001", "base": 10}])
    assert "aliquotasNominais" not in op["itens"][0]
    assert rtc.aliquotas_sugeridas(2027) == (8.8, 0.05, 0.05)
    assert rtc.aliquotas_sugeridas(2030)[1:] == (0.0, 0.0)


RESPOSTA = {
    "objetos": [
        {"nObj": 1, "estadoItem": "CALCULO_SIMULADO", "tribCalc": {"IBSCBS": {
            "CST": "200", "cClassTrib": "200028", "gIBSCBS": {
                "vBC": "1200.00",
                "gIBSUF": {"pIBSUF": "0.05", "gRed": {"pRedAliq": "60.00", "pAliqEfet": "0.02"}, "vIBSUF": "0.24"},
                "gIBSMun": {"pIBSMun": "0.05", "gRed": {"pRedAliq": "60.00", "pAliqEfet": "0.02"}, "vIBSMun": "0.24"},
                "vIBS": "0.48",
                "gCBS": {"pCBS": "8.80", "gRed": {"pRedAliq": "60.00", "pAliqEfet": "3.52"}, "vCBS": "42.24",
                         "memoriaCalculo": "base 1200 x 3,52%"}}}}},
        {"nObj": 2, "estadoItem": "INCONSISTENCIA_ENTRADA", "erros": [{
            "code": "REG-011", "title": "NCM não vinculada",
            "detail": "NCM de código 02013000 não vinculada à Classificação Tributária de código 200035 (CBS e IBS)"}]},
    ],
    "total": {"tribCalc": {
        "ISTot": {"vIS": "15.00"},
        "IBSCBSTot": {"vBCIBSCBS": "1465.00", "gIBS": {"vIBS": "0.64"}, "gCBS": {"vCBS": "56.76"}}}},
}


def test_le_itens_e_erros_da_resposta():
    ok, erro = rtc.linhas_resultado(RESPOSTA)
    assert ok["situacao"] == "Calculado (simulado)" and ok["cst"] == "200"
    assert (ok["base"], ok["cbs"], ok["ibs_uf"], ok["ibs_mun"], ok["ibs"]) == (1200.0, 42.24, 0.24, 0.24, 0.48)
    assert (ok["red_cbs"], ok["efet_cbs"], ok["red_ibs"]) == (60.0, 3.52, 60.0)
    assert ok["total"] == 42.72 and ok["memoria"] == ["base 1200 x 3,52%"]
    assert erro["situacao"] == "Erro nos dados" and "02013000" in erro["erros"] and erro["total"] == 0


def test_totais_da_operacao():
    t = rtc.totais(RESPOSTA)
    assert t == {"base": 1465.0, "cbs": 56.76, "ibs": 0.64, "ibs_uf": 0.0, "ibs_mun": 0.0, "is": 15.0,
                 "total": 72.4}


def test_cartao_ncm_nbs_formata_codigo_e_niveis():
    assert rtc.formatar_codigo("NCM", "22011000") == "2201.10.00"
    assert rtc.formatar_codigo("NBS", "122011200") == "1.2201.12.00"
    dados = {"capitulo": "Bebidas.", "posicao": "Águas", "subposicao": "", "subitem": "Águas minerais",
             "tributadoPeloImpostoSeletivo": False}
    assert rtc.niveis_classificacao(dados) == [("Capítulo", "Bebidas."), ("Posição", "Águas"),
                                               ("Subitem", "Águas minerais")]


def test_mensagem_de_erro_da_api():
    assert rtc.mensagem_de_erro({"title": "NCM não encontrada", "detail": "NCM 99999999 não encontrada"}) == \
        "NCM não encontrada — NCM 99999999 não encontrada"
    assert rtc.mensagem_de_erro({"title": "Dados inválidos", "objects": [{"userMessage": "uf obrigatória"}]}) == \
        "Dados inválidos — uf obrigatória"
    assert rtc.mensagem_de_erro("falhou") == "falhou"


def test_api_fora_do_ar_vira_erro_legivel(monkeypatch):
    monkeypatch.setenv("CALCULADORA_RTC_URL", "http://127.0.0.1:9/api/calculadora")
    try:
        rtc.versao()
    except rtc.ErroCalculadora as e:
        assert "fora do ar" in str(e) and e.status is None
    else:
        raise AssertionError("deveria ter falhado")

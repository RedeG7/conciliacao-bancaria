"""Testes da Calculadora RTC - Simples Nacional (calculadora_rtc_sn.py) - sem
banco e sem a API da Receita: só a montagem do pedido e a leitura da
resposta. As respostas usadas aqui foram tiradas da calculadora oficial
(ReceitaFederal/calculadora-rtc-simples-nacional 1.0.2, tabelas V0073)
rodando ao vivo com estes mesmos pedidos."""

from __future__ import annotations

from datetime import date

import calculadora_rtc_sn as sn


def test_versao_bate_com_as_novidades():
    # a cada atualização: suba calculadora_rtc_sn.VERSAO e registre a novidade no topo
    assert sn.NOVIDADES[0][0] == sn.VERSAO
    versoes = [tuple(int(x) for x in v.split(".")) for v, _, _ in sn.NOVIDADES]
    assert versoes == sorted(versoes, reverse=True) and len(set(versoes)) == len(versoes)


CATALOGO = [
    {"codigo": "01", "ordem": 1, "descricao": "Revenda de mercadorias", "anexoSemFatorR": "I",
     "anexoComFatorR": None, "sujeitaFatorR": False, "tpDocsAdmissiveis": ["55", "65"]},
    {"codigo": "07", "ordem": 7, "descricao": "Serviços do Anexo III", "anexoSemFatorR": "III",
     "anexoComFatorR": None, "sujeitaFatorR": False, "tpDocsAdmissiveis": ["91"]},
    {"codigo": "09", "ordem": 9, "descricao": "Serviços sujeitos ao Fator \"R\"", "anexoSemFatorR": "V",
     "anexoComFatorR": "III", "sujeitaFatorR": True, "tpDocsAdmissiveis": ["91"]},
    {"codigo": "90", "ordem": 90, "descricao": "Sem anexo", "anexoSemFatorR": None, "anexoComFatorR": None,
     "sujeitaFatorR": False, "tpDocsAdmissiveis": []},
]


def test_atividades_do_documento_e_anexos():
    assert [a["codigo"] for a in sn.atividades_do_documento(CATALOGO, "55")] == ["01", "90"]
    assert [a["codigo"] for a in sn.atividades_do_documento(CATALOGO, "91")] == ["07", "09", "90"]
    assert sn.anexos_usados(["01", "01"], CATALOGO, None) == ["I"]
    assert sn.anexos_usados(["09"], CATALOGO, True) == ["III"]
    assert sn.anexos_usados(["09"], CATALOGO, False) == ["V"]
    assert sn.anexos_usados(["09", "07"], CATALOGO, None) == ["III", "V"]  # sem fator: os dois
    assert sn.anexos_usados(["90", "xx"], CATALOGO, None) == []
    assert sn.codigo_atividade("09 — Prestação de serviços") == "09"
    assert sn.codigo_atividade("7") == "07" and sn.codigo_atividade(None) == ""


def test_regimes():
    assert sn.regime_calcula({"CRT": "1"}) and not sn.regime_calcula({"CRT": "1", "tpRegimeIBSCBS": "1"})
    assert sn.regime_sublimite({"CRT": "2"}) and not sn.regime_sublimite({"CRT": "1"})
    assert not sn.regime_calcula({"opSimpNac": "3", "regApIBSCBSSN": "3", "regApTribSN": "1"})
    assert sn.regime_sublimite({"opSimpNac": "3", "regApIBSCBSSN": "2", "regApTribSN": "1"})


def test_monta_operacao_nfe():
    aliq = sn.montar_aliquotas({"I": {"cbs": 1.1612, "ibs": "0,0129"}, "II": {"cbs": None}}, None, False)
    assert aliq == {"fatorR": None, "impedimentoSublimite": False,
                    "anexoI": {"pCBSSN": "1.1612", "pIBSSN": "0.0129"}}
    itens = [
        {"atividade": "01 — Revenda", "cClassTrib": "000001 — Tributação integral", "codigo": "2203.00.00",
         "base": 1000, "vis": None},
        {"atividade": "01 — Revenda", "cClassTrib": "200003", "codigo": "10063021", "base": "1.200,50", "vis": 5},
        {"atividade": "", "cClassTrib": None, "base": 50},            # sem cClassTrib: ignorado
        {"atividade": "", "cClassTrib": "000001", "base": float("nan")},  # sem base: ignorado
    ]
    op = sn.montar_operacao(date(2027, 3, 15), "55", {"CRT": "1", "tpRegimeIBSCBS": None}, itens, aliq, "2")
    assert op["data"] == "2027-03-15" and op["tpDoc"] == "55" and op["CRT"] == "1"
    assert "tpRegimeIBSCBS" not in op and "opSimpNac" not in op and op["tpEnteGov"] == "2"
    assert op["aliquotasEfetivas"] == aliq
    a, b = op["itens"]
    assert a == {"numero": 1, "cClassTrib": "000001", "baseCalculo": "1000.00", "cAtivSN": "01",
                 "ncm": "22030000", "valorImpostoSeletivo": "0.00"}
    assert b["baseCalculo"] == "1200.50" and b["valorImpostoSeletivo"] == "5.00" and b["numero"] == 2


def test_somente_receita_nao_manda_aliquotas():
    aliq = sn.montar_aliquotas({"I": {"cbs": 1, "ibs": 0.01}}, None, False)
    op = sn.montar_operacao(date(2027, 1, 2), "65", {"CRT": "1", "tpRegimeIBSCBS": "1"},
                            [{"atividade": "01", "cClassTrib": "000001", "base": 10}], aliq)
    assert op["tpRegimeIBSCBS"] == "1" and "aliquotasEfetivas" not in op


def test_monta_operacao_nfse_um_item_com_iss():
    aliq = sn.montar_aliquotas({"III": {"cbs": 2.3874, "ibs": 0.0263, "cbs_sem": 2.3591, "ibs_sem": 0.026}},
                               True, False)
    assert aliq["anexoIII"] == {"pCBSSN": "2.3874", "pIBSSN": "0.0263",
                                "semRedistribuicaoISS": {"pCBSSN": "2.3591", "pIBSSN": "0.026"}}
    regime = {"opSimpNac": "3", "regApIBSCBSSN": "1", "regApTribSN": "1"}
    itens = [{"atividade": "09 — Fator R", "cClassTrib": "000001", "codigo": "1.0101.11.00", "base": 10000,
              "tribISSQN": "1 — Operação tributável", "tpRetISSQN": "2 — Retido pelo tomador", "tpBM": "Sem benefício"},
             {"atividade": "09", "cClassTrib": "000001", "base": 5}]
    op = sn.montar_operacao(date(2027, 5, 10), "91", regime, itens, aliq)
    assert "CRT" not in op and op["opSimpNac"] == "3" and op["regApTribSN"] == "1"
    assert op["itens"] == [{"numero": 1, "cClassTrib": "000001", "baseCalculo": "10000.00", "cAtivSN": "09",
                            "nbs": "101011100", "tribISSQN": "1", "tpRetISSQN": "2"}]


def test_sublimite_tira_o_ibs():
    aliq = sn.montar_aliquotas({"I": {"cbs": 1.1612, "ibs": 0.0129},
                                "III": {"cbs": 2, "ibs": 1, "cbs_sem": 1.9, "ibs_sem": 0.9}}, None, True)
    assert aliq["impedimentoSublimite"] is True
    assert aliq["anexoI"] == {"pCBSSN": "1.1612"}
    assert aliq["anexoIII"] == {"pCBSSN": "2.0", "semRedistribuicaoISS": {"pCBSSN": "1.9"}}


# resposta real da calculadora (NF-e, CRT 1, anexo I; item 3 sem cAtivSN, item 4 com cClassTrib inválido)
RESPOSTA = {
    "oper": {"data": "2027-03-15", "tpDoc": "55", "CRT": "1", "regimeApuracao": "SN_PLENO"},
    "resolucaoAliquotas": {"fatorR": None, "indSublimite": False, "avisos": [], "itens": [
        {"numero": 1, "cAtivSN": "01", "anexoAplicado": "I", "tipoAliquota": "PAR_UNICO",
         "regraAliquota": "ANEXO_SEM_ISS", "pIBSSN": "0.0129", "pCBSSN": "1.1612", "motivo": "RESOLVIDA", "avisos": []},
        {"numero": 3, "cAtivSN": None, "anexoAplicado": None, "motivo": "ATIVIDADE_DESCONHECIDA", "avisos": []},
    ]},
    "objetos": [
        {"nObj": 1, "estadoItem": "CALCULADO", "tribCalc": {
            "vRBSNitem": "1000.00", "tpRBSN": 1, "tpRBSNDescricao": "Receita bruta - interna", "vBC": "1000.00",
            "pIBSSN": "0.0129", "vIBSSN": "0.13", "vIBSPendSusp": "0.00", "pCBSSN": "1.1612", "vCBSSN": "11.61",
            "vCBSPendSusp": "0.00", "IS": {"valor": "0.00"}, "totalItem": "11.74",
            "memoriaCalculo": {"cbs": "Receita bruta ... alíquota efetiva de 1,1612%.",
                               "ibs": "Receita bruta ... alíquota efetiva de 0,0129%."}}},
        {"nObj": 3, "estadoItem": "NAO_CALCULADO",
         "motivoEstado": {"codigo": "CATIVSN_AUSENTE", "descricao": "O código de atividade do Simples Nacional "
                          "(cAtivSN) não foi informado"},
         "tribCalc": {"vRBSNitem": "100.00", "tpRBSN": 1, "tpRBSNDescricao": "Receita bruta - interna"}},
        {"nObj": 4, "estadoItem": "INCONSISTENCIA_ENTRADA", "erros": [
            {"title": "cClassTrib desconhecido ou fora de vigência", "code": "VSN-021",
             "detail": "O cClassTrib '999999' não existe ou não está vigente na data '2027-03-15'"}]},
    ],
    "total": {"vRBSNtot": "1600.00", "vBC": "1500.00", "vIBSSNtot": "0.19", "vIBSSNtotPendSusp": "0.00",
              "vCBSSNtot": "17.42", "vCBSSNtotPendSusp": "0.00", "totalIs": "0.00", "totalTributos": "17.61"},
}


def test_le_resposta():
    l1, l3, l4 = sn.linhas_resultado(RESPOSTA)
    assert l1["situacao"] == "Calculado" and l1["anexo"] == "I" and l1["regra"] == "Anexo sem ISS (par único)"
    assert (l1["receita"], l1["base"], l1["cbs"], l1["ibs"], l1["total"]) == (1000.0, 1000.0, 11.61, 0.13, 11.74)
    assert l1["aliq_cbs"] == 1.1612 and l1["aliq_ibs"] == 0.0129 and len(l1["memoria"]) == 2
    assert l3["situacao"] == "Não calculado" and "cAtivSN" in l3["motivo"] and l3["receita"] == 100.0
    assert l3["aliq_cbs"] is None and l3["cbs"] == 0.0
    assert l4["situacao"] == "Erro nos dados" and "999999" in l4["erros"]
    tot = sn.totais(RESPOSTA)
    assert tot == {"receita": 1600.0, "base": 1500.0, "cbs": 17.42, "cbs_pend": 0.0, "ibs": 0.19,
                   "ibs_pend": 0.0, "is": 0.0, "total": 17.61}
    assert sn.avisos_gerais(RESPOSTA) == []
    # NFS-e: a resposta não traz o grupo IS nem totalIs
    assert sn.totais({"total": {"vRBSNtot": "10000.00", "totalTributos": "239.00"}})["is"] == 0.0

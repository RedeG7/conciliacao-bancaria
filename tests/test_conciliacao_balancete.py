"""Leitura do balancete em PDF (conciliacao_bancaria.parse_balancete)."""
from types import SimpleNamespace

import conciliacao_bancaria as cb


def _chars(texto, x0, largura, top=100.0):
    out = []
    for ch in texto:
        out.append({"text": ch, "x0": x0, "x1": x0 + largura, "top": top})
        x0 += largura + 0.4
    return out


def test_balancete_sem_classificacao_nao_vira_conta_nao_identificada():
    """Balancete 'Codigo  Descricao da conta  Saldo Anterior ...' (sem coluna
    de classificacao): a linha e legivel e nao pode ser "reparada" com os
    digitos dos VALORES como classificacao ('151 3.098.407' + nome ilegivel)."""
    linha = "151 EMPRESTIMOS 3.098.407,52D 0,00 0,00 3.098.407,52D"
    chars = (_chars("151", 15.1, 3.2) + _chars("EMPRESTIMOS", 59.5, 3.6)
             + _chars("3.098.407,52D", 300, 3.2) + _chars("0,00", 380, 3.2)
             + _chars("0,00", 430, 3.2) + _chars("3.098.407,52D", 480, 3.2))
    pagina = SimpleNamespace(chars=chars)
    assert cb._reparar_linhas_balancete_sobrepostas(pagina, [linha]) == [linha]
    m = cb._BAL_LINE_RE.match(linha) or cb._BAL_LINE_SEM_CLASSIF_RE.match(linha)
    assert m.group("codigo") == "151"
    assert cb._limpar_nome_conta(m.group("nome")) == "EMPRESTIMOS"


def test_reparo_continua_recuperando_codigo_e_classificacao_na_faixa_do_codigo():
    """O caso para o qual o reparo existe continua: codigo e classificacao
    (digitos estreitos, x < 100) recuperados mesmo com o nome ilegivel."""
    codigo = _chars("1323", 2, 3.2) + _chars("1.1.01.02.0008", 20, 3.2)
    nome = _chars("XYZW", 5, 5.0)  # letras intercaladas no meio do codigo
    chars = sorted(codigo + nome, key=lambda c: c["x0"])
    texto = "".join(c["text"] for c in chars)
    pagina = SimpleNamespace(chars=chars)
    [reparada] = cb._reparar_linhas_balancete_sobrepostas(pagina, [texto])
    assert reparada.startswith("1323 1.1.01.02.0008 ")

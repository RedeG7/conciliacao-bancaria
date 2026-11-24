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


# --------------------------------------------------------------------------
# balancete sem classificacao: grupos pela fonte e pai pelos valores
# --------------------------------------------------------------------------
import datetime as dt

from conciliacao_bancaria import ContaBalancete as C


def _balancete_exemplo():
    linhas = [  # (codigo, nome, fonte, (saldo anterior, debito, credito))
        ("1", "ATIVO", "F2", (100.0, 50.0, 30.0)),
        ("12", "CLIENTES", "F2", (100.0, 50.0, 30.0)),
        ("1295", "LUCAS GABRIEL DA SILVA GUIMARAES", "F1", (60.0, 50.0, 0.0)),
        ("1309", "JANILSON DA SILVA SENA", "F1", (40.0, 0.0, 30.0)),
        ("149", "PASSIVO", "F2", (-80.0, 10.0, 40.0)),
        ("164", "FORNECEDORES", "F2", (-80.0, 10.0, 40.0)),
        ("1202", "TUDACO SERVICO DE ESTRUTURAS METALICAS LTDA", "F1", (-50.0, 10.0, 0.0)),
        ("1257", "TH DISTRIBUIDORA DE MATERIAIS PARA CONSTRUCAO", "F1", (-30.0, 0.0, 40.0)),
        ("402", "RESULTADO", "F2", (0.0, 5.0, 0.0)),
        ("295", "DESPESAS OPERACIONAIS", "F2", (0.0, 5.0, 0.0)),
        ("1054", "DESPESAS BANCARIAS", "F1", (0.0, 5.0, 0.0)),
    ]
    contas = [C(codigo=c, classificacao="", nome=n) for c, n, _, _ in linhas]
    fontes = {c: f for c, _, f, _ in linhas}
    valores = {i: v for i, (_, _, _, v) in enumerate(linhas)}
    cb._inferir_grupos_sem_classificacao(contas, fontes, valores)
    return contas


def test_grupos_pela_fonte_e_pai_pelos_valores():
    contas = {c.codigo: c for c in _balancete_exemplo()}
    assert [k for k, c in contas.items() if c.sintetica] == ["1", "12", "149", "164", "402", "295"]
    assert contas["1295"].pai == "12" and contas["1309"].pai == "12" and contas["12"].pai == "1"
    assert contas["149"].pai == ""            # CLIENTES/ATIVO consumidos: PASSIVO e topo
    assert contas["1257"].pai == "164" and contas["164"].pai == "149"
    assert contas["1054"].pai == "295"
    idx = cb.montar_indice_balancete(list(contas.values()))
    assert {ic.conta.codigo for ic in idx.analiticas} == {"1295", "1309", "1202", "1257", "1054"}
    assert next(ic for ic in idx.analiticas if ic.conta.codigo == "1054").natureza == "despesa"


def test_uma_fonte_so_nao_infere_nada():
    contas = [C(codigo="1", classificacao="", nome="ATIVO"), C(codigo="2", classificacao="", nome="CAIXA")]
    cb._inferir_grupos_sem_classificacao(contas, {"1": "F1", "2": "F1"}, {0: (1.0, 0.0, 0.0), 1: (1.0, 0.0, 0.0)})
    assert not any(c.sintetica or c.pai for c in contas)


def _sugestao(idx, desc, valor):
    mv = cb.Movimento(data=dt.date(2026, 5, 1), valor=valor, descricao=desc, origem="extrato")
    s = cb.sugerir_contrapartidas(mv, idx)
    return (s[0].codigo, s[0].confianca) if s else None


def test_nome_cortado_pelo_banco_aplica_so_com_o_inicio_do_nome():
    idx = cb.montar_indice_balancete(_balancete_exemplo())
    lim = cb.LIMIAR_SUGESTAO_AUTOMATICA
    cod, conf = _sugestao(idx, "PIX ENVIADO TUDACO SERVICO DE ESTRUTU", -10)
    assert cod == "1202" and conf >= lim
    cod, conf = _sugestao(idx, "PIX RECEBIDO LUCAS GABRIEL DA SILVA GUIMA", 10)
    assert cod == "1295" and conf >= lim
    # nomes parecidos de quem NAO esta no balancete: nunca aplica sozinho
    for desc, v in [("PIX RECEBIDO JANAINA SILVA SENA", 10), ("PIX ENVIADO DISTRIBUIDORA DE MATERIAIS NORTE", -10),
                    ("PIX RECEBIDO GABRIEL DA SILVA", 10)]:
        r = _sugestao(idx, desc, v)
        assert r is None or r[1] < lim, (desc, r)


def test_empate_rebaixa_todas_as_contas_empatadas():
    contas = [C(codigo="535", classificacao="", nome="RODRIGO SOUZA NETTO"),
              C(codigo="245", classificacao="", nome="RODRIGO SOUZA NETTO")]
    idx = cb.montar_indice_balancete(contas)
    mv = cb.Movimento(data=dt.date(2026, 5, 1), valor=-10, descricao="PIX ENVIADO RODRIGO SOUZA NETTO", origem="extrato")
    sug = cb.sugerir_contrapartidas(mv, idx)
    assert len(sug) == 2 and all(s.confianca < cb.LIMIAR_SUGESTAO_AUTOMATICA for s in sug)

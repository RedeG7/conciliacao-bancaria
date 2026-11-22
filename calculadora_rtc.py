"""Calculadora RTC - Regime Regular (CBS, IBS e Imposto Seletivo, LC 214/2025).

O cálculo NÃO é feito aqui: quem calcula é a calculadora oficial da Receita
Federal (repo ReceitaFederal/calculadora-rtc-regime-regular, API Java com o
banco das tabelas oficiais - CST, cClassTrib, NCM/NBS, alíquotas), que roda
no VPS como o serviço "calculadora-rtc" do docker-compose (imagem montada a
partir de calculadora-rtc/Dockerfile). Este módulo só monta o pedido, chama
a API e organiza a resposta para a tela (_tela_calculadora_rtc em
app_conciliacao.py).

A API não tem login: fica só na rede interna do Docker (sem porta publicada
e sem rota no Caddy) - só o Hub fala com ela.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, time
from typing import Any, Optional
from zoneinfo import ZoneInfo

# Versão do app, mostrada na tela. A cada atualização: suba VERSAO e
# acrescente a entrada no topo de NOVIDADES (o teste confere que batem).
# A versão da calculadora da Receita (motor e banco de tabelas) é outra e
# aparece na tela lida da própria API (/dados-abertos/versao); para trocar,
# mude RTC_REF em calculadora-rtc/Dockerfile.
VERSAO = "1.3"
NOVIDADES = [
    ("1.3", "22/11/2026", [
        "Memória de cálculo volta a aparecer (CBS, IBS estadual, IBS municipal e Imposto Seletivo por item).",
        "Botão Limpar: apaga os itens e o resultado para fazer um cálculo novo.",
        "Relatório em PDF (operação, totais, itens e memória de cálculo) no lugar do download em JSON.",
    ]),
    ("1.2", "22/11/2026", [
        "Cartão do NCM/NBS: marcador dos níveis da classificação corrigido (aparecia como \"l,\").",
    ]),
    ("1.1", "22/11/2026", [
        "Consulta de NCM/NBS em cartão: código formatado, a classificação do capítulo ao subitem e selo "
        "dizendo se o item é tributado pelo Imposto Seletivo (no lugar do texto em formato de código).",
    ]),
    ("1.0", "22/11/2026", [
        "Novo app no RPA Fiscal: Calculadora RTC - Regime Regular, com a calculadora oficial da Receita "
        "Federal (versão 1.7.2) rodando na VPS.",
        "Cálculo da CBS, do IBS (estadual e municipal) e do Imposto Seletivo por item, com CST e cClassTrib "
        "das tabelas oficiais, reduções de alíquota, memória de cálculo e totais da operação.",
        "Base de cálculo unificada da NF-e/NFC-e (o que entra e o que sai da base em cada ano da transição).",
        "Consulta de cClassTrib, NCM e NBS na data escolhida, e download do resultado (JSON) e do grupo de "
        "tributação em XML da NF-e.",
    ]),
]

URL_PADRAO = "http://calculadora-rtc:8080/api/calculadora"
TIMEOUT_S = 30
FUSO = ZoneInfo("America/Sao_Paulo")

# Situação do item na resposta da observabilidade -> rótulo da tela
ESTADOS = {
    "CALCULADO": "Calculado",
    "CALCULO_SIMULADO": "Calculado (simulado)",
    "INCONSISTENCIA_ENTRADA": "Erro nos dados",
    "NAO_IMPLEMENTADO": "Não implementado",
    "FALHA_TECNICA": "Falha técnica",
}

# Alíquotas da transição (EC 132/2023 e LC 214/2025). Em 2026 a API já tem as
# alíquotas cadastradas (CBS 0,9% e IBS 0,1%) e não aceita que sejam
# informadas. De 2027 em diante a Receita ainda não cadastrou as alíquotas de
# referência: elas têm de ir no pedido e o resultado sai "simulado". Os
# valores abaixo são só o ponto de partida do formulário: o IBS de 2027/2028
# está na lei (0,05% + 0,05%); a CBS de 8,8% é a estimativa usada nos
# exemplos da própria Receita.
ALIQUOTA_CBS_ESTIMADA = 8.8
IBS_2027_2028 = (0.05, 0.05)


def url_base() -> str:
    return (os.environ.get("CALCULADORA_RTC_URL") or URL_PADRAO).rstrip("/")


class ErroCalculadora(Exception):
    """Falha ao falar com a API (fora do ar, timeout) ou resposta de erro.
    `status` é o HTTP (None quando nem chegou a responder) e `corpo` o JSON
    de erro da API, quando houver."""

    def __init__(self, mensagem: str, status: Optional[int] = None, corpo: Any = None):
        super().__init__(mensagem)
        self.status = status
        self.corpo = corpo


def _requisitar(metodo: str, caminho: str, params: Optional[dict] = None, corpo: Any = None,
                tipo: str = "application/json", aceita: str = "application/json") -> tuple[Any, dict]:
    url = url_base() + caminho
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    dados = None
    if corpo is not None:
        dados = corpo.encode("utf-8") if isinstance(corpo, str) else json.dumps(corpo).encode("utf-8")
    req = urllib.request.Request(url, data=dados, method=metodo,
                                 headers={"Content-Type": tipo, "Accept": aceita})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            bruto = resp.read().decode("utf-8")
            cabecalhos = {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        bruto = e.read().decode("utf-8", errors="replace")
        try:
            corpo_erro = json.loads(bruto)
        except ValueError:
            corpo_erro = bruto
        raise ErroCalculadora(mensagem_de_erro(corpo_erro) or f"HTTP {e.code}", e.code, corpo_erro) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ErroCalculadora(f"Calculadora da Receita fora do ar ({getattr(e, 'reason', e)}).") from None
    if aceita == "application/json":
        return (json.loads(bruto) if bruto.strip() else None), cabecalhos
    return bruto, cabecalhos


def mensagem_de_erro(corpo: Any) -> str:
    """Texto legível do erro da API (formato Problem Details: title/detail,
    às vezes com lista de erros/objects)."""
    if isinstance(corpo, str):
        return corpo.strip()[:500]
    if not isinstance(corpo, dict):
        return ""
    partes = [str(corpo.get(k)) for k in ("title", "detail", "userMessage") if corpo.get(k)]
    for chave in ("erros", "errors", "objects", "objetos"):
        for e in corpo.get(chave) or []:
            if isinstance(e, dict):
                txt = e.get("detail") or e.get("userMessage") or e.get("message") or e.get("title")
                if txt:
                    partes.append(str(txt))
    vistos, saida = set(), []
    for p in partes:
        if p not in vistos:
            vistos.add(p)
            saida.append(p)
    return " — ".join(saida)


# ---------------------------------------------------------------- consultas

def versao() -> dict:
    return _requisitar("GET", "/dados-abertos/versao")[0] or {}


def ufs() -> list[dict]:
    return sorted(_requisitar("GET", "/dados-abertos/ufs")[0] or [], key=lambda u: u.get("sigla", ""))


def municipios(sigla_uf: str) -> list[dict]:
    lista = _requisitar("GET", "/dados-abertos/ufs/municipios", {"siglaUf": sigla_uf})[0] or []
    return sorted(lista, key=lambda m: m.get("nome", ""))


def situacoes_cbs_ibs(data: date) -> list[dict]:
    """CSTs de CBS/IBS com as classificações (cClassTrib) de cada um."""
    return _requisitar("GET", "/dados-abertos/situacoes-tributarias/cbs-ibs", {"data": data.isoformat()})[0] or []


def classificacoes_cbs_ibs(data: date) -> list[dict]:
    """Todas as cClassTrib de CBS/IBS na data, com tipo de alíquota e reduções."""
    return _requisitar("GET", "/dados-abertos/classificacoes-tributarias/cbs-ibs",
                       {"data": data.isoformat()})[0] or []


def consultar_ncm(ncm: str, data: date) -> dict:
    return _requisitar("GET", "/dados-abertos/ncm", {"ncm": so_digitos(ncm), "data": data.isoformat()})[0] or {}


def consultar_nbs(nbs: str, data: date) -> dict:
    return _requisitar("GET", "/dados-abertos/nbs", {"nbs": so_digitos(nbs), "data": data.isoformat()})[0] or {}


# Níveis da classificação devolvidos pela consulta de NCM/NBS, do mais amplo
# ao mais específico (os que vierem vazios ficam de fora)
NIVEIS_NCM_NBS = (("capitulo", "Capítulo"), ("posicao", "Posição"), ("subposicao", "Subposição"),
                  ("item", "Item"), ("subitem", "Subitem"))


def formatar_codigo(tipo: str, codigo: str) -> str:
    """NCM 22011000 -> 2201.10.00; NBS 122011200 -> 1.2201.12.00."""
    d = so_digitos(codigo)
    if tipo == "NCM" and len(d) == 8:
        return f"{d[:4]}.{d[4:6]}.{d[6:]}"
    if tipo == "NBS" and len(d) == 9:
        return f"{d[0]}.{d[1:5]}.{d[5:7]}.{d[7:]}"
    return d


def niveis_classificacao(dados: dict) -> list[tuple[str, str]]:
    """[(rótulo, descrição)] da consulta de NCM/NBS, do capítulo ao subitem."""
    return [(rotulo, str(dados[chave]).strip()) for chave, rotulo in NIVEIS_NCM_NBS
            if str(dados.get(chave) or "").strip()]


def lista_classificacoes(situacoes: list[dict]) -> list[dict]:
    """Achata a lista CST -> classificações em linhas {cst, cClassTrib,
    descricao, descricao_cst}, ordenadas pelo código."""
    linhas = []
    for s in situacoes or []:
        for c in s.get("classificacoesTributarias") or []:
            linhas.append({
                "cst": s.get("codigo", ""),
                "descricao_cst": s.get("descricao", ""),
                "cClassTrib": c.get("codigo", ""),
                "descricao": c.get("descricao", ""),
            })
    return sorted(linhas, key=lambda l: l["cClassTrib"])


# ---------------------------------------------------------------- cálculo

def so_digitos(txt: Any) -> str:
    return "".join(ch for ch in str(txt or "") if ch.isdigit())


def aliquotas_obrigatorias(data_fato: date) -> bool:
    """A partir de 2027 as alíquotas têm de ir no pedido (em 2026 são proibidas)."""
    return data_fato.year >= 2027


def aliquotas_sugeridas(ano: int) -> tuple[float, float, float]:
    """(CBS, IBS estadual, IBS municipal) para pré-preencher o formulário."""
    if ano in (2027, 2028):
        return (ALIQUOTA_CBS_ESTIMADA, *IBS_2027_2028)
    return (ALIQUOTA_CBS_ESTIMADA, 0.0, 0.0)


def _numero(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        if isinstance(v, str):
            v = v.strip().replace(".", "").replace(",", ".") if "," in v else v.strip()
        n = float(v)
    except (TypeError, ValueError):
        return None
    return None if n != n else n  # NaN (célula vazia no data_editor)


def montar_operacao(data_fato: date, uf: str, municipio: int, itens: list[dict],
                    aliquotas: Optional[tuple[float, float, float]] = None) -> dict:
    """Corpo do POST /regime-geral. `itens`: dicts com codigo (NCM ou NBS),
    cClassTrib, base, quantidade, unidade e, opcionalmente, is_base /
    is_aliquota (Imposto Seletivo ad valorem). O CST são os 3 primeiros
    dígitos do cClassTrib. Linhas sem cClassTrib ou sem base são ignoradas."""
    momento = datetime.combine(data_fato, time(12, 0), tzinfo=FUSO)
    saida = []
    for it in itens:
        cclass = so_digitos(it.get("cClassTrib"))[:6]
        base = _numero(it.get("base"))
        if len(cclass) != 6 or base is None:
            continue
        item: dict[str, Any] = {"numero": len(saida) + 1, "cst": cclass[:3], "cClassTrib": cclass,
                                "baseCalculo": round(base, 2)}
        codigo = so_digitos(it.get("codigo"))
        if len(codigo) == 8:
            item["ncm"] = codigo
        elif len(codigo) == 9:
            item["nbs"] = codigo
        qtd = _numero(it.get("quantidade"))
        if qtd:
            item["quantidade"] = qtd
            item["unidade"] = (str(it.get("unidade") or "UN").strip() or "UN")[:6].upper()
        is_base, is_aliq = _numero(it.get("is_base")), _numero(it.get("is_aliquota"))
        if is_aliq:
            item.pop("baseCalculo")  # com IS, a base de CBS/IBS sai da base do IS + IS
            item["impostoSeletivo"] = {"cst": "000", "cClassTrib": "000001",
                                       "baseCalculo": round(is_base if is_base is not None else base, 2)}
            if qtd:
                item["impostoSeletivo"].update({"quantidade": qtd, "unidade": item["unidade"]})
        if aliquotas is not None:
            cbs, ibs_uf, ibs_mun = aliquotas
            item["aliquotasNominais"] = {"cbs": cbs, "ibsEstadual": ibs_uf, "ibsMunicipal": ibs_mun}
            if is_aliq:
                item["aliquotasNominais"]["impostoSeletivo"] = {"adValorem": is_aliq}
        saida.append(item)
    return {
        "id": uuid.uuid4().hex,
        "versao": "1.0.0",
        "dhFatoGerador": momento.isoformat(timespec="seconds"),
        "municipio": int(municipio),
        "uf": uf,
        "itens": saida,
    }


def calcular(operacao: dict) -> tuple[dict, Optional[str]]:
    """Cálculo com observabilidade (um item com erro não derruba os outros).
    Devolve (resposta, aviso de dados simulados ou None)."""
    resp, cab = _requisitar("POST", "/observabilidade/regime-geral", corpo=operacao)
    return resp or {}, cab.get("x-warning-dados-simulados")


def gerar_xml_nfe(operacao: dict) -> str:
    """Grupo de tributação da NF-e (XML) da operação. Usa o cálculo sem
    observabilidade, que falha inteiro (HTTP 422) se algum item tiver erro."""
    resultado, _ = _requisitar("POST", "/regime-geral", corpo=operacao)
    xml, _ = _requisitar("POST", "/xml/generate", {"tipo": "nfe"}, corpo=resultado,
                         aceita="application/xml")
    return xml


def base_calculo_unificada(componentes: dict) -> dict:
    return _requisitar("POST", "/base-calculo/base-calculo-unificada", corpo=componentes)[0] or {}


# ---------------------------------------------------------------- leitura da resposta

def _f(v: Any) -> float:
    n = _numero(v)
    return n if n is not None else 0.0


def _reducao(grupo: dict) -> tuple[Optional[float], Optional[float]]:
    red = grupo.get("gRed") or {}
    return _numero(red.get("pRedAliq")), _numero(red.get("pAliqEfet"))


_ROTULOS_MEMORIA = {"is": "Imposto Seletivo", "cbs": "CBS", "ibsuf": "IBS estadual", "ibsmun": "IBS municipal"}


def memoria_calculo(trib: dict) -> list[tuple[str, str]]:
    """[(tributo, texto)] da memória de cálculo de um item. Na 1.7.x a
    Receita manda a da CBS/IBS num objeto só (IBSCBS.memoriaCalculo = {cbs,
    ibsUF, ibsMun}) e a do IS como texto em IS.memoriaCalculo; versões
    antigas punham um texto dentro de cada grupo (gCBS, gIBSUF, gIBSMun)."""
    saida: list[tuple[str, str]] = []

    def junta(rotulo: str, valor: Any) -> None:
        if isinstance(valor, dict):
            for k, v in valor.items():
                junta(_ROTULOS_MEMORIA.get(k.lower(), k), v)
        elif isinstance(valor, str) and valor.strip():
            saida.append((rotulo, valor.strip()))

    is_ = trib.get("IS") or {}
    junta("Imposto Seletivo", is_.get("memoriaCalculo"))
    ibscbs = trib.get("IBSCBS") or {}
    junta("CBS/IBS", ibscbs.get("memoriaCalculo"))
    g = ibscbs.get("gIBSCBS") or {}
    for chave, rotulo in (("gCBS", "CBS"), ("gIBSUF", "IBS estadual"), ("gIBSMun", "IBS municipal")):
        junta(rotulo, (g.get(chave) or {}).get("memoriaCalculo"))
    return saida


def linhas_resultado(resposta: dict) -> list[dict]:
    """Uma linha por item da resposta, com o que a tela mostra."""
    linhas = []
    for obj in resposta.get("objetos") or []:
        trib = obj.get("tribCalc") or {}
        ibscbs = trib.get("IBSCBS") or {}
        g = ibscbs.get("gIBSCBS") or {}
        uf, mun, cbs = g.get("gIBSUF") or {}, g.get("gIBSMun") or {}, g.get("gCBS") or {}
        is_ = trib.get("IS") or {}
        red_cbs, efet_cbs = _reducao(cbs)
        red_uf, efet_uf = _reducao(uf)
        red_mun, efet_mun = _reducao(mun)
        erros = [e.get("detail") or e.get("title") or e.get("code") for e in obj.get("erros") or []]
        linha = {
            "item": obj.get("nObj"),
            "situacao": ESTADOS.get(obj.get("estadoItem"), obj.get("estadoItem") or "Calculado"),
            "cst": ibscbs.get("CST", ""),
            "cClassTrib": ibscbs.get("cClassTrib", ""),
            "base": _f(g.get("vBC")),
            "aliq_cbs": _numero(cbs.get("pCBS")),
            "red_cbs": red_cbs,
            "efet_cbs": efet_cbs,
            "cbs": _f(cbs.get("vCBS")),
            "aliq_ibs_uf": _numero(uf.get("pIBSUF")),
            "efet_ibs_uf": efet_uf,
            "ibs_uf": _f(uf.get("vIBSUF")),
            "aliq_ibs_mun": _numero(mun.get("pIBSMun")),
            "efet_ibs_mun": efet_mun,
            "ibs_mun": _f(mun.get("vIBSMun")),
            "ibs": _f(g.get("vIBS")),
            "is": _f(is_.get("vIS")),
            "erros": "; ".join(str(e) for e in erros if e),
            "memoria": memoria_calculo(trib),
        }
        linha["red_ibs"] = red_uf if red_uf is not None else red_mun
        linha["total"] = round(linha["cbs"] + linha["ibs"] + linha["is"], 2)
        linhas.append(linha)
    return linhas


def totais(resposta: dict) -> dict:
    """Totais da operação (só os itens calculados entram)."""
    t = (resposta.get("total") or {}).get("tribCalc") or {}
    ibscbs = t.get("IBSCBSTot") or {}
    g_ibs = ibscbs.get("gIBS") or {}
    tot = {
        "base": _f(ibscbs.get("vBCIBSCBS")),
        "cbs": _f((ibscbs.get("gCBS") or {}).get("vCBS")),
        "ibs": _f(g_ibs.get("vIBS")),
        "ibs_uf": _f((g_ibs.get("gIBSUF") or {}).get("vIBSUF")),
        "ibs_mun": _f((g_ibs.get("gIBSMun") or {}).get("vIBSMun")),
        "is": _f((t.get("ISTot") or {}).get("vIS")),
    }
    tot["total"] = round(tot["cbs"] + tot["ibs"] + tot["is"], 2)
    return tot


# ---------------------------------------------------------------- relatório em PDF

def moeda(v: Any) -> str:
    return "R$ " + f"{float(v or 0):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def pct(v: Any) -> str:
    return "" if v is None else f"{float(v):.4f}".rstrip("0").rstrip(".").replace(".", ",") + "%"


def _esc(txt: Any) -> str:
    import html as _html
    return _html.escape(str(txt if txt is not None else ""))


def gerar_pdf(operacao: dict, resposta: dict, municipio_nome: str = "", versao_rf: Optional[dict] = None,
              aviso: Any = None, escritorio: str = "") -> bytes:
    """Relatório do cálculo (A4 deitado): parâmetros da operação, totais,
    itens, inconsistências e memória de cálculo. Montado com o PyMuPDF (já
    é dependência do Hub), a partir de HTML."""
    import io
    import pymupdf

    linhas = linhas_resultado(resposta)
    tot = totais(resposta)
    codigos = {i["numero"]: (i.get("ncm") or i.get("nbs") or "") for i in operacao.get("itens") or []}
    try:
        data_fato = datetime.fromisoformat(operacao["dhFatoGerador"]).strftime("%d/%m/%Y")
    except (KeyError, ValueError):
        data_fato = ""
    aliq = (operacao.get("itens") or [{}])[0].get("aliquotasNominais")
    simulado = bool(aviso) or any(l["situacao"] == ESTADOS["CALCULO_SIMULADO"] for l in linhas)
    agora = datetime.now(FUSO).strftime("%d/%m/%Y %H:%M")

    css = """
    * {font-family: sans-serif;}
    body {font-size: 9pt; color: #1e293b;}
    h1 {font-size: 16pt; color: #0f172a; margin: 0 0 2pt 0;}
    h2 {font-size: 11pt; color: #0f766e; margin: 12pt 0 4pt 0; border-bottom: 1px solid #99f6e4;}
    .sub {color: #64748b; font-size: 8.5pt; margin-bottom: 6pt;}
    table {border-collapse: collapse; width: 100%;}
    th {background-color: #0f766e; color: #ffffff; font-size: 8pt; padding: 3pt; text-align: left;}
    td {border-bottom: 1px solid #e2e8f0; padding: 3pt; font-size: 8.5pt;}
    td.n, th.n {text-align: right;}
    .tot td {font-size: 10pt; padding: 4pt;}
    .tot b {font-size: 11pt;}
    .aviso {color: #92400e; background-color: #fef3c7; padding: 4pt; font-size: 8.5pt;}
    .erro {color: #991b1b; font-size: 8.5pt;}
    .mem {font-size: 8.5pt; margin: 2pt 0 2pt 0;}
    .rod {color: #64748b; font-size: 7.5pt; margin-top: 12pt;}
    """
    p = [f"<h1>Calculadora RTC — Regime Regular</h1>"
         f"<div class='sub'>CBS, IBS e Imposto Seletivo (LC 214/2025) · gerado em {agora}"
         + (f" · {_esc(escritorio)}" if escritorio else "") + "</div>"]

    p.append("<h2>Operação</h2>"
             f"<p class='mem'><b>Data do fato gerador:</b> {_esc(data_fato)}</p>"
             f"<p class='mem'><b>Local:</b> {_esc(municipio_nome)} ({_esc(operacao.get('municipio'))}) — "
             f"{_esc(operacao.get('uf'))}</p>")
    if aliq:
        p.append(f"<p class='mem'><b>Alíquotas informadas:</b> CBS {pct(aliq.get('cbs'))} · "
                 f"IBS estadual {pct(aliq.get('ibsEstadual'))} · IBS municipal {pct(aliq.get('ibsMunicipal'))}</p>")
    if simulado:
        p.append("<p class='aviso'>Resultado simulado: calculado com alíquotas informadas, ainda não publicadas "
                 "oficialmente pela Receita.</p>")

    p.append("<h2>Totais</h2><table class='tot'><tr>"
             f"<td>Base de cálculo<br/><b>{moeda(tot['base'])}</b></td>"
             f"<td>CBS<br/><b>{moeda(tot['cbs'])}</b></td>"
             f"<td>IBS<br/><b>{moeda(tot['ibs'])}</b><br/>UF {moeda(tot['ibs_uf'])} · Mun {moeda(tot['ibs_mun'])}</td>"
             f"<td>Imposto Seletivo<br/><b>{moeda(tot['is'])}</b></td>"
             f"<td>Total dos tributos<br/><b>{moeda(tot['total'])}</b></td></tr></table>")

    cab = ["Item", "NCM/NBS", "CST", "cClassTrib", "Situação", "Base", "CBS %", "Red. %", "CBS",
           "IBS UF %", "IBS UF", "IBS Mun %", "IBS Mun", "IS", "Total"]
    numericas = {"Base", "CBS %", "Red. %", "CBS", "IBS UF %", "IBS UF", "IBS Mun %", "IBS Mun", "IS", "Total"}
    p.append("<h2>Itens</h2><table><tr>" + "".join(
        f"<th class='{'n' if c in numericas else ''}'>{c}</th>" for c in cab) + "</tr>")
    for l in linhas:
        efet = lambda e, a: pct(e if e is not None else a)
        celulas = [l["item"], codigos.get(l["item"], ""), l["cst"], l["cClassTrib"], l["situacao"], moeda(l["base"]),
                   efet(l["efet_cbs"], l["aliq_cbs"]), pct(l["red_cbs"]), moeda(l["cbs"]),
                   efet(l["efet_ibs_uf"], l["aliq_ibs_uf"]), moeda(l["ibs_uf"]),
                   efet(l["efet_ibs_mun"], l["aliq_ibs_mun"]), moeda(l["ibs_mun"]), moeda(l["is"]), moeda(l["total"])]
        p.append("<tr>" + "".join(f"<td class='{'n' if c in numericas else ''}'>{_esc(v)}</td>"
                                  for c, v in zip(cab, celulas)) + "</tr>")
    p.append("</table>")

    erros = [l for l in linhas if l["erros"]]
    if erros:
        p.append("<h2>Itens com inconsistência</h2>")
        p += [f"<p class='erro'><b>Item {l['item']}:</b> {_esc(l['erros'])}</p>" for l in erros]

    p.append("<h2>Memória de cálculo</h2>")
    tem_memoria = False
    for l in linhas:
        if l["memoria"]:
            tem_memoria = True
            p.append(f"<p class='mem'><b>Item {l['item']}</b></p>")
            p += [f"<p class='mem'><b>{_esc(r)}:</b> {_esc(t)}</p>" for r, t in l["memoria"]]
    if not tem_memoria:
        p.append("<p class='mem'>A calculadora não devolveu memória de cálculo para estes itens.</p>")

    v = versao_rf or {}
    p.append("<p class='rod'>Cálculo feito pela calculadora oficial da Receita Federal "
             f"(calculadora-rtc-regime-regular {_esc(v.get('versaoApp', ''))}, tabelas {_esc(v.get('versaoDb', ''))}"
             f" de {_esc(v.get('dataVersaoDb', ''))}) · Hub APP — Calculadora RTC {VERSAO}. "
             "Documento de simulação, sem valor fiscal.</p>")

    html = f"<html><head><style>{css}</style></head><body>{''.join(p)}</body></html>"
    buf = io.BytesIO()
    escritor = pymupdf.DocumentWriter(buf)
    historia = pymupdf.Story(html=html)
    pagina = pymupdf.paper_rect("a4-l")
    area = pagina + (28, 28, -28, -28)
    mais = True
    while mais:
        dispositivo = escritor.begin_page(pagina)
        mais, _ = historia.place(area)
        historia.draw(dispositivo)
        escritor.end_page()
    escritor.close()
    return buf.getvalue()

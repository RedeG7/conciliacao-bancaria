"""Calculadora RTC - Simples Nacional (CBS e IBS do optante, LC 214/2025 e
NT 2026.005).

O cálculo NÃO é feito aqui: quem calcula é a calculadora oficial da Receita
Federal (repo ReceitaFederal/calculadora-rtc-simples-nacional, API Java com o
banco das tabelas oficiais - atividades do Simples, anexos, cClassTrib,
NCM/NBS), que roda no VPS como o serviço "calculadora-rtc-sn" do
docker-compose (imagem montada a partir de calculadora-rtc-sn/Dockerfile).
Este módulo só monta o pedido, chama a API e organiza a resposta para a tela
(_tela_calculadora_rtc_sn em app_conciliacao.py).

Usamos o cálculo "não assistido": o usuário informa as alíquotas efetivas de
CBS e IBS de cada anexo no período (as do PGDAS-D) e a calculadora escolhe o
par de alíquotas de cada item pela atividade (cAtivSN), pelo fator "r" e pela
situação do ISS. O "assistido" busca essas alíquotas no PGDAS pelo CNPJ e só
existe na versão online da Receita.

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
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from calculadora_rtc import ErroCalculadora, mensagem_de_erro, so_digitos

# Versão do app, mostrada na tela. A cada atualização: suba VERSAO e
# acrescente a entrada no topo de NOVIDADES (o teste confere que batem).
# A versão da calculadora da Receita (motor e banco de tabelas) é outra e
# aparece na tela lida da própria API (/versao); para trocar, mude SN_REF /
# RTC_REF em calculadora-rtc-sn/Dockerfile.
VERSAO = "1.1"
NOVIDADES = [
    ("1.1", "22/11/2026", [
        "Relatório em PDF (operação, alíquotas efetivas informadas, totais, itens, avisos e memória de "
        "cálculo), igual ao do Regime Regular, no lugar do download em JSON.",
        "Botão Limpar para começar um cálculo novo.",
    ]),
    ("1.0", "22/11/2026", [
        "Novo app no RPA Fiscal: Calculadora RTC - Simples Nacional, com a calculadora oficial da Receita "
        "Federal (versão 1.0.2) rodando na VPS.",
        "CBS e IBS do optante pelo Simples por item, a partir das alíquotas efetivas do período (PGDAS-D): "
        "anexo pela atividade, fator \"r\", sublimite, ISS retido/isento na NFS-e, compra governamental, "
        "valores pendentes/suspensos e memória de cálculo.",
        "NF-e, NFC-e, NFS-e, CT-e, CT-e OS, BP-e, BP-e TM e NFCom.",
        "Consulta das atividades do Simples Nacional (anexo, fator \"r\" e documentos aceitos) na data escolhida.",
    ]),
]

URL_PADRAO = "http://calculadora-rtc-sn:8082/api"
TIMEOUT_S = 30
INICIO = date(2027, 1, 1)  # CBS/IBS no Simples começam em 2027 (antes a API recusa)

# Documentos aceitos pelo cálculo do Simples (tpDoc). NFS-e usa o vocabulário
# próprio do regime (opSimpNac etc.) e tem um item só; os outros usam o CRT.
DOCUMENTOS = {
    "55": "NF-e (55)",
    "65": "NFC-e (65)",
    "91": "NFS-e (91)",
    "57": "CT-e (57)",
    "67": "CT-e OS (67)",
    "63": "BP-e (63)",
    "93": "BP-e TM (93)",
    "62": "NFCom (62)",
}
NFSE = "91"

# Regime do emitente nos documentos com CRT: rótulo -> (CRT, tpRegimeIBSCBS)
REGIMES_CRT = {
    "Simples Nacional (CRT 1)": ("1", None),
    "Simples Nacional — excesso de sublimite (CRT 2)": ("2", None),
    "Optante que escolheu o regime regular do IBS/CBS (só receita)": ("1", "1"),
    "Regime Normal com opção pelo Simples pendente (CRT 3)": ("3", "2"),
}
# NFS-e
OP_SIMP_NAC = {"3": "ME/EPP optante do Simples", "4": "Opção pelo Simples pendente"}
REG_AP_IBSCBS = {
    "1": "IBS e CBS pelo Simples",
    "2": "CBS pelo Simples e IBS pelo regime regular (sublimite)",
    "3": "IBS e CBS pelo regime regular (só receita)",
}
REG_AP_TRIB = {
    "1": "Federais e ISS pelo Simples",
    "2": "Federais pelo Simples, ISS fora dele",
    "3": "Federais e ISS fora do Simples",
}
TRIB_ISSQN = {"1": "Operação tributável", "2": "Imunidade", "3": "Exportação de serviço", "4": "Não incidência"}
TP_RET_ISSQN = {"1": "Não retido", "2": "Retido pelo tomador", "3": "Retido pelo intermediário"}
TP_BM = {"": "Sem benefício", "1": "Isenção", "2": "Redução da base (%)", "3": "Redução da base (R$)",
         "4": "Alíquota diferenciada"}
ENTE_GOV = {"": "Não é compra governamental", "1": "União", "2": "Estado", "3": "Distrito Federal",
            "4": "Município"}

ANEXOS = ("I", "II", "III", "IV", "V")
ANEXOS_COM_ISS = ("III", "IV", "V")
ATIVIDADE_FATOR_R = "09"

# Situação do item -> rótulo da tela
ESTADOS = {
    "CALCULADO": "Calculado",
    "NAO_CALCULADO": "Não calculado",
    "INCONSISTENCIA_ENTRADA": "Erro nos dados",
    "NAO_IMPLEMENTADO": "Não implementado",
    "FALHA_TECNICA": "Falha técnica",
}
# Como a calculadora escolheu o par de alíquotas do item
REGRAS = {
    "DOCUMENTO": "Atividade não aceita no documento",
    "ATIVIDADE_NAO_TRIBUTADA": "Atividade sem anexo",
    "ANEXO_SEM_ISS": "Anexo sem ISS (par único)",
    "ISS_FORA_DO_SIMPLES": "ISS fora do Simples (sem redistribuição)",
    "ATIVIDADE_SEM_ISS": "Atividade sem ISS no Simples (sem redistribuição)",
    "ISS_NAO_INCIDE": "ISS não incide (sem redistribuição)",
    "ISENCAO_MUNICIPAL": "Isenção municipal do ISS (sem redistribuição)",
    "ISS_RETIDO": "ISS retido (sem redistribuição)",
    "PADRAO": "Com redistribuição do ISS",
}


def url_base() -> str:
    return (os.environ.get("CALCULADORA_RTC_SN_URL") or URL_PADRAO).rstrip("/")


def _requisitar(metodo: str, caminho: str, params: Optional[dict] = None, corpo: Any = None) -> Any:
    url = url_base() + caminho
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}, doseq=True)
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    req = urllib.request.Request(url, data=dados, method=metodo,
                                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            bruto = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        bruto = e.read().decode("utf-8", errors="replace")
        try:
            corpo_erro = json.loads(bruto)
        except ValueError:
            corpo_erro = bruto
        raise ErroCalculadora(mensagem_de_erro(corpo_erro) or f"HTTP {e.code}", e.code, corpo_erro) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ErroCalculadora(f"Calculadora da Receita fora do ar ({getattr(e, 'reason', e)}).") from None
    return json.loads(bruto) if bruto.strip() else None


# ---------------------------------------------------------------- consultas

def versao() -> dict:
    return _requisitar("GET", "/versao") or {}


def atividades(data: date, tp_doc: Optional[str] = None) -> list[dict]:
    """Atividades do Simples (cAtivSN) vigentes na data, com anexo, fator "r"
    e os documentos em que cada uma é aceita. Com tp_doc, a API marca
    admissivelNoDocumento."""
    lista = _requisitar("GET", "/calculadora/simples-nacional/atividades",
                        {"data": data.isoformat(), "tpDoc": tp_doc}) or []
    return sorted(lista, key=lambda a: a.get("ordem", 0))


def atividades_do_documento(catalogo: list[dict], tp_doc: str) -> list[dict]:
    """Só as atividades aceitas no documento (sem lista = aceita em todos)."""
    return [a for a in catalogo if not a.get("tpDocsAdmissiveis") or tp_doc in a["tpDocsAdmissiveis"]]


def rotulo_atividade(a: dict) -> str:
    return f"{a.get('codigo', '')} — {a.get('descricao', '')}"


def anexo_da_atividade(a: dict, fator_r: Optional[bool]) -> Optional[str]:
    """Anexo usado pela atividade: nas sujeitas ao fator "r" (09), III com
    fator >= 28% e V abaixo; sem fator informado, os dois podem servir."""
    if a.get("sujeitaFatorR"):
        if fator_r is None:
            return None
        return a.get("anexoComFatorR") if fator_r else a.get("anexoSemFatorR")
    return a.get("anexoSemFatorR")


def anexos_usados(codigos: list[str], catalogo: list[dict], fator_r: Optional[bool]) -> list[str]:
    """Anexos que as atividades dos itens vão usar, na ordem I..V (os que
    precisam de alíquota no pedido)."""
    por_codigo = {a.get("codigo"): a for a in catalogo}
    usados = set()
    for c in codigos:
        a = por_codigo.get(c)
        if not a:
            continue
        anexo = anexo_da_atividade(a, fator_r)
        if anexo:
            usados.add(anexo)
        elif a.get("sujeitaFatorR"):
            usados.update(x for x in (a.get("anexoComFatorR"), a.get("anexoSemFatorR")) if x)
    return [x for x in ANEXOS if x in usados]


# ---------------------------------------------------------------- montagem do pedido

def _numero(v: Any) -> Optional[Decimal]:
    if v is None or v == "":
        return None
    try:
        if isinstance(v, str):
            v = v.strip().replace(".", "").replace(",", ".") if "," in v else v.strip()
        n = Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None
    return None if n.is_nan() else n  # NaN: célula vazia no data_editor


def _aliquota(v: Any) -> Optional[str]:
    """Alíquota em pontos percentuais, como texto sem notação científica."""
    n = _numero(v)
    if n is None:
        return None
    txt = format(n.normalize(), "f")
    return txt if "." in txt else txt + ".0"


def _valor(v: Any) -> Optional[str]:
    n = _numero(v)
    return None if n is None else f"{n.quantize(Decimal('0.01')):f}"


def codigo_atividade(v: Any) -> str:
    """'09 — Prestação de serviços...' -> '09' (um dígito vira '0X')."""
    txt = str(v or "").strip()
    cod = so_digitos(txt.split("—")[0].split("-")[0])[:2]
    return cod.zfill(2) if cod else ""


def regime_calcula(regime: dict) -> bool:
    """False quando o optante apura IBS/CBS pelo regime regular: aí a
    calculadora só devolve a receita bruta, sem pedir alíquotas."""
    if regime.get("opSimpNac"):
        return regime.get("regApIBSCBSSN") != "3"
    return regime.get("tpRegimeIBSCBS") != "1"


def regime_sublimite(regime: dict) -> bool:
    """Excesso de sublimite: o IBS sai do Simples (vai pelo regime regular)."""
    if regime.get("opSimpNac"):
        return regime.get("regApIBSCBSSN") == "2"
    return regime.get("CRT") == "2"


def montar_aliquotas(anexos: dict, fator_r: Optional[bool], sublimite: bool) -> dict:
    """Bloco aliquotasEfetivas. `anexos`: {"I": {"cbs":..,"ibs":..}, "III":
    {"cbs":..,"ibs":..,"cbs_sem":..,"ibs_sem":..}} com as alíquotas efetivas
    do período (PGDAS-D). Com sublimite, o IBS não vai (a API exige nulo)."""
    saida: dict[str, Any] = {"fatorR": fator_r, "impedimentoSublimite": bool(sublimite)}
    for anexo in ANEXOS:
        a = anexos.get(anexo)
        if not a or _aliquota(a.get("cbs")) is None:
            continue
        par = {"pCBSSN": _aliquota(a.get("cbs"))}
        if not sublimite and _aliquota(a.get("ibs")) is not None:
            par["pIBSSN"] = _aliquota(a.get("ibs"))
        if anexo in ANEXOS_COM_ISS and _aliquota(a.get("cbs_sem")) is not None:
            sem = {"pCBSSN": _aliquota(a.get("cbs_sem"))}
            if not sublimite and _aliquota(a.get("ibs_sem")) is not None:
                sem["pIBSSN"] = _aliquota(a.get("ibs_sem"))
            par["semRedistribuicaoISS"] = sem
        saida["anexo" + anexo] = par
    return saida


def montar_operacao(data_fato: date, tp_doc: str, regime: dict, itens: list[dict],
                    aliquotas: Optional[dict] = None, tp_ente_gov: Optional[str] = None) -> dict:
    """Corpo do POST .../simples-nacional/nao-assistido.

    `regime`: CRT e tpRegimeIBSCBS (documentos com CRT) ou opSimpNac,
    regApIBSCBSSN e regApTribSN (NFS-e) - os vazios não vão.
    `itens`: dicts com atividade (cAtivSN ou o rótulo do catálogo),
    cClassTrib, codigo (NCM 8 / NBS 9 dígitos), base, vis (Imposto Seletivo
    já calculado) e, na NFS-e, tribISSQN, tpRetISSQN e tpBM. Linhas sem
    cClassTrib ou sem base são ignoradas; na NFS-e vai só o primeiro item.
    `aliquotas`: saída de montar_aliquotas (fica de fora quando o regime só
    apura a receita)."""
    nfse = tp_doc == NFSE
    saida = []
    for it in itens:
        cclass = so_digitos(it.get("cClassTrib"))[:6]
        base = _valor(it.get("base"))
        if len(cclass) != 6 or base is None:
            continue
        item: dict[str, Any] = {"numero": len(saida) + 1, "cClassTrib": cclass, "baseCalculo": base}
        ativ = codigo_atividade(it.get("atividade"))
        if ativ:
            item["cAtivSN"] = ativ
        codigo = so_digitos(it.get("codigo"))
        if len(codigo) == 8:
            item["ncm"] = codigo
        elif len(codigo) == 9:
            item["nbs"] = codigo
        if nfse:
            for campo in ("tribISSQN", "tpRetISSQN", "tpBM"):
                v = so_digitos(it.get(campo))[:1]
                if v:
                    item[campo] = v
        else:
            item["valorImpostoSeletivo"] = _valor(it.get("vis")) or "0.00"
        saida.append(item)
        if nfse:
            break  # a NFS-e tem exatamente um item
    op: dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "versao": "3.0.0",
        "data": data_fato.isoformat(),
        "tpDoc": tp_doc,
    }
    campos = ("opSimpNac", "regApIBSCBSSN", "regApTribSN") if nfse else ("CRT", "tpRegimeIBSCBS")
    op.update({c: regime[c] for c in campos if regime.get(c)})
    if tp_ente_gov:
        op["tpEnteGov"] = tp_ente_gov
    if aliquotas and regime_calcula(regime):
        op["aliquotasEfetivas"] = aliquotas
    op["itens"] = saida
    return op


def calcular(operacao: dict) -> dict:
    """Cálculo com observabilidade (um item com erro não derruba os outros;
    erro na operação inteira - documento, regime, alíquotas - volta como
    ErroCalculadora com status 422)."""
    return _requisitar("POST", "/calculadora/observabilidade/simples-nacional/nao-assistido", corpo=operacao) or {}


# ---------------------------------------------------------------- leitura da resposta

def _f(v: Any) -> float:
    n = _numero(v)
    return float(n) if n is not None else 0.0


def _p(v: Any) -> Optional[float]:
    n = _numero(v)
    return None if n is None else float(n)


def linhas_resultado(resposta: dict) -> list[dict]:
    """Uma linha por item, juntando o cálculo (objetos) com a escolha das
    alíquotas (resolucaoAliquotas)."""
    resolucao = {r.get("numero"): r for r in (resposta.get("resolucaoAliquotas") or {}).get("itens") or []}
    linhas = []
    for obj in resposta.get("objetos") or []:
        t = obj.get("tribCalc") or {}
        r = resolucao.get(obj.get("nObj")) or {}
        motivo = (obj.get("motivoEstado") or {}).get("descricao") or ""
        erros = [e.get("detail") or e.get("title") or e.get("code") for e in obj.get("erros") or []]
        mem = t.get("memoriaCalculo") or {}
        linha = {
            "item": obj.get("nObj"),
            "estado": obj.get("estadoItem") or "",
            "situacao": ESTADOS.get(obj.get("estadoItem"), obj.get("estadoItem") or ""),
            "atividade": r.get("cAtivSN") or "",
            "anexo": r.get("anexoAplicado") or "",
            "regra": REGRAS.get(r.get("regraAliquota"), r.get("regraAliquota") or ""),
            "tipo_receita": t.get("tpRBSNDescricao") or "",
            "receita": _f(t.get("vRBSNitem")),
            "base": _f(t.get("vBC")),
            "aliq_cbs": _p(t.get("pCBSSN")),
            "cbs": _f(t.get("vCBSSN")),
            "cbs_pend": _f(t.get("vCBSPendSusp")),
            "aliq_ibs": _p(t.get("pIBSSN")),
            "ibs": _f(t.get("vIBSSN")),
            "ibs_pend": _f(t.get("vIBSPendSusp")),
            "is": _f((t.get("IS") or {}).get("valor")),
            "total": _f(t.get("totalItem")),
            "motivo": motivo,
            "avisos": list(r.get("avisos") or []),
            "erros": "; ".join(str(e) for e in erros if e),
            "memoria": [(rotulo, mem[chave]) for rotulo, chave in (("CBS", "cbs"), ("IBS", "ibs")) if mem.get(chave)],
        }
        linhas.append(linha)
    return linhas


def totais(resposta: dict) -> dict:
    """Totais da operação: receita bruta soma os itens calculados e os não
    calculados; base e tributos, só os calculados."""
    t = resposta.get("total") or {}
    return {
        "receita": _f(t.get("vRBSNtot")),
        "base": _f(t.get("vBC")),
        "cbs": _f(t.get("vCBSSNtot")),
        "cbs_pend": _f(t.get("vCBSSNtotPendSusp")),
        "ibs": _f(t.get("vIBSSNtot")),
        "ibs_pend": _f(t.get("vIBSSNtotPendSusp")),
        "is": _f(t.get("totalIs")),
        "total": _f(t.get("totalTributos")),
    }


def avisos_gerais(resposta: dict) -> list[str]:
    return list((resposta.get("resolucaoAliquotas") or {}).get("avisos") or [])


# ---------------------------------------------------------------- relatório em PDF

def descricao_regime(operacao: dict) -> str:
    """Regime do emitente em texto, a partir do que foi no pedido."""
    if operacao.get("opSimpNac"):
        return (f"{OP_SIMP_NAC.get(operacao['opSimpNac'], operacao['opSimpNac'])} · IBS/CBS: "
                f"{REG_AP_IBSCBS.get(operacao.get('regApIBSCBSSN'), '')} · Federais/ISS: "
                f"{REG_AP_TRIB.get(operacao.get('regApTribSN'), '')}")
    chave = (operacao.get("CRT"), operacao.get("tpRegimeIBSCBS"))
    return next((r for r, v in REGIMES_CRT.items() if v == chave), f"CRT {operacao.get('CRT', '')}")


def gerar_pdf(operacao: dict, resposta: dict, versao_rf: Optional[dict] = None, escritorio: str = "") -> bytes:
    """Relatório do cálculo (A4 deitado): operação, alíquotas efetivas
    informadas, totais, itens, itens não calculados/com inconsistência e
    memória de cálculo. Mesmo modelo do relatório do Regime Regular
    (calculadora_rtc.gerar_pdf), com PyMuPDF a partir de HTML."""
    import io
    from datetime import datetime

    import pymupdf

    from calculadora_rtc import FUSO, _esc, moeda, pct

    linhas = linhas_resultado(resposta)
    tot = totais(resposta)
    nfse = operacao.get("tpDoc") == NFSE
    codigos = {i["numero"]: (i.get("ncm") or i.get("nbs") or "") for i in operacao.get("itens") or []}
    try:
        data_fato = date.fromisoformat(operacao["data"]).strftime("%d/%m/%Y")
    except (KeyError, ValueError):
        data_fato = ""
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
    p = ["<h1>Calculadora RTC — Simples Nacional</h1>"
         f"<div class='sub'>CBS e IBS do optante pelo Simples (LC 214/2025, NT 2026.005) · gerado em {agora}"
         + (f" · {_esc(escritorio)}" if escritorio else "") + "</div>"]

    p.append("<h2>Operação</h2>"
             f"<p class='mem'><b>Data do fato gerador:</b> {_esc(data_fato)}</p>"
             f"<p class='mem'><b>Documento:</b> {_esc(DOCUMENTOS.get(operacao.get('tpDoc'), operacao.get('tpDoc')))}</p>"
             f"<p class='mem'><b>Regime do emitente:</b> {_esc(descricao_regime(operacao))}</p>")
    if operacao.get("tpEnteGov"):
        p.append(f"<p class='mem'><b>Compra governamental:</b> {_esc(ENTE_GOV.get(operacao['tpEnteGov'], ''))}</p>")

    aliq = operacao.get("aliquotasEfetivas")
    if aliq:
        extras = []
        if aliq.get("fatorR") is not None:
            extras.append("Fator \"r\" de 28% ou mais (Anexo III)" if aliq["fatorR"]
                          else "Fator \"r\" abaixo de 28% (Anexo V)")
        if aliq.get("impedimentoSublimite"):
            extras.append("sublimite excedido (IBS fora do Simples)")
        p.append("<h2>Alíquotas efetivas informadas (PGDAS-D)</h2>")
        if extras:
            p.append(f"<p class='mem'>{_esc('; '.join(extras))}.</p>")
        com_iss = any(aliq.get("anexo" + a) for a in ANEXOS_COM_ISS)
        p.append("<table><tr><th>Anexo</th><th class='n'>CBS</th><th class='n'>IBS</th>"
                 + ("<th class='n'>CBS sem redistribuição do ISS</th><th class='n'>IBS sem redistribuição do ISS</th>"
                    if com_iss else "") + "</tr>")
        for anexo in ANEXOS:
            par = aliq.get("anexo" + anexo)
            if not par:
                continue
            sem = par.get("semRedistribuicaoISS") or {}
            celulas = [pct(par.get("pCBSSN")), pct(par.get("pIBSSN"))]
            if com_iss:
                celulas += [pct(sem.get("pCBSSN")), pct(sem.get("pIBSSN"))]
            p.append(f"<tr><td>{anexo}</td>" + "".join(f"<td class='n'>{_esc(c)}</td>" for c in celulas) + "</tr>")
        p.append("</table>")
    elif not regime_calcula(operacao):
        p.append("<p class='aviso'>O optante apura o IBS e a CBS pelo regime regular: a calculadora devolve só a "
                 "receita bruta do Simples, sem tributos.</p>")

    pend = tot["cbs_pend"] + tot["ibs_pend"]
    terceiro = (f"<td>Pendente/suspenso<br/><b>{moeda(pend)}</b></td>" if nfse or pend
                else f"<td>Imposto Seletivo<br/><b>{moeda(tot['is'])}</b></td>")
    p.append("<h2>Totais</h2><table class='tot'><tr>"
             f"<td>Receita bruta do Simples<br/><b>{moeda(tot['receita'])}</b></td>"
             f"<td>Base de cálculo<br/><b>{moeda(tot['base'])}</b></td>"
             f"<td>CBS<br/><b>{moeda(tot['cbs'])}</b></td>"
             f"<td>IBS<br/><b>{moeda(tot['ibs'])}</b></td>"
             f"{terceiro}"
             f"<td>Total dos tributos<br/><b>{moeda(tot['total'])}</b></td></tr></table>")

    cab = ["Item", "Atividade", "NCM/NBS", "Situação", "Anexo", "Par de alíquotas", "Receita bruta", "Base",
           "CBS %", "CBS", "IBS %", "IBS", "Pend./susp."] + ([] if nfse else ["IS"]) + ["Total"]
    numericas = {"Receita bruta", "Base", "CBS %", "CBS", "IBS %", "IBS", "Pend./susp.", "IS", "Total"}
    p.append("<h2>Itens</h2><table><tr>" + "".join(
        f"<th class='{'n' if c in numericas else ''}'>{c}</th>" for c in cab) + "</tr>")
    for l in linhas:
        celulas = ([l["item"], l["atividade"], codigos.get(l["item"], ""), l["situacao"], l["anexo"], l["regra"],
                    moeda(l["receita"]), moeda(l["base"]), pct(l["aliq_cbs"]), moeda(l["cbs"]), pct(l["aliq_ibs"]),
                    moeda(l["ibs"]), moeda(l["cbs_pend"] + l["ibs_pend"])]
                   + ([] if nfse else [moeda(l["is"])]) + [moeda(l["total"])])
        p.append("<tr>" + "".join(f"<td class='{'n' if c in numericas else ''}'>{_esc(v)}</td>"
                                  for c, v in zip(cab, celulas)) + "</tr>")
    p.append("</table>")

    obs = [l for l in linhas if l["erros"] or l["motivo"] or l["avisos"]]
    gerais = avisos_gerais(resposta)
    if obs or gerais:
        p.append("<h2>Itens não calculados, inconsistências e avisos</h2>")
        p += [f"<p class='aviso'>{_esc(a)}</p>" for a in gerais]
        for l in obs:
            if l["erros"]:
                p.append(f"<p class='erro'><b>Item {l['item']}:</b> {_esc(l['erros'])}</p>")
            if l["motivo"]:
                p.append(f"<p class='mem'><b>Item {l['item']} não calculado:</b> {_esc(l['motivo'])}</p>")
            p += [f"<p class='mem'><b>Item {l['item']}:</b> {_esc(a)}</p>" for a in l["avisos"]]

    p.append("<h2>Memória de cálculo</h2>")
    com_memoria = [l for l in linhas if l["memoria"]]
    for l in com_memoria:
        p.append(f"<p class='mem'><b>Item {l['item']}</b></p>")
        p += [f"<p class='mem'><b>{rotulo}:</b> {_esc(t)}</p>" for rotulo, t in l["memoria"]]
    if not com_memoria:
        p.append("<p class='mem'>A calculadora não devolveu memória de cálculo para estes itens.</p>")

    v = versao_rf or {}
    p.append("<p class='rod'>Cálculo feito pela calculadora oficial da Receita Federal "
             f"(calculadora-rtc-simples-nacional {_esc(v.get('versaoApp', ''))}, tabelas {_esc(v.get('versaoDb', ''))}"
             f" de {_esc(v.get('dataVersaoDb', ''))}) · Hub APP — Calculadora RTC Simples Nacional {VERSAO}. "
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

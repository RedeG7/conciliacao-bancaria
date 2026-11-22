"""Gerador de DANFSe (PDF da NFS-e nacional, NT 008 SE/CGNFS-e).

O PDF NÃO é montado aqui: quem gera é o gerador oficial da Receita Federal
(repo ReceitaFederal/calculadora-rtc-gerador-danfse, serviço HTTP em Go), que
roda no VPS como o serviço "gerador-danfse" do docker-compose (imagem montada
a partir de gerador-danfse/Dockerfile). Este módulo só lê os XMLs enviados
(soltos ou em .zip), tira um resumo de cada nota para a tela, chama a API e
junta os PDFs num .zip. Tela: _tela_gerador_danfse em app_conciliacao.py.

A API não tem login: fica só na rede interna do Docker (sem porta publicada
e sem rota no Caddy) - só o Hub fala com ela.
"""

from __future__ import annotations

import io
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from typing import Any, Optional

# Versão do app, mostrada na tela. A cada atualização: suba VERSAO e
# acrescente a entrada no topo de NOVIDADES (o teste confere que batem).
# A versão do gerador da Receita é outra (MOTOR, igual ao DANFSE_REF de
# gerador-danfse/Dockerfile).
VERSAO = "1.0"
NOVIDADES = [
    ("1.0", "22/11/2026", [
        "Novo app no RPA Fiscal: Gerador de DANFSe, com o gerador oficial da Receita Federal rodando na VPS.",
        "Envie um ou vários XMLs de NFS-e nacional (soltos ou em .zip) e baixe o DANFSe em PDF de cada nota, "
        "um a um ou todos num .zip.",
        "Situação de cada nota (válida, substituída ou cancelada, com a marca d'água do PDF) e opção de "
        "imprimir com ou sem o canhoto.",
    ]),
]
MOTOR = "8d79e6b de 22/10/2026"  # commit do repo da Receita (DANFSE_REF no Dockerfile)

URL_PADRAO = "http://gerador-danfse:8083"
TIMEOUT_S = 60
MAX_XML = 5 * 1024 * 1024        # limite do gerador da Receita (XML_MAX_SIZE_BYTES)
MAX_ARQUIVOS = 500               # por lote (soltos + dentro dos .zip)
MAX_ZIP_TOTAL = 200 * 1024 * 1024  # soma descompactada dos .zip

SITUACOES = {0: "Válida", 1: "Substituída", 2: "Cancelada"}


class ErroDanfse(Exception):
    """Falha ao falar com o gerador (fora do ar, timeout) ou XML recusado.
    `status` é o HTTP (None quando nem chegou a responder)."""

    def __init__(self, mensagem: str, status: Optional[int] = None):
        super().__init__(mensagem)
        self.status = status


def url_base() -> str:
    return (os.environ.get("GERADOR_DANFSE_URL") or URL_PADRAO).rstrip("/")


def _mensagem_erro(bruto: bytes) -> str:
    """O gerador responde erro como {"mensagem": "..."} ou {"message": "..."}."""
    import json
    txt = bruto.decode("utf-8", errors="replace").strip()
    try:
        corpo = json.loads(txt)
    except ValueError:
        return txt[:500]
    if isinstance(corpo, dict):
        for k in ("mensagem", "message", "erro", "error", "detail", "title"):
            if corpo.get(k):
                return str(corpo[k])[:500]
    return txt[:500]


def disponivel() -> bool:
    """True quando o gerador está no ar e pronto (GET /health/ready)."""
    try:
        with urllib.request.urlopen(url_base() + "/health/ready", timeout=5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def gerar_pdf(xml: bytes, situacao: int = 0, canhoto: bool = True) -> bytes:
    """PDF do DANFSe de um XML de NFS-e (POST /api/danfse)."""
    if situacao not in SITUACOES:
        raise ValueError(f"situação inválida: {situacao}")
    params = urllib.parse.urlencode({"stc": situacao, "canhoto": "true" if canhoto else "false"})
    req = urllib.request.Request(f"{url_base()}/api/danfse?{params}", data=xml, method="POST",
                                 headers={"Content-Type": "application/xml", "Accept": "application/pdf"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            pdf = resp.read()
    except urllib.error.HTTPError as e:
        raise ErroDanfse(_mensagem_erro(e.read()) or f"HTTP {e.code}", e.code) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ErroDanfse(f"Gerador de DANFSe fora do ar ({getattr(e, 'reason', e)}).") from None
    if not pdf.startswith(b"%PDF"):
        raise ErroDanfse("O gerador não devolveu um PDF.")
    return pdf


# ---------------------------------------------------------------- leitura dos arquivos

def ler_arquivos(arquivos: list[tuple[str, bytes]]) -> tuple[list[tuple[str, bytes]], list[str]]:
    """Abre os arquivos enviados: .xml entram como estão e .zip são abertos
    (só os .xml de dentro). Devolve ([(nome, xml)], [avisos])."""
    saida: list[tuple[str, bytes]] = []
    avisos: list[str] = []
    for nome, dados in arquivos:
        if nome.lower().endswith(".zip"):
            try:
                zf = zipfile.ZipFile(io.BytesIO(dados))
            except zipfile.BadZipFile:
                avisos.append(f"{nome}: não é um .zip válido.")
                continue
            total = 0
            for info in zf.infolist():
                if info.is_dir() or not info.filename.lower().endswith(".xml"):
                    continue
                interno = info.filename.replace("\\", "/").rsplit("/", 1)[-1]
                if info.file_size > MAX_XML:
                    avisos.append(f"{interno}: maior que 5 MB, ignorado.")
                    continue
                total += info.file_size
                if total > MAX_ZIP_TOTAL or len(saida) >= MAX_ARQUIVOS:
                    avisos.append(f"{nome}: grande demais; envie em partes (até {MAX_ARQUIVOS} notas).")
                    break
                saida.append((interno, zf.read(info)))
        elif nome.lower().endswith(".xml"):
            if len(dados) > MAX_XML:
                avisos.append(f"{nome}: maior que 5 MB, ignorado.")
            elif len(saida) >= MAX_ARQUIVOS:
                avisos.append(f"Limite de {MAX_ARQUIVOS} notas por vez: {nome} ficou de fora.")
            else:
                saida.append((nome, dados))
        else:
            avisos.append(f"{nome}: envie .xml ou .zip.")
    return saida, avisos


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _filho(no: Optional[ET.Element], *caminho: str) -> Optional[ET.Element]:
    for parte in caminho:
        if no is None:
            return None
        no = next((f for f in no if _local(f.tag) == parte), None)
    return no


def _texto(no: Optional[ET.Element], *caminho: str) -> str:
    alvo = _filho(no, *caminho)
    return (alvo.text or "").strip() if alvo is not None else ""


def _numero(txt: str) -> Optional[float]:
    try:
        return float(txt) if txt else None
    except ValueError:
        return None


def _doc(no: Optional[ET.Element]) -> str:
    return _texto(no, "CNPJ") or _texto(no, "CPF") or _texto(no, "NIF")


def resumo(xml: bytes) -> dict:
    """Dados da nota para a tela e o nome do PDF. `erro` preenchido quando o
    arquivo não é um XML de NFS-e nacional (aí nem vai para o gerador)."""
    r: dict[str, Any] = {"numero": "", "chave": "", "emissao": "", "competencia": "", "prestador": "",
                         "doc_prestador": "", "tomador": "", "doc_tomador": "", "municipio": "",
                         "valor": None, "erro": ""}
    if re.search(rb"<!\s*(DOCTYPE|ENTITY)", xml[:4096], re.IGNORECASE):
        r["erro"] = "XML com DOCTYPE/ENTITY (recusado por segurança)."
        return r
    try:
        raiz = ET.fromstring(xml)
    except ET.ParseError as e:
        linha = getattr(e, "position", (None,))[0]
        r["erro"] = "XML inválido ou incompleto" + (f" (linha {linha})." if linha else ".")
        return r
    nfse = raiz if _local(raiz.tag) == "NFSe" else next((n for n in raiz.iter() if _local(n.tag) == "NFSe"), None)
    inf = _filho(nfse, "infNFSe")
    if inf is None:
        r["erro"] = "Não é XML de NFS-e nacional (falta NFSe/infNFSe)."
        return r
    if nfse is not raiz:
        r["erro"] = "A NFSe está dentro de outro elemento; envie o XML da NFS-e (raiz NFSe)."
    dps = _filho(inf, "DPS", "infDPS")
    emit = _filho(inf, "emit")
    toma = _filho(dps, "toma")
    r.update({
        "numero": _texto(inf, "nNFSe"),
        "chave": re.sub(r"^NFS", "", inf.get("Id") or ""),
        "emissao": _texto(dps, "dhEmi")[:10] or _texto(inf, "dhProc")[:10],
        "competencia": _texto(dps, "dCompet"),
        "prestador": _texto(emit, "xNome"),
        "doc_prestador": _doc(emit),
        "tomador": _texto(toma, "xNome"),
        "doc_tomador": _doc(toma),
        "municipio": _texto(inf, "xLocEmi"),
        "valor": _numero(_texto(dps, "valores", "vServPrest", "vServ")) or _numero(_texto(inf, "valores", "vLiq")),
    })
    return r


def _limpo(txt: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "_", txt).strip("_")


def nome_pdf(r: dict, nome_xml: str) -> str:
    """DANFSe_<número>_<CNPJ do prestador>.pdf; sem número, o nome do XML."""
    if r.get("numero"):
        partes = ["DANFSe", r["numero"]] + ([r["doc_prestador"]] if r.get("doc_prestador") else [])
        return _limpo("_".join(partes)) + ".pdf"
    base = nome_xml.rsplit(".", 1)[0]
    return (_limpo(base) or "DANFSe") + ".pdf"


def nomes_unicos(nomes: list[str]) -> list[str]:
    """Acrescenta (2), (3)... aos nomes repetidos, para não sobrescrever no .zip."""
    vistos: dict[str, int] = {}
    saida = []
    for n in nomes:
        vistos[n] = vistos.get(n, 0) + 1
        if vistos[n] == 1:
            saida.append(n)
        else:
            base, ext = n.rsplit(".", 1)
            saida.append(f"{base} ({vistos[n]}).{ext}")
    return saida


def zip_pdfs(pdfs: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for nome, pdf in pdfs:
            zf.writestr(nome, pdf)
    return buf.getvalue()


def moeda(v: Any) -> str:
    if v is None:
        return ""
    return f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def data_br(iso: str) -> str:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", iso or "")
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else (iso or "")


def documento_fmt(doc: str) -> str:
    d = re.sub(r"\D", "", doc or "")
    if len(d) == 14:
        return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"
    if len(d) == 11:
        return f"{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}"
    return doc or ""

"""Minuta revisada no mesmo layout do arquivo original (Hub Societário).

- Word (.docx): as sugestões aceitas trocam só o texto dos trechos dentro
  do próprio document.xml; estilos, fontes, tabelas, cabeçalho, rodapé,
  numeração e margens ficam como estavam. O XML é editado como texto (sem
  reserializar), para o Word não estranhar prefixos e namespaces.
- PDF original: cada trecho é coberto e reescrito no mesmo lugar (PyMuPDF),
  com a fonte reduzida se a correção for mais comprida.
- PDF a partir do Word: conversão pelo LibreOffice (instalado na imagem do
  Hub). Sem LibreOffice, `docx_para_pdf` avisa com ErroConversao.
"""
from __future__ import annotations

import html
import io
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from typing import Optional

# w:p (parágrafo), w:t (texto), w:tab / w:br / w:cr (tabulação e quebras) e
# w:tabs (definição das paradas de tabulação, que não são texto)
_TOKEN = re.compile(r"<(/?)w:(p|t|tab|tabs|br|cr)(?=[\s/>])([^>]*?)(/?)>")


class ErroConversao(Exception):
    pass


def _paragrafos(xml: str) -> list[list[dict]]:
    """Parágrafos do document.xml na ordem em que abrem. Cada um é a lista
    de pedaços: {'tipo': 't', 'texto', 'ini', 'fim'} para texto editável
    (ini/fim = posição do <w:t>...</w:t> inteiro no XML) ou {'tipo': 'x',
    'texto'} para tabulação/quebra de linha."""
    resultado: list[list[dict]] = []
    pilha: list[list[dict]] = []
    em_tabs = 0
    pos = 0
    while True:
        m = _TOKEN.search(xml, pos)
        if not m:
            break
        fecha, nome, auto = m.group(1) == "/", m.group(2), m.group(4) == "/"
        pos = m.end()
        if nome == "p":
            if fecha:
                if pilha:
                    pilha.pop()
            else:
                novo: list[dict] = []
                resultado.append(novo)
                if not auto:
                    pilha.append(novo)
        elif nome == "tabs":
            if not auto:
                em_tabs += -1 if fecha else 1
        elif nome == "t":
            if fecha or auto:
                continue
            fim = xml.find("</w:t>", m.end())
            if fim < 0:
                break
            if pilha:
                pilha[-1].append({"tipo": "t", "texto": html.unescape(xml[m.end():fim]),
                                  "ini": m.start(), "fim": fim + len("</w:t>")})
            pos = fim + len("</w:t>")
        elif not fecha and pilha and not em_tabs:  # tab, br, cr
            pilha[-1].append({"tipo": "x", "texto": "\t" if nome == "tab" else "\n"})
    return resultado


def texto_docx(dados: bytes) -> str:
    """Texto do Word, um parágrafo por linha (o que a IA lê e onde os
    trechos dos apontamentos são procurados)."""
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    return "\n".join("".join(s["texto"] for s in p) for p in _paragrafos(xml)).strip()


def _wt(texto: str) -> str:
    partes = [html.escape(l, quote=False) for l in texto.split("\n")]
    return '<w:t xml:space="preserve">' + '</w:t><w:br/><w:t xml:space="preserve">'.join(partes) + "</w:t>"


def _trocar(xml: str, trecho: str, sugestao: str) -> Optional[str]:
    """XML com a primeira ocorrência de `trecho` (dentro de um parágrafo)
    trocada por `sugestao`, mantendo a formatação do primeiro pedaço do
    trecho. None se não achar ou se o trecho atravessar tabulação/quebra."""
    for par in _paragrafos(xml):
        texto = "".join(s["texto"] for s in par)
        ini = texto.find(trecho)
        if ini < 0:
            continue
        fim = ini + len(trecho)
        edicoes = []  # (ini, fim, novo) no XML
        cur, primeiro = 0, True
        for s in par:
            a, b = cur, cur + len(s["texto"])
            cur = b
            if b <= ini or a >= fim or (a == b):
                continue
            if s["tipo"] == "x":
                return None
            antes = s["texto"][:max(ini - a, 0)]
            depois = s["texto"][min(fim - a, len(s["texto"])):] if b > fim else ""
            miolo = sugestao if primeiro else ""
            primeiro = False
            abre = xml[s["ini"]:xml.index(">", s["ini"]) + 1]
            novo = antes + miolo + depois
            if "\n" in novo or "xml:space" not in abre:
                trecho_xml = _wt(novo)
            else:
                trecho_xml = abre + html.escape(novo, quote=False) + "</w:t>"
            edicoes.append((s["ini"], s["fim"], trecho_xml))
        if primeiro:  # trecho só em pedaços vazios: não há o que trocar
            return None
        for a, b, novo in reversed(edicoes):
            xml = xml[:a] + novo + xml[b:]
        return xml
    return None


def aplicar_no_docx(dados: bytes, apontamentos: list[dict]) -> tuple[bytes, list[dict]]:
    """Word original com as sugestões ACEITAS aplicadas no lugar. Devolve o
    arquivo e os aceitos que não deu para aplicar sozinho (trecho vazio, não
    encontrado ou que passa de um parágrafo para outro)."""
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        itens = [(i, z.read(i.filename)) for i in z.infolist()]
    doc = next(c for i, c in itens if i.filename == "word/document.xml").decode("utf-8")
    manuais = []
    for a in apontamentos:
        if a.get("status") != "aceito":
            continue
        trecho = a.get("trecho") or ""
        novo = _trocar(doc, trecho, a.get("sugestao") or "") if trecho else None
        if novo is None:
            manuais.append(a)
        else:
            doc = novo
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for info, conteudo in itens:
            z.writestr(info, doc.encode("utf-8") if info.filename == "word/document.xml" else conteudo)
    return buf.getvalue(), manuais


def aplicar_no_pdf(dados: bytes, apontamentos: list[dict]) -> tuple[bytes, list[dict]]:
    """PDF original com cada trecho aceito coberto e reescrito no mesmo
    lugar. Só troca trechos que cabem numa linha; os demais voltam como
    manuais."""
    import pymupdf as fitz

    pdf = fitz.open(stream=dados, filetype="pdf")
    manuais = []
    for a in apontamentos:
        if a.get("status") != "aceito":
            continue
        trecho, sug = (a.get("trecho") or "").strip(), a.get("sugestao") or ""
        feito = False
        if trecho and "\n" not in trecho:
            for pg in pdf:
                areas = pg.search_for(trecho)
                if not areas:
                    continue
                r = areas[0]
                # trecho quebrado em duas linhas: o 1º retângulo não tem o trecho todo
                if _normal(pg.get_textbox(r)) != _normal(trecho):
                    continue
                tam = _tamanho_fonte(pg, r)
                pg.add_redact_annot(r, fill=(1, 1, 1))
                pg.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
                larg = fitz.get_text_length(sug, fontname="tiro", fontsize=tam) or 1
                tam = max(min(tam, tam * (r.width / larg) if larg > r.width else tam), 5)
                pg.insert_text((r.x0, r.y1 - (r.height - tam) / 2 - tam * 0.2), sug, fontname="tiro", fontsize=tam)
                feito = True
                break
        if not feito:
            manuais.append(a)
    saida = pdf.tobytes(garbage=3, deflate=True)
    pdf.close()
    return saida, manuais


def _normal(texto: str) -> str:
    return re.sub(r"\s+", " ", texto or "").strip()


def _tamanho_fonte(pg, r) -> float:
    for bloco in pg.get_text("dict", clip=r).get("blocks", []):
        for linha in bloco.get("lines", []):
            for sp in linha.get("spans", []):
                if sp.get("size"):
                    return float(sp["size"])
    return 11.0


def libreoffice() -> Optional[str]:
    return shutil.which("soffice") or shutil.which("libreoffice")


def docx_para_pdf(dados: bytes, timeout: int = 120) -> bytes:
    """Converte o Word em PDF pelo LibreOffice, mantendo o layout."""
    exe = libreoffice()
    if not exe:
        raise ErroConversao("Conversão para PDF indisponível neste servidor (LibreOffice não instalado).")
    with tempfile.TemporaryDirectory() as pasta:
        entrada = os.path.join(pasta, "minuta.docx")
        with open(entrada, "wb") as f:
            f.write(dados)
        perfil = "file:///" + os.path.join(pasta, "perfil").replace("\\", "/").lstrip("/")
        try:
            subprocess.run([exe, f"-env:UserInstallation={perfil}", "--headless", "--convert-to", "pdf",
                            "--outdir", pasta, entrada], check=True, timeout=timeout,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.SubprocessError, OSError) as exc:
            raise ErroConversao(f"Não consegui converter para PDF: {exc}") from exc
        saida = os.path.join(pasta, "minuta.pdf")
        if not os.path.exists(saida):
            raise ErroConversao("Não consegui converter para PDF.")
        with open(saida, "rb") as f:
            return f.read()

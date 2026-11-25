"""Minuta revisada no mesmo layout do arquivo original (Hub Societário).

- Word (.docx): as sugestões aceitas trocam só o texto dos trechos dentro
  do próprio document.xml; estilos, fontes, tabelas, cabeçalho, rodapé,
  numeração e margens ficam como estavam. O XML é editado como texto (sem
  reserializar), para o Word não estranhar prefixos e namespaces. Um trecho
  que passa por tabulação, quebra de linha ou de um parágrafo para outro é
  trocado pedaço a pedaço, cada pedaço com a formatação que já tinha.
- PDF original: cada trecho (mesmo quebrado em várias linhas) é apagado e
  reescrito no mesmo lugar (PyMuPDF), com o tamanho, a cor e o estilo
  (serifa, negrito, itálico) do texto original; a fonte diminui se a
  correção for mais comprida.
- PDF a partir do Word: conversão pelo LibreOffice (instalado na imagem do
  Hub). Sem LibreOffice, `docx_para_pdf` avisa com ErroConversao.

O trecho apontado pela IA é procurado com tolerância a diferenças de
espaços, quebras de linha, aspas e travessões (`achar`).
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

_ASPAS_D, _ASPAS_S, _TRACOS = "[\"“”„″]", "['‘’´`]", "[-‐‑–—]"
_EQUIV = {**{c: _ASPAS_D for c in "\"“”„″"}, **{c: _ASPAS_S for c in "'‘’´`"}, **{c: _TRACOS for c in "-‐‑–—"}}


class ErroConversao(Exception):
    pass


def achar(texto: str, trecho: str) -> Optional[tuple[int, int]]:
    """(início, fim) da primeira ocorrência de `trecho` em `texto`. Se não
    houver igual, tolera diferença de espaços/tabulações/quebras de linha,
    de aspas (retas ou curvas) e de hífen/travessão."""
    if not trecho or not texto:
        return None
    i = texto.find(trecho)
    if i >= 0:
        return i, i + len(trecho)
    t = trecho.strip()
    if not t:
        return None
    padrao = "".join(r"\s+" if p.isspace() else "".join(_EQUIV.get(c, re.escape(c)) for c in p)
                     for p in re.split(r"(\s+)", t) if p)
    m = re.search(padrao, texto)
    return (m.start(), m.end()) if m else None


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


def _pedacos(xml: str) -> list[dict]:
    """Todos os pedaços do documento em sequência, com uma quebra ('x', '\\n')
    entre um parágrafo e outro: o mesmo texto de `texto_docx`."""
    saida: list[dict] = []
    for n, par in enumerate(_paragrafos(xml)):
        if n:
            saida.append({"tipo": "x", "texto": "\n"})
        saida.extend(par)
    return saida


def texto_docx(dados: bytes) -> str:
    """Texto do Word, um parágrafo por linha (o que a IA lê e onde os
    trechos dos apontamentos são procurados)."""
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    return "\n".join("".join(s["texto"] for s in p) for p in _paragrafos(xml)).strip()


def _wt(texto: str) -> str:
    """<w:t> com o texto; quebras de linha viram <w:br/> e tabulações <w:tab/>."""
    def um(t: str) -> str:
        return '<w:t xml:space="preserve">' + html.escape(t, quote=False) + "</w:t>"
    partes = re.split(r"([\t\n])", texto)
    return "".join(um(p) if i % 2 == 0 else ("<w:tab/>" if p == "\t" else "<w:br/>") for i, p in enumerate(partes))


def _dividir_sugestao(sugestao: str, grupos: list[dict]) -> list[str]:
    """Texto que vai em cada grupo (pedaços entre tabulações/quebras/
    parágrafos) do trecho original.
    - A sugestão tem as mesmas quebras: cada parte vai no seu grupo.
    - Não tem, mas tem o mesmo número de palavras que o trecho: as palavras
      vão para o grupo onde estava a palavra que substituem (ex.: o campo
      depois da tabulação em "Nome:<tab>Fulano").
    - Senão, a sugestão inteira fica no primeiro grupo e as quebras sobram
      só nos grupos que tiverem texto fora do trecho."""
    n = len(grupos)
    partes = re.split(r"([\t\n])", sugestao)
    textos, seps = partes[0::2], partes[1::2]
    if len(textos) > n:  # quebras a mais: o resto fica no último grupo, com as quebras
        resto = textos[n - 1] + "".join(s + t for s, t in zip(seps[n - 1:], textos[n:]))
        return textos[:n - 1] + [resto]
    if len(textos) == n:
        return textos
    palavras = sugestao.split()
    contagem = [len(g["casado"].split()) for g in grupos]
    if len(textos) == 1 and sum(contagem) == len(palavras) and all(contagem):
        saida, k = [], 0
        for g, c in zip(grupos, contagem):
            fim = g["casado"]
            saida.append((" " if fim[:1].isspace() else "") + " ".join(palavras[k:k + c])
                         + (" " if fim[-1:].isspace() else ""))
            k += c
        return saida
    return textos + [""] * (n - len(textos))


def _trocar(xml: str, trecho: str, sugestao: str) -> Optional[str]:
    """XML com a primeira ocorrência de `trecho` trocada por `sugestao`,
    mantendo a formatação de cada pedaço. None se não achar o trecho."""
    pedacos = _pedacos(xml)
    texto = "".join(p["texto"] for p in pedacos)
    achado = achar(texto, trecho)
    if not achado:
        return None
    ini, fim = achado
    grupos: list[dict] = [{"itens": [], "casado": ""}]
    cur = 0
    for p in pedacos:
        a, b = cur, cur + len(p["texto"])
        cur = b
        if b <= ini or a >= fim or a == b:
            continue
        if p["tipo"] == "x":
            grupos.append({"itens": [], "casado": ""})
            continue
        i0, i1 = max(ini - a, 0), min(fim - a, len(p["texto"]))
        grupos[-1]["itens"].append((p, p["texto"][:i0], p["texto"][i1:]))
        grupos[-1]["casado"] += p["texto"][i0:i1]
    grupos = [g for g in grupos if g["itens"]]
    if not grupos:
        return None
    edicoes = []
    for g, novo_txt in zip(grupos, _dividir_sugestao(sugestao, grupos)):
        for k, (p, antes, depois) in enumerate(g["itens"]):
            novo = antes + (novo_txt if k == 0 else "") + depois
            abre = xml[p["ini"]:xml.index(">", p["ini"]) + 1]
            if "\n" in novo or "\t" in novo or "xml:space" not in abre:
                trecho_xml = _wt(novo)
            else:
                trecho_xml = abre + html.escape(novo, quote=False) + "</w:t>"
            edicoes.append((p["ini"], p["fim"], trecho_xml))
    for a, b, novo in sorted(edicoes, reverse=True):
        xml = xml[:a] + novo + xml[b:]
    return xml


def aplicar_no_docx(dados: bytes, apontamentos: list[dict]) -> tuple[bytes, list[dict]]:
    """Word original com as sugestões ACEITAS aplicadas no lugar. Devolve o
    arquivo e os aceitos que não deu para aplicar sozinho (trecho vazio ou
    não encontrado)."""
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


# ------------------------------------------------------------------ PDF

# fontes padrão do PDF: (serifa, negrito, itálico) -> nome
_FONTES = {(True, False, False): "tiro", (True, True, False): "tibo", (True, False, True): "tiit",
           (True, True, True): "tibi", (False, False, False): "helv", (False, True, False): "hebo",
           (False, False, True): "heit", (False, True, True): "hebi"}


def _sem_espaco(texto: str) -> str:
    return re.sub(r"\s+", "", texto or "")


def _achar_no_pdf(pg, trecho: str, letras: list) -> Optional[list]:
    """Retângulos (um por linha) da primeira ocorrência do trecho na página."""
    texto = pg.get_text()
    achado = achar(texto, trecho)
    if not achado:
        return None
    real = _normal(texto[achado[0]:achado[1]])
    alvo = _sem_espaco(real)
    rects = pg.search_for(real)
    for i in range(len(rects)):
        junto = ""
        for j in range(i, len(rects)):
            junto += _sem_espaco(_texto_no_rect(letras, rects[j]))
            if junto == alvo:
                return rects[i:j + 1]
            if not alvo.startswith(junto):
                break
    return None


def _letras(pg) -> list:
    """(centro x, centro y, letra, borda direita) de cada caractere da página."""
    saida = []
    for bloco in pg.get_text("rawdict").get("blocks", []):
        for linha in bloco.get("lines", []):
            for sp in linha.get("spans", []):
                for ch in sp.get("chars", []):
                    x0, y0, x1, y1 = ch["bbox"]
                    saida.append(((x0 + x1) / 2, (y0 + y1) / 2, ch["c"], x1))
    return saida


def _texto_no_rect(letras: list, r) -> str:
    """Letras cujo centro está no retângulo (as das linhas vizinhas, que
    encostam nele, ficam de fora)."""
    return "".join(c for x, y, c, _ in letras if r.x0 <= x <= r.x1 and r.y0 <= y <= r.y1)


def _miolo(r):
    """Retângulo da linha sem as bordas de cima e de baixo, para apagar só
    ela, sem pegar letras das linhas vizinhas."""
    import pymupdf as fitz
    folga = r.height * 0.2
    return fitz.Rect(r.x0, r.y0 + folga, r.x1, r.y1 - folga)


def _estilo(pg, r) -> dict:
    """Tamanho, fonte, cor e linha de base do texto original no retângulo."""
    for bloco in pg.get_text("dict", clip=_miolo(r)).get("blocks", []):
        for linha in bloco.get("lines", []):
            for sp in linha.get("spans", []):
                if not (sp.get("text") or "").strip():
                    continue
                nome, flags = (sp.get("font") or "").lower(), int(sp.get("flags") or 0)
                serifa = bool(flags & 4) or any(x in nome for x in ("times", "serif", "roman", "georgia",
                                                                      "garamond", "cambria", "book"))
                serifa = serifa and "sans" not in nome
                negrito = bool(flags & 16) or "bold" in nome or "black" in nome
                italico = bool(flags & 2) or "italic" in nome or "oblique" in nome
                c = int(sp.get("color") or 0)
                return {"tam": float(sp.get("size") or 11), "fonte": _FONTES[(serifa, negrito, italico)],
                        "cor": (((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255),
                        "base": float(sp["origin"][1]) if sp.get("origin") else None}
    return {"tam": 11.0, "fonte": "tiro", "cor": (0, 0, 0), "base": None}


def _distribuir(palavras: list[str], rects: list, fonte: str, tam: float, forcar: bool = False) -> Optional[list[str]]:
    """Palavras repartidas pelas linhas (retângulos) do trecho original, na
    fonte e tamanho dados. None se não couber."""
    import pymupdf as fitz

    linhas, k = [], 0
    for r in rects:
        atual: list[str] = []
        while k < len(palavras):
            teste = " ".join(atual + [palavras[k]])
            if fitz.get_text_length(teste, fontname=fonte, fontsize=tam) <= r.width + 0.5:
                atual.append(palavras[k])
                k += 1
            else:
                break
        linhas.append(" ".join(atual))
    if k < len(palavras):
        if not forcar:
            return None
        linhas[-1] = " ".join(filter(None, [linhas[-1]] + palavras[k:]))
    return linhas


def _caber(palavras: list[str], rects: list, fonte: str, tam: float, minimo: float):
    """(linhas, tamanho) com o maior tamanho de fonte, até `minimo` x o
    original, em que as palavras cabem nas linhas; (None, menor tamanho)."""
    t = tam
    while t >= tam * minimo:
        linhas = _distribuir(palavras, rects, fonte, t)
        if linhas is not None:
            return linhas, t
        t -= 0.25
    return None, max(t + 0.25, tam * minimo)


def aplicar_no_pdf(dados: bytes, apontamentos: list[dict]) -> tuple[bytes, list[dict]]:
    """PDF original com cada trecho aceito apagado e reescrito no mesmo
    lugar e no mesmo estilo; trecho em várias linhas é reescrito nas mesmas
    linhas. Os que não forem achados voltam como manuais."""
    import pymupdf as fitz

    pdf = fitz.open(stream=dados, filetype="pdf")
    manuais = []
    for a in apontamentos:
        if a.get("status") != "aceito":
            continue
        trecho, sug = _normal(a.get("trecho")), _normal(a.get("sugestao"))
        feito = False
        if trecho:
            for pg in pdf:
                letras = _letras(pg)
                rects = _achar_no_pdf(pg, trecho, letras)
                if not rects:
                    continue
                estilos = [_estilo(pg, r) for r in rects]
                e0 = estilos[0]
                fonte, palavras, apagar = e0["fonte"], sug.split(), list(rects)
                # 1º: nas mesmas linhas, diminuindo a fonte no máximo 15%
                linhas, tam = _caber(palavras, rects, fonte, e0["tam"], 0.85)
                if linhas is None:
                    # não coube: o resto da última linha anda para a direita, até a
                    # margem do texto da página (como num editor), em vez de
                    # espremer a letra
                    ult = rects[-1]
                    resto = [(c, x1) for x, y, c, x1 in letras if ult.y0 <= y <= ult.y1 and x > ult.x1]
                    margem = max([x1 for *_, x1 in letras] + [ult.x1])
                    if resto:
                        apagar.append(fitz.Rect(ult.x1, ult.y0, max(x1 for _, x1 in resto), ult.y1))
                    rects = rects[:-1] + [fitz.Rect(ult.x0, ult.y0, margem, ult.y1)]
                    palavras = palavras + "".join(c for c, _ in resto).split()
                    linhas, tam = _caber(palavras, rects, fonte, e0["tam"], 0.6)
                    if linhas is None:
                        linhas = _distribuir(palavras, rects, fonte, tam, forcar=True)
                for r in apagar:
                    pg.add_redact_annot(_miolo(r), fill=False)
                pg.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
                for r, est, linha in zip(rects, estilos, linhas):
                    if not linha:
                        continue
                    base = est["base"] if est["base"] is not None else r.y1 - (r.height - tam) / 2 - tam * 0.2
                    pg.insert_text((r.x0, base), linha, fontname=fonte, fontsize=tam, color=e0["cor"])
                feito = True
                break
        if not feito:
            manuais.append(a)
    saida = pdf.tobytes(garbage=3, deflate=True)
    pdf.close()
    return saida, manuais


def _normal(texto: Optional[str]) -> str:
    return re.sub(r"\s+", " ", texto or "").strip()


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

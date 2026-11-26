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
    if not m:
        # a leitura do PDF às vezes põe espaço no meio da palavra ("Civi l",
        # "cin quenta") ou some com ele; compara ignorando os espaços
        letras = [c for c in t if not c.isspace()]
        m = re.search(r"\s*".join(_EQUIV.get(c, re.escape(c)) for c in letras), texto)
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


def preencher_docx(dados: bytes, campos: dict[str, str]) -> bytes:
    """Word com cada campo do modelo (ex.: {{EMPRESA}}) trocado pelo valor,
    em todas as ocorrências, mantendo a formatação (o campo pode estar
    quebrado em vários pedaços de texto pelo Word)."""
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        itens = [(i, z.read(i.filename)) for i in z.infolist()]
    partes = {}
    for info, conteudo in itens:
        nome = info.filename
        if not (nome == "word/document.xml" or re.match(r"word/(header|footer)\d*\.xml$", nome)):
            continue
        xml = conteudo.decode("utf-8")
        for campo, valor in campos.items():
            for _ in range(500):
                pedacos = _pedacos(xml)
                if campo not in "".join(p["texto"] for p in pedacos):
                    break
                novo = _trocar(xml, campo, valor)
                if novo is None or novo == xml:
                    break
                xml = novo
        partes[nome] = xml.encode("utf-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for info, conteudo in itens:
            z.writestr(info, partes.get(info.filename, conteudo))
    return buf.getvalue()


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
        novo = _trocar(doc, trecho, _novo_texto(a)) if trecho else None
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
_PADRAO = {"f": "tiro", "s": 11.0, "c": (0, 0, 0)}


def _novo_texto(a: dict) -> str:
    """Texto que entra no lugar do trecho (preparado pelo societario em
    'texto_aplicar'; revisões antigas usam a própria sugestão)."""
    return a["texto_aplicar"] if "texto_aplicar" in a else (a.get("sugestao") or "")


def _sem_espaco(texto: str) -> str:
    return re.sub(r"\s+", "", texto or "")


def _estilo_span(sp: dict) -> dict:
    """Fonte padrão do PDF mais parecida com a do trecho, tamanho e cor."""
    nome, flags = (sp.get("font") or "").lower(), int(sp.get("flags") or 0)
    serifa = bool(flags & 4) or any(x in nome for x in ("times", "serif", "roman", "georgia",
                                                          "garamond", "cambria", "book"))
    serifa = serifa and "sans" not in nome and "arial" not in nome and "helvetica" not in nome
    negrito = bool(flags & 16) or "bold" in nome or "black" in nome
    italico = bool(flags & 2) or "italic" in nome or "oblique" in nome
    c = int(sp.get("color") or 0)
    return {"f": _FONTES[(serifa, negrito, italico)], "s": float(sp.get("size") or 11),
            "c": (((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255)}


def _letras(pg) -> list[tuple]:
    """(centro x, centro y, letra, x0, y0, x1, y1, estilo, linha de base) de
    cada caractere da página."""
    saida = []
    for bloco in pg.get_text("rawdict").get("blocks", []):
        for linha in bloco.get("lines", []):
            for sp in linha.get("spans", []):
                est = _estilo_span(sp)
                base = float(sp["origin"][1]) if sp.get("origin") else None
                for ch in sp.get("chars", []):
                    x0, y0, x1, y1 = ch["bbox"]
                    saida.append(((x0 + x1) / 2, (y0 + y1) / 2, ch["c"], x0, y0, x1, y1, est, base))
    return saida


def _no_rect(letras: list, r) -> list[tuple]:
    """Letras cujo centro está no retângulo (as das linhas vizinhas, que
    encostam nele, ficam de fora), da esquerda para a direita."""
    return sorted((l for l in letras if r.x0 <= l[0] <= r.x1 and r.y0 <= l[1] <= r.y1), key=lambda l: l[0])


def _palavras(letras: list[tuple], colado: bool = False) -> list[dict]:
    """Palavras (com o estilo da 1ª letra) de uma sequência de letras;
    'cola' marca a que vem grudada na anterior (sem espaço, ex.: pontuação)."""
    saida, atual, espaco, ant = [], None, not colado, None
    for l in letras:
        if l[2].isspace():
            atual, espaco = None, True
            continue
        # PDF do Word muitas vezes não tem o caractere de espaço: o espaço é só
        # um vão entre as letras
        if ant is not None and l[3] - ant[5] > (l[6] - l[4]) * 0.15:
            atual, espaco = None, True
        ant = l
        if atual is None:
            atual = {"t": "", **l[7], "cola": not espaco}
            saida.append(atual)
            espaco = False
        atual["t"] += l[2]
    return saida


def _linhas_visuais(letras: list) -> list[dict]:
    """Linhas da página como aparecem (letras agrupadas pela altura), de
    cima para baixo: {x0, y0, x1, y1, cy, letras}."""
    grupos: list[dict] = []
    for l in sorted(letras, key=lambda l: l[1]):
        alt = max(l[6] - l[4], 1)
        if grupos and abs(l[1] - grupos[-1]["cy"]) <= alt * 0.35:
            grupos[-1]["letras"].append(l)
        else:
            grupos.append({"cy": l[1], "letras": [l]})
    saida = []
    for g in grupos:
        ls = sorted(g["letras"], key=lambda l: l[0])
        vis = [l for l in ls if not l[2].isspace()] or ls
        saida.append({"x0": min(l[3] for l in vis), "x1": max(l[5] for l in vis), "y0": min(l[4] for l in ls),
                      "y1": max(l[6] for l in ls), "cy": g["cy"], "letras": ls,
                      "base": next((l[8] for l in vis if l[8] is not None), None)})
    return saida


def _margens(pg, linhas: list[dict]) -> tuple[float, float]:
    """Margem esquerda e direita do corpo do texto (a borda mais comum das
    linhas largas, que ignora cabeçalho, numeração de página etc.)."""
    larg = pg.rect.width
    cheias = [l for l in linhas if l["x1"] - l["x0"] > larg * 0.4]
    if not cheias:
        return 72.0, larg - 72.0

    def moda(vals):
        cont: dict[int, int] = {}
        for v in vals:
            cont[round(v)] = cont.get(round(v), 0) + 1
        alvo = max(cont.items(), key=lambda kv: (kv[1], kv[0]))[0]
        return max(v for v in vals if round(v) == alvo)

    return moda([l["x0"] for l in cheias]), moda([l["x1"] for l in cheias])


def _achar_no_pdf(pg, trecho: str, letras: list) -> Optional[list]:
    """Retângulos (um por linha) da primeira ocorrência do trecho na página."""
    texto = pg.get_text()
    achado = achar(texto, trecho)
    if not achado:
        # pedaços da mesma linha gravados fora de ordem no PDF: lê pela posição
        texto = pg.get_text(sort=True)
        achado = achar(texto, trecho)
    if not achado:
        return None
    real = _normal(texto[achado[0]:achado[1]])
    alvo = _sem_espaco(real)
    rects = pg.search_for(real)
    for i in range(len(rects)):
        junto = ""
        for j in range(i, len(rects)):
            junto += _sem_espaco("".join(l[2] for l in _no_rect(letras, rects[j])))
            if junto == alvo:
                return rects[i:j + 1]
            if not alvo.startswith(junto):
                break
    return _achar_por_letras(letras, alvo)


def _achar_por_letras(letras: list, alvo: str) -> Optional[list]:
    """Quando a busca do PyMuPDF não acha (pedaços da linha gravados fora
    de ordem ou com espaço largo no meio), procura o texto nas letras
    ordenadas pela posição e devolve um retângulo por linha."""
    import pymupdf as fitz
    vis = sorted((l for l in letras if not l[2].isspace()), key=lambda l: (l[1], l[0]))
    linhas: list[list] = []
    for l in vis:
        if linhas and abs(l[1] - linhas[-1][0][1]) < (l[6] - l[4]) * 0.5:
            linhas[-1].append(l)
        else:
            linhas.append([l])
    seq = [l for ln in linhas for l in sorted(ln, key=lambda l: l[0])]
    i = "".join(l[2] for l in seq).find(alvo) if alvo else -1
    if i < 0 or "".join(l[2] for l in seq).find(alvo, i + 1) >= 0:
        return None
    rects: list = []
    for l in seq[i:i + len(alvo)]:
        r = fitz.Rect(l[3], l[4], l[5], l[6])
        if rects and abs((rects[-1].y0 + rects[-1].y1) / 2 - l[1]) < r.height * 0.5:
            rects[-1] |= r
        else:
            rects.append(r)
    return rects


def _miolo(r):
    """Retângulo da linha sem as bordas de cima e de baixo, para apagar só
    ela, sem pegar letras das linhas vizinhas."""
    import pymupdf as fitz
    folga = r.height * 0.2
    return fitz.Rect(r.x0, r.y0 + folga, r.x1, r.y1 - folga)


_FONTES_CACHE: dict = {}


def _medir(texto: str, fonte: str, tam: float) -> float:
    """Largura do texto como ele sai desenhado (fitz.get_text_length mede
    menos as letras acentuadas, e a palavra seguinte encavalaria)."""
    import pymupdf as fitz
    if fonte not in _FONTES_CACHE:
        _FONTES_CACHE[fonte] = fitz.Font(fonte)
    return _FONTES_CACHE[fonte].text_length(texto, fontsize=tam)


def _larg(p: dict, escala: float) -> float:
    return _medir(p["t"], p["f"], p["s"] * escala)


def _espaco(p: dict, escala: float) -> float:
    return 0.0 if p.get("cola") else _medir(" ", p["f"], p["s"] * escala)


def _distribuir(palavras: list[dict], rects: list, escala: float) -> Optional[list[list[dict]]]:
    """Palavras repartidas pelas linhas (retângulos); None se não couber."""
    linhas, k = [], 0
    for r in rects:
        atual: list[dict] = []
        usado = 0.0
        while k < len(palavras):
            p = palavras[k]
            w = _larg(p, escala) + (_espaco(p, escala) if atual else 0)
            if usado + w <= r.width + 0.5:
                atual.append(p)
                usado += w
                k += 1
            elif not atual and p.get("cola"):  # pontuação não começa linha sozinha
                break
            else:
                break
        linhas.append(atual)
    return linhas if k >= len(palavras) else None


def _caber(palavras: list[dict], rects: list, minimo: float):
    """(linhas, escala) com a maior fonte, até `minimo` x a original, em que
    as palavras cabem; (None, 1) se não cabe."""
    e = 1.0
    while e >= minimo - 1e-6:
        linhas = _distribuir(palavras, rects, e)
        if linhas is not None:
            return linhas, e
        e -= 0.02
    return None, 1.0


def _plano_pdf(pg, rects: list, sug: str, letras: list) -> Optional[dict]:
    """Onde e como reescrever a correção. Cada palavra mantém o próprio
    estilo (a do texto novo, o estilo do trecho original). Tenta:
    1) nas mesmas linhas do trecho (fonte até 15% menor), quando o texto novo
       tem mais ou menos o tamanho do antigo;
    2) refazendo o resto da última linha (o texto anda para a direita ou
       volta para a esquerda, sem buraco), justificado até a margem;
    3) refazendo também as linhas seguintes do mesmo parágrafo;
    4) usando o espaço em branco logo abaixo do parágrafo.
    None se nem assim couber (fica para ajustar à mão: melhor do que letra
    miúda ou texto por cima de outro)."""
    import pymupdf as fitz

    orig = [l for r in rects for l in _no_rect(letras, r)]
    est = next((l[7] for l in orig if l[2].isalnum()), orig[0][7] if orig else _PADRAO)
    novas = [{"t": t, **est, "cola": False} for t in sug.split()]
    bases = [next((l[8] for l in _no_rect(letras, r) if l[8] is not None), None) for r in rects]
    alvo, apagar = list(rects), list(rects)
    larg_orig = sum(r.width for r in rects)
    larg_nova = sum(_larg(p, 1) + (_espaco(p, 1) if i else 0) for i, p in enumerate(novas))
    ult = rects[-1]
    resto = sorted((l for l in letras if ult.y0 <= l[1] <= ult.y1 and l[0] > ult.x1 + 0.5), key=lambda l: l[0])
    linhas, escala = _caber(novas, alvo, 0.85)
    parecido = abs(larg_nova - larg_orig) <= max(_espaco(novas[0], 1) * 2 if novas else 0, 3)
    if linhas is not None and (parecido or not resto or not novas):
        return {"alvo": alvo, "apagar": apagar, "bases": bases, "linhas": linhas, "escala": escala,
                "cheias": [i < len(alvo) - 1 for i in range(len(alvo))]}

    visuais = _linhas_visuais(letras)
    esq, dir_ = _margens(pg, visuais)
    cy = (ult.y0 + ult.y1) / 2
    idx = min(range(len(visuais)), key=lambda i: abs(visuais[i]["cy"] - cy)) if visuais else None
    tam0 = est["s"]
    linha_ult = visuais[idx] if idx is not None else None
    cheia_ult = bool(linha_ult and linha_ult["x1"] >= dir_ - tam0 * 2)
    # o resto começa grudado no trecho (ex.: "." ou "," logo depois)? continua grudado
    colado = bool(resto) and not resto[0][2].isspace() and resto[0][3] - ult.x1 < (resto[0][6] - resto[0][4]) * 0.15
    palavras = novas + _palavras(resto, colado)
    if resto:
        apagar.append(fitz.Rect(ult.x1, ult.y0, max(l[5] for l in resto), ult.y1))
    alvo[-1] = fitz.Rect(ult.x0, ult.y0, max(dir_, ult.x1) if (cheia_ult or resto) else ult.x1, ult.y1)
    cheias = [True] * (len(alvo) - 1) + [cheia_ult]
    linhas, escala = _caber(palavras, alvo, 0.85)
    passo = ult.height * 1.15
    j = idx + 1 if idx is not None else 0
    if linhas is None and idx is not None:
        # 3) linhas seguintes do mesmo parágrafo
        ant = linha_ult
        while (j < len(visuais) and ant["x1"] >= dir_ - tam0 * 2
               and visuais[j]["y0"] - ant["y1"] < tam0 * 0.8 and visuais[j]["x1"] <= dir_ + 2):
            v = visuais[j]
            passo = v["cy"] - ant["cy"]
            alvo.append(fitz.Rect(esq, v["y0"], dir_, v["y1"]))
            apagar.append(fitz.Rect(v["x0"], v["y0"], v["x1"], v["y1"]))
            bases.append(v["base"])
            cheias.append(v["x1"] >= dir_ - tam0 * 2)
            palavras = palavras + _palavras(v["letras"])
            ant, j = v, j + 1
        linhas, escala = _caber(palavras, alvo, 0.85)
        if linhas is None:
            # 4) espaço em branco abaixo do parágrafo, até a próxima linha
            limite = visuais[j]["y0"] if j < len(visuais) else pg.rect.height - 40
            r, base = alvo[-1], bases[-1] if bases[-1] is not None else alvo[-1].y1 - ult.height * 0.25
            while r.y1 + passo <= limite - passo * 0.3:
                r = fitz.Rect(esq, r.y0 + passo, dir_, r.y1 + passo)
                base += passo
                alvo.append(r)
                bases.append(base)
                cheias.append(False)
            linhas, escala = _caber(palavras, alvo, 0.85)
    if linhas is None:
        return None
    # a linha que antes ia até a margem continua justificada, menos a última
    # linha que recebeu texto (fim do parágrafo)
    ultima = max((i for i, l in enumerate(linhas) if l), default=-1)
    # (ou a última, se ela é a última linha usada e o parágrafo segue abaixo)
    cheias = [c and (i < ultima or i == ultima == len(alvo) - 1) for i, c in enumerate(cheias)]
    return {"alvo": alvo, "apagar": apagar, "bases": bases, "linhas": linhas, "escala": escala, "cheias": cheias}


def _escrever_linha(pg, r, base: float, linha: list[dict], escala: float, justificar: bool) -> None:
    larguras = [_larg(p, escala) for p in linha]
    espacos = [(_espaco(p, escala) if i else 0.0) for i, p in enumerate(linha)]
    folga = r.width - sum(larguras) - sum(espacos)
    vaos = sum(1 for i, p in enumerate(linha) if i and not p.get("cola"))
    extra = folga / vaos if justificar and vaos and 0 < folga else 0.0
    if extra > max(espacos + [3.0]) * 3:  # linha com poucas palavras: não estica
        extra = 0.0
    x = r.x0
    for i, (p, w) in enumerate(zip(linha, larguras)):
        if i:
            x += espacos[i] + (extra if not p.get("cola") else 0)
        pg.insert_text((x, base), p["t"], fontname=p["f"], fontsize=p["s"] * escala, color=p["c"])
        x += w


def aplicar_no_pdf(dados: bytes, apontamentos: list[dict]) -> tuple[bytes, list[dict]]:
    """PDF original com cada trecho aceito apagado e reescrito no mesmo
    lugar e no mesmo estilo (veja `_plano_pdf`). Os que não forem achados,
    ou que não couberem sem estragar a página, voltam como manuais."""
    import pymupdf as fitz

    pdf = fitz.open(stream=dados, filetype="pdf")
    manuais = []
    for a in apontamentos:
        if a.get("status") != "aceito":
            continue
        trecho, sug = _normal(a.get("trecho")), _normal(_novo_texto(a))
        feito = False
        if trecho and _sem_espaco(trecho) == _sem_espaco(sug):
            # o "erro" era só um espaço que a leitura inventou; no PDF já está certo
            continue
        if trecho:
            for pg in pdf:
                letras = _letras(pg)
                rects = _achar_no_pdf(pg, trecho, letras)
                if not rects:
                    continue
                plano = _plano_pdf(pg, rects, sug, letras)
                if plano is None:
                    break
                for r in plano["apagar"]:
                    pg.add_redact_annot(_miolo(r), fill=False)
                pg.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
                for r, base, linha, cheia in zip(plano["alvo"], plano["bases"], plano["linhas"], plano["cheias"]):
                    if not linha:
                        continue
                    if base is None:
                        tam = linha[0]["s"] * plano["escala"]
                        base = r.y1 - (r.height - tam) / 2 - tam * 0.2
                    _escrever_linha(pg, r, base, linha, plano["escala"], cheia)
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


# ------------------------------------------------------------------ contrato gerado no modelo

# formatação de cada tipo de bloco (espaço antes/depois em twips, alinhamento,
# negrito), no padrão das minutas do escritório
BLOCOS_CONTRATO = {
    "titulo": (0, 240, "center", True),
    "subtitulo": (0, 240, "center", False),
    "secao": (360, 240, "center", True),
    "clausula": (160, 80, "left", True),
    "paragrafo": (0, 120, "both", False),
    "item": (0, 0, "left", False),
    "local_data": (240, 600, "right", False),
}
_PENDENTE = re.compile(r"(\[[^\]]*\])")


def _runs(texto: str, negrito: bool, tam: Optional[int] = None) -> str:
    """Runs do parágrafo: **trecho** sai em negrito e [informar ...] sai
    marcado em amarelo, para o colaborador completar."""
    saida = []
    for i, parte in enumerate(re.split(r"\*\*", texto or "")):
        neg = negrito or i % 2 == 1
        for pedaco in _PENDENTE.split(parte):
            if not pedaco:
                continue
            rpr = ("<w:b/>" if neg else '<w:b w:val="0"/>') + (
                '<w:highlight w:val="yellow"/>' if _PENDENTE.fullmatch(pedaco) else "") + (
                f'<w:sz w:val="{tam}"/><w:szCs w:val="{tam}"/>' if tam else "")
            saida.append(f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{html.escape(pedaco, quote=False)}</w:t></w:r>')
    return "".join(saida)


def _par(texto: str, antes: int, depois: int, alinha: str, negrito: bool, extra: str = "") -> str:
    return (f'<w:p><w:pPr>{extra}<w:spacing w:before="{antes}" w:after="{depois}"/><w:jc w:val="{alinha}"/>'
            f'</w:pPr>{_runs(texto, negrito)}</w:p>')


def _tabela(linhas: list[list[str]]) -> str:
    linhas = [l for l in linhas if any(str(c).strip() for c in l)]
    if not linhas:
        return ""
    ncol = max(len(l) for l in linhas)
    larg = [4252, 1701, 1134, 2268] if ncol == 4 else [9355 // ncol] * ncol
    grade = "".join(f'<w:gridCol w:w="{w}"/>' for w in larg)
    corpo = []
    for n, linha in enumerate(linhas):
        neg = n == 0 or str(linha[0]).strip().upper().startswith("TOTAL")
        cels = []
        for c in range(ncol):
            txt = str(linha[c]) if c < len(linha) else ""
            cels.append(f'<w:tc><w:tcPr><w:tcW w:w="{larg[c]}" w:type="dxa"/></w:tcPr><w:p><w:pPr>'
                        f'<w:spacing w:before="0" w:after="0"/><w:jc w:val="{"left" if c == 0 else "center"}"/>'
                        f'</w:pPr>{_runs(txt, neg, 20)}</w:p></w:tc>')
        corpo.append("<w:tr>" + "".join(cels) + "</w:tr>")
    borda = "".join(f'<w:{b} w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
                    for b in ("top", "left", "bottom", "right", "insideH", "insideV"))
    return (f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:jc w:val="center"/><w:tblBorders>{borda}'
            f'</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>{grade}</w:tblGrid>'
            + "".join(corpo) + "</w:tbl>" + _par("", 0, 120, "left", False))


def _assinatura(texto: str) -> str:
    nome, _, papel = (texto or "").strip().partition("\n")
    return (_par("", 480, 0, "center", False, "<w:keepNext/><w:keepLines/>")
            + _par("_____________________________________", 0, 0, "center", False, "<w:keepNext/>")
            + _par(nome.strip(), 0, 0, "center", True, "<w:keepNext/>")
            + (_par(papel.strip(), 0, 0, "center", False) if papel.strip() else ""))


def corpo_contrato(blocos: list[dict]) -> str:
    """XML do corpo do Word a partir dos blocos do contrato (título,
    cláusulas, parágrafos, tabela do capital, local e data, assinaturas)."""
    partes = []
    for b in blocos:
        tipo, texto = b.get("tipo"), b.get("texto") or ""
        if tipo == "tabela":
            partes.append(_tabela(b.get("linhas") or []))
        elif tipo == "assinatura":
            partes.append(_assinatura(texto))
        elif tipo in BLOCOS_CONTRATO:
            antes, depois, alinha, neg = BLOCOS_CONTRATO[tipo]
            linhas = texto.split("\n")
            junto = tipo in ("subtitulo", "item")  # linhas coladas; o espaço vem depois da última
            for i, linha in enumerate(linhas):
                fim = depois if not junto or i == len(linhas) - 1 else 0
                partes.append(_par(linha, antes if i == 0 else 0, fim, alinha, neg))
    return "".join(partes)


def montar_docx_modelo(modelo: bytes, blocos: list[dict]) -> bytes:
    """O Word do modelo do escritório (timbre no cabeçalho, rodapé, margens,
    fontes e estilos) com o corpo trocado pelo contrato gerado."""
    with zipfile.ZipFile(io.BytesIO(modelo)) as z:
        itens = [(i, z.read(i.filename)) for i in z.infolist()]
    doc = next(c for i, c in itens if i.filename == "word/document.xml").decode("utf-8")
    ini = doc.index(">", doc.index("<w:body")) + 1
    fim = doc.rfind("<w:sectPr")
    if fim < ini or doc.find("</w:body>", fim) < 0:
        fim = doc.rindex("</w:body>")
    doc = doc[:ini] + corpo_contrato(blocos) + doc[fim:]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for info, conteudo in itens:
            z.writestr(info, doc.encode("utf-8") if info.filename == "word/document.xml" else conteudo)
    return buf.getvalue()

"""Minuta revisada no layout do arquivo original (minuta_layout.py)."""
import io
import zipfile

import pytest

import minuta_layout as ml

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' \
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' \
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"'

# parágrafo com o valor quebrado em vários runs (negrito no meio), tabulação
# definida no estilo (w:tabs, que não é texto), tabulação real e entidade &amp;
DOC = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W}><w:body>'
       '<w:p w14:paraId="1"><w:pPr><w:pStyle w:val="Titulo"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>'
       '</w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>CONTRATO SOCIAL</w:t></w:r></w:p>'
       '<w:p><w:r><w:t xml:space="preserve">Sócio B: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>R$ 30.</w:t></w:r>'
       '<w:r><w:rPr><w:b/></w:rPr><w:t>000,00</w:t></w:r><w:r><w:t xml:space="preserve"> em quotas</w:t></w:r></w:p>'
       '<w:p><w:r><w:t>Cláusula 2</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Objeto &amp; sede</w:t></w:r></w:p>'
       '<w:p><w:r><w:t>Fim do parágrafo</w:t></w:r></w:p><w:p><w:r><w:t>começo do outro</w:t></w:r></w:p>'
       '<w:sectPr><w:pgMar w:top="1417"/></w:sectPr></w:body></w:document>')
HEADER = b'<?xml version="1.0"?><w:hdr><w:p><w:r><w:t>Cabecalho do escritorio</w:t></w:r></w:p></w:hdr>'


def _docx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", DOC)
        z.writestr("word/header1.xml", HEADER)
        z.writestr("word/styles.xml", "<w:styles/>")
    return buf.getvalue()


def _ler(dados: bytes, parte: str) -> bytes:
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        return z.read(parte)


def _ap(trecho, sugestao, status="aceito", i=1):
    return {"id": i, "titulo": f"a{i}", "trecho": trecho, "sugestao": sugestao, "status": status}


def test_texto_do_word():
    assert ml.texto_docx(_docx()) == ("CONTRATO SOCIAL\nSócio B: R$ 30.000,00 em quotas\n"
                                      "Cláusula 2\tObjeto & sede\nFim do parágrafo\ncomeço do outro")


def test_aplica_no_word_mantendo_o_layout():
    aps = [_ap("R$ 30.000,00", "R$ 40.000,00 (quarenta mil reais)", i=1),
           _ap("Objeto & sede", "Objeto & endereço", i=2),
           _ap("CONTRATO SOCIAL", "CONTRATO SOCIAL - 3ª ALTERAÇÃO", i=3),
           _ap("Cláusula 2", "Cláusula 9", status="recusado", i=4),
           _ap("parágrafo\ncomeço", "texto\ninício", i=5),   # passa de um parágrafo para outro
           _ap("Cláusula 2\tObjeto", "Cláusula 3\tObjeto", i=6),  # atravessa a tabulação
           _ap("não existe", "x", i=7)]
    novo, manuais = ml.aplicar_no_docx(_docx(), aps)
    assert [a["id"] for a in manuais] == [7]
    assert ml.texto_docx(novo) == ("CONTRATO SOCIAL - 3ª ALTERAÇÃO\nSócio B: R$ 40.000,00 (quarenta mil reais) em quotas\n"
                                   "Cláusula 3\tObjeto & endereço\nFim do texto\ninício do outro")
    xml = _ler(novo, "word/document.xml").decode()
    # formatação preservada: o valor novo fica no run em negrito, estilos e
    # namespaces (mc:Ignorable) intactos, demais partes do arquivo iguais
    assert '<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">R$ 40.000,00 (quarenta mil reais)</w:t>' in xml
    assert '<w:pStyle w:val="Titulo"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>' in xml
    assert 'mc:Ignorable="w14"' in xml and "&amp; endereço" in xml
    assert _ler(novo, "word/header1.xml") == HEADER
    assert _ler(novo, "word/styles.xml") == b"<w:styles/>"


def test_trecho_com_diferenca_de_espacos_aspas_e_tabulacao():
    # a IA escreveu espaço onde há tabulação e espaços duplos: o campo depois
    # da tabulação é preenchido e a tabulação continua lá
    aps = [_ap("Cláusula  2 Objeto", "Cláusula 5 Finalidade", i=1),
           _ap("Sócio B:\nR$ 30.000,00", "Sócio C: R$ 1,00", i=2)]
    novo, manuais = ml.aplicar_no_docx(_docx(), aps)
    assert not manuais
    texto = ml.texto_docx(novo)
    assert "Cláusula 5\tFinalidade & sede" in texto
    assert "Sócio C: R$ 1,00 em quotas" in texto
    xml = _ler(novo, "word/document.xml").decode()
    assert "Sócio C: R$ 1,00</w:t>" in xml
    assert ml.achar("cláusula “primeira” – sede", 'cláusula "primeira" - sede') == (0, 26)


def test_quebra_de_linha_na_sugestao():
    novo, manuais = ml.aplicar_no_docx(_docx(), [_ap("Fim do parágrafo", "Linha 1\nLinha 2")])
    assert not manuais
    assert "Linha 1</w:t><w:br/><w:t" in _ler(novo, "word/document.xml").decode()
    assert "Linha 1\nLinha 2" in ml.texto_docx(novo)


def test_aplica_no_pdf():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    pg = doc.new_page()
    pg.insert_text((72, 100), "CONTRATO SOCIAL", fontname="tibo", fontsize=14)
    pg.insert_text((72, 130), "Socio B: R$ 30.000,00 em quotas", fontname="tiro", fontsize=11)
    original = doc.tobytes()
    novo, manuais = ml.aplicar_no_pdf(original, [_ap("R$ 30.000,00", "R$ 40.000,00"),
                                                  _ap("nao existe", "x", i=2)])
    assert [a["id"] for a in manuais] == [2]
    texto = fitz.open(stream=novo, filetype="pdf")[0].get_text()
    assert "R$ 40.000,00" in texto and "R$ 30.000,00" not in texto and "CONTRATO SOCIAL" in texto


def test_pdf_trecho_em_varias_linhas_mantem_estilo_e_linhas():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    pg = doc.new_page()
    pg.draw_line((72, 140), (500, 140), color=(0, 0, 0))  # linha de tabela/assinatura
    pg.insert_text((72, 100), "O socio FULANO DE TAL, brasileiro,", fontname="tibo", fontsize=12, color=(0, 0, 1))
    pg.insert_text((72, 116), "casado, residente na Rua A, assina.", fontname="tibo", fontsize=12, color=(0, 0, 1))
    original = doc.tobytes()
    # o texto do PDF vem linha a linha: o trecho da IA tem a quebra no meio
    novo, manuais = ml.aplicar_no_pdf(original, [_ap("FULANO DE TAL, brasileiro,\ncasado, residente na Rua A",
                                                     "BELTRANO SILVA, brasileiro, solteiro, residente na Rua B")])
    assert not manuais
    pg2 = fitz.open(stream=novo, filetype="pdf")[0]
    texto = " ".join(pg2.get_text(sort=True).split())
    assert "BELTRANO SILVA" in texto and "Rua B" in texto and "FULANO" not in texto and "Rua A" not in texto
    assert texto.startswith("O socio") and texto.endswith("assina.")
    spans = [sp for b in pg2.get_text("dict")["blocks"] for l in b.get("lines", []) for sp in l["spans"]
             if "BELTRANO" in sp["text"]]
    assert spans and spans[0]["flags"] & 16 and spans[0]["color"] == 0x0000FF  # negrito e azul, como antes
    assert pg2.get_drawings()  # a linha continua no PDF


def test_pdf_correcao_maior_empurra_o_resto_da_linha():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    pg = doc.new_page()
    pg.insert_text((72, 100), "Capital social: R$ 30.000,00 dividido em quotas iguais de todos os socios.",
                   fontname="helv", fontsize=11)
    pg.insert_text((72, 160), "Outro paragrafo.", fontname="helv", fontsize=11)
    novo, manuais = ml.aplicar_no_pdf(doc.tobytes(), [_ap("R$ 30.000,00", "R$ 50.000,00 (cinquenta mil reais)")])
    assert not manuais
    pg2 = fitz.open(stream=novo, filetype="pdf")[0]
    assert " ".join(pg2.get_text(sort=True).split()) == ("Capital social: R$ 50.000,00 (cinquenta mil reais) "
                                                         "dividido em quotas iguais de todos os socios. Outro paragrafo.")
    tamanhos = {round(sp["size"], 1) for b in pg2.get_text("dict")["blocks"] for l in b.get("lines", [])
                for sp in l["spans"] if "cinquenta" in sp["text"]}
    assert tamanhos and min(tamanhos) >= 6.6  # não vira letra miúda (>= 60% de 11)


def test_pdf_sem_libreoffice(monkeypatch):
    monkeypatch.setattr(ml, "libreoffice", lambda: None)
    with pytest.raises(ml.ErroConversao):
        ml.docx_para_pdf(_docx())


def test_pdf_acentos_e_pontuacao_nao_encavalam():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    pg = doc.new_page()
    pg.insert_text((72, 100), "CLAUSULA QUARTA - A Administracao da sociedade e exercida", fontname="tibo", fontsize=12)
    novo, manuais = ml.aplicar_no_pdf(doc.tobytes(), [_ap("CLAUSULA QUARTA", "CLÁUSULA QUARTA DA ADMINISTRAÇÃO")])
    assert not manuais
    pg2 = fitz.open(stream=novo, filetype="pdf")[0]
    palavras = [w[4] for w in pg2.get_text("words", sort=True)]
    assert palavras[:5] == ["CLÁUSULA", "QUARTA", "DA", "ADMINISTRAÇÃO", "-"]
    caixas = sorted(pg2.get_text("words"), key=lambda w: (round(w[3]), w[0]))
    assert all(a[2] <= b[0] + 0.5 for a, b in zip(caixas, caixas[1:]) if round(a[3]) == round(b[3]))  # nada encavalado


def test_pdf_correcao_que_nao_cabe_fica_a_mao():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    pg = doc.new_page()
    pg.insert_text((72, 100), "Fica eleito o foro de Goiania.", fontname="tiro", fontsize=12)
    pg.insert_text((72, 114), "Segunda linha logo abaixo, sem espaco livre.", fontname="tiro", fontsize=12)
    original = doc.tobytes()
    novo, manuais = ml.aplicar_no_pdf(original, [_ap("foro de Goiania", "foro " + "muito longo " * 60)])
    assert [a["id"] for a in manuais] == [1]
    assert "foro de Goiania" in fitz.open(stream=novo, filetype="pdf")[0].get_text()  # página intacta


def test_achar_tolera_espaco_inventado_no_meio_da_palavra():
    texto = "corrigir para 'de acordo com o art. 997, I, do Código Civil'.\nA administração"
    assert ml.achar(texto, "do Código Civi l'.") is not None
    assert texto[slice(*ml.achar(texto, "administraç ão"))] == "administração"


def test_pdf_nota_com_espaco_inventado_e_pedacos_fora_de_ordem():
    fitz = pytest.importorskip("pymupdf")
    doc = fitz.open()
    pg = doc.new_page()
    pg.insert_text((72, 100), "Texto do contrato. Remover a nota da Clausula Nona.", fontname="tiro", fontsize=12)
    # mesma linha gravada em dois pedaços, o segundo antes do primeiro
    pg.insert_text((150, 130), "Setor Estrela Dalva", fontname="tiro", fontsize=12)
    pg.insert_text((72, 130), "- 01,", fontname="tiro", fontsize=12)
    pg.insert_text((72, 160), "Fim.", fontname="tiro", fontsize=12)
    original = doc.tobytes()
    novo, manuais = ml.aplicar_no_pdf(original, [
        _ap("Remover a nota da Claus ula Nona.", "", i=1),
        _ap("- 01, Setor Estrela Dalva", "", i=2),
        _ap("cin quenta", "cinquenta", i=3)])  # erro que só existia na leitura: nada a fazer
    assert not manuais
    texto = " ".join(fitz.open(stream=novo, filetype="pdf")[0].get_text(sort=True).split())
    assert texto == "Texto do contrato. Fim."


def _modelo_docx():
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p/>'
           '<w:sectPr><w:headerReference w:type="default" r:id="rId8"/><w:pgMar w:top="1814"/></w:sectPr>'
           '</w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", doc)
        z.writestr("word/header1.xml", "<w:hdr>TIMBRE</w:hdr>")
    return buf.getvalue()


def test_montar_docx_modelo_troca_o_corpo_e_mantem_o_timbre():
    blocos = [{"tipo": "titulo", "texto": "ALTERAÇÃO – EMPRESA & CIA", "linhas": []},
              {"tipo": "paragrafo", "texto": "**FULANO**, RG [informar: RG], sócio.", "linhas": []},
              {"tipo": "tabela", "texto": "", "linhas": [["SÓCIO", "QUOTAS"], ["FULANO", "10"], ["TOTAL", "10"]]},
              {"tipo": "assinatura", "texto": "FULANO\nSócio", "linhas": []}]
    novo = ml.montar_docx_modelo(_modelo_docx(), blocos)
    with zipfile.ZipFile(io.BytesIO(novo)) as z:
        doc = z.read("word/document.xml").decode()
        assert z.read("word/header1.xml") == b"<w:hdr>TIMBRE</w:hdr>"
    assert 'r:id="rId8"' in doc and 'w:top="1814"' in doc  # timbre e margens do modelo
    assert "EMPRESA &amp; CIA" in doc and "<w:tbl>" in doc
    assert '<w:highlight w:val="yellow"/>' in doc and "[informar: RG]" in doc
    assert "<w:b/>" in doc and "**" not in doc
    assert ml.texto_docx(novo).startswith("ALTERAÇÃO – EMPRESA & CIA\nFULANO, RG [informar: RG], sócio.")

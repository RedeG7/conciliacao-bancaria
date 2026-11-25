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
           _ap("parágrafo\ncomeço", "x", i=5),        # passa de um parágrafo para outro: à mão
           _ap("Cláusula 2\tObjeto", "x", i=6),        # atravessa a tabulação: à mão
           _ap("não existe", "x", i=7)]
    novo, manuais = ml.aplicar_no_docx(_docx(), aps)
    assert [a["id"] for a in manuais] == [5, 6, 7]
    assert ml.texto_docx(novo) == ("CONTRATO SOCIAL - 3ª ALTERAÇÃO\nSócio B: R$ 40.000,00 (quarenta mil reais) em quotas\n"
                                   "Cláusula 2\tObjeto & endereço\nFim do parágrafo\ncomeço do outro")
    xml = _ler(novo, "word/document.xml").decode()
    # formatação preservada: o valor novo fica no run em negrito, estilos e
    # namespaces (mc:Ignorable) intactos, demais partes do arquivo iguais
    assert '<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">R$ 40.000,00 (quarenta mil reais)</w:t>' in xml
    assert '<w:pStyle w:val="Titulo"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>' in xml
    assert 'mc:Ignorable="w14"' in xml and "&amp; endereço" in xml
    assert _ler(novo, "word/header1.xml") == HEADER
    assert _ler(novo, "word/styles.xml") == b"<w:styles/>"


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


def test_pdf_sem_libreoffice(monkeypatch):
    monkeypatch.setattr(ml, "libreoffice", lambda: None)
    with pytest.raises(ml.ErroConversao):
        ml.docx_para_pdf(_docx())

"""Testes do Gerador de DANFSe (gerador_danfse.py) - sem o gerador da Receita:
leitura dos XMLs/.zip, resumo da nota, nomes dos PDFs e a chamada HTTP
(contra um servidor falso local)."""

from __future__ import annotations

import io
import json
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

import gerador_danfse as gd

XML = """<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infNFSe Id="NFS52087072212345678000195000000000001226110000000001">
    <xLocEmi>Senador Canedo</xLocEmi>
    <nNFSe>12</nNFSe>
    <dhProc>2026-11-10T09:15:00-03:00</dhProc>
    <emit><CNPJ>12345678000195</CNPJ><xNome>Prestador Ltda</xNome></emit>
    <valores><vLiq>950.00</vLiq></valores>
    <DPS><infDPS>
      <dhEmi>2026-11-09T18:00:00-03:00</dhEmi>
      <dCompet>2026-11-09</dCompet>
      <toma><CPF>12345678909</CPF><xNome>Fulano de Tal</xNome></toma>
      <valores><vServPrest><vServ>1000.00</vServ></vServPrest></valores>
    </infDPS></DPS>
  </infNFSe>
</NFSe>""".encode("utf-8")


def test_versao_bate_com_as_novidades():
    # a cada atualização: suba gerador_danfse.VERSAO e registre a novidade no topo
    assert gd.NOVIDADES[0][0] == gd.VERSAO
    versoes = [tuple(int(x) for x in v.split(".")) for v, _, _ in gd.NOVIDADES]
    assert versoes == sorted(versoes, reverse=True) and len(set(versoes)) == len(versoes)


def test_motor_bate_com_o_dockerfile():
    from pathlib import Path
    docker = (Path(__file__).resolve().parents[1] / "gerador-danfse" / "Dockerfile").read_text(encoding="utf-8")
    assert f"DANFSE_REF={gd.MOTOR.split()[0]}" in docker


def test_resumo_com_namespace():
    r = gd.resumo(XML)
    assert r["erro"] == ""
    assert r["numero"] == "12"
    assert r["chave"].startswith("5208707") and not r["chave"].startswith("NFS")
    assert r["emissao"] == "2026-11-09" and r["competencia"] == "2026-11-09"
    assert (r["prestador"], r["doc_prestador"]) == ("Prestador Ltda", "12345678000195")
    assert (r["tomador"], r["doc_tomador"]) == ("Fulano de Tal", "12345678909")
    assert r["valor"] == 1000.0 and r["municipio"] == "Senador Canedo"


def test_resumo_recusa_o_que_nao_e_nfse():
    assert "inválido" in gd.resumo(b"<NFSe><infNFSe>")["erro"]
    assert "NFS-e nacional" in gd.resumo(b"<nfeProc><NFe/></nfeProc>")["erro"]
    assert "DOCTYPE" in gd.resumo(b'<!DOCTYPE x [<!ENTITY a "b">]><NFSe/>')["erro"]
    embrulhado = gd.resumo(b"<retorno>" + XML.split(b"?>", 1)[1] + b"</retorno>")
    assert embrulhado["numero"] == "12" and "raiz NFSe" in embrulhado["erro"]


def test_ler_arquivos_xml_e_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("pasta/nota1.xml", XML)
        zf.writestr("leia-me.txt", "x")
        zf.writestr("NOTA2.XML", XML)
    xmls, avisos = gd.ler_arquivos([("solta.xml", XML), ("lote.zip", buf.getvalue()),
                                    ("foto.png", b"x"), ("ruim.zip", b"nao e zip")])
    assert [n for n, _ in xmls] == ["solta.xml", "nota1.xml", "NOTA2.XML"]
    assert all(x == XML for _, x in xmls)
    assert len(avisos) == 2 and "foto.png" in avisos[0] and "ruim.zip" in avisos[1]


def test_ler_arquivos_limites(monkeypatch):
    monkeypatch.setattr(gd, "MAX_XML", 10)
    monkeypatch.setattr(gd, "MAX_ARQUIVOS", 2)
    xmls, avisos = gd.ler_arquivos([("grande.xml", b"x" * 11), ("a.xml", b"1"), ("b.xml", b"2"), ("c.xml", b"3")])
    assert [n for n, _ in xmls] == ["a.xml", "b.xml"]
    assert "grande.xml" in avisos[0] and "c.xml" in avisos[1]


def test_nomes_dos_pdfs():
    r = gd.resumo(XML)
    assert gd.nome_pdf(r, "x.xml") == "DANFSe_12_12345678000195.pdf"
    assert gd.nome_pdf({"numero": ""}, "minha nota (1).xml") == "minha_nota_1.pdf"
    assert gd.nomes_unicos(["a.pdf", "b.pdf", "a.pdf", "a.pdf"]) == ["a.pdf", "b.pdf", "a (2).pdf", "a (3).pdf"]
    with zipfile.ZipFile(io.BytesIO(gd.zip_pdfs([("a.pdf", b"%PDF-1"), ("b.pdf", b"%PDF-2")]))) as zf:
        assert zf.namelist() == ["a.pdf", "b.pdf"] and zf.read("b.pdf") == b"%PDF-2"


def test_formatos():
    assert gd.moeda(1234.5) == "R$ 1.234,50" and gd.moeda(None) == ""
    assert gd.data_br("2026-11-09") == "09/11/2026"
    assert gd.documento_fmt("12345678000195") == "12.345.678/0001-95"
    assert gd.documento_fmt("12345678909") == "123.456.789-09"


class _Falso(BaseHTTPRequestHandler):
    pedidos: list = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200 if self.path == "/health/ready" else 404)
        self.end_headers()

    def do_POST(self):
        corpo = self.rfile.read(int(self.headers["Content-Length"]))
        url = urlparse(self.path)
        _Falso.pedidos.append((url.path, parse_qs(url.query), self.headers["Content-Type"], corpo))
        if b"<NFSe" not in corpo:
            dados = json.dumps({"sucesso": False, "mensagem": "XML inválido."}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
        else:
            dados = b"%PDF-1.7 falso"
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)


@pytest.fixture
def servidor(monkeypatch):
    srv = HTTPServer(("127.0.0.1", 0), _Falso)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("GERADOR_DANFSE_URL", f"http://127.0.0.1:{srv.server_port}/")
    _Falso.pedidos.clear()
    yield srv
    srv.shutdown()


def test_gerar_pdf(servidor):
    assert gd.disponivel()
    assert gd.gerar_pdf(XML, 2, canhoto=False).startswith(b"%PDF")
    caminho, query, tipo, corpo = _Falso.pedidos[0]
    assert caminho == "/api/danfse" and query == {"stc": ["2"], "canhoto": ["false"]}
    assert tipo == "application/xml" and corpo == XML
    with pytest.raises(gd.ErroDanfse) as e:
        gd.gerar_pdf(b"<x/>")
    assert e.value.status == 400 and str(e.value) == "XML inválido."
    with pytest.raises(ValueError):
        gd.gerar_pdf(XML, 5)


def test_gerador_fora_do_ar(monkeypatch):
    monkeypatch.setenv("GERADOR_DANFSE_URL", "http://127.0.0.1:9")
    assert not gd.disponivel()
    with pytest.raises(gd.ErroDanfse) as e:
        gd.gerar_pdf(XML)
    assert e.value.status is None and "fora do ar" in str(e.value)

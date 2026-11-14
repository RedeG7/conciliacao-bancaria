"""Integrações dos canais (admissoes_canais.py): configuração por escritório
com token cifrado e a sincronização com o Acessórias (API simulada)."""

from __future__ import annotations

import io
import json
import urllib.error
from datetime import date

import pytest

import admissoes as adm
import admissoes_canais as canais
import auth
import clientes
from conftest import ESC_A, ESC_B

TOKEN = "tok-secreto-de-teste-123"
CNPJ_ALFA = "11.222.333/0001-81"


def _sol(sol_id, assunto="Admissão de funcionário", dpto="Pessoal", cnpj=CNPJ_ALFA, anexos=("ficha.pdf",),
         encerrada="Não", texto=""):
    return {
        "SolID": str(sol_id), "SolAssunto": assunto, "DptoNome": dpto, "EmpCNPJ": cnpj, "EmpID": "9",
        "SolStatus": "Nova", "SolEncerrada": encerrada,
        "SolInteracoes": [[{"CmtText": texto, "CmtAnx": [{"Nome": n, "Url": "https://x/" + n} for n in anexos]}]],
    }


class FakeAcessorias:
    def __init__(self, solicitacoes=(), erro=None):
        self.solicitacoes_lista = list(solicitacoes)
        self.erro = erro
        self.chamadas = []

    def solicitacoes(self, desde, pagina):
        self.chamadas.append((desde, pagina))
        if self.erro:
            raise canais.ErroCanal(self.erro)
        return self.solicitacoes_lista if pagina == 1 else []

    def departamentos(self):
        return ["Pessoal", "Fiscal"]


@pytest.fixture
def ativo(db):
    canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", True, {"token": TOKEN})
    return True


# --- configuração -----------------------------------------------------------

def test_token_fica_cifrado_e_nao_volta(db):
    cfg = canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", False, {"token": TOKEN})
    assert cfg["segredos_salvos"] == ["token"] and TOKEN not in json.dumps(cfg, default=str)
    with auth.conectar() as conn:
        bruto = conn.execute("SELECT segredos_cifrados, parametros FROM admissoes_canais_config").fetchone()
    assert TOKEN.encode() not in bytes(bruto["segredos_cifrados"]) and TOKEN not in json.dumps(bruto["parametros"])


def test_token_em_branco_mantem_o_salvo_e_pode_apagar(db):
    canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", False, {"token": TOKEN})
    canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", False, {"token": "", "departamentos": "DP"})
    assert canais._segredos(ESC_A, canais.ACESSORIAS)["token"] == TOKEN
    assert canais.obter_config(ESC_A, canais.ACESSORIAS)["parametros"]["departamentos"] == "DP"
    cfg = canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", False, {}, limpar_segredos=("token",))
    assert cfg["segredos_salvos"] == []


def test_padroes_aparecem_sem_config(db):
    cfg = canais.obter_config(ESC_A, canais.ACESSORIAS)
    assert cfg["ativo"] is False and cfg["parametros"]["departamentos"] == "Pessoal"


def test_ativar_exige_token(db):
    with pytest.raises(canais.ConfigInvalida):
        canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", True, {})


def test_canal_ainda_indisponivel_nao_ativa_mas_guarda(db):
    with pytest.raises(canais.ConfigInvalida):
        canais.salvar_config(ESC_A, canais.WHATSAPP, "dp_admin", True, {"access_token": "x"})
    cfg = canais.salvar_config(ESC_A, canais.WHATSAPP, "dp_admin", False, {"phone_number_id": "123", "access_token": "x"})
    assert cfg["parametros"]["phone_number_id"] == "123" and cfg["segredos_salvos"] == ["access_token"]


def test_dias_retroativos_validado(db):
    with pytest.raises(canais.ConfigInvalida):
        canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", False, {"dias_retroativos": "abc"})


def test_config_isolada_por_escritorio(db):
    canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", True, {"token": TOKEN})
    assert canais.obter_config(ESC_B, canais.ACESSORIAS)["ativo"] is False
    assert canais._segredos(ESC_B, canais.ACESSORIAS) == {}


# --- sincronização com o Acessórias -------------------------------------------

def test_sinc_cria_admissao_com_empresa_pelo_cnpj(ativo):
    fake = FakeAcessorias([_sol(500, anexos=("ficha.pdf", "aso.pdf"))])
    r = canais.sincronizar_acessorias(ESC_A, cliente=fake)
    assert r["novas"] == 1 and r["sem_empresa"] == 0
    a = adm.listar(ESC_A)[0]
    assert (a["canal"], a["id_externo"], a["status"], a["cliente_nome"]) == ("acessorias", "500", "queued", "Padaria Alfa")
    assert a["resumo"] == "Admissão de funcionário"
    assert adm.obter(a["id"], ESC_A)["documentos"] == ["ficha.pdf", "aso.pdf"]


def test_sinc_filtra_departamento_e_assunto(ativo):
    fake = FakeAcessorias([
        _sol(1, dpto="Fiscal"),
        _sol(2, assunto="Dúvida sobre férias"),
        _sol(3, assunto="Novo funcionário", texto="Segue a ADMISSAO da Maria"),
        _sol(4, assunto="CONTRATAÇÃO de vendedor"),
    ])
    r = canais.sincronizar_acessorias(ESC_A, cliente=fake)
    assert r["lidas"] == 4 and r["novas"] == 2
    assert sorted(a["id_externo"] for a in adm.listar(ESC_A)) == ["3", "4"]


def test_sinc_repetida_nao_duplica_e_pega_anexo_novo(ativo):
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(7)]))
    r = canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(7, anexos=("ficha.pdf", "ctps.pdf"))]))
    assert r["novas"] == 0 and r["atualizadas"] == 1
    assert len(adm.listar(ESC_A)) == 1
    assert adm.listar(ESC_A)[0]["id_externo"] == "7"


def test_sinc_cnpj_desconhecido_entra_bloqueada(ativo):
    r = canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(8, cnpj="99.999.999/0001-99")]))
    assert r["sem_empresa"] == 1 and adm.listar(ESC_A)[0]["status"] == adm.BLOCKED


def test_sinc_ignora_encerrada_nova(ativo):
    r = canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(9, encerrada="Sim")]))
    assert r["novas"] == 0 and adm.listar(ESC_A) == []


def test_sinc_usa_janela_e_depois_continua_de_onde_parou(ativo):
    fake = FakeAcessorias()
    canais.sincronizar_acessorias(ESC_A, cliente=fake, hoje=date(2026, 11, 14))
    assert fake.chamadas[0] == (date(2026, 11, 7), 1)  # 7 dias na primeira vez
    fake2 = FakeAcessorias()
    canais.sincronizar_acessorias(ESC_A, cliente=fake2, hoje=date(2026, 11, 14))
    assert fake2.chamadas[0][0] == date.today() - __import__("datetime").timedelta(days=1)


def test_sinc_erro_fica_registrado_sem_token(ativo):
    with pytest.raises(canais.ErroCanal):
        canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias(erro="Acessórias recusou o token"))
    cfg = canais.obter_config(ESC_A, canais.ACESSORIAS)
    assert cfg["ultima_sinc_ok"] is False and TOKEN not in cfg["ultima_sinc_msg"]


def test_sinc_inativa_recusa(db):
    with pytest.raises(canais.ConfigInvalida):
        canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias())


def test_sinc_isolada_por_escritorio(ativo):
    clientes.criar_cliente(ESC_B, "Outra com mesmo CNPJ", "999", CNPJ_ALFA)
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(11)]))
    assert adm.listar(ESC_B) == [] and adm.listar(ESC_A)[0]["cliente_nome"] == "Padaria Alfa"


def test_sincronizar_todos_so_os_ativos(db, monkeypatch):
    canais.salvar_config(ESC_A, canais.ACESSORIAS, "dp_admin", True, {"token": TOKEN})
    canais.salvar_config(ESC_B, canais.ACESSORIAS, "x", False, {"token": TOKEN})
    feitos = []
    monkeypatch.setattr(canais, "sincronizar_acessorias", lambda esc, **k: feitos.append(esc))
    canais.sincronizar_todos()
    assert feitos == [ESC_A]


# --- cliente HTTP (sem rede) --------------------------------------------------

class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_cliente_monta_requisicao_com_bearer_e_filtros():
    vistos = []

    def abrir(req, timeout):
        vistos.append(req)
        return _Resp(json.dumps([{"SolID": "1"}]).encode())

    c = canais.AcessoriasCliente(TOKEN, abrir=abrir)
    assert c.solicitacoes(date(2026, 11, 1), 2) == [{"SolID": "1"}]
    req = vistos[0]
    assert req.full_url == "https://api.acessorias.com/requests/ListAll?SolTipo=E&SolUltAtIni=2026-11-01&Pagina=2"
    assert req.get_header("Authorization") == f"Bearer {TOKEN}"


def test_cliente_erro_de_negocio_e_401_nao_vazam_token():
    c = canais.AcessoriasCliente(TOKEN, abrir=lambda req, timeout: _Resp(b'{"Erro": "Parametro invalido"}'))
    with pytest.raises(canais.ErroCanal, match="Parametro invalido"):
        c.departamentos()

    def negar(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

    with pytest.raises(canais.ErroCanal) as exc:
        canais.AcessoriasCliente(TOKEN, abrir=negar).departamentos()
    assert TOKEN not in str(exc.value)


def test_cliente_sem_token_recusa():
    with pytest.raises(canais.ErroCanal):
        canais.AcessoriasCliente("")


# --- empresas: reconhecer quem abriu a solicitação -----------------------------

class FakeEmpresas(FakeAcessorias):
    def __init__(self, empresas, **kw):
        super().__init__(**kw)
        self.empresas_lista = empresas

    def empresas(self, pagina):
        return self.empresas_lista if pagina == 1 else []


def _emp(id_, cnpj, razao, fantasia=""):
    return {"ID": str(id_), "Identificador": cnpj, "Razao": razao, "Fantasia": fantasia}


def test_sinc_guarda_nome_da_empresa_do_canal(ativo):
    sol = {**_sol(20, cnpj="55.666.777/0001-88"), "EmpNome": "Loja Nova LTDA"}
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([sol]))
    a = adm.listar(ESC_A)[0]
    assert a["status"] == adm.BLOCKED and a["empresa_nome"] == "Loja Nova LTDA"


def test_importar_empresas_com_id_como_codigo_religa_bloqueada(ativo):
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(21, cnpj="55.666.777/0001-88")]))
    fake = FakeEmpresas([
        _emp(300, "55.666.777/0001-88", "Loja Nova LTDA"),
        _emp(101, "11.222.333/0001-81", "Padaria Alfa"),          # já cadastrada pelo CNPJ
        _emp(102, "22.333.444/0001-55", "Outra"),
    ])
    r = canais.importar_empresas_acessorias(ESC_A, "dp_admin", True, cliente=fake)
    assert (r["criadas"], r["ja_cadastradas"], r["religadas"]) == (2, 1, 1)
    a = adm.listar(ESC_A)[0]
    assert a["status"] == adm.QUEUED and a["cliente_nome"] == "Loja Nova LTDA"
    novo = [c for c in clientes.listar_clientes(ESC_A) if c["cnpj"] == "55666777000188"][0]
    assert novo["codigo_dominio"] == "300"
    eventos = adm.listar_eventos(a["id"], ESC_A)
    assert eventos[-1]["para"] == adm.QUEUED and "Loja Nova" in eventos[-1]["motivo"]


def test_importar_sem_id_como_codigo_so_completa_cnpj_por_nome(ativo):
    clientes.criar_cliente(ESC_A, "Mercado Gama", "777")
    fake = FakeEmpresas([_emp(5, "33.444.555/0001-66", "MERCADO GAMA"), _emp(6, "44.555.666/0001-77", "Sem Cadastro")])
    r = canais.importar_empresas_acessorias(ESC_A, "dp_admin", False, cliente=fake)
    assert (r["cnpj_preenchido"], r["criadas"], r["sem_codigo"]) == (1, 0, 1)
    gama = [c for c in clientes.listar_clientes(ESC_A) if c["codigo_dominio"] == "777"][0]
    assert gama["cnpj"] == "33444555000166"


def test_importar_nao_sobrescreve_codigo_em_uso(ativo):
    r = canais.importar_empresas_acessorias(ESC_A, "dp_admin", True,
                                            cliente=FakeEmpresas([_emp(101, "66.777.888/0001-99", "Conflito")]))
    assert r["codigo_em_uso"] == 1 and r["criadas"] == 0


def test_cadastro_manual_da_empresa_religa(ativo):
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(22, cnpj="77.888.999/0001-00")]))
    clientes.criar_cliente(ESC_A, "Cadastrada Depois", "880", "77888999000100")
    assert adm.religar_empresas(ESC_A, "dp_admin") == 1
    assert adm.listar(ESC_A)[0]["cliente_nome"] == "Cadastrada Depois"


def test_vincular_empresa_manual(ativo):
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(23, cnpj="")]))
    a = adm.listar(ESC_A)[0]
    assert a["status"] == adm.BLOCKED
    alfa = clientes.listar_clientes(ESC_A)[0]
    v = adm.vincular_empresa(a["id"], ESC_A, alfa["id"], "dp_user")
    assert v["status"] == adm.QUEUED and v["cliente_id"] == alfa["id"] and v["motivo"] is None


def test_vincular_empresa_de_outro_escritorio_recusa(ativo):
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(24, cnpj="")]))
    a = adm.listar(ESC_A)[0]
    beta = clientes.listar_clientes(ESC_B)[0]
    with pytest.raises(adm.AdmissaoNaoEncontrada):
        adm.vincular_empresa(a["id"], ESC_A, beta["id"], "dp_user")


def test_vincular_empresa_depois_do_agente_recusa(ativo):
    canais.sincronizar_acessorias(ESC_A, cliente=FakeAcessorias([_sol(25)]))
    a = adm.reservar_proxima(ESC_A, "agente")
    with pytest.raises(adm.TransicaoInvalida):
        adm.vincular_empresa(a["id"], ESC_A, a["cliente_id"], "dp_user")


def test_reenvio_completa_nome_e_assunto_que_faltavam(db):
    adm.receber_solicitacao(ESC_A, "acessorias", "30", "101", [])
    linha, dup = adm.receber_solicitacao(ESC_A, "acessorias", "30", "101", [], resumo="Admissão", empresa_nome="Padaria")
    assert dup and (linha["resumo"], linha["empresa_nome"]) == ("Admissão", "Padaria")


# --- material da solicitação para o agente -----------------------------------

class FakeMaterial:
    def __init__(self, sol, arquivos):
        self.sol = sol
        self.arquivos = arquivos
        self.baixados = []

    def solicitacao(self, sol_id):
        assert sol_id == self.sol["SolID"]
        return self.sol

    def baixar(self, url, limite):
        self.baixados.append(url)
        conteudo = self.arquivos[url]
        if isinstance(conteudo, Exception):
            raise conteudo
        return conteudo


def test_material_baixa_pdf_e_imagem_e_ignora_o_resto():
    import base64
    sol = _sol(171, texto="Segue a ficha", anexos=("ficha.pdf", "aso.JPG", "planilha.xlsx", "rg.png"))
    fake = FakeMaterial(sol, {"https://x/ficha.pdf": b"%PDF-1", "https://x/aso.JPG": b"jpg",
                              "https://x/rg.png": canais.ErroCanal("Anexo indisponível (HTTP 404)")})
    m = canais.material_acessorias(ESC_A, "171", fake)
    assert m["mensagens"] == ["Segue a ficha"]
    assert [(d["nome"], d["tipo"]) for d in m["documentos"]] == [("ficha.pdf", "application/pdf"),
                                                                ("aso.JPG", "image/jpeg")]
    assert base64.b64decode(m["documentos"][0]["base64"]) == b"%PDF-1"
    motivos = {i["nome"]: i["motivo"] for i in m["ignorados"]}
    assert "planilha.xlsx" in motivos and "HTTP 404" in motivos["rg.png"]
    assert "https://x/planilha.xlsx" not in fake.baixados


def test_material_respeita_limite_total(monkeypatch):
    monkeypatch.setattr(canais, "MAX_MATERIAL_BYTES", 10)
    sol = _sol(5, anexos=("a.pdf", "b.pdf"))
    fake = FakeMaterial(sol, {"https://x/a.pdf": b"12345678", "https://x/b.pdf": b"12345678"})
    m = canais.material_acessorias(ESC_A, "5", fake)
    assert [d["nome"] for d in m["documentos"]] == ["a.pdf"]
    assert m["ignorados"][0]["nome"] == "b.pdf"


def test_material_de_canal_sem_integracao_so_lista_nomes():
    m = canais.material_para_agente(ESC_A, {"canal": "whatsapp", "resumo": "", "documentos": ["ficha.pdf"]})
    assert m["documentos"] == [] and m["ignorados"][0]["nome"] == "ficha.pdf"


def test_baixar_anexo_so_https_publico_e_token_so_para_o_acessorias(monkeypatch):
    vistos = []

    def abrir(req, timeout):
        vistos.append(req)
        return _Resp(b"conteudo")

    c = canais.AcessoriasCliente(TOKEN, abrir=abrir)
    monkeypatch.setattr(canais, "_host_publico", lambda host: host != "interno.local")
    with pytest.raises(canais.ErroCanal):
        c.baixar("http://api.acessorias.com/a.pdf", 100)
    with pytest.raises(canais.ErroCanal):
        c.baixar("https://interno.local/a.pdf", 100)
    assert c.baixar("https://arquivos.acessorias.com/a.pdf", 100) == b"conteudo"
    assert c.baixar("https://s3.amazonaws.com/a.pdf", 100) == b"conteudo"
    assert vistos[0].get_header("Authorization") == f"Bearer {TOKEN}"
    assert vistos[1].get_header("Authorization") is None
    with pytest.raises(canais.ErroCanal, match="grande"):
        c.baixar("https://s3.amazonaws.com/a.pdf", 3)


def test_host_privado_e_recusado():
    assert canais._host_publico("localhost") is False
    assert canais._host_publico("127.0.0.1") is False

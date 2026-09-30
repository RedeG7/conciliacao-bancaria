"""Wrapper Playwright para o download de XML de NF-e no portal da SEFAZ-GO
(netaccess - Acesso Restrito > Baixar XML NF-e).

Fluxo pedido pelo escritório (roteiro manual traduzido para automação):
  1. Abre LOGIN_URL. O certificado digital do escritório é apresentado no
     handshake TLS - por isso o contexto do browser já nasce com
     client_certificates (ver rpa.registry.criar_contexto), sem a janela
     "Selecionar certificado" do navegador (Playwright não enxerga janelas
     nativas do SO; entregar o .pfx no contexto é o equivalente).
  2. Acesso Restrito > Baixar XML NF-e > CPF + senha do escritório > Entrar.
     Se aparecer a pergunta de salvar senha, clica em "Depois".
  3. Tela "Baixar XML NF-e": Período (1º ao último dia da competência),
     Inscrição Estadual, Tipo de nota (Entrada/Saída), Modelo "Todas",
     Pesquisar.
  4. Resultado: lê o total de notas da tela + print da página inteira
     (evidência). "Baixar todos os arquivos" > "Baixar documentos e
     eventos" > "Baixar" > captura o arquivo (download direto ou o link
     "Baixar XML" que aparece no topo da tela quando o arquivo fica pronto).
  5. "Nova consulta" volta pro formulário - mesma IE, agora Saída.

NUNCA rodou contra o portal de verdade: o ambiente onde este módulo foi
escrito não alcança www.sefaz.go.gov.br. Os seletores são por texto
visível/rótulo (mesma estratégia de rpa/issweb/portal.py), com vários
nomes alternativos por campo - a primeira execução real deve ser
acompanhada, e ajustes finos de texto são esperados (o print da tela
salvo em screenshot_erro mostra exatamente onde parou).

Cada função levanta ErroPortal com a etapa que falhou - o worker marca só
aquela linha (empresa + tipo) como ERRO e segue para a próxima.
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

LOGIN_URL = "https://www.sefaz.go.gov.br/netaccess/000System/acessoRestrito/login/"
CERTIFICADO_ORIGIN = "https://www.sefaz.go.gov.br"

TIMEOUT_PADRAO_MS = 20_000
TIMEOUT_CURTO_MS = 4_000
TIMEOUT_PESQUISA_MS = 90_000
# a SEFAZ monta o pacote de XMLs sob demanda - com centenas de notas pode
# demorar bem mais que um download comum
TIMEOUT_DOWNLOAD_MS = 300_000

TEXTOS_TIPO = {"ENTRADA": ["Entrada", "Entradas"], "SAIDA": ["Saída", "Saida", "Saídas", "Saidas"]}


class ErroPortal(Exception):
    """Falha numa etapa da automacao do portal — nunca aborta o lote inteiro."""


# ---------------------------------------------------------------------------
# Localizadores genéricos (página + iframes)
# ---------------------------------------------------------------------------

def _escopos(page: Page):
    """Sistemas antigos da SEFAZ ainda usam frame/iframe pro conteúdo - toda
    busca olha a página principal primeiro e depois cada frame filho."""
    return [page.main_frame] + [f for f in page.frames if f != page.main_frame]


def _texto_regex(texto: str):
    return re.compile(re.escape(texto), re.I)


def _rotulo_regex(texto: str):
    """Rótulo de campo ancorado no início ("Data inicial", "Modelo") - sem
    isso um rótulo curto casa no meio de outro ("ie" dentro de "Série")."""
    return re.compile(rf"^\s*{re.escape(texto)}", re.I)


def _candidatos_clique(escopo, texto: str):
    rx = _texto_regex(texto)
    return [
        escopo.get_by_role("button", name=rx),
        escopo.get_by_role("link", name=rx),
        escopo.get_by_role("menuitem", name=rx),
        escopo.locator(f"input[type=button][value*='{texto}' i], input[type=submit][value*='{texto}' i]"),
        escopo.get_by_text(rx),
    ]


def _achar_visivel(page: Page, textos: list[str]):
    for texto in textos:
        for escopo in _escopos(page):
            for loc in _candidatos_clique(escopo, texto):
                try:
                    qtd = loc.count()
                except Exception:
                    continue
                for i in range(min(qtd, 5)):
                    item = loc.nth(i)
                    try:
                        if item.is_visible():
                            return item
                    except Exception:
                        continue
    return None


def _clicar(page: Page, textos: list[str], timeout: int = TIMEOUT_CURTO_MS) -> str | None:
    """Clica no primeiro texto da lista que aparecer (tenta até timeout).
    Retorna o texto clicado, ou None se nenhum apareceu."""
    esperado = 0
    while True:
        for texto in textos:
            alvo = _achar_visivel(page, [texto])
            if alvo is not None:
                alvo.scroll_into_view_if_needed(timeout=TIMEOUT_CURTO_MS)
                alvo.click()
                return texto
        if esperado >= timeout:
            return None
        page.wait_for_timeout(500)
        esperado += 500


def _existe(page: Page, textos: list[str], timeout: int = TIMEOUT_CURTO_MS) -> str | None:
    esperado = 0
    while True:
        for texto in textos:
            for escopo in _escopos(page):
                loc = escopo.get_by_text(_texto_regex(texto))
                try:
                    if loc.count() and loc.first.is_visible():
                        return texto
                except Exception:
                    continue
        if esperado >= timeout:
            return None
        page.wait_for_timeout(500)
        esperado += 500


def texto_da_tela(page: Page) -> str:
    partes = []
    for escopo in _escopos(page):
        try:
            partes.append(escopo.locator("body").inner_text(timeout=TIMEOUT_CURTO_MS))
        except Exception:
            continue
    return "\n".join(partes)


def _campo(page: Page, rotulos: list[str], css: list[str]):
    """Acha um input por rótulo (label/aria/placeholder) ou, na falta, por
    atributos name/id típicos. Retorna o primeiro VISÍVEL."""
    for escopo in _escopos(page):
        candidatos = []
        for rotulo in rotulos:
            rx = _rotulo_regex(rotulo)
            candidatos += [escopo.get_by_label(rx), escopo.get_by_placeholder(rx)]
        candidatos += [escopo.locator(seletor) for seletor in css]
        for loc in candidatos:
            try:
                qtd = loc.count()
            except Exception:
                continue
            for i in range(min(qtd, 5)):
                item = loc.nth(i)
                try:
                    if item.is_visible() and item.is_editable():
                        return item
                except Exception:
                    continue
    return None


def _preencher(campo, valor: str) -> None:
    """fill() direto; se o campo tiver máscara que rejeita o texto colado
    (comum em data/IE), apaga e digita só os dígitos, tecla por tecla."""
    campo.click()
    campo.fill(valor)
    atual = re.sub(r"\D", "", campo.input_value() or "")
    if atual != re.sub(r"\D", "", valor):
        campo.fill("")
        campo.press_sequentially(re.sub(r"\D", "", valor), delay=40)
    campo.dispatch_event("change")
    campo.dispatch_event("blur")


def _clicar_se_existir(page: Page, textos: list[str], timeout: int = 2_000) -> bool:
    return _clicar(page, textos, timeout=timeout) is not None


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def _formulario_consulta_visivel(page: Page, timeout: int = TIMEOUT_CURTO_MS) -> bool:
    return _existe(page, ["Inscrição Estadual", "Inscricao Estadual"], timeout=timeout) is not None and \
        _existe(page, ["Pesquisar", "Consultar"], timeout=1_000) is not None


def _abrir_menu_baixar_xml(page: Page) -> None:
    _clicar_se_existir(page, ["Acesso Restrito"], timeout=2_000)
    _clicar(page, ["Baixar XML NF-e", "Baixar XML NFe", "Baixar XML NFE", "Download de XML", "Baixar XML"],
            timeout=TIMEOUT_CURTO_MS)


def login(page: Page, cpf: str, senha: str) -> None:
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)

    # se já cair direto no formulário de CPF, os cliques abaixo só não acham nada
    _abrir_menu_baixar_xml(page)

    campo_cpf = _campo(
        page, ["CPF", "Usuário", "Usuario", "Login"],
        ["input[name*=cpf i]", "input[id*=cpf i]", "input[name*=usuario i]", "input[name*=login i]"],
    )
    campo_senha = _campo(page, ["Senha"], ["input[type=password]"])
    if campo_cpf is None or campo_senha is None:
        if _formulario_consulta_visivel(page, timeout=1_000):
            return  # sessão ainda válida (reaproveitada)
        raise ErroPortal("[login] campos de CPF/senha não encontrados na tela de Acesso Restrito")

    _preencher(campo_cpf, cpf)
    campo_senha.fill(senha)
    if _clicar(page, ["Entrar", "Acessar", "Login", "Confirmar"], timeout=TIMEOUT_CURTO_MS) is None:
        campo_senha.press("Enter")

    erros = ["senha inválida", "senha invalida", "usuário ou senha", "usuario ou senha",
             "cpf inválido", "cpf invalido", "acesso negado", "não autorizado", "nao autorizado",
             "bloquead"]
    achou = _existe(page, erros, timeout=3_000)
    if achou:
        raise ErroPortal(f"[login] portal recusou o acesso ('{achou}') — confira CPF/senha em Credenciais")

    # "Deseja salvar a senha?" -> Depois (pode ser do próprio portal; o do
    # navegador nem aparece no Chromium do Playwright)
    _clicar_se_existir(page, ["Depois", "Agora não", "Agora nao", "Lembrar depois"], timeout=3_000)

    abrir_formulario(page)


def abrir_formulario(page: Page) -> None:
    """Garante que a tela "Baixar XML NF-e" (formulário de consulta) está
    aberta - clica em Nova consulta se estiver no resultado anterior, ou
    no menu Baixar XML NF-e se estiver em outra tela."""
    if _formulario_consulta_visivel(page, timeout=1_000):
        return
    _clicar_se_existir(page, ["Nova consulta", "Nova Consulta", "Nova pesquisa"], timeout=1_500)
    if _formulario_consulta_visivel(page, timeout=3_000):
        return
    _clicar_se_existir(page, ["Depois"], timeout=1_000)
    _abrir_menu_baixar_xml(page)
    if not _formulario_consulta_visivel(page, timeout=TIMEOUT_PADRAO_MS):
        raise ErroPortal(
            "[consulta] tela 'Baixar XML NF-e' (Período / Inscrição Estadual) não abriu — "
            "sessão pode ter expirado ou o menu mudou de nome"
        )


# ---------------------------------------------------------------------------
# Consulta
# ---------------------------------------------------------------------------

def _campos_periodo(page: Page):
    inicio = _campo(
        page, ["Data inicial", "Data Início", "Data Inicio", "Período inicial", "Periodo inicial"],
        ["input[name*=inicial i]", "input[id*=inicial i]", "input[name*=inicio i]", "input[id*=inicio i]",
         "input[name*=dtIni i]", "input[id*=dtIni i]", "input[name*=dataDe i]"],
    )
    fim = _campo(
        page, ["Data final", "Data Fim", "Período final", "Periodo final"],
        ["input[name*=final i]", "input[id*=final i]", "input[name*=fim i]", "input[id*=fim i]",
         "input[name*=dtFim i]", "input[id*=dtFim i]", "input[name*=dataAte i]"],
    )
    if inicio is not None and fim is not None:
        return inicio, fim
    # fallback: os 2 primeiros inputs de texto depois do rótulo "Período"
    for escopo in _escopos(page):
        rotulo = escopo.get_by_text(re.compile(r"^\s*Per[ií]odo", re.I)).first
        try:
            if not rotulo.count():
                continue
        except Exception:
            continue
        seguintes = rotulo.locator(
            "xpath=following::input[(@type='text' or @type='date' or not(@type)) and not(@disabled)]"
        )
        if seguintes.count() >= 2:
            return seguintes.nth(0), seguintes.nth(1)
    raise ErroPortal("[consulta] campos do Período (data inicial/final) não encontrados")


def _selecionar_no_select(select, textos: list[str]) -> bool:
    try:
        if not select.is_visible():
            return False
        opcoes = [o.strip() for o in select.locator("option").all_inner_texts()]
    except Exception:
        return False
    for t in textos:
        alvo = next((o for o in opcoes if o.lower() == t.lower()), None)
        if alvo:
            select.select_option(label=alvo)
            return True
    return False


def _marcar_opcao(page: Page, grupo: list[str], textos: list[str]) -> None:
    """Marca uma opção que pode ser <select>, radio ou checkbox: tenta o
    select com o rótulo do grupo, depois radio/checkbox com o texto exato,
    depois qualquer select que tenha a opção, e por fim clique no texto."""
    for escopo in _escopos(page):
        for g in grupo:
            sel = escopo.get_by_label(_rotulo_regex(g))
            try:
                for i in range(min(sel.count(), 3)):
                    item = sel.nth(i)
                    if item.evaluate("e => e.tagName") == "SELECT" and _selecionar_no_select(item, textos):
                        return
            except Exception:
                continue
    for escopo in _escopos(page):
        for t in textos:
            exato = re.compile(rf"^\s*{re.escape(t)}\s*$", re.I)
            for loc in (escopo.get_by_role("radio", name=exato), escopo.get_by_role("checkbox", name=exato),
                        escopo.get_by_label(exato)):
                try:
                    if loc.count() and loc.first.is_visible():
                        loc.first.check()
                        return
                except Exception:
                    continue
    for escopo in _escopos(page):
        selects = escopo.locator("select")
        for i in range(selects.count()):
            if _selecionar_no_select(selects.nth(i), textos):
                return
    if _clicar(page, textos, timeout=1_000) is None:
        raise ErroPortal(f"[consulta] opção '{textos[0]}' ({grupo[0]}) não encontrada no formulário")


def pesquisar(page: Page, data_inicial: str, data_final: str, inscricao_estadual: str, tipo: str) -> None:
    """Preenche o formulário e clica em Pesquisar. tipo: 'ENTRADA' | 'SAIDA'."""
    inicio, fim = _campos_periodo(page)
    _preencher(inicio, data_inicial)
    _preencher(fim, data_final)

    campo_ie = _campo(
        page, ["Inscrição Estadual", "Inscricao Estadual"],
        ["input[name*=inscricao i]", "input[id*=inscricao i]", "input[name=ie i]", "input[id=ie i]"],
    )
    if campo_ie is None:
        raise ErroPortal("[consulta] campo Inscrição Estadual não encontrado")
    _preencher(campo_ie, inscricao_estadual)

    _marcar_opcao(page, ["Tipo de nota", "Tipo da nota", "Tipo de Operação", "Tipo"], TEXTOS_TIPO[tipo])
    _marcar_opcao(page, ["Modelo"], ["Todas", "Todos"])

    # o botão fica no fim do formulário ("descer a barra de rolagem") -
    # _clicar já faz scroll_into_view antes de clicar
    if _clicar(page, ["Pesquisar", "Consultar", "Buscar"], timeout=TIMEOUT_CURTO_MS) is None:
        raise ErroPortal("[consulta] botão 'Pesquisar' não encontrado")
    try:
        page.wait_for_load_state("networkidle", timeout=TIMEOUT_PADRAO_MS)
    except PlaywrightTimeoutError:
        pass

    achou = _existe(
        page,
        ["Baixar todos", "Nenhum", "não foram encontrad", "nao foram encontrad", "Nova consulta",
         "encontrad", "Total"],
        timeout=TIMEOUT_PESQUISA_MS,
    )
    if achou is None:
        raise ErroPortal("[consulta] resultado da pesquisa não carregou (tempo esgotado)")
    erro = _existe(page, ["Inscrição Estadual inválida", "Inscricao Estadual invalida", "IE inválida",
                          "não possui permissão", "nao possui permissao", "sem permissão"], timeout=500)
    if erro:
        raise ErroPortal(f"[consulta] portal recusou a consulta: '{erro}'")


def evidencia(page: Page) -> bytes:
    """Print da página inteira do resultado (total de notas da SEFAZ)."""
    page.wait_for_timeout(800)
    return page.screenshot(full_page=True)


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def _salvar_download(download) -> tuple[bytes, str]:
    with tempfile.TemporaryDirectory() as tmp:
        caminho = Path(tmp) / (download.suggested_filename or "arquivo.bin")
        download.save_as(caminho)
        return caminho.read_bytes(), download.suggested_filename or ""


def _clicar_botao_baixar(page: Page, timeout: int) -> bool:
    """O botão final é só "Baixar" - procura o nome EXATO primeiro, pra não
    clicar de novo em "Baixar todos os arquivos"/"Baixar documentos e
    eventos" que continuam na tela."""
    exato = re.compile(r"^\s*(Baixar|Download)\s*$", re.I)
    esperado = 0
    while esperado <= timeout:
        for escopo in _escopos(page):
            for loc in (escopo.get_by_role("button", name=exato), escopo.get_by_role("link", name=exato),
                        escopo.locator("input[type=button][value='Baixar' i], input[type=submit][value='Baixar' i]")):
                try:
                    if loc.count() and loc.first.is_visible():
                        loc.first.scroll_into_view_if_needed(timeout=TIMEOUT_CURTO_MS)
                        loc.first.click()
                        return True
                except Exception:
                    continue
        page.wait_for_timeout(500)
        esperado += 500
    return False


def baixar_todos(page: Page) -> tuple[bytes, str]:
    """Baixar todos os arquivos > Baixar documentos e eventos > Baixar >
    (link "Baixar XML" no topo quando o pacote fica pronto). Retorna
    (bytes, nome sugerido pelo portal)."""
    downloads: list = []
    paginas_antes = set(page.context.pages)
    def ouvinte(download):
        downloads.append(download)

    page.on("download", ouvinte)
    try:
        if _clicar(page, ["Baixar todos os arquivos", "Baixar todos", "Download de todos"],
                   timeout=TIMEOUT_PADRAO_MS) is None:
            raise ErroPortal("[download] botão 'Baixar todos os arquivos' não encontrado no resultado")

        page.wait_for_timeout(1_000)
        if not downloads:
            _marcar_opcao(page, ["Tipo de download", "Opção", "Opcao", "Conteúdo", "Conteudo"],
                          ["Baixar documentos e eventos", "Documentos e eventos", "Documentos e Eventos"])
            if not _clicar_botao_baixar(page, TIMEOUT_PADRAO_MS):
                raise ErroPortal("[download] botão 'Baixar' (documentos e eventos) não encontrado")

        esperado = 0
        clicou_link_topo = False
        while not downloads and esperado < TIMEOUT_DOWNLOAD_MS:
            page.wait_for_timeout(1_000)
            esperado += 1_000
            # pacote grande: o portal avisa no topo quando fica pronto, com
            # um link pra baixar - clica nele uma vez quando aparecer
            if not clicou_link_topo and esperado % 3_000 == 0:
                if _clicar_se_existir(page, ["Baixar XML", "Clique aqui para baixar", "Download XML",
                                             "Arquivo disponível", "Arquivo disponivel"], timeout=500):
                    clicou_link_topo = True
            # alguns portais abrem o arquivo numa aba nova em vez de disparar download
            novas = [p for p in page.context.pages if p not in paginas_antes and not p.is_closed()]
            if novas and not downloads:
                aba = novas[0]
                try:
                    aba.wait_for_load_state("domcontentloaded", timeout=TIMEOUT_CURTO_MS)
                    corpo = page.context.request.get(aba.url).body()
                    aba.close()
                    if corpo:
                        return corpo, aba.url.rsplit("/", 1)[-1]
                except Exception:
                    paginas_antes.add(aba)

        if not downloads:
            raise ErroPortal(f"[download] arquivo não foi entregue em {TIMEOUT_DOWNLOAD_MS // 1000}s")
        falha = downloads[0].failure()
        if falha:
            raise ErroPortal(f"[download] navegador reportou falha no download: {falha}")
        return _salvar_download(downloads[0])
    finally:
        page.remove_listener("download", ouvinte)


def nova_consulta(page: Page) -> None:
    """Volta pro formulário depois do download (próxima consulta: mesma IE
    com Saída, ou a próxima empresa). Falha aqui não é erro da linha atual -
    abrir_formulario() tenta de novo pelo menu no começo da próxima."""
    _clicar_se_existir(page, ["Nova consulta", "Nova Consulta", "Nova pesquisa", "Voltar"], timeout=3_000)

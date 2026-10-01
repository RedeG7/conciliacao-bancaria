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

import itertools
import re
import tempfile
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

LOGIN_URL = "https://www.sefaz.go.gov.br/netaccess/000System/acessoRestrito/login/"
# formulário "Consulta de Notas Recebidas" - destino do "Baixar XML NFE"
# (OpenUrl2 do menu do Acesso Restrito, visto no log da execução real)
URL_CONSULTA = "https://nfeweb.sefaz.go.gov.br/nfeweb/sites/nfe/consulta-notas-recebidas"
# o login e o menu ficam em www.sefaz.go.gov.br, mas o formulário "Baixar
# XML NFE" abre em nfeweb.sefaz.go.gov.br (OpenUrl2 do menu, visto no log
# da execução real) - o certificado, se cadastrado, vale para os dois
# (o login em si redireciona para portal.sefaz.go.gov.br/portalsefaz-apps/
# auth/login-form - confirmado acessando o portal real)
CERTIFICADO_ORIGINS = [
    "https://www.sefaz.go.gov.br", "https://portal.sefaz.go.gov.br", "https://nfeweb.sefaz.go.gov.br",
]

TIMEOUT_PADRAO_MS = 20_000
TIMEOUT_CURTO_MS = 4_000
TIMEOUT_PESQUISA_MS = 90_000
# a SEFAZ monta o pacote de XMLs sob demanda - com centenas de notas pode
# demorar bem mais que um download comum
TIMEOUT_DOWNLOAD_MS = 300_000

TEXTOS_TIPO = {"ENTRADA": ["Entrada", "Entradas"], "SAIDA": ["Saída", "Saida", "Saídas", "Saidas"]}


_CONTADOR_MARCA = itertools.count(1)


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


# true quando o centro do elemento está na tela e NADA está por cima dele
# (o clique de verdade acertaria ele mesmo, não outro elemento)
_JS_NO_TOPO = """e => {
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
  const t = document.elementFromPoint(x, y);
  return !!t && (t === e || e.contains(t));
}"""


def _achar_visivel(page: Page, textos: list[str]):
    """Primeiro elemento visível com o texto, preferindo o que está de fato
    clicável. Confirmado na execução real: o menu do Acesso Restrito tem
    DOIS "Baixar XML NFE" - um no submenu lateral "Nota Fiscal Eletronica",
    coberto pelos títulos do menu (todo clique acertava o <h3> por cima), e
    o link de "Serviços em Destaque", que é o que uma pessoa clica."""
    for texto in textos:
        reserva = None
        for escopo in _escopos(page):
            for loc in _candidatos_clique(escopo, texto):
                try:
                    qtd = loc.count()
                except Exception:
                    continue
                for i in range(min(qtd, 8)):
                    item = loc.nth(i)
                    try:
                        if not item.is_visible():
                            continue
                        if item.evaluate(_JS_NO_TOPO):
                            return item
                        if reserva is None:
                            reserva = item
                    except Exception:
                        continue
        if reserva is not None:
            return reserva
    return None


def _clique(alvo) -> None:
    """Clique normal; se outro elemento estiver por cima (Playwright fica
    tentando até estourar o timeout), aciona o clique direto no elemento
    via JS - dispara o mesmo onclick (ex.: OpenUrl2 do menu da SEFAZ)."""
    try:
        alvo.scroll_into_view_if_needed(timeout=TIMEOUT_CURTO_MS)
    except Exception:
        pass
    try:
        alvo.click(timeout=5_000)
    except PlaywrightTimeoutError:
        alvo.evaluate("e => e.click()")


def _clicar(page: Page, textos: list[str], timeout: int = TIMEOUT_CURTO_MS) -> str | None:
    """Clica no primeiro texto da lista que aparecer (tenta até timeout).
    Retorna o texto clicado, ou None se nenhum apareceu."""
    esperado = 0
    while True:
        for texto in textos:
            alvo = _achar_visivel(page, [texto])
            if alvo is not None:
                _clique(alvo)
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
                        return _fixar(escopo, item)
                except Exception:
                    continue
    return None


def _fixar(escopo, item):
    """Troca o localizador "por placeholder/rótulo" por um preso ao próprio
    elemento (id ou name). Confirmado no portal real: o campo de CPF nasce
    com placeholder "CPF" e o plugin de máscara troca na hora para
    "___.___.___-__" - o localizador lazy por placeholder deixava de achar
    o campo entre o "achei" e o fill(), e travava 30s até o timeout."""
    try:
        attrs = item.evaluate("e => ({id: e.id || '', name: e.getAttribute('name') || ''})")
    except Exception:
        return item
    if attrs.get("id"):
        return escopo.locator(f"[id='{attrs['id']}']").first
    if attrs.get("name"):
        return escopo.locator(f"[name='{attrs['name']}']").first
    try:
        handle = item.element_handle(timeout=TIMEOUT_CURTO_MS)
        # sem id/name: marca o elemento com um atributo próprio
        marca = f"rpa-{next(_CONTADOR_MARCA)}"
        handle.evaluate("(e, m) => e.setAttribute('data-rpa', m)", marca)
        return escopo.locator(f"[data-rpa='{marca}']").first
    except Exception:
        return item


def _preencher(campo, valor: str) -> None:
    """fill() direto; se o campo tiver máscara que rejeita o texto colado
    (CPF, data, IE), apaga e digita só os dígitos, tecla por tecla."""
    digitos = re.sub(r"\D", "", valor)
    campo.click(timeout=TIMEOUT_PADRAO_MS)
    try:
        campo.fill(valor, timeout=TIMEOUT_CURTO_MS)
    except PlaywrightTimeoutError:
        pass
    atual = re.sub(r"\D", "", campo.input_value(timeout=TIMEOUT_CURTO_MS) or "")
    if atual != digitos:
        campo.click(timeout=TIMEOUT_CURTO_MS)
        campo.press("Control+a")
        campo.press("Delete")
        campo.press("Home")
        campo.press_sequentially(digitos, delay=60)
        atual = re.sub(r"\D", "", campo.input_value(timeout=TIMEOUT_CURTO_MS) or "")
        if atual != digitos:
            raise ErroPortal(f"[preencher] campo não aceitou o valor (ficou '{atual}', esperado '{digitos}')")
    campo.dispatch_event("change")
    campo.dispatch_event("blur")


def _clicar_se_existir(page: Page, textos: list[str], timeout: int = 2_000) -> bool:
    return _clicar(page, textos, timeout=timeout) is not None


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def _formulario_consulta_visivel(page: Page, timeout: int = TIMEOUT_CURTO_MS) -> bool:
    """Tela "Consulta de Notas Recebidas" (nfeweb.sefaz.go.gov.br - print da
    execução real): Período, Inscrição Estadual, Tipo de notas, Modelo da
    NF-e, Exibir notas canceladas e a verificação da Cloudflare."""
    return _existe(page, ["Inscrição Estadual", "Inscricao Estadual"], timeout=timeout) is not None and \
        _existe(page, ["Tipo de notas", "Consulta de Notas", "Pesquisar", "Consultar"], timeout=1_000) is not None


def _aguardar_verificacao_cloudflare(page: Page, timeout_ms: int = 30_000) -> None:
    """O formulário tem uma verificação da Cloudflare (Turnstile) que, num
    navegador comum, passa sozinha ("Sucesso!"). O robô só ESPERA ela passar
    sozinha - não clica nem tenta contornar a verificação. Se não passar no
    prazo, para com mensagem clara (a consulta dessa empresa fica com erro)."""
    tem_widget = False
    for escopo in _escopos(page):
        try:
            if escopo.locator("[name='cf-turnstile-response'], .cf-turnstile, iframe[src*='challenges.cloudflare.com']").count():
                tem_widget = True
                break
        except Exception:
            continue
    if not tem_widget and not any("challenges.cloudflare.com" in (f.url or "") for f in page.frames):
        return
    esperado = 0
    while esperado <= timeout_ms:
        for escopo in _escopos(page):
            try:
                campo = escopo.locator("[name='cf-turnstile-response']")
                if campo.count() and (campo.first.input_value() or "").strip():
                    return
            except Exception:
                continue
        page.wait_for_timeout(1_000)
        esperado += 1_000
    raise ErroPortal(
        "[consulta] a verificação da Cloudflare do formulário não foi concluída automaticamente "
        f"em {timeout_ms // 1000}s — o portal não liberou a consulta para o navegador do robô"
    )


# Injetado em toda página da sessão (context.add_init_script): o portal
# abre telas em janela nova (card "Acesso Restrito", link "Baixar XML NFE"
# - confirmado nos prints da execução real). O worker trabalha sempre com o
# mesmo objeto page, então tudo que abriria janela nova passa a abrir NA
# MESMA aba: links/forms com target _blank/_new e window.open(). Frames com
# nome (target="main" num frameset) continuam funcionando normalmente.
_SCRIPT_MESMA_ABA = """
(() => {
  const nova = (t) => !t || ['_blank', '_new'].includes(String(t).toLowerCase());
  const abrirOriginal = window.open;
  window.open = function (url, nome, ...resto) {
    try {
      if (nome && !nova(nome) && window.top.frames[nome]) return abrirOriginal.call(window, url, nome, ...resto);
    } catch (e) {}
    if (url) {
      try { window.top.location.href = new URL(url, location.href).href; }
      catch (e) { location.href = url; }
    }
    return window;
  };
  document.addEventListener('click', (e) => {
    const alvo = e.target && e.target.closest ? e.target.closest('a[target], area[target]') : null;
    if (alvo && nova(alvo.getAttribute('target'))) alvo.setAttribute('target', '_top');
  }, true);
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f && f.getAttribute && f.hasAttribute('target') && nova(f.getAttribute('target'))) f.setAttribute('target', '_top');
  }, true);
})();
"""


def preparar_sessao(page: Page) -> None:
    """Chamado uma vez antes do login: vale para todas as navegações
    seguintes do contexto (add_init_script roda em cada página nova)."""
    page.context.add_init_script(_SCRIPT_MESMA_ABA)


def _clicar_e_seguir(page: Page, textos: list[str], timeout: int) -> str | None:
    """Clica e segue o destino. Com _SCRIPT_MESMA_ABA quase tudo já abre na
    própria aba; se mesmo assim surgir uma aba nova, espera ela sair do
    about:blank (window.open costuma nascer em branco e só depois carregar
    o endereço), traz a página de trabalho para a mesma URL e fecha a aba."""
    antes = set(page.context.pages)
    clicado = _clicar(page, textos, timeout=timeout)
    if clicado is None:
        return None
    for _ in range(10):
        novas = [p for p in page.context.pages if p not in antes and not p.is_closed()]
        if novas:
            aba = novas[0]
            destino = ""
            for _ in range(40):  # até ~20s para o endereço de verdade aparecer
                destino = aba.url
                if destino and destino != "about:blank":
                    break
                aba.wait_for_timeout(500)
            try:
                aba.wait_for_load_state("domcontentloaded", timeout=TIMEOUT_PADRAO_MS)
            except PlaywrightTimeoutError:
                pass
            destino = aba.url
            aba.close()
            if destino and destino != "about:blank":
                page.goto(destino, wait_until="domcontentloaded", timeout=60_000)
            break
        page.wait_for_timeout(500)
    try:
        page.wait_for_load_state("networkidle", timeout=TIMEOUT_PADRAO_MS)
    except PlaywrightTimeoutError:
        pass
    return clicado


TEXTOS_MENU_XML = ["Baixar XML NF-e", "Baixar XML NFe", "Baixar XML NFE", "Download de XML", "Baixar XML"]


def _insistir(page: Page, textos: list[str], chegou, tentativas: int = 6, espera_ms: int = 8_000) -> bool:
    """Clica até a próxima página abrir (pedido do escritório: "colocar uma
    persistência ao chegar na tela e clicar até abrir a próxima página").
    A cada tentativa: se o link ainda está na tela, clica; espera até
    espera_ms pela próxima página (chegou()), entrando de novo com CPF/senha
    se o portal pedir login no caminho. Sistemas antigos da SEFAZ às vezes
    ignoram o primeiro clique (página ainda carregando scripts)."""
    for _ in range(tentativas):
        if chegou():
            return True
        if _existe(page, textos, timeout=0):
            _clicar_e_seguir(page, textos, timeout=TIMEOUT_CURTO_MS)
        for _ in range(espera_ms // 1_000):
            if chegou():
                return True
            if _relogar_se_pedir(page):
                # Passo 2 -> 3 do roteiro: depois da nova autenticação o
                # portal VOLTA ao menu; clica de novo já, sem esperar
                break
            page.wait_for_timeout(1_000)
    return chegou()


def _abrir_menu_baixar_xml(page: Page) -> None:
    """Painel pós-login ("Portal de Aplicações e Serviços") -> card "Acesso
    Restrito" (ASP) -> "Baixar XML NFE" -> "Consulta de Notas Recebidas",
    clicando de novo em cada passo até a página seguinte abrir."""
    def no_formulario() -> bool:
        return _formulario_consulta_visivel(page, timeout=0)

    def no_menu_asp() -> bool:
        return no_formulario() or _existe(page, TEXTOS_MENU_XML, timeout=0) is not None

    if not _insistir(page, ["Acesso Restrito"], no_menu_asp):
        raise ErroPortal(
            "[menu] cliquei várias vezes em 'Acesso Restrito' e o menu com 'Baixar XML NFE' não abriu "
            f"(página atual: {page.url})"
        )
    _clicar_se_existir(page, ["Depois", "Agora não", "Agora nao"], timeout=1_000)
    if not _insistir(page, TEXTOS_MENU_XML, no_formulario):
        raise ErroPortal(
            "[menu] cliquei várias vezes em 'Baixar XML NFE' e a tela 'Consulta de Notas Recebidas' não abriu "
            f"(página atual: {page.url})"
        )


# CPF/senha da sessão atual: o portal pede login DE NOVO ao entrar no site
# das notas (nfeweb.sefaz.go.gov.br, depois do "Baixar XML NFE") e quando a
# sessão expira no meio do lote - o robô preenche as mesmas credenciais
_CREDENCIAIS: dict = {}


def _tela_de_login(page: Page) -> bool:
    return _campo(page, ["Senha"], ["input[type=password]"]) is not None


def _autenticar(page: Page, cpf: str, senha: str) -> None:
    """Preenche CPF + senha na tela de login que estiver aberta e entra."""
    campo_cpf = _campo(
        page, ["CPF", "Usuário", "Usuario", "Login"],
        ["input[name*=cpf i]", "input[id*=cpf i]", "input[name*=usuario i]", "input[name*=login i]",
         "input[name*=username i]", "input[id*=username i]",
         # último recurso: o campo de texto logo antes do campo de senha
         # (o placeholder "CPF" some quando a máscara do portal carrega)
         "xpath=//input[@type='password']/preceding::input[not(@type) or @type='text' or @type='tel'][1]"],
    )
    campo_senha = _campo(page, ["Senha"], ["input[type=password]"])
    if campo_senha is None:
        raise ErroPortal(f"[login] campo de senha não encontrado na tela de login (página: {page.url})")
    if campo_cpf is not None:
        _preencher(campo_cpf, cpf)
    elif not _cpf_ja_preenchido(page):
        raise ErroPortal(f"[login] campo de CPF não encontrado na tela de login (página: {page.url})")
    # Passo 2 do roteiro do escritório: "Baixar XML NFE" abre a tela "Acesso
    # Restrito - Este módulo requer nova autenticação" com o CPF já
    # preenchido (pode vir travado) - aí só a senha é informada.
    campo_senha.fill(senha, timeout=TIMEOUT_PADRAO_MS)
    # "Autenticar": texto real do botão no Portal de Aplicações e Serviços
    # (tela de login confirmada pelo print da primeira execução)
    if _clicar(page, ["Autenticar", "Entrar", "Acessar", "Login", "Confirmar"], timeout=TIMEOUT_CURTO_MS) is None:
        campo_senha.press("Enter")

    erros = ["senha inválida", "senha invalida", "usuário ou senha", "usuario ou senha",
             "credenciais inválidas", "credenciais invalidas", "cpf ou senha",
             "cpf inválido", "cpf invalido", "acesso negado", "não autorizado", "nao autorizado",
             "bloquead"]
    achou = _existe(page, erros, timeout=3_000)
    if achou:
        raise ErroPortal(f"[login] portal recusou o acesso ('{achou}') — confira CPF/senha em Credenciais")
    try:
        page.wait_for_load_state("domcontentloaded", timeout=TIMEOUT_PADRAO_MS)
    except PlaywrightTimeoutError:
        pass

    # "Deseja salvar a senha?" -> Depois (pode ser do próprio portal; o do
    # navegador nem aparece no Chromium do Playwright)
    _clicar_se_existir(page, ["Depois", "Agora não", "Agora nao", "Lembrar depois"], timeout=2_000)


def _cpf_ja_preenchido(page: Page) -> bool:
    """CPF já vem preenchido (e possivelmente somente leitura) na tela de
    nova autenticação do Acesso Restrito - confirmado no roteiro (Passo 2)."""
    for escopo in _escopos(page):
        try:
            valores = escopo.locator(
                "xpath=//input[@type='password']/preceding::input[not(@type) or @type='text' or @type='tel'][1]"
            ).evaluate_all("els => els.map(e => e.value || '')")
        except Exception:
            continue
        if any(len(re.sub(r"\D", "", v)) == 11 for v in valores):
            return True
    return False


def _relogar_se_pedir(page: Page) -> bool:
    """Se a tela atual for de login, entra com as credenciais da sessão."""
    if not _CREDENCIAIS or not _tela_de_login(page):
        return False
    _autenticar(page, _CREDENCIAIS["cpf"], _CREDENCIAIS["senha"])
    return True


def login(page: Page, cpf: str, senha: str) -> None:
    _CREDENCIAIS.update(cpf=cpf, senha=senha)
    preparar_sessao(page)
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)

    # LOGIN_URL redireciona para portal.sefaz.go.gov.br/portalsefaz-apps/
    # auth/login-form (confirmado no portal real). Na execução real o robô
    # olhou a página ANTES do redirecionamento terminar, não viu a senha e
    # desistiu com "campos não encontrados" - mesmo o login acontecendo logo
    # depois. Agora espera (até 30s) a tela estabilizar em algo conhecido.
    for _ in range(30):
        if (_tela_de_login(page) or _formulario_consulta_visivel(page, timeout=0)
                or _existe(page, ["Acesso Restrito"] + TEXTOS_MENU_XML, timeout=0)):
            break
        page.wait_for_timeout(1_000)

    if _tela_de_login(page):
        _autenticar(page, cpf, senha)
    # daqui em diante o caminho é sempre o mesmo (card Acesso Restrito >
    # Baixar XML NFE > formulário), entrando de novo se o portal pedir login
    abrir_formulario(page)


def _esperar_formulario(page: Page, timeout_ms: int) -> bool:
    """Espera o formulário aparecer; se no caminho surgir tela de login
    (site das notas pedindo login de novo), entra e continua esperando."""
    esperado = 0
    relogins = 0
    while esperado <= timeout_ms:
        if _formulario_consulta_visivel(page, timeout=0):
            return True
        if relogins < 3 and _relogar_se_pedir(page):
            relogins += 1
            continue
        page.wait_for_timeout(1_000)
        esperado += 1_000
    return False


def abrir_formulario(page: Page) -> None:
    """Garante que a tela "Consulta de Notas Recebidas" está aberta: Nova
    consulta (se estiver no resultado anterior), senão Acesso Restrito >
    Baixar XML NFE. Entra de novo com CPF/senha sempre que o portal pedir.
    Última tentativa: vai direto para URL_CONSULTA (endereço que o próprio
    menu abre, visto no log da execução real)."""
    _relogar_se_pedir(page)
    if _formulario_consulta_visivel(page, timeout=1_000):
        return
    _clicar_se_existir(page, ["Nova consulta", "Nova Consulta", "Nova pesquisa"], timeout=1_500)
    if _esperar_formulario(page, 3_000):
        return
    _clicar_se_existir(page, ["Depois"], timeout=1_000)
    erro_menu = None
    try:
        _abrir_menu_baixar_xml(page)
    except ErroPortal as exc:
        # última tentativa abaixo (URL direta); se também falhar, o erro do
        # menu (que diz em qual passo parou) é o que vai para a tela
        erro_menu = exc
    if _esperar_formulario(page, 3_000):
        return
    page.goto(URL_CONSULTA, wait_until="domcontentloaded", timeout=60_000)
    if _esperar_formulario(page, TIMEOUT_PADRAO_MS):
        return
    if erro_menu is not None:
        raise erro_menu
    # confirmado no portal real: abrir URL_CONSULTA sem a sessão criada pelo
    # menu "Baixar XML NFE" mostra só "Você não tem permissão para acessar
    # esta página" (o OpenUrl2 do menu é quem libera o acesso)
    if _existe(page, ["não tem permissão", "nao tem permissao"], timeout=1_000):
        raise ErroPortal(
            "[consulta] o site das notas respondeu 'Você não tem permissão para acessar esta página' — "
            "o menu 'Baixar XML NFE' do Acesso Restrito não abriu o formulário (CPF sem acesso ao "
            f"serviço ou sessão perdida no caminho; página atual: {page.url})"
        )
    raise ErroPortal(
        "[consulta] tela 'Consulta de Notas Recebidas' (Período / Inscrição Estadual) não abriu — "
        f"sessão pode ter expirado ou o menu mudou de nome (página atual: {page.url})"
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
                        try:
                            loc.first.check(timeout=5_000)
                        except PlaywrightTimeoutError:
                            loc.first.evaluate("e => { if (!e.checked) e.click(); }")
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

    _marcar_opcao(page, ["Tipo de notas", "Tipo de nota", "Tipo da nota", "Tipo de Operação", "Tipo"], TEXTOS_TIPO[tipo])
    _marcar_opcao(page, ["Modelo da NF-e", "Modelo"], ["Todos", "Todas"])

    _aguardar_verificacao_cloudflare(page)

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
                        _clique(loc.first)
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

"""Wrapper Playwright para o portal ISS Net Online (Goiânia e Aparecida de
Goiânia — GO). Mesmo domínio, caminhos/sessões separados por cidade:
PORTAL_URLS abaixo.

Confirmado ao vivo (sessão de exploração manual via Claude in Chrome, não
Playwright — os seletores aqui são a tradução dessa exploração para
Playwright, ainda SEM um run de Playwright de verdade contra o portal):
  - Login é por certificado digital A1 (.pfx), não usuário/senha: o desafio
    de certificado acontece no handshake TLS contra CERTIFICADO_ORIGIN, por
    isso o contexto do browser já precisa nascer com client_certificates
    (ver rpa.registry.criar_contexto) — não dá pra configurar isso depois
    de abrir a página, diferente do issweb que só dá fill() nos campos.
  - Depois de entrar numa empresa (Empresas.aspx > clicar em "Selecione"),
    todo o conteúdo do menu/telas passa a morar dentro de um
    <iframe id="iframe"> (confirmado via JS: document.querySelectorAll
    ('iframe') = ['iframe', 'rocketchat-iframe']) — por isso os locators
    abaixo usam page.frame_locator("#iframe") a partir daí. A tela
    "Empresas" (antes de entrar numa empresa) NÃO tem esse iframe.
  - "Livro Fiscal > Emitir Livro Fiscal": Tipo De Serviços "Serviços
    Prestados" = DMS, "Serviços Contratados" = REST; preenche Data
    Inicial/Final (mês anterior completo) e clica "Gerar" — isso já É o
    fechamento final (PDF via Relatorios/ReportManager.aspx), sem passo de
    abrir/fechar movimento como no issweb. Confirmado ao vivo só para
    Serviços Prestados (DMS); Serviços Contratados (REST) segue o mesmo
    padrão de tela mas NUNCA foi clicado de verdade — validar antes de
    confiar cegamente no resultado.
  - "Nota Eletrônica > Consultar Nota Eletrônica": filtra por Data
    Competência Inicial/Final (dentro de "Filtros Adicionais") e clica no
    ícone "Exportar todas as notas em XML" (canto superior direito da
    grade de resultados) — baixa um .zip com um .xml por nota. Confirmado
    ao vivo com download real.

Nada disso teve um run de Playwright real ainda (só exploração manual via
extensão de browser) — trate os seletores de texto como o melhor palpite
informado, não como garantia, e valide a primeira execução de verdade com
atenção redobrada.
"""

from pathlib import Path
import tempfile

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

from rpa.issnet.urls import PORTAL_URLS

TIMEOUT_PADRAO_MS = 15_000
TIMEOUT_CURTO_MS = 4_000

CERTIFICADO_ORIGIN = "https://www.issnetonline.com.br"


class ErroPortal(Exception):
    """Falha numa etapa da automacao do portal — nunca aborta o lote inteiro."""


def login(page: Page, municipio: str) -> None:
    """Login por certificado digital: o navegador já apresenta o cert do
    contexto (client_certificates) no handshake TLS, então aqui só precisa
    ir até a home e clicar no link — sem preencher CPF/senha nem lidar com
    o teclado numérico embaralhado (esse é o fluxo alternativo do portal,
    não usado aqui)."""
    portal_url = PORTAL_URLS.get(municipio)
    if not portal_url:
        raise ErroPortal(f"[login] município desconhecido para issnet: '{municipio}'")

    page.goto(portal_url, wait_until="domcontentloaded")

    link_certificado = page.get_by_text("Logar com certificado digital", exact=False)
    try:
        link_certificado.wait_for(state="visible", timeout=TIMEOUT_PADRAO_MS)
        link_certificado.click()
    except PlaywrightTimeoutError as exc:
        raise ErroPortal("[login] link 'Logar com certificado digital' não encontrado") from exc

    # Pós-login cai na tela "Empresas" (lista de clientes do procurador) —
    # confirmado ao vivo pelo campo "Selecione a Empresa".
    try:
        page.get_by_text("Selecione a Empresa", exact=False).wait_for(
            state="visible", timeout=TIMEOUT_PADRAO_MS
        )
    except PlaywrightTimeoutError as exc:
        raise ErroPortal(
            "[login] não caiu na tela 'Empresas' após o certificado — "
            "sessão pode não ter autenticado (certificado errado/expirado?)"
        ) from exc


def selecionar_empresa(page: Page, cnpj_cpf: str) -> None:
    """Na tela Empresas: busca por CNPJ/CPF e clica no ✓ (Selecione) da
    primeira linha encontrada. cnpj_cpf pode estar com ou sem máscara — o
    campo de busca aceita ambos (confirmado ao vivo com CNPJ mascarado)."""
    campo_busca = page.get_by_label("CPF / CNPJ", exact=False)
    if campo_busca.count() == 0:
        # fallback: campo identificado só pelo texto do rótulo acima dele
        # (JSF/ASP antigo às vezes não associa <label for=...> de verdade)
        campo_busca = page.locator("input[type=text]").nth(1)
    campo_busca.fill(cnpj_cpf)

    botao_buscar = page.locator("button, input[type=submit]").filter(has=page.locator("svg, i.fa-search"))
    if botao_buscar.count():
        botao_buscar.first.click()
    else:
        page.keyboard.press("Enter")

    linha_selecione = page.locator("table").get_by_role("button", name="Selecione", exact=False)
    if linha_selecione.count() == 0:
        # botão "Selecione" costuma ser um ícone (✓) sem texto acessível —
        # cai pro primeiro botão de check verde da tabela de resultados
        linha_selecione = page.locator("table tr td:last-child button, table tr td:last-child a").first

    try:
        linha_selecione.first.wait_for(state="visible", timeout=TIMEOUT_PADRAO_MS)
        linha_selecione.first.click()
    except PlaywrightTimeoutError as exc:
        raise ErroPortal(f"[selecionar_empresa] empresa {cnpj_cpf} não encontrada na lista") from exc

    # Confirma que entrou (menu lateral com "Livro Fiscal" só existe dentro
    # de uma empresa selecionada, dentro do iframe da aplicação).
    try:
        _frame(page).get_by_text("Livro Fiscal", exact=False).wait_for(
            state="visible", timeout=TIMEOUT_PADRAO_MS
        )
    except PlaywrightTimeoutError as exc:
        raise ErroPortal(f"[selecionar_empresa] não confirmou entrada na empresa {cnpj_cpf}") from exc


def _frame(page: Page):
    """Todo o conteúdo pós-seleção de empresa mora em <iframe id="iframe">
    (confirmado ao vivo) — centraliza aqui pra não repetir em cada função."""
    return page.frame_locator("#iframe")


def _abrir_menu(page: Page, item_pai: str, item_filho: str) -> None:
    frame = _frame(page)
    link_pai = frame.get_by_text(item_pai, exact=False).first
    link_pai.click()
    link_filho = frame.get_by_text(item_filho, exact=False).first
    try:
        link_filho.wait_for(state="visible", timeout=TIMEOUT_CURTO_MS)
    except PlaywrightTimeoutError:
        # submenu pode já estar expandido de uma navegação anterior
        pass
    link_filho.click()


def _capturar_download_ou_popup(page: Page, acionar) -> bytes:
    """Mesmo padrão de rpa/issweb/portal.py gerar_pdf(): o portal serve o
    arquivo por download direto OU abrindo uma aba nova (sem evento
    'download'), então escuta os dois e segue o que disparar primeiro."""
    downloads: list = []
    popups: list = []
    page.on("download", lambda d: downloads.append(d))
    page.context.on("page", lambda p: popups.append(p))

    acionar()

    esperado_ms = 0
    intervalo_ms = 500
    while not downloads and not popups and esperado_ms < TIMEOUT_PADRAO_MS:
        page.wait_for_timeout(intervalo_ms)
        esperado_ms += intervalo_ms

    if downloads:
        with tempfile.TemporaryDirectory() as tmp:
            caminho = Path(tmp) / "arquivo.bin"
            downloads[0].save_as(caminho)
            return caminho.read_bytes()

    if popups:
        popup = popups[0]
        popup.wait_for_load_state("domcontentloaded", timeout=TIMEOUT_PADRAO_MS)
        resposta = page.context.request.get(popup.url)
        conteudo = resposta.body()
        popup.close()
        return conteudo

    raise ErroPortal("[download] arquivo não foi gerado (nem download nem aba nova detectados)")


def gerar_livro_fiscal(page: Page, tipo_servico: str, data_inicial: str, data_final: str) -> bytes:
    """tipo_servico: 'prestados' (DMS) ou 'contratados' (REST). Retorna os
    bytes do PDF final — aqui JÁ é o fechamento, sem abrir/fechar movimento
    (diferente do issweb). REST (contratados) nunca foi testado ao vivo."""
    frame = _frame(page)
    _abrir_menu(page, "Livro Fiscal", "Emitir Livro Fiscal")

    rotulo_radio = "Serviços Prestados" if tipo_servico == "prestados" else "Serviços Contratados"
    radio = frame.get_by_text(rotulo_radio, exact=False)
    try:
        radio.wait_for(state="visible", timeout=TIMEOUT_PADRAO_MS)
        radio.click()
    except PlaywrightTimeoutError as exc:
        raise ErroPortal(f"[livro_fiscal] opção '{rotulo_radio}' não encontrada") from exc

    campos_data = frame.locator("input[type=text]").filter(has_not=frame.locator("[readonly]"))
    campo_inicio = frame.get_by_label("Data Inicial", exact=False)
    campo_fim = frame.get_by_label("Data Final", exact=False)
    if campo_inicio.count() == 0 or campo_fim.count() == 0:
        raise ErroPortal("[livro_fiscal] campos Data Inicial/Final não encontrados")
    campo_inicio.fill(data_inicial)
    campo_fim.fill(data_final)

    botao_gerar = frame.get_by_role("button", name="Gerar", exact=False)
    if botao_gerar.count() == 0:
        raise ErroPortal("[livro_fiscal] botão 'Gerar' não encontrado")

    return _capturar_download_ou_popup(page, lambda: botao_gerar.first.click())


def exportar_xml_competencia(page: Page, data_inicial: str, data_final: str) -> bytes:
    """Menu Nota Eletrônica > Consultar Nota Eletrônica, filtra pela
    competência do mês anterior e baixa o zip de XMLs. Confirmado ao vivo:
    o campo 'Data Competência Inicial' NÃO aceitou digitação direta na
    exploração manual (só o datepicker) — aqui usamos fill(), que dispara
    os eventos corretos via DOM e deve funcionar mesmo onde o clique manual
    simulado falhou; ainda assim, validar no primeiro run real.

    LIMITAÇÃO CONHECIDA: a especificação pede XMLs de notas emitidas E
    recebidas separados (pastas XML_Emitidas/XML_Recebidas). Esta função
    baixa só UM zip (a exploração manual não confirmou se essa grade já
    mistura os dois sentidos ou é só um lado) — separar direito exige achar
    o filtro real de emitida/recebida na tela e validar ao vivo contra o
    portal, não dá pra adivinhar o seletor daqui. Por ora entrega tudo num
    zip só (xml_zip_nome sem sufixo Emitidas/Recebidas)."""
    frame = _frame(page)
    _abrir_menu(page, "Nota Eletrônica", "Consultar Nota Eletrônica")

    filtros_adicionais = frame.get_by_text("Filtros Adicionais", exact=False)
    if filtros_adicionais.count():
        filtros_adicionais.first.click()

    campo_inicio = frame.get_by_label("Data Competência Inicial", exact=False)
    campo_fim = frame.get_by_label("Data Competência Final", exact=False)
    if campo_inicio.count() == 0 or campo_fim.count() == 0:
        raise ErroPortal("[exportar_xml] campos Data Competência Inicial/Final não encontrados")
    campo_inicio.fill(data_inicial)
    campo_fim.fill(data_final)

    botao_localizar = frame.get_by_role("button", name="Localizar", exact=False)
    if botao_localizar.count() == 0:
        raise ErroPortal("[exportar_xml] botão 'Localizar' não encontrado")
    botao_localizar.first.click()

    try:
        frame.get_by_text("Documentos Fiscais", exact=False).wait_for(
            state="visible", timeout=TIMEOUT_PADRAO_MS
        )
    except PlaywrightTimeoutError as exc:
        raise ErroPortal("[exportar_xml] grade 'Documentos Fiscais' não carregou após a busca") from exc

    botao_exportar = frame.get_by_title("Exportar todas as notas em XML", exact=False)
    if botao_exportar.count() == 0:
        # título/tooltip confirmado ao vivo via hover; se o atributo real
        # não for 'title' (pode ser um componente de tooltip JS), cai pro
        # ícone no canto superior direito do cabeçalho da grade
        botao_exportar = frame.locator("table thead button, table thead a").last

    return _capturar_download_ou_popup(page, lambda: botao_exportar.first.click())

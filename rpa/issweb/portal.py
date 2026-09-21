"""Wrapper Playwright para o portal ISS Web (Prefeitura de Senador Canedo/GO).

Portado de rpa-issweb/issweb/portal.py (script local, já testado contra o
login real do portal) com uma diferença: aqui o worker roda headless num
container sem tela, então não há como pausar e esperar o usuário resolver
uma tela de 2FA como no script local (ver README de rpa-issweb) — se
aparecer, falha a empresa com ErroPortal e uma mensagem clara para rodar
essa empresa depois pelo script local (navegador visível).

O portal e feito em JSF/PrimeFaces: os ids de campo mudam por sessao, entao
toda a navegacao aqui usa localizadores por texto/rotulo visivel
(get_by_text / get_by_role / get_by_label) em vez de ids fixos. Mesmo assim,
o texto exato de botoes/menus pode divergir um pouco do documentado aqui —
ajustes finos de seletor sao esperados conforme o uso real revelar.

Cada funcao levanta ErroPortal com uma mensagem descritiva de qual etapa
falhou, para a linha em rpa_empresas ser marcada com Status=ERRO e o motivo.
"""

import tempfile
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

TIMEOUT_PADRAO_MS = 15_000
TIMEOUT_CURTO_MS = 4_000


class ErroPortal(Exception):
    """Falha numa etapa da automacao do portal — nunca aborta o lote inteiro."""


def _localizador_por_texto(page: Page, texto: str):
    """Combina varias estrategias, porque no JSF/PrimeFaces desse portal um
    'botao' costuma ser <input type=button value="Entrar"> — get_by_text NAO
    encontra isso (o rotulo esta no atributo value, sem no de texto), so
    get_by_role com o nome acessivel calculado a partir do value. Ja menus
    (<a>) tem texto de verdade. Tentamos role primeiro, depois texto puro."""
    candidatos = [
        page.get_by_role("button", name=texto, exact=False),
        page.get_by_role("link", name=texto, exact=False),
        page.get_by_text(texto, exact=False),
    ]
    for loc in candidatos:
        if loc.count() > 0:
            return loc.first
    return candidatos[-1].first


def _clicar_primeiro_texto(page: Page, textos: list[str], timeout: int = TIMEOUT_CURTO_MS):
    """Tenta clicar no primeiro texto da lista que existir na tela; None se nenhum existir."""
    for texto in textos:
        loc = _localizador_por_texto(page, texto)
        try:
            loc.wait_for(state="visible", timeout=timeout)
            loc.click()
            return texto
        except PlaywrightTimeoutError:
            continue
    return None


def _existe_texto(page: Page, texto: str, timeout: int = TIMEOUT_CURTO_MS) -> bool:
    try:
        _localizador_por_texto(page, texto).wait_for(state="visible", timeout=timeout)
        return True
    except PlaywrightTimeoutError:
        return False


def verificar_2fa(page: Page) -> None:
    """Servidor headless: sem usuário para resolver 2FA ao vivo — falha a
    empresa em vez de travar o worker esperando input que nunca vem."""
    gatilhos = ["Código de Verificação", "Codigo de Verificacao", "Verificação em duas etapas", "Token de acesso"]
    for gatilho in gatilhos:
        if _existe_texto(page, gatilho, timeout=1_500):
            raise ErroPortal(
                f"[login] portal pediu verificação adicional ('{gatilho}') — não é possível "
                "resolver isso num worker sem tela. Rode esta empresa pelo script local "
                "(rpa-issweb, navegador visível) para resolver manualmente."
            )


def login(page: Page, cnpj: str, senha: str, portal_url: str) -> None:
    page.goto(portal_url, wait_until="domcontentloaded")

    # Texto real do link na home (confirmado ao vivo): "Acesso ao Sistema".
    if _clicar_primeiro_texto(page, ["Acesso ao Sistema", "Acessar o Sistema", "Entrar"]) is None:
        raise ErroPortal("[login] link 'Acesso ao Sistema' não encontrado na home do portal")

    # Na página de login (paginas/login), o botão "Entrar" só assume seu
    # rótulo/estado final depois do JS de inicialização rodar — sem esperar
    # aqui, ele ainda mostra "Aguarde..." e o clique pode cair num estado
    # incorreto do formulário.
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_PADRAO_MS)

    # Campos de login (ids confirmados estáveis nesta página: #username/#password).
    campo_usuario = page.locator("#username")
    if campo_usuario.count() == 0:
        campo_usuario = page.locator("input[type=text]").first
    campo_usuario.fill(cnpj)

    campo_senha = page.locator("#password")
    if campo_senha.count() == 0:
        campo_senha = page.locator("input[type=password]").first
    campo_senha.fill(senha)

    if _clicar_primeiro_texto(page, ["Entrar", "Acessar", "Login"]) is None:
        raise ErroPortal("[login] botão 'Entrar' não encontrado no formulário de login")

    verificar_2fa(page)

    # Mensagem real confirmada ao vivo no portal: "Usuário e/ou Senha inválidos".
    erro_login = ["Usuário e/ou Senha inválidos", "Senha inválid", "acesso negado", "credenciais inválidas"]
    for msg in erro_login:
        if _existe_texto(page, msg, timeout=2_000):
            raise ErroPortal(f"[login] portal retornou erro de credenciais: '{msg}'")

    # Confirmado ao vivo: a tela pós-login não tem link "Sair" visível na
    # landing page — o sinal confiável é o menu lateral "Menu Principal" da
    # tela "Pesquisar Contribuinte" (ou "SELECIONE UM CONTRIBUINTE" no topo).
    sessao_ativa = _existe_texto(page, "Menu Principal", timeout=TIMEOUT_PADRAO_MS)
    if not sessao_ativa:
        raise ErroPortal("[login] não foi possível confirmar sessão ativa ('Menu Principal' não apareceu)")


def trocar_contribuinte(page: Page, cnpj_cpf: str) -> bool:
    """Pesquisa a empresa por CNPJ/CPF; tenta 'Mobiliário' e depois 'Contribuinte'.

    O item "Trocar Contribuinte" só aparece no menu depois de expandir o
    submenu pai "Contribuinte" na barra lateral — na tela de pouso logo após
    o login ele já vem visível/expandido, mas depois de navegar para outra
    seção (ex.: Declaração Tomador de uma empresa anterior) o submenu fecha
    de novo e precisa ser reaberto antes de clicar em "Trocar Contribuinte".
    """
    if not _existe_texto(page, "Trocar Contribuinte", timeout=1_500) and not _existe_texto(page, "Pesquisar Contribuinte", timeout=500):
        _clicar_primeiro_texto(page, ["Contribuinte"], timeout=TIMEOUT_CURTO_MS)

    if _clicar_primeiro_texto(page, ["Trocar Contribuinte", "Pesquisar Contribuinte"]) is None:
        raise ErroPortal("[trocar_contribuinte] menu 'Trocar/Pesquisar Contribuinte' não encontrado")

    for tipo_busca in ["Mobiliário", "Contribuinte"]:
        _clicar_primeiro_texto(page, [tipo_busca], timeout=TIMEOUT_CURTO_MS)

        # get_by_label("CNPJ") colide com o cabeçalho da tabela de resultados
        # (<th aria-label="CNPJ/CPF">) — o campo de busca real é identificado
        # pelo placeholder "CNPJ ou CPF" (confirmado ao vivo).
        campo_busca = page.get_by_placeholder("CNPJ ou CPF", exact=False).first
        if campo_busca.count() == 0:
            campo_busca = page.locator("input[type=text]").first
        campo_busca.fill(cnpj_cpf)

        if _clicar_primeiro_texto(page, ["Pesquisar"], timeout=TIMEOUT_CURTO_MS) is None:
            continue

        linha_resultado = page.get_by_text(cnpj_cpf, exact=False).first
        try:
            linha_resultado.wait_for(state="visible", timeout=TIMEOUT_CURTO_MS)
            linha_resultado.dblclick()
            return True
        except PlaywrightTimeoutError:
            continue

    return False


def consultar_notas_tomadas(page: Page, data_inicial: str, data_final: str) -> bool:
    """Retorna True se houver notas (com movimento) ou False se a grade vier vazia."""
    if _clicar_primeiro_texto(page, ["Notas Fiscais Tomadas"]) is None:
        if _clicar_primeiro_texto(page, ["Eu Tomador"], timeout=TIMEOUT_CURTO_MS) is None:
            raise ErroPortal("[consultar_notas] menu 'Notas Fiscais Tomadas' não encontrado (direto nem em 'Eu Tomador')")
        if _clicar_primeiro_texto(page, ["Notas Fiscais Tomadas"], timeout=TIMEOUT_CURTO_MS) is None:
            raise ErroPortal("[consultar_notas] menu 'Notas Fiscais Tomadas' não encontrado dentro de 'Eu Tomador'")

    campos_data = page.locator("input[type=text]")
    try:
        campos_data.nth(0).fill(data_inicial)
        campos_data.nth(1).fill(data_final)
    except PlaywrightTimeoutError as exc:
        raise ErroPortal("[consultar_notas] campos de período não encontrados") from exc

    if _clicar_primeiro_texto(page, ["Pesquisar"]) is None:
        raise ErroPortal("[consultar_notas] botão 'Pesquisar' não encontrado")

    sem_registro = ["nenhum registro encontrado", "nenhuma nota", "sem resultados", "nenhum resultado"]
    for msg in sem_registro:
        if _existe_texto(page, msg, timeout=3_000):
            return False
    return True


def abrir_ou_localizar_movimento(page: Page, tipo: str, competencia: dict) -> str:
    """tipo: '01' (Normal, com movimento) ou '03' (Sem Movimento).

    Retorna 'aberto' se criou um movimento novo, ou 'existente' se já havia
    um movimento na competência (e o fluxo deve seguir a partir da
    verificação, sem recriar).
    """
    if _clicar_primeiro_texto(page, ["Declaração", "Declaracao"]) is None:
        raise ErroPortal("[movimento] menu 'Declaração' não encontrado")
    if _clicar_primeiro_texto(page, ["Declaração Tomador", "Declaracao Tomador"]) is None:
        raise ErroPortal("[movimento] submenu 'Declaração Tomador' não encontrado")
    if _clicar_primeiro_texto(page, ["Novo Movimento"]) is None:
        raise ErroPortal("[movimento] botão 'Novo Movimento' não encontrado")

    # "Tipo Escritura" e "Mês" são <select> (PrimeFaces selectOneMenu) —
    # confirmado ao vivo que _clicar_primeiro_texto não funciona neles (o
    # rótulo só existe dentro de <option>, sem role de botão/link clicável
    # até o dropdown ser aberto). Usamos select_option() direto no <select>
    # real, identificado pela opção que ele contém, sem depender do id
    # (formDeclaracao:somTipoEscritura_input) que pode mudar por sessão.
    rotulo_tipo = "01 - Normal" if tipo == "01" else "03 - Sem Movimento"
    select_tipo = page.locator("select").filter(has=page.locator(f"option[value='{rotulo_tipo}']"))
    if select_tipo.count() == 0:
        raise ErroPortal(f"[movimento] campo 'Tipo Escritura' com opção '{rotulo_tipo}' não encontrado")
    select_tipo.first.select_option(label=rotulo_tipo)

    # get_by_label("Ano") não resolve (o campo não tem <label for=...>
    # associado semanticamente, confirmado ao vivo) — o input vem pré-
    # preenchido com o ano corrente, o que só está errado na virada de ano
    # (execução em janeiro para competência de dezembro anterior), então
    # setamos explicitamente. id conhecido: formDeclaracao:itAno.
    campo_ano = page.locator("input[id$=':itAno']").first
    if campo_ano.count():
        campo_ano.fill(str(competencia["ano"]))

    nomes_mes = [
        "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
        "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ]
    nome_mes_alvo = nomes_mes[competencia["mes"] - 1]
    select_mes = page.locator("select").filter(has=page.locator(f"option:text-is('{nome_mes_alvo}')"))
    if select_mes.count():
        select_mes.first.select_option(label=nome_mes_alvo)

    if _clicar_primeiro_texto(page, ["Salvar"]) is None:
        raise ErroPortal("[movimento] botão 'Salvar' não encontrado")

    # O portal pede confirmação extra ("Deseja realmente salvar este
    # registro?") antes de gravar de verdade — sem confirmar aqui, o código
    # antigo declarava sucesso sem o movimento ter sido salvo de fato.
    if _existe_texto(page, "Deseja realmente salvar este registro", timeout=3_000):
        if _clicar_primeiro_texto(page, ["Sim"], timeout=TIMEOUT_CURTO_MS) is None:
            raise ErroPortal("[movimento] diálogo de confirmação apareceu mas botão 'Sim' não encontrado")

    aviso_existente = "Já existe um movimento de serviço tomado nessa referência"
    if _existe_texto(page, "movimento não pode ser aberto", timeout=3_000) or _existe_texto(page, aviso_existente, timeout=1_000):
        return _localizar_movimento_existente(page, competencia)

    return "aberto"


def _localizar_movimento_existente(page: Page, competencia: dict) -> str:
    """LIMITAÇÃO CONHECIDA (confirmado ao vivo, não resolvido): quando o
    portal recusa salvar por já existir um movimento na competência, a grade
    de resultados da busca (Tipo Escritura/Ano/Mês/Fatura/Dedução/ISS/
    Fechada?) aparece no texto da página (inner_text), mas não foi possível
    localizar a linha via seletor (nem <table>/<tr>, nem role="row", nem
    texto exato do mês — todos retornam 0 ou colidem com opções escondidas
    do próprio <select> de filtro). Isso é tratado com segurança: levanta
    ErroPortal, a linha da planilha/execução fica marcada ERRO (não trava o
    lote) e fica disponível para reprocessar manualmente pelo script local
    com navegador visível. Ajustar aqui exige inspecionar a grade ao vivo
    (ela pode ser um componente PrimeFaces DataTable renderizado sem <table>
    semântico) — não tentar de novo sem visibilidade real da tela.
    """
    _clicar_primeiro_texto(page, ["Voltar", "Pesquisar"], timeout=TIMEOUT_CURTO_MS)
    for tipo_texto in ["01 - Normal", "02 - Complementar", "03 - Sem Movimento"]:
        if _clicar_primeiro_texto(page, [tipo_texto], timeout=TIMEOUT_CURTO_MS):
            if _existe_texto(page, competencia["mm_aaaa"], timeout=TIMEOUT_CURTO_MS):
                return "existente"
    raise ErroPortal(
        "[movimento] portal indicou movimento já existente na competência, "
        "mas não foi possível localizá-lo entre os tipos 01/02/03 "
        "(limitação conhecida — rode esta empresa pelo script local com navegador visível)"
    )


def importar_e_aceitar_notas(page: Page) -> None:
    if _clicar_primeiro_texto(page, ["Declarar", "Importar Notas"]) is None:
        raise ErroPortal("[importar_notas] botão 'Declarar'/'Importar Notas' não encontrado")

    selecionar_tudo = page.get_by_role("checkbox", name="Selecionar Tudo")
    while True:
        if selecionar_tudo.count():
            selecionar_tudo.first.check()
        else:
            checkboxes = page.get_by_role("checkbox")
            for i in range(checkboxes.count()):
                checkboxes.nth(i).check()

        proximo = page.get_by_text("Próximo", exact=False).first
        if proximo.count() == 0 or not proximo.is_enabled():
            break
        proximo.click()

    if _clicar_primeiro_texto(page, ["Aceita", "Aceitar"]) is None:
        raise ErroPortal("[importar_notas] botão 'Aceita' não encontrado")
    _clicar_primeiro_texto(page, ["Sim"], timeout=TIMEOUT_CURTO_MS)
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_PADRAO_MS)


def fechar_movimento(page: Page, com_movimento: bool) -> None:
    _clicar_primeiro_texto(page, ["Pesquisar"] if not com_movimento else ["Voltar"], timeout=TIMEOUT_CURTO_MS)

    if _clicar_primeiro_texto(page, ["Fechar Movimento"]) is None:
        raise ErroPortal("[fechar_movimento] botão 'Fechar Movimento' não encontrado")
    _clicar_primeiro_texto(page, ["Sim"], timeout=TIMEOUT_CURTO_MS)
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_PADRAO_MS)


def gerar_pdf(page: Page) -> bytes:
    """Clica em 'Gerar PDF' e retorna os bytes do arquivo (sem depender de
    disco persistente — o worker guarda o PDF direto no Postgres).

    O portal pode servir o PDF de duas formas: (a) como download direto, ou
    (b) abrindo uma aba nova com o visualizador de PDF do Chrome (sem
    disparar o evento 'download'). Escutamos os dois eventos ao mesmo tempo
    a partir do clique e seguimos o que disparar primeiro; no caso (b),
    baixamos os bytes da própria URL do PDF via requisição HTTP autenticada
    da sessão.
    """
    downloads: list = []
    popups: list = []
    page.on("download", lambda d: downloads.append(d))
    page.context.on("page", lambda p: popups.append(p))

    if _clicar_primeiro_texto(page, ["Gerar PDF"]) is None:
        raise ErroPortal("[gerar_pdf] botão 'Gerar PDF' não encontrado")

    esperado_ms = 0
    intervalo_ms = 500
    while not downloads and not popups and esperado_ms < TIMEOUT_PADRAO_MS:
        page.wait_for_timeout(intervalo_ms)
        esperado_ms += intervalo_ms

    if downloads:
        with tempfile.TemporaryDirectory() as tmp:
            caminho = Path(tmp) / "declaracao.pdf"
            downloads[0].save_as(caminho)
            return caminho.read_bytes()

    if popups:
        popup = popups[0]
        popup.wait_for_load_state("domcontentloaded", timeout=TIMEOUT_PADRAO_MS)
        resposta = page.context.request.get(popup.url)
        conteudo = resposta.body()
        popup.close()
        return conteudo

    raise ErroPortal("[gerar_pdf] PDF não foi gerado (nem download nem aba nova detectados)")


def gerar_pdf_movimento_economico(page: Page, data_inicial: str, data_final: str) -> bytes:
    """Fluxo do DMS — confirmado ao vivo, é bem diferente do REST (Declaração
    Tomador): não existe abrir/fechar movimento aqui. É um relatório direto
    (Relatórios > Movimento Econômico) que reflete o faturamento das NFS-e
    emitidas no período, ou mostra "SEM MOVIMENTAÇÃO" se não houve nenhuma —
    já serve como o PDF final da obrigação DMS.

    "Relatórios" é item de topo do menu lateral (mesmo padrão de
    "Declaração"), não precisa do truque de expandir "Contribuinte" primeiro.
    """
    if _clicar_primeiro_texto(page, ["Relatórios"]) is None:
        raise ErroPortal("[dms] menu 'Relatórios' não encontrado")
    if _clicar_primeiro_texto(page, ["Movimento Econômico"]) is None:
        raise ErroPortal("[dms] submenu 'Movimento Econômico' não encontrado")

    if _clicar_primeiro_texto(page, ["Competência"]) is None:
        raise ErroPortal("[dms] opção 'Período por: Competência' não encontrada")

    campo_inicio = page.locator("input[id$=':dtInicio_input']").first
    campo_fim = page.locator("input[id$=':dtFim_input']").first
    if campo_inicio.count() == 0 or campo_fim.count() == 0:
        raise ErroPortal("[dms] campos de data início/fim não encontrados")
    campo_inicio.fill(data_inicial)
    campo_fim.fill(data_final)

    downloads: list = []
    popups: list = []
    page.on("download", lambda d: downloads.append(d))
    page.context.on("page", lambda p: popups.append(p))

    if _clicar_primeiro_texto(page, ["Gerar PDF"]) is None:
        raise ErroPortal("[dms] botão 'Gerar PDF' não encontrado")

    # Abre um modal "Selecionar Contribuintes" — clicar em "Gerar PDF" DENTRO
    # do modal sem marcar nenhum contribuinte gera direto para o contribuinte
    # já selecionado na sessão (confirmado ao vivo).
    modal_gerar = page.locator(".ui-dialog:visible").get_by_role("button", name="Gerar PDF", exact=False)
    try:
        modal_gerar.first.wait_for(state="visible", timeout=TIMEOUT_CURTO_MS)
        modal_gerar.first.click()
    except PlaywrightTimeoutError:
        pass  # em alguma variação o modal pode não aparecer — segue pro download direto

    esperado_ms = 0
    intervalo_ms = 500
    while not downloads and not popups and esperado_ms < TIMEOUT_PADRAO_MS:
        page.wait_for_timeout(intervalo_ms)
        esperado_ms += intervalo_ms

    if downloads:
        with tempfile.TemporaryDirectory() as tmp:
            caminho = Path(tmp) / "dms.pdf"
            downloads[0].save_as(caminho)
            return caminho.read_bytes()

    if popups:
        popup = popups[0]
        popup.wait_for_load_state("domcontentloaded", timeout=TIMEOUT_PADRAO_MS)
        resposta = page.context.request.get(popup.url)
        conteudo = resposta.body()
        popup.close()
        return conteudo

    raise ErroPortal("[dms] PDF não foi gerado (nem download nem aba nova detectados)")

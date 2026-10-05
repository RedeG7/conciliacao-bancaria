#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Automação ATTENDED do ISS Net Online (Goiânia/Ap. de Goiânia) — a pessoa faz
login manualmente (certificado, qualquer verificação do portal) num Edge
comum (Chrome tem um bug conhecido pra baixar PDF nesse portal — confirmado
pelo usuário, por isso Edge); este script só mecaniza os cliques repetitivos
DEPOIS disso, dentro da MESMA janela/sessão já autenticada pela pessoa.

Mecanismo: Windows UI Automation (pywinauto, backend "uia") lendo a árvore
de acessibilidade da página — não usa Playwright/CDP, não conecta no
navegador por protocolo de automação nenhum. Só enxerga o conteúdo da
página porque o navegador foi aberto com --force-renderer-accessibility
(flag padrão de acessibilidade, usada por leitores de tela).

CONFIRMADO AO VIVO nesta sessão (Edge, empresa "IS Engenharia e Construcao
Ltda", Goiânia, competência 08/2026):
  - Busca por CPF/CNPJ na tela Empresas + clique no botão "Selecione" da
    linha certa.
  - Menu lateral: clicar em "Livro Fiscal" (ListItem) expande "Emitir Livro
    Fiscal" (ListItem) - clicar de novo abre o formulário.
  - "Tipo do Documento" é um <select> NATIVO do navegador (não native
    HTML combo custom) - não abre como popup UIA navegável; a forma que
    funcionou foi focar (click) + digitar "l" (seleciona por primeira
    letra, padrão de <select> nativo) + Enter. Isso já marca "Serviços
    Prestados" (DMS) por padrão.
  - Data Inicial/Data Final: dois campos Edit, preenchidos com type_keys
    normal.
  - Botão "Gerar": não achei de forma confiável por texto via UIA (o
    ListItem "Gerar" ficava fora da árvore acessível em alguns momentos) -
    funcionou clicar por COORDENADA da tela (pyautogui.click), calculada a
    partir de um screenshot da região do formulário. Isso é o ponto mais
    frágil do fluxo — se o layout/zoom/posição da janela mudar, quebra.
  - PDF abre num popup novo (about:blank -> navega para
    Relatorios/ReportManager.aspx) - no Edge renderiza corretamente (no
    Chrome ficou em branco, bug conhecido do usuário nesse navegador/portal
    - por isso o script pressupõe Edge). Salvar: Ctrl+S no visualizador de
    PDF do Edge abre "Salvar como" nativo do Windows - digitar o caminho
    completo no campo "Nome" funciona e cria o arquivo direto, sem precisar
    navegar pastas na mão. (Versão anterior clicava por coordenada no ícone
    de salvar da toolbar - trocado por Ctrl+S porque uma coordenada fixa
    calculada numa tela podia cair em outro lugar, inclusive perto do botão
    de fechar da janela, em telas com resolução diferente.)
  - Texto extraído do PDF gerado (pdfplumber) pra empresa SEM movimento
    contém a frase exata "não teve movimento econômico tributável" na
    página 2 (ver _tem_movimento) - mais confiável que tentar ler "Total
    Registros:" (que no caso sem movimento aparece sem nenhum número
    depois, nem "0").

AINDA NÃO TESTADO AO VIVO por este script (escrito com base no que já foi
confirmado no Playwright e na exploração manual anterior — tratar como
palpite informado, validar com atenção):
  - Fluxo de REST (Serviços Contratados) - mesma tela, só troca o rádio.
  - Exportar XML quando há movimento (Nota Eletrônica > Consultar).
  - O loop completo por várias empresas em sequência.
  - Comportamento quando a busca por CNPJ não acha a empresa, ou quando o
    "Gerar" demora mais que o esperado.

Pré-requisito: Edge já aberto (lançado com --force-renderer-accessibility),
login já feito manualmente pela pessoa, dentro de uma empresa (ou na tela
Empresas, pronto pra buscar a próxima).
"""

from __future__ import annotations

import re
import shutil
import sys
import time
from pathlib import Path

from pywinauto import Desktop
from pywinauto.timings import TimeoutError as PywinautoTimeoutError

sys.path.insert(0, str(Path(__file__).resolve().parent))  # pra importar hub_api
import hub_api

# titulos de janela do navegador as vezes trazem caracteres invisiveis
# (ex.: zero-width space) que o console do Windows nao imprime na
# codificacao padrao (cp1252) - sem isso, o script (principalmente o .exe
# empacotado) crasha com UnicodeEncodeError so por causa de um print().
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # pra importar rpa.issnet.competencia

TIMEOUT_PADRAO_S = 15
TIMEOUT_CURTO_S = 4

_RE_SEM_MOVIMENTO = re.compile(r"não teve movimento econômico tributável", re.IGNORECASE)


class ErroAttended(Exception):
    """Falha num passo da automação attended — não deve derrubar o processo
    inteiro, só a empresa atual (mesma filosofia do worker Playwright)."""


# ---------------------------------------------------------------------------
# Janela / navegação
# ---------------------------------------------------------------------------

def conectar_janela():
    """Acha a janela do Edge/Chrome já logada no portal. Prefere Edge
    (Chrome tem bug conhecido pra baixar PDF nesse portal - ver docstring
    do módulo).

    IMPORTANTE: pywinauto resolve o título de forma preguiçosa - um
    WindowSpecification guardado numa variável e reusado depois de a
    página navegar (título muda entre "Empresas..." e "ISSNet On-Line -
    Nota Eletrônica...") quebra com ElementNotFoundError, porque ele tenta
    re-resolver pelo título ORIGINAL. Por isso o padrão usa um regex único
    que casa as DUAS variações de título ao mesmo tempo (em vez de uma
    lista de padrões tentados em sequência) - confirmado ao vivo que isso
    resolve o problema; ainda assim, chame conectar_janela() de novo
    depois de qualquer navegação que possa ter mudado a aba/página, não
    reuse a referência antiga por muito tempo."""
    d = Desktop(backend="uia")
    padroes = [
        r".*(Empresas|ISSNet On-Line|Nota Eletr).*Edge.*",
        r".*(Empresas|ISSNet On-Line|Nota Eletr).*Chrome.*",
    ]
    for titulo_re in padroes:
        try:
            win = d.window(title_re=titulo_re)
            win.wait("exists", timeout=2)
            win.set_focus()
            time.sleep(0.3)
            try:
                win.maximize()  # geometria consistente p/ os cliques por coordenada, qualquer que seja a tela do usuário
                time.sleep(0.3)
            except Exception:
                pass
            return win
        except PywinautoTimeoutError:
            continue
    raise ErroAttended(
        "Não achei a janela do navegador logada no portal. Confirme que está aberto "
        "(com --force-renderer-accessibility) e logado."
    )


def _achar_edit_por_rotulo(win, rotulo: str):
    statics = win.descendants(control_type="Text")
    alvo = next((s for s in statics if s.window_text().strip() == rotulo), None)
    if alvo is None:
        raise ErroAttended(f"[campo] rótulo '{rotulo}' não encontrado na tela")
    rect_alvo = alvo.rectangle()
    edits = win.descendants(control_type="Edit")
    candidatos = [e for e in edits if abs(e.rectangle().top - rect_alvo.bottom) < 40 or abs(e.rectangle().top - rect_alvo.top) < 10]
    if not candidatos:
        raise ErroAttended(f"[campo] nenhum campo Edit perto do rótulo '{rotulo}'")
    candidatos.sort(key=lambda e: abs(e.rectangle().left - rect_alvo.left))
    return candidatos[0]


def esta_na_tela_empresas(win) -> bool:
    """Confere se a página atual é a listagem 'Empresas' (tem o campo de
    busca 'CPF / CNPJ') - usado pra falhar rápido e com mensagem clara
    logo no início do lote, em vez de repetir o mesmo erro cripticamente
    pra cada empresa da planilha quando a janela começa em outra página
    (ex.: dentro de uma empresa específica, em Nota Eletrônica etc)."""
    statics = win.descendants(control_type="Text")
    return any(s.window_text().strip() == "CPF / CNPJ" for s in statics)


def _fechar_popup_atencao(win) -> "str | None":
    """Detecta QUALQUER popup modal 'Atenção' que o portal mostra (o
    portal reusa esse MESMO modal genérico pra vários avisos - "Contribuinte
    não encontrado." foi o primeiro confirmado ao vivo, mas pode aparecer
    com outra mensagem) e clica em OK pra fechar. Sem isso o popup fica
    aberto bloqueando a página, e a automação seguinte (inclusive
    voltar_para_empresas da PRÓXIMA empresa) acaba clicando nele sem
    querer em vez do elemento certo - mesma classe de bug já vista com o
    painel de Downloads do Edge interceptando cliques (ver
    voltar_para_empresas). Retorna o texto da mensagem (pra aparecer no
    log/erro) ou None se não achou nenhum popup."""
    textos = win.descendants(control_type="Text")
    titulo = next((t for t in textos if t.window_text().strip() == "Atenção"), None)
    if titulo is None:
        return None

    rect_titulo = titulo.rectangle()
    proximos = [
        t for t in textos
        if t.window_text().strip() and t.window_text().strip() != "Atenção"
        and 0 < (t.rectangle().top - rect_titulo.bottom) < 150
    ]
    mensagem = proximos[0].window_text().strip() if proximos else "(mensagem não identificada)"

    botoes_ok = [b for b in win.descendants(control_type="Button") if b.window_text().strip().upper() == "OK"]
    if botoes_ok:
        try:
            botoes_ok[0].invoke()
        except Exception:
            botoes_ok[0].click_input()
    else:
        # sem botão OK identificado por algum motivo - Escape fecha a
        # maioria dos modais/diálogos como último recurso.
        try:
            win.type_keys("{ESC}")
        except Exception:
            pass
    time.sleep(0.5)
    return mensagem


def selecionar_empresa(win, cnpj_cpf: str, codigo: str) -> None:
    """Na tela Empresas: digita o CNPJ/CPF no campo de busca e pressiona
    Enter.

    DESCOBERTA CONFIRMADA AO VIVO (com inspeção direta da árvore UIA):
    quando a busca resulta em EXATAMENTE UMA empresa, o próprio portal
    navega direto pra dentro dela sozinho (medido: ~5s depois do Enter) -
    NÃO existe nenhum botão "Selecione" pra clicar nesse caso, porque a
    tela Empresas (com a grade/DataItem) já nem existe mais nesse ponto.
    Essa era a causa raiz de dois bugs anteriores ("empresa não
    encontrada na busca" mesmo com o CNPJ certo, e o fluxo não seguir
    pra Livro Fiscal): o código antigo ficava esperando uma linha de
    grade que nunca ia aparecer, porque a página já tinha navegado.

    Mantém como FALLBACK a lógica antiga (achar a linha na grade e
    clicar no ✓) pro caso da busca retornar mais de um resultado (aí sim
    continua na tela Empresas com uma grade de verdade pra escolher)."""
    campo_busca = _achar_edit_por_rotulo(win, "CPF / CNPJ")
    campo_busca.click_input()
    campo_busca.type_keys("^a{DELETE}", pause=0.02)
    campo_busca.type_keys(cnpj_cpf.replace("{", "{{").replace("}", "}}"), with_spaces=True)
    campo_busca.type_keys("{ENTER}")

    prazo = time.time() + TIMEOUT_PADRAO_S
    while time.time() < prazo:
        mensagem_popup = _fechar_popup_atencao(win)
        if mensagem_popup is not None:
            raise ErroAttended(
                f"[selecionar_empresa] empresa {codigo} ({cnpj_cpf}) — popup \"Atenção\" do portal: {mensagem_popup}"
            )
        if not esta_na_tela_empresas(win):
            return  # navegou sozinho pra dentro da empresa - nada mais a fazer
        time.sleep(0.5)

    # ainda na tela Empresas depois do prazo -> a busca não navegou
    # sozinha (provavelmente mais de um resultado) - tenta achar a linha
    # certa na grade e clicar no botão Selecione dela.
    candidatas = [d for d in win.descendants(control_type="DataItem") if cnpj_cpf in d.window_text()]
    if not candidatas:
        raise ErroAttended(f"[selecionar_empresa] empresa {codigo} ({cnpj_cpf}) não encontrada na busca")
    rect_linha = candidatas[0].rectangle()

    hyperlinks = win.descendants(control_type="Hyperlink")
    candidatos = [h for h in hyperlinks if abs(h.rectangle().top - rect_linha.top) < 15]
    if not candidatos:
        raise ErroAttended(f"[selecionar_empresa] botão Selecione não encontrado pra empresa {codigo}")
    candidatos[0].click_input()
    time.sleep(2)


def voltar_para_empresas(win) -> None:
    """Clica no botão com o nome da empresa atual (canto superior direito,
    dentro de uma empresa) pra voltar pra tela Empresas - confirmado ao
    vivo. O texto acessível desse botão vem com um glifo de ícone colado
    na frente (ex.: '\\uee53IS Engenharia...'), por isso usa title_re
    genérico em vez de tentar casar o nome exato da empresa (que muda a
    cada chamada).

    IMPORTANTE: a busca é restrita aos Document (conteúdo da página),
    NUNCA ao win inteiro - win.descendants() também devolve botões do
    CHROME do navegador (barra de abas, "Fechar guia" etc.), que ficam
    bem no topo da janela como a área da página. Se a busca pegasse o win
    inteiro e o botão certo não fosse o primeiro da lista, dava pra clicar
    sem querer no botão de fechar a aba/janela - causa confirmada de um
    bug relatado (empresa selecionada, fluxo seguinte falha, PÁGINA
    FECHA) quando processar_empresa lança erro antes de abrir_livro_fiscal
    e o fallback aqui pegava o botão errado."""
    # varre TODOS os Document (não só o último) - a página pode ter mais de
    # um frame dependendo de qual sub-tela está aberta (ex.: Nota
    # Eletrônica pareceu usar uma estrutura diferente da de Livro Fiscal
    # nos testes), e pegar só o último Document podia não achar o botão
    # nesse caso.
    docs = win.descendants(control_type="Document")
    alvos = docs if docs else [win]
    fixos = {"Sair", "Competência", "Ajuda", "Menu"}
    candidatos = []
    for alvo in alvos:
        try:
            botoes = alvo.descendants(control_type="Button")
        except Exception:
            continue
        candidatos.extend(
            b for b in botoes
            if b.window_text().strip()
            and not any(f in b.window_text() for f in fixos)
            and b.rectangle().top < 220
        )
    if not candidatos:
        raise ErroAttended("[voltar_para_empresas] botão da empresa atual não encontrado no topo da página")
    candidatos[0].click_input()
    time.sleep(2)

    try:
        win.child_window(title="Selecione a Empresa", control_type="Text").wait("exists", timeout=TIMEOUT_PADRAO_S)
    except PywinautoTimeoutError as exc:
        raise ErroAttended("[voltar_para_empresas] não confirmou volta pra tela Empresas") from exc


def _achar_item_menu(win, texto: str, timeout: float):
    """Busca um ListItem do menu lateral por SUBSTRING (não título exato) -
    mesmo motivo da correção em selecionar_empresa: itens de menu costumam
    ter um glifo de ícone colado no nome acessível (ver voltar_para_empresas),
    então título EXATO falha de forma inconsistente. Faz polling porque o
    item só aparece depois que a página da empresa termina de carregar.

    Inspeção ao vivo da árvore UIA revelou dois detalhes importantes:
    1) O ListItem "Emitir Livro Fiscal" tem um Hyperlink FILHO com o
       mesmo texto - é esse Hyperlink que tem o clique de navegação de
       verdade; clicar no ListItem pai não navegava (ficava só marcado/
       destacado, sem trocar o conteúdo da página). Por isso a busca
       tenta Hyperlink primeiro.
    2) O ListItem "Livro Fiscal" (item pai, que só expande/recolhe)
       concatena o texto dos filhos no próprio window_text() (ex.:
       "Livro FiscalEmitir Livro Fiscal"), então uma busca por substring
       simples de "Emitir Livro Fiscal" batia ERRADO nesse ListItem pai
       também (falso positivo) e ficava clicando nele de novo em vez do
       item filho - por isso o fallback pra ListItem usa startswith, que
       distingue as duas strings corretamente."""
    prazo = time.time() + timeout
    while time.time() < prazo:
        links = [h for h in win.descendants(control_type="Hyperlink") if texto in h.window_text()]
        if links:
            return links[0]
        candidatos = [i for i in win.descendants(control_type="ListItem") if i.window_text().strip().startswith(texto)]
        if candidatos:
            return candidatos[0]
        time.sleep(0.3)
    return None


def abrir_livro_fiscal(win) -> None:
    """Clica em Livro Fiscal > Emitir Livro Fiscal no menu lateral."""
    item = _achar_item_menu(win, "Livro Fiscal", TIMEOUT_PADRAO_S)
    if item is None:
        raise ErroAttended("[menu] 'Livro Fiscal' não encontrado")
    item.click_input()
    time.sleep(1)

    sub = _achar_item_menu(win, "Emitir Livro Fiscal", TIMEOUT_CURTO_S)
    if sub is None:
        raise ErroAttended("[menu] 'Emitir Livro Fiscal' não encontrado")
    sub.click_input()
    time.sleep(1.5)


def selecionar_tipo_livro_fiscal(win) -> None:
    """'Tipo do Documento' é um <select> nativo - não abre como popup UIA
    navegável. Funciona focar + digitar a primeira letra + Enter (padrão
    de <select> nativo do navegador). Confirmado ao vivo."""
    combos = win.descendants(control_type="ComboBox")
    if not combos:
        raise ErroAttended("[livro_fiscal] combo 'Tipo do Documento' não encontrado")
    combo = combos[0]
    combo.click_input()
    time.sleep(0.3)
    combo.type_keys("l")
    time.sleep(0.3)
    combo.type_keys("{ENTER}")
    time.sleep(1.5)


def marcar_tipo_servico(win, tipo_servico: str) -> None:
    """tipo_servico: 'prestados' (DMS, já vem marcado por padrão - ver
    screenshot confirmado ao vivo) ou 'contratados' (REST, AINDA NÃO
    TESTADO - precisa clicar no rádio 'Serviços Contratados')."""
    if tipo_servico == "prestados":
        return  # já vem selecionado por padrão, confirmado ao vivo
    prazo = time.time() + TIMEOUT_CURTO_S
    radio = None
    while time.time() < prazo:
        candidatos = [
            r for r in win.descendants(control_type="RadioButton")
            if "Serviços Contratados" in r.window_text()
        ]
        if candidatos:
            radio = candidatos[0]
            break
        time.sleep(0.3)
    if radio is None:
        raise ErroAttended("[livro_fiscal] rádio 'Serviços Contratados' não encontrado")
    radio.click_input()
    time.sleep(0.5)


def preencher_datas_livro_fiscal(win, data_inicial: str, data_final: str) -> None:
    """Confirmado ao vivo: dois Edit específicos (índices 3 e 4 entre todos
    os Edit da janela, na tela de Emitir Livro Fiscal)."""
    edits = win.descendants(control_type="Edit")
    if len(edits) < 5:
        raise ErroAttended(f"[livro_fiscal] esperava >=5 campos Edit, achei {len(edits)}")
    campo_inicial, campo_final = edits[3], edits[4]
    campo_inicial.click_input()
    time.sleep(0.2)
    campo_inicial.type_keys("^a{DELETE}", pause=0.02)
    campo_inicial.type_keys(data_inicial, with_spaces=True)
    time.sleep(0.2)
    campo_final.click_input()
    time.sleep(0.2)
    campo_final.type_keys("^a{DELETE}", pause=0.02)
    campo_final.type_keys(data_final, with_spaces=True)
    time.sleep(0.3)


def clicar_gerar_por_coordenada(win) -> None:
    """Tenta achar o botão 'Gerar' por texto primeiro (robusto, independe da
    tela do usuário); só cai pro clique por COORDENADA (frágil - ver
    docstring do módulo) se não achar. A janela já é maximizada em
    conectar_janela(), então a coordenada de fallback fica mais previsível
    entre máquinas diferentes - mas ainda pode errar se a resolução for
    muito diferente da usada nos testes (1920x1080)."""
    for tipo in ("Button", "Hyperlink", "ListItem", "Text"):
        try:
            candidatos = [
                el for el in win.descendants(control_type=tipo)
                if "gerar" in el.window_text().strip().lower()
            ]
        except Exception:
            candidatos = []
        if candidatos:
            candidatos[0].click_input()
            time.sleep(3)
            return

    import pyautogui
    edits = win.descendants(control_type="Edit")
    campo_inicial = edits[3]
    rect = campo_inicial.rectangle()
    x = rect.left + 100
    y = rect.bottom + 70
    pyautogui.click(x, y)
    time.sleep(3)


# ---------------------------------------------------------------------------
# PDF: popup, salvar
# ---------------------------------------------------------------------------

def salvar_pdf_popup(caminho_destino: Path) -> None:
    """Espera o popup do PDF abrir e clica no botão "Salvar" da toolbar do
    visualizador (achado por UIA, não por coordenada nem atalho de
    teclado - confirmado ao vivo).

    HISTÓRICO (pra não repetir as duas tentativas que não funcionaram):
    1) Clique por coordenada fixa no ícone - arriscado, quebra se a
       resolução/posição da janela mudar (podia até acertar o botão de
       FECHAR da janela em vez do ícone certo).
    2) Ctrl+S - testado ao vivo e NÃO abre o 'Salvar como': o atalho real
       desse visualizador é Ctrl+B, não Ctrl+S (confirmado inspecionando a
       árvore UIA: o botão se chama "Salvar (Ctrl+B)"). Ctrl+S deixava a
       página em branco (mesmo bug de renderização já visto no Chrome,
       aqui disparado de outra forma).
    O que funciona: achar o Button cujo texto contém "Salvar" e clicar
    nele diretamente - não precisa maximizar a janela nem saber o atalho."""
    import pyautogui

    d = Desktop(backend="uia")
    popup = None
    for _ in range(20):
        candidatos = d.windows(title_re=r".*ReportManager.*")
        if candidatos:
            # pode sobrar mais de um popup (ex.: um anterior que não
            # fechou por causa de erro/timeout numa empresa passada) -
            # d.window() quebra com ElementAmbiguousError nesse caso;
            # usa sempre o ÚLTIMO (mais recente) e não trata isso como
            # erro, já que é esperado em execuções longas com várias
            # empresas.
            popup = candidatos[-1]
            break
        time.sleep(0.5)
    if popup is None:
        raise ErroAttended("[salvar_pdf] popup do PDF (ReportManager) não abriu a tempo")

    time.sleep(1.5)
    botoes_salvar = [b for b in popup.descendants(control_type="Button") if "Salvar" in b.window_text()]
    if not botoes_salvar:
        raise ErroAttended("[salvar_pdf] botão 'Salvar' não encontrado na toolbar do visualizador")
    botoes_salvar[0].click_input()
    time.sleep(2)

    caminho_destino.parent.mkdir(parents=True, exist_ok=True)
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.typewrite(str(caminho_destino), interval=0.01)
    time.sleep(0.3)
    pyautogui.press("enter")
    time.sleep(2)

    # mesmo painel de "Downloads" do Edge que aparece em exportar_xml_
    # competencia() - fecha antes de fechar o popup, por segurança (ver
    # comentário lá pro motivo completo).
    pyautogui.press("escape")
    time.sleep(0.5)

    popup.close()
    time.sleep(1)

    if not caminho_destino.exists():
        raise ErroAttended(f"[salvar_pdf] arquivo não apareceu em {caminho_destino} após salvar")


def tem_movimento(caminho_pdf: Path) -> bool:
    """Confirmado ao vivo: PDF sem movimento tem a frase exata 'não teve
    movimento econômico tributável' na página 2. Ausência dessa frase =
    tem movimento (heurística por exclusão)."""
    import pdfplumber
    with pdfplumber.open(caminho_pdf) as pdf:
        texto = "\n".join(pagina.extract_text() or "" for pagina in pdf.pages)
    return not _RE_SEM_MOVIMENTO.search(texto)


# ---------------------------------------------------------------------------
# Nota Eletrônica: exportar XML da competência (empresa COM movimento)
# ---------------------------------------------------------------------------

def _achar_por_postback(win, trecho: str, tipo: str = "Hyperlink"):
    """Acha um elemento pelo trecho do javascript:__doPostBack(...) REAL
    (propriedade legacy 'Value', exposta pelo controle ASP.NET) em vez do
    texto visível - confirmado ao vivo como o jeito mais confiável de
    identificar ícones que só têm um glifo de fonte como texto acessível
    (não dá pra procurar "Exportar XML" no texto - o texto É só um
    glifo, ex. '\\uea72'). O nome do controle no postback (ex.
    'btnExportarTodosXml') é estável porque é gerado pelo ASP.NET a
    partir do ID do controle no servidor, não muda com sessão/dados."""
    for el in win.descendants(control_type=tipo):
        try:
            valor = el.legacy_properties().get("Value", "")
        except Exception:
            continue
        if trecho in valor:
            return el
    return None


def abrir_consultar_nota_eletronica(win) -> None:
    """Clica em Nota Eletrônica > Consultar Nota Eletrônica no menu
    lateral - confirmado ao vivo.

    NÃO usa _achar_item_menu aqui: "Nota Eletrônica" é substring tanto de
    "Nova Nota Eletrônica" quanto de "Consultar Nota Eletrônica" (os dois
    itens filhos), então a busca de _achar_item_menu (Hyperlink por
    substring primeiro) acharia um item FILHO errado antes de qualquer
    Hyperlink do item pai (que nem existe - só o ListItem pai é
    clicável). Usa startswith no ListItem pai (só ele começa exatamente
    com "Nota Eletrônica") e depois match EXATO no Hyperlink filho certo
    (sem ambiguidade, já que os dois nomes de filho são diferentes um do
    outro quando comparados por igualdade)."""
    prazo = time.time() + TIMEOUT_PADRAO_S
    pai = None
    while time.time() < prazo:
        candidatos = [
            i for i in win.descendants(control_type="ListItem")
            if i.window_text().strip().startswith("Nota Eletrônica")
        ]
        if candidatos:
            pai = candidatos[0]
            break
        time.sleep(0.3)
    if pai is None:
        raise ErroAttended("[menu] 'Nota Eletrônica' não encontrado")
    pai.click_input()
    time.sleep(1)

    prazo = time.time() + TIMEOUT_CURTO_S
    sub = None
    while time.time() < prazo:
        candidatos = [h for h in win.descendants(control_type="Hyperlink") if h.window_text() == "Consultar Nota Eletrônica"]
        if candidatos:
            sub = candidatos[0]
            break
        time.sleep(0.3)
    if sub is None:
        raise ErroAttended("[menu] 'Consultar Nota Eletrônica' não encontrado")
    sub.click_input()
    time.sleep(2)


def _aguardar_novo_arquivo_downloads(pasta_downloads: Path, referencia: float, timeout: float) -> "Path | None":
    """Espera um .zip NOVO aparecer em pasta_downloads (mtime >=
    referencia) e o tamanho estabilizar entre duas checagens seguidas
    (sinal de que o download terminou) - usado em vez de depender do
    prompt "Salvar como" do Edge, que só aparece se a opção "Perguntar o
    que fazer com cada download" estiver ligada nas configurações do
    navegador (ver exportar_xml_competencia pro motivo completo). Retorna
    None se nada apareceu dentro do prazo."""
    candidato = None
    ultimo_tamanho = -1
    prazo = time.time() + timeout
    while time.time() < prazo:
        try:
            arquivos = sorted(
                (p for p in pasta_downloads.glob("*.zip") if p.stat().st_mtime >= referencia),
                key=lambda p: p.stat().st_mtime, reverse=True,
            )
        except OSError:
            arquivos = []
        if arquivos:
            candidato = arquivos[0]
            try:
                tamanho_atual = candidato.stat().st_size
            except OSError:
                tamanho_atual = -1
            if tamanho_atual > 0 and tamanho_atual == ultimo_tamanho:
                return candidato
            ultimo_tamanho = tamanho_atual
        time.sleep(1)
    return candidato


def exportar_xml_competencia(win, data_inicial: str, data_final: str, caminho_destino: Path) -> bool:
    """Nota Eletrônica > Consultar Nota Eletrônica > expande "Filtros
    Adicionais" > preenche Data Competência Inicial/Final > Localizar >
    clica no ícone "Exportar todas as notas em XML" do cabeçalho da
    grade > espera o arquivo aparecer na pasta Downloads e move pro
    destino certo (não depende do prompt "Salvar como" - ver
    _aguardar_novo_arquivo_downloads pro motivo). Tudo achado por UIA
    (postback real dos botões, não coordenada nem glifo de ícone) -
    confirmado ao vivo, com XML real validado (59 notas, formato ABRASF
    NFSe padrão).

    Retorna True se salvou algum arquivo, False se a busca não achou
    nenhuma nota nessa competência (não é erro - só não tem nada pra
    exportar; PODE acontecer mesmo com "tem_movimento()" True, já que
    aquela checagem é sobre o PDF do Livro Fiscal, uma fonte diferente).

    LIMITE CONFIRMADO AO VIVO: a busca por data aceita no máximo 31 dias
    entre inicial e final - uma competência de um mês só (a mesma janela
    usada no Livro Fiscal) sempre respeita isso."""
    import pyautogui

    # acomodação extra: confirmado ao vivo que, logo depois do popup do
    # PDF do Livro Fiscal fechar (salvar_pdf_popup), a página principal
    # demora um pouco mais que o normal pra reagir a cliques - sem essa
    # pausa, o primeiro clique em "Localizar" mais adiante às vezes não
    # tinha efeito nenhum (nem grade, nem diálogo de erro).
    time.sleep(2)

    abrir_consultar_nota_eletronica(win)

    seta_filtros = _achar_por_postback(win, "imbArrow")
    if seta_filtros is None:
        raise ErroAttended("[exportar_xml] 'Filtros Adicionais' não encontrado")
    try:
        seta_filtros.invoke()
    except Exception:
        seta_filtros.click_input()
    time.sleep(1)

    campo_ini = _achar_edit_por_rotulo(win, "Data Competência Inicial")
    campo_ini.click_input()
    campo_ini.type_keys("^a{DELETE}", pause=0.02)
    campo_ini.type_keys(data_inicial, with_spaces=True)

    campo_fim = _achar_edit_por_rotulo(win, "Data Competência Final")
    campo_fim.click_input()
    campo_fim.type_keys("^a{DELETE}", pause=0.02)
    campo_fim.type_keys(data_final, with_spaces=True)
    time.sleep(0.3)

    def _resultado_pronto():
        """Retorna ('vazio', None) se o diálogo 'Nenhum registro' apareceu,
        ('achou', botao) se a grade carregou (botão Exportar Todos XML
        presente), ou (None, None) se ainda não reagiu."""
        btn_ok = [b for b in win.descendants(control_type="Button") if "OK" in b.window_text()]
        if btn_ok:
            return "vazio", btn_ok[0]
        botao = _achar_por_postback(win, "btnExportarTodosXml")
        if botao is not None:
            return "achou", botao
        return None, None

    # CAUSA RAIZ CONFIRMADA AO VIVO (depois de bastante investigação): o
    # clique em "Localizar" via click_input() (clique de mouse simulado
    # numa coordenada de tela) simplesmente não tinha efeito nenhum quando
    # essa função rodava logo depois do fluxo do Livro Fiscal (seleciona
    # empresa -> gera PDF -> salva -> só então chega aqui) - mas a MESMA
    # chamada funcionava sempre que testada isolada. A diferença real era
    # o MECANISMO do clique, não timing/foco/polling (tentei de tudo:
    # focar a janela, esperar mais, não fazer polling, buscar a janela de
    # novo a cada tentativa - nada disso resolveu sozinho). O que
    # resolveu foi trocar pra invoke() (UIA InvokePattern - dispara a
    # ação do controle direto pela API de acessibilidade, sem depender de
    # coordenada de tela/scroll/foco do SO). Mantém click_input() como
    # fallback só por segurança, caso o elemento não suporte invoke().
    situacao, elemento = None, None
    for tentativa in range(3):
        win = conectar_janela()
        btn_localizar = _achar_por_postback(win, "btnLocalizar2")
        if btn_localizar is None:
            raise ErroAttended("[exportar_xml] botão 'Localizar' não encontrado")
        try:
            btn_localizar.invoke()
        except Exception:
            btn_localizar.click_input()
        time.sleep(8)
        situacao, elemento = _resultado_pronto()
        if situacao:
            break

    if situacao == "vazio":
        elemento.click_input()
        time.sleep(1)
        return False
    if situacao != "achou":
        raise ErroAttended("[exportar_xml] busca não respondeu (nem grade nem 'nenhum registro')")

    btn_exportar = elemento
    referencia = time.time()
    try:
        btn_exportar.invoke()
    except Exception:
        btn_exportar.click_input()
    time.sleep(1)

    # CAUSA RAIZ CONFIRMADA AO VIVO (num PC de usuário diferente do meu):
    # o prompt "Salvar como" só aparece se a opção do Edge "Perguntar o
    # que fazer com cada download antes de baixar" estiver ligada - em
    # muitas instalações (inclusive a que o usuário testou) ela vem
    # DESLIGADA por padrão, e o arquivo cai direto na pasta Downloads
    # padrão sem perguntar nada. Por isso o código antigo (esperar o botão
    # "Salvar como") travava pra sempre nessa máquina, mesmo com prazo
    # generoso - o botão simplesmente nunca existia.
    #
    # Fix: não depende mais do prompt. Se ele aparecer (algumas máquinas
    # têm a opção ligada, como a minha nos testes originais), clica em
    # "Salvar" (não "Salvar como" - aceita o download direto, sem digitar
    # caminho nenhum). Depois, em QUALQUER caso, só observa a pasta
    # Downloads do usuário até o arquivo novo aparecer e o tamanho parar
    # de crescer (download terminou), e MOVE ele pro destino certo -
    # funciona igual não importa se o Edge perguntou ou baixou direto.
    d = Desktop(backend="uia")
    prazo_barra = time.time() + 5
    while time.time() < prazo_barra:
        candidatos = d.windows(title_re=r".*(Empresas|ISSNet On-Line|Nota Eletr).*Edge.*")
        if candidatos:
            botoes = [b for b in candidatos[0].descendants(control_type="Button") if b.window_text().strip() == "Salvar"]
            if botoes:
                botoes[0].click_input()
                break
        time.sleep(0.3)

    pasta_downloads = Path.home() / "Downloads"
    arquivo_baixado = _aguardar_novo_arquivo_downloads(pasta_downloads, referencia, timeout=45)
    if arquivo_baixado is None:
        raise ErroAttended(
            f"[exportar_xml] nenhum arquivo novo apareceu em {pasta_downloads} depois de exportar"
        )

    caminho_destino.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(arquivo_baixado), str(caminho_destino))

    # o Edge abre o painel de "Downloads" (o mesmo da barra de ferramentas)
    # depois de baixar e ele fica ABERTO por cima da página - relatado ao
    # vivo: sem fechar, o clique seguinte (voltar pra Empresas/selecionar a
    # próxima empresa) caía nesse painel em vez da página, abrindo a pasta
    # de downloads por engano. Esc fecha esse painel (não afeta mais nada
    # na página, já que nenhum campo está em edição nesse ponto).
    pyautogui.press("escape")
    time.sleep(0.5)

    if not caminho_destino.exists():
        raise ErroAttended(f"[exportar_xml] arquivo não apareceu em {caminho_destino} após mover")
    return True


# ---------------------------------------------------------------------------
# Fluxo por empresa
# ---------------------------------------------------------------------------

def processar_empresa(
    win, pasta_raiz: Path, codigo: str, cnpj_cpf: str,
    data_inicial: str, data_final: str, competencia_pasta: str, competencia_arquivo: str,
) -> dict:
    """Fluxo completo pra uma empresa: seleciona, gera DMS, salva, checa
    movimento, (se tiver) exporta XML, senão gera REST também.

    data_inicial/data_final: "DD/MM/AAAA", já calculados pelo chamador (ver
    rpa/issnet/competencia.py calcular_competencia_anterior — mm_aaaa_arquivo,
    data_inicial, data_final). competencia_pasta: "MMAAAA" (nome da
    subpasta, ex. "082026"). competencia_arquivo: "MM AAAA" (pro nome do
    arquivo, mesmo padrão do worker Playwright).

    Retorna {'movimento': str, 'arquivos': [Path]}. AINDA NÃO TESTADO AO
    VIVO em nenhuma empresa com movimento real — a parte de exportar XML é
    a mais arriscada (nunca vi a tela de resultado com notas de verdade
    através deste mecanismo, só documentado do Playwright)."""
    selecionar_empresa(win, cnpj_cpf, codigo)

    # pasta da empresa = "{codigo}-" (traço colado no código, ex. "92-"),
    # padrão de nome de pasta do escritório - o resto do caminho
    # (competência, nome dos arquivos) segue como sempre foi.
    pasta_empresa = pasta_raiz / f"{codigo}-" / competencia_pasta
    arquivos: list[Path] = []

    abrir_livro_fiscal(win)
    selecionar_tipo_livro_fiscal(win)
    marcar_tipo_servico(win, "prestados")
    preencher_datas_livro_fiscal(win, data_inicial, data_final)
    clicar_gerar_por_coordenada(win)

    pdf_dms = pasta_empresa / f"{codigo} DMS {competencia_arquivo}.pdf"
    salvar_pdf_popup(pdf_dms)
    arquivos.append(pdf_dms)

    if tem_movimento(pdf_dms):
        xml_zip = pasta_empresa / f"{codigo} XML {competencia_arquivo}.zip"
        exportou = exportar_xml_competencia(win, data_inicial, data_final, xml_zip)
        if exportou:
            arquivos.append(xml_zip)
            return {"movimento": "DMS com movimento — XML exportado", "arquivos": arquivos}
        return {"movimento": "DMS com movimento — mas nenhuma nota encontrada na competência pra exportar XML", "arquivos": arquivos}

    # sem movimento no DMS -> processa REST (Serviços Contratados) também,
    # mesma regra de negócio do worker Playwright original.
    abrir_livro_fiscal(win)
    selecionar_tipo_livro_fiscal(win)
    marcar_tipo_servico(win, "contratados")
    preencher_datas_livro_fiscal(win, data_inicial, data_final)
    clicar_gerar_por_coordenada(win)

    pdf_rest = pasta_empresa / f"{codigo} REST {competencia_arquivo}.pdf"
    salvar_pdf_popup(pdf_rest)
    arquivos.append(pdf_rest)

    return {"movimento": "DMS sem movimento — REST processado", "arquivos": arquivos}


def processar_planilha(caminho_planilha: Path, pasta_raiz: Path, deve_parar=None) -> None:
    """Loop completo: lê a planilha (mesmo leiaute/validação do Hub web -
    rpa.issnet.planilha), processa cada empresa (seleciona, gera DMS,
    salva, REST se sem movimento), fecha e volta pra Empresas antes da
    próxima. Erro numa empresa não aborta as outras - mesma filosofia do
    worker Playwright: continua a partir da próxima.

    deve_parar: callable opcional (sem argumento, retorna bool) checado
    ANTES de cada empresa - nunca no meio de uma, pra sempre parar numa
    borda limpa (navegador na tela Empresas, nada pela metade). Usado
    pelo botão "Parar" da GUI (ver gui.py _parar)."""
    from rpa.issnet import planilha as planilha_mod
    from rpa.issnet.competencia import calcular_competencia_anterior

    empresas = planilha_mod.ler_empresas(caminho_planilha.read_bytes())
    comp = calcular_competencia_anterior()
    competencia_pasta = comp["mm_aaaa_arquivo"].replace(" ", "")  # "MMAAAA"

    win = conectar_janela()
    print(f"Janela conectada: {win.window_text()}")
    if not esta_na_tela_empresas(win):
        raise ErroAttended(
            "A janela não está na tela 'Empresas' (lista de empresas com o campo "
            "'CPF / CNPJ'). Antes de iniciar, volte pra essa tela no portal — não "
            "fique dentro de uma empresa específica nem em Nota Eletrônica."
        )
    print(f"Competência: {comp['mm_aaaa']} ({len(empresas)} empresa(s) na planilha)")

    resultados = []
    for empresa in empresas:
        if deve_parar and deve_parar():
            print("\n⏹ Parado pelo usuário.")
            break

        codigo, cnpj = empresa["codigo"], empresa["cnpj_cpf"]
        print(f"\n=== Empresa {codigo} ({cnpj}) ===")
        try:
            resultado = processar_empresa(
                win, pasta_raiz, codigo, cnpj,
                comp["data_inicial"], comp["data_final"],
                competencia_pasta, comp["mm_aaaa_arquivo"],
            )
            print(f"  OK — {resultado['movimento']}")
            for arq in resultado["arquivos"]:
                print(f"  arquivo: {arq}")
            resultados.append((codigo, "OK", resultado["movimento"]))
        except ErroAttended as exc:
            print(f"  ERRO — {exc}")
            resultados.append((codigo, "ERRO", str(exc)))
        except Exception as exc:  # nunca deixa uma empresa travar o lote inteiro
            print(f"  ERRO INESPERADO — {exc}")
            resultados.append((codigo, "ERRO", str(exc)))

        try:
            voltar_para_empresas(win)
        except Exception as exc:
            print(f"  AVISO: não confirmou volta pra Empresas ({exc}) — tentando seguir mesmo assim")

    print("\n=== Resumo ===")
    for codigo, status, detalhe in resultados:
        print(f"{codigo}: {status} — {detalhe}")


# ---------------------------------------------------------------------------
# Sincronização com o Hub - login/senha via API HTTP (ver hub_api.py e, na
# raiz do repositório, api.py). Substitui o mecanismo antigo de túnel SSH +
# acesso direto ao Postgres do VPS (exigia chave de deploy manual na
# máquina) - agora qualquer usuário do Hub sincroniza só com o próprio
# login, sem configuração nenhuma além disso.
# ---------------------------------------------------------------------------

def processar_execucao_hub(token: str, pasta_raiz: Path, deve_parar=None) -> None:
    """Versão sincronizada com o Hub: em vez de ler uma planilha local,
    pega a execução PENDENTE mais recente do módulo issnet_rest_dms criada
    na tela do Hub (upload de planilha lá, mesmo fluxo de sempre) e
    devolve o resultado pra lá - status por empresa e os PDFs/XMLs, pra
    aparecerem como botão de download no Hub, igual um módulo totalmente
    automatizado. Confere a licença antes de processar qualquer coisa.

    token: sessão obtida via hub_api.login(usuario, senha) - o mesmo tipo
    de token usado no cookie do navegador (30 dias de validade).

    deve_parar: callable opcional (sem argumento, retorna bool) checado
    ANTES de cada empresa - nunca no meio de uma (ver processar_planilha).
    Se parar com empresas ainda PENDENTE, elas ficam assim no Hub mesmo
    (nunca marcadas erro só por não terem rodado) - reabrir_execucao_se_incompleta
    (rpa/core.py, chamada pela tela do Hub) já cobre esse caso exatamente
    (execução "interrompida no meio"), então dá pra continuar depois
    rodando o script de novo sem perder nada."""
    from rpa.issnet.competencia import calcular_competencia_anterior

    if not hub_api.verificar_licenca(token):
        raise ErroAttended(
            "[licença] uso do script attended está BLOQUEADO pelo administrador "
            "pra este escritório - fale com o super admin do Hub"
        )

    resultado_busca = hub_api.execucao_pendente(token, "issnet_rest_dms")
    execucao_id = resultado_busca["execucao_id"]
    if execucao_id is None:
        print("Nenhuma execução PENDENTE encontrada pra este escritório - envie a planilha no Hub primeiro.")
        return

    empresas = resultado_busca["empresas"]
    if not empresas:
        print(f"Execução #{execucao_id} não tem empresa pendente.")
        return

    comp = calcular_competencia_anterior()
    competencia_pasta = comp["mm_aaaa_arquivo"].replace(" ", "")

    win = conectar_janela()
    print(f"Janela conectada: {win.window_text()}")
    if not esta_na_tela_empresas(win):
        raise ErroAttended(
            "A janela não está na tela 'Empresas' (lista de empresas com o campo "
            "'CPF / CNPJ'). Antes de iniciar, volte pra essa tela no portal — não "
            "fique dentro de uma empresa específica nem em Nota Eletrônica."
        )
    print(f"Execução #{execucao_id} — competência {comp['mm_aaaa']} — {len(empresas)} empresa(s) pendente(s)")

    alguma_concluida = False
    for empresa in empresas:
        if deve_parar and deve_parar():
            print("\n⏹ Parado pelo usuário — empresas restantes continuam pendentes no Hub, pode retomar depois.")
            break

        codigo, cnpj = empresa["codigo"], empresa["cnpj_cpf"]
        print(f"\n=== Empresa {codigo} ({cnpj}) ===")
        hub_api.marcar_rodando(token, empresa["id"])
        try:
            resultado = processar_empresa(
                win, pasta_raiz, codigo, cnpj,
                comp["data_inicial"], comp["data_final"],
                competencia_pasta, comp["mm_aaaa_arquivo"],
            )
            arquivos_pdf = [a for a in resultado["arquivos"] if a.suffix.lower() == ".pdf"]
            arquivos_xml = [a for a in resultado["arquivos"] if a.suffix.lower() == ".zip"]
            hub_api.concluir_empresa(
                token, empresa["id"], resultado["movimento"],
                pdf_path=arquivos_pdf[-1] if arquivos_pdf else None,
                xml_path=arquivos_xml[-1] if arquivos_xml else None,
            )
            print(f"  OK — {resultado['movimento']} (sincronizado com o Hub)")
            alguma_concluida = True
        except Exception as exc:
            print(f"  ERRO — {exc}")
            hub_api.erro_empresa(token, empresa["id"], str(exc))

        try:
            voltar_para_empresas(win)
        except Exception as exc:
            print(f"  AVISO: não confirmou volta pra Empresas ({exc}) — tentando seguir mesmo assim")

    status_final = "CONCLUIDO" if alguma_concluida else "ERRO"
    hub_api.concluir_execucao(token, execucao_id, comp["mm_aaaa"], status_final)
    print(f"\nExecução #{execucao_id} finalizada ({status_final}) e sincronizada com o Hub.")


def main_cli() -> None:
    """Modo linha de comando (sem interface gráfica) - usado por gui.py
    quando roda com argumentos reconhecidos, e também disponível chamando
    este arquivo direto (uso avançado/automação/debug)."""
    if len(sys.argv) > 3 and sys.argv[1] == "processar-hub":
        # usuario/senha em vez de escritorio_id - loga na hora (mesmo
        # login do site) pra pegar o token, sem precisar de chave SSH nem
        # config nenhuma na maquina.
        dados_login = hub_api.login(sys.argv[2], sys.argv[3])
        processar_execucao_hub(dados_login["token"], Path(sys.argv[4] if len(sys.argv) > 4 else r"C:\Prefeituras"))
        return

    if len(sys.argv) > 2 and sys.argv[1] == "processar-planilha":
        processar_planilha(Path(sys.argv[2]), Path(sys.argv[3] if len(sys.argv) > 3 else r"C:\Prefeituras"))
        return

    win = conectar_janela()
    print("Janela conectada:", win.window_text())

    if len(sys.argv) > 2 and sys.argv[1] == "testar-empresa":
        cnpj_teste = sys.argv[2]
        codigo_teste = sys.argv[3] if len(sys.argv) > 3 else "teste"
        from rpa.issnet.competencia import calcular_competencia_anterior
        comp = calcular_competencia_anterior()
        resultado = processar_empresa(
            win, Path(sys.argv[4] if len(sys.argv) > 4 else r"C:\Prefeituras"),
            codigo_teste, cnpj_teste,
            comp["data_inicial"], comp["data_final"],
            comp["mm_aaaa_arquivo"].replace(" ", ""), comp["mm_aaaa_arquivo"],
        )
        print("Resultado:", resultado)


if __name__ == "__main__":
    main_cli()

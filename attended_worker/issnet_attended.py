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
import sys
import time
from pathlib import Path

from pywinauto import Desktop
from pywinauto.timings import TimeoutError as PywinautoTimeoutError

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


def selecionar_empresa(win, cnpj_cpf: str, codigo: str) -> None:
    """Na tela Empresas: busca por CNPJ/CPF e clica no ✓ (Selecione) da
    linha correspondente. Confirmado ao vivo."""
    campo_busca = _achar_edit_por_rotulo(win, "CPF / CNPJ")
    campo_busca.click_input()
    campo_busca.type_keys("^a{DELETE}", pause=0.02)
    campo_busca.type_keys(cnpj_cpf.replace("{", "{{").replace("}", "}}"), with_spaces=True)
    campo_busca.type_keys("{ENTER}")
    time.sleep(2)

    linha_alvo = win.child_window(title=cnpj_cpf, control_type="DataItem")
    try:
        linha_alvo.wait("exists", timeout=TIMEOUT_PADRAO_S)
    except PywinautoTimeoutError as exc:
        raise ErroAttended(f"[selecionar_empresa] empresa {codigo} ({cnpj_cpf}) não encontrada na busca") from exc
    rect_linha = linha_alvo.rectangle()

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

    IMPORTANTE: a busca é restrita ao Document (conteúdo da página via
    _tela_documento), NUNCA ao win inteiro - win.descendants() também
    devolve botões do CHROME do navegador (barra de abas, "Fechar guia"
    etc.), que ficam bem no topo da janela como a área da página. Se a
    busca pegasse o win inteiro e o botão certo não fosse o primeiro da
    lista, dava pra clicar sem querer no botão de fechar a aba/janela -
    suspeita forte de um bug relatado (empresa selecionada, fluxo seguinte
    falha, PÁGINA FECHA) quando processar_empresa lança erro antes de
    abrir_livro_fiscal e o fallback aqui pega o botão errado."""
    doc = _tela_documento(win)
    botoes = doc.descendants(control_type="Button")
    # o botão da empresa fica na faixa superior da página (mesma área do
    # "Competência: ..." e "Sair"), com texto não-vazio que não é nenhum
    # desses rótulos fixos - identifica por eliminação em vez de regex de
    # nome (mais robusto entre empresas com nomes bem diferentes).
    fixos = {"Sair", "Competência", "Ajuda", "Menu"}
    candidatos = [
        b for b in botoes
        if b.window_text().strip()
        and not any(f in b.window_text() for f in fixos)
        and b.rectangle().top < 220
    ]
    if not candidatos:
        raise ErroAttended("[voltar_para_empresas] botão da empresa atual não encontrado no topo da página")
    candidatos[0].click_input()
    time.sleep(2)

    try:
        win.child_window(title="Selecione a Empresa", control_type="Text").wait("exists", timeout=TIMEOUT_PADRAO_S)
    except PywinautoTimeoutError as exc:
        raise ErroAttended("[voltar_para_empresas] não confirmou volta pra tela Empresas") from exc


def abrir_livro_fiscal(win) -> None:
    """Clica em Livro Fiscal > Emitir Livro Fiscal no menu lateral -
    confirmado ao vivo."""
    item = win.child_window(title="Livro Fiscal", control_type="ListItem")
    try:
        item.wait("exists", timeout=TIMEOUT_PADRAO_S)
    except PywinautoTimeoutError as exc:
        raise ErroAttended("[menu] 'Livro Fiscal' não encontrado") from exc
    item.click_input()
    time.sleep(1)

    sub = win.child_window(title="Emitir Livro Fiscal", control_type="ListItem")
    try:
        sub.wait("exists", timeout=TIMEOUT_CURTO_S)
    except PywinautoTimeoutError as exc:
        raise ErroAttended("[menu] 'Emitir Livro Fiscal' não encontrado") from exc
    sub.click_input()
    time.sleep(1.5)


def _tela_documento(win):
    """Retorna o Document da página atual (o iframe do conteúdo) - usado
    pra restringir buscas de elemento a ele quando útil."""
    docs = win.descendants(control_type="Document")
    return docs[-1] if docs else win


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
    radio = win.child_window(title="Serviços Contratados", control_type="RadioButton")
    try:
        radio.wait("exists", timeout=TIMEOUT_CURTO_S)
        radio.click_input()
    except PywinautoTimeoutError as exc:
        raise ErroAttended("[livro_fiscal] rádio 'Serviços Contratados' não encontrado") from exc
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
    """Espera o popup do PDF abrir, maximiza e usa Ctrl+S (atalho nativo do
    visualizador de PDF do Edge) pra abrir o 'Salvar como' - evita clique
    por coordenada no ícone da toolbar (o ponto mais arriscado da versão
    anterior: uma coordenada fixa perto do canto da janela podia acertar o
    botão de FECHAR em telas com resolução diferente da usada nos testes,
    o que explicaria o navegador fechando sozinho). Digita o caminho
    completo no campo Nome do 'Salvar como' nativo do Windows e confirma.
    Confirmado ao vivo uma vez (Edge, clique por coordenada); Ctrl+S ainda
    não testado ao vivo por este script, mas é o atalho padrão do
    visualizador de PDF do Edge."""
    import pyautogui

    d = Desktop(backend="uia")
    popup = None
    for _ in range(20):
        try:
            popup = d.window(title_re=r".*ReportManager.*")
            popup.wait("exists", timeout=1)
            break
        except PywinautoTimeoutError:
            time.sleep(0.5)
    if popup is None:
        raise ErroAttended("[salvar_pdf] popup do PDF (ReportManager) não abriu a tempo")

    popup.maximize()
    time.sleep(2)
    popup.set_focus()
    time.sleep(0.3)

    pyautogui.hotkey("ctrl", "s")
    time.sleep(2)

    caminho_destino.parent.mkdir(parents=True, exist_ok=True)
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.2)
    pyautogui.typewrite(str(caminho_destino), interval=0.01)
    time.sleep(0.3)
    pyautogui.press("enter")
    time.sleep(2)

    popup.close()
    time.sleep(1)

    if not caminho_destino.exists():
        raise ErroAttended(f"[salvar_pdf] arquivo não apareceu em {caminho_destino} após salvar")


def tem_movimento(caminho_pdf: Path) -> bool:
    """Confirmado ao vivo: PDF sem movimento tem a frase exata 'não teve
    movimento econômico tributável' na página 2. Ausência dessa frase =
    tem movimento (heurística por exclusão - nunca vi o caso positivo de
    verdade ainda, validar quando aparecer uma empresa com movimento)."""
    import pdfplumber
    with pdfplumber.open(caminho_pdf) as pdf:
        texto = "\n".join(pagina.extract_text() or "" for pagina in pdf.pages)
    return not _RE_SEM_MOVIMENTO.search(texto)


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

    pasta_empresa = pasta_raiz / codigo / competencia_pasta
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
        # TODO (não testado ao vivo): exportar_xml_competencia ainda não
        # foi escrita pra este mecanismo - ver rpa/issnet/portal.py (versão
        # Playwright) pra referência do fluxo (Nota Eletrônica > Consultar
        # Nota Eletrônica > Filtros Adicionais > Data Competência > botão
        # "Exportar todas as notas em XML" no canto da grade).
        return {"movimento": "DMS com movimento — XML ainda não implementado neste mecanismo", "arquivos": arquivos}

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


def processar_planilha(caminho_planilha: Path, pasta_raiz: Path) -> None:
    """Loop completo: lê a planilha (mesmo leiaute/validação do Hub web -
    rpa.issnet.planilha), processa cada empresa (seleciona, gera DMS,
    salva, REST se sem movimento), fecha e volta pra Empresas antes da
    próxima. Erro numa empresa não aborta as outras - mesma filosofia do
    worker Playwright: continua a partir da próxima."""
    from rpa.issnet import planilha as planilha_mod
    from rpa.issnet.competencia import calcular_competencia_anterior

    empresas = planilha_mod.ler_empresas(caminho_planilha.read_bytes())
    comp = calcular_competencia_anterior()
    competencia_pasta = comp["mm_aaaa_arquivo"].replace(" ", "")  # "MMAAAA"

    win = conectar_janela()
    print(f"Janela conectada: {win.window_text()}")
    print(f"Competência: {comp['mm_aaaa']} ({len(empresas)} empresa(s) na planilha)")

    resultados = []
    for empresa in empresas:
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
# Sincronização com o Hub (banco de produção) - licença + status/arquivos
# ---------------------------------------------------------------------------

def _abrir_tunel_ssh(chave: Path, vps_host: str, porta_local: int) -> "subprocess.Popen":
    """Abre um túnel SSH (-N, sem shell remoto) até o Postgres do VPS -
    dura só enquanto este processo Python roda, fecha sozinho no fim (não
    é serviço persistente, é sob demanda - diferente da tentativa anterior
    de worker sempre ligado, que foi abandonada)."""
    import subprocess
    processo = subprocess.Popen(
        ["ssh", "-i", str(chave), "-L", f"{porta_local}:127.0.0.1:5432",
         "-o", "StrictHostKeyChecking=accept-new", "-N", f"root@{vps_host}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(3)
    if processo.poll() is not None:
        raise ErroAttended("[banco] túnel SSH caiu logo de cara - confira a chave/conexão com o VPS")
    return processo


def _ler_env(caminho: Path) -> dict:
    valores = {}
    for linha in caminho.read_text(encoding="utf-8-sig").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, _, valor = linha.partition("=")
        valores[chave.strip()] = valor.strip()
    return valores


def conectar_banco():
    """Prepara DATABASE_URL/RPA_ENC_KEY e abre o túnel SSH - precisa de
    attended_worker/prod.env (RPA_ENC_KEY e POSTGRES_PASSWORD) e da chave
    em ../.deploy_keys/homehost_deploy (mesmo par usado pelo deploy) - ver
    LEIA-ME.txt. Retorna o processo do túnel (mantenha uma referência viva
    até terminar de usar o banco, senão ele é encerrado)."""
    import os

    raiz = Path(__file__).resolve().parent.parent
    env_path = Path(__file__).resolve().parent / "prod.env"
    chave = raiz / ".deploy_keys" / "homehost_deploy"
    if not env_path.exists():
        raise ErroAttended(
            f"[banco] falta {env_path} com RPA_ENC_KEY e POSTGRES_PASSWORD de produção - ver LEIA-ME.txt"
        )
    if not chave.exists():
        raise ErroAttended(f"[banco] falta a chave SSH em {chave}")

    valores = _ler_env(env_path)
    for obrigatoria in ("RPA_ENC_KEY", "POSTGRES_PASSWORD"):
        if not valores.get(obrigatoria):
            raise ErroAttended(f"[banco] falta '{obrigatoria}' em {env_path}")

    porta_local = 5433
    tunel = _abrir_tunel_ssh(chave, "192.96.217.88", porta_local)

    os.environ["RPA_ENC_KEY"] = valores["RPA_ENC_KEY"]
    os.environ["DATABASE_URL"] = (
        f"postgresql://conciliacao:{valores['POSTGRES_PASSWORD']}@localhost:{porta_local}/conciliacao"
    )
    return tunel


def verificar_licenca(escritorio_id: str) -> None:
    """Confere a licença de uso (super_admin_global pode bloquear a
    qualquer momento em Gerenciar Escritórios) - levanta ErroAttended e
    para tudo se estiver desligada."""
    import auth
    escritorios = auth.carregar_escritorios()
    dados = escritorios.get(escritorio_id)
    if dados is None:
        raise ErroAttended(f"[licença] escritório '{escritorio_id}' não encontrado")
    if not dados.get("issnet_attended_liberado", True):
        raise ErroAttended(
            f"[licença] uso do script attended está BLOQUEADO pelo administrador pra "
            f"'{escritorio_id}' - fale com o super admin do Hub"
        )


def processar_execucao_hub(escritorio_id: str, pasta_raiz: Path) -> None:
    """Versão sincronizada com o Hub: em vez de ler uma planilha local,
    pega a execução PENDENTE mais recente do módulo issnet_rest_dms criada
    na tela do Hub (upload de planilha lá, mesmo fluxo de sempre) e
    devolve o resultado pro banco - status por empresa e os PDFs, pra
    aparecerem como botão de download na tela do Hub, igual um módulo
    totalmente automatizado. Confere a licença antes de processar
    qualquer coisa."""
    from rpa import core as rpa_core
    from rpa.issnet.competencia import calcular_competencia_anterior

    tunel = conectar_banco()
    try:
        verificar_licenca(escritorio_id)

        execucoes = rpa_core.listar_execucoes(escritorio_id, "issnet_rest_dms")
        execucao = next((e for e in execucoes if e["status"] == rpa_core.STATUS_PENDENTE), None)
        if execucao is None:
            print("Nenhuma execução PENDENTE encontrada pra este escritório - envie a planilha no Hub primeiro.")
            return

        empresas = rpa_core.listar_empresas_pendentes(execucao["id"])
        if not empresas:
            print(f"Execução #{execucao['id']} não tem empresa pendente.")
            return

        comp = calcular_competencia_anterior()
        competencia_pasta = comp["mm_aaaa_arquivo"].replace(" ", "")

        win = conectar_janela()
        print(f"Janela conectada: {win.window_text()}")
        print(f"Execução #{execucao['id']} — competência {comp['mm_aaaa']} — {len(empresas)} empresa(s) pendente(s)")

        alguma_concluida = False
        for empresa in empresas:
            codigo, cnpj = empresa["codigo"], empresa["cnpj_cpf"]
            print(f"\n=== Empresa {codigo} ({cnpj}) ===")
            rpa_core.marcar_empresa_status(empresa["id"], rpa_core.STATUS_RODANDO)
            try:
                resultado = processar_empresa(
                    win, pasta_raiz, codigo, cnpj,
                    comp["data_inicial"], comp["data_final"],
                    competencia_pasta, comp["mm_aaaa_arquivo"],
                )
                pdf_bytes = resultado["arquivos"][-1].read_bytes() if resultado["arquivos"] else None
                pdf_nome = resultado["arquivos"][-1].name if resultado["arquivos"] else ""
                rpa_core.atualizar_empresa(
                    empresa["id"], status=rpa_core.STATUS_CONCLUIDO,
                    movimento=resultado["movimento"], pdf=pdf_bytes, pdf_nome=pdf_nome,
                )
                print(f"  OK — {resultado['movimento']} (sincronizado com o Hub)")
                alguma_concluida = True
            except Exception as exc:
                print(f"  ERRO — {exc}")
                rpa_core.atualizar_empresa(empresa["id"], status=rpa_core.STATUS_ERRO, erro=str(exc))

            try:
                voltar_para_empresas(win)
            except Exception as exc:
                print(f"  AVISO: não confirmou volta pra Empresas ({exc}) — tentando seguir mesmo assim")

        status_final = rpa_core.STATUS_CONCLUIDO if alguma_concluida else rpa_core.STATUS_ERRO
        rpa_core.marcar_execucao_concluida(execucao["id"], comp["mm_aaaa"], status_final)
        print(f"\nExecução #{execucao['id']} finalizada ({status_final}) e sincronizada com o Hub.")
    finally:
        tunel.terminate()


def main_cli() -> None:
    """Modo linha de comando (sem interface gráfica) - usado por gui.py
    quando roda com argumentos reconhecidos, e também disponível chamando
    este arquivo direto (uso avançado/automação/debug)."""
    if len(sys.argv) > 2 and sys.argv[1] == "processar-hub":
        processar_execucao_hub(sys.argv[2], Path(sys.argv[3] if len(sys.argv) > 3 else r"C:\Prefeituras"))
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

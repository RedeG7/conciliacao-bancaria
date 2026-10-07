#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RPA NF GO no PC do escritório (ATTENDED) - download dos XMLs de NF-e
(Entrada e Saída) da SEFAZ-GO, empresa por empresa, a partir da execução
criada no Hub.

Por que no PC e não no servidor: o formulário "Consulta de Notas
Recebidas" tem a verificação da Cloudflare, que no Chrome/Edge do
escritório passa sozinha ("Sucesso!") e no navegador do servidor pede
"Verify you are human" - testado: nem o clique de uma pessoa repassado
pela tela do Hub liberou.

Mesmo modelo do programa do ISS Net (issnet_attended.py): a PESSOA abre o
Edge pelo programa e faz o caminho até o formulário (certificado do
escritório > Acesso Restrito > Baixar XML NFE > nova autenticação com CPF
e senha). Daí em diante o programa só mecaniza os cliques DENTRO dessa
mesma janela, via Windows UI Automation (pywinauto "uia") - não usa
Playwright/CDP nem nenhum protocolo de automação de navegador. A senha da
SEFAZ nunca passa pelo programa. Se a verificação da Cloudflare pedir
clique, quem está no PC clica; o programa só espera.

Por consulta (empresa x Entrada/Saída), seguindo o roteiro do escritório:
  Período (1º ao último dia da competência da execução) > Inscrição
  Estadual > Tipo de notas > Pesquisar > lê o total de notas + print >
  Baixar todos os arquivos > Baixar documentos e eventos > Baixar >
  (o portal enfileira; quando aparece "Baixar XML" no topo, clica) >
  arquivo da pasta Downloads vira ENTRADA_MMAAAA.zip / SAIDA_MMAAAA.zip em
  <pasta>/RPA NF GO/<código - empresa>/<MMAAAA>/ENTRADA|SAIDA/ > Nova
  consulta.

AINDA NÃO TESTADO AO VIVO (escrito a partir dos prints do escritório e dos
padrões já confirmados no ISS Net). Os nomes de botões vieram dos prints;
a árvore de acessibilidade real pode trazer variações - o log da janela
mostra o passo exato onde parar.
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
import time
from pathlib import Path

from pywinauto import Desktop

sys.path.insert(0, str(Path(__file__).resolve().parent))  # hub_api
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # rpa.sefazgo_nfe.arquivos (regras puras)

import hub_api  # noqa: E402
from rpa.sefazgo_nfe import arquivos  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MODULO = "sefazgo_nfe"
URL_ACESSO_RESTRITO = "https://www.sefaz.go.gov.br/netaccess/000System/acessoRestrito/"

TIMEOUT_PADRAO_S = 20
TIMEOUT_PESQUISA_S = 120
TIMEOUT_FILA_DOWNLOAD_S = 15 * 60   # o portal enfileira o pacote ("pode demorar alguns minutos")
TIMEOUT_VERIFICACAO_S = 5 * 60      # tempo pra pessoa clicar na verificação, se ela pedir

TEXTOS_TIPO = {"ENTRADA": ["Entrada"], "SAIDA": ["Saída", "Saida"]}


class ErroAttended(Exception):
    """Falha numa consulta - marca só ela e segue pra próxima."""


class ErroFatal(ErroAttended):
    """Falha que impede continuar o lote (janela/sessão perdida): o programa
    para e o restante volta pro Hub como erro (aparece o Reprocessar)."""


# ---------------------------------------------------------------------------
# Janela e elementos (UI Automation)
# ---------------------------------------------------------------------------

_TITULO_JANELA = r".*(Secretaria de Estado|Economia|Nota Fiscal Eletr|SEFAZ|Portal de Aplica|Acesso Restrito).*Edge.*"


def abrir_portal() -> None:
    """Abre o Edge com acessibilidade ligada (sem isso o conteúdo da página
    não aparece pra UI Automation) direto no Acesso Restrito."""
    subprocess.Popen(["cmd", "/c", "start", "msedge", "--force-renderer-accessibility", URL_ACESSO_RESTRITO])


def _janela_portal():
    """Janela do Edge no portal, ou None (sem erro)."""
    try:
        candidatas = Desktop(backend="uia").windows(title_re=_TITULO_JANELA)
    except Exception:
        return None
    return candidatas[0] if candidatas else None


def conectar_janela():
    """Janela do Edge no portal. Sempre chame de novo depois de navegar - o
    pywinauto re-resolve pelo título (mesma lição do ISS Net)."""
    win = _janela_portal()
    if win is None:
        raise ErroFatal(
            "Não achei a janela do Edge no portal da SEFAZ. Abra pelo botão 'Abrir portal no Edge', "
            "faça o login e deixe aberta a tela 'Consulta de Notas Recebidas'."
        )
    try:
        win.set_focus()
        win.maximize()
    except Exception:
        pass
    time.sleep(0.3)
    return win


def _texto(el) -> str:
    try:
        return (el.window_text() or "").strip()
    except Exception:
        return ""


def _descendentes(win, tipo: str) -> list:
    try:
        return win.descendants(control_type=tipo)
    except Exception:
        return []


def _todos_os_textos(win) -> str:
    partes = [_texto(t) for t in _descendentes(win, "Text")]
    return "\n".join(p for p in partes if p)


def _achar(win, textos: list[str], tipos=("Button", "Hyperlink", "ListItem", "Text"), exato=False):
    """Primeiro elemento cujo texto bate (sem acento/caixa). Pula itens do
    menu lateral do Acesso Restrito ("::" na frente) - ver ISS Net: o menu
    lateral tem itens com o mesmo texto, cobertos por outros elementos."""
    alvos = [t.lower() for t in textos]
    for tipo in tipos:
        for el in _descendentes(win, tipo):
            nome = _texto(el)
            if not nome or nome.startswith("::"):
                continue
            n = nome.lower()
            if any((n == a) if exato else (a in n) for a in alvos):
                return el
    return None


def _acionar(el) -> None:
    """invoke() (ação do controle pela API de acessibilidade, sem depender
    de coordenada/scroll/foco) - lição do ISS Net; clique só como reserva."""
    try:
        el.invoke()
    except Exception:
        try:
            el.select()
        except Exception:
            el.click_input()


def _esperar(condicao, timeout: float, intervalo: float = 0.5):
    prazo = time.time() + timeout
    while time.time() < prazo:
        resultado = condicao()
        if resultado:
            return resultado
        time.sleep(intervalo)
    return None


def _edits_abaixo_do_rotulo(win, padrao: str) -> list:
    """Campos Edit na faixa logo abaixo (ou ao lado) do texto do rótulo,
    ordenados da esquerda pra direita - o "Período" tem dois (inicial e
    final) sem rótulo próprio, e o rótulo da IE não está ligado ao campo."""
    rx = re.compile(padrao, re.I)
    rotulo = next((t for t in _descendentes(win, "Text") if rx.search(_texto(t))), None)
    if rotulo is None:
        return []
    r = rotulo.rectangle()
    campos = []
    for e in _descendentes(win, "Edit"):
        try:
            re_ = e.rectangle()
        except Exception:
            continue
        if -10 <= re_.top - r.top <= 70 and re_.right > r.left - 20:
            campos.append(e)
    campos.sort(key=lambda e: (e.rectangle().top, e.rectangle().left))
    return campos


def _valor(edit) -> str:
    try:
        return edit.get_value() or ""
    except Exception:
        try:
            return edit.window_text() or ""
        except Exception:
            return ""


def _preencher(edit, valor: str) -> None:
    """Digita e confere; se o campo recusar a digitação (calendário/máscara),
    tenta só os dígitos e por fim põe o valor pela API de acessibilidade."""
    digitos = re.sub(r"\D", "", valor)

    def ok() -> bool:
        return re.sub(r"\D", "", _valor(edit)) == digitos

    for texto in (valor, digitos):
        try:
            edit.click_input()
            time.sleep(0.2)
            edit.type_keys("^a{DELETE}", pause=0.02)
            edit.type_keys(texto, with_spaces=True, pause=0.03)
            time.sleep(0.3)
        except Exception:
            pass
        if ok():
            return
    try:
        edit.set_edit_text(valor)
    except Exception:
        pass
    if not ok():
        raise ErroAttended(f"[preencher] o campo não aceitou '{valor}' (ficou '{_valor(edit)}')")


# ---------------------------------------------------------------------------
# Formulário "Consulta de Notas Recebidas"
# ---------------------------------------------------------------------------

def no_formulario(win) -> bool:
    textos = _todos_os_textos(win)
    return "Inscrição Estadual" in textos and ("Tipo de notas" in textos or "Consulta de Notas" in textos)


def garantir_formulario(win, timeout: float = TIMEOUT_PADRAO_S):
    """Volta pro formulário (Nova consulta) se estiver no resultado; se não
    achar em lugar nenhum, a sessão provavelmente caiu - fatal."""
    if no_formulario(win):
        return win
    botao = _achar(win, ["Nova consulta", "Nova Consulta", "Nova pesquisa"])
    if botao is not None:
        _acionar(botao)
    win2 = _esperar(lambda: (lambda w: w if no_formulario(w) else None)(conectar_janela()), timeout, 1)
    if win2 is None:
        raise ErroFatal(
            "A tela 'Consulta de Notas Recebidas' não está aberta no Edge (sessão expirada?). Faça o "
            "caminho de novo até ela (Acesso Restrito > Baixar XML NFE) e clique em Iniciar."
        )
    return win2


TIMEOUT_CHEGAR_FORMULARIO_S = 15 * 60  # tempo pra pessoa logar (certificado/nova autenticação)
_PASSOS_ATE_FORMULARIO = [
    # (textos do botão/link, rótulo pro log) - clicados sozinhos quando
    # aparecem; login com certificado e nova autenticação ficam com a pessoa
    (["Baixar XML NFE", "Baixar XML NF-e"], "Baixar XML NFE"),
    (["Acesso Restrito"], "Acesso Restrito"),
]


def preparar_portal(log=print, deve_parar=None):
    """Garante o Edge na tela "Consulta de Notas Recebidas" antes do lote.

    - Edge não aberto no portal -> abre sozinho (Acesso Restrito).
    - Enquanto não chega no formulário, clica sozinho no que reconhece
      (card "Acesso Restrito", "Baixar XML NFE") e espera a pessoa fazer o
      que é dela (escolher o certificado, nova autenticação, verificação).
    - Chegou no formulário -> devolve a janela e o lote começa sem precisar
      clicar em Iniciar de novo."""
    win = _janela_portal()
    if win is None:
        log("Edge não estava aberto no portal da SEFAZ — abrindo agora...")
        abrir_portal()
        win = _esperar(_janela_portal, 60, 1)
        if win is None:
            raise ErroFatal("Abri o Edge, mas não achei a janela do portal da SEFAZ. Confira se o Edge abriu e clique em Iniciar de novo.")
    else:
        win = conectar_janela()
    if no_formulario(win):
        return win

    log("Aguardando chegar na tela 'Consulta de Notas Recebidas'.\n"
        "  Se pedir, escolha o certificado do escritório e faça a nova autenticação na janela do Edge —\n"
        "  o programa clica sozinho em 'Acesso Restrito' e 'Baixar XML NFE' e começa quando a tela abrir.")
    ultimo_clique: dict = {}
    prazo = time.time() + TIMEOUT_CHEGAR_FORMULARIO_S
    while time.time() < prazo:
        if deve_parar and deve_parar():
            raise ErroAttended("Parado antes de começar.")
        win = _janela_portal()
        if win is not None:
            if no_formulario(win):
                log("✔ Tela 'Consulta de Notas Recebidas' aberta — começando.")
                return conectar_janela()
            pagina = _todos_os_textos(win).lower()
            # tela de login/nova autenticação/certificado é da pessoa: não
            # clica em nada (um "Acesso Restrito" no cabeçalho a tiraria dali)
            if any(t in pagina for t in ("nova autentica", "autenticar", "selecione um certificado", "verify you are human")):
                time.sleep(2)
                continue
            for textos, rotulo in _PASSOS_ATE_FORMULARIO:
                el = _achar(win, textos, tipos=("Hyperlink", "Button", "ListItem"))
                # não repete o mesmo clique antes de a página ter tempo de abrir
                if el is not None and time.time() - ultimo_clique.get(rotulo, 0) > 10:
                    try:
                        _acionar(el)
                        ultimo_clique[rotulo] = time.time()
                        log(f"  → cliquei em '{rotulo}'")
                    except Exception:
                        pass
                    break
        time.sleep(2)
    raise ErroFatal("Passaram 15 minutos sem chegar na tela 'Consulta de Notas Recebidas'. Clique em Iniciar de novo quando ela estiver aberta.")


def _aguardar_verificacao(win, log) -> None:
    """Verificação da Cloudflare: no Edge do escritório passa sozinha. Se
    pedir clique, AVISA e espera a pessoa clicar - o programa nunca clica
    nela."""
    def estado():
        textos = _todos_os_textos(conectar_janela()).lower()
        if "sucesso" in textos or "success" in textos:
            return "ok"
        if "verify you are human" in textos or "verifique se você é humano" in textos or "confirme que" in textos:
            return "pede"
        return None

    situacao = _esperar(estado, 20, 1)
    if situacao in ("ok", None):
        return  # passou, ou o quadro não aparece na árvore de acessibilidade (segue; o Pesquisar dirá)
    log("  ⚠️  A Cloudflare pediu confirmação: clique em 'Verify you are human' na janela do Edge.")
    if _esperar(lambda: estado() == "ok", TIMEOUT_VERIFICACAO_S, 2) is None:
        raise ErroAttended("[consulta] ninguém confirmou a verificação da Cloudflare a tempo")


def pesquisar(win, data_inicial: str, data_final: str, ie: str, tipo: str, log):
    periodo = _edits_abaixo_do_rotulo(win, r"^\s*Per[ií]odo")
    if len(periodo) < 2:
        raise ErroAttended("[consulta] campos do Período (data inicial/final) não encontrados")
    _preencher(periodo[0], data_inicial)
    win.type_keys("{ESC}")  # fecha o calendário, que cobre o campo da IE
    _preencher(periodo[1], data_final)
    win.type_keys("{ESC}")

    campos_ie = _edits_abaixo_do_rotulo(win, r"^\s*Inscri[çc][ãa]o\s+Estadual")
    if not campos_ie:
        raise ErroAttended("[consulta] campo Inscrição Estadual não encontrado")
    _preencher(campos_ie[0], ie)

    radio = _achar(win, TEXTOS_TIPO[tipo], tipos=("RadioButton",), exato=True)
    if radio is None:
        raise ErroAttended(f"[consulta] opção '{TEXTOS_TIPO[tipo][0]}' (Tipo de notas) não encontrada")
    _acionar(radio)
    # "Modelo da NF-e" já vem "Todos" (prints do escritório) - não mexe

    # confere as datas de novo (a página pode apagar ao perder o foco)
    for campo, valor in ((periodo[0], data_inicial), (periodo[1], data_final)):
        if re.sub(r"\D", "", _valor(campo)) != re.sub(r"\D", "", valor):
            _preencher(campo, valor)
            win.type_keys("{ESC}")

    _aguardar_verificacao(win, log)

    botao = _achar(conectar_janela(), ["Pesquisar", "Consultar"], tipos=("Button",))
    if botao is None:
        raise ErroAttended("[consulta] botão 'Pesquisar' não encontrado")
    _acionar(botao)

    def resultado():
        w = conectar_janela()
        textos = _todos_os_textos(w)
        if _achar(w, ["Baixar todos"]) is not None or arquivos.sem_resultado(textos):
            return w
        return None

    win = _esperar(resultado, TIMEOUT_PESQUISA_S, 1.5)
    if win is None:
        raise ErroAttended("[consulta] o resultado da pesquisa não apareceu a tempo")
    return win


def print_da_janela(win) -> bytes:
    imagem = win.capture_as_image()
    buffer = io.BytesIO()
    imagem.save(buffer, format="PNG")
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Download (fila do portal + pasta Downloads)
# ---------------------------------------------------------------------------

def _novo_arquivo_downloads(pasta: Path, referencia: float):
    """Arquivo .zip/.xml novo (mtime >= referencia) com tamanho estável."""
    candidatos = []
    for padrao in ("*.zip", "*.xml"):
        try:
            candidatos += [p for p in pasta.glob(padrao) if p.stat().st_mtime >= referencia]
        except OSError:
            continue
    if not candidatos:
        return None
    candidato = max(candidatos, key=lambda p: p.stat().st_mtime)
    try:
        t1 = candidato.stat().st_size
        time.sleep(1.5)
        t2 = candidato.stat().st_size
    except OSError:
        return None
    return candidato if t1 > 0 and t1 == t2 else None


def baixar_todos(win, log) -> Path:
    """Baixar todos os arquivos > Baixar documentos e eventos > Baixar; o
    portal enfileira o pacote e mostra "Baixar XML" no topo quando fica
    pronto (roteiro do escritório). Devolve o arquivo baixado (Downloads)."""
    pasta_downloads = Path.home() / "Downloads"
    referencia = time.time()

    botao = _achar(win, ["Baixar todos os arquivos", "Baixar todos"])
    if botao is None:
        raise ErroAttended("[download] 'Baixar todos os arquivos' não encontrado")
    _acionar(botao)
    time.sleep(2)

    win = conectar_janela()
    opcao = _achar(win, ["Baixar documentos e eventos", "Documentos e eventos"], tipos=("RadioButton", "Text", "ListItem"))
    if opcao is not None:
        _acionar(opcao)
        time.sleep(0.5)
    baixar = _achar(win, ["Baixar"], tipos=("Button",), exato=True)
    if baixar is None:
        raise ErroAttended("[download] botão 'Baixar' (documentos e eventos) não encontrado")
    _acionar(baixar)
    log("  Pedido de download enviado — o portal processa na fila (pode levar alguns minutos)...")

    prazo = time.time() + TIMEOUT_FILA_DOWNLOAD_S
    clicou_link = False
    while time.time() < prazo:
        arquivo = _novo_arquivo_downloads(pasta_downloads, referencia)
        if arquivo is not None:
            win = conectar_janela()
            try:
                win.type_keys("{ESC}")  # fecha o painel de Downloads do Edge (lição do ISS Net)
            except Exception:
                pass
            return arquivo
        w = conectar_janela()
        # prompt "Salvar" do Edge (só aparece se a opção "perguntar onde
        # salvar" estiver ligada) - aceita o download direto
        salvar = _achar(w, ["Salvar"], tipos=("Button",), exato=True)
        if salvar is not None:
            _acionar(salvar)
        if not clicou_link:
            link = next(
                (el for tipo in ("Hyperlink", "Button")
                 for el in _descendentes(w, tipo)
                 if "baixar xml" in _texto(el).lower() and "nfe" not in _texto(el).lower()
                 and not _texto(el).startswith("::")),
                None,
            )
            if link is not None:
                _acionar(link)
                clicou_link = True
                log("  Pacote pronto no portal — baixando...")
        time.sleep(3)
    raise ErroAttended(f"[download] o arquivo não chegou na pasta {pasta_downloads} em {TIMEOUT_FILA_DOWNLOAD_S // 60} min")


# ---------------------------------------------------------------------------
# Uma consulta (empresa x tipo)
# ---------------------------------------------------------------------------

def processar_consulta(empresa: dict, competencia: dict, pasta_raiz: Path, log) -> dict:
    tipo = (empresa.get("obrigacao") or "").upper()
    if tipo not in TEXTOS_TIPO:
        raise ErroAttended(f"[fila] tipo de nota inválido: '{tipo}'")
    ie = empresa.get("inscricao_estadual") or ""
    if not ie:
        raise ErroAttended("[fila] empresa sem Inscrição Estadual na planilha")

    mm_aaaa = competencia["mm_aaaa"]
    pasta = pasta_raiz.joinpath(*arquivos.pasta_relativa(
        empresa["codigo"], empresa.get("razao_social") or "", mm_aaaa, tipo,
    ).split("/"))
    pasta.mkdir(parents=True, exist_ok=True)

    win = garantir_formulario(conectar_janela())
    win = pesquisar(win, competencia["data_inicial"], competencia["data_final"], ie, tipo, log)

    textos = _todos_os_textos(win)
    print_png = print_da_janela(win)
    (pasta / arquivos.nome_evidencia(tipo, mm_aaaa)).write_bytes(print_png)
    qtd_portal = arquivos.extrair_quantidade(textos)

    if arquivos.sem_resultado(textos) and not qtd_portal:
        return {"status": "CONCLUIDO", "movimento": "Sem movimento", "qtd_notas_portal": 0, "qtd_xml": 0,
                "evidencia_png": print_png, "zip_path": None, "observacao": "", "erro": ""}

    baixado = baixar_todos(win, log)
    try:
        zip_bytes = arquivos.padronizar_download(baixado.read_bytes(), baixado.name)
        contagem = arquivos.contar_xmls(zip_bytes)
    except arquivos.ArquivoInvalido as exc:
        raise ErroAttended(f"[download] {exc}") from exc

    destino = pasta / arquivos.nome_zip(tipo, mm_aaaa)
    destino.write_bytes(zip_bytes)
    try:
        baixado.unlink()
    except OSError:
        pass

    situacao, observacao = arquivos.conferir(qtd_portal, contagem)
    if contagem["eventos"]:
        observacao = (observacao + " " if observacao else "") + f"(+ {contagem['eventos']} XML(s) de evento)"
    return {
        "status": "ERRO" if situacao == "INCOMPLETO" else "CONCLUIDO",
        "movimento": "Com movimento",
        "qtd_notas_portal": qtd_portal,
        "qtd_xml": contagem["notas"],
        "evidencia_png": print_png,
        "zip_path": destino,
        "observacao": observacao,
        "erro": observacao if situacao == "INCOMPLETO" else "",
    }


def _competencia(mm_aaaa: str) -> dict:
    """Competência da execução (MM/AAAA); vazia = mês anterior ao de hoje
    (mesma regra do servidor: rodando em 10/2026, busca 09/2026)."""
    import calendar
    import datetime as _dt
    if not (mm_aaaa or "").strip():
        hoje = _dt.date.today()
        mes, ano = (hoje.month - 1, hoje.year) if hoje.month > 1 else (12, hoje.year - 1)
        mm_aaaa = f"{mes:02d}/{ano}"
    mes, ano = (int(x) for x in mm_aaaa.split("/"))
    ultimo = calendar.monthrange(ano, mes)[1]
    return {"mm_aaaa": mm_aaaa, "data_inicial": f"01/{mes:02d}/{ano}", "data_final": f"{ultimo:02d}/{mes:02d}/{ano}"}


# ---------------------------------------------------------------------------
# Lote a partir do Hub
# ---------------------------------------------------------------------------

def processar_execucao_hub(token: str, pasta_raiz: Path, deve_parar=None, log=print) -> None:
    if not hub_api.verificar_licenca(token):
        raise ErroFatal("Uso do programa bloqueado para este escritório (licença) — fale com o administrador do Hub.")

    pendente = hub_api.execucao_pendente(token, MODULO)
    execucao_id = pendente.get("execucao_id")
    if not execucao_id:
        log("Nenhuma execução do RPA NF GO na fila do Hub. Crie uma no Hub (🧾 RPA NF GO) e clique em Iniciar de novo.")
        return
    empresas = pendente.get("empresas") or []
    competencia = _competencia(pendente.get("competencia") or "")
    log(f"Execução #{execucao_id} — competência {competencia['mm_aaaa']} "
        f"({competencia['data_inicial']} a {competencia['data_final']}), {len(empresas)} consulta(s).")

    preparar_portal(log, deve_parar)  # abre o Edge se preciso e espera chegar no formulário
    hub_api.iniciar_execucao(token, execucao_id)

    alguma_ok = False
    try:
        for empresa in empresas:
            situacao = hub_api.situacao_execucao(token, execucao_id)
            if situacao.get("cancelar_solicitado"):
                hub_api.interromper_execucao(token, execucao_id, "Cancelado pelo usuário")
                log("⛔ Cancelado pelo Hub — o que faltava ficou para reprocessar.")
                return
            if deve_parar and deve_parar():
                hub_api.interromper_execucao(token, execucao_id, "Parado no programa do PC")
                log("⏹ Parado — o que faltava ficou para reprocessar no Hub.")
                return

            rotulo = f"{empresa['codigo']} - {empresa.get('razao_social') or ''} · {empresa['obrigacao'].title()}"
            log(f"\n▶ {rotulo}")
            hub_api.marcar_rodando(token, empresa["id"])
            try:
                r = processar_consulta(empresa, competencia, pasta_raiz, log)
            except ErroFatal:
                raise
            except Exception as exc:
                log(f"  ❌ {exc}")
                hub_api.erro_empresa(token, empresa["id"], str(exc))
                continue
            hub_api.concluir_consulta_nfgo(
                token, empresa["id"], status=r["status"], movimento=r["movimento"], erro=r["erro"],
                zip_path=r["zip_path"], evidencia_png=r["evidencia_png"],
                qtd_notas_portal=r["qtd_notas_portal"], qtd_xml=r["qtd_xml"], observacao=r["observacao"],
            )
            alguma_ok = alguma_ok or r["status"] == "CONCLUIDO"
            log(f"  ✅ {r['movimento']} — SEFAZ: {r['qtd_notas_portal']} · XML no ZIP: {r['qtd_xml']} {r['observacao']}")
    except ErroFatal as exc:
        hub_api.interromper_execucao(token, execucao_id, f"Interrompido: {exc}")
        raise

    hub_api.concluir_execucao(token, execucao_id, competencia["mm_aaaa"], "CONCLUIDO" if alguma_ok else "ERRO")
    log("\nExecução finalizada — confira a grade no Hub.")

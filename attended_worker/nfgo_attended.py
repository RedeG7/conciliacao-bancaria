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


class ErroParado(ErroAttended):
    """Botão Parar do programa ou Cancelar no Hub - interrompe na hora,
    inclusive no meio das esperas longas (fila de download do portal)."""


_PARADA = {"fn": None, "cancelado_hub": False}


def _definir_parada(fn) -> None:
    _PARADA.update(fn=fn, cancelado_hub=False)


def _checar_parada() -> None:
    if _PARADA["cancelado_hub"]:
        raise ErroParado("Cancelado pelo usuário no Hub")
    fn = _PARADA["fn"]
    if fn is not None and fn():
        raise ErroParado("Parado no programa do PC")


# ---------------------------------------------------------------------------
# Janela e elementos (UI Automation)
# ---------------------------------------------------------------------------

_TITULO_JANELA = r".*(Secretaria de Estado|Economia|Nota Fiscal Eletr|SEFAZ|Portal de Aplica|Acesso Restrito).*Edge.*"


def abrir_portal() -> None:
    """Abre o Edge com acessibilidade ligada (sem isso o conteúdo da página
    não aparece pra UI Automation) direto no Acesso Restrito."""
    subprocess.Popen(["cmd", "/c", "start", "msedge", "--force-renderer-accessibility", URL_ACESSO_RESTRITO],
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


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
        _checar_parada()
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


_MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
          "setembro", "outubro", "novembro", "dezembro"]
_MESES_EN = ["january", "february", "march", "april", "may", "june", "july", "august",
             "september", "october", "november", "december"]


def _mes_do_texto(texto: str):
    """'Setembro 2026' / 'set 2026' / 'September 2026' -> (9, 2026)."""
    t = texto.lower().replace("marco", "março")
    m = re.search(r"([a-zç]+)\.?\s*(?:de\s*)?(\d{4})", t)
    if not m:
        return None
    nome, ano = m.group(1), int(m.group(2))
    for lista in (_MESES, _MESES_EN):
        for i, mes in enumerate(lista):
            if len(nome) >= 3 and mes.startswith(nome[:3]):
                return i + 1, ano
    return None


def _escolher_no_calendario(win, edit, data: str, log) -> None:
    """Campo de data que não aceita digitação: abre o calendário do campo,
    navega até o mês e clica no dia. Dias repetidos na grade (fim do mês
    anterior / começo do seguinte): dia <= 15 pega o de cima, > 15 o de baixo."""
    dia, mes, ano = (int(x) for x in data.split("/"))
    try:
        edit.click_input()
    except Exception:
        edit.set_focus()
    time.sleep(0.6)
    for _ in range(36):
        w = conectar_janela()
        cab = None
        for tipo in ("Text", "Button", "Header", "HeaderItem", "Custom", "DataItem"):
            for el in _descendentes(w, tipo):
                mm = _mes_do_texto(_texto(el))
                if mm and len(_texto(el)) <= 30:
                    cab = (el, mm)
                    break
            if cab:
                break
        if cab is None:
            raise ErroAttended("[data] não achei o calendário do campo de data")
        el_cab, (m_atual, a_atual) = cab
        if (a_atual, m_atual) == (ano, mes):
            break
        voltar = (a_atual, m_atual) > (ano, mes)
        nomes = ["«", "‹", "<", "anterior", "prev", "previous", "ant"] if voltar else ["»", "›", ">", "próximo", "proximo", "next", "próx"]
        rc = el_cab.rectangle()
        botao = None
        for tipo in ("Button", "Hyperlink", "Text", "Custom", "HeaderItem", "DataItem"):
            for el in _descendentes(w, tipo):
                n = _texto(el).lower()
                if n in nomes or any(n.startswith(x) for x in nomes if len(x) > 2):
                    r = el.rectangle()
                    if abs(r.top - rc.top) <= 25:
                        botao = el
                        break
            if botao:
                break
        if botao is None:
            raise ErroAttended(f"[data] não achei a seta do calendário pra ir até {mes:02d}/{ano}")
        try:
            botao.click_input()
        except Exception:
            _acionar(botao)
        time.sleep(0.4)
    else:
        raise ErroAttended(f"[data] o calendário não chegou em {mes:02d}/{ano}")

    rc = el_cab.rectangle()
    candidatos = []
    for tipo in ("DataItem", "Button", "Text", "Hyperlink", "Custom", "ListItem"):
        for el in _descendentes(w, tipo):
            if _texto(el) != str(dia):
                continue
            try:
                r = el.rectangle()
            except Exception:
                continue
            if r.top > rc.bottom - 2 and rc.left - 200 <= r.left <= rc.right + 200 and r.top - rc.bottom < 400:
                candidatos.append(el)
        if candidatos:
            break
    if not candidatos:
        raise ErroAttended(f"[data] não achei o dia {dia} no calendário")
    candidatos.sort(key=lambda e: (e.rectangle().top, e.rectangle().left))
    alvo = candidatos[0] if dia <= 15 else candidatos[-1]
    alvo.click_input()
    time.sleep(0.4)
    log(f"  (data {data} escolhida no calendário)")


def _datas_pela_pagina(win, data_inicial: str, data_final: str, log) -> None:
    """Campos do Período são SOMENTE LEITURA com calendário (jQuery
    datepicker): não aceitam digitação - no robô do servidor só pegaram
    definindo o valor dentro da própria página. Aqui faz o mesmo pela barra
    de endereço DESTA aba (javascript: digitado - o Edge só bloqueia quando
    é colado): põe as duas datas nos 2 primeiros campos de data visíveis,
    usando a API do datepicker quando existir e disparando input/change."""
    codigo = (
        "javascript:void(function(){var a=['%s','%s'];"
        "var L=[].filter.call(document.querySelectorAll('input'),function(e){"
        "return /^[0-9]{2}.[0-9]{2}.[0-9]{4}$/.test(e.value)&&e.offsetParent!==null});"
        "var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"
        "L.slice(0,2).forEach(function(e,i){var r=e.readOnly;e.readOnly=false;"
        "try{if(window.jQuery&&jQuery(e).hasClass('hasDatepicker'))jQuery(e).datepicker('setDate',a[i])}catch(x){}"
        "s.call(e,a[i]);['input','change','keyup','blur'].forEach(function(t){"
        "e.dispatchEvent(new Event(t,{bubbles:true}))});e.readOnly=r})}())"
    ) % (data_inicial, data_final)
    try:
        win.set_focus()
        win.type_keys("^l", set_foreground=False)  # barra de endereço
        time.sleep(0.4)
        win.type_keys(_literal(codigo), with_spaces=True, pause=0.005, set_foreground=False)
        win.type_keys("{DELETE}{ENTER}", set_foreground=False)  # {DELETE}: tira o autocompletar
        time.sleep(1.2)
        log(f"  (datas {data_inicial} a {data_final} colocadas direto na página)")
    except Exception as exc:
        log(f"  ⚠️  não consegui colocar as datas pela página: {exc}")


def _preencher_data(win, edit, data: str, log) -> None:
    """Data no formato do portal (01/09/2026). Digitação primeiro (sem Esc,
    que em alguns calendários desfaz o valor; Tab confirma), depois apagando
    com Backspace, valor pela acessibilidade e, por fim, pelo calendário."""
    digitos = re.sub(r"\D", "", data)

    def ok() -> bool:
        return re.sub(r"\D", "", _valor(edit)) == digitos

    tentativas = [
        ("^a{DELETE}", data), ("^a{DELETE}", digitos),
        ("{END}" + "{BACKSPACE}" * 12, data), ("{END}" + "{BACKSPACE}" * 12, digitos),
    ]
    for limpar, texto in tentativas:
        try:
            edit.set_focus()
            time.sleep(0.2)
            edit.type_keys(limpar, pause=0.02, set_foreground=False)
            edit.type_keys(_literal(texto), pause=0.04, set_foreground=False)
            time.sleep(0.2)
            edit.type_keys("{TAB}", set_foreground=False)
            time.sleep(0.4)
        except Exception:
            pass
        if ok():
            return
    try:
        edit.set_edit_text(data)
        time.sleep(0.3)
    except Exception:
        pass
    if ok():
        return
    antes = _valor(edit)
    _escolher_no_calendario(win, edit, data, log)
    if not ok():
        raise ErroAttended(f"[data] o campo não aceitou {data} (ficou '{_valor(edit)}'; antes '{antes}')")


def _marcar_opcao(win, textos: list[str]) -> bool:
    """Radio "Entrada"/"Saída": no portal o texto fica AO LADO do botão e o
    radio não tem nome próprio (por isso "Saída não encontrada" no 1º
    teste). Tenta pelo nome; senão acha o texto e marca o radio da mesma
    linha mais perto à esquerda; por último clica no próprio texto."""
    alvos = [t.lower() for t in textos]
    for el in _descendentes(win, "RadioButton"):
        if _texto(el).lower() in alvos:
            _acionar(el)
            return True
    rotulo = next((t for t in _descendentes(win, "Text") if _texto(t).lower() in alvos), None)
    if rotulo is None:
        return False
    rr = rotulo.rectangle()
    meio = (rr.top + rr.bottom) / 2
    radios = []
    for el in _descendentes(win, "RadioButton"):
        try:
            r = el.rectangle()
        except Exception:
            continue
        if abs((r.top + r.bottom) / 2 - meio) <= 15 and r.right <= rr.left + 5:
            radios.append((rr.left - r.right, el))
    if radios:
        radio = min(radios, key=lambda x: x[0])[1]
        _acionar(radio)
        try:
            if radio.is_selected():
                return True
        except Exception:
            return True
        radio.click_input()
        return True
    rotulo.click_input()
    return True


def _opcao_marcada(win, textos: list[str]) -> bool:
    """Confere se o radio do texto ficou marcado (quando dá pra saber)."""
    alvos = [t.lower() for t in textos]
    rotulo = next((t for t in _descendentes(win, "Text") if _texto(t).lower() in alvos), None)
    for el in _descendentes(win, "RadioButton"):
        try:
            nome = _texto(el).lower()
            if nome in alvos:
                return bool(el.is_selected())
            if rotulo is not None and not nome:
                rr, r = rotulo.rectangle(), el.rectangle()
                if abs((r.top + r.bottom) / 2 - (rr.top + rr.bottom) / 2) <= 15 and 0 <= rr.left - r.right <= 40:
                    return bool(el.is_selected())
        except Exception:
            continue
    return True  # não deu pra conferir - segue


def _fechar_calendario(win) -> None:
    """Esc + clique no título do formulário (área neutra) - o calendário das
    datas cobre a IE e o Tipo de notas."""
    try:
        win.type_keys("{ESC}", set_foreground=False)
    except Exception:
        pass
    titulo = _achar(win, ["Consulta de Notas Recebidas"], tipos=("Text",))
    if titulo is not None:
        try:
            titulo.click_input()
        except Exception:
            pass
    time.sleep(0.3)


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

    # 1º foco pela acessibilidade (funciona mesmo com o calendário cobrindo
    # o campo - foi o que fez a IE ficar vazia no 1º teste), 2º clique
    for focar in ("foco", "clique"):
        for texto in (valor, digitos):
            try:
                if focar == "foco":
                    edit.set_focus()
                else:
                    edit.click_input()
                time.sleep(0.2)
                edit.type_keys("^a{DELETE}", pause=0.02, set_foreground=False)
                edit.type_keys(texto, with_spaces=True, pause=0.03, set_foreground=False)
                time.sleep(0.3)
                edit.type_keys("{ESC}", set_foreground=False)  # fecha o autocompletar do Edge
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


def garantir_formulario(win, timeout: float = TIMEOUT_PADRAO_S, log=print):
    """Volta pro formulário (Nova consulta) se estiver no resultado; se
    sumiu (sessão caiu / pediu nova autenticação), refaz o caminho com
    preparar_portal; só é fatal se nem assim voltar."""
    if no_formulario(win):
        return win
    botao = _achar(win, ["Nova consulta", "Nova Consulta", "Nova pesquisa"])
    if botao is None and _linhas_historico(win):
        # depois do download o portal fica no "Histórico de Download de XMLs"
        botao = _achar(win, ["Voltar"], tipos=("Hyperlink", "Button", "Text"), exato=True)
    if botao is not None:
        _acionar(botao)
    win2 = _esperar(lambda: (lambda w: w if no_formulario(w) else None)(conectar_janela()), timeout, 1)
    if win2 is None:
        win2 = preparar_portal(log, timeout=5 * 60)
    if win2 is None:
        raise ErroFatal(
            "A tela 'Consulta de Notas Recebidas' não está aberta no Edge (sessão expirada?). Faça o "
            "caminho de novo até ela (Acesso Restrito > Baixar XML NFE) e clique em Iniciar."
        )
    return win2


TIMEOUT_CHEGAR_FORMULARIO_S = 15 * 60  # tempo máximo até chegar no formulário
_PASSOS_ATE_FORMULARIO = [
    # (textos do botão/link, rótulo pro log) - clicados sozinhos quando aparecem
    (["Baixar XML NFE", "Baixar XML NF-e"], "Baixar XML NFE"),
    (["Acesso Restrito"], "Acesso Restrito"),
    (["Home"], "Home"),  # último recurso: volta pro menu do Acesso Restrito
]

# CPF/senha do Acesso Restrito cadastrados no Hub (tela do RPA NF GO) - só
# em memória enquanto o programa roda; usados na "nova autenticação"
_CREDENCIAL = {"cpf": "", "senha": ""}
_ULTIMA_AUTENTICACAO = {"quando": 0.0, "falhou": False}


def definir_credencial(cpf: str, senha: str) -> None:
    _CREDENCIAL.update(cpf=re.sub(r"\D", "", cpf or ""), senha=senha or "")
    _ULTIMA_AUTENTICACAO.update(quando=0.0, falhou=False)


def _literal(texto: str) -> str:
    """type_keys trata + ^ % ~ ( ) { } [ ] como comandos - escapa pra
    digitar a senha exatamente como ela é."""
    return "".join(f"{{{c}}}" if c in "+^%~(){}[]" else c for c in texto)


def _janelas_edge() -> list:
    try:
        return [w for w in Desktop(backend="uia").windows(class_name="Chrome_WidgetWin_1")
                if "edge" in (w.window_text() or "").lower()]
    except Exception:
        return []


def _confirmar_certificado(log) -> bool:
    """Janela "Selecionar um certificado" do Edge (login com certificado do
    escritório): confirma o certificado que o Edge já deixa selecionado."""
    for janela in _janelas_edge():
        try:
            candidatos = [janela] + janela.descendants(control_type="Window")
        except Exception:
            continue
        for dlg in candidatos:
            if "certificado" not in _texto(dlg).lower() and "certificate" not in _texto(dlg).lower():
                continue
            ok = _achar(dlg, ["OK"], tipos=("Button",), exato=True)
            if ok is not None:
                _acionar(ok)
                log("  → confirmei o certificado na janela do Edge")
                time.sleep(2)
                return True
    return False


def _tela_autenticacao(win, textos: str) -> bool:
    t = textos.lower()
    if "consulta de notas" in t:
        return False
    return "nova autentica" in t or (
        _achar(win, ["Autenticar"], tipos=("Button",)) is not None and len(_descendentes(win, "Edit")) >= 2
    )


def _eh_senha(edit) -> bool:
    try:
        return bool(edit.element_info.element.CurrentIsPassword)
    except Exception:
        return False


def _autenticar(win, log) -> None:
    """Tela "Este módulo requer nova autenticação com seu CPF e Senha":
    preenche com o CPF/senha cadastrados no Hub e clica em Autenticar.
    Só UMA tentativa por vez (senha errada repetida pode bloquear o
    acesso); se voltar a pedir logo em seguida, para e avisa."""
    if not _CREDENCIAL["senha"]:
        if not _ULTIMA_AUTENTICACAO["falhou"]:
            log("  ⚠️  O portal pediu CPF e senha, mas não há credencial cadastrada no Hub "
                "(RPA NF GO > Credenciais). Preencha na janela do Edge ou cadastre no Hub.")
            _ULTIMA_AUTENTICACAO["falhou"] = True
        return
    if _ULTIMA_AUTENTICACAO["falhou"]:
        return
    if time.time() - _ULTIMA_AUTENTICACAO["quando"] < 60:
        log("  ⚠️  O portal pediu a senha de novo logo depois de autenticar — confira o CPF/senha "
            "cadastrados no Hub. Não vou tentar de novo sozinho (evita bloquear o acesso).")
        _ULTIMA_AUTENTICACAO["falhou"] = True
        return
    edits = _descendentes(win, "Edit")
    senha = next((e for e in edits if _eh_senha(e)), None)
    if senha is None and len(edits) >= 2:
        senha = edits[1]
    cpf = next((e for e in edits if e is not senha), None)
    if senha is None:
        return
    if cpf is not None and not re.sub(r"\D", "", _valor(cpf)) and _CREDENCIAL["cpf"]:
        try:
            cpf.set_focus()
            cpf.type_keys(_CREDENCIAL["cpf"], pause=0.03, set_foreground=False)
        except Exception:
            pass
    try:
        senha.set_focus()
        senha.type_keys("^a{DELETE}", set_foreground=False)
        senha.type_keys(_literal(_CREDENCIAL["senha"]), with_spaces=True, pause=0.03, set_foreground=False)
    except Exception as exc:
        log(f"  ⚠️  Não consegui digitar a senha: {exc}")
        return
    botao = _achar(win, ["Autenticar"], tipos=("Button",))
    if botao is not None:
        _acionar(botao)
    else:
        senha.type_keys("{ENTER}", set_foreground=False)
    _ULTIMA_AUTENTICACAO["quando"] = time.time()
    log("  → nova autenticação feita com o CPF/senha do Hub")
    time.sleep(3)


def preparar_portal(log=print, deve_parar=None, timeout: float = TIMEOUT_CHEGAR_FORMULARIO_S):
    """Garante o Edge na tela "Consulta de Notas Recebidas".

    - Edge não aberto no portal -> abre sozinho (Acesso Restrito).
    - Janela do certificado -> confirma o certificado selecionado.
    - "Este módulo requer nova autenticação" -> CPF/senha do Hub + Autenticar.
    - Card "Acesso Restrito" / "Baixar XML NFE" -> clica.
    - "Verify you are human" -> espera a pessoa (nunca clica).
    Chegou no formulário -> devolve a janela."""
    win = _janela_portal()
    if win is not None and no_formulario(win):
        return conectar_janela()
    if win is None:
        log("Edge não estava aberto no portal da SEFAZ — abrindo agora...")
        abrir_portal()

    log("Indo até a tela 'Consulta de Notas Recebidas'...")
    ultimo_clique: dict = {}
    avisou_verificacao = False
    prazo = time.time() + timeout
    while time.time() < prazo:
        if deve_parar and deve_parar():
            raise ErroParado("Parado antes de começar.")
        _checar_parada()
        _confirmar_certificado(log)
        win = _janela_portal()
        if win is not None:
            if no_formulario(win):
                log("✔ Tela 'Consulta de Notas Recebidas' aberta — começando.")
                return conectar_janela()
            textos = _todos_os_textos(win)
            if _tela_autenticacao(win, textos):
                _autenticar(win, log)
                time.sleep(2)
                continue
            if "verify you are human" in textos.lower():
                if not avisou_verificacao:
                    log("  ⚠️  A Cloudflare pediu confirmação: clique em 'Verify you are human' no Edge.")
                    avisou_verificacao = True
                time.sleep(2)
                continue
            for textos_botao, rotulo in _PASSOS_ATE_FORMULARIO:
                el = _achar(win, textos_botao, tipos=("Hyperlink", "Button", "ListItem"))
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
    raise ErroFatal(f"Passaram {int(timeout // 60)} minutos sem chegar na tela 'Consulta de Notas Recebidas'. "
                    "Clique em Iniciar de novo quando ela estiver aberta.")


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
    campos_ie = _edits_abaixo_do_rotulo(win, r"^\s*Inscri[çc][ãa]o\s+Estadual")
    if not campos_ie:
        raise ErroAttended("[consulta] campo Inscrição Estadual não encontrado")
    campo_ie = campos_ie[0]

    # IE e Tipo ANTES das datas: o calendário das datas abre por cima deles
    _fechar_calendario(win)
    _preencher(campo_ie, ie)
    if not _marcar_opcao(win, TEXTOS_TIPO[tipo]):
        raise ErroAttended(f"[consulta] opção '{TEXTOS_TIPO[tipo][0]}' (Tipo de notas) não encontrada")
    # "Modelo da NF-e" já vem "Todos" (prints do escritório) - não mexe

    # datas: campos somente leitura com calendário -> primeiro direto na
    # página; digitação/calendário só se ainda não pegou
    _datas_pela_pagina(win, data_inicial, data_final, log)
    win = conectar_janela()
    periodo = _edits_abaixo_do_rotulo(win, r"^\s*Per[ií]odo") or periodo
    for campo, data in ((periodo[0], data_inicial), (periodo[1], data_final)):
        if re.sub(r"\D", "", _valor(campo)) != re.sub(r"\D", "", data):
            _preencher_data(win, campo, data, log)
            _fechar_calendario(win)

    # confere tudo de novo (a página pode apagar campo ao perder o foco)
    for campo, valor in ((periodo[0], data_inicial), (periodo[1], data_final), (campo_ie, ie)):
        if re.sub(r"\D", "", _valor(campo)) != re.sub(r"\D", "", valor):
            if campo is campo_ie:
                _preencher(campo, valor)
            else:
                _preencher_data(win, campo, valor, log)
            _fechar_calendario(win)
    log(f"  Período {_valor(periodo[0])} a {_valor(periodo[1])} · IE {_valor(campo_ie)} · {TEXTOS_TIPO[tipo][0]}")
    if not _opcao_marcada(win, TEXTOS_TIPO[tipo]):
        _marcar_opcao(win, TEXTOS_TIPO[tipo])

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


def arvore_da_janela(win, limite: int = 4000) -> str:
    """Lista dos elementos da janela como a automação enxerga (tipo, nome,
    id, posição) - pra ajustar o programa a partir do PC de verdade."""
    linhas = [f"janela: {_texto(win)}"]
    try:
        for i, el in enumerate(win.descendants()):
            if i >= limite:
                linhas.append(f"... (parou em {limite} elementos)")
                break
            try:
                info = el.element_info
                r = info.rectangle
                linhas.append(
                    f"{info.control_type:<12} | nome='{(info.name or '')[:120]}' | id='{info.automation_id}' "
                    f"| classe='{info.class_name}' | ({r.left},{r.top},{r.right},{r.bottom})"
                )
            except Exception:
                continue
    except Exception as exc:
        linhas.append(f"(erro lendo a árvore: {exc})")
    return "\n".join(linhas)


def print_do_erro() -> "bytes | None":
    """Print da tela no momento do erro (janela do Edge; sem ela, a tela
    inteira) - vai pra grade do Hub ("Tela do erro") e pra pasta _ERROS.
    Nunca levanta: um erro ao tirar o print não pode esconder o erro real."""
    try:
        win = _janela_portal()
        if win is not None:
            return print_da_janela(win)
    except Exception:
        pass
    try:
        from PIL import ImageGrab
        buffer = io.BytesIO()
        ImageGrab.grab(all_screens=True).save(buffer, format="PNG")
        return buffer.getvalue()
    except Exception:
        return None


def _guardar_print_erro(pasta_raiz: Path, empresa: dict, competencia: dict, png: "bytes | None", erro: str = "") -> None:
    """Print + texto do erro + árvore de elementos da janela, em
    RPA NF GO/_ERROS/<MMAAAA>/ (mesmo nome, .png e .txt)."""
    try:
        pasta = pasta_raiz / arquivos.PASTA_RAIZ / "_ERROS" / arquivos.competencia_pasta(competencia["mm_aaaa"])
        pasta.mkdir(parents=True, exist_ok=True)
        base = f"{empresa['codigo']}_{(empresa.get('obrigacao') or '').upper()}_{time.strftime('%Y%m%d_%H%M%S')}"
        if png:
            (pasta / f"{base}.png").write_bytes(png)
        win = _janela_portal()
        arvore = arvore_da_janela(win) if win is not None else "(janela do portal não encontrada)"
        (pasta / f"{base}.txt").write_text(f"ERRO: {erro}\n\n{arvore}", encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Download (fila do portal + pasta Downloads)
# ---------------------------------------------------------------------------

def _pastas_download() -> list[Path]:
    """Onde o Edge pode salvar: pasta Downloads do Windows (pode estar em
    outro disco/OneDrive), a pasta configurada no próprio Edge (Configurações
    > Downloads > Local) e a Downloads do perfil."""
    pastas = [Path.home() / "Downloads"]
    try:
        import ctypes
        from ctypes import wintypes
        import uuid
        guid = uuid.UUID("{374DE290-123F-4565-9164-39C4925E467B}")  # FOLDERID_Downloads

        class _GUID(ctypes.Structure):
            _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]
        g = _GUID(guid.fields[0], guid.fields[1], guid.fields[2], (ctypes.c_ubyte * 8)(*guid.bytes[8:]))
        caminho = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(caminho)) == 0:
            pastas.append(Path(caminho.value))
            ctypes.windll.ole32.CoTaskMemFree(caminho)
    except Exception:
        pass
    try:
        import json
        dados = Path.home() / "AppData" / "Local" / "Microsoft" / "Edge" / "User Data"
        for pref in list(dados.glob("*/Preferences")):
            try:
                d = json.loads(pref.read_text(encoding="utf-8", errors="ignore"))
                pasta = (d.get("download") or {}).get("default_directory")
                if pasta:
                    pastas.append(Path(pasta))
            except Exception:
                continue
    except Exception:
        pass
    unicas = []
    for p in pastas:
        if p.exists() and p not in unicas:
            unicas.append(p)
    return unicas or [Path.home() / "Downloads"]


def _novo_arquivo_downloads(pastas, referencia: float, nome_esperado: str = ""):
    """Arquivo .zip/.xml novo (mtime >= referencia) com tamanho estável, em
    qualquer das pastas. Com nome_esperado (o "Arquivo" da linha do
    histórico do portal), só aceita esse arquivo - o Edge pode acrescentar
    " (1)" se já existir um igual."""
    if isinstance(pastas, Path):
        pastas = [pastas]
    candidatos = []
    base = Path(nome_esperado).stem.lower() if nome_esperado else ""
    for pasta in pastas:
        for padrao in ("*.zip", "*.xml"):
            try:
                candidatos += [p for p in pasta.glob(padrao) if p.stat().st_mtime >= referencia
                               and (not base or p.stem.lower().startswith(base))]
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


def _aceitar_prompt_download(pasta_downloads: Path, log) -> None:
    """Edge configurado pra perguntar o que fazer com cada download: abre
    um balão FORA da janela do portal (gravação do escritório: janela sem
    título, botão "Salvar como" classe "saveAs"). Prefere "Salvar" (vai
    direto pra Downloads); só com "Salvar como", abre a janela de salvar e
    grava em Downloads com o nome sugerido."""
    portal = _janela_portal()
    if portal is None:
        return
    botoes = []
    try:
        pid_edge = portal.element_info.process_id
        for janela in Desktop(backend="uia").windows(process=pid_edge):
            try:
                botoes += janela.descendants(control_type="Button")
            except Exception:
                continue
    except Exception:
        return
    salvar = next((b for b in botoes if _texto(b).lower() == "salvar"), None)
    if salvar is not None:
        _acionar(salvar)
        log("  (Edge perguntou onde salvar — cliquei em Salvar)")
        return
    salvar_como = next((b for b in botoes if _texto(b).lower() == "salvar como"), None)
    if salvar_como is None:
        return
    _acionar(salvar_como)
    dialogo = _esperar(lambda: next(iter(Desktop(backend="uia").windows(title_re="Salvar como|Save as")), None), 15, 0.5)
    if dialogo is None:
        return
    try:
        nome = dialogo.child_window(control_type="Edit", found_index=0)
        sugerido = Path(nome.get_value() or "download.zip").name
        nome.set_edit_text(str(pasta_downloads / sugerido))
        nome.type_keys("{ENTER}", set_foreground=False)
        log(f"  (Edge pediu 'Salvar como' — salvei em Downloads: {sugerido})")
    except Exception as exc:
        log(f"  ⚠️  Não consegui responder a janela 'Salvar como' do Edge: {exc} — salve em Downloads.")


_RX_ARQUIVO_HISTORICO = re.compile(r"(\d+)_(\d{8})_(\d{8})_(\d+)\.zip", re.I)
_JA_BAIXADOS: set = set()   # arquivos do histórico já baixados nesta sessão (Entrada e Saída têm o mesmo prefixo)
INTERVALO_ATUALIZAR_HISTORICO_S = 20
TOLERANCIA_RELOGIO_S = 15 * 60  # diferença aceitável entre o relógio do PC e o da SEFAZ


def _linhas_historico(win) -> list[dict]:
    """Tabela "Histórico de Download de XMLs" (Situação | Arquivo | Data de
    Solicitação | Observações | Baixar XML), mais nova em cima. Monta as
    linhas pela posição na tela: o texto do arquivo
    (IE_ddmmaaaa_ddmmaaaa_N.zip) e, na mesma altura, a situação e o botão."""
    textos = []
    # "Em processamento..." vem numa barra verde (pode ser ProgressBar/Custom)
    for tipo in ("Text", "ProgressBar", "Custom", "DataItem", "Hyperlink"):
        for el in _descendentes(win, tipo):
            try:
                textos.append((_texto(el), el.rectangle()))
            except Exception:
                continue
    botoes = []
    for tipo in ("Button", "Hyperlink"):
        for el in _descendentes(win, tipo):
            if "baixar xml" in _texto(el).lower() and "nfe" not in _texto(el).lower():
                try:
                    botoes.append((el, el.rectangle()))
                except Exception:
                    continue
    linhas = []
    vistos = set()
    for texto, r in textos:
        m = _RX_ARQUIVO_HISTORICO.search(texto)
        if not m or (m.group(0).lower(), r.top // 6) in vistos:
            continue
        nome = m.group(0)
        vistos.add((nome.lower(), r.top // 6))
        meio = (r.top + r.bottom) / 2
        mesma_linha = [t for t, rt in textos if abs((rt.top + rt.bottom) / 2 - meio) <= 12]
        # Aguardando... -> Em processamento... -> Concluído (ou erro)
        situacao = next((t for t in mesma_linha if not _RX_ARQUIVO_HISTORICO.search(t)
                         and re.search(r"(?i)\b(aguardando|em processamento|processando|conclu|erro|falh|cancel)", t)), "")
        quando = None
        for t in mesma_linha:
            md = re.match(r"(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?", t)
            if md:
                d, mo, a, h, mi, se = md.groups()
                try:
                    quando = time.mktime((int(a), int(mo), int(d), int(h), int(mi), int(se or 0), 0, 0, -1))
                except (OverflowError, ValueError):
                    quando = None
                break
        botao = min(
            ((b, abs((rb.top + rb.bottom) / 2 - meio)) for b, rb in botoes),
            key=lambda x: x[1], default=(None, 999),
        )
        linhas.append({
            "arquivo": nome, "ie": m.group(1), "inicio": m.group(2), "fim": m.group(3),
            "situacao": situacao, "topo": r.top, "solicitado_em": quando,
            "botao": botao[0] if botao[1] <= 30 else None,
        })
    linhas.sort(key=lambda l: l["topo"])
    return linhas


def _abrir_historico(win, log) -> bool:
    """Botão "Histórico de Downloads de XMLs" no fim do formulário (invoke
    não precisa rolar a página)."""
    botao = _achar(win, ["Histórico de Downloads", "Historico de Downloads", "Histórico de Download",
                         "Historico de Download"], tipos=("Button", "Hyperlink"))
    if botao is None:
        return False
    _acionar(botao)
    log("  → abri o 'Histórico de Downloads de XMLs'")
    time.sleep(3)
    return True


def _voltar_ao_historico(log) -> None:
    """Saiu da tela do histórico antes de baixar (nova autenticação, outra
    página...): caminho do escritório - Baixar XML NFE > formulário >
    "Histórico de Downloads de XMLs" (no fim da página)."""
    log("  Saiu do histórico antes de baixar — voltando: Baixar XML NFE > Histórico de Downloads de XMLs...")
    win = preparar_portal(log, timeout=5 * 60)
    if not _abrir_historico(win, log):
        raise ErroAttended("[download] não achei o botão 'Histórico de Downloads de XMLs' no formulário")


def baixar_todos(win, log, ie: str, data_inicial: str, data_final: str) -> Path:
    """Baixar todos os arquivos > Baixar documentos e eventos > Baixar. O
    portal cria uma linha no "Histórico de Download de XMLs" (Aguardando...
    -> Concluído). Espera a linha DESTE pedido - a mais nova com a mesma IE e
    período, que ainda não foi baixada - ficar Concluída (atualizando a
    página) e clica no "Baixar XML" DELA (não em linhas antigas, que davam o
    arquivo errado). Confere que o arquivo baixado tem o nome da linha."""
    pastas_download = _pastas_download()
    referencia = time.time()
    so_digitos = [re.sub(r"\D", "", x) for x in (ie, data_inicial, data_final)]
    prefixo = "_".join(so_digitos).lower() + "_"

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
    log("  Pedido de download enviado — aguardando a linha deste pedido no histórico do portal...")
    time.sleep(3)

    prazo = time.time() + TIMEOUT_FILA_DOWNLOAD_S
    ultimo_refresh = time.time()
    ultima_volta = 0.0
    alvo = None
    situacao_anterior = ""
    estado_anterior = ""
    while time.time() < prazo:
        _checar_parada()
        w = conectar_janela()
        linhas = _linhas_historico(w)
        na_tela_historico = "histórico de downloads" in _todos_os_textos(w).lower()
        if not linhas and na_tela_historico:
            # está no histórico mas não leu as linhas (ainda carregando?) -
            # NÃO sai daqui; atualiza e tenta de novo
            if estado_anterior != "sem_linhas":
                log("  Histórico aberto, mas ainda sem linhas legíveis — atualizando...")
                estado_anterior = "sem_linhas"
        elif not linhas and time.time() - ultima_volta > 45:
            # fora do histórico: do formulário é só o botão; de outra tela,
            # refaz o caminho até ele (o pedido continua na fila do portal)
            ultima_volta = time.time()
            if not (no_formulario(w) and _abrir_historico(w, log)):
                _voltar_ao_historico(log)
            continue
        # a mais nova (em cima) com esta IE e período, pedida agora (não uma
        # linha antiga do mesmo período) e que ainda não baixamos
        # o ÚLTIMO pedido (maior Data de Solicitação) feito nesta rodada e
        # ainda não baixado - de preferência com a IE/período desta consulta
        def _recente(l):
            return l["arquivo"] not in _JA_BAIXADOS and (
                l["solicitado_em"] is None or l["solicitado_em"] >= referencia - TOLERANCIA_RELOGIO_S)
        por_data = sorted(linhas, key=lambda l: (l["solicitado_em"] or 0, -l["topo"]), reverse=True)
        desta = [l for l in por_data if l["arquivo"].lower().startswith(prefixo)]
        nossa = next((l for l in desta if _recente(l)), None)
        if nossa is None:
            outra = next((l for l in por_data if _recente(l)), None)
            if outra is not None and outra["solicitado_em"] is not None:
                if estado_anterior != "outra:" + outra["arquivo"]:
                    log(f"  ⚠️  O pedido mais recente no histórico é {outra['arquivo']} (esperava {prefixo}*.zip) "
                        "— baixando o último solicitado.")
                    estado_anterior = "outra:" + outra["arquivo"]
                nossa = outra
        if linhas and nossa is None:
            estado = f"{len(linhas)}|{len(desta)}|{desta[0]['arquivo'] if desta else ''}"
            if estado != estado_anterior:
                if desta:
                    topo = desta[0]
                    quando = time.strftime("%d/%m %H:%M", time.localtime(topo["solicitado_em"])) if topo["solicitado_em"] else "?"
                    log(f"  Histórico: {len(linhas)} linha(s); deste pedido ainda nenhuma nova — a mais recente "
                        f"desta IE/período é {topo['arquivo']} ({topo['situacao'] or '?'}, pedida {quando}"
                        f"{', já baixada' if topo['arquivo'] in _JA_BAIXADOS else ''}). Aguardando...")
                else:
                    log(f"  Histórico: {len(linhas)} linha(s), nenhuma com {prefixo}*.zip ainda. Aguardando...")
                estado_anterior = estado
        if nossa is not None:
            if nossa["situacao"] != situacao_anterior:
                log(f"  Histórico: {nossa['arquivo']} — {nossa['situacao'] or '?'}")
                situacao_anterior = nossa["situacao"]
            if re.search(r"(?i)\b(erro|falh|cancel)", nossa["situacao"]):
                raise ErroAttended(f"[download] o portal marcou o pedido {nossa['arquivo']} como '{nossa['situacao']}'")
            if re.search(r"(?i)\bconclu", nossa["situacao"]):
                if nossa["botao"] is None:
                    if estado_anterior != "sem_botao:" + nossa["arquivo"]:
                        log(f"  ⚠️  {nossa['arquivo']} está Concluído, mas não achei o 'Baixar XML' da linha — tentando de novo...")
                        estado_anterior = "sem_botao:" + nossa["arquivo"]
                else:
                    alvo = nossa
                    _acionar(nossa["botao"])
                    log(f"  Pacote pronto — baixando {nossa['arquivo']} (pedido de "
                        f"{time.strftime('%d/%m %H:%M:%S', time.localtime(nossa['solicitado_em'])) if nossa['solicitado_em'] else '?'})...")
                    break
        if time.time() - ultimo_refresh >= INTERVALO_ATUALIZAR_HISTORICO_S:
            try:
                w.type_keys("{F5}")  # a lista não atualiza sozinha (gravação: o escritório recarregava)
            except Exception:
                pass
            ultimo_refresh = time.time()
            time.sleep(4)
            continue
        time.sleep(3)
    if alvo is None:
        raise ErroAttended(f"[download] a linha deste pedido ({prefixo}*.zip) não ficou 'Concluído' no histórico "
                           f"em {TIMEOUT_FILA_DOWNLOAD_S // 60} min")

    prazo = time.time() + 5 * 60
    while time.time() < prazo:
        _checar_parada()
        arquivo = _novo_arquivo_downloads(pastas_download, referencia, alvo["arquivo"])
        if arquivo is not None:
            _JA_BAIXADOS.add(alvo["arquivo"])
            try:
                conectar_janela().type_keys("{ESC}")  # fecha o painel de Downloads do Edge
            except Exception:
                pass
            return arquivo
        _aceitar_prompt_download(pastas_download[0], log)
        time.sleep(2)
    raise ErroAttended(f"[download] cliquei em Baixar XML de {alvo['arquivo']}, mas o arquivo não chegou em "
                       f"{', '.join(str(p) for p in pastas_download)} — confira a pasta de downloads do Edge")


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

    win = garantir_formulario(conectar_janela(), log=log)
    win = pesquisar(win, competencia["data_inicial"], competencia["data_final"], ie, tipo, log)

    textos = _todos_os_textos(win)
    print_png = print_da_janela(win)
    (pasta / arquivos.nome_evidencia(tipo, mm_aaaa)).write_bytes(print_png)
    qtd_portal = arquivos.extrair_quantidade(textos)
    try:
        return _baixar_e_salvar(win, pasta, tipo, mm_aaaa, textos, print_png, qtd_portal, log,
                                ie, competencia["data_inicial"], competencia["data_final"])
    except Exception as exc:
        try:
            exc.parcial = {"evidencia_png": print_png, "qtd_notas_portal": qtd_portal}
        except Exception:
            pass
        raise


def _baixar_e_salvar(win, pasta: Path, tipo: str, mm_aaaa: str, textos: str, print_png: bytes, qtd_portal, log,
                     ie: str, data_inicial: str, data_final: str) -> dict:
    if arquivos.sem_resultado(textos) and not qtd_portal:
        return {"status": "CONCLUIDO", "movimento": "Sem movimento", "qtd_notas_portal": 0, "qtd_xml": 0,
                "evidencia_png": print_png, "zip_path": None, "observacao": "", "erro": ""}

    baixado = baixar_todos(win, log, ie, data_inicial, data_final)
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
# Gravação do passo a passo (diagnóstico)
# ---------------------------------------------------------------------------

def _pasta_gravacao() -> Path:
    desktop = Path.home() / "Desktop"
    base = desktop if desktop.exists() else Path.home()
    return base / f"RPA NF GO - gravacao {time.strftime('%Y-%m-%d %H-%M-%S')}"


def gravar_passo_a_passo(deve_parar, log=print) -> Path:
    """A pessoa faz o caminho no Edge do jeito dela e, a cada CLIQUE do
    mouse, o programa guarda: print da tela com uma marca vermelha onde
    clicou + o que o Windows diz que é aquele elemento (tipo, nome, id).
    É isso que mostra como os botões aparecem pra automação no PC de
    verdade - pra ajustar o programa sem adivinhar.

    Não grava teclado (senha nunca entra na gravação). Ao parar, salva
    também a árvore de elementos da janela do portal (arvore_janela.txt)
    e compacta tudo num .zip ao lado da pasta."""
    import ctypes
    import zipfile
    from PIL import ImageDraw, ImageGrab

    pasta = _pasta_gravacao()
    pasta.mkdir(parents=True, exist_ok=True)
    user32 = ctypes.windll.user32

    class _Ponto(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    def _titulo_frente() -> str:
        hwnd = user32.GetForegroundWindow()
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        return buf.value

    log(f"🎥 Gravando. Faça o passo a passo no Edge normalmente; cada clique vira um print.\n   Pasta: {pasta}")
    passos = (pasta / "passos.txt").open("w", encoding="utf-8")
    passos.write("RPA NF GO - gravação do passo a passo\n\n")
    n = 0
    apertado_antes = False
    try:
        while not deve_parar():
            apertado = bool(user32.GetAsyncKeyState(0x01) & 0x8000)  # botão esquerdo
            if apertado and not apertado_antes:
                pt = _Ponto()
                user32.GetCursorPos(ctypes.byref(pt))
                try:
                    info = Desktop(backend="uia").from_point(pt.x, pt.y).element_info
                    elemento = (f"tipo={info.control_type} | nome='{(info.name or '')[:150]}' | "
                                f"id='{info.automation_id}' | classe='{info.class_name}'")
                except Exception as exc:
                    elemento = f"(não identificado: {exc})"
                n += 1
                titulo = _titulo_frente()
                try:
                    tela = ImageGrab.grab(all_screens=True)
                    # all_screens: a origem da imagem é o canto do monitor mais à esquerda/acima
                    x0 = min(0, user32.GetSystemMetrics(76))  # SM_XVIRTUALSCREEN
                    y0 = min(0, user32.GetSystemMetrics(77))  # SM_YVIRTUALSCREEN
                    x, y = pt.x - x0, pt.y - y0
                    desenho = ImageDraw.Draw(tela)
                    for r in (18, 19, 20, 21):
                        desenho.ellipse((x - r, y - r, x + r, y + r), outline=(255, 0, 0))
                    tela.save(pasta / f"passo_{n:03d}.png")
                except Exception as exc:
                    elemento += f" | (sem print: {exc})"
                linha = f"passo {n:03d} {time.strftime('%H:%M:%S')} | janela='{titulo}' | clique em ({pt.x},{pt.y}) | {elemento}"
                passos.write(linha + "\n")
                passos.flush()
                log(f"  📸 passo {n}: {elemento[:110]}")
            apertado_antes = apertado
            time.sleep(0.03)
    finally:
        passos.close()

    try:
        win = _janela_portal()
        if win is not None:
            (pasta / "arvore_janela.txt").write_text(arvore_da_janela(win), encoding="utf-8")
    except Exception as exc:
        (pasta / "arvore_janela.txt").write_text(f"não consegui ler a árvore: {exc}", encoding="utf-8")

    arquivo_zip = pasta.with_suffix(".zip")
    with zipfile.ZipFile(arquivo_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for arq in sorted(pasta.iterdir()):
            zf.write(arq, arcname=arq.name)
    log(f"⏹ Gravação parada — {n} clique(s). Arquivos em:\n   {pasta}\n   {arquivo_zip}")
    return pasta


# ---------------------------------------------------------------------------
# Lote a partir de uma planilha local (sem Hub) - igual ao modo "Planilha
# local" do programa do ISS Net
# ---------------------------------------------------------------------------

def _gravar_resumo(pasta_raiz: Path, mm_aaaa: str, linhas: list[dict]) -> Path:
    """RPA NF GO/RESUMO_MMAAAA.xlsx - o que a grade do Hub mostraria."""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Resumo"
    colunas = ["Código", "Empresa", "CNPJ", "IE", "Competência", "Tipo", "Status", "Movimento",
               "Qtd SEFAZ", "XML no ZIP", "Observação / erro", "Arquivo", "Data/Hora"]
    ws.append(colunas)
    for l in linhas:
        ws.append([l.get(c, "") for c in colunas])
    for col, largura in zip("ABCDEFGHIJKLM", (10, 40, 20, 14, 12, 10, 12, 16, 10, 10, 60, 60, 18)):
        ws.column_dimensions[col].width = largura
    destino = pasta_raiz / arquivos.PASTA_RAIZ / f"RESUMO_{arquivos.competencia_pasta(mm_aaaa)}.xlsx"
    destino.parent.mkdir(parents=True, exist_ok=True)
    try:
        wb.save(destino)
    except PermissionError:  # resumo aberto no Excel - salva com outro nome
        destino = destino.with_name(f"{destino.stem}_{time.strftime('%H%M%S')}.xlsx")
        wb.save(destino)
    return destino


def processar_planilha(caminho_planilha: Path, pasta_raiz: Path, mm_aaaa: str = "", deve_parar=None,
                       log=print, cpf: str = "", senha: str = "") -> Path:
    """Lê a planilha (mesmas colunas do Hub: Código da Empresa, Razão
    Social, CNPJ, Inscrição Estadual), faz Entrada e Saída de cada empresa
    e grava os arquivos + RESUMO_MMAAAA.xlsx. Sem Hub: o CPF/senha da nova
    autenticação vêm da tela do programa (opcionais)."""
    from rpa.sefazgo_nfe import planilha as planilha_mod

    try:
        empresas = planilha_mod.ler_empresas(Path(caminho_planilha).read_bytes())
    except Exception as exc:
        raise ErroAttended(f"[planilha] {exc}") from exc
    if not empresas:
        raise ErroAttended("[planilha] nenhuma empresa com Inscrição Estadual na planilha")
    competencia = _competencia(mm_aaaa)
    log(f"Planilha {Path(caminho_planilha).name} — competência {competencia['mm_aaaa']} "
        f"({competencia['data_inicial']} a {competencia['data_final']}), "
        f"{len(empresas) // 2} empresa(s), {len(empresas)} consulta(s).")
    definir_credencial(cpf, senha)
    _definir_parada(deve_parar)
    linhas = []
    try:
        preparar_portal(log, deve_parar)
    except ErroParado:
        log("⏹ Parado antes de começar.")
        empresas = []

    for empresa in empresas:
        if deve_parar and deve_parar():
            log("⏹ Parado — o resumo traz o que já foi feito.")
            break
        tipo = empresa["obrigacao"]
        log(f"\n▶ {empresa['codigo']} - {empresa.get('razao_social') or ''} · {'Saída' if tipo == 'SAIDA' else 'Entrada'}")
        base = {
            "Código": empresa["codigo"], "Empresa": empresa.get("razao_social") or "",
            "CNPJ": empresa.get("cnpj_cpf") or "", "IE": empresa.get("inscricao_estadual") or "",
            "Competência": competencia["mm_aaaa"], "Tipo": "Saída" if tipo == "SAIDA" else "Entrada",
        }
        try:
            r = processar_consulta(empresa, competencia, pasta_raiz, log)
        except ErroParado:
            log("⏹ Parado — o resumo traz o que já foi feito.")
            break
        except Exception as exc:
            log(f"  ❌ {exc}")
            png = print_do_erro()
            _guardar_print_erro(pasta_raiz, empresa, competencia, png, str(exc))
            parcial = getattr(exc, "parcial", None) or {}
            linhas.append({**base, "Status": "ERRO", "Qtd SEFAZ": parcial.get("qtd_notas_portal"),
                           "Observação / erro": str(exc), "Data/Hora": time.strftime("%d/%m/%Y %H:%M")})
            if isinstance(exc, ErroFatal):
                break
            continue
        linhas.append({**base, "Status": r["status"], "Movimento": r["movimento"],
                       "Qtd SEFAZ": r["qtd_notas_portal"], "XML no ZIP": r["qtd_xml"],
                       "Observação / erro": r["erro"] or r["observacao"],
                       "Arquivo": str(r["zip_path"] or ""), "Data/Hora": time.strftime("%d/%m/%Y %H:%M")})
        log(f"  ✅ {r['movimento']} — SEFAZ: {r['qtd_notas_portal']} · XML no ZIP: {r['qtd_xml']} {r['observacao']}")

    resumo = _gravar_resumo(pasta_raiz, competencia["mm_aaaa"], linhas)
    ok = sum(1 for l in linhas if l["Status"] == "CONCLUIDO")
    log(f"\nResumo: {ok} de {len(linhas)} consulta(s) concluída(s). Planilha de resumo:\n  {resumo}")
    return resumo


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

    try:
        cred = hub_api.credencial_nfgo(token)
        definir_credencial(cred.get("cpf", ""), cred.get("senha", ""))
        if not cred.get("senha"):
            log("ℹ️  Sem CPF/senha do Acesso Restrito no Hub — se o portal pedir nova autenticação, preencha no Edge.")
    except hub_api.ErroHubApi as exc:
        log(f"⚠️  Não consegui ler o CPF/senha do Hub ({exc}) — se o portal pedir, preencha no Edge.")
    _definir_parada(deve_parar)
    try:
        preparar_portal(log, deve_parar)  # abre o Edge se preciso e vai até o formulário
    except ErroParado:
        log("⏹ Parado antes de começar — a execução continua na fila do Hub.")
        return
    hub_api.iniciar_execucao(token, execucao_id)

    # sinal de vida pro Hub a cada 30 s (as esperas do download passam de 10
    # min): sem ele a tela acharia que o programa foi fechado
    import threading
    fim_sinal = threading.Event()

    def _sinal_de_vida() -> None:
        # também é por aqui que o "Cancelar processamento" do Hub chega no
        # meio de uma espera longa (o lote confere em _checar_parada)
        while not fim_sinal.wait(20):
            try:
                sit = hub_api.situacao_execucao(token, execucao_id)
                if sit.get("cancelar_solicitado") or sit.get("status") not in (None, "RODANDO"):
                    _PARADA["cancelado_hub"] = True
            except Exception:
                pass

    threading.Thread(target=_sinal_de_vida, daemon=True).start()
    try:
        _processar_lote_hub(token, execucao_id, empresas, competencia, pasta_raiz, deve_parar, log)
    finally:
        fim_sinal.set()


def _processar_lote_hub(token, execucao_id, empresas, competencia, pasta_raiz, deve_parar, log) -> None:

    alguma_ok = False
    try:
        for empresa in empresas:
            situacao = hub_api.situacao_execucao(token, execucao_id)
            if situacao.get("status") not in (None, "RODANDO"):
                log("⛔ A execução foi cancelada/encerrada no Hub — parando.")
                return
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
            except ErroParado:
                raise
            except Exception as exc:
                log(f"  ❌ {exc}")
                png = print_do_erro()
                _guardar_print_erro(pasta_raiz, empresa, competencia, png, str(exc))
                parcial = getattr(exc, "parcial", None) or {}
                hub_api.erro_empresa(
                    token, empresa["id"], str(exc) or type(exc).__name__, screenshot_png=png,
                    evidencia_png=parcial.get("evidencia_png"), qtd_notas_portal=parcial.get("qtd_notas_portal"),
                )
                if isinstance(exc, ErroFatal):
                    raise
                continue
            hub_api.concluir_consulta_nfgo(
                token, empresa["id"], status=r["status"], movimento=r["movimento"], erro=r["erro"],
                zip_path=r["zip_path"], evidencia_png=r["evidencia_png"],
                qtd_notas_portal=r["qtd_notas_portal"], qtd_xml=r["qtd_xml"], observacao=r["observacao"],
            )
            alguma_ok = alguma_ok or r["status"] == "CONCLUIDO"
            log(f"  ✅ {r['movimento']} — SEFAZ: {r['qtd_notas_portal']} · XML no ZIP: {r['qtd_xml']} {r['observacao']}")
    except ErroParado as exc:
        motivo = "Cancelado pelo usuário" if "Hub" in str(exc) else "Parado no programa do PC"
        hub_api.interromper_execucao(token, execucao_id, motivo)
        log(f"⏹ {exc} — o que faltava ficou para reprocessar no Hub.")
        return
    except ErroFatal as exc:
        hub_api.interromper_execucao(token, execucao_id, f"Interrompido: {exc}")
        raise
    except Exception as exc:
        # qualquer outra falha (Hub fora do ar no meio, erro inesperado): não
        # deixa a execução presa em RODANDO - libera o Reprocessar
        try:
            hub_api.interromper_execucao(token, execucao_id, f"Interrompido por erro no programa do PC: {exc}"[:400])
        except Exception:
            pass
        raise

    hub_api.concluir_execucao(token, execucao_id, competencia["mm_aaaa"], "CONCLUIDO" if alguma_ok else "ERRO")
    log("\nExecução finalizada — confira a grade no Hub.")

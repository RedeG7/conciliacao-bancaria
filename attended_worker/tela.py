#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tela da sessão RDS para o agente de admissões: captura (reduzida para o
limite de imagem do modelo) e execução das ações da ferramenta de
computador do Claude (computer_toolset_20260801) com pyautogui.

As coordenadas que o Claude manda estão no espaço da captura reduzida;
aqui elas voltam para o tamanho real da tela antes do clique.

A sessão RDS precisa ficar ABERTA (não minimizada nem desconectada):
desconectada, o Windows não desenha a tela e a captura sai preta."""

from __future__ import annotations

import io
import time
from typing import Callable, Optional

# lado maior da captura enviada ao modelo (menos tokens por print; o
# limite do modelo é 2576 px)
LADO_MAX = 1366

_TECLAS = {
    "return": "enter", "kp_enter": "enter", "escape": "esc", "page_down": "pagedown",
    "page_up": "pageup", "super": "win", "cmd": "win", "control": "ctrl", "ctl": "ctrl",
    "backspace": "backspace", "delete": "delete", "del": "delete", "space": "space",
    "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right",
    "prior": "pageup", "next": "pagedown", "insert": "insert", "home": "home", "end": "end",
}

MEMBROS = {
    "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click",
    "triple_click", "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up",
    "cursor_position", "scroll", "type", "key", "hold_key", "wait",
}


class AcaoInvalida(ValueError):
    pass


def teclas(texto: str) -> list[str]:
    """"ctrl+shift+Tab" -> ["ctrl", "shift", "tab"] (nomes do pyautogui)."""
    partes = [p.strip() for p in str(texto or "").split("+") if p.strip()]
    if not partes:
        raise AcaoInvalida("Tecla vazia")
    return [_TECLAS.get(p.lower(), p.lower()) for p in partes]


def _escapar_send_keys(texto: str) -> str:
    """send_keys do pywinauto trata {}+^%~() como comandos."""
    return "".join("{" + c + "}" if c in "{}+^%~()" else c for c in texto)


class Tela:
    def __init__(self, gui=None, capturar: Optional[Callable] = None,
                 digitar: Optional[Callable[[str], None]] = None, lado_max: int = LADO_MAX):
        if gui is None:
            import pyautogui as gui  # noqa: N813 - só no Windows da sessão RDS
            gui.FAILSAFE = True       # mouse no canto superior esquerdo interrompe
            gui.PAUSE = 0.15
        self._gui = gui
        self._capturar = capturar or self._capturar_pil
        self._digitar = digitar or self._digitar_unicode
        self._lado_max = lado_max
        self.escala = 1.0

    # -- captura ----------------------------------------------------------
    @staticmethod
    def _capturar_pil():
        from PIL import ImageGrab
        return ImageGrab.grab(all_screens=False)

    def _png(self, img) -> bytes:
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    def captura(self):
        """Print da tela inteira reduzido; atualiza a escala usada nos cliques."""
        img = self._capturar()
        largura, altura = img.size
        self.escala = min(1.0, self._lado_max / max(largura, altura))
        if self.escala < 1.0:
            img = img.resize((round(largura * self.escala), round(altura * self.escala)))
        return img

    def screenshot_png(self) -> bytes:
        return self._png(self.captura())

    def zoom_png(self, regiao) -> bytes:
        x0, y0, x1, y1 = [self._real(v) for v in regiao]
        if x1 <= x0 or y1 <= y0:
            raise AcaoInvalida("Região inválida")
        img = self._capturar().crop((x0, y0, x1, y1))
        fator = min(1.0, self._lado_max / max(img.size))
        if fator < 1.0:
            img = img.resize((round(img.size[0] * fator), round(img.size[1] * fator)))
        return self._png(img)

    # -- ações ------------------------------------------------------------
    def _real(self, v) -> int:
        return round(float(v) / (self.escala or 1.0))

    def _ponto(self, coord):
        if coord is None:
            return None
        if not isinstance(coord, (list, tuple)) or len(coord) != 2:
            raise AcaoInvalida("Coordenada inválida")
        return self._real(coord[0]), self._real(coord[1])

    @staticmethod
    def _digitar_unicode(texto: str) -> None:
        # acentos e ç: pyautogui.write só digita ASCII; o send_keys do
        # pywinauto manda o caractere Unicode direto
        from pywinauto.keyboard import send_keys
        send_keys(_escapar_send_keys(texto), with_spaces=True, with_tabs=True, with_newlines=True, pause=0.01)

    def _clicar(self, entrada: dict, botao: str = "left", vezes: int = 1) -> None:
        ponto = self._ponto(entrada.get("coordinate"))
        mods = teclas(entrada["text"]) if entrada.get("text") else []
        for m in mods:
            self._gui.keyDown(m)
        try:
            if ponto:
                self._gui.click(ponto[0], ponto[1], clicks=vezes, interval=0.08, button=botao)
            else:
                self._gui.click(clicks=vezes, interval=0.08, button=botao)
        finally:
            for m in reversed(mods):
                self._gui.keyUp(m)

    def executar(self, nome: str, entrada: dict):
        """Executa um membro da ferramenta. Retorna bytes PNG (screenshot,
        zoom) ou texto."""
        entrada = entrada or {}
        if nome not in MEMBROS:
            raise AcaoInvalida(f"Ação desconhecida: {nome}")
        if nome == "screenshot":
            return self.screenshot_png()
        if nome == "zoom":
            return self.zoom_png(entrada.get("region") or [])
        if nome == "left_click":
            self._clicar(entrada)
        elif nome == "right_click":
            self._clicar(entrada, "right")
        elif nome == "middle_click":
            self._clicar(entrada, "middle")
        elif nome == "double_click":
            self._clicar(entrada, vezes=2)
        elif nome == "triple_click":
            self._clicar(entrada, vezes=3)
        elif nome == "left_click_drag":
            ini, fim = self._ponto(entrada.get("start_coordinate")), self._ponto(entrada.get("coordinate"))
            if not ini or not fim:
                raise AcaoInvalida("Arrastar precisa de início e fim")
            self._gui.moveTo(*ini)
            self._gui.dragTo(fim[0], fim[1], duration=0.4, button="left")
        elif nome == "mouse_move":
            ponto = self._ponto(entrada.get("coordinate"))
            if not ponto:
                raise AcaoInvalida("Coordenada obrigatória")
            self._gui.moveTo(*ponto)
        elif nome == "left_mouse_down":
            self._gui.mouseDown(button="left")
        elif nome == "left_mouse_up":
            self._gui.mouseUp(button="left")
        elif nome == "cursor_position":
            x, y = self._gui.position()
            return f"[{round(x * self.escala)}, {round(y * self.escala)}]"
        elif nome == "scroll":
            ponto = self._ponto(entrada.get("coordinate"))
            if ponto:
                self._gui.moveTo(*ponto)
            qtd = max(1, min(int(entrada.get("scroll_amount") or 3), 30))
            direcao = entrada.get("scroll_direction")
            if direcao in ("up", "down"):
                self._gui.scroll(120 * qtd * (1 if direcao == "up" else -1))
            elif direcao in ("left", "right"):
                self._gui.hscroll(120 * qtd * (1 if direcao == "right" else -1))
            else:
                raise AcaoInvalida("Direção de rolagem inválida")
        elif nome == "type":
            self._digitar(str(entrada.get("text") or ""))
        elif nome == "key":
            combo = teclas(entrada.get("text"))
            for _ in range(max(1, min(int(entrada.get("repeat") or 1), 100))):
                self._gui.hotkey(*combo)
        elif nome == "hold_key":
            combo = teclas(entrada.get("text"))
            for t in combo:
                self._gui.keyDown(t)
            time.sleep(min(float(entrada.get("duration") or 0.5), 10))
            for t in reversed(combo):
                self._gui.keyUp(t)
        elif nome == "wait":
            time.sleep(min(float(entrada.get("duration") or 1), 30))
        return "OK"

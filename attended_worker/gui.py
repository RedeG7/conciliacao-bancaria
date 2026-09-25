#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Interface gráfica do script attended do ISS Net Online - ver
issnet_attended.py pro núcleo da automação (essa camada só monta uma
janela normal do Windows por cima, sem precisar de terminal nem argumentos
de linha de comando).

Fluxo pensado pro usuário final: abre o portal certo no Edge com um botão,
a pessoa loga manualmente (certificado), escolhe a planilha/pasta numa
janela comum de "Procurar arquivo", clica em Iniciar e acompanha o log ao
vivo. Se rodado com um argumento reconhecido (processar-hub,
processar-planilha, testar-empresa), passa direto pro modo linha de
comando de sempre (sem abrir janela) - uso avançado/automação."""

from __future__ import annotations

import contextlib
import json
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

sys.path.insert(0, str(Path(__file__).resolve().parent))

import issnet_attended as core  # noqa: E402  (reusa toda a lógica já testada)

MUNICIPIOS = {"Goiânia": "goiania", "Aparecida de Goiânia": "aparecida"}

# quando empacotado como .exe (PyInstaller --onefile), sys.executable é o
# próprio .exe; __file__ aponta pra pasta temporária de extração, que não
# serve pra guardar config entre execuções.
_PASTA_APP = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_PATH = _PASTA_APP / "issnet_attended_config.json"


def _carregar_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _salvar_config(dados: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass  # nunca trava o fluxo principal por causa disso


class _LogParaWidget:
    """Redireciona print() (usado pelo núcleo em issnet_attended.py) pro
    Text widget do log. write() roda numa thread de fundo - só agenda a
    atualização real na thread principal via app.after(), porque Tkinter
    não é thread-safe."""

    def __init__(self, app: "App") -> None:
        self._app = app
        self._buffer = ""

    def write(self, texto: str) -> None:
        self._buffer += texto
        while "\n" in self._buffer:
            linha, self._buffer = self._buffer.split("\n", 1)
            self._app.after(0, self._app._log, linha)

    def flush(self) -> None:
        pass


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Fechamento ISS Net Online — REST/DMS")
        self.geometry("680x600")
        self.minsize(600, 520)
        self._config = _carregar_config()
        self._rodando = False
        self._montar_ui()

    # ------------------------------------------------------------------
    # montagem da janela
    # ------------------------------------------------------------------

    def _montar_ui(self) -> None:
        pad = {"padx": 10, "pady": 6}

        f1 = ttk.LabelFrame(self, text="1. Abrir o portal e logar")
        f1.pack(fill="x", **pad)
        ttk.Label(f1, text="Município:").grid(row=0, column=0, sticky="w", padx=8, pady=6)
        self.municipio_var = tk.StringVar(value=self._config.get("municipio", "Goiânia"))
        ttk.Combobox(
            f1, textvariable=self.municipio_var, values=list(MUNICIPIOS), state="readonly", width=25,
        ).grid(row=0, column=1, sticky="w", padx=8, pady=6)
        ttk.Button(f1, text="Abrir portal no Edge", command=self._abrir_portal).grid(row=0, column=2, padx=8, pady=6)
        ttk.Label(
            f1,
            text="Faça login manualmente (certificado digital, ou qualquer verificação que\n"
                 "aparecer) na janela que abrir. Deixe essa janela em primeiro plano, sem\n"
                 "trocar de aplicativo, até o processamento terminar. IMPORTANTE: antes de\n"
                 "clicar em Iniciar, fique na tela 'Empresas' (a listagem com o campo de\n"
                 "busca CPF/CNPJ) — não deixe aberto dentro de uma empresa específica.",
            foreground="#555", justify="left",
        ).grid(row=1, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 6))

        f2 = ttk.LabelFrame(self, text="2. De onde vêm as empresas")
        f2.pack(fill="x", **pad)
        self.modo_var = tk.StringVar(value=self._config.get("modo", "planilha"))
        ttk.Radiobutton(
            f2, text="Planilha local (.xlsx)", variable=self.modo_var, value="planilha", command=self._atualizar_modo,
        ).grid(row=0, column=0, sticky="w", padx=8, pady=4)
        ttk.Radiobutton(
            f2, text="Sincronizar com o Hub (avançado)", variable=self.modo_var, value="hub", command=self._atualizar_modo,
        ).grid(row=0, column=1, sticky="w", padx=8, pady=4)

        self.planilha_var = tk.StringVar(value=self._config.get("planilha", ""))
        self.lbl_planilha = ttk.Label(f2, text="Planilha:")
        self.ent_planilha = ttk.Entry(f2, textvariable=self.planilha_var, width=55)
        self.btn_planilha = ttk.Button(f2, text="Procurar...", command=self._escolher_planilha)

        self.escritorio_var = tk.StringVar(value=self._config.get("escritorio_id", ""))
        self.lbl_escritorio = ttk.Label(f2, text="ID do escritório:")
        self.ent_escritorio = ttk.Entry(f2, textvariable=self.escritorio_var, width=55)
        self.lbl_hub_info = ttk.Label(
            f2,
            text="Precisa da chave SSH de deploy e do arquivo prod.env nesta máquina\n"
                 "(configuração única, com o super admin) - ver LEIA-ME.txt.",
            foreground="#555", justify="left",
        )

        f2.columnconfigure(1, weight=1)

        f3 = ttk.LabelFrame(self, text="3. Pasta onde salvar os PDFs")
        f3.pack(fill="x", **pad)
        self.pasta_var = tk.StringVar(value=self._config.get("pasta_raiz", str(Path.home() / "Prefeituras")))
        ttk.Entry(f3, textvariable=self.pasta_var, width=55).grid(row=0, column=0, sticky="we", padx=8, pady=6)
        ttk.Button(f3, text="Procurar...", command=self._escolher_pasta).grid(row=0, column=1, padx=8, pady=6)
        f3.columnconfigure(0, weight=1)

        self.btn_iniciar = ttk.Button(self, text="▶  Iniciar processamento", command=self._iniciar)
        self.btn_iniciar.pack(pady=(4, 8))

        f4 = ttk.LabelFrame(self, text="Andamento")
        f4.pack(fill="both", expand=True, **pad)
        self.txt_log = tk.Text(f4, height=14, state="disabled", wrap="word")
        self.txt_log.pack(fill="both", expand=True, padx=6, pady=6)

        self._atualizar_modo()

    def _atualizar_modo(self) -> None:
        if self.modo_var.get() == "planilha":
            self.lbl_escritorio.grid_forget()
            self.ent_escritorio.grid_forget()
            self.lbl_hub_info.grid_forget()
            self.lbl_planilha.grid(row=1, column=0, sticky="w", padx=8)
            self.ent_planilha.grid(row=1, column=1, sticky="we", padx=8)
            self.btn_planilha.grid(row=1, column=2, padx=8)
        else:
            self.lbl_planilha.grid_forget()
            self.ent_planilha.grid_forget()
            self.btn_planilha.grid_forget()
            self.lbl_escritorio.grid(row=1, column=0, sticky="w", padx=8, pady=4)
            self.ent_escritorio.grid(row=1, column=1, sticky="we", padx=8, pady=4)
            self.lbl_hub_info.grid(row=2, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 4))

    # ------------------------------------------------------------------
    # ações
    # ------------------------------------------------------------------

    def _abrir_portal(self) -> None:
        slug = MUNICIPIOS[self.municipio_var.get()]
        url = f"https://www.issnetonline.com.br/{slug}/online/login/login.aspx"
        try:
            subprocess.Popen(["cmd", "/c", "start", "msedge", "--force-renderer-accessibility", url])
        except Exception as exc:
            messagebox.showerror("Erro", f"Não consegui abrir o Edge: {exc}")

    def _pasta_inicial_valida(self, valor: str) -> str:
        """Pasta de partida pro seletor nativo do Windows. SEM isso, o
        seletor abre em "Este Computador" e tenta listar todas as
        unidades - inclusive unidades de rede/compartilhamentos, comuns
        em escritório de contabilidade - o que trava por um bom tempo
        (relatado como "travando ao clicar em Procurar"). Usa a pasta já
        digitada se ela existir, senão cai pra pasta do usuário (sempre
        local, sempre rápida)."""
        candidato = Path(valor) if valor else None
        if candidato and candidato.exists():
            return str(candidato)
        return str(Path.home())

    def _escolher_planilha(self) -> None:
        caminho = filedialog.askopenfilename(
            title="Escolha a planilha", filetypes=[("Excel", "*.xlsx")],
            initialdir=self._pasta_inicial_valida(str(Path(self.planilha_var.get()).parent) if self.planilha_var.get() else ""),
            parent=self,
        )
        if caminho:
            self.planilha_var.set(caminho)

    def _escolher_pasta(self) -> None:
        caminho = filedialog.askdirectory(
            title="Escolha a pasta de destino",
            initialdir=self._pasta_inicial_valida(self.pasta_var.get()),
            parent=self,
        )
        if caminho:
            self.pasta_var.set(caminho)

    def _log(self, texto: str) -> None:
        self.txt_log.configure(state="normal")
        self.txt_log.insert("end", texto + "\n")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _iniciar(self) -> None:
        if self._rodando:
            return

        modo = self.modo_var.get()
        pasta = self.pasta_var.get().strip()
        if not pasta:
            messagebox.showwarning("Faltou informação", "Escolha a pasta de destino.")
            return

        planilha = self.planilha_var.get().strip()
        escritorio = self.escritorio_var.get().strip()
        if modo == "planilha":
            if not planilha or not Path(planilha).exists():
                messagebox.showwarning("Faltou informação", "Escolha uma planilha válida (.xlsx).")
                return
        else:
            if not escritorio:
                messagebox.showwarning("Faltou informação", "Informe o ID do escritório.")
                return

        _salvar_config({
            "municipio": self.municipio_var.get(),
            "modo": modo,
            "planilha": planilha,
            "pasta_raiz": pasta,
            "escritorio_id": escritorio,
        })

        self._rodando = True
        self.btn_iniciar.configure(state="disabled", text="Processando...")
        self.txt_log.configure(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.configure(state="disabled")

        threading.Thread(target=self._rodar, args=(modo, planilha, escritorio, pasta), daemon=True).start()

    def _rodar(self, modo: str, planilha: str, escritorio: str, pasta: str) -> None:
        saida = _LogParaWidget(self)
        try:
            with contextlib.redirect_stdout(saida):
                if modo == "planilha":
                    core.processar_planilha(Path(planilha), Path(pasta))
                else:
                    core.processar_execucao_hub(escritorio, Path(pasta))
            self.after(0, self._log, "\n✅ Terminado.")
        except core.ErroAttended as exc:
            self.after(0, self._log, f"\n❌ {exc}")
        except Exception as exc:  # nunca deixa a GUI travar por uma exceção não prevista
            self.after(0, self._log, f"\n❌ ERRO INESPERADO: {exc}")
        finally:
            self.after(0, self._finalizar)

    def _finalizar(self) -> None:
        self._rodando = False
        self.btn_iniciar.configure(state="normal", text="▶  Iniciar processamento")


SUBCOMANDOS_CLI = {"processar-hub", "processar-planilha", "testar-empresa"}


def _esconder_console() -> None:
    """O .exe é buildado como app de CONSOLE normal (não --windowed) pra
    que o modo CLI (processar-hub/processar-planilha/testar-empresa)
    herde o console de quem chamou sem nenhum truque (AttachConsole em
    .exe --windowed se mostrou frágil - depende de como o processo pai
    aloca console, quebra em terminais que usam pseudo-console). No modo
    GUI (duplo clique, sem argumento) simplesmente esconde a janela preta
    do console assim que abre - ela pisca rapidinho e some, comportamento
    padrão desse tipo de app."""
    import ctypes
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in SUBCOMANDOS_CLI:
        core.main_cli()
        return
    _esconder_console()
    App().mainloop()


if __name__ == "__main__":
    main()

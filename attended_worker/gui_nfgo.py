#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Janela do programa do PC do RPA NF GO - ver nfgo_attended.py pro núcleo
(cliques via UI Automation no Edge). Mesmo desenho do programa do ISS Net
(gui.py), mas só no modo "Sincronizar com o Hub": a planilha e a
competência vêm da execução criada no Hub (🧾 RPA NF GO), e o resultado
(quantidades, print, ZIP) volta pra grade de lá.

Fluxo: Abrir portal no Edge > a pessoa entra com o certificado do
escritório e vai até "Consulta de Notas Recebidas" > Iniciar."""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hub_api  # noqa: E402
import nfgo_attended as core  # noqa: E402

NOME_APP = "RPA NF GO"

# quando empacotado como .exe (PyInstaller --onefile), sys.executable é o
# próprio .exe; __file__ aponta pra pasta temporária de extração, que não
# serve pra guardar config entre execuções.
_PASTA_APP = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_PATH = _PASTA_APP / "nfgo_attended_config.json"

# _MEIPASS: pasta temporária onde o PyInstaller extrai os arquivos
# empacotados (--add-data) em modo --onefile - é de lá que o VERSION
# embutido é lido, não da pasta do .exe (que é só onde ele foi salvo).
_PASTA_DADOS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def _ler_versao_local() -> str:
    arq = _PASTA_DADOS / "VERSION_NFGO"
    return arq.read_text(encoding="utf-8").strip() if arq.exists() else "0.0"


def _versao_maior(a: str, b: str) -> bool:
    """True se a > b, comparando parte a parte como número (\"1.10\" > \"1.9\",
    diferente de comparar como texto)."""
    def partes(v: str) -> list:
        return [int(p) for p in v.split(".") if p.strip().isdigit()]
    return partes(a) > partes(b)


VERSAO_ATUAL = _ler_versao_local()

# comandos auxiliares (PowerShell do seletor de pasta/atalho) sem abrir
# janela de prompt - o .exe é "janela" (sem console), ver build_nfgo.ps1
_SEM_JANELA = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _selecionar_pasta_nativa(inicial: str) -> str:
    """Abre o seletor de pasta MODERNO do Windows (estilo Explorer),
    delegando pro FolderBrowserDialog do .NET via um PowerShell auxiliar
    - em vez do filedialog.askdirectory() do Tkinter, que no Windows usa
    o componente ANTIGO (SHBrowseForFolder). Esse antigo sempre monta a
    árvore inteira a partir de "Este Computador" pra poder expandir até
    a pasta inicial, o que enumera TODAS as unidades (inclusive de rede)
    mesmo com initialdir definido - confirmado que travava mesmo depois
    de setar initialdir, então o problema era o componente em si, não a
    pasta de partida."""
    inicial_escapada = inicial.replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Windows.Forms\n"
        "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog\n"
        "$dlg.Description = 'Escolha a pasta de destino'\n"
        f"$dlg.SelectedPath = '{inicial_escapada}'\n"
        "$dlg.ShowNewFolderButton = $true\n"
        "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {\n"
        "    Write-Output $dlg.SelectedPath\n"
        "}\n"
    )
    try:
        resultado = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=180, creationflags=_SEM_JANELA,
        )
    except Exception:
        return ""
    return resultado.stdout.strip()


def _atualizar_atalho_desktop(exe_path: Path, forcar: bool) -> None:
    """Cria (se não existir) ou atualiza (se forcar=True) o atalho fixo
    "{NOME_APP}.lnk" na Área de Trabalho, sempre apontando pro .exe mais
    recente - pedido do usuário: como cada atualização baixa um arquivo
    com nome novo (nfgo_attended_v{versão}.exe, pra nunca mexer no
    arquivo antigo rodando - ver _baixar_e_atualizar_bg), um atalho
    fixado manualmente na Área de Trabalho ficaria PRESO na versão de
    quando foi criado, e a pessoa nunca mais abriria a versão nova sem
    saber procurar o arquivo certo na pasta.

    O ATALHO em si (não o .exe) é o que fica fixo - trocar o ALVO dele é
    uma operação leve num arquivo .lnk que ninguém tem aberto, então não
    esbarra no mesmo problema que substituir o .exe rodando tinha
    (antivírus/Windows barrando a troca - ver v1.4)."""
    try:
        desktop = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"
        atalho = desktop / f"{NOME_APP}.lnk"
        if atalho.exists() and not forcar:
            return
        script = (
            "$WshShell = New-Object -ComObject WScript.Shell\n"
            f'$Shortcut = $WshShell.CreateShortcut("{atalho}")\n'
            f'$Shortcut.TargetPath = "{exe_path}"\n'
            f'$Shortcut.IconLocation = "{exe_path},0"\n'
            f'$Shortcut.WorkingDirectory = "{exe_path.parent}"\n'
            "$Shortcut.Save()\n"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, timeout=15, creationflags=_SEM_JANELA,
        )
    except Exception:
        pass  # atalho é conveniência - nunca trava o uso normal por causa disso


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
    """Redireciona print() (usado pelo núcleo em nfgo_attended.py) pro
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
        self.title(f"{NOME_APP} — v{VERSAO_ATUAL}")
        self.geometry("700x720")
        self.minsize(620, 600)
        self._config = _carregar_config()
        self._rodando = False
        self._evento_parar = threading.Event()
        self._hub_token = self._config.get("hub_token", "")
        self._automatico = False          # rodada atual veio do "aguardar execuções"
        self._ignorar_ate: dict = {}      # execucao_id -> hora até quando não pega de novo sozinho
        self._vigiando = False
        self._montar_ui()
        if getattr(sys, "frozen", False):
            threading.Thread(
                target=_atualizar_atalho_desktop, args=(Path(sys.executable).resolve(), False), daemon=True,
            ).start()
        self.after(800, self._checar_atualizacao)
        self.after(3000, self._vigiar)

    def _montar_ui(self) -> None:
        pad = {"padx": 10, "pady": 6}

        f1 = ttk.LabelFrame(self, text="1. Abrir o portal da SEFAZ-GO e entrar")
        f1.pack(fill="x", **pad)
        ttk.Button(f1, text="Abrir portal no Edge", command=self._abrir_portal).grid(row=0, column=0, sticky="w", padx=8, pady=6)
        ttk.Label(
            f1,
            text="Opcional: se o Edge não estiver aberto, o Iniciar abre sozinho. Escolha o\n"
                 "certificado do escritório e faça a nova autenticação quando pedir — o programa\n"
                 "clica em Acesso Restrito > Baixar XML NFE e começa ao chegar na 'Consulta de\n"
                 "Notas Recebidas'. Deixe o Edge na frente. 'Verify you are human': clique você.",
            foreground="#555", justify="left",
        ).grid(row=1, column=0, sticky="w", padx=8, pady=(0, 6))

        f2 = ttk.LabelFrame(self, text="2. De onde vêm as empresas")
        f2.pack(fill="x", **pad)
        self.modo_var = tk.StringVar(value=self._config.get("modo", "hub"))
        ttk.Radiobutton(f2, text="Sincronizar com o Hub", variable=self.modo_var, value="hub",
                        command=self._atualizar_modo).grid(row=0, column=0, sticky="w", padx=8, pady=4)
        ttk.Radiobutton(f2, text="Planilha local (.xlsx) — sem login no Hub", variable=self.modo_var, value="planilha",
                        command=self._atualizar_modo).grid(row=0, column=1, sticky="w", padx=8, pady=4)

        # modo Hub
        self.hub_usuario_var = tk.StringVar(value=self._config.get("hub_usuario", ""))
        self.hub_senha_var = tk.StringVar(value="")  # senha nunca fica salva
        self._widgets_hub = [
            (ttk.Label(f2, text="Usuário do Hub:"), {"row": 1, "column": 0, "sticky": "w"}),
            (ttk.Entry(f2, textvariable=self.hub_usuario_var, width=50), {"row": 1, "column": 1, "columnspan": 2, "sticky": "we"}),
            (ttk.Label(f2, text="Senha:"), {"row": 2, "column": 0, "sticky": "w"}),
            (ttk.Entry(f2, textvariable=self.hub_senha_var, width=50, show="•"), {"row": 2, "column": 1, "columnspan": 2, "sticky": "we"}),
            (ttk.Label(f2, text="Mesmo login/senha do hub.redeg7.com (a execução é criada lá, em 🧾 RPA NF GO).\n"
                                "Só precisa digitar a senha de novo se a sessão expirar (30 dias).",
                       foreground="#555", justify="left"), {"row": 3, "column": 0, "columnspan": 3, "sticky": "w"}),
        ]

        # modo planilha local
        self.planilha_var = tk.StringVar(value=self._config.get("planilha", ""))
        self.competencia_var = tk.StringVar(value=core._competencia("")["mm_aaaa"])  # mês anterior
        self.sefaz_cpf_var = tk.StringVar(value=self._config.get("sefaz_cpf", ""))
        self.sefaz_senha_var = tk.StringVar(value="")  # senha nunca fica salva
        self._widgets_planilha = [
            (ttk.Label(f2, text="Planilha:"), {"row": 1, "column": 0, "sticky": "w"}),
            (ttk.Entry(f2, textvariable=self.planilha_var, width=45), {"row": 1, "column": 1, "sticky": "we"}),
            (ttk.Button(f2, text="Procurar...", command=self._escolher_planilha), {"row": 1, "column": 2}),
            (ttk.Label(f2, text="Competência (MM/AAAA):"), {"row": 2, "column": 0, "sticky": "w"}),
            (ttk.Entry(f2, textvariable=self.competencia_var, width=10), {"row": 2, "column": 1, "sticky": "w"}),
            (ttk.Label(f2, text="CPF Acesso Restrito:"), {"row": 3, "column": 0, "sticky": "w"}),
            (ttk.Entry(f2, textvariable=self.sefaz_cpf_var, width=20), {"row": 3, "column": 1, "sticky": "w"}),
            (ttk.Label(f2, text="Senha Acesso Restrito:"), {"row": 4, "column": 0, "sticky": "w"}),
            (ttk.Entry(f2, textvariable=self.sefaz_senha_var, width=20, show="•"), {"row": 4, "column": 1, "sticky": "w"}),
            (ttk.Label(f2, text="Colunas: Código da Empresa, Razão Social, CNPJ, Inscrição Estadual. CPF/senha\n"
                                "(opcionais) são usados se o portal pedir nova autenticação. Gera RESUMO_MMAAAA.xlsx.",
                       foreground="#555", justify="left"), {"row": 5, "column": 0, "columnspan": 3, "sticky": "w"}),
        ]
        f2.columnconfigure(1, weight=1)

        f3 = ttk.LabelFrame(self, text="3. Pasta onde salvar (cria RPA NF GO\\<empresa>\\<MMAAAA>\\ENTRADA|SAIDA)")
        f3.pack(fill="x", **pad)
        self.pasta_var = tk.StringVar(value=self._config.get("pasta_raiz", "C:\\"))
        ttk.Entry(f3, textvariable=self.pasta_var, width=55).grid(row=0, column=0, sticky="we", padx=8, pady=6)
        ttk.Button(f3, text="Procurar...", command=self._escolher_pasta).grid(row=0, column=1, padx=8, pady=6)
        f3.columnconfigure(0, weight=1)

        f_acoes = ttk.Frame(self)
        f_acoes.pack(pady=(4, 8))
        self.btn_iniciar = ttk.Button(f_acoes, text="▶  Iniciar processamento", command=self._iniciar)
        self.btn_iniciar.pack(side="left", padx=4)
        self.btn_parar = ttk.Button(f_acoes, text="⏹  Parar", command=self._parar, state="disabled")
        self.btn_parar.pack(side="left", padx=4)
        self.btn_gravar = ttk.Button(f_acoes, text="🎥  Gravar passo a passo", command=self._gravar)
        self.btn_gravar.pack(side="left", padx=4)

        f_auto = ttk.Frame(self)
        f_auto.pack(fill="x", padx=10)
        self.aguardar_var = tk.BooleanVar(value=self._config.get("aguardar_hub", True))
        ttk.Checkbutton(
            f_auto, variable=self.aguardar_var, command=self._salvar_aguardar,
            text="Ficar aguardando o Hub (criar execução ou Reprocessar no Hub começa sozinho)",
        ).pack(anchor="w")
        self.lbl_aguardando = ttk.Label(f_auto, text="", foreground="#555")
        self.lbl_aguardando.pack(anchor="w")

        self._atualizar_modo()

        f4 = ttk.LabelFrame(self, text="Andamento")
        f4.pack(fill="both", expand=True, **pad)
        self.txt_log = tk.Text(f4, height=14, state="disabled", wrap="word")
        self.txt_log.pack(fill="both", expand=True, padx=6, pady=6)

    def _atualizar_modo(self) -> None:
        hub = self.modo_var.get() == "hub"
        for widget, pos in self._widgets_hub + self._widgets_planilha:
            widget.grid_forget()
        for widget, pos in (self._widgets_hub if hub else self._widgets_planilha):
            widget.grid(padx=8, pady=3, **pos)
        if hasattr(self, "lbl_aguardando"):
            self.lbl_aguardando.configure(text="" if hub else "(aguardar o Hub só vale no modo 'Sincronizar com o Hub')")

    def _escolher_planilha(self) -> None:
        from tkinter import filedialog
        atual = self.planilha_var.get().strip()
        inicial = str(Path(atual).parent) if atual and Path(atual).parent.exists() else str(Path.home())
        caminho = filedialog.askopenfilename(title="Escolha a planilha", filetypes=[("Excel", "*.xlsx")],
                                             initialdir=inicial, parent=self)
        if caminho:
            self.planilha_var.set(caminho)

    def _abrir_portal(self) -> None:
        try:
            core.abrir_portal()
        except Exception as exc:
            messagebox.showerror("Erro", f"Não consegui abrir o Edge: {exc}")

    def _escolher_pasta(self) -> None:
        valor = self.pasta_var.get()
        inicial = valor if valor and Path(valor).exists() else str(Path.home())
        caminho = _selecionar_pasta_nativa(inicial)
        if caminho:
            self.pasta_var.set(caminho)

    def _log(self, texto: str) -> None:
        self.txt_log.configure(state="normal")
        self.txt_log.insert("end", texto + "\n")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _config_atual(self) -> dict:
        return {
            "pasta_raiz": self.pasta_var.get().strip(),
            "hub_usuario": self.hub_usuario_var.get().strip(),
            "hub_token": self._hub_token,
            "aguardar_hub": bool(self.aguardar_var.get()),
            "modo": self.modo_var.get(),
            "planilha": self.planilha_var.get().strip(),
            "sefaz_cpf": self.sefaz_cpf_var.get().strip(),
        }

    def _gravar(self) -> None:
        """Liga/desliga a gravação do passo a passo (ver
        nfgo_attended.gravar_passo_a_passo). Não roda junto com o
        processamento - os cliques do programa entrariam na gravação."""
        if getattr(self, "_evento_gravar", None) is not None:
            self._evento_gravar.set()
            self.btn_gravar.configure(state="disabled", text="Salvando gravação...")
            return
        if self._rodando:
            messagebox.showinfo("Gravação", "Pare o processamento antes de gravar o passo a passo.")
            return
        if not messagebox.askokcancel(
            "Gravar passo a passo",
            "A cada clique do mouse o programa vai guardar um print da tela (com uma marca onde você\n"
            "clicou) e o nome do botão clicado. O teclado NÃO é gravado.\n\n"
            "Faça o caminho no Edge do jeito de sempre (login, Acesso Restrito, Baixar XML NFE,\n"
            "preencher, Pesquisar, Baixar...) e depois clique em 'Parar gravação'.\n\n"
            "Os arquivos ficam numa pasta na Área de Trabalho - mande os prints e o passos.txt\n"
            "para ajustarmos o programa.",
        ):
            return
        self._evento_gravar = threading.Event()
        self.btn_iniciar.configure(state="disabled")
        self.btn_gravar.configure(text="⏺  Parar gravação")
        saida = _LogParaWidget(self)

        def _rodar_gravacao() -> None:
            pasta = None
            try:
                with contextlib.redirect_stdout(saida):
                    pasta = core.gravar_passo_a_passo(self._evento_gravar.is_set, log=print)
            except Exception as exc:
                self.after(0, self._log, f"❌ Gravação: {exc}")
            finally:
                self.after(0, self._fim_gravacao, pasta)

        threading.Thread(target=_rodar_gravacao, daemon=True).start()

    def _fim_gravacao(self, pasta) -> None:
        self._evento_gravar = None
        self.btn_iniciar.configure(state="normal")
        self.btn_gravar.configure(state="normal", text="🎥  Gravar passo a passo")
        if pasta:
            try:
                os.startfile(str(pasta))  # abre a pasta no Explorer
            except Exception:
                pass

    def _salvar_aguardar(self) -> None:
        self._config.update(self._config_atual())
        _salvar_config(self._config)
        if not self.aguardar_var.get():
            self.lbl_aguardando.configure(text="")

    # ------------------------------------------------------------------
    # aguardar execuções do Hub: com o programa aberto, confere a fila a
    # cada 30 s e começa sozinho (o Reprocessar/criar execução no Hub vira
    # o "comando" pro PC). Usa a sessão salva - precisa ter feito o
    # Iniciar com a senha uma vez.
    # ------------------------------------------------------------------

    INTERVALO_VIGIA_MS = 30_000

    def _vigiar(self) -> None:
        self.after(self.INTERVALO_VIGIA_MS, self._vigiar)
        usuario = self.hub_usuario_var.get().strip()
        if (
            self._rodando or self._vigiando or not self.aguardar_var.get() or self.modo_var.get() != "hub"
            or getattr(self, "_evento_gravar", None) is not None
            or not self._hub_token or self._config.get("hub_usuario") != usuario
            or not self.pasta_var.get().strip()
        ):
            if self.aguardar_var.get() and not self._rodando and not self._hub_token:
                self.lbl_aguardando.configure(text="Para aguardar o Hub, clique em Iniciar uma vez com a senha (a sessão fica salva).")
            return
        self._vigiando = True
        threading.Thread(target=self._vigiar_bg, args=(self._hub_token,), daemon=True).start()

    def _vigiar_bg(self, token: str) -> None:
        try:
            pendente = hub_api.execucao_pendente(token, core.MODULO)
        except hub_api.ErroHubApi as exc:
            texto = f"⚠️ Sem contato com o Hub ({time.strftime('%H:%M')}): {str(exc)[:120]}"
            if "faça login de novo" in str(exc):
                self._hub_token = ""
                texto = "Sessão do Hub expirou — digite a senha e clique em Iniciar."
            self.after(0, self.lbl_aguardando.configure, {"text": texto})
            self._vigiando = False
            return
        execucao_id = pendente.get("execucao_id")
        self._vigiando = False
        if execucao_id and time.time() >= self._ignorar_ate.get(execucao_id, 0):
            self.after(0, self._iniciar_automatico, execucao_id)
        else:
            self.after(0, self.lbl_aguardando.configure,
                       {"text": f"🟢 Aguardando execuções do Hub — última conferência às {time.strftime('%H:%M:%S')}"})

    def _iniciar_automatico(self, execucao_id: int) -> None:
        if self._rodando:
            return
        self._automatico = True
        self._execucao_auto = execucao_id
        self.lbl_aguardando.configure(text=f"▶ Execução #{execucao_id} recebida do Hub — processando...")
        self._comecar(self.hub_usuario_var.get().strip(), "", self.pasta_var.get().strip())

    def _iniciar(self) -> None:
        if self._rodando:
            return
        if self.modo_var.get() == "planilha":
            self._iniciar_planilha()
            return
        pasta = self.pasta_var.get().strip()
        usuario = self.hub_usuario_var.get().strip()
        senha = self.hub_senha_var.get()
        if not pasta:
            messagebox.showwarning("Faltou informação", "Escolha a pasta de destino.")
            return
        if not usuario:
            messagebox.showwarning("Faltou informação", "Informe o usuário do Hub.")
            return
        tem_sessao_salva = bool(self._hub_token) and self._config.get("hub_usuario") == usuario
        if not senha and not tem_sessao_salva:
            messagebox.showwarning("Faltou informação", "Informe a senha (primeira vez usando este usuário, ou sessão expirada).")
            return

        self._automatico = False
        self._comecar(usuario, senha, pasta)

    def _iniciar_planilha(self) -> None:
        import re as _re
        pasta = self.pasta_var.get().strip()
        planilha = self.planilha_var.get().strip()
        competencia = self.competencia_var.get().strip()
        if not pasta:
            messagebox.showwarning("Faltou informação", "Escolha a pasta de destino.")
            return
        if not planilha or not Path(planilha).exists():
            messagebox.showwarning("Faltou informação", "Escolha uma planilha válida (.xlsx).")
            return
        m = _re.fullmatch(r"(\d{1,2})/(\d{4})", competencia)
        if not m or not 1 <= int(m.group(1)) <= 12:
            messagebox.showwarning("Competência inválida", "Informe a competência no formato MM/AAAA (ex.: 09/2026).")
            return
        competencia = f"{int(m.group(1)):02d}/{m.group(2)}"
        self._automatico = False
        _salvar_config(self._config_atual())
        self._preparar_execucao()
        threading.Thread(
            target=self._rodar_planilha,
            args=(planilha, pasta, competencia, self.sefaz_cpf_var.get().strip(), self.sefaz_senha_var.get()),
            daemon=True,
        ).start()

    def _rodar_planilha(self, planilha: str, pasta: str, competencia: str, cpf: str, senha: str) -> None:
        saida = _LogParaWidget(self)
        erro_msg = None
        try:
            with contextlib.redirect_stdout(saida):
                resumo = core.processar_planilha(Path(planilha), Path(pasta), competencia,
                                                 deve_parar=self._evento_parar.is_set, log=print, cpf=cpf, senha=senha)
            self.after(0, self._log, "\n✅ Terminado.")
            try:
                os.startfile(str(resumo.parent))  # abre a pasta com o resumo
            except Exception:
                pass
        except core.ErroAttended as exc:
            erro_msg = str(exc)
            self.after(0, self._log, f"\n❌ {exc}")
        except Exception as exc:
            erro_msg = str(exc)
            self.after(0, self._log, f"\n❌ ERRO INESPERADO: {exc}")
        finally:
            self.after(0, self._finalizar, erro_msg)

    def _preparar_execucao(self) -> None:
        self._rodando = True
        self._evento_parar.clear()
        self.btn_iniciar.configure(state="disabled", text="Processando...")
        self.btn_parar.configure(state="normal", text="⏹  Parar")
        self.txt_log.configure(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.configure(state="disabled")

    def _comecar(self, usuario: str, senha: str, pasta: str) -> None:
        _salvar_config(self._config_atual())
        self._preparar_execucao()
        threading.Thread(target=self._rodar, args=(usuario, senha, pasta), daemon=True).start()

    def _parar(self) -> None:
        """Para ANTES da próxima consulta (nunca no meio de um download); o
        que faltar volta pro Hub pra reprocessar."""
        if not self._rodando:
            return
        self._evento_parar.set()
        self.btn_parar.configure(state="disabled", text="Parando...")

    def _obter_token_hub(self, usuario: str, senha: str) -> str:
        if not senha and self._hub_token and self._config.get("hub_usuario") == usuario:
            return self._hub_token
        dados = hub_api.login(usuario, senha)
        self._hub_token = dados["token"]
        self._config["hub_usuario"] = usuario
        self.after(0, self._log, f"Login OK — {dados.get('nome', usuario)}")
        _salvar_config(self._config_atual())
        return self._hub_token

    def _rodar(self, usuario: str, senha: str, pasta: str) -> None:
        saida = _LogParaWidget(self)
        erro_msg = None
        try:
            with contextlib.redirect_stdout(saida):
                token = self._obter_token_hub(usuario, senha)
                core.processar_execucao_hub(token, Path(pasta), deve_parar=self._evento_parar.is_set, log=print)
            self.after(0, self._log, "\n✅ Terminado.")
        except (hub_api.ErroHubApi, core.ErroAttended) as exc:
            erro_msg = str(exc)
            self.after(0, self._log, f"\n❌ {exc}")
        except Exception as exc:  # nunca deixa a janela travar por uma exceção não prevista
            erro_msg = str(exc)
            self.after(0, self._log, f"\n❌ ERRO INESPERADO: {exc}")
        finally:
            self.after(0, self._finalizar, erro_msg)

    def _finalizar(self, erro_msg: "str | None" = None) -> None:
        parado = self._evento_parar.is_set()
        self._rodando = False
        if self._automatico:
            # rodada sozinha: sem janela de aviso (ninguém pode estar no PC);
            # se falhou antes de terminar, não pega a mesma execução de novo
            # por 20 min (senão reabriria o Edge sem parar)
            self._automatico = False
            self.btn_iniciar.configure(state="normal", text="▶  Iniciar processamento")
            self.btn_parar.configure(state="disabled", text="⏹  Parar")
            self._evento_parar.clear()
            if erro_msg or parado:
                self._ignorar_ate[self._execucao_auto] = time.time() + 20 * 60
                self.lbl_aguardando.configure(
                    text=f"⚠️ Execução #{self._execucao_auto} parou — tento de novo em 20 min, ou clique em Iniciar.")
            else:
                self.lbl_aguardando.configure(text=f"✅ Execução #{self._execucao_auto} concluída às {time.strftime('%H:%M')} — aguardando o Hub.")
            return
        self._evento_parar.clear()
        self.btn_iniciar.configure(state="normal", text="▶  Iniciar processamento")
        self.btn_parar.configure(state="disabled", text="⏹  Parar")
        self.deiconify()
        self.lift()
        self.attributes("-topmost", True)
        self.after(300, lambda: self.attributes("-topmost", False))
        self.focus_force()
        if erro_msg:
            messagebox.showerror("Concluído com erro", f"O processamento parou:\n\n{erro_msg}")
        elif self.modo_var.get() == "planilha":
            messagebox.showinfo("Parado" if parado else "Concluído",
                                ("Processamento interrompido a pedido." if parado else "Processamento concluído!")
                                + " Veja o RESUMO_MMAAAA.xlsx na pasta RPA NF GO.")
        elif parado:
            messagebox.showinfo("Parado", "Processamento interrompido a pedido. O que faltou fica para reprocessar no Hub.")
        else:
            messagebox.showinfo("Concluído", "Processamento concluído! Confira a grade no Hub.")

    # ------------------------------------------------------------------
    # auto-atualização (mesmo esquema do gui.py, com rotas/nome próprios)
    # ------------------------------------------------------------------

    def _checar_atualizacao(self) -> None:
        if not getattr(sys, "frozen", False):
            return
        threading.Thread(target=self._checar_atualizacao_bg, daemon=True).start()

    def _checar_atualizacao_bg(self) -> None:
        try:
            r = requests.get(f"{hub_api.BASE_URL}/attended-nfgo/versao", timeout=10)
            r.raise_for_status()
            versao_nova = r.json()["versao"]
        except Exception:
            return
        if _versao_maior(versao_nova, VERSAO_ATUAL):
            self.after(0, self._perguntar_atualizar, versao_nova)

    def _perguntar_atualizar(self, versao_nova: str) -> None:
        if messagebox.askyesno(
            "Atualização disponível",
            f"Tem uma versão nova (v{versao_nova} — você está na v{VERSAO_ATUAL}).\n\n"
            "Atualizar agora? O programa baixa a versão nova e reabre sozinho.",
        ):
            threading.Thread(target=self._baixar_e_atualizar_bg, args=(versao_nova,), daemon=True).start()
            self._log(f"Baixando a versão {versao_nova}...")

    def _falha_atualizacao(self, erro: str) -> None:
        self.lbl_aguardando.configure(text="")
        if messagebox.askyesno(
            "Erro na atualização",
            f"Não consegui baixar a versão nova:\n{erro}\n\n"
            "Abrir o Hub no navegador para baixar por lá? (RPA NF GO > Baixar programa)",
        ):
            _abrir_hub()

    def _baixar_com_retomada(self, url: str, destino: Path, tentativas: int = 5) -> None:
        """Baixa em pedaços; se a conexão cair no meio (erro 10054 - visto num
        PC do escritório), tenta de novo continuando de onde parou (Range)."""
        destino.unlink(missing_ok=True)
        ultimo_erro = None
        for tentativa in range(1, tentativas + 1):
            ja = destino.stat().st_size if destino.exists() else 0
            cabecalho = {"Range": f"bytes={ja}-"} if ja else {}
            try:
                with requests.get(url, headers=cabecalho, stream=True, timeout=60) as r:
                    if r.status_code == 416:  # já estava completo
                        return
                    r.raise_for_status()
                    modo = "ab" if ja and r.status_code == 206 else "wb"
                    total = int(r.headers.get("Content-Length") or 0) + (ja if modo == "ab" else 0)
                    baixado = ja if modo == "ab" else 0
                    with destino.open(modo) as f:
                        for pedaco in r.iter_content(chunk_size=262144):
                            f.write(pedaco)
                            baixado += len(pedaco)
                            if total:
                                self.after(0, self.lbl_aguardando.configure,
                                           {"text": f"Baixando atualização... {baixado * 100 // total}%"})
                    if total and baixado < total:
                        raise IOError(f"download incompleto ({baixado} de {total} bytes)")
                    return
            except Exception as exc:
                ultimo_erro = exc
                self.after(0, self._log, f"  tentativa {tentativa}/{tentativas} falhou: {exc}")
                time.sleep(min(2 * tentativa, 10))
        raise ultimo_erro or IOError("download falhou")

    def _baixar_e_atualizar_bg(self, versao_nova: str) -> None:
        import zipfile
        exe_novo = Path(sys.executable).resolve().with_name(f"nfgo_attended_v{versao_nova}.exe")
        temp_zip = exe_novo.with_suffix(".zip.part")
        try:
            try:
                # .zip primeiro (antivírus/firewall costuma cortar .exe), .exe como reserva
                self._baixar_com_retomada(f"{hub_api.BASE_URL}/attended-nfgo/download-zip", temp_zip)
                with zipfile.ZipFile(temp_zip) as zf:
                    exe_novo.write_bytes(zf.read("nfgo_attended.exe"))
            except Exception as exc_zip:
                self.after(0, self._log, f"  .zip não deu ({exc_zip}); tentando o .exe direto...")
                self._baixar_com_retomada(f"{hub_api.BASE_URL}/attended-nfgo/download", exe_novo)
        except Exception as exc:
            self.after(0, self._falha_atualizacao, str(exc))
            return
        finally:
            temp_zip.unlink(missing_ok=True)
        # arquivo novo com outro nome (nunca sobrescreve o .exe rodando -
        # ver gui.py) e o atalho da Área de Trabalho passa a apontar pra ele
        _atualizar_atalho_desktop(exe_novo, True)
        subprocess.Popen(["cmd", "/c", "start", "", str(exe_novo)], creationflags=subprocess.CREATE_NO_WINDOW)
        os._exit(0)


def _abrir_hub() -> None:
    import webbrowser
    webbrowser.open("https://hub.redeg7.com")


def _esconder_console() -> None:
    import ctypes
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE


def main() -> None:
    # .exe montado com --windowed: não abre prompt nenhum. Sem console,
    # stdout/stderr vêm None - aponta pra nulo pra print/log de biblioteca
    # nunca quebrar fora do Andamento
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    _esconder_console()  # cobre quem rodar uma versão antiga, montada com console
    App().mainloop()


if __name__ == "__main__":
    main()

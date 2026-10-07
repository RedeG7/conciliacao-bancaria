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
            capture_output=True, text=True, timeout=180,
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
            capture_output=True, timeout=15,
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
        self.geometry("680x600")
        self.minsize(600, 520)
        self._config = _carregar_config()
        self._rodando = False
        self._evento_parar = threading.Event()
        self._hub_token = self._config.get("hub_token", "")
        self._montar_ui()
        if getattr(sys, "frozen", False):
            threading.Thread(
                target=_atualizar_atalho_desktop, args=(Path(sys.executable).resolve(), False), daemon=True,
            ).start()
        self.after(800, self._checar_atualizacao)

    def _montar_ui(self) -> None:
        pad = {"padx": 10, "pady": 6}

        f1 = ttk.LabelFrame(self, text="1. Abrir o portal da SEFAZ-GO e entrar")
        f1.pack(fill="x", **pad)
        ttk.Button(f1, text="Abrir portal no Edge", command=self._abrir_portal).grid(row=0, column=0, sticky="w", padx=8, pady=6)
        ttk.Label(
            f1,
            text="Na janela do Edge que abrir: entre com o certificado do escritório >\n"
                 "Acesso Restrito > Baixar XML NFE (e a nova autenticação, se pedir).\n"
                 "Deixe aberta a tela 'Consulta de Notas Recebidas' e o Edge em primeiro\n"
                 "plano até terminar. Se aparecer 'Verify you are human', clique você.",
            foreground="#555", justify="left",
        ).grid(row=1, column=0, sticky="w", padx=8, pady=(0, 6))

        f2 = ttk.LabelFrame(self, text="2. Login do Hub (a execução é criada lá, em 🧾 RPA NF GO)")
        f2.pack(fill="x", **pad)
        self.hub_usuario_var = tk.StringVar(value=self._config.get("hub_usuario", ""))
        ttk.Label(f2, text="Usuário do Hub:").grid(row=0, column=0, sticky="w", padx=8, pady=4)
        ttk.Entry(f2, textvariable=self.hub_usuario_var, width=55).grid(row=0, column=1, sticky="we", padx=8, pady=4)
        self.hub_senha_var = tk.StringVar(value="")  # senha nunca fica salva
        ttk.Label(f2, text="Senha:").grid(row=1, column=0, sticky="w", padx=8, pady=4)
        ttk.Entry(f2, textvariable=self.hub_senha_var, width=55, show="•").grid(row=1, column=1, sticky="we", padx=8, pady=4)
        ttk.Label(
            f2,
            text="Mesmo login/senha do site hub.redeg7.com. Só precisa digitar a senha\n"
                 "de novo se a sessão expirar (30 dias) ou trocar de usuário.",
            foreground="#555", justify="left",
        ).grid(row=2, column=0, columnspan=2, sticky="w", padx=8, pady=(0, 4))
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

        f4 = ttk.LabelFrame(self, text="Andamento")
        f4.pack(fill="both", expand=True, **pad)
        self.txt_log = tk.Text(f4, height=14, state="disabled", wrap="word")
        self.txt_log.pack(fill="both", expand=True, padx=6, pady=6)

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
        }

    def _iniciar(self) -> None:
        if self._rodando:
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

        _salvar_config(self._config_atual())
        self._rodando = True
        self._evento_parar.clear()
        self.btn_iniciar.configure(state="disabled", text="Processando...")
        self.btn_parar.configure(state="normal", text="⏹  Parar")
        self.txt_log.configure(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.configure(state="disabled")
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

    def _baixar_e_atualizar_bg(self, versao_nova: str) -> None:
        try:
            r = requests.get(f"{hub_api.BASE_URL}/attended-nfgo/download", timeout=300)
            r.raise_for_status()
            exe_novo = Path(sys.executable).resolve().with_name(f"nfgo_attended_v{versao_nova}.exe")
            exe_novo.write_bytes(r.content)
        except Exception as exc:
            self.after(0, messagebox.showerror, "Erro na atualização", f"Não consegui baixar a versão nova: {exc}")
            return
        # arquivo novo com outro nome (nunca sobrescreve o .exe rodando -
        # ver gui.py) e o atalho da Área de Trabalho passa a apontar pra ele
        _atualizar_atalho_desktop(exe_novo, True)
        subprocess.Popen(["cmd", "/c", "start", "", str(exe_novo)], creationflags=subprocess.CREATE_NO_WINDOW)
        os._exit(0)


def _esconder_console() -> None:
    import ctypes
    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE


def main() -> None:
    _esconder_console()
    App().mainloop()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Janela do Agente de Admissões (roda na sessão RDS, onde o Domínio está
aberto). Núcleo em admissoes_agent.py.

Fluxo: entrar com a conta do Hub dedicada ao agente > Iniciar. O programa
consulta o Hub a cada 15 s; quando há admissão na fila, monta a prévia
(pelo formulário do Acessórias ou com a IA ligada no Hub, em Canais e
agente › IA - as chaves ficam no Hub) e manda para o DP aprovar; quando o
DP aprova, com a Claude ligada, preenche o cadastro no Domínio em MODO
CONFERÊNCIA (não salva, não transmite).

A sessão RDS precisa ficar aberta (não minimizar, não desconectar) para o
agente enxergar e clicar na tela. Mouse no canto superior esquerdo da tela
interrompe a ação em andamento (FailSafe)."""

from __future__ import annotations

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

import admissoes_agent as agente  # noqa: E402
import hub_api  # noqa: E402

NOME_APP = "Agente de Admissões"
_PASTA_APP = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_PATH = _PASTA_APP / "admissoes_agente_config.json"
_PASTA_DADOS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
_SEM_JANELA = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _ler_versao_local() -> str:
    arq = _PASTA_DADOS / "VERSION_ADMISSOES"
    return arq.read_text(encoding="utf-8").strip() if arq.exists() else "0.0"


def _versao_maior(a: str, b: str) -> bool:
    def partes(v: str) -> list:
        return [int(p) for p in v.split(".") if p.strip().isdigit()]
    return partes(a) > partes(b)


VERSAO_ATUAL = _ler_versao_local()


def _carregar_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _salvar_config(dados: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(f"{NOME_APP} — v{VERSAO_ATUAL}")
        self.geometry("680x640")
        self.minsize(600, 560)
        self._config = _carregar_config()
        self._token = self._config.get("hub_token", "")
        self._parar = threading.Event()
        self._rodando = False
        self._montar_ui()
        self._atualizar_estado_login()
        self.after(800, self._checar_atualizacao)

    # -- tela -------------------------------------------------------------
    def _montar_ui(self) -> None:
        pad = {"padx": 10, "pady": 4}
        hub = ttk.LabelFrame(self, text="Conta do Hub (dedicada ao agente)")
        hub.pack(fill="x", **pad)
        ttk.Label(hub, text="Usuário").grid(row=0, column=0, sticky="w", padx=6, pady=3)
        self.ent_usuario = ttk.Entry(hub, width=30)
        self.ent_usuario.insert(0, self._config.get("hub_usuario", ""))
        self.ent_usuario.grid(row=0, column=1, sticky="w", padx=6)
        ttk.Label(hub, text="Senha").grid(row=1, column=0, sticky="w", padx=6, pady=3)
        self.ent_senha = ttk.Entry(hub, width=30, show="•")
        self.ent_senha.grid(row=1, column=1, sticky="w", padx=6)
        self.btn_entrar = ttk.Button(hub, text="Entrar", command=self._entrar)
        self.btn_entrar.grid(row=0, column=2, rowspan=2, padx=6)
        self.lbl_login = ttk.Label(hub, text="")
        self.lbl_login.grid(row=2, column=0, columnspan=3, sticky="w", padx=6, pady=(0, 4))

        ia_box = ttk.LabelFrame(self, text="Leitura dos documentos")
        ia_box.pack(fill="x", **pad)
        ttk.Label(ia_box, wraplength=600, justify="left", text=(
            "Escolhida no Hub, em Admissões › Canais e agente › IA (as chaves da Claude e da OpenAI ficam lá). "
            "IA desligada: usa os campos do formulário do Acessórias.")).pack(anchor="w", padx=6, pady=4)

        cfg = ttk.LabelFrame(self, text="Execução")
        cfg.pack(fill="x", **pad)
        ttk.Label(cfg, text="Pasta de trabalho").grid(row=0, column=0, sticky="w", padx=6, pady=3)
        self.ent_pasta = ttk.Entry(cfg, width=40)
        self.ent_pasta.insert(0, self._config.get("pasta", str(agente.PASTA_PADRAO)))
        self.ent_pasta.grid(row=0, column=1, sticky="w", padx=6)
        ttk.Label(cfg, text="Modo: CONFERÊNCIA — preenche o cadastro no Domínio e NÃO salva nem transmite.",
                  foreground="#9a3412").grid(row=1, column=0, columnspan=3, sticky="w", padx=6, pady=3)

        botoes = ttk.Frame(self)
        botoes.pack(fill="x", **pad)
        self.btn_iniciar = ttk.Button(botoes, text="▶ Iniciar", command=self._iniciar)
        self.btn_iniciar.pack(side="left")
        self.btn_parar = ttk.Button(botoes, text="■ Parar", command=self._parar_agente, state="disabled")
        self.btn_parar.pack(side="left", padx=6)
        self.lbl_status = ttk.Label(botoes, text="Parado")
        self.lbl_status.pack(side="left", padx=10)

        logf = ttk.LabelFrame(self, text="Andamento (sem dados pessoais)")
        logf.pack(fill="both", expand=True, **pad)
        self.txt_log = tk.Text(logf, height=14, state="disabled", wrap="word")
        self.txt_log.pack(fill="both", expand=True, padx=4, pady=4)

    def _log(self, texto: str) -> None:
        def escrever() -> None:
            self.txt_log.configure(state="normal")
            self.txt_log.insert("end", time.strftime("%H:%M:%S ") + texto + "\n")
            self.txt_log.see("end")
            self.txt_log.configure(state="disabled")
        self.after(0, escrever)

    def _atualizar_estado_login(self) -> None:
        usuario = self._config.get("hub_usuario", "")
        self.lbl_login.configure(text=f"Conectado como {usuario}" if self._token else "Não conectado")

    # -- ações ------------------------------------------------------------
    def _entrar(self) -> None:
        usuario, senha = self.ent_usuario.get().strip(), self.ent_senha.get()
        if not usuario or not senha:
            messagebox.showwarning(NOME_APP, "Informe usuário e senha do Hub.")
            return
        try:
            self._token = hub_api.login(usuario, senha)["token"]
        except hub_api.ErroHubApi as exc:
            messagebox.showerror(NOME_APP, str(exc))
            return
        self.ent_senha.delete(0, "end")
        self._config.update(hub_usuario=usuario, hub_token=self._token)
        _salvar_config(self._config)
        self._atualizar_estado_login()
        self._log("Conectado ao Hub.")

    def _iniciar(self) -> None:
        if not self._token:
            messagebox.showwarning(NOME_APP, "Entre com a conta do Hub primeiro.")
            return
        pasta = Path(self.ent_pasta.get().strip() or agente.PASTA_PADRAO)
        self._config["pasta"] = str(pasta)
        _salvar_config(self._config)
        try:
            from tela import Tela
            ctx = agente.Contexto(token=self._token, tela=Tela(),
                                  pasta=pasta, parar=self._parar, log=self._log)
        except Exception as exc:
            messagebox.showerror(NOME_APP, f"Não consegui preparar o agente: {exc}")
            return
        self._parar.clear()
        self._rodando = True
        self.btn_iniciar.configure(state="disabled")
        self.btn_parar.configure(state="normal")
        self.lbl_status.configure(text="Aguardando admissões...")
        self._log("Agente iniciado. Mantenha esta sessão RDS aberta.")
        threading.Thread(target=self._laco, args=(ctx,), daemon=True).start()

    def _parar_agente(self) -> None:
        self._parar.set()
        self.lbl_status.configure(text="Parando (termina a ação atual)...")

    def _laco(self, ctx: agente.Contexto) -> None:
        while not self._parar.is_set():
            try:
                resultado = agente.rodar_uma(ctx)
                if resultado is not None:
                    continue  # pode ter mais na fila
            except hub_api.ErroHubApi as exc:
                self._log(f"Erro: {exc}")
                if "faça login" in str(exc):
                    self._token = ""
                    self._config.pop("hub_token", None)
                    _salvar_config(self._config)
                    self.after(0, self._atualizar_estado_login)
                    break
            except Exception as exc:
                self._log(f"Erro inesperado: {type(exc).__name__}: {str(exc)[:200]}")
            self._parar.wait(agente.INTERVALO_S)
        self.after(0, self._parado)

    def _parado(self) -> None:
        self._rodando = False
        self.btn_iniciar.configure(state="normal")
        self.btn_parar.configure(state="disabled")
        self.lbl_status.configure(text="Parado")
        self._log("Agente parado.")

    # -- auto-atualização (mesmo esquema do gui_nfgo.py) -------------------
    def _checar_atualizacao(self) -> None:
        if getattr(sys, "frozen", False):
            threading.Thread(target=self._checar_atualizacao_bg, daemon=True).start()

    def _checar_atualizacao_bg(self) -> None:
        try:
            r = requests.get(f"{hub_api.BASE_URL}/attended-admissoes/versao", timeout=10)
            r.raise_for_status()
            versao_nova = r.json()["versao"]
        except Exception:
            return
        if _versao_maior(versao_nova, VERSAO_ATUAL):
            self.after(0, self._perguntar_atualizar, versao_nova)

    def _perguntar_atualizar(self, versao_nova: str) -> None:
        if self._rodando:
            self._log(f"Versão nova disponível (v{versao_nova}) - pare o agente e reabra para atualizar.")
            return
        if messagebox.askyesno(NOME_APP, f"Tem uma versão nova (v{versao_nova} — você está na v{VERSAO_ATUAL}).\n\n"
                               "Atualizar agora? O programa baixa a versão nova e reabre sozinho."):
            threading.Thread(target=self._baixar_e_atualizar_bg, args=(versao_nova,), daemon=True).start()

    def _baixar_e_atualizar_bg(self, versao_nova: str) -> None:
        import zipfile
        exe_novo = Path(sys.executable).resolve().with_name(f"admissoes_agente_v{versao_nova}.exe")
        temp_zip = exe_novo.with_suffix(".zip.part")
        try:
            with requests.get(f"{hub_api.BASE_URL}/attended-admissoes/download-zip", stream=True, timeout=60) as r:
                r.raise_for_status()
                with temp_zip.open("wb") as f:
                    for pedaco in r.iter_content(chunk_size=262144):
                        f.write(pedaco)
            with zipfile.ZipFile(temp_zip) as zf:
                exe_novo.write_bytes(zf.read("admissoes_agente.exe"))
        except Exception as exc:
            self._log(f"Atualização falhou: {exc}")
            return
        finally:
            temp_zip.unlink(missing_ok=True)
        subprocess.Popen(["cmd", "/c", "start", "", str(exe_novo)], creationflags=_SEM_JANELA)
        os._exit(0)


def main() -> None:
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    if os.environ.get("HUB_API_URL"):
        hub_api.BASE_URL = os.environ["HUB_API_URL"].rstrip("/")
    App().mainloop()


if __name__ == "__main__":
    main()

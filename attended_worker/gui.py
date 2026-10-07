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
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hub_api  # noqa: E402
import issnet_attended as core  # noqa: E402  (reusa toda a lógica já testada)

MUNICIPIOS = {"Goiânia": "goiania", "Aparecida de Goiânia": "aparecida"}
NOME_APP = "Prefeituras DMS_REST"

# quando empacotado como .exe (PyInstaller --onefile), sys.executable é o
# próprio .exe; __file__ aponta pra pasta temporária de extração, que não
# serve pra guardar config entre execuções.
_PASTA_APP = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_PATH = _PASTA_APP / "issnet_attended_config.json"

# _MEIPASS: pasta temporária onde o PyInstaller extrai os arquivos
# empacotados (--add-data) em modo --onefile - é de lá que o VERSION
# embutido é lido, não da pasta do .exe (que é só onde ele foi salvo).
_PASTA_DADOS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def _ler_versao_local() -> str:
    arq = _PASTA_DADOS / "VERSION"
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
    com nome novo (issnet_attended_v{versão}.exe, pra nunca mexer no
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
        self.title(f"{NOME_APP} — v{VERSAO_ATUAL}")
        self.geometry("680x600")
        self.minsize(600, 520)
        self._config = _carregar_config()
        self._rodando = False
        self._evento_parar = threading.Event()
        self._montar_ui()
        if getattr(sys, "frozen", False):
            # garante que o atalho fixo da Área de Trabalho aponte pra
            # ESTE .exe se ainda não existir - cobre o primeiro uso (a
            # pessoa ainda não tem atalho nenhum). Atualizações
            # seguintes reapontam o mesmo atalho pro .exe novo (ver
            # _baixar_e_atualizar_bg) - o atalho em si nunca muda de
            # nome/local, só o alvo.
            threading.Thread(
                target=_atualizar_atalho_desktop, args=(Path(sys.executable).resolve(), False), daemon=True,
            ).start()
        self.after(800, self._checar_atualizacao)

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
            f2, text="Sincronizar com o Hub", variable=self.modo_var, value="hub", command=self._atualizar_modo,
        ).grid(row=0, column=1, sticky="w", padx=8, pady=4)

        self.planilha_var = tk.StringVar(value=self._config.get("planilha", ""))
        self.lbl_planilha = ttk.Label(f2, text="Planilha:")
        self.ent_planilha = ttk.Entry(f2, textvariable=self.planilha_var, width=55)
        self.btn_planilha = ttk.Button(f2, text="Procurar...", command=self._escolher_planilha)

        self.hub_usuario_var = tk.StringVar(value=self._config.get("hub_usuario", ""))
        self.lbl_hub_usuario = ttk.Label(f2, text="Usuário do Hub:")
        self.ent_hub_usuario = ttk.Entry(f2, textvariable=self.hub_usuario_var, width=55)

        self.hub_senha_var = tk.StringVar(value="")  # senha nunca fica salva
        self.lbl_hub_senha = ttk.Label(f2, text="Senha:")
        self.ent_hub_senha = ttk.Entry(f2, textvariable=self.hub_senha_var, width=55, show="•")

        self._hub_token = self._config.get("hub_token", "")
        self.lbl_hub_info = ttk.Label(
            f2,
            text="Mesmo login/senha do site hub.redeg7.com. Só precisa digitar a senha\n"
                 "de novo se a sessão expirar (30 dias) ou trocar de usuário.",
            foreground="#555", justify="left",
        )

        f2.columnconfigure(1, weight=1)

        f3 = ttk.LabelFrame(self, text="3. Pasta onde salvar os PDFs")
        f3.pack(fill="x", **pad)
        self.pasta_var = tk.StringVar(value=self._config.get("pasta_raiz", str(Path.home() / "Prefeituras")))
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

        self._atualizar_modo()

    def _atualizar_modo(self) -> None:
        if self.modo_var.get() == "planilha":
            self.lbl_hub_usuario.grid_forget()
            self.ent_hub_usuario.grid_forget()
            self.lbl_hub_senha.grid_forget()
            self.ent_hub_senha.grid_forget()
            self.lbl_hub_info.grid_forget()
            self.lbl_planilha.grid(row=1, column=0, sticky="w", padx=8)
            self.ent_planilha.grid(row=1, column=1, sticky="we", padx=8)
            self.btn_planilha.grid(row=1, column=2, padx=8)
        else:
            self.lbl_planilha.grid_forget()
            self.ent_planilha.grid_forget()
            self.btn_planilha.grid_forget()
            self.lbl_hub_usuario.grid(row=1, column=0, sticky="w", padx=8, pady=4)
            self.ent_hub_usuario.grid(row=1, column=1, sticky="we", padx=8, pady=4)
            self.lbl_hub_senha.grid(row=2, column=0, sticky="w", padx=8, pady=4)
            self.ent_hub_senha.grid(row=2, column=1, sticky="we", padx=8, pady=4)
            self.lbl_hub_info.grid(row=3, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 4))

    # ------------------------------------------------------------------
    # ações
    # ------------------------------------------------------------------

    def _url_portal(self) -> str:
        slug = MUNICIPIOS[self.municipio_var.get()]
        return f"https://www.issnetonline.com.br/{slug}/online/login/login.aspx"

    def _abrir_portal(self) -> None:
        url = self._url_portal()
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
        caminho = _selecionar_pasta_nativa(self._pasta_inicial_valida(self.pasta_var.get()))
        if caminho:
            self.pasta_var.set(caminho)

    def _log(self, texto: str) -> None:
        self.txt_log.configure(state="normal")
        self.txt_log.insert("end", texto + "\n")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _config_atual(self) -> dict:
        return {
            "municipio": self.municipio_var.get(),
            "modo": self.modo_var.get(),
            "planilha": self.planilha_var.get().strip(),
            "pasta_raiz": self.pasta_var.get().strip(),
            "hub_usuario": self.hub_usuario_var.get().strip(),
            "hub_token": self._hub_token,
        }

    def _iniciar(self) -> None:
        if self._rodando:
            return

        modo = self.modo_var.get()
        pasta = self.pasta_var.get().strip()
        if not pasta:
            messagebox.showwarning("Faltou informação", "Escolha a pasta de destino.")
            return

        planilha = self.planilha_var.get().strip()
        hub_usuario = self.hub_usuario_var.get().strip()
        hub_senha = self.hub_senha_var.get()
        if modo == "planilha":
            if not planilha or not Path(planilha).exists():
                messagebox.showwarning("Faltou informação", "Escolha uma planilha válida (.xlsx).")
                return
        else:
            if not hub_usuario:
                messagebox.showwarning("Faltou informação", "Informe o usuário do Hub.")
                return
            tem_sessao_salva = bool(self._hub_token) and self._config.get("hub_usuario") == hub_usuario
            if not hub_senha and not tem_sessao_salva:
                messagebox.showwarning(
                    "Faltou informação",
                    "Informe a senha (primeira vez usando este usuário, ou sessão expirada).",
                )
                return

        _salvar_config(self._config_atual())

        self._rodando = True
        self._evento_parar.clear()
        self.btn_iniciar.configure(state="disabled", text="Processando...")
        self.btn_parar.configure(state="normal", text="⏹  Parar")
        self.txt_log.configure(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.configure(state="disabled")

        # URL lida aqui (thread principal) - StringVar.get() de dentro da
        # thread de processamento não é seguro no Tkinter.
        url_portal = self._url_portal()
        threading.Thread(
            target=self._rodar, args=(modo, planilha, hub_usuario, hub_senha, pasta, url_portal), daemon=True,
        ).start()

    def _parar(self) -> None:
        """Sinaliza pra parar ANTES da próxima empresa (ver `deve_parar` em
        processar_planilha/processar_execucao_hub) - nunca interrompe no
        meio de uma empresa, pra nunca deixar o navegador/arquivo pela
        metade. Por isso o processamento ainda continua rodando por um
        tempinho depois do clique, até terminar a empresa atual."""
        if not self._rodando:
            return
        self._evento_parar.set()
        self.btn_parar.configure(state="disabled", text="Parando...")

    def _obter_token_hub(self, usuario: str, senha: str) -> str:
        """Reusa a sessão salva se a senha não foi digitada de novo (mesmo
        usuário de antes); senão faz login de verdade e guarda o token
        novo - a senha em si NUNCA é salva em disco."""
        if not senha and self._hub_token and self._config.get("hub_usuario") == usuario:
            return self._hub_token
        dados = core.hub_api.login(usuario, senha)
        self._hub_token = dados["token"]
        self.after(0, self._log, f"Login OK — {dados.get('nome', usuario)}")
        _salvar_config(self._config_atual())
        return self._hub_token

    def _rodar(
        self, modo: str, planilha: str, hub_usuario: str, hub_senha: str, pasta: str, url_portal: str,
    ) -> None:
        saida = _LogParaWidget(self)
        erro_msg = None
        try:
            with contextlib.redirect_stdout(saida):
                if modo == "planilha":
                    core.processar_planilha(
                        Path(planilha), Path(pasta), deve_parar=self._evento_parar.is_set, url_portal=url_portal,
                    )
                else:
                    token = self._obter_token_hub(hub_usuario, hub_senha)
                    core.processar_execucao_hub(
                        token, Path(pasta), deve_parar=self._evento_parar.is_set, url_portal=url_portal,
                    )
            self.after(0, self._log, "\n✅ Terminado.")
        except core.hub_api.ErroHubApi as exc:
            erro_msg = str(exc)
            self.after(0, self._log, f"\n❌ {exc}")
        except core.ErroAttended as exc:
            erro_msg = str(exc)
            self.after(0, self._log, f"\n❌ {exc}")
        except Exception as exc:  # nunca deixa a GUI travar por uma exceção não prevista
            erro_msg = str(exc)
            self.after(0, self._log, f"\n❌ ERRO INESPERADO: {exc}")
        finally:
            self.after(0, self._finalizar, erro_msg)

    def _finalizar(self, erro_msg: "str | None" = None) -> None:
        parado_pelo_usuario = self._evento_parar.is_set()
        self._rodando = False
        self._evento_parar.clear()
        self.btn_iniciar.configure(state="normal", text="▶  Iniciar processamento")
        self.btn_parar.configure(state="disabled", text="⏹  Parar")
        self._trazer_para_frente()
        if erro_msg:
            messagebox.showerror("Concluído com erro", f"O processamento parou:\n\n{erro_msg}")
        elif parado_pelo_usuario:
            messagebox.showinfo("Parado", "Processamento interrompido a pedido. Veja o resumo na caixa Andamento.")
        else:
            messagebox.showinfo("Concluído", "Processamento concluído! Veja o resumo na caixa Andamento.")

    def _trazer_para_frente(self) -> None:
        """Traz a janela pra frente (mesmo se tiver minimizada ou atrás do
        Edge, onde ela fica o tempo todo enquanto processa) - pedido do
        usuário: sem isso, a mensagem de conclusão passava despercebida
        porque a janela do programa nunca é a que fica em foco durante o
        processamento (é o Edge que precisa ficar em primeiro plano)."""
        self.deiconify()
        self.lift()
        self.attributes("-topmost", True)
        self.after(300, lambda: self.attributes("-topmost", False))
        self.focus_force()

    # ------------------------------------------------------------------
    # auto-atualização
    # ------------------------------------------------------------------

    def _checar_atualizacao(self) -> None:
        # só faz sentido pro .exe empacotado - rodando como script solto
        # (dev) não tem um único arquivo pra substituir sozinho.
        if not getattr(sys, "frozen", False):
            return
        threading.Thread(target=self._checar_atualizacao_bg, daemon=True).start()

    def _checar_atualizacao_bg(self) -> None:
        try:
            r = requests.get(f"{hub_api.BASE_URL}/attended/versao", timeout=10)
            r.raise_for_status()
            versao_nova = r.json()["versao"]
        except Exception:
            return  # sem internet/servidor fora do ar - nunca trava o uso normal por causa disso
        if _versao_maior(versao_nova, VERSAO_ATUAL):
            self.after(0, self._perguntar_atualizar, versao_nova)

    def _perguntar_atualizar(self, versao_nova: str) -> None:
        se_atualiza = messagebox.askyesno(
            "Atualização disponível",
            f"Tem uma versão nova (v{versao_nova} — você está na v{VERSAO_ATUAL}).\n\n"
            "Atualizar agora? O programa baixa a versão nova e reabre sozinho.",
        )
        if se_atualiza:
            self._baixar_e_atualizar(versao_nova)

    def _baixar_e_atualizar(self, versao_nova: str) -> None:
        """Mostra uma janelinha com barra de progresso durante o download
        (pedido do usuário - antes baixava mudo, sem feedback nenhum) e só
        troca/reabre depois de confirmar "Atualização concluída"."""
        janela = tk.Toplevel(self)
        janela.title("Atualizando")
        janela.geometry("380x130")
        janela.resizable(False, False)
        janela.transient(self)
        janela.grab_set()
        janela.protocol("WM_DELETE_WINDOW", lambda: None)  # não deixa fechar no meio do download
        ttk.Label(janela, text=f"Baixando versão {versao_nova}...").pack(pady=(18, 8))
        barra = ttk.Progressbar(janela, orient="horizontal", length=320, mode="determinate")
        barra.pack(pady=4)
        lbl_status = ttk.Label(janela, text="")
        lbl_status.pack(pady=(4, 12))

        threading.Thread(
            target=self._baixar_e_atualizar_bg, args=(janela, barra, lbl_status, versao_nova), daemon=True,
        ).start()

    def _baixar_e_atualizar_bg(
        self, janela: tk.Toplevel, barra: ttk.Progressbar, lbl_status: ttk.Label, versao_nova: str,
    ) -> None:
        def _atualizar(pct: int, texto: str) -> None:
            barra["value"] = pct
            lbl_status.configure(text=texto)

        try:
            with requests.get(f"{hub_api.BASE_URL}/attended/download", stream=True, timeout=180) as r:
                r.raise_for_status()
                total = int(r.headers.get("Content-Length") or 0)
                baixado = 0
                pedacos = []
                for pedaco in r.iter_content(chunk_size=262144):
                    if not pedaco:
                        continue
                    pedacos.append(pedaco)
                    baixado += len(pedaco)
                    pct = int(baixado * 100 / total) if total else 0
                    texto = f"{pct}% ({baixado // 1024} KB / {total // 1024} KB)" if total else f"{baixado // 1024} KB baixados"
                    self.after(0, _atualizar, pct, texto)
                conteudo = b"".join(pedacos)
        except Exception as exc:
            self.after(0, janela.destroy)
            self.after(0, messagebox.showerror, "Erro na atualização", f"Não consegui baixar a versão nova: {exc}")
            return

        # NÃO troca o arquivo antigo no lugar (era o que fazia antes, via
        # .bat: baixava, esperava este processo encerrar, MOVIA por cima
        # do .exe atual e reabria) - confirmado ao vivo que isso falhava
        # silenciosamente num PC de usuário (o novo ficava baixado do
        # lado, mas o "move" nunca completava e nada reabria sozinho).
        # Um executável se auto-substituindo é exatamente o padrão que
        # antivírus/Windows Defender tende a barrar sem avisar. Mais
        # simples e confiável: salva com um nome novo (com a versão) e
        # abre ELE diretamente - nunca mexe no arquivo antigo, que fica
        # do lado (a pessoa pode apagar na mão quando quiser).
        exe_atual = Path(sys.executable).resolve()
        exe_novo = exe_atual.with_name(f"issnet_attended_v{versao_nova}.exe")
        try:
            exe_novo.write_bytes(conteudo)
        except Exception as exc:
            self.after(0, janela.destroy)
            self.after(0, messagebox.showerror, "Erro na atualização", f"Não consegui salvar a versão nova: {exc}")
            return

        # reaponta o atalho fixo da Área de Trabalho pra este .exe novo -
        # ANTES de abrir, senão a pessoa fecha e da próxima vez clica no
        # mesmo ícone de sempre e cai de volta na versão antiga.
        _atualizar_atalho_desktop(exe_novo, True)

        self.after(0, _atualizar, 100, "✅ Atualização concluída — abrindo o programa...")
        time.sleep(1.5)  # dá tempo da pessoa ler "Atualização concluída" antes de sumir

        subprocess.Popen(["cmd", "/c", "start", "", str(exe_novo)], creationflags=subprocess.CREATE_NO_WINDOW)
        os._exit(0)


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

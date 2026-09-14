#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Interface web (Streamlit) para o script conciliacao_bancaria.py

Rodar:
    streamlit run app_conciliacao.py

Permite:
  - Upload direto dos 3 arquivos (extrato, razao, balancete), OU
  - Informar o caminho de uma pasta no disco e o app identifica os
    arquivos automaticamente pelo nome (extrato/fluxo, razao, balancete).
  - Informar codigo da empresa no Dominio + demais parametros.
  - Ver o espelho de conciliacao na tela e baixar os 3 entregaveis
    (espelho .md, memoria .csv, importacao Dominio .txt).
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Optional

import streamlit as st

import conciliacao_bancaria as cb

st.set_page_config(page_title="Conciliacao Bancaria", page_icon="🏦", layout="wide")

st.title("🏦 Conciliação Bancária Automatizada")
st.caption("Extrato/fluxo de caixa × razão contábil × balancete → espelho + arquivo de importação Domínio")

# ---------------------------------------------------------------------------
# Deteccao automatica de arquivos numa pasta
# ---------------------------------------------------------------------------

_PADROES = {
    "extrato": ["extrato", "fluxo", "movimento", "ofx"],
    "razao": ["razao", "razão", "livro razao"],
    "balancete": ["balancete", "balanco", "balanço"],
}


def _identificar_arquivos_na_pasta(pasta: Path) -> dict:
    """Varre a pasta e tenta identificar extrato/razao/balancete pelo nome.
    Retorna dict {categoria: [candidatos]} - nao decide sozinho quando ha
    mais de um candidato, deixa o usuario escolher na interface."""
    candidatos = {k: [] for k in _PADROES}
    exts_validas = {".ofx", ".csv", ".pdf"}
    for f in pasta.iterdir():
        if not f.is_file() or f.suffix.lower() not in exts_validas:
            continue
        nome = f.name.lower()
        for categoria, termos in _PADROES.items():
            if any(t in nome for t in termos):
                candidatos[categoria].append(f)
    return candidatos


# ---------------------------------------------------------------------------
# Sidebar - parametros gerais
# ---------------------------------------------------------------------------

with st.sidebar:
    st.header("Parâmetros")
    empresa_codigo = st.text_input("Código da empresa no Domínio *", placeholder="Ex: 123")
    competencia = st.text_input(
        "Competência (MM-AAAA)",
        value="",
        placeholder="Ex: 01-2026 — deixe em branco p/ detectar do balancete",
        help="Se deixado em branco, a competência é detectada automaticamente a partir do texto do balancete informado.",
    )

    col1, col2 = st.columns(2)
    with col1:
        saldo_inicial_razao = st.number_input("Saldo inicial razão (R$)", value=0.0, step=0.01, format="%.2f")
    with col2:
        saldo_inicial_extrato = st.number_input("Saldo inicial extrato (R$)", value=0.0, step=0.01, format="%.2f")

    with st.expander("Avançado"):
        dias_tolerancia = st.number_input("Dias de tolerância no match (cheques)", value=0, min_value=0, max_value=15)
        cod_historico = st.text_input("Código de histórico padrão Domínio", value="",
                                       help="Confirme contra a tabela de históricos do escritório antes de importar.")

st.divider()

# ---------------------------------------------------------------------------
# Escolha de origem dos arquivos: upload ou pasta
# ---------------------------------------------------------------------------

modo = st.radio("Como fornecer os arquivos?", ["Upload de arquivos", "Caminho de uma pasta"], horizontal=True)

extrato_path: Optional[str] = None
razao_path: Optional[str] = None
balancete_path: Optional[str] = None

if "tmpdir" not in st.session_state:
    st.session_state.tmpdir = Path(tempfile.mkdtemp(prefix="conc_upload_"))
_tmpdir = st.session_state.tmpdir


def _salvar_upload(uploaded_file, destino_nome: str) -> str:
    destino = _tmpdir / destino_nome
    destino.write_bytes(uploaded_file.getvalue())
    return str(destino)


if modo == "Upload de arquivos":
    c1, c2, c3 = st.columns(3)
    with c1:
        up_extrato = st.file_uploader("Extrato / fluxo de caixa", type=["ofx", "csv", "pdf"], key="up_extrato")
    with c2:
        up_razao = st.file_uploader("Razão contábil da conta (opcional)", type=["csv", "pdf"], key="up_razao")
    with c3:
        up_balancete = st.file_uploader("Balancete", type=["csv", "pdf"], key="up_balancete")

    if up_extrato:
        extrato_path = _salvar_upload(up_extrato, f"extrato{Path(up_extrato.name).suffix}")
    if up_razao:
        razao_path = _salvar_upload(up_razao, f"razao{Path(up_razao.name).suffix}")
    if up_balancete:
        balancete_path = _salvar_upload(up_balancete, f"balancete{Path(up_balancete.name).suffix}")

else:
    pasta_str = st.text_input("Caminho da pasta com os arquivos", placeholder=r"C:\Clientes\EmpresaX\2026-01")
    if pasta_str:
        pasta = Path(pasta_str)
        if not pasta.is_dir():
            st.error(f"Pasta não encontrada: {pasta_str}")
        else:
            candidatos = _identificar_arquivos_na_pasta(pasta)
            st.write("Arquivos identificados automaticamente (confira/ajuste antes de rodar):")
            c1, c2, c3 = st.columns(3)

            def _seletor(col, categoria, label):
                opcoes = candidatos[categoria] or list(pasta.glob("*"))
                opcoes_validas = [f for f in opcoes if f.is_file() and f.suffix.lower() in (".ofx", ".csv", ".pdf")]
                nomes = ["(selecione)"] + [f.name for f in opcoes_validas]
                with col:
                    escolha = st.selectbox(label, nomes, key=f"sel_{categoria}")
                if escolha != "(selecione)":
                    return str(pasta / escolha)
                return None

            extrato_path = _seletor(c1, "extrato", "Extrato")
            razao_path = _seletor(c2, "razao", "Razão (opcional)")
            balancete_path = _seletor(c3, "balancete", "Balancete")

# ---------------------------------------------------------------------------
# Conta banco: identificada automaticamente cruzando extrato x balancete.
# O usuario nao "lanca" nada aqui - so confirma se o app pedir, quando a
# identificacao automatica fica ambigua.
# ---------------------------------------------------------------------------


@st.cache_data(show_spinner=False)
def _parse_balancete_cached(path: str, _mtime: float):
    return cb.parse_balancete(path)


@st.cache_data(show_spinner=False)
def _detectar_conta_banco_cached(extrato_path: str, _extrato_mtime: float,
                                  balancete_path: str, _balancete_mtime: float):
    contas = _parse_balancete_cached(balancete_path, _balancete_mtime)
    return cb.detectar_conta_banco(extrato_path, contas)


conta_contabil: Optional[str] = None

if balancete_path:
    try:
        contas_balancete = _parse_balancete_cached(balancete_path, Path(balancete_path).stat().st_mtime)
    except Exception as exc:
        st.error(f"Erro ao ler o balancete: {exc}")
        contas_balancete = []

    if contas_balancete:
        conta_auto = None
        if extrato_path:
            conta_auto = _detectar_conta_banco_cached(
                extrato_path, Path(extrato_path).stat().st_mtime,
                balancete_path, Path(balancete_path).stat().st_mtime,
            )

        if conta_auto and not st.session_state.get("forcar_escolha_conta"):
            conta_contabil = conta_auto.nome
            st.success(f"Conta banco identificada automaticamente a partir do extrato: "
                       f"{conta_auto.codigo} — {conta_auto.nome}")
            if st.button("Não é essa conta — escolher manualmente"):
                st.session_state["forcar_escolha_conta"] = True
                st.rerun()
        else:
            if not extrato_path:
                st.info("Informe o extrato para o app tentar identificar a conta banco automaticamente "
                         "(cruzando o banco do extrato com o balancete).")
            else:
                st.warning("Não consegui identificar a conta banco automaticamente a partir do extrato — "
                            "confirme qual é, abaixo (o balancete continua sendo a fonte de verdade).")
            provaveis = cb.contas_provaveis_banco(contas_balancete)
            mostrar_todas = st.checkbox(
                "Mostrar todas as contas do balancete (em vez de só as prováveis de banco/caixa)",
                value=not provaveis,
            )
            opcoes = contas_balancete if (mostrar_todas or not provaveis) else provaveis
            rotulos = ["(selecione)"] + [f"{c.codigo} — {c.nome}" for c in opcoes]
            escolha = st.selectbox("Conta banco a conciliar (lida do balancete) *", rotulos, key="sel_conta_banco")
            if escolha != "(selecione)":
                conta_contabil = opcoes[rotulos.index(escolha) - 1].nome
                if st.session_state.get("forcar_escolha_conta"):
                    if st.button("Voltar para identificação automática"):
                        st.session_state["forcar_escolha_conta"] = False
                        st.rerun()
else:
    st.info("Informe o balancete acima para o app identificar, a partir dele, qual conta banco será conciliada.")

st.divider()

# ---------------------------------------------------------------------------
# Execucao
# ---------------------------------------------------------------------------

pronto = all([extrato_path, balancete_path, empresa_codigo, conta_contabil])

if not pronto:
    st.info("Preencha o código da empresa, informe extrato + balancete (razão é opcional) e escolha a conta banco "
             "(a partir do balancete) — a conciliação roda automaticamente assim que tudo estiver pronto. "
             "Competência também é opcional: se deixada em branco, é detectada do balancete.")

if pronto:

    def _mtime(path: Optional[str]) -> float:
        return Path(path).stat().st_mtime if path else 0.0

    @st.cache_data(show_spinner=False)
    def _processar_cached(
        extrato_path, razao_path, balancete_path, conta_contabil, competencia,
        saldo_inicial_razao, saldo_inicial_extrato, dias_tolerancia,
        _extrato_mtime, _razao_mtime, _balancete_mtime,
    ):
        log = []
        _print_original = print
        import builtins
        def _capture_print(*a, **kw):
            log.append(" ".join(str(x) for x in a))
        builtins.print = _capture_print
        try:
            resultado = cb.processar(
                extrato_path=extrato_path,
                razao_path=razao_path,
                balancete_path=balancete_path,
                conta_contabil_nome=conta_contabil,
                competencia=competencia or None,
                saldo_inicial_razao=saldo_inicial_razao,
                saldo_inicial_extrato=saldo_inicial_extrato,
                dias_tolerancia=dias_tolerancia,
            )
        finally:
            builtins.print = _print_original
        return resultado, log

    out_dir = _tmpdir / "saida"
    out_dir.mkdir(exist_ok=True)

    with st.spinner("Conciliando automaticamente..."):
        try:
            # cache_data devolve uma COPIA a cada chamada - seguro mutar
            # `resultado` abaixo (aplicar_contrapartida_padrao) sem
            # corromper o que ficou em cache.
            resultado, log = _processar_cached(
                extrato_path, razao_path, balancete_path, conta_contabil, competencia,
                saldo_inicial_razao, saldo_inicial_extrato, int(dias_tolerancia),
                _mtime(extrato_path), _mtime(razao_path), _mtime(balancete_path),
            )
        except Exception as exc:
            st.error(f"Erro ao processar: {exc}")
            st.stop()

    if not razao_path:
        st.info("Razão não informada — todos os itens do extrato foram tratados como pendentes de lançamento "
                 "(sem uma razão prévia para comparar).")

    # -----------------------------------------------------------------
    # Correcao em massa: pendencias sem contrapartida especifica podem
    # receber uma conta padrao (ex.: Fornecedores / Adiantamento de
    # Clientes) aplicada de uma vez a TODAS as saidas/entradas nessa
    # situacao - assim elas entram no arquivo de importacao Dominio em
    # vez de ficarem de fora. O balancete continua sendo a fonte: so
    # aparecem contas que realmente existem nele.
    # -----------------------------------------------------------------
    pendentes_sem_conta = [m for m in resultado.pendentes_banco if m.status == "conta_nao_identificada"]
    qtd_saida = sum(1 for m in pendentes_sem_conta if m.valor < 0)
    qtd_entrada = sum(1 for m in pendentes_sem_conta if m.valor >= 0)
    conta_saida_codigo: Optional[str] = None
    conta_entrada_codigo: Optional[str] = None

    if pendentes_sem_conta:
        st.warning(
            f"{len(pendentes_sem_conta)} pendência(s) sem contrapartida específica identificada "
            f"({qtd_saida} saída(s), {qtd_entrada} entrada(s)) — sem uma conta escolhida abaixo, "
            "elas ficam de fora do arquivo de importação Domínio (nunca inventamos o código)."
        )
        rotulos_contas = ["(não atribuir)"] + [f"{c.codigo} — {c.nome}" for c in resultado.contas]
        csa, cse = st.columns(2)
        if qtd_saida:
            with csa:
                escolha = st.selectbox(
                    f"Conta padrão para as {qtd_saida} saída(s) sem fornecedor identificado",
                    rotulos_contas, key="sel_conta_saida_padrao",
                )
                if escolha != "(não atribuir)":
                    conta_saida_codigo = escolha.split(" — ")[0]
        if qtd_entrada:
            with cse:
                escolha = st.selectbox(
                    f"Conta padrão para as {qtd_entrada} entrada(s) sem identificação",
                    rotulos_contas, key="sel_conta_entrada_padrao",
                )
                if escolha != "(não atribuir)":
                    conta_entrada_codigo = escolha.split(" — ")[0]

        if conta_saida_codigo or conta_entrada_codigo:
            qtd_aplicados = cb.aplicar_contrapartida_padrao(
                resultado.pendentes_banco, resultado.conta_banco,
                conta_saida_codigo=conta_saida_codigo, conta_entrada_codigo=conta_entrada_codigo,
            )
            st.success(f"{qtd_aplicados} pendência(s) resolvida(s) com a conta padrão escolhida — "
                       "já entram no arquivo de importação Domínio abaixo.")

    log_saidas = []
    _print_original = print
    import builtins
    def _capture_print(*a, **kw):
        log_saidas.append(" ".join(str(x) for x in a))
    builtins.print = _capture_print
    try:
        info = cb.gerar_saidas(str(out_dir), resultado, empresa_codigo=empresa_codigo, cod_historico=cod_historico)
    finally:
        builtins.print = _print_original

    st.success(f"Conciliação concluída automaticamente — competência: {resultado.competencia}.")

    with st.expander("Log de execução"):
        st.code("\n".join(log + log_saidas))

    espelho_path = info["espelho_path"]
    memoria_path = info["memoria_path"]
    import_path = info["import_path"]

    espelho_texto = espelho_path.read_text(encoding="utf-8")
    diferenca_ok = "DIFERENCA: R$ 0,00" in espelho_texto or "DIFERENCA: -R$ 0,00" in espelho_texto
    if diferenca_ok:
        st.success("Saldo fechou com tolerância ZERO ✓")
    else:
        st.warning("Saldo NÃO fechou — revise as pendências abaixo antes de importar.")

    st.caption(f"Arquivo de importação Domínio: {info['qtd_prontos']} lançamento(s) pronto(s) "
               f"(de {len(resultado.pendentes_banco)} pendência(s) do extrato).")

    st.subheader("Espelho de conciliação")
    st.markdown(espelho_texto)

    st.subheader("Downloads")
    dl1, dl2, dl3 = st.columns(3)
    with dl1:
        st.download_button("⬇ Espelho (.md)", espelho_path.read_bytes(),
                            file_name=espelho_path.name, mime="text/markdown")
    with dl2:
        st.download_button("⬇ Memória (.csv)", memoria_path.read_bytes(),
                            file_name=memoria_path.name, mime="text/csv")
    with dl3:
        st.download_button("⬇ Importação Domínio (.txt)", import_path.read_bytes(),
                            file_name=import_path.name, mime="text/plain")

    st.caption("Antes de importar no Domínio: confira o código de histórico contra a tabela do escritório. "
               "O .txt de importação segue sempre o leiaute de 10 colunas separadas por ';' — pendências "
               "marcadas 'A CONFIRMAR' no espelho acima nunca entram nesse arquivo com texto inválido; "
               "elas só entram quando resolvidas (individualmente ou via conta padrão em massa acima).")

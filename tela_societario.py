"""Tela do Hub Societário (Streamlit). Os dados e as regras ficam em
societario.py; aqui só telas, filtros e botões. Chamada por
app_conciliacao.py: render(cabecalho_app, pode_configurar, eh_global),
menu_lateral(pode_configurar) e popup_lembretes(...)."""

from __future__ import annotations

import html
import json
from pathlib import Path
from datetime import date, datetime, time, timedelta
from typing import Callable

import streamlit as st
import streamlit.components.v1 as components

import auth
import clientes
import societario as so

_COR_NIVEL = {so.CRITICO: "#ef4444", so.ATENCAO: "#f59e0b", so.INFO: "#3b82f6"}
_ROT_NIVEL = {so.CRITICO: "Urgente", so.ATENCAO: "Atenção", so.INFO: "Acompanhar"}
_COR_ETAPA = {so.A_INICIAR: "#64748b", so.EM_ELABORACAO: "#3b82f6", so.EM_ANALISE: "#a855f7",
              so.PROTOCOLADO: "#14b8a6", so.EM_EXIGENCIA: "#ef4444", so.CONCLUIDO: "#22e08a",
              so.CANCELADO: "#475569"}
# Kanban com arrastar e soltar (componente em componentes/soc_kanban/index.html)
_kanban = components.declare_component("soc_kanban", path=str(Path(__file__).parent / "componentes" / "soc_kanban"))

_COR_LIC = {so.VIGENTE: "#22e08a", so.A_VENCER: "#f59e0b", so.VENCIDA: "#ef4444", so.SEM_VALIDADE: "#94a3b8"}
_COR_GRAV = {"alta": "#ef4444", "media": "#f59e0b", "baixa": "#3b82f6"}

_SECOES = [
    ("Visão geral", ":material/dashboard:"),
    ("Processos", ":material/view_kanban:"),
    ("Novo processo", ":material/add_circle:"),
    ("Empresas", ":material/domain:"),
    ("Protocolos", ":material/assignment_turned_in:"),
    ("Licenças", ":material/verified:"),
    ("Agenda", ":material/event:"),
    ("Documentos", ":material/folder_open:"),
    ("Assistente IA", ":material/auto_awesome:"),
    ("Relatórios", ":material/bar_chart:"),
    ("Configurações", ":material/settings:"),
]

# ícone e descrição de cada tipo, para os cartões de "Novo processo"
_CARTAO_TIPO = {
    "constituicao": (":material/domain_add:", "Abertura, registro e inscrições."),
    "alteracao": (":material/edit_document:", "Sócios, endereço, capital, CNAE e outros."),
    "baixa": (":material/domain_disabled:", "Distrato e encerramento."),
    "alvara": (":material/storefront:", "Emissão e renovação."),
    "bombeiros": (":material/local_fire_department:", "Licenciamento e regularização."),
    "sanitaria": (":material/health_and_safety:", "Licenças sanitárias."),
    "ambiental": (":material/eco:", "Emissão e acompanhamento."),
    "regularizacao": (":material/account_balance:", "Receita Federal, Junta, SEFAZ e Prefeitura."),
    "outro": (":material/more_horiz:", "Qualquer outro processo do departamento."),
}

# ícone (caractere) e cor de cada tipo de andamento na linha do tempo
_ICONE_ANDAMENTO = {
    "abertura": ("+", "#22e08a"), "ia": ("✦", "#a855f7"), "protocolo": ("⇢", "#14b8a6"),
    "exigencia": ("!", "#ef4444"), "concluido": ("✓", "#22e08a"), "cancelado": ("×", "#64748b"),
    "anexo": ("⎘", "#3b82f6"), "etapa": ("→", "#3b82f6"), "dados": ("✎", "#94a3b8"), "nota": ("•", "#94a3b8"),
}

_ROT_ANEXO = {"minuta": "Minuta", "minuta_revisada": "Minuta revisada (IA)", "documento": "Documento",
              "comprovante": "Comprovante"}


def _estilo() -> None:
    st.markdown("""<style>
    .soc-kpis {display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:4px 0 14px;}
    .soc-kpi {background:#111a2c; border:1px solid rgba(255,255,255,.07); border-radius:14px; padding:14px 16px;}
    .soc-kpi .l {color:#94a3b8; font-size:.82rem;} .soc-kpi .v {font-size:1.9rem; font-weight:800; line-height:1.15;}
    .soc-card {background:#111a2c; border:1px solid rgba(255,255,255,.07); border-radius:14px; padding:14px 16px;
               margin-bottom:10px;}
    .soc-card h4 {margin:0 0 10px; font-size:1rem;}
    .soc-bar {margin:7px 0;} .soc-bar .t {display:flex; justify-content:space-between; font-size:.86rem;}
    .soc-bar .tr {background:rgba(255,255,255,.07); border-radius:6px; height:9px; overflow:hidden;}
    .soc-bar .tr span {display:block; height:100%; background:#22e08a;}
    .soc-al {border-left:4px solid; border-radius:10px; padding:8px 12px; margin:6px 0; background:rgba(255,255,255,.03);}
    .soc-al .e {font-weight:700;} .soc-al .s {color:#94a3b8; font-size:.8rem;}
    .soc-chip {display:inline-block; padding:1px 9px; border-radius:999px; font-size:.75rem; font-weight:600;
               border:1px solid; margin-right:4px;}
    .soc-muted {color:#94a3b8; font-size:.82rem;}
    .soc-col-h {font-weight:700; font-size:.9rem; padding:6px 10px; border-radius:10px; margin-bottom:8px;
                background:rgba(255,255,255,.04); border-top:3px solid;}
    .soc-tl {border-left:2px solid rgba(255,255,255,.12); margin-left:8px; padding-left:16px;}
    .soc-tl .i {position:relative; margin-bottom:14px;}
    .soc-tl .ic {position:absolute; left:-28px; top:0; width:22px; height:22px; border-radius:50%;
                 display:flex; align-items:center; justify-content:center; font-size:.78rem; font-weight:800;
                 color:#0b1220; line-height:1;}
    .soc-tl .i.pend .ic {background:#334155; color:#cbd5e1;}
    .soc-tl .i.pend .t {color:#94a3b8;}
    .soc-doc {background:#0b1220; border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:14px 16px;
              max-height:640px; overflow-y:auto; white-space:pre-wrap; font-size:.88rem; line-height:1.55;}
    .soc-doc mark {color:inherit; border-radius:4px; padding:0 2px;}
    .soc-doc mark sup {font-weight:800; font-size:.65rem; margin-right:2px;}
    .soc-doc del {color:#f87171;} .soc-doc ins {color:#22e08a; text-decoration:none; font-weight:600;}
    .soc-tl .t {font-weight:700;} .soc-tl .d {color:#94a3b8; font-size:.8rem;}
    .soc-sug {border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:12px 14px; margin:8px 0;}
    .soc-sug .tr {background:rgba(239,68,68,.08); border-radius:8px; padding:6px 10px; font-family:monospace;
                  font-size:.85rem; white-space:pre-wrap;}
    .soc-sug .sg {background:rgba(34,224,138,.08); border-radius:8px; padding:6px 10px; font-family:monospace;
                  font-size:.85rem; white-space:pre-wrap;}
    </style>""", unsafe_allow_html=True)


def _chip(texto: str, cor: str) -> str:
    return f'<span class="soc-chip" style="color:{cor}; border-color:{cor}">{html.escape(texto)}</span>'


def _e(t) -> str:
    return html.escape(str(t or ""))


def _hoje() -> date:
    return datetime.now(so.FUSO).date()


def _versao() -> int:
    return st.session_state.get("soc_versao", 0)


def _recarregar() -> None:
    st.session_state["soc_versao"] = _versao() + 1


@st.cache_data(ttl=60, show_spinner=False)
def _processos(esc: str, versao: int) -> list[dict]:
    return so.listar_processos(esc)


@st.cache_data(ttl=60, show_spinner=False)
def _licencas(esc: str, versao: int) -> list[dict]:
    return so.listar_licencas(esc)


@st.cache_data(ttl=60, show_spinner=False)
def _andamentos(esc: str, versao: int) -> list[dict]:
    return so.listar_andamentos(esc)


@st.cache_data(ttl=60, show_spinner=False)
def _anexos(esc: str, versao: int) -> list[dict]:
    return so.listar_anexos(esc)


@st.cache_data(ttl=300, show_spinner=False)
def _regras(esc: str, versao: int) -> dict:
    return so.obter_regras(esc)


def _usuarios(esc: str) -> list[str]:
    return sorted(auth.usuarios_do_escritorio(auth.carregar_usuarios(), esc))


def _escolher_escritorio(eh_global: bool) -> str:
    proprio = st.session_state.get("escritorio_id")
    if not eh_global:
        return proprio
    escritorios = auth.carregar_escritorios()
    ids = list(escritorios)
    if not ids:
        return proprio
    if st.session_state.get("soc_escritorio") not in ids:
        st.session_state["soc_escritorio"] = proprio if proprio in ids else ids[0]
    return st.selectbox("Escritório", ids, key="soc_escritorio",
                        format_func=lambda e: escritorios.get(e, {}).get("nome") or e,
                        help="Só o super administrador escolhe o escritório; os demais veem só o próprio.")


# ---------------------------------------------------------------- menu e entrada


def _ir_secao(nome: str) -> None:
    st.session_state["soc_secao"] = nome
    st.session_state.pop("soc_proc", None)
    st.session_state.pop("soc_rev", None)


def abrir_processo(processo_id: int) -> None:
    st.session_state["tela"] = "societario"
    st.session_state["soc_secao"] = "Processos"
    st.session_state["soc_proc"] = processo_id


def menu_lateral(pode_configurar: bool) -> None:
    """Telas do módulo no menu lateral do Hub, logo abaixo de "Aplicativos"
    (só com o app aberto). Chaves nav_* = mesmo visual do menu do Hub."""
    st.markdown('<div class="hh-sep"></div><div class="hh-sec">Hub Societário</div>', unsafe_allow_html=True)
    atual = st.session_state.get("soc_secao", "Visão geral")
    for i, (nome, icone) in enumerate(_SECOES):
        if nome == "Configurações" and not pode_configurar:
            continue
        st.button(nome, key=f"nav_soc_{i}", icon=icone, use_container_width=True,
                  type="primary" if nome == atual else "secondary", on_click=_ir_secao, args=(nome,))
    st.markdown('<div class="hh-sep"></div>', unsafe_allow_html=True)


def render(cabecalho: Callable, pode_configurar: bool, eh_global: bool = False) -> None:
    _estilo()
    usuario = st.session_state.get("usuario_logado") or ""
    cabecalho("🏛️", "Hub Societário",
              "Processos societários, alvarás e licenças: andamento, prazos, lembretes e revisão de minutas por IA.")
    with st.expander(f"Versão {so.VERSAO} — novidades"):
        for versao_, data_, itens in so.NOVIDADES:
            st.markdown(f"**{versao_}** ({data_})" + "\n" + "\n".join(f"- {i}" for i in itens))
    esc = _escolher_escritorio(eh_global)
    secao = st.session_state.get("soc_secao", "Visão geral")
    if secao not in [s[0] for s in _SECOES] or (secao == "Configurações" and not pode_configurar):
        secao = "Visão geral"

    detalhe = secao == "Processos" and st.session_state.get("soc_proc")
    revisao = secao == "Assistente IA" and st.session_state.get("soc_rev")
    c1, c2 = st.columns([5, 1.3], vertical_alignment="center")
    if not (detalhe or revisao):
        c1.markdown(f"### {secao}")
    _sininho(c2, esc, usuario)
    _ativar_avisos_windows()
    if detalhe:
        _detalhe(esc, usuario, st.session_state["soc_proc"])
        return
    if revisao:
        _revisao(esc, usuario, st.session_state["soc_rev"])
        return

    if secao == "Visão geral":
        _visao_geral(esc, usuario)
    elif secao == "Processos":
        _lista(esc)
    elif secao == "Novo processo":
        _novo(esc, usuario)
    elif secao == "Licenças":
        _tela_licencas(esc, usuario)
    elif secao == "Agenda":
        _agenda(esc, usuario)
    elif secao == "Assistente IA":
        _assistente(esc, usuario)
    elif secao == "Empresas":
        _empresas(esc)
    elif secao == "Protocolos":
        _protocolos(esc, usuario)
    elif secao == "Documentos":
        _documentos(esc)
    elif secao == "Relatórios":
        _relatorios(esc)
    elif secao == "Configurações":
        _configuracoes(esc, usuario)


def _sininho(alvo, esc: str, usuario: str) -> None:
    """Contador de alertas dos processos e licenças do usuário; leva à Agenda."""
    hoje = _hoje()
    rg = _regras(esc, _versao())
    procs = [p for p in _processos(esc, _versao()) if p.get("responsavel") == usuario]
    lics = [l for l in _licencas(esc, _versao()) if l.get("responsavel") in (usuario, None, "")]
    n = len(so.painel_alertas(procs, lics, hoje, rg))
    alvo.button(f"{n} alerta{'s' if n != 1 else ''}", key="soc_sino", icon=":material/notifications:",
                type="primary" if n else "secondary", use_container_width=True, on_click=_ir_secao, args=("Agenda",),
                help="Alertas dos seus processos e licenças. Clique para ver na Agenda.")


# ---------------------------------------------------------------- visão geral


def _kpis(itens: list[tuple[str, object, str]]) -> None:
    st.markdown('<div class="soc-kpis">' + "".join(
        f'<div class="soc-kpi"><div class="l">{_e(l)}</div><div class="v" style="color:{c}">{html.escape(str(v))}</div></div>'
        for l, v, c in itens) + "</div>", unsafe_allow_html=True)


def _linha_alerta(a: dict) -> str:
    origem = a.get("numero") or a.get("titulo") or ""
    return (f'<div class="soc-al" style="border-color:{_COR_NIVEL[a["nivel"]]}">'
            f'<div class="e">{_e(a.get("titulo"))} — {_e(a.get("empresa"))}</div>'
            f'<div>{_e(a["texto"])}</div>'
            f'<div class="s">{_e(origem)} · {_ROT_NIVEL[a["nivel"]]}'
            + (f' · responsável: {_e(a["responsavel"])}' if a.get("responsavel") else "") + "</div></div>")


def _visao_geral(esc: str, usuario: str) -> None:
    hoje = _hoje()
    rg = _regras(esc, _versao())
    procs = _processos(esc, _versao())
    lics = _licencas(esc, _versao())
    ind = so.indicadores(procs, hoje, rg)
    resumo = so.resumo_do_dia(procs, lics, so.revisoes_pendentes(esc), hoje, usuario, rg)
    hora = datetime.now(so.FUSO).hour
    saud = "Bom dia" if hora < 12 else "Boa tarde" if hora < 18 else "Boa noite"
    with st.container(border=True):
        st.markdown(f"#### {saud}, {usuario}!")
        if resumo["itens"]:
            st.markdown("Estas atividades dos seus processos precisam de atenção hoje:")
            st.markdown("\n".join(f"- **{n}** {t}" for _, t, n in resumo["itens"]))
            st.markdown(f"**Prioridade sugerida:** {resumo['prioridade']}")
        else:
            st.markdown("Nada pendente nos seus processos hoje. 🎉")

    _kpis([("Total de processos", ind["total"], "#e2e8f0"), ("Em andamento", ind["andamento"], "#3b82f6"),
           ("Com pendências", ind["pendencias"], "#ef4444"), ("Concluídos", ind["concluidos"], "#22e08a")])

    c1, c2 = st.columns(2)
    with c1:
        maior = max([n for _, n in ind["por_tipo"]] or [1])
        barras = "".join(f'<div class="soc-bar"><div class="t"><span>{_e(t)}</span><b>{n}</b></div>'
                         f'<div class="tr"><span style="width:{n / maior * 100:.0f}%"></span></div></div>'
                         for t, n in ind["por_tipo"]) or '<div class="soc-muted">Nenhum processo ainda.</div>'
        st.markdown(f'<div class="soc-card"><h4>Processos por categoria</h4>{barras}</div>', unsafe_allow_html=True)
        etapas = "".join(f'<div class="soc-bar"><div class="t"><span>{so.ETAPAS[e]}</span><b>{ind["por_etapa"][e]}</b>'
                         f'</div></div>' for e in so.ETAPAS_KANBAN)
        st.markdown(f'<div class="soc-card"><h4>Por etapa</h4>{etapas}</div>', unsafe_allow_html=True)
    with c2:
        als = so.painel_alertas(procs, lics, hoje, rg)
        st.markdown(f"**Precisam de atenção ({len(als)})**")
        for i, a in enumerate(als[:12]):
            st.markdown(_linha_alerta(a), unsafe_allow_html=True)
            if a.get("processo_id"):
                st.button("Abrir processo", key=f"soc_va_{i}", on_click=abrir_processo, args=(a["processo_id"],))
        if len(als) > 12:
            st.caption(f"+ {len(als) - 12} alerta(s) na Agenda.")
        if not als:
            st.caption("Nenhum alerta.")


# ---------------------------------------------------------------- processos (lista e Kanban)


def _mover(esc: str, usuario: str, p: dict, etapa: str) -> None:
    so.registrar_andamento(esc, p["id"], usuario, f"Etapa: {so.ETAPAS[etapa]}", etapa=etapa)
    _recarregar()


def _lista(esc: str) -> None:
    usuario = st.session_state.get("usuario_logado") or ""
    procs = _processos(esc, _versao())
    hoje = _hoje()
    rg = _regras(esc, _versao())
    modo = st.segmented_control("Visualização", ["Kanban", "Lista"], default="Kanban", key="soc_modo")
    f1, f2, f3, f4, f5 = st.columns([2, 1.4, 1.2, 1, 1.2])
    busca = f1.text_input("Buscar", key="soc_busca", placeholder="🔍  Empresa, número, CNPJ ou protocolo")
    tipos = f2.multiselect("Tipo", list(so.TIPOS), format_func=lambda t: so.TIPOS[t]["nome"], key="soc_f_tipo",
                           placeholder="Todos")
    resp_opts = sorted({p["responsavel"] for p in procs if p.get("responsavel")})
    resp = f3.selectbox("Responsável", ["Todos"] + resp_opts, key="soc_f_resp")
    prio = f4.selectbox("Prioridade", [""] + list(so.PRIORIDADES), key="soc_f_prio",
                        format_func=lambda p: so.PRIORIDADES.get(p, "Todas"))
    orgao = f5.selectbox("Órgão", [""] + so.ORGAOS, key="soc_f_orgao", format_func=lambda o: o or "Todos")
    g1, g2, g3 = st.columns([2, 1.2, 1])
    etapas = g1.multiselect("Situação (etapa)", list(so.ETAPAS), format_func=so.ETAPAS.get, key="soc_f_etapa",
                            placeholder="Todas")
    periodo = g2.date_input("Abertos entre", value=(), format="DD/MM/YYYY", key="soc_f_per")
    so_alerta = g3.toggle("Só com alerta", key="soc_f_alerta")
    ini = fim = None
    if isinstance(periodo, (tuple, list)) and len(periodo) == 2:
        ini, fim = periodo
    vis = so.filtrar(procs, busca or "", tipos or None, etapas or None, None if resp == "Todos" else resp,
                     prio or None, orgao or None, ini, fim)
    if so_alerta:
        vis = [p for p in vis if so.alertas_processo(p, hoje, rg)]
    st.caption(f"{len(vis)} processo(s).")
    if modo == "Lista":
        dados = [{"Número": p["numero"], "Empresa": p["empresa_nome"], "Tipo": so.TIPOS[p["tipo"]]["nome"],
                  "Etapa": so.ETAPAS[p["etapa"]], "Prioridade": so.PRIORIDADES.get(p["prioridade"], ""),
                  "Responsável": p.get("responsavel") or "", "Órgão": p.get("orgao") or "",
                  "Protocolo": p.get("protocolo") or "", "Previsão": so.data_br(p.get("previsao")),
                  "Checklist": f"{p['check_feitos']}/{p['check_total']}",
                  "Últ. movimentação": so.data_br(p.get("ultima_movimentacao")),
                  "Alerta": "; ".join(a["texto"] for a in so.alertas_processo(p, hoje, rg))} for p in vis]
        if not dados:
            return
        ev = st.dataframe(dados, hide_index=True, use_container_width=True, height=480, key="soc_tab",
                          on_select="rerun", selection_mode="single-row")
        try:
            i = ev.selection.rows[0]
        except (AttributeError, IndexError, TypeError):
            i = None
        if i is not None and 0 <= i < len(vis):
            abrir_processo(vis[i]["id"])
            st.rerun()
        return

    # Kanban: uma coluna por etapa; arrastar o cartão (ou ◀ ▶) muda a etapa e registra o andamento
    por_id = {p["id"]: p for p in vis}
    colunas = []
    for etapa in so.ETAPAS_KANBAN:
        todos = [p for p in vis if p["etapa"] == etapa]
        cartoes = todos[:15] if etapa == so.CONCLUIDO else todos
        itens = []
        for p in cartoes:
            al = so.alertas_processo(p, hoje, rg)
            nivel = min((a["nivel"] for a in al), key=lambda n: so._PESO[n], default=None)
            chips = []
            if p["prioridade"] != "normal":
                chips.append([so.PRIORIDADES[p["prioridade"]],
                              "#ef4444" if p["prioridade"] in ("alta", "urgente") else "#94a3b8"])
            if nivel:
                chips.append([_ROT_NIVEL[nivel], _COR_NIVEL[nivel]])
            itens.append({"id": p["id"], "numero": p["numero"], "empresa": p["empresa_nome"],
                          "tipo": so.TIPOS[p["tipo"]]["nome"], "chips": chips,
                          "rodape": f"{p.get('responsavel') or 'sem responsável'} · ☑ {p['check_feitos']}/"
                                    f"{p['check_total']}" + (f" · 📎 {p['n_anexos']}" if p.get("n_anexos") else "")})
        colunas.append({"id": etapa, "nome": so.ETAPAS[etapa], "cor": _COR_ETAPA[etapa], "total": len(todos),
                        "cartoes": itens, "ocultos": len(todos) - len(cartoes)})
    ev = _kanban(colunas=colunas, key="soc_kanban", default=None)
    # o valor do componente fica guardado entre as recargas: "n" separa um gesto novo de um já tratado
    if ev and ev.get("n") != st.session_state.get("soc_kanban_n"):
        st.session_state["soc_kanban_n"] = ev["n"]
        p = por_id.get(ev.get("id"))
        if p and ev.get("acao") == "abrir":
            abrir_processo(p["id"])
            st.rerun()
        elif p and ev.get("acao") == "mover" and ev.get("etapa") in so.ETAPAS_KANBAN and ev["etapa"] != p["etapa"]:
            _mover(esc, usuario, p, ev["etapa"])
            st.toast(f"{p['numero']}: {so.ETAPAS[p['etapa']]} → {so.ETAPAS[ev['etapa']]}")
            st.rerun()


# ---------------------------------------------------------------- novo processo


@st.cache_data(ttl=120, show_spinner=False)
def _empresas_escolha(esc: str, versao: int) -> list[dict]:
    return so.unir_empresas(so.listar_empresas_cadastradas(esc), clientes.listar_clientes(esc),
                            so.empresas_acessorias(esc))


def _atualizar_acessorias(esc: str) -> None:
    try:
        with st.spinner("Buscando as empresas no Acessórias…"):
            n = so.atualizar_empresas_acessorias(esc)
    except ValueError as exc:
        st.session_state["soc_acess_msg"] = ("erro", f"Não consegui buscar no Acessórias: {exc}")
    else:
        st.session_state["soc_acess_msg"] = ("ok", f"{n} empresa(s) do Acessórias atualizadas.")
    _recarregar()


def _botao_acessorias(esc: str, chave: str) -> None:
    if so.tem_acessorias(esc):
        st.button("Atualizar empresas do Acessórias", key=f"{chave}_acess", icon=":material/sync:",
                  on_click=_atualizar_acessorias, args=(esc,),
                  help="Busca agora na API do Acessórias a lista de empresas (é a mesma que o Controle de "
                       "Obrigações usa e atualiza sozinho).")
    else:
        st.caption("Para buscar as empresas do Acessórias, cadastre o API Token do Acessórias no Controle de "
                   "Obrigações (Configurações) ou em Admissões › Canais.")
    msg = st.session_state.pop("soc_acess_msg", None)
    if msg:
        (st.success if msg[0] == "ok" else st.error)(msg[1])


def _empresa_campos(esc: str, chave: str) -> dict:
    """Empresa do processo: busca no cadastro do Societário, nos clientes do
    Hub e no Acessórias, ou cadastro de uma empresa nova (ex.: constituição)."""
    st.markdown("**Empresa**")
    modo = st.segmented_control("Empresa", ["Buscar empresa", "Cadastrar empresa nova"], default="Buscar empresa",
                                key=f"{chave}_modo", label_visibility="collapsed") or "Buscar empresa"
    if modo == "Buscar empresa":
        lista = _empresas_escolha(esc, _versao())
        # chave estável (CNPJ ou nome): a escolha não muda quando a lista é atualizada
        por_chave = {(e["cnpj"] or "n:" + e["nome"]): e for e in lista}
        if st.session_state.get(f"{chave}_emp") not in por_chave:
            st.session_state.pop(f"{chave}_emp", None)
        sel = st.selectbox(
            "Empresa", list(por_chave), index=None, key=f"{chave}_emp", label_visibility="collapsed",
            format_func=lambda k: so.rotulo_empresa(por_chave[k]),
            placeholder=f"Digite o nome ou o CNPJ para buscar entre {len(lista)} empresa(s)…")
        orig = {o: sum(1 for e in lista if o in e["origens"])
                for o in (so.ORIGEM_SOCIETARIO, so.ORIGEM_HUB, so.ORIGEM_ACESSORIAS)}
        st.caption("Busca em: " + " · ".join(f"{o} ({n})" for o, n in orig.items())
                   + ". Não achou? Use \"Cadastrar empresa nova\".")
        _botao_acessorias(esc, chave)
        if sel is None:
            return {"nome": "", "cnpj": "", "novo": None}
        e = por_chave[sel]
        return {"nome": e["nome"], "cnpj": e["cnpj"], "novo": None}
    c1, c2 = st.columns([2, 1])
    nome = c1.text_input("Razão social ou nome pretendido *", key=f"{chave}_nome")
    cnpj = c2.text_input("CNPJ / CPF", key=f"{chave}_cnpj", help="Deixe em branco se a empresa ainda não tem (constituição).")
    c3, c4, c5 = st.columns(3)
    contato = c3.text_input("Contato (sócio / responsável)", key=f"{chave}_contato")
    telefone = c4.text_input("Telefone", key=f"{chave}_tel")
    email = c5.text_input("E-mail", key=f"{chave}_email")
    guardar = st.checkbox("Guardar no cadastro de empresas do Societário (para achar na busca nos próximos processos)",
                          value=True, key=f"{chave}_guardar")
    return {"nome": nome, "cnpj": cnpj, "novo": {"guardar": guardar, "contato": contato, "telefone": telefone,
                                                  "email": email}}


def _escolher_tipo(tipo: str) -> None:
    st.session_state["soc_n_tipo"] = tipo


def _novo(esc: str, usuario: str) -> None:
    st.caption("O número do processo, quem abriu e a data e hora ficam registrados automaticamente. O checklist do "
               "tipo escolhido é carregado na abertura.")
    usuarios = _usuarios(esc)
    if st.session_state.get("soc_n_tipo") not in so.TIPOS:
        st.session_state["soc_n_tipo"] = "alteracao"
    tipo = st.session_state["soc_n_tipo"]
    st.markdown("**Tipo de processo**")
    tipos = list(so.TIPOS)
    for i in range(0, len(tipos), 3):
        cols = st.columns(3)
        for col, t in zip(cols, tipos[i:i + 3]):
            icone, desc = _CARTAO_TIPO.get(t, (":material/description:", ""))
            with col.container(border=True):
                st.button(so.TIPOS[t]["nome"], key=f"soc_n_t_{t}", icon=icone, use_container_width=True,
                          type="primary" if t == tipo else "secondary", on_click=_escolher_tipo, args=(t,))
                st.caption(desc)
    c1, c2 = st.columns(2)
    c1.markdown(f"Tipo escolhido: **{so.TIPOS[tipo]['nome']}** "
                f"<span class='soc-muted'>({len(so.TIPOS[tipo]['checklist'])} etapas no checklist)</span>",
                unsafe_allow_html=True)
    orgao = c2.selectbox("Órgão", so.ORGAOS, key="soc_n_orgao_" + tipo,
                         index=so.ORGAOS.index(so.TIPOS[tipo]["orgao"]))
    emp = _empresa_campos(esc, "soc_n")
    c3, c4, c5 = st.columns(3)
    resp = c3.selectbox("Colaborador responsável", usuarios, key="soc_n_resp",
                        index=usuarios.index(usuario) if usuario in usuarios else 0)
    prio = c4.selectbox("Prioridade", list(so.PRIORIDADES), format_func=so.PRIORIDADES.get, index=1, key="soc_n_prio")
    prev = c5.date_input("Previsão de conclusão", value=_hoje() + timedelta(days=10), format="DD/MM/YYYY",
                         key="soc_n_prev")
    desc = st.text_area("Descrição da solicitação", key="soc_n_desc", height=110,
                        placeholder="Ex.: saída do sócio A, entrada do sócio B, aumento de capital para R$ 100.000,00…")
    arqs = st.file_uploader("Anexar documentos e minutas (PDF, Word, imagens)", accept_multiple_files=True,
                            key="soc_n_arqs")
    t1, t2 = st.columns(2)
    ia = t1.toggle("Habilitar análise documental por IA", value=True, key="soc_n_ia")
    lemb = t2.toggle("Habilitar lembretes automáticos", value=True, key="soc_n_lemb")
    if st.button("Abrir processo", type="primary", icon=":material/add:"):
        try:
            empresa, cnpj = emp["nome"].strip(), emp["cnpj"]
            if not empresa:
                raise ValueError("Escolha a empresa na busca ou cadastre uma empresa nova.")
            novo = emp["novo"]
            if novo is not None:
                cnpj = so.validar_documento(cnpj)
                if novo["guardar"]:
                    cad = so.cadastrar_empresa(esc, usuario, empresa, cnpj, novo["contato"], novo["telefone"],
                                               novo["email"])
                    empresa, cnpj = cad["nome"], cad.get("cnpj") or ""
            p = so.criar_processo(esc, usuario, tipo, empresa, cnpj, resp, prio, prev, desc, orgao, ia, lemb)
            for a in arqs or []:
                so.anexar(esc, p["id"], usuario, a.name, a.getvalue(), a.type or "",
                          categoria="minuta" if a.name.lower().endswith((".docx", ".doc")) else "documento")
        except ValueError as exc:
            st.error(str(exc))
            return
        _recarregar()
        for k in ("soc_n_desc", "soc_n_nome", "soc_n_cnpj", "soc_n_arqs", "soc_n_emp", "soc_n_contato",
                  "soc_n_tel", "soc_n_email"):
            st.session_state.pop(k, None)
        st.toast(f"Processo {p['numero']} aberto.", icon="✅")
        abrir_processo(p["id"])
        st.rerun()


# ---------------------------------------------------------------- detalhe do processo


def _voltar() -> None:
    st.session_state.pop("soc_proc", None)


def _detalhe(esc: str, usuario: str, processo_id: int) -> None:
    p = so.obter_processo(esc, processo_id)
    st.button("← Processos", key="soc_voltar", on_click=_voltar)
    if not p:
        st.warning("Processo não encontrado.")
        return
    hoje = _hoje()
    rg = _regras(esc, _versao())
    feitos, total = so.progresso_checklist(p["checklist"])
    st.markdown(f"### Processo {_e(p['numero'])}")
    st.markdown(f"{_e(so.TIPOS[p['tipo']]['nome'])} • **{_e(p['empresa_nome'])}**"
                + (f" · {so.formatar_cnpj(p['cnpj'])}" if p.get("cnpj") else "") + " &nbsp; "
                + _chip(so.ETAPAS[p["etapa"]], _COR_ETAPA[p["etapa"]])
                + _chip(so.PRIORIDADES[p["prioridade"]], "#94a3b8"), unsafe_allow_html=True)
    st.markdown(f'<div class="soc-muted">Responsável: {_e(p.get("responsavel") or "—")} · Órgão: {_e(p.get("orgao") or "—")}'
                f' · Protocolo: {_e(p.get("protocolo") or "—")} · Previsão: {so.data_br(p.get("previsao")) or "—"}'
                f' · Checklist: {feitos}/{total} · Aberto por {_e(p.get("criado_por"))} em {so.data_br(p["criado_em"])}</div>',
                unsafe_allow_html=True)
    for a in so.alertas_processo(p, hoje, rg):
        st.markdown(f'<div class="soc-al" style="border-color:{_COR_NIVEL[a["nivel"]]}">{_e(a["texto"])}</div>',
                    unsafe_allow_html=True)

    # nomes fixos: se a contagem entrasse no nome, cada clique no checklist
    # trocaria a aba e a tela voltaria para "Andamento"
    abas = st.tabs(["Andamento", "Checklist", "Documentos", "Lembretes", "Dados do processo"])
    with abas[0]:
        _aba_andamento(esc, usuario, p)
    with abas[1]:
        _aba_checklist(esc, usuario, p, feitos, total)
    with abas[2]:
        _aba_documentos(esc, usuario, p)
    with abas[3]:
        _aba_lembretes(esc, usuario, p)
    with abas[4]:
        _aba_dados(esc, usuario, p)


def _aba_andamento(esc: str, usuario: str, p: dict) -> None:
    c1, c2 = st.columns([1.05, 1])
    with c1:
        st.markdown("**Linha do tempo**")
        itens = []
        for a in p["andamentos"]:
            extra = []
            if a.get("etapa_depois"):
                extra.append(f"Etapa: {so.ETAPAS.get(a['etapa_antes'], '—') if a.get('etapa_antes') else ''}"
                             f"{' → ' if a.get('etapa_antes') else ''}{so.ETAPAS.get(a['etapa_depois'], '')}")
            if a.get("protocolo"):
                extra.append(f"Protocolo: {a['protocolo']}")
            if a.get("proxima_acao"):
                extra.append(f"Próxima ação: {a['proxima_acao']}")
            if a.get("proxima_verificacao"):
                extra.append(f"Próxima verificação: {so.data_br(a['proxima_verificacao'])}")
            simb, cor = _ICONE_ANDAMENTO[so.tipo_andamento(a)]
            itens.append(f'<div class="i"><span class="ic" style="background:{cor}">{simb}</span>'
                         f'<div class="t">{_e(a["titulo"])}</div>'
                         f'<div class="d">{so.data_br(a["criado_em"])} · {_e(a.get("usuario"))}</div>'
                         + (f'<div>{_e(a["texto"])}</div>' if a.get("texto") else "")
                         + "".join(f'<div class="soc-muted">{_e(x)}</div>' for x in extra) + "</div>")
        if p["etapa"] not in so.ENCERRADAS:
            prox = p.get("proxima_verificacao")
            itens.append('<div class="i pend"><span class="ic">◷</span><div class="t">'
                         + (f"Próxima verificação: {so.data_br(prox)}" if prox else "Conclusão e envio ao cliente")
                         + '</div><div class="d">Pendente</div>'
                         + (f'<div>{_e(p["proxima_acao"])}</div>' if p.get("proxima_acao") else "") + "</div>")
        st.markdown('<div class="soc-tl">' + "".join(itens) + "</div>", unsafe_allow_html=True)
    with c2:
        with st.form(f"soc_and_{p['id']}", clear_on_submit=True):
            st.markdown("**Atualizar andamento**")
            titulo = st.text_input("O que aconteceu", placeholder="Ex.: Processo protocolado na JUCEG")
            texto = st.text_area("Observações", height=90)
            etapas = list(so.ETAPAS)
            etapa = st.selectbox("Etapa", etapas, index=etapas.index(p["etapa"]), format_func=so.ETAPAS.get)
            protocolo = st.text_input("Número do protocolo", value="")
            proxima_acao = st.text_input("Próxima ação", placeholder="Ex.: Verificar retorno da Junta Comercial")
            cd, ch = st.columns([3, 2])
            prox = cd.date_input("Próxima verificação", value=None, format="DD/MM/YYYY",
                                 help="Vira um lembrete em pop-up para o responsável nesse dia e hora.")
            hora_prox = ch.time_input("Hora do lembrete", value=time(8, 0), step=timedelta(minutes=15))
            arq = st.file_uploader("Anexar comprovante (opcional)")
            if st.form_submit_button("Registrar andamento", type="primary"):
                if not (titulo.strip() or texto.strip() or etapa != p["etapa"] or protocolo.strip() or prox):
                    st.error("Escreva o que aconteceu ou mude a etapa.")
                else:
                    so.registrar_andamento(esc, p["id"], usuario, titulo, texto,
                                           etapa if etapa != p["etapa"] else None, protocolo, proxima_acao, prox,
                                           hora_lembrete=hora_prox)
                    if arq is not None:
                        so.anexar(esc, p["id"], usuario, arq.name, arq.getvalue(), arq.type or "", "comprovante")
                    _recarregar()
                    st.rerun()


def _aba_checklist(esc: str, usuario: str, p: dict, feitos: int, total: int) -> None:
    st.progress(feitos / total if total else 0.0, text=f"{feitos} de {total} etapas concluídas")
    for item in p["checklist"]:
        novo = st.checkbox(item["item"], value=item["feito"], key=f"soc_ck_{item['id']}",
                           help=f"Feito por {item['feito_por']} em {so.data_br(item['feito_em'])}"
                           if item["feito"] else None)
        if novo != item["feito"]:
            so.marcar_item(esc, item["id"], usuario, novo)
            _recarregar()
            st.rerun()
    with st.form(f"soc_ck_novo_{p['id']}", clear_on_submit=True, border=False):
        c1, c2 = st.columns([4, 1])
        novo_item = c1.text_input("Acrescentar etapa ao checklist", label_visibility="collapsed",
                                  placeholder="Acrescentar etapa ao checklist deste processo")
        if c2.form_submit_button("Acrescentar") and novo_item.strip():
            so.adicionar_item(esc, p["id"], novo_item)
            _recarregar()
            st.rerun()


def _aba_documentos(esc: str, usuario: str, p: dict) -> None:
    rot = {"minuta": "Minuta", "minuta_revisada": "Minuta revisada (IA)", "documento": "Documento",
           "comprovante": "Comprovante"}
    for a in p["anexos"]:
        c1, c2, c3 = st.columns([4, 1.4, 1])
        c1.markdown(f"**{_e(a['nome'])}**  \n<span class='soc-muted'>{rot.get(a['categoria'], a['categoria'])} · "
                    f"{a['tamanho'] / 1024:.0f} KB · {_e(a.get('enviado_por'))} em {so.data_br(a['criado_em'])}</span>",
                    unsafe_allow_html=True)
        if c2.button("Preparar download", key=f"soc_dl_p_{a['id']}"):
            st.session_state[f"soc_dl_{a['id']}"] = True
        if st.session_state.get(f"soc_dl_{a['id']}"):
            arq = so.baixar_anexo(esc, a["id"])
            if arq:
                c3.download_button("Baixar", arq["conteudo"], file_name=arq["nome"],
                                   mime=arq.get("tipo_mime") or "application/octet-stream", key=f"soc_dl_b_{a['id']}")
        if a["categoria"] in ("minuta", "minuta_revisada") and p.get("ia_habilitada") and \
                a["nome"].lower().endswith((".docx", ".pdf", ".txt")):
            if c3.button("Revisar com IA", key=f"soc_rv_{a['id']}"):
                arq = so.baixar_anexo(esc, a["id"])
                try:
                    texto = so.extrair_texto(arq["nome"], arq["conteudo"])
                except Exception as exc:  # noqa: BLE001 - arquivo corrompido ou formato estranho
                    st.error(f"Não consegui ler o texto do arquivo: {exc}")
                else:
                    _iniciar_revisao(esc, usuario, arq["nome"], texto, p["id"], p["tipo"], p.get("descricao") or "",
                                     arq["conteudo"])
    if not p["anexos"]:
        st.caption("Nenhum documento anexado.")
    with st.form(f"soc_anx_{p['id']}", clear_on_submit=True):
        arqs = st.file_uploader("Anexar arquivos", accept_multiple_files=True)
        cat = st.selectbox("Tipo", ["documento", "minuta", "comprovante"], format_func=rot.get)
        if st.form_submit_button("Anexar") and arqs:
            try:
                for a in arqs:
                    so.anexar(esc, p["id"], usuario, a.name, a.getvalue(), a.type or "", cat)
            except ValueError as exc:
                st.error(str(exc))
            else:
                _recarregar()
                st.rerun()
    if p["revisoes"]:
        st.markdown("**Revisões por IA deste processo**")
        for r in p["revisoes"]:
            c1, c2 = st.columns([4, 1])
            c1.markdown(f"{_e(r['titulo'])} · {_ROT_REV.get(r['status'], r['status'])} · {so.data_br(r['criado_em'])}")
            c2.button("Abrir", key=f"soc_rv_ab_{r['id']}", on_click=_abrir_revisao, args=(r["id"],))


def _aba_lembretes(esc: str, usuario: str, p: dict) -> None:
    pend = [l for l in p["lembretes"] if l["status"] == "pendente"]
    for l in pend:
        c1, c2 = st.columns([4, 1])
        c1.markdown(f"**{so.data_br(l['quando'])}** — {_e(l['texto'])} <span class='soc-muted'>(para {_e(l['usuario'])})</span>",
                    unsafe_allow_html=True)
        if c2.button("Concluir", key=f"soc_lb_ok_{l['id']}"):
            so.concluir_lembrete(esc, l["id"])
            st.rerun()
    if not pend:
        st.caption("Nenhum lembrete pendente.")
    with st.form(f"soc_lb_{p['id']}", clear_on_submit=True):
        st.markdown("**Novo lembrete**")
        texto = st.text_input("Lembrar de", placeholder="Verificar o retorno do processo protocolado na Junta")
        c1, c2, c3 = st.columns(3)
        dia = c1.date_input("Dia", value=_hoje() + timedelta(days=2), format="DD/MM/YYYY")
        hora = c2.time_input("Hora", value=time(8, 0), step=timedelta(minutes=15))
        usuarios = _usuarios(esc)
        alvo = p.get("responsavel") or usuario
        para = c3.selectbox("Para", usuarios, index=usuarios.index(alvo) if alvo in usuarios else 0)
        if st.form_submit_button("Agendar lembrete"):
            try:
                so.criar_lembrete(esc, para, datetime.combine(dia, hora, so.FUSO), texto, usuario, p["id"])
            except ValueError as exc:
                st.error(str(exc))
            else:
                st.rerun()


def _aba_dados(esc: str, usuario: str, p: dict) -> None:
    usuarios = _usuarios(esc)
    with st.form(f"soc_dados_{p['id']}"):
        c1, c2 = st.columns([2, 1])
        empresa = c1.text_input("Empresa", value=p["empresa_nome"])
        cnpj = c2.text_input("CNPJ / CPF", value=so.formatar_cnpj(p.get("cnpj")))
        c3, c4, c5, c6 = st.columns(4)
        resp_atual = p.get("responsavel") or ""
        opts = usuarios + ([resp_atual] if resp_atual and resp_atual not in usuarios else [])
        resp = c3.selectbox("Responsável", opts, index=opts.index(resp_atual) if resp_atual in opts else 0)
        prio = c4.selectbox("Prioridade", list(so.PRIORIDADES), format_func=so.PRIORIDADES.get,
                            index=list(so.PRIORIDADES).index(p["prioridade"]))
        orgaos = so.ORGAOS + ([p["orgao"]] if p.get("orgao") and p["orgao"] not in so.ORGAOS else [])
        orgao = c5.selectbox("Órgão", orgaos, index=orgaos.index(p["orgao"]) if p.get("orgao") in orgaos else 0)
        prev = c6.date_input("Previsão", value=p.get("previsao"), format="DD/MM/YYYY")
        desc = st.text_area("Descrição", value=p.get("descricao") or "")
        if st.form_submit_button("Salvar dados"):
            so.atualizar_dados(esc, p["id"], usuario, empresa_nome=empresa, cnpj=cnpj, responsavel=resp,
                               prioridade=prio, orgao=orgao, previsao=prev, descricao=desc)
            _recarregar()
            st.rerun()


# ---------------------------------------------------------------- licenças


def _tela_licencas(esc: str, usuario: str) -> None:
    hoje = _hoje()
    rg = _regras(esc, _versao())
    aviso = max(rg["licenca_avisos"]) if rg["licenca_avisos"] else 90
    lics = _licencas(esc, _versao())
    sit = {l["id"]: so.situacao_licenca(l.get("validade"), hoje, aviso) for l in lics}
    _kpis([("Vigentes", sum(1 for s in sit.values() if s == so.VIGENTE), "#22e08a"),
           ("A vencer", sum(1 for s in sit.values() if s == so.A_VENCER), "#f59e0b"),
           ("Vencidas", sum(1 for s in sit.values() if s == so.VENCIDA), "#ef4444")])
    st.caption(f"\"A vencer\" = vence nos próximos {aviso} dias. Ao abrir o processo de renovação, a licença deixa de "
               "gerar alerta e o processo fica ligado a ela.")
    filtro = st.segmented_control("Mostrar", ["Todas", "A vencer", "Vencidas"], default="Todas", key="soc_lic_f")
    for l in lics:
        s = sit[l["id"]]
        if filtro == "A vencer" and s != so.A_VENCER or filtro == "Vencidas" and s != so.VENCIDA:
            continue
        with st.container(border=True):
            c1, c2, c3 = st.columns([3, 1.4, 1.4])
            c1.markdown(f"**{_e(l['empresa_nome'])}** · {_e(so.LICENCAS[l['tipo']])}"
                        + (f" nº {_e(l['numero'])}" if l.get("numero") else "")
                        + "  \n<span class='soc-muted'>" + " · ".join(x for x in [
                            f"Validade: {so.data_br(l.get('validade')) or '—'}", _e(l.get("orgao")),
                            f"responsável: {_e(l.get('responsavel') or '—')}"] if x) + "</span>",
                        unsafe_allow_html=True)
            c1.markdown(_chip(so.SITUACOES_LICENCA[s], _COR_LIC[s]), unsafe_allow_html=True)
            if l.get("processo_renovacao_id"):
                c2.markdown(f"Renovação: **{_e(l['renovacao_numero'])}**  \n"
                            f"<span class='soc-muted'>{so.ETAPAS.get(l['renovacao_etapa'], '')}</span>",
                            unsafe_allow_html=True)
                c3.button("Abrir processo", key=f"soc_lic_ab_{l['id']}", on_click=abrir_processo,
                          args=(l["processo_renovacao_id"],))
            else:
                if c2.button("Abrir renovação", key=f"soc_lic_ren_{l['id']}", type="primary" if s != so.VIGENTE else "secondary"):
                    p = so.abrir_renovacao(esc, l["id"], usuario)
                    _recarregar()
                    st.toast(f"Processo {p['numero']} aberto.", icon="✅")
                    abrir_processo(p["id"])
                    st.rerun()
            if c3.button("Editar", key=f"soc_lic_ed_{l['id']}"):
                st.session_state["soc_lic_edit"] = l["id"]
            if st.session_state.get("soc_lic_edit") == l["id"]:
                _form_licenca(esc, usuario, l)
    if not lics:
        st.caption("Nenhuma licença cadastrada.")
    with st.expander("Cadastrar licença", icon=":material/add:"):
        _form_licenca(esc, usuario, None)


def _form_licenca(esc: str, usuario: str, l: dict | None) -> None:
    k = f"soc_lic_{l['id'] if l else 'nova'}"
    usuarios = _usuarios(esc)
    with st.form(k, clear_on_submit=l is None):
        c1, c2, c3 = st.columns([2, 1, 1.4])
        empresa = c1.text_input("Empresa", value=(l or {}).get("empresa_nome", ""))
        cnpj = c2.text_input("CNPJ", value=so.formatar_cnpj((l or {}).get("cnpj")))
        tipos = list(so.LICENCAS)
        tipo = c3.selectbox("Tipo", tipos, format_func=so.LICENCAS.get,
                            index=tipos.index(l["tipo"]) if l else 0)
        c4, c5, c6, c7 = st.columns(4)
        numero = c4.text_input("Número", value=(l or {}).get("numero") or "")
        orgao = c5.text_input("Órgão", value=(l or {}).get("orgao") or "")
        emissao = c6.date_input("Emissão", value=(l or {}).get("emissao"), format="DD/MM/YYYY")
        validade = c7.date_input("Validade", value=(l or {}).get("validade"), format="DD/MM/YYYY")
        c8, c9 = st.columns([1, 3])
        atual = (l or {}).get("responsavel") or usuario
        resp = c8.selectbox("Responsável", usuarios, index=usuarios.index(atual) if atual in usuarios else 0)
        obs = c9.text_input("Observação", value=(l or {}).get("observacao") or "")
        b1, b2 = st.columns([1, 4])
        salvar = b1.form_submit_button("Salvar", type="primary")
        arquivar = l is not None and b2.form_submit_button("Arquivar licença (não renova mais)")
        if salvar:
            try:
                so.salvar_licenca(esc, usuario, {"empresa_nome": empresa, "cnpj": cnpj, "tipo": tipo, "numero": numero,
                                                 "orgao": orgao, "emissao": emissao, "validade": validade,
                                                 "responsavel": resp, "observacao": obs}, l["id"] if l else None)
            except ValueError as exc:
                st.error(str(exc))
                return
            st.session_state.pop("soc_lic_edit", None)
            _recarregar()
            st.rerun()
        if arquivar:
            so.arquivar_licenca(esc, l["id"])
            st.session_state.pop("soc_lic_edit", None)
            _recarregar()
            st.rerun()


# ---------------------------------------------------------------- agenda


def _agenda(esc: str, usuario: str) -> None:
    hoje = _hoje()
    rg = _regras(esc, _versao())
    so_meus = st.toggle("Só os meus", value=True, key="soc_ag_meus")
    lembs = so.listar_lembretes(esc, usuario if so_meus else None)
    st.markdown("**Lembretes**")
    agora = datetime.now(so.FUSO)
    for l in lembs:
        c1, c2, c3 = st.columns([4, 1, 1])
        venc = l["quando"] <= agora
        c1.markdown(("🔔 " if venc else "") + f"**{so.data_br(l['quando'])}** — {_e(l['texto'])}"
                    + (f" <span class='soc-muted'>· {_e(l['numero'])} {_e(l['empresa_nome'])}</span>" if l.get("numero") else "")
                    + ("" if so_meus else f" <span class='soc-muted'>· para {_e(l['usuario'])}</span>"),
                    unsafe_allow_html=True)
        if l.get("processo_id"):
            c2.button("Abrir", key=f"soc_ag_ab_{l['id']}", on_click=abrir_processo, args=(l["processo_id"],))
        if c3.button("Concluir", key=f"soc_ag_ok_{l['id']}"):
            so.concluir_lembrete(esc, l["id"])
            st.rerun()
    if not lembs:
        st.caption("Nenhum lembrete pendente.")
    with st.expander("Novo lembrete avulso", icon=":material/add_alert:"):
        with st.form("soc_ag_novo", clear_on_submit=True):
            texto = st.text_input("Lembrar de")
            c1, c2, c3 = st.columns(3)
            dia = c1.date_input("Dia", value=hoje + timedelta(days=1), format="DD/MM/YYYY")
            hora = c2.time_input("Hora", value=time(8, 0), step=timedelta(minutes=15))
            usuarios = _usuarios(esc)
            para = c3.selectbox("Para", usuarios, index=usuarios.index(usuario) if usuario in usuarios else 0)
            if st.form_submit_button("Agendar"):
                try:
                    so.criar_lembrete(esc, para, datetime.combine(dia, hora, so.FUSO), texto, usuario)
                except ValueError as exc:
                    st.error(str(exc))
                else:
                    st.rerun()

    st.markdown("**Alertas automáticos**")
    procs = _processos(esc, _versao())
    lics = _licencas(esc, _versao())
    if so_meus:
        procs = [p for p in procs if p.get("responsavel") == usuario]
        lics = [l for l in lics if l.get("responsavel") in (usuario, None, "")]
    als = so.painel_alertas(procs, lics, hoje, rg)
    for i, a in enumerate(als):
        st.markdown(_linha_alerta(a), unsafe_allow_html=True)
        if a.get("processo_id"):
            st.button("Abrir processo", key=f"soc_ag_al_{i}", on_click=abrir_processo, args=(a["processo_id"],))
    if not als:
        st.caption("Nenhum alerta.")
    st.markdown("**Previsões de conclusão (próximos 30 dias)**")
    prox = sorted([p for p in procs if p.get("previsao") and p["etapa"] not in so.ENCERRADAS
                   and p["previsao"] <= hoje + timedelta(days=30)], key=lambda p: p["previsao"])
    if prox:
        st.dataframe([{"Previsão": so.data_br(p["previsao"]), "Número": p["numero"], "Empresa": p["empresa_nome"],
                       "Tipo": so.TIPOS[p["tipo"]]["nome"], "Etapa": so.ETAPAS[p["etapa"]],
                       "Responsável": p.get("responsavel") or ""} for p in prox],
                     hide_index=True, use_container_width=True)
    else:
        st.caption("Nenhuma previsão nos próximos 30 dias.")


# ---------------------------------------------------------------- empresas


def _empresas(esc: str) -> None:
    hoje = _hoje()
    rg = _regras(esc, _versao())
    lics = _licencas(esc, _versao())
    emps = so.resumo_empresas(_processos(esc, _versao()), lics, hoje, rg, so.listar_empresas_cadastradas(esc))
    with st.expander("Cadastrar empresa", icon=":material/add_business:"):
        st.caption("Para a empresa que ainda não está nos clientes do Hub nem no Acessórias (ex.: constituição). "
                   "Ela passa a aparecer na busca do Novo processo.")
        _form_empresa(esc, None)
        _botao_acessorias(esc, "soc_emp")
    _kpis([("Empresas", len(emps), "#e2e8f0"),
           ("Com processo em andamento", sum(1 for e in emps if e["ativos"]), "#3b82f6"),
           ("Com alerta", sum(1 for e in emps if e["alertas"]), "#ef4444")])
    busca = st.text_input("Buscar", key="soc_emp_busca", placeholder="🔍  Nome da empresa ou CNPJ")
    b, d = so._sem_acento(busca.strip()), so.so_digitos(busca)
    if b:
        emps = [e for e in emps if b in so._sem_acento(e["empresa"]) or (d and d in e["cnpj"])]
    st.caption(f"{len(emps)} empresa(s). As com alerta aparecem primeiro. A mesma empresa é reconhecida pelo CNPJ "
               "(ou pelo nome, quando o processo não tem CNPJ).")
    sit_lic = {l["id"]: so.situacao_licenca(l.get("validade"), hoje, max(rg["licenca_avisos"] or [90])) for l in lics}
    for k, e in enumerate(emps[:150]):
        titulo = (f"**{e['empresa']}**" + (f" · {so.formatar_cnpj(e['cnpj'])}" if e["cnpj"] else "")
                  + f" — {e['ativos']} em andamento · {e['concluidos']} concluído(s) · {len(e['licencas'])} licença(s)"
                  + (f" · ⚠️ {e['alertas']} alerta(s)" if e["alertas"] else ""))
        with st.expander(titulo):
            cad = e.get("cadastro")
            if cad:
                st.markdown("<span class='soc-muted'>Cadastro do Societário: " + " · ".join(
                    _e(x) for x in [cad.get("contato"), cad.get("telefone"), cad.get("email"), cad.get("observacao")]
                    if x) + "</span>", unsafe_allow_html=True)
                if st.toggle("Editar cadastro", key=f"soc_emp_ed_{k}"):
                    _form_empresa(esc, cad)
            if e["ultima"]:
                st.caption(f"Última movimentação: {so.data_br(e['ultima'])}")
            for p in e["processos"]:
                c1, c2 = st.columns([5, 1])
                al = so.alertas_processo(p, hoje, rg)
                c1.markdown(f"**{_e(p['numero'])}** · {_e(so.TIPOS[p['tipo']]['nome'])} "
                            + _chip(so.ETAPAS[p["etapa"]], _COR_ETAPA[p["etapa"]])
                            + f"<span class='soc-muted'> responsável: {_e(p.get('responsavel') or '—')}"
                            + (f" · previsão {so.data_br(p.get('previsao'))}" if p.get("previsao") else "")
                            + (f" · {_e(al[0]['texto'])}" if al else "") + "</span>", unsafe_allow_html=True)
                c2.button("Abrir", key=f"soc_emp_p_{k}_{p['id']}", on_click=abrir_processo, args=(p["id"],),
                          use_container_width=True)
            for l in e["licencas"]:
                s = sit_lic[l["id"]]
                st.markdown(f"{_e(so.LICENCAS[l['tipo']])}" + (f" nº {_e(l['numero'])}" if l.get("numero") else "")
                            + f" · validade {so.data_br(l.get('validade')) or '—'} "
                            + _chip(so.SITUACOES_LICENCA[s], _COR_LIC[s]), unsafe_allow_html=True)
            if not e["processos"] and not e["licencas"]:
                st.caption("Nada registrado.")
    if len(emps) > 150:
        st.caption(f"+ {len(emps) - 150} empresa(s). Use a busca.")
    if not emps:
        st.caption("Nenhuma empresa ainda. Elas aparecem aqui ao abrir um processo ou cadastrar uma licença.")


def _form_empresa(esc: str, cad: dict | None) -> None:
    usuario = st.session_state.get("usuario_logado") or ""
    with st.form(f"soc_emp_f_{cad['id'] if cad else 'nova'}", clear_on_submit=cad is None):
        c1, c2 = st.columns([2, 1])
        nome = c1.text_input("Razão social ou nome pretendido *", value=(cad or {}).get("nome") or "")
        cnpj = c2.text_input("CNPJ / CPF", value=so.formatar_cnpj((cad or {}).get("cnpj")),
                             help="Deixe em branco se a empresa ainda não tem.")
        c3, c4, c5 = st.columns(3)
        contato = c3.text_input("Contato (sócio / responsável)", value=(cad or {}).get("contato") or "")
        telefone = c4.text_input("Telefone", value=(cad or {}).get("telefone") or "")
        email = c5.text_input("E-mail", value=(cad or {}).get("email") or "")
        obs = st.text_input("Observação", value=(cad or {}).get("observacao") or "")
        if st.form_submit_button("Salvar empresa", type="primary"):
            try:
                if cad:
                    so.atualizar_empresa_cadastrada(esc, cad["id"], nome, cnpj, contato, telefone, email, obs)
                else:
                    so.cadastrar_empresa(esc, usuario, nome, cnpj, contato, telefone, email, obs)
            except ValueError as exc:
                st.error(str(exc))
                return
            _recarregar()
            st.toast("Empresa salva.", icon="✅")
            st.rerun()


# ---------------------------------------------------------------- protocolos


def _protocolos(esc: str, usuario: str) -> None:
    hoje = _hoje()
    rg = _regras(esc, _versao())
    procs = _processos(esc, _versao())
    so_meus = st.toggle("Só os meus", value=False, key="soc_prot_meus")
    if so_meus:
        procs = [p for p in procs if p.get("responsavel") == usuario]
    lista = so.painel_protocolos(procs, _andamentos(esc, _versao()), hoje, rg)
    exig = [x for x in lista if x["etapa"] == so.EM_EXIGENCIA]
    verif = [x for x in lista if x["etapa"] == so.PROTOCOLADO and x["verificar"]]
    _kpis([("No órgão (protocolados)", sum(1 for x in lista if x["etapa"] == so.PROTOCOLADO), "#14b8a6"),
           ("Verificar hoje", len(verif), "#f59e0b"), ("Em exigência", len(exig), "#ef4444")])
    st.caption(f"Sem data marcada, o protocolado deve ser verificado a cada {rg['protocolado_dias_uteis']} dia(s) "
               "útil(eis) depois da última movimentação (ajustável em Configurações).")
    for x in lista:
        if x["etapa"] == so.EM_EXIGENCIA:
            situ = _chip("Responder exigência", "#ef4444")
        elif x["verificar"]:
            situ = _chip("Verificar hoje", "#f59e0b")
        else:
            situ = _chip(f"Verificar em {so.data_br(x['verificar_em'])}", "#94a3b8")
        with st.container(border=True):
            c1, c2 = st.columns([5, 1])
            c1.markdown(
                f"**{_e(x['numero'])}** · **{_e(x['empresa_nome'])}** · {_e(so.TIPOS[x['tipo']]['nome'])} "
                + _chip(so.ETAPAS[x["etapa"]], _COR_ETAPA[x["etapa"]]) + situ
                + "<div class='soc-muted'>" + " · ".join(v for v in [
                    _e(x.get("orgao")), f"protocolo {_e(x['protocolo'])}" if x.get("protocolo") else "sem nº de protocolo",
                    f"protocolado em {so.data_br(x['data_protocolo'])} ({x['dias_uteis']} dia(s) útil(eis))"
                    if x.get("data_protocolo") else "", f"responsável: {_e(x.get('responsavel') or '—')}"] if v)
                + "</div>" + (f"<div>{_e(x['proxima_acao'])}</div>" if x.get("proxima_acao") else ""),
                unsafe_allow_html=True)
            c2.button("Abrir", key=f"soc_prot_{x['id']}", on_click=abrir_processo, args=(x["id"],),
                      use_container_width=True, type="primary" if x["verificar"] else "secondary")
    if not lista:
        st.caption("Nenhum processo protocolado ou em exigência.")


# ---------------------------------------------------------------- documentos


def _documentos(esc: str) -> None:
    anexos = _anexos(esc, _versao())
    c1, c2 = st.columns([2, 1.4])
    busca = c1.text_input("Buscar", key="soc_doc_busca", placeholder="🔍  Arquivo, empresa, CNPJ ou nº do processo")
    cats = c2.multiselect("Tipo", list(_ROT_ANEXO), format_func=_ROT_ANEXO.get, key="soc_doc_cat",
                          placeholder="Todos")
    b, d = so._sem_acento(busca.strip()), so.so_digitos(busca)
    vis = [a for a in anexos if (not cats or a["categoria"] in cats) and (
        not b or b in so._sem_acento(f"{a['nome']} {a['empresa_nome']} {a['numero']}")
        or (len(d) >= 4 and d in so.so_digitos(a.get("cnpj"))))]
    st.caption(f"{len(vis)} documento(s) de {len(anexos)}. Selecione uma linha para baixar ou abrir o processo.")
    if not vis:
        return
    ev = st.dataframe([{"Arquivo": a["nome"], "Tipo": _ROT_ANEXO.get(a["categoria"], a["categoria"]),
                        "Processo": a["numero"], "Empresa": a["empresa_nome"],
                        "Enviado por": a.get("enviado_por") or "", "Data": so.data_br(a["criado_em"]),
                        "Tamanho": f"{a['tamanho'] / 1024:,.0f} KB".replace(",", ".")} for a in vis],
                      hide_index=True, use_container_width=True, height=min(460, 38 + 35 * len(vis)), key="soc_doc_tab",
                      on_select="rerun", selection_mode="single-row")
    try:
        i = ev.selection.rows[0]
    except (AttributeError, IndexError, TypeError):
        return
    if not 0 <= i < len(vis):
        return
    a = vis[i]
    arq = so.baixar_anexo(esc, a["id"])
    with st.container(border=True):
        st.markdown(f"**{_e(a['nome'])}** · {_e(a['numero'])} · {_e(a['empresa_nome'])}")
        b1, b2, _ = st.columns([1, 1, 3])
        if arq:
            b1.download_button("Baixar", arq["conteudo"], file_name=arq["nome"], icon=":material/download:",
                               mime=arq.get("tipo_mime") or "application/octet-stream", key=f"soc_doc_dl_{a['id']}")
        b2.button("Abrir processo", key=f"soc_doc_ab_{a['id']}", on_click=abrir_processo, args=(a["processo_id"],))


# ---------------------------------------------------------------- relatórios


def _periodo(hoje: date) -> tuple[date, date]:
    op = st.segmented_control("Período", ["Este mês", "Últimos 30 dias", "Últimos 90 dias", "Este ano",
                                          "Escolher"], default="Este mês", key="soc_rel_per")
    if op == "Últimos 30 dias":
        return hoje - timedelta(days=29), hoje
    if op == "Últimos 90 dias":
        return hoje - timedelta(days=89), hoje
    if op == "Este ano":
        return date(hoje.year, 1, 1), hoje
    if op == "Escolher":
        per = st.date_input("De / até", value=(hoje.replace(day=1), hoje), format="DD/MM/YYYY", key="soc_rel_datas")
        if isinstance(per, (tuple, list)) and len(per) == 2:
            return per[0], per[1]
    return hoje.replace(day=1), hoje


def _barras(itens: list[tuple[str, float, str]], cor: str = "#22e08a") -> str:
    maior = max([v for _, v, _ in itens] or [1]) or 1
    return "".join(f'<div class="soc-bar"><div class="t"><span>{_e(t)}</span><b>{_e(r)}</b></div>'
                   f'<div class="tr"><span style="width:{v / maior * 100:.0f}%; background:{cor}"></span></div></div>'
                   for t, v, r in itens)


def _relatorios(esc: str) -> None:
    hoje = _hoje()
    rg = _regras(esc, _versao())
    ini, fim = _periodo(hoje)
    rel = so.relatorio_produtividade(_processos(esc, _versao()), _andamentos(esc, _versao()), ini, fim, hoje, rg)
    t = rel["totais"]
    st.caption(f"De {so.data_br(ini)} a {so.data_br(fim)}. Processos cancelados ficam de fora.")
    _kpis([("Abertos no período", t["abertos"], "#3b82f6"), ("Concluídos no período", t["concluidos"], "#22e08a"),
           ("Tempo médio até concluir", f"{t['tempo_medio']:.0f} dia(s)" if t["tempo_medio"] is not None else "—",
            "#e2e8f0"),
           ("Concluídos no prazo", f"{t['no_prazo_pct']}%" if t["no_prazo_pct"] is not None else "—", "#f59e0b"),
           ("Andamentos registrados", t["andamentos"], "#a855f7")])

    st.markdown("**Por colaborador**")
    if rel["pessoas"]:
        st.dataframe([{"Colaborador": r["responsavel"], "Em andamento": r["ativos"], "Atrasados": r["atrasados"],
                       "Abertos no período": r["abertos"], "Concluídos": r["concluidos"],
                       "No prazo": r["no_prazo"],
                       "Tempo médio (dias)": f"{r['tempo_medio']:.0f}" if r["tempo_medio"] is not None else "—",
                       "Andamentos registrados": r["andamentos"]} for r in rel["pessoas"]],
                     hide_index=True, use_container_width=True)
        st.caption("\"Em andamento\" e \"Atrasados\" são de hoje; as demais colunas, do período. Tempo médio = da "
                   "abertura à conclusão, em dias corridos.")
    else:
        st.caption("Nenhum processo ainda.")

    c1, c2 = st.columns(2)
    with c1:
        g = rel["gargalos"]
        corpo = _barras([(f"{so.ETAPAS[x['etapa']]} ({x['processos']})", x["media_dias"],
                          f"{x['media_dias']:.0f} dia(s) em média · máx. {x['max_dias']}") for x in g], "#f59e0b") \
            or '<div class="soc-muted">Nenhum processo em andamento.</div>'
        st.markdown(f'<div class="soc-card"><h4>Onde os processos travam</h4>'
                    f'<div class="soc-muted" style="margin-bottom:6px">Há quantos dias os processos em andamento '
                    f'estão na etapa atual.</div>{corpo}</div>', unsafe_allow_html=True)
    with c2:
        pt = rel["por_tipo"]
        corpo = _barras([(f"{x['tipo']} ({x['concluidos']})", x["tempo_medio"] or 0,
                          f"{x['tempo_medio']:.0f} dia(s)") for x in pt]) \
            or '<div class="soc-muted">Nenhum processo concluído no período.</div>'
        st.markdown(f'<div class="soc-card"><h4>Tempo médio até concluir, por tipo</h4>{corpo}</div>',
                    unsafe_allow_html=True)

    st.markdown("**Parados há mais tempo na mesma etapa**")
    for x in rel["mais_parados"]:
        c1, c2 = st.columns([5, 1])
        c1.markdown(f"**{_e(x['numero'])}** · {_e(x['empresa_nome'])} · {_e(so.TIPOS[x['tipo']]['nome'])} "
                    + _chip(so.ETAPAS[x["etapa"]], _COR_ETAPA[x["etapa"]])
                    + f"<span class='soc-muted'> há {x['dias_na_etapa']} dia(s) · "
                      f"{_e(x.get('responsavel') or 'sem responsável')}</span>", unsafe_allow_html=True)
        c2.button("Abrir", key=f"soc_rel_{x['id']}", on_click=abrir_processo, args=(x["id"],),
                  use_container_width=True)
    if not rel["mais_parados"]:
        st.caption("Nenhum processo em andamento.")


# ---------------------------------------------------------------- assistente IA

_ROT_REV = {"aguardando": "Na fila", "em_validacao": "Aguardando validação", "concluida": "Validada", "erro": "Erro"}


def _abrir_revisao(revisao_id: int) -> None:
    st.session_state["tela"] = "societario"
    st.session_state["soc_secao"] = "Assistente IA"
    st.session_state["soc_rev"] = revisao_id


def _iniciar_revisao(esc: str, usuario: str, titulo: str, texto: str, processo_id, tipo: str, contexto: str,
                     arquivo: bytes | None = None) -> None:
    chave = so.chave_claude(esc)
    if not chave:
        st.error("Falta a chave da Claude do escritório. O administrador cadastra em Admissões › Canais › IA "
                 "(API Key da Claude); a mesma chave vale para o Hub Societário.")
        return
    rid = so.criar_revisao(esc, usuario, titulo, texto, processo_id, titulo, arquivo)
    with st.spinner("A IA está revisando a minuta… (pode levar alguns minutos)"):
        try:
            res = so.revisar_minuta(texto, chave, tipo, contexto)
        except so.ErroIA as exc:
            so.gravar_resultado(esc, rid, None, str(exc))
            st.error(str(exc))
            return
    so.gravar_resultado(esc, rid, res)
    _recarregar()
    _abrir_revisao(rid)
    st.rerun()


def _assistente(esc: str, usuario: str) -> None:
    st.caption("A IA revisa contratos sociais, alterações, distratos e requerimentos: ortografia, cláusulas, dados "
               "dos sócios, CPF/CNPJ, quotas × capital social, objeto social e CNAE, e cláusulas obrigatórias "
               "ausentes — com a fundamentação. Nada é alterado no documento original: você aceita ou recusa cada "
               "sugestão e a versão revisada sai em Word. Use a IA para conferir, e a conferência final é sempre do "
               "responsável.")
    procs = [p for p in _processos(esc, _versao()) if p["etapa"] not in so.ENCERRADAS and p.get("ia_habilitada")]
    por_id = {p["id"]: p for p in procs}
    with st.container(border=True):
        st.markdown("**Nova revisão**")
        pid = st.selectbox("Processo (opcional)", [None] + list(por_id), key="soc_ia_proc",
                           format_func=lambda i: "— sem processo —" if i is None else
                           f"{por_id[i]['numero']} · {por_id[i]['empresa_nome']} · {so.TIPOS[por_id[i]['tipo']]['nome']}")
        tipo = por_id[pid]["tipo"] if pid else st.selectbox(
            "Tipo de documento", list(so.TIPOS), index=1, format_func=lambda t: so.TIPOS[t]["nome"], key="soc_ia_tipo")
        anexo_id = None
        if pid:
            todos = _anexos(esc, _versao())
            com_rev = st.checkbox("Mostrar também as minutas já revisadas pela IA", key=f"soc_ia_rev_{pid}",
                                  value=False) if any(a["processo_id"] == pid and a["categoria"] == "minuta_revisada"
                                                      for a in todos) else False
            legiveis = so.anexos_para_revisao(todos, pid, com_rev)
            if legiveis:
                por_anexo = {a["id"]: a for a in legiveis}
                anexo_id = st.selectbox(
                    "Anexo do processo para revisar", list(por_anexo) + [None], key=f"soc_ia_anx_{pid}_{com_rev}",
                    format_func=lambda i: "— enviar ou colar uma minuta nova —" if i is None else
                    f"{por_anexo[i]['nome']} · {_ROT_ANEXO.get(por_anexo[i]['categoria'], por_anexo[i]['categoria'])}"
                    f" · {so.data_br(por_anexo[i]['criado_em'])}",
                    help="A minuta mais recente do processo já vem escolhida. Se enviar um arquivo ou colar um texto "
                         "abaixo, a IA revisa esse no lugar do anexo.")
            else:
                st.info("Este processo não tem minuta anexada em Word, PDF ou texto. Envie o arquivo ou cole o texto abaixo.")
        arq = st.file_uploader("Minuta em Word (.docx), PDF ou texto" + (" (outra minuta)" if anexo_id else ""),
                               type=["docx", "pdf", "txt"], key="soc_ia_arq")
        colado = st.text_area("…ou cole o texto da minuta", height=160, key="soc_ia_txt")
        contexto = st.text_area("Contexto (opcional)", height=80, key="soc_ia_ctx",
                                value=(por_id[pid].get("descricao") or "") if pid else "",
                                placeholder="Ex.: exigência da Junta, o que a alteração deve fazer, capital correto…")
        if st.button("Revisar com IA", type="primary", icon=":material/auto_awesome:"):
            texto, titulo, original = colado.strip(), "Texto colado", None
            if arq is not None:
                try:
                    texto, titulo, original = so.extrair_texto(arq.name, arq.getvalue()), arq.name, arq.getvalue()
                except Exception as exc:  # noqa: BLE001
                    st.error(f"Não consegui ler o texto do arquivo: {exc}")
                    return
                if pid:
                    so.anexar(esc, pid, usuario, arq.name, arq.getvalue(), arq.type or "", "minuta")
                    _recarregar()
            elif not texto and anexo_id:
                anexo = so.baixar_anexo(esc, anexo_id)
                try:
                    texto, titulo = so.extrair_texto(anexo["nome"], anexo["conteudo"]), anexo["nome"]
                    original = anexo["conteudo"]
                except Exception as exc:  # noqa: BLE001 - arquivo corrompido ou formato estranho
                    st.error(f"Não consegui ler o texto do anexo: {exc}")
                    return
            if not texto:
                st.error("Envie o arquivo ou cole o texto da minuta.")
                return
            _iniciar_revisao(esc, usuario, titulo, texto, pid, tipo, contexto, original)

    revs = so.listar_revisoes(esc)
    st.markdown("**Revisões**")
    for r in revs:
        c1, c2 = st.columns([5, 1])
        c1.markdown(f"**{_e(r['titulo'])}**" + (f" · {_e(r['numero'])} {_e(r['empresa_nome'])}" if r.get("numero") else "")
                    + f"  \n<span class='soc-muted'>{_ROT_REV.get(r['status'], r['status'])} · "
                      f"{r['n_apontamentos'] or 0} apontamento(s) · {_e(r['criado_por'])} em {so.data_br(r['criado_em'])}"
                    + (f" · {_e(r['erro'])}" if r.get("erro") else "") + "</span>", unsafe_allow_html=True)
        if r["status"] != "erro":
            c2.button("Abrir", key=f"soc_ia_ab_{r['id']}", on_click=_abrir_revisao, args=(r["id"],))
    if not revs:
        st.caption("Nenhuma revisão ainda.")


def _voltar_rev() -> None:
    st.session_state.pop("soc_rev", None)


def _decidir(esc: str, rid: int, aid: int, status: str) -> None:
    so.decidir_apontamento(esc, rid, aid, status)


def _trecho_html(texto: str, i, aps: list[dict]) -> str:
    if i is None:
        return _e(texto)
    a = aps[i]
    cor = _COR_GRAV.get(a.get("gravidade"), "#f59e0b")
    corpo = (f"<del>{_e(texto)}</del> <ins>{_e(a['sugestao'])}</ins>"
             if a.get("status") == "aceito" and a.get("sugestao") else _e(texto))
    return (f'<mark style="background:{cor}26; border-bottom:2px solid {cor}" title="{_e(a.get("titulo"))}">'
            f'<sup style="color:{cor}">{i + 1}</sup>{corpo}</mark>')


def _revisao(esc: str, usuario: str, rid: int) -> None:
    st.button("← Assistente IA", key="soc_rev_voltar", on_click=_voltar_rev)
    r = so.obter_revisao(esc, rid)
    if not r or not r.get("resultado"):
        st.warning("Revisão não encontrada.")
        return
    res = r["resultado"]
    aps = res.get("apontamentos") or []
    st.markdown(f"### Revisão: {_e(r['titulo'])}")
    if r.get("numero"):
        st.markdown(f'<div class="soc-muted">Processo {_e(r["numero"])} · {_e(r["empresa_nome"])}</div>',
                    unsafe_allow_html=True)
        st.button("Abrir processo", key="soc_rev_proc", on_click=abrir_processo, args=(r["processo_id"],))
    st.info(res.get("resumo") or "Sem resumo.")
    dec = {s: sum(1 for a in aps if a.get("status") == s) for s in ("pendente", "aceito", "recusado")}
    st.caption(f"{len(aps)} apontamento(s): {dec['aceito']} aceito(s), {dec['recusado']} recusado(s), "
               f"{dec['pendente']} pendente(s). Estado: {_ROT_REV.get(r['status'], r['status'])}.")
    c1, c2 = st.columns([1, 1.25])
    with c1:
        st.markdown("**Minuta original**")
        partes = so.marcar_trechos(r["texto_original"], aps)
        marcados = {i for _, i in partes if i is not None}
        st.html('<div class="soc-doc">' + "".join(_trecho_html(t, i, aps) for t, i in partes) + "</div>")
        st.caption("Trechos com problema marcados com o número do apontamento. Os aceitos aparecem riscados, "
                   "com a correção em verde. O original não muda.")
    with c2:
        st.markdown("**Análise da IA**")
        if not aps:
            st.success("A IA não encontrou problemas.")
        for n, a in enumerate(aps):
            cor = _COR_GRAV[a["gravidade"]]
            st.markdown(
                f'<div class="soc-sug" style="border-left:4px solid {cor}">'
                f'<b style="color:{cor}; margin-right:6px">#{n + 1}</b>'
                f'{_chip(so.GRAVIDADES[a["gravidade"]], cor)}{_chip(so.CATEGORIAS_IA[a["categoria"]], "#94a3b8")}'
                + ("" if n in marcados or not a.get("trecho") else
                   '<span class="soc-muted">trecho não localizado no texto</span>')
                + f'<div style="font-weight:700; margin:6px 0">{_e(a["titulo"])}</div>'
                f'<div>{_e(a["problema"])}</div>'
                + (f'<div class="soc-muted" style="margin-top:6px">Trecho:</div><div class="tr">{_e(a["trecho"])}</div>'
                   if a.get("trecho") else "")
                + (f'<div class="soc-muted" style="margin-top:6px">Sugestão:</div><div class="sg">{_e(a["sugestao"])}</div>'
                   if a.get("sugestao") else "")
                + (f'<div class="soc-muted" style="margin-top:6px">Fundamento: {_e(a["fundamento"])}</div>'
                   if a.get("fundamento") else "") + "</div>", unsafe_allow_html=True)
            b1, b2, b3 = st.columns([1, 1, 2])
            st_atual = a.get("status", "pendente")
            b1.button("Aceitar", key=f"soc_ap_a_{a['id']}", type="primary" if st_atual == "aceito" else "secondary",
                      on_click=_decidir, args=(esc, rid, a["id"], "pendente" if st_atual == "aceito" else "aceito"))
            b2.button("Recusar", key=f"soc_ap_r_{a['id']}", type="primary" if st_atual == "recusado" else "secondary",
                      on_click=_decidir, args=(esc, rid, a["id"], "pendente" if st_atual == "recusado" else "recusado"))
            b3.caption({"aceito": "✅ Aceito", "recusado": "❌ Recusado"}.get(st_atual, "Pendente"))
    st.divider()
    if st.button("Gerar versão revisada (Word e PDF)", type="primary", icon=":material/description:",
                 disabled=dec["aceito"] == 0,
                 help="Aplica só as sugestões aceitas, no mesmo layout do arquivo original. O original fica guardado."):
        with st.spinner("Gerando o Word e o PDF…"):
            out = so.finalizar_revisao(esc, rid, usuario)
        st.session_state[f"soc_rev_out_{rid}"] = out
        _recarregar()
    out = st.session_state.get(f"soc_rev_out_{rid}")
    if out:
        st.success(f"Versão revisada pronta: {out['aceitos'] - len(out['manuais'])} sugestão(ões) aplicada(s)."
                   + (" Também anexada ao processo." if out.get("anexo_id") else ""))
        if out["manuais"]:
            st.warning("Estas sugestões aceitas não puderam ser aplicadas sozinhas (trecho não encontrado ou cláusula "
                       "a acrescentar) — ajuste à mão no Word:\n\n"
                       + "\n".join(f"- **{a['titulo']}**: {a['sugestao']}" for a in out["manuais"]))
        if not out.get("layout_original"):
            st.caption("A minuta foi colada como texto (ou não veio em Word): o Word sai com o texto corrigido, "
                       "sem a formatação original. Para manter o layout, revise a partir do arquivo Word.")
        d1, d2, _ = st.columns([1, 1, 2])
        d1.download_button("Baixar Word", out["docx"], file_name=out["nome"], icon=":material/description:",
                           mime=so.MIME_DOCX, use_container_width=True)
        if out.get("pdf"):
            d2.download_button("Baixar PDF", out["pdf"], file_name=out["nome_pdf"], icon=":material/picture_as_pdf:",
                               mime="application/pdf", use_container_width=True)
        elif out.get("aviso_pdf"):
            st.caption(out["aviso_pdf"])


# ---------------------------------------------------------------- configurações


def _configuracoes(esc: str, usuario: str) -> None:
    rg = so.obter_regras(esc)
    st.caption("Intervalos dos alertas automáticos e dos avisos. Valem para todo o escritório.")
    with st.form("soc_cfg"):
        c1, c2 = st.columns(2)
        parado = c1.number_input("Alertar processo sem movimentação após (dias)", 1, 60, int(rg["sem_movimentacao_dias"]))
        prot = c2.number_input("Processo protocolado: verificar a cada (dias úteis)", 1, 30, int(rg["protocolado_dias_uteis"]))
        prazo = c1.text_input("Avisar antes da previsão de conclusão (dias, separados por vírgula)",
                              ", ".join(str(x) for x in rg["prazo_avisos"]))
        lic = c2.text_input("Avisar antes do vencimento da licença (dias)", ", ".join(str(x) for x in rg["licenca_avisos"]))
        if st.form_submit_button("Salvar", type="primary"):
            try:
                so.salvar_regras(esc, usuario, {"sem_movimentacao_dias": parado, "protocolado_dias_uteis": prot,
                                                "prazo_avisos": prazo, "licenca_avisos": lic})
            except ValueError:
                st.error("Use só números separados por vírgula.")
            else:
                _recarregar()
                st.success("Configuração salva.")
    st.markdown("**Assistente IA**")
    if so.chave_claude(esc):
        st.success("Chave da Claude configurada (a mesma de Admissões › Canais › IA).")
    else:
        st.warning("Sem chave da Claude. Cadastre em Admissões › Canais › IA (API Key da Claude): a mesma chave "
                   "vale para o Hub Societário.")
    st.caption("Integrações com Acessórias, ONVIO, WhatsApp e órgãos públicos, e avisos por e-mail/WhatsApp, entram "
               "nas próximas versões.")


# ---------------------------------------------------------------- pop-up de lembretes


@st.dialog("Lembrete de acompanhamento", width="large")
def _dialogo(esc: str, usuario: str) -> None:
    # relê a cada clique (o pop-up roda como fragmento: adiar/concluir
    # atualiza só ele e os demais lembretes continuam na tela)
    lembs = so.lembretes_vencidos(esc, usuario)
    if not lembs:
        st.success("Tudo em dia: nenhum lembrete pendente agora.")
    for l in lembs[:5]:
        with st.container(border=True):
            if l.get("numero"):
                st.markdown(f"**{_e(l['empresa_nome'])}**  \nProcesso {_e(l['numero'])} · "
                            f"{_e(so.TIPOS.get(l.get('tipo'), {}).get('nome', ''))} · {so.ETAPAS.get(l.get('etapa'), '')}")
            st.markdown(f"🔔 {_e(l['texto'])}")
            if l.get("numero"):
                st.caption(f"Última movimentação: {so.data_br(l.get('ultima_movimentacao'))}"
                           + (f" · Protocolo: {l['protocolo']}" if l.get("protocolo") else "")
                           + f" · Lembrete de {so.data_br(l['quando'])}")
            c1, c2, c3, c4 = st.columns(4)
            if l.get("processo_id") and c1.button("Atualizar andamento", key=f"soc_pp_ab_{l['id']}", type="primary"):
                so.concluir_lembrete(esc, l["id"])
                abrir_processo(l["processo_id"])
                st.rerun()
            c2.button("Adiar 1 hora", key=f"soc_pp_1h_{l['id']}", on_click=_adiar, args=(esc, l["id"], 1))
            c3.button("Adiar 1 dia", key=f"soc_pp_1d_{l['id']}", on_click=_adiar, args=(esc, l["id"], 24))
            c4.button("Concluir", key=f"soc_pp_ok_{l['id']}", on_click=so.concluir_lembrete, args=(esc, l["id"]))
    if len(lembs) > 5:
        st.caption(f"+ {len(lembs) - 5} lembrete(s) na Agenda do Hub Societário.")
    if st.button("Fechar" if not lembs else "Fechar (lembrar mais tarde)", key="soc_pp_fechar"):
        st.rerun()


# ---------------------------------------------------------------- aviso do Windows
# O aviso usa as notificações do navegador: aparece no canto da tela, com som,
# mesmo com a pessoa em outro programa, enquanto o Hub estiver aberto numa aba.
# O navegador pede permissão uma vez (botão abaixo). O código roda na página do
# Hub (window.parent, mesma origem), para o clique no aviso continuar valendo
# depois que a tela do Streamlit se refaz.

_JS_ESCONDER = """
const f = window.frameElement;
function esconder() { if (f) { f.style.height = '0px'; if (f.parentElement) f.parentElement.style.display = 'none'; } }
"""


def _ativar_avisos_windows() -> None:
    """Faixa que pede a permissão dos avisos do Windows; some quando já foi dada."""
    components.html("""
<style>
  body { margin: 0; font-family: "Source Sans Pro", system-ui, sans-serif; background: transparent; color: #e6edf3; }
  .faixa { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-radius: 10px;
           border: 1px solid rgba(250, 204, 21, .45); background: rgba(250, 204, 21, .08); font-size: 14px; }
  .faixa b { color: #facc15; }
  button { margin-left: auto; padding: 6px 14px; border-radius: 8px; border: 0; cursor: pointer;
           background: #22c55e; color: #052e16; font-weight: 600; white-space: nowrap; }
</style>
<div class="faixa" id="faixa" style="display:none">
  <span id="msg"></span><button id="bt" style="display:none">Ativar avisos no Windows</button>
</div>
<script>
""" + _JS_ESCONDER + """
const W = window.parent, N = W.Notification;
const faixa = document.getElementById('faixa'), msg = document.getElementById('msg'), bt = document.getElementById('bt');
if (!N || N.permission === 'granted') { esconder(); }
else if (N.permission === 'denied') {
  faixa.style.display = 'flex';
  msg.innerHTML = '<b>Avisos do Windows bloqueados.</b> Para receber os lembretes mesmo em outro programa: '
    + 'clique no cadeado ao lado do endereço do Hub › Notificações › Permitir, e recarregue a página.';
} else {
  faixa.style.display = 'flex';
  bt.style.display = 'block';
  msg.innerHTML = '<b>Lembretes no canto da tela:</b> ative os avisos do Windows para ver os lembretes '
    + 'mesmo trabalhando em outro programa.';
  bt.onclick = async () => {
    const r = await N.requestPermission();
    if (r === 'granted') {
      new N('Hub Societário', {body: 'Avisos ativados: os lembretes vão aparecer aqui no canto da tela.'});
      esconder();
    } else { location.reload(); }
  };
}
</script>""", height=48)


def _aviso_windows(lembs: list[dict]) -> None:
    """Mostra cada lembrete vencido como aviso do Windows (se a permissão
    já foi dada). A etiqueta por lembrete evita aviso repetido."""
    avisos = []
    for l in lembs[:5]:
        corpo = l["texto"]
        if l.get("numero"):
            corpo = f"{l.get('empresa_nome') or ''} · {l['numero']}\n{corpo}"
        avisos.append({"tag": f"soc-lembrete-{l['id']}", "titulo": "🔔 Lembrete do Hub Societário", "corpo": corpo})
    if len(lembs) > 5:
        avisos.append({"tag": "soc-lembrete-mais", "titulo": "Hub Societário",
                       "corpo": f"+ {len(lembs) - 5} lembrete(s) na Agenda."})
    codigo = """
(function () {
  const N = window.Notification;
  if (!N || N.permission !== 'granted') return;
  for (const a of AVISOS) {
    try {
      const n = new N(a.titulo, {body: a.corpo, tag: a.tag, renotify: true, requireInteraction: true});
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) {}
  }
})();""".replace("AVISOS", json.dumps(avisos, ensure_ascii=False))
    components.html("<script>" + _JS_ESCONDER + "esconder();\n"
                    "const s = window.parent.document.createElement('script');\n"
                    # "<\/" para um texto do lembrete com </script> não fechar a tag
                    "s.textContent = " + json.dumps(codigo).replace("</", "<\\/") + ";\n"
                    "window.parent.document.head.appendChild(s); s.remove();</script>", height=0)


def _adiar(esc: str, lembrete_id: int, horas: int) -> None:
    so.adiar_lembrete(esc, lembrete_id, datetime.now(so.FUSO) + timedelta(hours=horas))


@st.fragment(run_every=60)
def _vigiar_lembretes(esc: str, usuario: str) -> None:
    """Roda sozinho a cada minuto, mesmo com a tela parada. Quando chega
    a hora de um lembrete que ainda não apareceu (ou passaram os 30 minutos
    dos já mostrados), recarrega a tela para o pop-up abrir."""
    agora = datetime.now(so.FUSO)
    ultima = st.session_state.get("soc_pp_consulta")
    if ultima and agora - ultima < timedelta(seconds=55):
        return  # a tela acabou de consultar
    st.session_state["soc_pp_consulta"] = agora
    try:
        lembs = so.lembretes_vencidos(esc, usuario, agora)
    except Exception:  # noqa: BLE001 - banco fora do ar não pode derrubar a tela
        return
    if not lembs:
        return
    visto = st.session_state.get("soc_pp_visto")
    novos = {l["id"] for l in lembs} - st.session_state.get("soc_pp_ids", set())
    if novos or not visto or agora - visto >= timedelta(minutes=30):
        st.session_state.pop("soc_pp_consulta", None)  # a tela inteira consulta de novo e abre o pop-up
        st.rerun(scope="app")


def popup_lembretes(esc: str, usuario: str) -> None:
    """Abre o pop-up com os lembretes vencidos do usuário. Chamado pelo
    app_conciliacao.py nas telas do Hub. Abre quando vence um lembrete que
    ainda não apareceu nesta sessão; os já mostrados voltam depois de 30
    minutos (fechar no X ou em "Fechar" não apaga o lembrete). Um vigia
    confere a cada minuto, então o pop-up abre na hora mesmo sem cliques."""
    if not esc or not usuario:
        return
    _checar_popup(esc, usuario)
    _vigiar_lembretes(esc, usuario)


def _checar_popup(esc: str, usuario: str) -> None:
    agora = datetime.now(so.FUSO)
    ultima = st.session_state.get("soc_pp_consulta")
    if ultima and agora - ultima < timedelta(seconds=60):
        return  # no máximo uma consulta ao banco por minuto
    st.session_state["soc_pp_consulta"] = agora
    try:
        lembs = so.lembretes_vencidos(esc, usuario, agora)
    except Exception:  # noqa: BLE001 - banco fora do ar não pode derrubar a tela que chamou
        return
    if not lembs:
        return
    mostrados = st.session_state.setdefault("soc_pp_ids", set())
    visto = st.session_state.get("soc_pp_visto")
    novos = {l["id"] for l in lembs} - mostrados
    if novos or not visto or agora - visto >= timedelta(minutes=30):
        mostrados.update(l["id"] for l in lembs)
        st.session_state["soc_pp_visto"] = agora
        _aviso_windows(lembs)
        _dialogo(esc, usuario)

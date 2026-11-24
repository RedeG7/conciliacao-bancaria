"""Tela do Hub Societário (Streamlit). Os dados e as regras ficam em
societario.py; aqui só telas, filtros e botões. Chamada por
app_conciliacao.py: render(cabecalho_app, pode_configurar, eh_global),
menu_lateral(pode_configurar) e popup_lembretes(...)."""

from __future__ import annotations

import html
from datetime import date, datetime, timedelta
from typing import Callable

import streamlit as st

import auth
import clientes
import societario as so

_COR_NIVEL = {so.CRITICO: "#ef4444", so.ATENCAO: "#f59e0b", so.INFO: "#3b82f6"}
_ROT_NIVEL = {so.CRITICO: "Urgente", so.ATENCAO: "Atenção", so.INFO: "Acompanhar"}
_COR_ETAPA = {so.A_INICIAR: "#64748b", so.EM_ELABORACAO: "#3b82f6", so.EM_ANALISE: "#a855f7",
              so.PROTOCOLADO: "#14b8a6", so.EM_EXIGENCIA: "#ef4444", so.CONCLUIDO: "#22e08a",
              so.CANCELADO: "#475569"}
_COR_LIC = {so.VIGENTE: "#22e08a", so.A_VENCER: "#f59e0b", so.VENCIDA: "#ef4444", so.SEM_VALIDADE: "#94a3b8"}
_COR_GRAV = {"alta": "#ef4444", "media": "#f59e0b", "baixa": "#3b82f6"}

_SECOES = [
    ("Visão geral", ":material/dashboard:"),
    ("Processos", ":material/view_kanban:"),
    ("Novo processo", ":material/add_circle:"),
    ("Licenças", ":material/verified:"),
    ("Agenda", ":material/event:"),
    ("Assistente IA", ":material/auto_awesome:"),
    ("Configurações", ":material/settings:"),
]


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
    .soc-tl .i:before {content:""; position:absolute; left:-23px; top:4px; width:12px; height:12px; border-radius:50%;
                       background:#22e08a;}
    .soc-tl .i.pend:before {background:#475569;}
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

    if secao == "Processos" and st.session_state.get("soc_proc"):
        _detalhe(esc, usuario, st.session_state["soc_proc"])
        return
    if secao == "Assistente IA" and st.session_state.get("soc_rev"):
        _revisao(esc, usuario, st.session_state["soc_rev"])
        return

    st.markdown(f"### {secao}")
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
    elif secao == "Configurações":
        _configuracoes(esc, usuario)


# ---------------------------------------------------------------- visão geral


def _kpis(itens: list[tuple[str, object, str]]) -> None:
    st.markdown('<div class="soc-kpis">' + "".join(
        f'<div class="soc-kpi"><div class="l">{_e(l)}</div><div class="v" style="color:{c}">{_e(v)}</div></div>'
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

    # Kanban: uma coluna por etapa; ◀ ▶ movem o cartão e registram o andamento
    cols = st.columns(len(so.ETAPAS_KANBAN))
    for c, etapa in zip(cols, so.ETAPAS_KANBAN):
        cartoes = [p for p in vis if p["etapa"] == etapa]
        if etapa == so.CONCLUIDO:
            cartoes = cartoes[:15]
        c.markdown(f'<div class="soc-col-h" style="border-color:{_COR_ETAPA[etapa]}">{so.ETAPAS[etapa]} '
                   f'<span class="soc-muted">({sum(1 for p in vis if p["etapa"] == etapa)})</span></div>',
                   unsafe_allow_html=True)
        idx = so.ETAPAS_KANBAN.index(etapa)
        for p in cartoes:
            al = so.alertas_processo(p, hoje, rg)
            nivel = min((a["nivel"] for a in al), key=lambda n: so._PESO[n], default=None)
            with c.container(border=True):
                st.markdown(
                    f'<div class="soc-muted">{_e(p["numero"])}</div><b>{_e(p["empresa_nome"])}</b><br>'
                    f'<span style="font-size:.85rem">{_e(so.TIPOS[p["tipo"]]["nome"])}</span><br>'
                    + (_chip(so.PRIORIDADES[p["prioridade"]], "#ef4444" if p["prioridade"] in ("alta", "urgente")
                             else "#94a3b8") if p["prioridade"] != "normal" else "")
                    + (_chip(_ROT_NIVEL[nivel], _COR_NIVEL[nivel]) if nivel else "")
                    + f'<div class="soc-muted">{_e(p.get("responsavel") or "sem responsável")} · '
                      f'{p["check_feitos"]}/{p["check_total"]}</div>', unsafe_allow_html=True)
                st.button("Abrir", key=f"soc_k_o_{p['id']}", on_click=abrir_processo, args=(p["id"],),
                          use_container_width=True)
                b1, b2 = st.columns(2)
                b1.button("◀", key=f"soc_k_l_{p['id']}", disabled=idx == 0, use_container_width=True,
                          help=f"Voltar para {so.ETAPAS[so.ETAPAS_KANBAN[idx - 1]]}" if idx else None,
                          on_click=_mover, args=(esc, usuario, p, so.ETAPAS_KANBAN[idx - 1] if idx else etapa))
                ult = idx == len(so.ETAPAS_KANBAN) - 1
                b2.button("▶", key=f"soc_k_r_{p['id']}", disabled=ult, use_container_width=True,
                          help=None if ult else f"Mover para {so.ETAPAS[so.ETAPAS_KANBAN[idx + 1]]}",
                          on_click=_mover, args=(esc, usuario, p, so.ETAPAS_KANBAN[idx if ult else idx + 1]))


# ---------------------------------------------------------------- novo processo


def _empresa_campos(esc: str, chave: str) -> tuple[str, str]:
    """Empresa vinda do cadastro de clientes do Hub ou digitada."""
    cads = clientes.listar_clientes(esc)
    opcoes = [None] + [c["id"] for c in cads]
    por_id = {c["id"]: c for c in cads}
    escolha = st.selectbox("Empresa cadastrada", opcoes, key=f"{chave}_cad",
                           format_func=lambda i: "— digitar abaixo —" if i is None else
                           f"{por_id[i]['nome']}" + (f" · {so.formatar_cnpj(por_id[i]['cnpj'])}" if por_id[i].get("cnpj") else ""),
                           help="Clientes cadastrados em Gerenciar Clientes. Empresa nova (constituição): digite.")
    if escolha is not None:
        return por_id[escolha]["nome"], por_id[escolha].get("cnpj") or ""
    c1, c2 = st.columns([2, 1])
    nome = c1.text_input("Empresa (razão social ou nome pretendido)", key=f"{chave}_nome")
    cnpj = c2.text_input("CNPJ / CPF", key=f"{chave}_cnpj")
    return nome, cnpj


def _novo(esc: str, usuario: str) -> None:
    st.caption("O número do processo, quem abriu e a data e hora ficam registrados automaticamente. O checklist do "
               "tipo escolhido é carregado na abertura.")
    usuarios = _usuarios(esc)
    c1, c2 = st.columns(2)
    tipo = c1.selectbox("Tipo de processo", list(so.TIPOS), format_func=lambda t: so.TIPOS[t]["nome"],
                        index=1, key="soc_n_tipo")
    orgao = c2.selectbox("Órgão", so.ORGAOS, key="soc_n_orgao_" + tipo,
                         index=so.ORGAOS.index(so.TIPOS[tipo]["orgao"]))
    empresa, cnpj = _empresa_campos(esc, "soc_n")
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
            p = so.criar_processo(esc, usuario, tipo, empresa, cnpj, resp, prio, prev, desc, orgao, ia, lemb)
            for a in arqs or []:
                so.anexar(esc, p["id"], usuario, a.name, a.getvalue(), a.type or "",
                          categoria="minuta" if a.name.lower().endswith((".docx", ".doc")) else "documento")
        except ValueError as exc:
            st.error(str(exc))
            return
        _recarregar()
        for k in ("soc_n_desc", "soc_n_nome", "soc_n_cnpj", "soc_n_arqs"):
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
            itens.append(f'<div class="i"><div class="t">{_e(a["titulo"])}</div>'
                         f'<div class="d">{so.data_br(a["criado_em"])} · {_e(a.get("usuario"))}</div>'
                         + (f'<div>{_e(a["texto"])}</div>' if a.get("texto") else "")
                         + "".join(f'<div class="soc-muted">{_e(x)}</div>' for x in extra) + "</div>")
        if p["etapa"] not in so.ENCERRADAS:
            prox = p.get("proxima_verificacao")
            itens.append('<div class="i pend"><div class="t">'
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
            prox = st.date_input("Próxima verificação", value=None, format="DD/MM/YYYY",
                                 help="Vira um lembrete em pop-up para o responsável, às 8h desse dia.")
            arq = st.file_uploader("Anexar comprovante (opcional)")
            if st.form_submit_button("Registrar andamento", type="primary"):
                if not (titulo.strip() or texto.strip() or etapa != p["etapa"] or protocolo.strip() or prox):
                    st.error("Escreva o que aconteceu ou mude a etapa.")
                else:
                    so.registrar_andamento(esc, p["id"], usuario, titulo, texto,
                                           etapa if etapa != p["etapa"] else None, protocolo, proxima_acao, prox)
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
                    _iniciar_revisao(esc, usuario, arq["nome"], texto, p["id"], p["tipo"], p.get("descricao") or "")
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
        hora = c2.time_input("Hora", value=datetime.strptime("08:00", "%H:%M").time())
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
            hora = c2.time_input("Hora", value=datetime.strptime("08:00", "%H:%M").time())
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


# ---------------------------------------------------------------- assistente IA

_ROT_REV = {"aguardando": "Na fila", "em_validacao": "Aguardando validação", "concluida": "Validada", "erro": "Erro"}


def _abrir_revisao(revisao_id: int) -> None:
    st.session_state["tela"] = "societario"
    st.session_state["soc_secao"] = "Assistente IA"
    st.session_state["soc_rev"] = revisao_id


def _iniciar_revisao(esc: str, usuario: str, titulo: str, texto: str, processo_id, tipo: str, contexto: str) -> None:
    chave = so.chave_claude(esc)
    if not chave:
        st.error("Falta a chave da Claude do escritório. O administrador cadastra em Admissões › Canais › IA "
                 "(API Key da Claude); a mesma chave vale para o Hub Societário.")
        return
    rid = so.criar_revisao(esc, usuario, titulo, texto, processo_id)
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
        arq = st.file_uploader("Minuta em Word (.docx), PDF ou texto", type=["docx", "pdf", "txt"], key="soc_ia_arq")
        colado = st.text_area("…ou cole o texto da minuta", height=160, key="soc_ia_txt")
        contexto = st.text_area("Contexto (opcional)", height=80, key="soc_ia_ctx",
                                value=(por_id[pid].get("descricao") or "") if pid else "",
                                placeholder="Ex.: exigência da Junta, o que a alteração deve fazer, capital correto…")
        if st.button("Revisar com IA", type="primary", icon=":material/auto_awesome:"):
            texto, titulo = colado.strip(), "Texto colado"
            if arq is not None:
                try:
                    texto, titulo = so.extrair_texto(arq.name, arq.getvalue()), arq.name
                except Exception as exc:  # noqa: BLE001
                    st.error(f"Não consegui ler o texto do arquivo: {exc}")
                    return
                if pid:
                    so.anexar(esc, pid, usuario, arq.name, arq.getvalue(), arq.type or "", "minuta")
            if not texto:
                st.error("Envie o arquivo ou cole o texto da minuta.")
                return
            _iniciar_revisao(esc, usuario, titulo, texto, pid, tipo, contexto)

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
        st.text_area("Minuta original", r["texto_original"], height=640, disabled=True, label_visibility="collapsed")
    with c2:
        st.markdown("**Análise da IA**")
        if not aps:
            st.success("A IA não encontrou problemas.")
        for a in aps:
            cor = _COR_GRAV[a["gravidade"]]
            st.markdown(
                f'<div class="soc-sug" style="border-left:4px solid {cor}">'
                f'{_chip(so.GRAVIDADES[a["gravidade"]], cor)}{_chip(so.CATEGORIAS_IA[a["categoria"]], "#94a3b8")}'
                f'<div style="font-weight:700; margin:6px 0">{_e(a["titulo"])}</div>'
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
    if st.button("Gerar versão revisada (Word)", type="primary", icon=":material/description:",
                 disabled=dec["aceito"] == 0, help="Aplica só as sugestões aceitas. O original fica guardado."):
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
        st.download_button("Baixar Word", out["docx"], file_name=out["nome"],
                           mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


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


def _adiar(esc: str, lembrete_id: int, horas: int) -> None:
    so.adiar_lembrete(esc, lembrete_id, datetime.now(so.FUSO) + timedelta(hours=horas))


def popup_lembretes(esc: str, usuario: str) -> None:
    """Abre o pop-up com os lembretes vencidos do usuário. Chamado pelo
    app_conciliacao.py nas telas do Hub. Abre quando vence um lembrete que
    ainda não apareceu nesta sessão; os já mostrados voltam depois de 30
    minutos (fechar no X ou em "Fechar" não apaga o lembrete)."""
    if not esc or not usuario:
        return
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
        _dialogo(esc, usuario)

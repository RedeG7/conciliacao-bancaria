"""Tela do Controle de Obrigações (Streamlit). Os dados e as regras ficam em
obrigacoes.py; aqui só filtros, abas, gráficos e botões. Chamada por
app_conciliacao.py: render(cabecalho_app, pode_configurar, eh_global)."""

from __future__ import annotations

import html
from datetime import date, datetime, timedelta
from typing import Callable

import streamlit as st

import auth
import obrigacoes as ob

_MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro",
          "outubro", "novembro", "dezembro"]
_CORES = {ob.CONCLUIDA_PRAZO: "#22e08a", ob.CONCLUIDA_ATRASO: "#a8e63d", ob.PENDENTE: "#f59e0b",
          ob.ATRASADA: "#ef4444", ob.DISPENSADA: "#64748b", ob.NAO_IDENTIFICADA: "#94a3b8"}
_ROT_PERIODO = ["Mês atual", "Mês anterior", "Próximo mês", "Últimos 3 meses", "Personalizado"]


def _estilo() -> None:
    st.markdown("""<style>
    .ob-kpis {display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin:4px 0 14px;}
    .ob-kpi {background:#111a2c; border:1px solid rgba(255,255,255,.07); border-radius:14px; padding:14px 16px;}
    .ob-kpi .l {color:#94a3b8; font-size:.82rem;} .ob-kpi .v {font-size:1.9rem; font-weight:800; line-height:1.15;}
    .ob-kpi .s {color:#94a3b8; font-size:.75rem;}
    /* cartão clicável: um botão invisível cobre o cartão inteiro e abre a lista filtrada */
    [class*="st-key-ob_kpi_"] {position:relative; gap:0;}
    [class*="st-key-ob_kpi_"] .ob-kpi {min-height:118px; box-sizing:border-box; transition:border-color .15s, transform .15s;}
    [class*="st-key-ob_kpi_"] .ob-kpi .ir {color:#64748b; font-size:.72rem; margin-top:6px;}
    [class*="st-key-ob_kpi_"]:hover .ob-kpi {border-color:rgba(34,224,138,.55); transform:translateY(-2px);}
    [class*="st-key-ob_kpi_"]:hover .ob-kpi .ir {color:#22e08a;}
    [class*="st-key-ob_kpi_"] .stElementContainer:has(.stButton) {position:absolute; inset:0; z-index:2; margin:0;}
    [class*="st-key-ob_kpi_"] .stButton, [class*="st-key-ob_kpi_"] .stButton button {width:100%; height:100%;
        opacity:0; cursor:pointer;}
    .ob-card {background:#111a2c; border:1px solid rgba(255,255,255,.07); border-radius:14px; padding:16px;
              height:340px; overflow-y:auto; box-sizing:border-box;}
    .ob-card h4 {margin:0 0 10px; font-size:1rem;}
    .ob-bar {margin:7px 0;} .ob-bar .t {display:flex; justify-content:space-between; font-size:.85rem;}
    .ob-bar .tr {background:rgba(255,255,255,.07); border-radius:6px; height:9px; overflow:hidden; display:flex;}
    .ob-bar .tr span {display:block; height:100%;}
    .ob-leg {display:flex; flex-direction:column; gap:6px; font-size:.86rem;}
    .ob-leg i {display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:7px;}
    .ob-al {border-radius:12px; padding:10px 14px; margin:6px 0; border:1px solid;}
    .ob-al.erro {background:rgba(239,68,68,.10); border-color:rgba(239,68,68,.35);}
    .ob-al.aviso {background:rgba(245,158,11,.10); border-color:rgba(245,158,11,.35);}
    .ob-al.info {background:rgba(59,130,246,.10); border-color:rgba(59,130,246,.35);}
    .ob-al b {margin-right:6px;} .ob-muted {color:#94a3b8; font-size:.82rem;}
    </style>""", unsafe_allow_html=True)


def _pct(v) -> str:
    return "—" if v is None else f"{v:.1f}%".replace(".", ",")


def _num(v) -> str:
    return f"{v:,}".replace(",", ".")


def _periodo(hoje: date) -> tuple[date, date, str]:
    c1, c2 = st.columns([1, 2])
    escolha = c1.selectbox("Período (vencimento)", _ROT_PERIODO, key="ob_periodo")
    ini_mes = hoje.replace(day=1)
    if escolha == "Mês atual":
        ini, fim = ini_mes, ob.somar_meses(ini_mes, 1) - timedelta(days=1)
    elif escolha == "Mês anterior":
        ini, fim = ob.somar_meses(ini_mes, -1), ini_mes - timedelta(days=1)
    elif escolha == "Próximo mês":
        ini, fim = ob.somar_meses(ini_mes, 1), ob.somar_meses(ini_mes, 2) - timedelta(days=1)
    elif escolha == "Últimos 3 meses":
        ini, fim = ob.somar_meses(ini_mes, -2), ob.somar_meses(ini_mes, 1) - timedelta(days=1)
    else:
        faixa = c2.date_input("De / até", value=(ini_mes, ob.somar_meses(ini_mes, 1) - timedelta(days=1)),
                              format="DD/MM/YYYY", key="ob_faixa")
        if isinstance(faixa, (tuple, list)) and len(faixa) == 2:
            ini, fim = faixa
        else:
            ini = fim = faixa[0] if isinstance(faixa, (tuple, list)) and faixa else ini_mes
    if ini.month == fim.month and ini.year == fim.year and ini.day == 1 and \
            fim == ob.somar_meses(ini, 1) - timedelta(days=1):
        rotulo = f"{_MESES[ini.month - 1].capitalize()} de {ini.year}"
    else:
        rotulo = f"{ob.data_br(ini)} a {ob.data_br(fim)}"
    return ini, fim, rotulo


@st.cache_data(ttl=60, show_spinner=False)
def _carregar(escritorio_id: str, ini: date, fim: date, versao: int) -> list[dict]:
    return ob.carregar(escritorio_id, ini, fim)


def _versao_dados() -> int:
    return st.session_state.get("ob_versao_dados", 0)


def _recarregar() -> None:
    st.session_state["ob_versao_dados"] = _versao_dados() + 1


def _escolher_escritorio(eh_global: bool) -> str:
    """Escritório cujos dados a tela mostra. Usuário comum e admin: sempre o
    próprio. Super admin (administra o Hub inteiro): escolhe qualquer um."""
    proprio = st.session_state.get("escritorio_id")
    if not eh_global:
        return proprio
    escritorios = auth.carregar_escritorios()
    ids = list(escritorios)
    if not ids:
        return proprio
    if st.session_state.get("ob_escritorio") not in ids:
        st.session_state["ob_escritorio"] = proprio if proprio in ids else ids[0]
    return st.selectbox("Escritório", ids, key="ob_escritorio",
                        format_func=lambda e: escritorios.get(e, {}).get("nome") or e,
                        help="Só o super administrador escolhe o escritório; os demais veem só o próprio.")


def render(cabecalho: Callable, pode_configurar: bool, eh_global: bool = False) -> None:
    _estilo()
    usuario = st.session_state.get("usuario_logado") or ""
    hoje = datetime.now(ob.FUSO).date()
    cabecalho("📊", "Controle de Obrigações",
              "Obrigações concluídas, pendentes, em atraso e enviadas ao cliente, por colaborador — fonte: Acessórias.")
    with st.expander(f"Versão {ob.VERSAO} — novidades"):
        for versao_, data_, itens in ob.NOVIDADES:
            st.markdown(f"**{versao_}** ({data_})" + "\n" + "\n".join(f"- {i}" for i in itens))
    esc = _escolher_escritorio(eh_global)
    cfg = ob.obter_config(esc)

    rodando = ob.sinc_em_andamento(esc)
    if rodando:
        _progresso_sinc(esc)

    secoes = [s for s in _SECOES if pode_configurar or s[0] != "Integração"]
    secao = st.session_state.get("ob_secao", "Dashboard")
    if secao not in [s[0] for s in secoes]:
        secao = "Dashboard"
    if not cfg["ultima_sinc_ok"] and not rodando and secao != "Integração":
        if pode_configurar:
            st.info("Ainda não há dados. Configure o token do Acessórias em **Integração** (menu lateral) e rode "
                    "a primeira carga.")
        else:
            st.info("Ainda não há dados: o administrador do escritório precisa ligar a integração com o Acessórias.")

    if secao == "Integração":
        st.markdown("### Integração")
        _aba_integracao(esc, usuario, cfg)
        return

    ini, fim, rotulo = _periodo(hoje)
    linhas_todas = _carregar(esc, ini, fim, _versao_dados())

    deptos = sorted({l.get("departamento_nome") or "Não informado" for l in linhas_todas})
    empresas = sorted({(l.get("cnpj") or l.get("empresa_id_externo") or "", l.get("empresa_nome") or "")
                       for l in linhas_todas if l.get("cnpj") or l.get("empresa_id_externo")}, key=lambda e: e[1])
    pessoas = sorted({p for l in linhas_todas for p in (l.get("resp_prazo"), l.get("resp_entrega")) if p})
    f1, f2, f3, f4, f5, f6 = st.columns([1.1, 1.6, 1.3, 1.6, 1, 1.2])
    depto = f1.selectbox("Departamento", ["Todos"] + deptos, key="ob_f_depto")
    empresa = f2.selectbox("Empresa", [""] + [e[0] for e in empresas], key="ob_f_empresa",
                           format_func=lambda c: "Todas" if not c else
                           next((f"{n} · {ob.formatar_cnpj(cc)}" for cc, n in empresas if cc == c), c))
    pessoa = f3.selectbox("Colaborador", ["Todos"] + pessoas, key="ob_f_pessoa")
    sits = f4.multiselect("Situação", list(ob.SITUACOES), format_func=ob.SITUACOES.get, key="ob_f_sit",
                          placeholder="Todas")
    tipo = f5.selectbox("Tipo", ["", "O", "T"], format_func=lambda t: {"": "Todos", "O": "Obrigações",
                                                                         "T": "Tarefas"}[t], key="ob_f_tipo")
    envio = f6.selectbox("Envio ao cliente", [""] + list(ob.ENVIOS), key="ob_f_envio",
                         format_func=lambda e: ob.ENVIOS.get(e, "Todos"))
    linhas = ob.filtrar(linhas_todas, departamento=None if depto == "Todos" else depto, empresa=empresa or None,
                        colaborador=None if pessoa == "Todos" else pessoa, situacoes=sits or None, tipo=tipo or None,
                        envios=[envio] if envio else None)
    filtros_txt = " · ".join(x for x in [rotulo, depto if depto != "Todos" else "",
                                         pessoa if pessoa != "Todos" else "",
                                         ", ".join(ob.SITUACOES[s] for s in sits),
                                         ob.ENVIOS.get(envio, "")] if x)
    ult = cfg.get("ultima_sinc_ok")
    st.markdown(f'<div class="ob-muted">Visão geral • {html.escape(rotulo)} · {_num(len(linhas))} registro(s) · '
                f'última sincronização: {ob.data_br(ult) if ult else "nunca"}</div>', unsafe_allow_html=True)

    st.markdown(f"### {secao}")
    if secao == "Dashboard":
        _aba_dashboard(linhas)
    elif secao == "Obrigações":
        _aba_lista(esc, linhas)
    elif secao == "Empresas":
        _aba_empresas(esc, linhas)
    elif secao == "Colaboradores":
        _aba_colaboradores(linhas)
    elif secao == "Envios":
        _aba_envios(linhas)
    elif secao == "Alertas":
        _aba_alertas(linhas, hoje, ult)
    elif secao == "Relatórios":
        _aba_relatorios(esc, linhas, filtros_txt)


# seções do módulo no menu lateral (abaixo do menu do Hub): (nome, ícone)
_SECOES = [
    ("Dashboard", ":material/dashboard:"),
    ("Obrigações", ":material/checklist:"),
    ("Empresas", ":material/apartment:"),
    ("Colaboradores", ":material/groups:"),
    ("Envios", ":material/send:"),
    ("Alertas", ":material/notifications:"),
    ("Relatórios", ":material/description:"),
    ("Integração", ":material/sync_alt:"),
]


def _ir_secao(nome: str) -> None:
    st.session_state["ob_secao"] = nome
    if nome == "Dashboard" and st.session_state.pop("ob_filtro_cartao", False):
        # volta ao dashboard completo: tira o filtro que o clique no cartão aplicou
        st.session_state["ob_f_sit"] = []
        st.session_state["ob_f_envio"] = ""


def menu_lateral(pode_configurar: bool) -> None:
    """Telas do módulo no menu lateral do Hub, logo abaixo de "Aplicativos"
    (chamado por _sidebar_hub, já dentro do `with st.sidebar`, só quando o
    app está aberto). Chaves nav_* = mesmo visual do menu do Hub."""
    st.markdown('<div class="hh-sep"></div><div class="hh-sec">Controle de Obrigações</div>',
                unsafe_allow_html=True)
    atual = st.session_state.get("ob_secao", "Dashboard")
    for i, (nome, icone) in enumerate(_SECOES):
        if nome == "Integração" and not pode_configurar:
            continue
        st.button(nome, key=f"nav_ob_{i}", icon=icone, use_container_width=True,
                  type="primary" if nome == atual else "secondary", on_click=_ir_secao, args=(nome,))
    st.markdown('<div class="hh-sep"></div>', unsafe_allow_html=True)


# ---------------------------------------------------------------- dashboard

def _abrir_lista(situacoes: list[str], envio: str = "") -> None:
    """Clique num cartão do dashboard: vai para Obrigações com o filtro do
    cartão aplicado nos filtros do topo (visíveis e removíveis)."""
    st.session_state["ob_f_sit"] = list(situacoes)
    st.session_state["ob_f_envio"] = envio
    st.session_state["ob_busca"] = ""
    st.session_state["ob_secao"] = "Obrigações"
    st.session_state["ob_filtro_cartao"] = True


def _kpis(ind: dict) -> None:
    sem_dispensa = [s for s in ob.SITUACOES if s != ob.DISPENSADA]
    cartoes = [
        ("Total de obrigações", _num(ind["total"]), "sem as dispensadas", "#e6edf6", sem_dispensa, ""),
        ("Concluídas", _num(ind["concluidas"]), _pct(ind["pct_concluidas"]), "#22e08a", list(ob.CONCLUIDAS), ""),
        ("Pendentes", _num(ind["pendentes"]), _pct(ind["pct_pendentes"]), "#f59e0b", [ob.PENDENTE], ""),
        ("Em atraso", _num(ind["atrasadas"]), _pct(ind["pct_atrasadas"]), "#ef4444", [ob.ATRASADA], ""),
        ("Cumprimento no prazo", _pct(ind["cumprimento"]),
         f"{_num(ind['concluidas_prazo'])} no prazo · {_num(ind['concluidas_atraso'])} com atraso", "#e6edf6",
         [ob.CONCLUIDA_PRAZO], ""),
        ("Sem confirmação de envio", _num(ind["aguardando_envio"]), "concluídas", "#60a5fa",
         list(ob.CONCLUIDAS), ob.ENVIO_AGUARDANDO),
    ]
    for inicio in (0, 3):  # duas linhas de três cartões
        for col, i in zip(st.columns(3), range(inicio, inicio + 3)):
            rot, v, sub, cor, sits, envio = cartoes[i]
            with col, st.container(key=f"ob_kpi_{i}"):
                st.markdown(f'<div class="ob-kpi"><div class="l">{rot}</div><div class="v" style="color:{cor}">{v}'
                            f'</div><div class="s">{sub}</div><div class="ir">Ver lista ›</div></div>',
                            unsafe_allow_html=True)
                st.button(f"Ver lista: {rot}", key=f"ob_kpi_btn_{i}", on_click=_abrir_lista, args=(sits, envio))
    st.write("")


def _rosca(ind: dict) -> str:
    partes = [(ob.CONCLUIDA_PRAZO, ind["concluidas_prazo"]), (ob.CONCLUIDA_ATRASO, ind["concluidas_atraso"]),
              (ob.PENDENTE, ind["pendentes"]), (ob.ATRASADA, ind["atrasadas"]),
              (ob.NAO_IDENTIFICADA, ind["nao_identificadas"])]
    total = sum(v for _, v in partes)
    r, c = 54, 2 * 3.14159 * 54
    arcos, desloc = [], 0.0
    for chave, v in partes:
        if not v or not total:
            continue
        tam = c * v / total
        arcos.append(f'<circle r="{r}" cx="70" cy="70" fill="none" stroke="{_CORES[chave]}" stroke-width="18" '
                     f'stroke-dasharray="{tam:.2f} {c - tam:.2f}" stroke-dashoffset="{-desloc:.2f}" '
                     'transform="rotate(-90 70 70)"/>')
        desloc += tam
    centro = _pct(ind["pct_concluidas"])
    svg = (f'<svg viewBox="0 0 140 140" width="150" height="150"><circle r="{r}" cx="70" cy="70" fill="none" '
           f'stroke="rgba(255,255,255,.08)" stroke-width="18"/>{"".join(arcos)}'
           f'<text x="70" y="68" text-anchor="middle" fill="#e6edf6" font-size="20" font-weight="800">{centro}</text>'
           '<text x="70" y="86" text-anchor="middle" fill="#94a3b8" font-size="10">concluídas</text></svg>')
    leg = "".join(f'<div><i style="background:{_CORES[k]}"></i>{ob.SITUACOES[k]} — {_num(v)} '
                  f'({_pct(round(100 * v / total, 1) if total else None)})</div>' for k, v in partes if v)
    return (f'<div style="display:flex; gap:18px; align-items:center; flex-wrap:wrap">{svg}'
            f'<div class="ob-leg">{leg or "Sem registros no período"}</div></div>')


def _barras(itens: list[tuple[str, int, int, int]], vazio: str) -> str:
    """itens = (rótulo, no prazo, com atraso, em aberto)."""
    if not itens:
        return f'<div class="ob-muted">{vazio}</div>'
    maior = max(a + b + c for _, a, b, c in itens) or 1
    saida = []
    for rot, a, b, c in itens:
        saida.append(
            f'<div class="ob-bar"><div class="t"><span>{html.escape(rot)}</span><span>{_num(a + b)} concluídas'
            f'{f" · {_num(c)} em aberto" if c else ""}</span></div><div class="tr">'
            f'<span style="width:{100 * a / maior:.1f}%; background:#22e08a"></span>'
            f'<span style="width:{100 * b / maior:.1f}%; background:#a8e63d"></span>'
            f'<span style="width:{100 * c / maior:.1f}%; background:#f59e0b55"></span></div></div>')
    return "".join(saida)


def _aba_dashboard(linhas: list[dict]) -> None:
    ind = ob.indicadores(linhas)
    _kpis(ind)
    c1, c2 = st.columns(2)
    with c1:
        st.markdown(f'<div class="ob-card"><h4>Situação das obrigações</h4>{_rosca(ind)}</div>',
                    unsafe_allow_html=True)
    with c2:
        top = [(g["colaborador"], g["no_prazo"], g["com_atraso"], g["pendentes"] + g["atrasadas"])
               for g in ob.por_colaborador(linhas)[:8]]
        st.markdown(f'<div class="ob-card"><h4>Produtividade por colaborador</h4>'
                    f'{_barras(top, "Sem responsáveis no período")}</div>', unsafe_allow_html=True)
    st.write("")
    c3, c4 = st.columns(2)
    with c3:
        dep = [(g["grupo"], g["concluidas_prazo"], g["concluidas_atraso"], g["pendentes"] + g["atrasadas"])
               for g in ob.por_chave(linhas, "departamento_nome")[:8]]
        st.markdown(f'<div class="ob-card"><h4>Por departamento</h4>{_barras(dep, "Sem registros")}</div>',
                    unsafe_allow_html=True)
    with c4:
        env = ind["envios"]
        concl = ind["concluidas"] or 0
        linhas_env = "".join(
            f'<div class="ob-bar"><div class="t"><span>{ob.ENVIOS[k]}</span><span>{_num(env[k])}</span></div>'
            f'<div class="tr"><span style="width:{100 * env[k] / concl if concl else 0:.1f}%; background:{cor}">'
            '</span></div></div>'
            for k, cor in [(ob.ENVIO_LIDA, "#22e08a"), (ob.ENVIO_REGISTRADO, "#60a5fa"),
                           (ob.ENVIO_AGUARDANDO, "#f59e0b")])
        st.markdown('<div class="ob-card"><h4>Envio ao cliente (das concluídas)</h4>' + linhas_env +
                    '<div class="ob-muted" style="margin-top:8px">Conta só o que o Acessórias registrou '
                    '(leitura da guia ou comentário de envio). Transmissão ao órgão: indisponível na API.</div></div>',
                    unsafe_allow_html=True)
    comp = ob.por_chave(linhas, "competencia", "Sem competência")
    if len(comp) > 1:
        st.write("")
        st.markdown("**Por competência**")
        st.dataframe([{"Competência": g["grupo"], "Total": g["total"], "Concluídas": g["concluidas"],
                       "Pendentes": g["pendentes"], "Em atraso": g["atrasadas"],
                       "Cumprimento": _pct(g["cumprimento"])} for g in sorted(comp, key=lambda g: g["grupo"])],
                     hide_index=True, use_container_width=True)


# ---------------------------------------------------------------- listas

def _tabela(linhas: list[dict], chave: str, colunas: list[str] | None = None, altura: int = 460):
    dados = [ob.linha_relatorio(l) for l in linhas]
    for d in dados:  # na tela, vazio em vez de "None" (no Excel continua número)
        d["Dias de atraso"] = str(d["Dias de atraso"]) if d["Dias de atraso"] else ""
    if colunas:
        dados = [{c: d[c] for c in colunas} for d in dados]
    return st.dataframe(dados, hide_index=True, use_container_width=True, height=altura, key=chave,
                        on_select="rerun", selection_mode="single-row")


def _selecionada(evento, linhas: list[dict]):
    try:
        i = evento.selection.rows[0]
    except (AttributeError, IndexError, TypeError):
        return None
    return linhas[i] if 0 <= i < len(linhas) else None


_COLS_LISTA = ["Empresa", "Obrigação", "Departamento", "Competência", "Prazo", "Entrega", "Situação",
               "Dias de atraso", "Responsável (prazo)", "Entregue por", "Envio ao cliente"]


def _aba_lista(esc: str, linhas: list[dict]) -> None:
    busca = st.text_input("Buscar", key="ob_busca", placeholder="🔍  Empresa, obrigação, CNPJ ou responsável")
    vis = ob.filtrar(linhas, busca=busca or "")
    st.caption(f"Obrigações encontradas: {_num(len(vis))} registro(s). Clique numa linha para ver o histórico.")
    if not vis:
        return
    ev = _tabela(vis, "ob_tab_lista", _COLS_LISTA)
    sel = _selecionada(ev, vis)
    if sel:
        _detalhe(esc, sel["id"])


def _detalhe(esc: str, entrega_id: int) -> None:
    d = ob.detalhe(esc, entrega_id)
    if not d:
        return
    with st.container(border=True):
        st.markdown(f"#### {html.escape(d['nome'])} — {html.escape(d.get('empresa_nome') or '')}")
        c1, c2, c3 = st.columns(3)
        c1.markdown(f"**1. Execução**  \n{ob.SITUACOES[d['situacao']]}"
                    + (f" em {ob.data_br(d['dt_entrega'])}" if d.get("dt_entrega") else "")
                    + f"  \nPrazo: {ob.data_br(d.get('prazo')) or 'não informado'}"
                    + f"  \nResponsável: {d.get('resp_prazo') or 'não informado'}"
                    + f"  \nEntregue por: {d.get('resp_entrega') or ('não informado' if d.get('dt_entrega') else '—')}")
        c2.markdown("**2. Transmissão ao órgão**  \nIndisponível: a API do Acessórias não informa.")
        c3.markdown(f"**3. Envio ao cliente**  \n{ob.ENVIOS[d['envio']]}"
                    + (f"  \nEm {ob.data_br(d['envio_data'])}" if d.get("envio_data") else "")
                    + (f" por {d['envio_por']}" if d.get("envio_por") else "")
                    + (f"  \n{d['guia_lida']}" if d.get("guia_lida") else ""))
        st.caption(f"Status no Acessórias: {d.get('status_origem') or '—'} · Competência: "
                   f"{d.get('competencia') or '—'} · Departamento: {d.get('departamento_nome') or '—'} · "
                   f"CNPJ: {ob.formatar_cnpj(d.get('cnpj'))} · Multa: "
                   f"{'sim' if d.get('multa') else 'não' if d.get('multa') is False else '—'}")
        if d["eventos"]:
            st.markdown("**Histórico (comentários do Acessórias)**")
            st.dataframe([{"Data": ob.data_br(e["data"]), "Tipo": ob.EVENTOS.get(e["tipo"], e["tipo"]),
                           "Quem": e.get("autor") or "", "Texto": e.get("texto") or ""} for e in d["eventos"]],
                         hide_index=True, use_container_width=True)
        else:
            st.caption("Sem comentários registrados no Acessórias.")
        if d["alteracoes"]:
            with st.expander(f"Alterações vistas pelo Hub ({len(d['alteracoes'])})"):
                st.dataframe([{"Quando": ob.data_br(a["criado_em"]), "Campo": a["campo"], "Antes": a["antes"] or "",
                               "Depois": a["depois"] or ""} for a in d["alteracoes"]],
                             hide_index=True, use_container_width=True)


def _aba_empresas(esc: str, linhas: list[dict]) -> None:
    grupos: dict[str, list] = {}
    for l in linhas:
        grupos.setdefault(l.get("cnpj") or l.get("empresa_id_externo") or "?", []).append(l)
    dados = []
    for cnpj, ls in grupos.items():
        ind = ob.indicadores(ls)
        dados.append({"cnpj": cnpj, "Empresa": ls[0].get("empresa_nome") or "", "CNPJ": ob.formatar_cnpj(cnpj),
                      "Total": ind["total"], "Concluídas": ind["concluidas"], "Pendentes": ind["pendentes"],
                      "Em atraso": ind["atrasadas"], "Cumprimento": _pct(ind["cumprimento"]),
                      "Sem confirmação de envio": ind["aguardando_envio"]})
    dados.sort(key=lambda d: (-d["Em atraso"], -d["Pendentes"], d["Empresa"]))
    st.caption(f"{_num(len(dados))} empresa(s) com obrigações no período. Clique numa empresa para ver o "
               "histórico completo dela.")
    if not dados:
        return
    ev = st.dataframe([{k: v for k, v in d.items() if k != "cnpj"} for d in dados], hide_index=True,
                      use_container_width=True, height=380, key="ob_tab_emp", on_select="rerun",
                      selection_mode="single-row")
    sel = _selecionada(ev, dados)
    if sel and sel["cnpj"] != "?":
        hist = ob.historico_empresa(esc, sel["cnpj"])
        st.markdown(f"#### Histórico de {html.escape(sel['Empresa'])} ({sel['CNPJ']}) — todas as competências")
        ind = ob.indicadores(hist)
        st.caption(f"{_num(ind['total'])} obrigações · {_num(ind['concluidas'])} concluídas · "
                   f"{_num(ind['atrasadas'])} em atraso · cumprimento {_pct(ind['cumprimento'])}")
        ev2 = _tabela(hist, "ob_tab_emp_hist", ["Obrigação", "Competência", "Prazo", "Entrega", "Situação",
                                                "Responsável (prazo)", "Entregue por", "Envio ao cliente"], 360)
        s2 = _selecionada(ev2, hist)
        if s2:
            _detalhe(esc, s2["id"])


def _aba_colaboradores(linhas: list[dict]) -> None:
    grupos = ob.por_colaborador(linhas)
    st.caption("Atribuídas = responsável pelo prazo no Acessórias. Entregas feitas = quem concluiu a entrega "
               "(pode ser outra pessoa). Tempo de execução: indisponível (a API não informa o início).")
    if not grupos:
        st.info("Sem registros no período.")
        return
    dados = [{"Colaborador": g["colaborador"], "Atribuídas": g["atribuidas"], "Concluídas": g["concluidas"],
              "No prazo": g["no_prazo"], "Com atraso": g["com_atraso"], "Em atraso": g["atrasadas"],
              "Pendentes": g["pendentes"], "Entregas feitas": g["entregas_feitas"], "Envios": g["envios"],
              "Cumprimento": _pct(g["taxa"])} for g in grupos]
    ev = st.dataframe(dados, hide_index=True, use_container_width=True, height=360, key="ob_tab_col",
                      on_select="rerun", selection_mode="single-row")
    sel = _selecionada(ev, dados)
    if sel:
        nome = sel["Colaborador"]
        meus = [l for l in linhas if (l.get("resp_prazo") or "Sem responsável") == nome or l.get("resp_entrega") == nome]
        abertos = [l for l in meus if l["situacao"] in (ob.ATRASADA, ob.PENDENTE)]
        st.markdown(f"#### {html.escape(nome)}")
        st.caption(f"{_num(len({l.get('cnpj') for l in meus}))} empresa(s) · {_num(len(meus))} obrigação(ões) · "
                   f"{_num(len(abertos))} pendência(s)")
        so_abertas = st.toggle("Só pendências", value=True, key="ob_col_abertas")
        mostrar = sorted(abertos if so_abertas else meus,
                         key=lambda l: (l["situacao"] != ob.ATRASADA, l.get("prazo") or date.max))
        _tabela(mostrar, "ob_tab_col_det", ["Empresa", "Obrigação", "Prazo", "Entrega", "Situação",
                                             "Dias de atraso", "Envio ao cliente"], 320)


def _aba_envios(linhas: list[dict]) -> None:
    concl = [l for l in linhas if l["situacao"] in ob.CONCLUIDAS]
    op = st.segmented_control("Mostrar", list(ob.ENVIOS)[:3], format_func=ob.ENVIOS.get, key="ob_envio_f",
                              selection_mode="multi", default=list(ob.ENVIOS)[:3])
    vis = [l for l in concl if l["envio"] in (op or [])]
    st.caption(f"{_num(len(vis))} de {_num(len(concl))} concluída(s). \"Lida pelo cliente\" vem do Acessórias "
               "(guia acessada/lida); \"Envio registrado\", de um comentário que fala em envio. Sem nenhum dos "
               "dois, fica \"Sem confirmação\" — o Hub não presume o envio.")
    if vis:
        _tabela(vis, "ob_tab_env", ["Empresa", "Obrigação", "Competência", "Entrega", "Entregue por",
                                    "Envio ao cliente", "Data do envio/leitura", "Enviado por"])


def _aba_alertas(linhas: list[dict], hoje: date, ult) -> None:
    dias = st.slider("Avisar vencimentos nos próximos (dias)", 1, 30, 5, key="ob_alerta_dias")
    for a in ob.alertas(linhas, hoje, dias, ult):
        qtd = f" — {_num(a['qtd'])}" if a.get("qtd") is not None else ""
        st.markdown(f'<div class="ob-al {a["nivel"]}"><b>{html.escape(a["titulo"])}{qtd}</b>'
                    f'{html.escape(a["texto"])}</div>', unsafe_allow_html=True)
    vencendo = sorted([l for l in linhas if l["situacao"] in (ob.ATRASADA, ob.PENDENTE) and l.get("prazo")
                       and (l["prazo"] - hoje).days <= dias], key=lambda l: l["prazo"])
    if vencendo:
        st.markdown("**Em atraso e vencendo**")
        _tabela(vencendo, "ob_tab_alerta", ["Empresa", "Obrigação", "Prazo", "Situação", "Dias de atraso",
                                            "Responsável (prazo)"], 380)


def _aba_relatorios(esc: str, linhas: list[dict], filtros_txt: str) -> None:
    st.caption(f"Os relatórios saem com os filtros escolhidos acima ({filtros_txt}).")
    nome_base = f"obrigacoes_{datetime.now(ob.FUSO).strftime('%Y%m%d_%H%M')}"
    c1, c2 = st.columns(2)
    c1.download_button("Baixar Excel", ob.gerar_excel(linhas, "Controle de Obrigações", filtros_txt),
                       file_name=f"{nome_base}.xlsx", icon=":material/table_view:", use_container_width=True,
                       mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", key="ob_xlsx")
    # o PDF gerado vale só para o escritório e os filtros com que foi gerado
    chave = (esc, filtros_txt, len(linhas))
    if c2.button("Gerar PDF", icon=":material/picture_as_pdf:", use_container_width=True, key="ob_pdf_gerar"):
        nome_esc = auth.carregar_escritorios().get(esc, {}).get("nome") or st.session_state.get("escritorio_nome") or ""
        st.session_state["ob_pdf"] = (chave, ob.gerar_pdf(linhas, "Controle de Obrigações", nome_esc, filtros_txt))
    pdf = st.session_state.get("ob_pdf")
    if pdf and pdf[0] == chave:
        c2.download_button("Baixar PDF", pdf[1], file_name=f"{nome_base}.pdf",
                           mime="application/pdf", type="primary", use_container_width=True, key="ob_pdf_baixar")


# ---------------------------------------------------------------- integração

@st.fragment(run_every=5)
def _progresso_sinc(esc: str) -> None:
    r = ob.sinc_em_andamento(esc)
    if r:
        st.info(f"🔄 Sincronizando com o Acessórias ({r['tipo']}) — {r.get('progresso') or 'em andamento'}. "
                "Pode sair da tela: a rodada continua no servidor.")
        st.session_state["ob_viu_rodando"] = True
    elif st.session_state.pop("ob_viu_rodando", False):
        _recarregar()
        st.rerun()


def _aba_integracao(esc: str, usuario: str, cfg: dict) -> None:
    st.markdown("**Acessórias** · `https://api.acessorias.com` · limite de 100 requisições por minuto")
    if cfg["token_salvo"]:
        st.caption("✔ Token salvo (cifrado; não volta para a tela).")
    elif cfg["token_admissoes"]:
        st.caption("✔ Usando o token do Acessórias já salvo na integração das Admissões. Salve um aqui se "
                   "quiser um usuário só para esta integração.")
    with st.form("ob_form_cfg"):
        ativo = st.toggle("Integração ativa (sincroniza sozinha a cada 5 minutos)", value=bool(cfg["ativo"]))
        tok = st.text_input("API Token", type="password", placeholder="deixe em branco para manter o salvo",
                            help="No Acessórias: engrenagem (canto superior direito) › API Token.")
        c1, c2 = st.columns(2)
        atras = c1.number_input("Buscar vencimentos de quantos meses atrás", 0, 24, int(cfg["meses_atras"]))
        frente = c2.number_input("E de quantos meses à frente", 0, 12, int(cfg["meses_frente"]))
        apagar = st.checkbox("Apagar o token salvo aqui", value=False) if cfg["token_salvo"] else False
        if st.form_submit_button("Salvar", type="primary"):
            ob.salvar_config(esc, usuario, ativo, tok, atras, frente, apagar)
            st.success("Configuração salva.")
            st.rerun()

    c1, c2, c3 = st.columns(3)
    if c1.button("Testar conexão", icon=":material/lan:", use_container_width=True, key="ob_testar"):
        try:
            r = ob.testar_conexao(esc)
            st.success(f"Conectado. Departamentos: {', '.join(r['departamentos']) or 'nenhum'}.")
        except ob.ErroIntegracao as e:
            st.error(str(e))
    rodando = bool(ob.sinc_em_andamento(esc))
    if c2.button("Sincronizar agora", icon=":material/sync:", use_container_width=True, key="ob_sinc",
                 disabled=rodando, help="Só o que mudou desde ontem (ou carga completa, se for a primeira vez)."):
        ob.sincronizar_em_segundo_plano(esc, usuario)
        st.rerun()
    if c3.button("Carga completa", icon=":material/cloud_download:", use_container_width=True, key="ob_carga",
                 disabled=rodando, help="Consulta empresa por empresa dentro da janela de meses. Com muitas "
                                        "empresas leva alguns minutos (limite de 100 requisições/min)."):
        ob.sincronizar_em_segundo_plano(esc, usuario, ob.SINC_COMPLETA)
        st.rerun()

    hist = ob.listar_sincronizacoes(esc)
    if hist:
        st.markdown("**Histórico de sincronizações**")
        st.dataframe([{"Início": ob.data_br(h["iniciado_em"]), "Fim": ob.data_br(h["concluido_em"]),
                       "Tipo": h["tipo"], "Situação": h["status"], "Por": h.get("por") or "",
                       "Janela": f"{ob.data_br(h['janela_ini'])} a {ob.data_br(h['janela_fim'])}",
                       "Resultado": h.get("mensagem") or h.get("progresso") or ""} for h in hist],
                     hide_index=True, use_container_width=True)
    st.caption("O que a API do Acessórias traz e o Hub usa: empresas (CNPJ), departamentos, usuários e entregas "
               "com prazo, data de entrega, status, responsável pelo prazo e pela entrega e comentários. "
               "Não traz: transmissão ao órgão e início da execução — essas colunas aparecem como indisponíveis.")

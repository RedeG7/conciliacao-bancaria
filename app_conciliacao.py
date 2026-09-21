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

import os
import tempfile
from pathlib import Path
from typing import Optional

import streamlit as st

import auth
import clientes
import historico
import conciliacao_bancaria as cb
from rpa import core as rpa_core
from rpa import registry as rpa_registry

st.set_page_config(page_title="Hub App", page_icon="🧩", layout="wide")

# Usuarios/escritorios/clientes/historico ficam no Postgres (DATABASE_URL) -
# ver auth.py. Isso evita corrida de escrita entre admins de escritorios
# diferentes mexendo ao mesmo tempo (cada operacao e uma transacao atomica
# no banco).

if "DATABASE_URL" not in os.environ:
    # roda esse arquivo direto (sem docker compose) sem apontar pra um
    # Postgres - o mais comum e alguem tentando ACESSAR o sistema em vez de
    # rodar em modo desenvolvedor: o site de producao ja fica no ar em
    # https://hub.redeg7.com, nao precisa (nem deveria) rodar isso localmente
    # pra usar o sistema.
    st.error(
        "⚠️ **Este app não está configurado com um banco de dados** "
        "(variável de ambiente `DATABASE_URL` não definida)."
    )
    st.info(
        "**Se você quer só usar o sistema:** acesse "
        "[hub.redeg7.com](https://hub.redeg7.com) — não precisa rodar nada "
        "no seu computador.\n\n"
        "**Se você é desenvolvedor e quer testar localmente:** defina a "
        "variável `DATABASE_URL` apontando pra um Postgres (local ou via "
        "túnel) antes de rodar `streamlit run app_conciliacao.py`, ex.:\n\n"
        "```\nDATABASE_URL=postgresql://usuario:senha@localhost:5432/conciliacao "
        "streamlit run app_conciliacao.py\n```"
    )
    st.stop()


@st.cache_resource
def _garantir_schema_extra() -> bool:
    # auth primeiro: clientes/historico tem FK pra escritorios(id).
    auth.garantir_schema()
    clientes.garantir_schema()
    historico.garantir_schema()
    rpa_core.garantir_schema()
    return True


try:
    _garantir_schema_extra()
except Exception as exc:
    st.error(
        f"⚠️ **Não consegui conectar ao banco de dados configurado.** "
        f"Confira se o Postgres em `DATABASE_URL` está no ar e acessível.\n\n"
        f"Detalhe técnico: `{exc}`"
    )
    st.stop()

# ---------------------------------------------------------------------------
# Login / autenticacao multi-escritorio - nada do app roda sem sessao
# autenticada. Varios escritorios de contabilidade usam o mesmo app ao
# mesmo tempo, cada um enxergando so os proprios usuarios (isolamento por
# escritorio_id). Ha sempre um super_admin_global (bootstrap "admin"/
# "admin123" no primeiro uso, escritorio "redeg7") que enxerga todos os
# escritorios; cada escritorio tambem tem seu proprio admin_escritorio,
# capaz de redefinir a senha de quem esqueceu sem depender do global.
# ---------------------------------------------------------------------------

_CHAVES_SESSAO_LOGIN = (
    "usuario_logado", "papel_usuario", "nome_usuario", "escritorio_id",
    "escritorio_nome", "deve_trocar_senha", "mostrar_trocar_senha",
)


_COOKIE_SESSAO = "sessao_token"


def _https_ativo() -> bool:
    try:
        return str(st.context.url or "").startswith("https://")
    except Exception:
        return False


def _definir_cookie_sessao(token: str, dias: int) -> None:
    """Grava o token de sessao persistente no cookie do navegador (via um
    scriptzinho injetado - o Streamlit nao expoe um jeito nativo de setar
    cookie a partir do Python). Nao e HttpOnly (o Streamlit nao da controle
    sobre os headers HTTP de resposta pra isso) - fica no mesmo nivel de
    protecao de localStorage, aceitavel aqui porque o app nao renderiza
    HTML/JS vindo de outro usuario (sem superficie de XSS entre tenants)."""
    seguro = "; Secure" if _https_ativo() else ""
    st.components.v1.html(
        f"<script>document.cookie = "
        f"'{_COOKIE_SESSAO}={token}; path=/; max-age={dias * 86400}; SameSite=Lax{seguro}';</script>",
        height=0,
    )


def _limpar_cookie_sessao() -> None:
    st.components.v1.html(
        f"<script>document.cookie = '{_COOKIE_SESSAO}=; path=/; max-age=0; SameSite=Lax';</script>",
        height=0,
    )


def _agendar_cookie_sessao(acao: str, valor: str = "") -> None:
    """`st.rerun()` interrompe a execucao do script na hora - se o
    componente que grava/apaga o cookie fosse renderizado bem antes de um
    rerun(), o navegador nunca chegaria a rodar aquele JS (a tela e trocada
    antes). Por isso o pedido de gravar/apagar cookie fica "agendado" no
    session_state e so e efetivamente renderizado no INICIO do proximo
    script run (via `_renderizar_cookie_pendente`), depois que o rerun ja
    aconteceu - mesmo motivo/padrao do `_flash()` pra mensagens de sucesso."""
    st.session_state["_cookie_pendente"] = (acao, valor)


def _renderizar_cookie_pendente() -> None:
    pendente = st.session_state.pop("_cookie_pendente", None)
    if not pendente:
        return
    acao, valor = pendente
    if acao == "set":
        _definir_cookie_sessao(valor, auth.DURACAO_SESSAO_DIAS)
    elif acao == "clear":
        _limpar_cookie_sessao()


def _popular_sessao(dados: dict, token: Optional[str] = None) -> None:
    escritorios = auth.carregar_escritorios()
    eid = dados.get("escritorio_id", "")
    st.session_state["usuario_logado"] = dados["usuario"]
    st.session_state["papel_usuario"] = dados.get("papel", auth.PAPEL_USUARIO)
    st.session_state["nome_usuario"] = dados.get("nome", dados["usuario"])
    st.session_state["escritorio_id"] = eid
    st.session_state["escritorio_nome"] = escritorios.get(eid, {}).get("nome", eid)
    st.session_state["deve_trocar_senha"] = bool(dados.get("deve_trocar_senha"))
    if token:
        st.session_state[_COOKIE_SESSAO] = token


def _fazer_logout() -> None:
    auth.remover_sessao(st.session_state.get(_COOKIE_SESSAO, ""))
    for chave in _CHAVES_SESSAO_LOGIN:
        st.session_state.pop(chave, None)
    st.session_state.pop(_COOKIE_SESSAO, None)
    _agendar_cookie_sessao("clear")
    st.rerun()


def _tela_login() -> None:
    st.markdown(
        "<div style='display:flex;justify-content:center;align-items:center;"
        "text-align:center;font-size:2.25rem;font-weight:700;line-height:1.2;"
        "margin-bottom:0.5rem;'>🧩 Hub App</div>"
        "<div style='display:flex;justify-content:center;align-items:center;"
        "text-align:center;color:rgba(250,250,250,0.6);margin-bottom:1rem;'>"
        "Faça login para continuar — cada escritório vê só os próprios dados.</div>",
        unsafe_allow_html=True,
    )
    _esq, meio, _dir = st.columns([1, 1.3, 1])
    with meio:
        with st.form("login_form"):
            usuario = st.text_input("Usuário")
            senha = st.text_input("Senha", type="password")
            entrar = st.form_submit_button("Entrar", type="primary", use_container_width=True)
        if entrar:
            auth.garantir_bootstrap()
            usuario = usuario.strip()
            dados = auth.autenticar(usuario, senha)
            if not dados:
                st.error("Usuário ou senha inválidos.")
            elif not auth.usuario_esta_ativo(dados):
                st.error("Este usuário está inativo. Fale com o administrador do seu escritório.")
            else:
                token = auth.criar_sessao(usuario)
                _popular_sessao(dados, token=token)
                _agendar_cookie_sessao("set", token)
                st.rerun()


def _tela_trocar_senha(obrigatoria: bool) -> None:
    st.title("🔑 Trocar senha")
    if obrigatoria:
        st.warning("Por segurança, defina uma nova senha antes de continuar "
                    "(esta conta ainda está com a senha padrão/temporária).")
    with st.form("trocar_senha_form"):
        senha_atual = st.text_input("Senha atual", type="password")
        nova = st.text_input("Nova senha (mín. 6 caracteres)", type="password")
        confirmar = st.text_input("Confirmar nova senha", type="password")
        enviar = st.form_submit_button("Salvar nova senha", type="primary")
    if enviar:
        usuario = st.session_state["usuario_logado"]
        if not auth.autenticar(usuario, senha_atual):
            st.error("Senha atual incorreta.")
        elif len(nova) < 6:
            st.error("A nova senha precisa ter pelo menos 6 caracteres.")
        elif nova != confirmar:
            st.error("As senhas digitadas não coincidem.")
        else:
            auth.redefinir_senha(usuario, nova, forcar_troca=False)
            st.session_state["deve_trocar_senha"] = False
            st.session_state["mostrar_trocar_senha"] = False
            st.success("Senha atualizada.")
            st.rerun()
    if not obrigatoria and st.button("Cancelar"):
        st.session_state["mostrar_trocar_senha"] = False
        st.rerun()


def _flash(chave: str, texto: Optional[str] = None) -> None:
    """Guarda uma mensagem de sucesso para sobreviver a um st.rerun()
    (sem isso, a mensagem e substituida pela proxima renderizacao antes do
    usuario conseguir ve-la). Chame com `texto` para guardar, e sem `texto`
    no topo do bloco seguinte para exibir e limpar a mensagem pendente."""
    if texto is not None:
        st.session_state[chave] = texto
        return
    msg = st.session_state.pop(chave, None)
    if msg:
        st.success(msg)


def _tela_gerenciar_escritorios() -> None:
    """Tela dedicada (só super_admin_global) para gerenciar os escritórios
    cadastrados: criar, renomear, ver quantos usuários cada um tem, e
    excluir. Fica separada do painel de usuários porque mexe no tenant em
    si, não em quem tem acesso a ele."""
    st.title("🌐 Gerenciar Escritórios")
    if st.button("← Início"):
        st.session_state["tela"] = "home"
        st.rerun()
    st.caption("Cada escritório é isolado: usuários de um não enxergam nem gerenciam os de outro.")
    st.divider()

    escritorios = auth.carregar_escritorios()
    usuarios = auth.carregar_usuarios()

    st.subheader("Criar novo escritório")
    _flash("flash_novo_escritorio")
    with st.form("novo_escritorio_form", clear_on_submit=True):
        nome_escritorio = st.text_input("Nome do escritório")
        st.caption("Primeiro usuário desse escritório (será admin_escritorio dele):")
        adm_usuario = st.text_input("Usuário do admin do escritório")
        adm_nome = st.text_input("Nome completo do admin (opcional)")
        adm_senha = st.text_input("Senha inicial (mín. 6 caracteres)", type="password")
        criar = st.form_submit_button("Criar escritório", type="primary")
    if criar:
        if not nome_escritorio.strip() or not adm_usuario.strip():
            st.error("Informe o nome do escritório e o usuário do admin.")
        elif len(adm_senha) < 6:
            st.error("A senha precisa ter pelo menos 6 caracteres.")
        elif adm_usuario.strip() in usuarios:
            st.error("Esse nome de usuário já existe — escolha outro.")
        else:
            novo_eid = auth.criar_escritorio(nome_escritorio.strip())
            auth.criar_ou_atualizar_usuario(
                adm_usuario.strip(), adm_senha, escritorio_id=novo_eid,
                papel=auth.PAPEL_ADMIN_ESCRITORIO, nome=adm_nome.strip(), deve_trocar_senha=True,
            )
            _flash("flash_novo_escritorio",
                   f"✅ Escritório '{nome_escritorio.strip()}' criado com sucesso (id: {novo_eid}), "
                   f"com admin '{adm_usuario.strip()}'.")
            st.rerun()

    st.divider()
    st.subheader(f"Escritórios cadastrados ({len(escritorios)})")
    _flash("flash_escritorio_renomeado")
    _flash("flash_escritorio_removido")

    if not escritorios:
        st.info("Nenhum escritório cadastrado ainda.")
        return

    for eid, edados in sorted(escritorios.items(), key=lambda kv: kv[1].get("nome", kv[0]).lower()):
        usuarios_do = auth.usuarios_do_escritorio(usuarios, eid)
        # mantem o expander aberto entre reruns enquanto os checkboxes de
        # exclusao estiverem marcados - sem isso, cada clique dentro dele
        # fecha o painel de novo (expander sem `expanded` volta a False a
        # cada rerun) e o usuario precisa reabrir a cada passo.
        aberto = bool(
            st.session_state.get(f"forcar_excluir_{eid}") or st.session_state.get(f"confirmar_excluir_{eid}")
        )
        with st.expander(f"🏢 {edados.get('nome', eid)}  ·  {len(usuarios_do)} usuário(s)", expanded=aberto):
            st.caption(f"id: `{eid}` · criado em {edados.get('criado_em', '—')}")

            with st.form(f"renomear_{eid}_form"):
                novo_nome = st.text_input("Nome", value=edados.get("nome", eid), key=f"nome_input_{eid}")
                salvar_nome = st.form_submit_button("Salvar nome")
            if salvar_nome:
                if not novo_nome.strip():
                    st.error("O nome não pode ficar em branco.")
                else:
                    auth.renomear_escritorio(eid, novo_nome.strip())
                    if st.session_state.get("escritorio_id") == eid:
                        st.session_state["escritorio_nome"] = novo_nome.strip()
                    _flash("flash_escritorio_renomeado", f"✅ Escritório renomeado para '{novo_nome.strip()}'.")
                    st.rerun()

            st.markdown("**Usuários deste escritório**")
            if usuarios_do:
                for uname, udados in usuarios_do.items():
                    st.write(f"- **{uname}** — {udados.get('nome', uname)} · {udados.get('papel')}")
            else:
                st.caption("Nenhum usuário cadastrado neste escritório.")

            st.markdown("**Excluir escritório**")
            forcar = False
            if usuarios_do:
                st.warning(f"Este escritório tem {len(usuarios_do)} usuário(s) cadastrado(s).")
                forcar = st.checkbox(
                    "Excluir também todos os usuários deste escritório", key=f"forcar_excluir_{eid}"
                )
            confirmar = st.checkbox(f"Confirmo que quero excluir \"{edados.get('nome', eid)}\"", key=f"confirmar_excluir_{eid}")
            if st.button("Excluir escritório", key=f"btn_excluir_{eid}", disabled=not confirmar):
                ok, msg = auth.remover_escritorio(eid, forcar=forcar)
                if ok:
                    _flash("flash_escritorio_removido", f"✅ {msg}")
                    st.rerun()
                else:
                    st.error(msg)


def _tela_gerenciar_usuarios() -> None:
    """Tela dedicada para gerenciar os usuários cadastrados: cadastrar,
    inativar/ativar (bloqueia o login sem apagar o cadastro) e remover
    definitivamente. super_admin_global enxerga e gerencia usuários de
    TODOS os escritórios (escolhendo qual ver); admin_escritorio só
    enxerga/gerencia o próprio (isolamento entre escritórios-cliente)."""
    st.title("👥 Gerenciar Usuários")
    if st.button("← Início"):
        st.session_state["tela"] = "home"
        st.rerun()
    st.divider()

    eh_global = st.session_state.get("papel_usuario") == auth.PAPEL_SUPER_GLOBAL
    usuarios_todos = auth.carregar_usuarios()
    escritorios = auth.carregar_escritorios()

    if eh_global:
        if not escritorios:
            st.info("Nenhum escritório cadastrado ainda — crie um em "
                     "\"🌐 Gerenciar Escritórios\" antes de cadastrar usuários.")
            return
        escritorio_visto = st.selectbox(
            "Escritório",
            list(escritorios.keys()),
            format_func=lambda eid: escritorios.get(eid, {}).get("nome", eid),
            index=list(escritorios.keys()).index(st.session_state.get("escritorio_id"))
            if st.session_state.get("escritorio_id") in escritorios else 0,
        )
        papeis_disponiveis = [auth.PAPEL_USUARIO, auth.PAPEL_ADMIN_ESCRITORIO, auth.PAPEL_SUPER_GLOBAL]
    else:
        escritorio_visto = st.session_state.get("escritorio_id")
        papeis_disponiveis = [auth.PAPEL_USUARIO, auth.PAPEL_ADMIN_ESCRITORIO]
        st.caption(f"Escritório: **{st.session_state.get('escritorio_nome')}**")

    usuarios_escopo = auth.usuarios_do_escritorio(usuarios_todos, escritorio_visto)

    st.subheader("Cadastrar usuário / redefinir senha")
    _flash("flash_usuario_salvo")
    with st.form("gerenciar_usuario_form", clear_on_submit=True):
        alvo = st.text_input("Usuário (novo ou existente)")
        nome_completo = st.text_input("Nome completo (opcional)")
        papel = st.selectbox("Papel", papeis_disponiveis)
        nova_senha = st.text_input("Senha (mín. 6 caracteres)", type="password")
        salvar = st.form_submit_button("Salvar", type="primary")
    if salvar:
        alvo = alvo.strip()
        ja_existe = alvo in usuarios_todos
        if not alvo:
            st.error("Informe o nome de usuário.")
        elif len(nova_senha) < 6:
            st.error("A senha precisa ter pelo menos 6 caracteres.")
        elif ja_existe and not eh_global and usuarios_todos[alvo].get("escritorio_id") != escritorio_visto:
            st.error("Esse usuário pertence a outro escritório — você só gerencia o seu.")
        else:
            auth.criar_ou_atualizar_usuario(
                alvo, nova_senha, escritorio_id=escritorio_visto, papel=papel,
                nome=nome_completo.strip(), deve_trocar_senha=True,
            )
            _flash("flash_usuario_salvo",
                   f"✅ Usuário '{alvo}' salvo com sucesso — vai precisar trocar a senha no próximo login.")
            st.rerun()

    st.divider()
    st.subheader(f"Usuários cadastrados ({len(usuarios_escopo)})")
    _flash("flash_usuario_status")
    _flash("flash_usuario_removido")

    if not usuarios_escopo:
        st.info("Nenhum usuário cadastrado neste escritório ainda.")
        return

    for uname, dados in sorted(usuarios_escopo.items()):
        ativo = auth.usuario_esta_ativo(dados)
        voce = uname == st.session_state.get("usuario_logado")
        status_txt = "🟢 Ativo" if ativo else "🔴 Inativo"
        # mantem aberto entre reruns enquanto houver uma acao pendente
        # marcada neste usuario (mesmo motivo do fix nos escritorios).
        aberto = bool(
            st.session_state.get(f"confirmar_remover_{uname}")
            or st.session_state.get(f"aberto_{uname}")
        )
        rotulo = f"{dados.get('nome', uname)} (`{uname}`) · {dados.get('papel')} · {status_txt}"
        with st.expander(rotulo, expanded=aberto):
            st.caption(f"Papel: {dados.get('papel')}" + (" · (você)" if voce else ""))

            c1, c2 = st.columns(2)
            with c1:
                if ativo:
                    if voce:
                        st.caption("Você não pode inativar a própria conta.")
                    elif st.button("🔴 Inativar", key=f"inativar_{uname}"):
                        ok, msg = auth.definir_status_usuario(uname, ativo=False)
                        if ok:
                            _flash("flash_usuario_status", f"✅ {msg}")
                            st.rerun()
                        else:
                            st.error(msg)
                else:
                    if st.button("🟢 Ativar", key=f"ativar_{uname}", type="primary"):
                        ok, msg = auth.definir_status_usuario(uname, ativo=True)
                        if ok:
                            _flash("flash_usuario_status", f"✅ {msg}")
                            st.rerun()
                        else:
                            st.error(msg)
            with c2:
                if voce:
                    st.caption("Você não pode remover a própria conta.")
                else:
                    confirmar = st.checkbox("Confirmar remoção definitiva", key=f"confirmar_remover_{uname}")
                    if st.button("🗑️ Remover definitivamente", key=f"remover_{uname}", disabled=not confirmar):
                        if auth.remover_usuario(uname):
                            _flash("flash_usuario_removido", f"✅ Usuário '{uname}' removido definitivamente.")
                            st.rerun()
                        else:
                            st.error("Não foi possível remover: precisa sobrar pelo menos 1 admin para este escritório.")

            st.divider()
            st.markdown("**Redefinir senha**")
            with st.form(f"redefinir_senha_{uname}_form", clear_on_submit=True):
                nova_senha_user = st.text_input(
                    "Nova senha (mín. 6 caracteres)", type="password", key=f"nova_senha_{uname}"
                )
                redefinir = st.form_submit_button("🔑 Redefinir senha")
            if redefinir:
                if len(nova_senha_user) < 6:
                    st.error("A senha precisa ter pelo menos 6 caracteres.")
                    st.session_state[f"aberto_{uname}"] = True
                else:
                    auth.redefinir_senha(uname, nova_senha_user, forcar_troca=True)
                    st.session_state[f"aberto_{uname}"] = False
                    _flash("flash_usuario_status",
                           f"✅ Senha de '{uname}' redefinida — vai precisar trocar no próximo login.")
                    st.rerun()


def _tela_historico() -> None:
    """Tela de historico dos lancamentos (conciliacoes) rodados por cada
    usuario - so super_admin_global (escolhendo o escritorio) e
    admin_escritorio (so o proprio) enxergam; usuario comum nao ve o
    historico dos colegas."""
    st.title("📜 Histórico de Lançamentos")
    if st.button("← Início"):
        st.session_state["tela"] = "home"
        st.rerun()
    st.divider()

    eh_global = st.session_state.get("papel_usuario") == auth.PAPEL_SUPER_GLOBAL
    if eh_global:
        escritorios = auth.carregar_escritorios()
        if not escritorios:
            st.info("Nenhum escritório cadastrado ainda.")
            return
        escritorio_visto = st.selectbox(
            "Escritório",
            list(escritorios.keys()),
            format_func=lambda eid: escritorios.get(eid, {}).get("nome", eid),
            index=list(escritorios.keys()).index(st.session_state.get("escritorio_id"))
            if st.session_state.get("escritorio_id") in escritorios else 0,
        )
    else:
        escritorio_visto = st.session_state.get("escritorio_id")
        st.caption(f"Escritório: **{st.session_state.get('escritorio_nome')}**")

    registros = historico.listar(escritorio_visto)
    if not registros:
        st.info("Nenhum lançamento registrado ainda neste escritório.")
        return

    st.caption(f"{len(registros)} lançamento(s) mais recente(s) primeiro:")
    for r in registros:
        dt = r["criado_em"]
        empresa = r.get("empresa_nome") or r["empresa_codigo"]
        st.write(
            f"👤 **{r['usuario']}** — Lançamento {empresa} "
            f"dia {dt.strftime('%d/%m/%Y')} hora {dt.strftime('%H:%M')}"
        )


def _tela_gerenciar_clientes() -> None:
    """Tela dedicada para gerenciar os clientes (empresas) cadastrados:
    cadastrar, editar nome/código e remover. Disponível pra qualquer
    usuário logado (é só referência de negócio, não dado sensível) -
    super_admin_global escolhe qual escritório ver; os demais só enxergam
    o próprio. Remoção fica restrita a admin_escritorio/super_admin_global
    pra evitar que alguém apague por engano um código usado por outros."""
    st.title("🏢 Gerenciar Clientes")
    if st.button("← Início"):
        st.session_state["tela"] = "home"
        st.rerun()
    st.divider()

    eh_global = st.session_state.get("papel_usuario") == auth.PAPEL_SUPER_GLOBAL
    pode_remover = st.session_state.get("papel_usuario") in (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO)

    if eh_global:
        escritorios = auth.carregar_escritorios()
        if not escritorios:
            st.info("Nenhum escritório cadastrado ainda.")
            return
        escritorio_visto = st.selectbox(
            "Escritório",
            list(escritorios.keys()),
            format_func=lambda eid: escritorios.get(eid, {}).get("nome", eid),
            index=list(escritorios.keys()).index(st.session_state.get("escritorio_id"))
            if st.session_state.get("escritorio_id") in escritorios else 0,
        )
    else:
        escritorio_visto = st.session_state.get("escritorio_id")
        st.caption(f"Escritório: **{st.session_state.get('escritorio_nome')}**")

    st.subheader("Cadastrar cliente")
    _flash("flash_gerenciar_cliente")
    with st.form("gerenciar_cliente_form", clear_on_submit=True):
        novo_nome = st.text_input("Nome do cliente")
        novo_codigo = st.text_input("Código da empresa no Domínio")
        salvar = st.form_submit_button("Cadastrar", type="primary")
    if salvar:
        if not novo_nome.strip() or not novo_codigo.strip():
            st.error("Informe nome e código da empresa.")
        else:
            ok, msg = clientes.criar_cliente(escritorio_visto, novo_nome.strip(), novo_codigo.strip())
            if ok:
                _flash("flash_gerenciar_cliente", f"✅ {msg}")
                st.rerun()
            else:
                st.error(msg)

    st.divider()
    lista = clientes.listar_clientes(escritorio_visto)
    st.subheader(f"Clientes cadastrados ({len(lista)})")

    if not lista:
        st.info("Nenhum cliente cadastrado neste escritório ainda.")
        return

    for c in lista:
        aberto = bool(st.session_state.get(f"aberto_cliente_{c['id']}"))
        with st.expander(f"{c['nome']} — {c['codigo_dominio']}", expanded=aberto):
            with st.form(f"editar_cliente_{c['id']}_form"):
                nome_edit = st.text_input("Nome", value=c["nome"], key=f"nome_cliente_{c['id']}")
                codigo_edit = st.text_input(
                    "Código da empresa no Domínio", value=c["codigo_dominio"], key=f"codigo_cliente_{c['id']}"
                )
                salvar_edit = st.form_submit_button("💾 Salvar alterações")
            if salvar_edit:
                if not nome_edit.strip() or not codigo_edit.strip():
                    st.error("Nome e código não podem ficar em branco.")
                    st.session_state[f"aberto_cliente_{c['id']}"] = True
                else:
                    ok, msg = clientes.atualizar_cliente(
                        c["id"], escritorio_visto, nome_edit.strip(), codigo_edit.strip()
                    )
                    if ok:
                        _flash("flash_gerenciar_cliente", f"✅ {msg}")
                        st.session_state[f"aberto_cliente_{c['id']}"] = False
                        st.rerun()
                    else:
                        st.error(msg)
                        st.session_state[f"aberto_cliente_{c['id']}"] = True

            if pode_remover:
                confirmar = st.checkbox(
                    "Confirmar remoção definitiva", key=f"confirmar_remover_cliente_{c['id']}"
                )
                if confirmar:
                    st.session_state[f"aberto_cliente_{c['id']}"] = True
                if st.button(
                    "🗑️ Remover definitivamente", key=f"remover_cliente_{c['id']}", disabled=not confirmar,
                ):
                    clientes.remover_cliente(c["id"], escritorio_visto)
                    st.session_state[f"aberto_cliente_{c['id']}"] = False
                    _flash("flash_gerenciar_cliente", f"✅ Cliente '{c['nome']}' removido.")
                    st.rerun()


def _tela_rpa_hub() -> None:
    """Hub de RPAs do escritório: cadastro de credenciais de procurador,
    upload de planilha e acompanhamento das execuções, por módulo (ISS Web
    é o primeiro — novos módulos só entram em rpa/registry.py, esta tela
    não muda). O processamento de verdade roda no worker separado
    (rpa_worker.py, container à parte com Playwright) — esta tela só
    enfileira em rpa_execucoes/rpa_empresas e mostra status/resultado."""
    st.title("🤖 Hub de RPAs")
    if st.button("← Início"):
        st.session_state["tela"] = "home"
        st.rerun()
    st.divider()

    escritorio_id = st.session_state.get("escritorio_id")
    usuario = st.session_state.get("usuario_logado")

    modulo_id = st.selectbox(
        "Rotina", list(rpa_registry.MODULOS.keys()),
        format_func=lambda m: rpa_registry.MODULOS[m]["titulo"],
    )
    modulo_info = rpa_registry.MODULOS[modulo_id]
    sistema = modulo_info["sistema_credencial"]

    st.subheader("Credenciais do procurador")
    cred = rpa_core.tem_credencial(escritorio_id, sistema)
    if cred:
        st.caption(
            f"✅ Cadastrada — CNPJ {cred['cnpj']} · "
            f"atualizado em {cred['atualizado_em']:%d/%m/%Y %H:%M} por {cred['atualizado_por']}"
        )
    else:
        st.caption("⚠️ Nenhuma credencial cadastrada ainda para esta rotina.")

    with st.expander("Cadastrar / atualizar credencial"):
        with st.form(f"credencial_form_{modulo_id}", clear_on_submit=True):
            cnpj_proc = st.text_input("CNPJ do procurador")
            senha_proc = st.text_input("Senha do procurador", type="password")
            salvar_cred = st.form_submit_button("Salvar", type="primary")
        if salvar_cred:
            if not cnpj_proc.strip() or not senha_proc:
                st.error("Informe CNPJ e senha.")
            else:
                rpa_core.salvar_credencial(escritorio_id, sistema, cnpj_proc.strip(), senha_proc, usuario)
                _flash("flash_rpa_hub", "✅ Credencial salva.")
                st.rerun()

    st.divider()
    _flash("flash_rpa_hub")

    st.subheader("Nova execução")
    if not cred:
        st.info("Cadastre a credencial do procurador acima antes de enviar uma planilha.")
    else:
        up_planilha = st.file_uploader(
            "Planilha de empresas (.xlsx)", type=["xlsx"], key=f"up_planilha_{modulo_id}",
        )
        if up_planilha:
            conteudo = up_planilha.getvalue()
            try:
                empresas = rpa_registry.ler_empresas(modulo_id, conteudo)
            except Exception as exc:
                st.error(str(exc))
            else:
                st.success(f"{len(empresas)} empresa(s) de Senador Canedo encontradas na planilha.")
                with st.expander("Ver empresas identificadas"):
                    st.dataframe(
                        [
                            {"Código": e["codigo"], "CNPJ/CPF": e["cnpj_cpf"], "Obrigação": e["obrigacao"]}
                            for e in empresas
                        ],
                        use_container_width=True, hide_index=True,
                    )
                if st.button("🚀 Iniciar processamento", type="primary"):
                    execucao_id = rpa_core.criar_execucao(
                        escritorio_id, modulo_id, conteudo, up_planilha.name, usuario, empresas,
                    )
                    _flash("flash_rpa_hub", f"✅ Execução #{execucao_id} criada — {len(empresas)} empresa(s) na fila.")
                    st.rerun()

    st.divider()
    st.subheader("Execuções")
    execucoes = rpa_core.listar_execucoes(escritorio_id, modulo_id)
    if not execucoes:
        st.info("Nenhuma execução ainda para esta rotina.")
        return

    if st.button("🔄 Atualizar status"):
        st.rerun()

    emoji_status = {"PENDENTE": "⏳", "RODANDO": "🔄", "CONCLUIDO": "✅", "ERRO": "❌"}
    for execucao in execucoes:
        empresas_exec = rpa_core.listar_empresas(execucao["id"])
        concluidas = sum(1 for e in empresas_exec if e["status"] == rpa_core.STATUS_CONCLUIDO)
        erros = sum(1 for e in empresas_exec if e["status"] == rpa_core.STATUS_ERRO)
        titulo = (
            f"{emoji_status.get(execucao['status'], '•')} Execução #{execucao['id']} — "
            f"{execucao['criado_em']:%d/%m/%Y %H:%M} — {execucao['status']} "
            f"({concluidas}/{len(empresas_exec)} concluídas, {erros} erro(s))"
        )
        with st.expander(titulo):
            st.caption(f"Planilha: {execucao['planilha_nome']} · Enviada por {execucao['criado_por']}")
            for empresa in empresas_exec:
                cols = st.columns([1, 2, 1, 1, 2])
                cols[0].write(empresa["codigo"])
                cols[1].write(empresa["cnpj_cpf"])
                cols[2].write(empresa["obrigacao"])
                cols[3].write(empresa["status"])
                if empresa["status"] == rpa_core.STATUS_CONCLUIDO and empresa["pdf"]:
                    cols[4].download_button(
                        "⬇️ PDF", bytes(empresa["pdf"]), file_name=empresa["pdf_nome"],
                        key=f"pdf_{empresa['id']}",
                    )
                elif empresa["status"] == rpa_core.STATUS_ERRO:
                    cols[4].caption(f"⚠️ {empresa['erro']}")
                else:
                    cols[4].write("—")


_APPS_HOME = [
    {
        "icone": "🏦",
        "titulo": "Conciliação Bancária Automática",
        "descricao": "Extrato/fluxo de caixa × razão contábil × balancete → espelho e arquivo de importação Domínio.",
        "tela": "conciliacao",
    },
    {
        "icone": "🤖",
        "titulo": "RPA — Fechamento REST/DMS",
        "descricao": "Fechamento mensal de REST e DMS no ISS Web (Senador Canedo/GO).",
        "tela": "rpa_hub",
    },
    {
        "icone": "📋",
        "titulo": "RPA — Folha de Pagamento",
        "descricao": "Fechamento da folha no Domínio Folha. Ainda roda por automação assistida, sem tela própria aqui.",
        "tela": None,
    },
]


def _tela_home() -> None:
    """Tela inicial: um icone por aplicativo do escritorio. Cada app novo
    (proxima automacao) so precisa de uma entrada em _APPS_HOME - nao mexe
    no roteamento das telas que ja existem."""
    st.markdown(
        "<div style='text-align:center;font-size:2.25rem;font-weight:700;"
        "margin-bottom:0.25rem;'>👋 Bem-vindo(a)</div>"
        "<div style='text-align:center;color:rgba(250,250,250,0.6);"
        "margin-bottom:2rem;'>Escolha um aplicativo para começar.</div>",
        unsafe_allow_html=True,
    )

    colunas = st.columns(len(_APPS_HOME))
    for coluna, app in zip(colunas, _APPS_HOME):
        with coluna:
            with st.container(border=True):
                st.markdown(
                    f"<div style='text-align:center;font-size:3rem;'>{app['icone']}</div>",
                    unsafe_allow_html=True,
                )
                st.markdown(f"<div style='text-align:center;font-weight:600;'>{app['titulo']}</div>",
                            unsafe_allow_html=True)
                st.caption(app["descricao"])
                if app["tela"]:
                    if st.button("Abrir", key=f"home_abrir_{app['tela']}",
                                 use_container_width=True, type="primary"):
                        st.session_state["tela"] = app["tela"]
                        st.rerun()
                else:
                    st.button("Em breve", key="home_abrir_rpa_folha",
                              use_container_width=True, disabled=True)


_renderizar_cookie_pendente()

if "usuario_logado" not in st.session_state:
    # antes de exigir login de novo: a pagina pode ter sido so atualizada
    # (F5), que abre uma conexao Streamlit nova e zera o session_state -
    # se o navegador ainda tiver um cookie de sessao valido, reloga sem
    # pedir usuario/senha de novo.
    _token_cookie = st.context.cookies.get(_COOKIE_SESSAO, "")
    _dados_cookie = auth.validar_sessao(_token_cookie) if _token_cookie else None
    if _dados_cookie:
        _popular_sessao(_dados_cookie, token=_token_cookie)
        st.rerun()

if "usuario_logado" not in st.session_state:
    _tela_login()
    st.stop()

if st.session_state.get("deve_trocar_senha"):
    _tela_trocar_senha(obrigatoria=True)
    st.stop()

if st.session_state.get("mostrar_trocar_senha"):
    _tela_trocar_senha(obrigatoria=False)
    st.stop()

st.session_state.setdefault("tela", "home")

if st.session_state.get("tela") == "home":
    _tela_home()
    st.stop()

if st.session_state.get("tela") == "gerenciar_escritorios":
    if st.session_state.get("papel_usuario") != auth.PAPEL_SUPER_GLOBAL:
        st.session_state["tela"] = "home"
    else:
        _tela_gerenciar_escritorios()
        st.stop()

if st.session_state.get("tela") == "gerenciar_usuarios":
    if st.session_state.get("papel_usuario") not in (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO):
        st.session_state["tela"] = "home"
    else:
        _tela_gerenciar_usuarios()
        st.stop()

if st.session_state.get("tela") == "historico":
    if st.session_state.get("papel_usuario") not in (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO):
        st.session_state["tela"] = "home"
    else:
        _tela_historico()
        st.stop()

if st.session_state.get("tela") == "gerenciar_clientes":
    _tela_gerenciar_clientes()
    st.stop()

if st.session_state.get("tela") == "rpa_hub":
    _tela_rpa_hub()
    st.stop()

with st.sidebar:
    st.caption(f"👤 {st.session_state.get('nome_usuario')} · {st.session_state.get('papel_usuario')}")
    st.caption(f"🏢 {st.session_state.get('escritorio_nome')}")
    csb1, csb2 = st.columns(2)
    with csb1:
        if st.button("Trocar senha", use_container_width=True):
            st.session_state["mostrar_trocar_senha"] = True
            st.rerun()
    with csb2:
        if st.button("Sair", use_container_width=True):
            _fazer_logout()
    if st.button("🏠 Início", use_container_width=True):
        st.session_state["tela"] = "home"
        st.rerun()
    if st.button("🏢 Gerenciar Clientes", use_container_width=True):
        st.session_state["tela"] = "gerenciar_clientes"
        st.rerun()
    if st.session_state.get("papel_usuario") == auth.PAPEL_SUPER_GLOBAL:
        if st.button("🌐 Gerenciar Escritórios", use_container_width=True):
            st.session_state["tela"] = "gerenciar_escritorios"
            st.rerun()
    if st.session_state.get("papel_usuario") in (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO):
        if st.button("👥 Gerenciar Usuários", use_container_width=True):
            st.session_state["tela"] = "gerenciar_usuarios"
            st.rerun()
        if st.button("📜 Histórico de Lançamentos", use_container_width=True):
            st.session_state["tela"] = "historico"
            st.rerun()
    st.divider()

def _resetar_empresa() -> None:
    """Limpa os arquivos e parametros preenchidos, pra comecar a
    conciliacao de outra empresa do zero - chamada tanto pelo botao do
    topo quanto pelo de baixo, perto dos downloads."""
    _chaves_reset_empresa = [
        "forcar_escolha_conta",
        "sel_conta_saida_padrao", "sel_conta_entrada_padrao", "filtro_pendencias",
        "sel_conta_grupo_filtrado", "historico_ultima_assinatura", "pend_contas_manuais",
        "pagina_pendencias_individual",
    ]
    for _chave in _chaves_reset_empresa:
        st.session_state.pop(_chave, None)
    # selectboxes individuais de tratativa de pendencia (chave dinamica
    # por lancamento) - limpa todas de uma vez, nao da pra listar antes.
    for _chave in list(st.session_state.keys()):
        if _chave.startswith("sel_ci_"):
            del st.session_state[_chave]
    # os 3 file_uploader tem uma peculiaridade do Streamlit: apagar a
    # chave do session_state sozinho nao limpa visualmente o arquivo ja
    # selecionado - precisa trocar a propria key do widget (por isso o
    # contador "reset_seq" usado no key= deles mais abaixo).
    st.session_state["reset_seq"] = st.session_state.get("reset_seq", 0) + 1
    # limpa o cache de processamento (@st.cache_data) tambem - garante que
    # a proxima conciliacao roda 100% do zero, sem reaproveitar nenhum
    # resultado (balancete/conta banco/conciliacao) calculado antes.
    st.cache_data.clear()


def _resetar_lancamento() -> None:
    """Limpa os arquivos e pendencias do lancamento atual (extrato,
    balancete, competencia, saldos) pra rodar a proxima competencia -
    mas MANTEM a empresa (cliente) e o modo de arquivo selecionados,
    ja que normalmente e a mesma empresa que vai lancar o mes seguinte
    (diferente do botao "Novo lançamento" do topo, que zera tudo,
    inclusive a empresa, pra comecar outra do zero)."""
    _seq_atual = st.session_state.get("reset_seq", 0)
    _cliente_atual = st.session_state.get(f"sel_cliente_empresa_{_seq_atual}")
    _modo_atual = st.session_state.get(f"radio_modo_arquivos_{_seq_atual}")
    _resetar_empresa()
    _seq_novo = st.session_state.get("reset_seq", 0)
    if _cliente_atual:
        st.session_state[f"sel_cliente_empresa_{_seq_novo}"] = _cliente_atual
    if _modo_atual:
        st.session_state[f"radio_modo_arquivos_{_seq_novo}"] = _modo_atual


_titulo_col, _reset_col = st.columns([5, 1.4])
with _titulo_col:
    st.title("🏦 Conciliação Bancária Automatizada")
    st.caption(f"{st.session_state.get('escritorio_nome')} · "
               "Extrato/fluxo de caixa × razão contábil × balancete → espelho + arquivo de importação Domínio")
with _reset_col:
    st.write("")
    if st.button(
        "🆕 Novo lançamento", use_container_width=True, key="btn_nova_empresa_topo",
        help="Limpa arquivos, parâmetros e cache, pra começar a conciliação de outra empresa do zero.",
    ):
        _resetar_empresa()
        st.rerun()

# Alem dos file_uploader, o selectbox de empresa e o radio de modo de
# arquivo tambem sofrem da mesma peculiaridade do Streamlit (apagar a
# chave do session_state sozinho nao reseta visualmente o valor ja
# escolhido) - por isso usam o mesmo sufixo "reset_seq" no key= deles.
_reset_seq = st.session_state.get("reset_seq", 0)

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

    _escritorio_id_atual = st.session_state.get("escritorio_id")
    _lista_clientes = clientes.listar_clientes(_escritorio_id_atual)
    _flash("flash_cliente_salvo")

    empresa_codigo: Optional[str] = None
    empresa_nome_selecionado: Optional[str] = None
    if _lista_clientes:
        _opcoes_cliente = ["(selecione)"] + [f"{c['nome']} — {c['codigo_dominio']}" for c in _lista_clientes]
        _escolha_cliente = st.selectbox(
            "Empresa (cliente) *", _opcoes_cliente, key=f"sel_cliente_empresa_{_reset_seq}",
        )
        if _escolha_cliente != "(selecione)":
            _cliente_sel = _lista_clientes[_opcoes_cliente.index(_escolha_cliente) - 1]
            empresa_codigo = _cliente_sel["codigo_dominio"]
            empresa_nome_selecionado = _cliente_sel["nome"]
    else:
        st.info("Nenhum cliente cadastrado ainda — cadastre um abaixo.")

    with st.expander("➕ Cadastrar novo cliente"):
        with st.form("novo_cliente_form", clear_on_submit=True):
            _cliente_nome_novo = st.text_input("Nome do cliente")
            _cliente_codigo_novo = st.text_input("Código da empresa no Domínio")
            _salvar_cliente = st.form_submit_button("Cadastrar cliente", type="primary")
        if _salvar_cliente:
            if not _cliente_nome_novo.strip() or not _cliente_codigo_novo.strip():
                st.error("Informe nome e código da empresa.")
            else:
                _ok, _msg = clientes.criar_cliente(
                    _escritorio_id_atual, _cliente_nome_novo.strip(), _cliente_codigo_novo.strip()
                )
                if _ok:
                    _flash("flash_cliente_salvo", f"✅ {_msg}")
                    st.rerun()
                else:
                    st.error(_msg)

        if _lista_clientes and st.session_state.get("papel_usuario") in (
            auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO,
        ):
            st.caption("Remover cliente cadastrado:")
            for _c in _lista_clientes:
                _cc1, _cc2 = st.columns([4, 1])
                with _cc1:
                    st.caption(f"{_c['nome']} — {_c['codigo_dominio']}")
                with _cc2:
                    if st.button("🗑️", key=f"remover_cliente_{_c['id']}"):
                        clientes.remover_cliente(_c["id"], _escritorio_id_atual)
                        _flash("flash_cliente_salvo", f"✅ Cliente '{_c['nome']}' removido.")
                        st.rerun()

    competencia = st.text_input(
        "Competência (MM-AAAA)",
        value="",
        placeholder="Ex: 01-2026 — deixe em branco p/ detectar do balancete",
        help="Se deixado em branco, a competência é detectada automaticamente a partir do texto do balancete informado.",
        key=f"input_competencia_{_reset_seq}",
    )

    col1, col2 = st.columns(2)
    with col1:
        saldo_inicial_razao = st.number_input(
            "Saldo inicial razão (R$)", value=0.0, step=0.01, format="%.2f",
            key=f"input_saldo_razao_{_reset_seq}",
        )
    with col2:
        saldo_inicial_extrato = st.number_input(
            "Saldo inicial extrato (R$)", value=0.0, step=0.01, format="%.2f",
            key=f"input_saldo_extrato_{_reset_seq}",
        )

    with st.expander("Avançado"):
        dias_tolerancia = st.number_input(
            "Dias de tolerância no match (cheques)", value=0, min_value=0, max_value=15,
            key=f"input_dias_tolerancia_{_reset_seq}",
        )
        cod_historico = st.text_input(
            "Código de histórico padrão Domínio", value="",
            help="Confirme contra a tabela de históricos do escritório antes de importar.",
            key=f"input_cod_historico_{_reset_seq}",
        )

st.divider()

# ---------------------------------------------------------------------------
# Escolha de origem dos arquivos: upload ou pasta
# ---------------------------------------------------------------------------

modo = st.radio(
    "Como fornecer os arquivos?", ["Upload de arquivos", "Caminho de uma pasta"],
    horizontal=True, key=f"radio_modo_arquivos_{_reset_seq}",
)

extrato_path: Optional[str] = None
razao_path: Optional[str] = None
balancete_path: Optional[str] = None

if "tmpdir" not in st.session_state:
    st.session_state.tmpdir = Path(tempfile.mkdtemp(prefix="conc_upload_"))
_tmpdir = st.session_state.tmpdir
_reset_seq = st.session_state.get("reset_seq", 0)


def _salvar_upload(uploaded_file, destino_nome: str) -> str:
    destino = _tmpdir / destino_nome
    destino.write_bytes(uploaded_file.getvalue())
    return str(destino)


if modo == "Upload de arquivos":
    c1, c2, c3 = st.columns(3)
    with c1:
        up_extrato = st.file_uploader(
            "Extrato / fluxo de caixa", type=["ofx", "csv", "pdf"], key=f"up_extrato_{_reset_seq}",
        )
    with c2:
        up_razao = st.file_uploader(
            "Razão contábil da conta (opcional)", type=["csv", "pdf"], key=f"up_razao_{_reset_seq}",
        )
    with c3:
        up_balancete = st.file_uploader(
            "Balancete", type=["csv", "pdf"], key=f"up_balancete_{_reset_seq}",
        )

    if up_extrato:
        extrato_path = _salvar_upload(up_extrato, f"extrato{Path(up_extrato.name).suffix}")
    if up_razao:
        razao_path = _salvar_upload(up_razao, f"razao{Path(up_razao.name).suffix}")
    if up_balancete:
        balancete_path = _salvar_upload(up_balancete, f"balancete{Path(up_balancete.name).suffix}")

else:
    st.warning(
        "⚠️ Esse caminho é lido no **servidor** onde o app está rodando (não no seu computador). "
        "Como este sistema fica hospedado na nuvem (hub.redeg7.com), ele não enxerga pastas do seu "
        "PC — use \"Upload de arquivos\" acima para enviar os arquivos diretamente daqui. Esta opção "
        "só funciona quando o app roda localmente na própria máquina onde os arquivos estão."
    )
    pasta_str = st.text_input(
        "Caminho da pasta com os arquivos", placeholder=r"C:\Clientes\EmpresaX\2026-01",
        key=f"input_pasta_caminho_{_reset_seq}",
    )
    if pasta_str:
        pasta = Path(pasta_str)
        if not pasta.is_dir():
            st.error(f"Pasta não encontrada no servidor: {pasta_str} — lembre-se que este caminho "
                     "precisa existir na máquina onde o app está rodando, não no seu computador.")
        else:
            candidatos = _identificar_arquivos_na_pasta(pasta)
            st.write("Arquivos identificados automaticamente (confira/ajuste antes de rodar):")
            c1, c2, c3 = st.columns(3)

            def _seletor(col, categoria, label):
                opcoes = candidatos[categoria] or list(pasta.glob("*"))
                opcoes_validas = [f for f in opcoes if f.is_file() and f.suffix.lower() in (".ofx", ".csv", ".pdf")]
                nomes = ["(selecione)"] + [f.name for f in opcoes_validas]
                with col:
                    escolha = st.selectbox(label, nomes, key=f"sel_{categoria}_{_reset_seq}")
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

    _contas_nome_ilegivel = [c for c in contas_balancete if c.nome == cb.NOME_ILEGIVEL_BALANCETE]
    if _contas_nome_ilegivel:
        with st.expander(
            f"⚠️ {len(_contas_nome_ilegivel)} conta(s) do balancete com nome ilegível "
            "(código recuperado, mas o nome não — clique para ver os códigos)"
        ):
            st.caption(
                "Nome comprido demais ficou sobreposto ao código no PDF de origem — o código foi "
                "recuperado (aparece como \"não identificado\" na lista de contas), mas confira o "
                "nome real no balancete original pela classificação antes de vincular:"
            )
            st.write(", ".join(f"{c.codigo} ({c.classificacao})" for c in _contas_nome_ilegivel))

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
            escolha = st.selectbox(
                "Conta banco a conciliar (lida do balancete) *", rotulos, key=f"sel_conta_banco_{_reset_seq}",
            )
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
    # `resultado` vem de @st.cache_data (uma COPIA nova a cada rerun) -
    # entao as escolhas manuais (grupo filtrado / individual) de reruns
    # anteriores precisam ser reaplicadas aqui, ANTES de contar quantas
    # pendencias restam, senao o contador nunca desce e cada selecao
    # dispara um st.rerun() que reaplica de novo -> loop infinito.
    # -----------------------------------------------------------------
    def _chave_estavel_mov(idx: int, mov) -> str:
        return f"{idx}_{mov.data.isoformat()}_{round(mov.valor, 2)}_{hash(mov.descricao)}"

    _idx_por_mov = {id(m): i for i, m in enumerate(resultado.pendentes_banco)}
    _pend_manuais = st.session_state.setdefault("pend_contas_manuais", {})
    if _pend_manuais:
        for _idx_mov, _mov in enumerate(resultado.pendentes_banco):
            if _mov.status != "conta_nao_identificada":
                continue
            _codigo_salvo = _pend_manuais.get(_chave_estavel_mov(_idx_mov, _mov))
            if _codigo_salvo:
                cb.aplicar_contrapartida_padrao(
                    [_mov], resultado.conta_banco,
                    conta_saida_codigo=_codigo_salvo, conta_entrada_codigo=_codigo_salvo,
                )

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

        # -------------------------------------------------------------
        # Filtro + tratativa agrupada ou individual: a conta padrao acima
        # so cobre "todas as saidas"/"todas as entradas" de uma vez - aqui
        # da pra filtrar por descricao (ex.: nome de um fornecedor) e
        # aplicar uma conta so aquele grupo filtrado, ou linha por linha.
        # -------------------------------------------------------------
        pendentes_restantes = [m for m in resultado.pendentes_banco if m.status == "conta_nao_identificada"]
        if pendentes_restantes:
            with st.expander(
                f"🔍 Filtrar e tratar pendências agrupadas ou individualmente "
                f"({len(pendentes_restantes)} restante(s))"
            ):
                filtro = st.text_input(
                    "Filtrar por descrição (ex.: nome do fornecedor/cliente)",
                    key="filtro_pendencias",
                )
                filtradas = (
                    [m for m in pendentes_restantes if filtro.strip().lower() in m.descricao.lower()]
                    if filtro.strip() else pendentes_restantes
                )
                st.caption(
                    f"{len(filtradas)} pendência(s) encontrada(s)"
                    + (" com esse filtro." if filtro.strip() else ".")
                )

                if filtradas:
                    st.markdown("**Aplicar uma conta a todas as pendências filtradas de uma vez (agrupado):**")
                    cg1, cg2 = st.columns([3, 1])
                    with cg1:
                        escolha_grupo = st.selectbox(
                            "Conta para o grupo filtrado", rotulos_contas, key="sel_conta_grupo_filtrado",
                        )
                    with cg2:
                        st.write("")
                        aplicar_grupo = st.button("Aplicar ao grupo")
                    if aplicar_grupo:
                        if escolha_grupo == "(não atribuir)":
                            st.error("Escolha uma conta antes de aplicar ao grupo.")
                        else:
                            codigo_grupo = escolha_grupo.split(" — ")[0]
                            for _mov_grupo in filtradas:
                                _chave = _chave_estavel_mov(_idx_por_mov[id(_mov_grupo)], _mov_grupo)
                                _pend_manuais[_chave] = codigo_grupo
                            qtd_grupo = cb.aplicar_contrapartida_padrao(
                                filtradas, resultado.conta_banco,
                                conta_saida_codigo=codigo_grupo, conta_entrada_codigo=codigo_grupo,
                            )
                            st.success(f"{qtd_grupo} pendência(s) do grupo filtrado resolvida(s).")
                            st.rerun()

                    st.markdown("**Ou tratar uma pendência por vez (individual):**")
                    # Renderizar um st.selectbox com TODO o plano de contas pra
                    # cada pendencia de uma vez trava a tela por minutos quando
                    # ha centenas delas - por isso so mostra ate 30 por pagina
                    # (nao um limite bloqueante: da pra folhear todas as
                    # pendencias, filtradas ou nao, 30 em 30).
                    _PAGINA_TAMANHO = 30
                    _total_paginas = max(1, -(-len(filtradas) // _PAGINA_TAMANHO))
                    _chave_pagina = "pagina_pendencias_individual"
                    if st.session_state.get(_chave_pagina, 1) > _total_paginas:
                        st.session_state[_chave_pagina] = _total_paginas
                    if _total_paginas > 1:
                        _pc1, _pc2 = st.columns([1, 3])
                        with _pc1:
                            _pagina_atual = st.number_input(
                                "Página", min_value=1, max_value=_total_paginas, step=1,
                                key=_chave_pagina,
                            )
                        with _pc2:
                            st.write("")
                            st.caption(f"{len(filtradas)} pendência(s) no total — {_PAGINA_TAMANHO} por página "
                                       f"({_total_paginas} página(s)).")
                    else:
                        _pagina_atual = 1
                    _inicio_pagina = (_pagina_atual - 1) * _PAGINA_TAMANHO
                    for _idx_ind, mov in enumerate(filtradas[_inicio_pagina:_inicio_pagina + _PAGINA_TAMANHO]):
                        chave_ind = (
                            f"sel_ci_{_inicio_pagina + _idx_ind}_"
                            f"{hash((mov.data, round(mov.valor, 2), mov.descricao))}"
                        )
                        ci1, ci2, ci3 = st.columns([2, 3, 3])
                        with ci1:
                            st.caption(f"{mov.data:%d/%m/%Y} · {cb.fmt_money(mov.valor)}")
                        with ci2:
                            st.caption(mov.descricao[:70])
                        with ci3:
                            escolha_ind = st.selectbox(
                                "Conta", rotulos_contas, key=chave_ind, label_visibility="collapsed",
                            )
                        if escolha_ind != "(não atribuir)":
                            codigo_ind = escolha_ind.split(" — ")[0]
                            _chave_ind_estavel = _chave_estavel_mov(_idx_por_mov[id(mov)], mov)
                            if _pend_manuais.get(_chave_ind_estavel) != codigo_ind:
                                _pend_manuais[_chave_ind_estavel] = codigo_ind
                                cb.aplicar_contrapartida_padrao(
                                    [mov], resultado.conta_banco,
                                    conta_saida_codigo=codigo_ind, conta_entrada_codigo=codigo_ind,
                                )
                                st.rerun()

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

    # so grava no historico quando a combinacao de entradas mudar - sem
    # isso, qualquer clique na tela (Streamlit reexecuta o script inteiro
    # a cada interacao) duplicaria o lancamento no historico.
    _assinatura_execucao = (
        empresa_codigo, competencia, conta_contabil,
        _mtime(extrato_path), _mtime(razao_path), _mtime(balancete_path),
    )
    if st.session_state.get("historico_ultima_assinatura") != _assinatura_execucao:
        historico.registrar(
            escritorio_id=st.session_state.get("escritorio_id"),
            usuario=st.session_state.get("usuario_logado"),
            empresa_codigo=empresa_codigo,
            empresa_nome=empresa_nome_selecionado,
        )
        st.session_state["historico_ultima_assinatura"] = _assinatura_execucao

    if info.get("aviso_ocr"):
        qtd_alertas = info.get("qtd_alertas_valor", 0)
        detalhe_alertas = (
            f" **{qtd_alertas} lançamento(s)** ficaram marcados com ⚠️ no espelho abaixo — o valor "
            "lido não bateu com a variação do saldo impresso no extrato, então comece a conferência "
            "por eles." if qtd_alertas else
            " Nenhum lançamento ficou marcado como divergente do saldo impresso, mas ainda assim "
            "vale uma conferência rápida."
        )
        st.error(
            "⚠️ O extrato foi lido via **OCR** (reconhecimento de imagem), porque o PDF não tinha "
            "texto real embutido — comum em PDFs gerados por \"Imprimir em PDF\" do navegador. "
            "OCR pode errar dígitos em valores monetários." + detalhe_alertas
        )

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
    dl1, dl2, dl3, dl4 = st.columns(4)
    with dl1:
        st.download_button("⬇ Espelho (.md)", espelho_path.read_bytes(),
                            file_name=espelho_path.name, mime="text/markdown")
    with dl2:
        st.download_button("⬇ Memória (.csv)", memoria_path.read_bytes(),
                            file_name=memoria_path.name, mime="text/csv")
    with dl3:
        st.download_button("⬇ Importação Domínio (.txt)", import_path.read_bytes(),
                            file_name=import_path.name, mime="text/plain")
    with dl4:
        if st.button(
            "🆕 Novo lançamento", use_container_width=True, key="btn_novo_lancamento_downloads",
            help="Limpa extrato, balancete, competência e pendências deste lançamento, pra rodar o "
                 "próximo (mantém a empresa selecionada).",
        ):
            _resetar_lancamento()
            st.rerun()

    st.caption("Antes de importar no Domínio: confira o código de histórico contra a tabela do escritório. "
               "O .txt de importação segue sempre o leiaute de 10 colunas separadas por ';' — pendências "
               "marcadas 'A CONFIRMAR' no espelho acima nunca entram nesse arquivo com texto inválido; "
               "elas só entram quando resolvidas (individualmente ou via conta padrão em massa acima).")

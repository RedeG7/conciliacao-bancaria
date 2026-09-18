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

st.set_page_config(page_title="Conciliacao Bancaria", page_icon="🏦", layout="wide")

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


def _fazer_logout() -> None:
    for chave in _CHAVES_SESSAO_LOGIN:
        st.session_state.pop(chave, None)
    st.rerun()


def _tela_login() -> None:
    st.markdown(
        "<div style='display:flex;justify-content:center;align-items:center;"
        "text-align:center;font-size:2.25rem;font-weight:700;line-height:1.2;"
        "margin-bottom:0.5rem;'>🏦 Conciliação Bancária Automatizada</div>"
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
                escritorios = auth.carregar_escritorios()
                eid = dados.get("escritorio_id", "")
                st.session_state["usuario_logado"] = usuario
                st.session_state["papel_usuario"] = dados.get("papel", auth.PAPEL_USUARIO)
                st.session_state["nome_usuario"] = dados.get("nome", usuario)
                st.session_state["escritorio_id"] = eid
                st.session_state["escritorio_nome"] = escritorios.get(eid, {}).get("nome", eid)
                st.session_state["deve_trocar_senha"] = bool(dados.get("deve_trocar_senha"))
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
    if st.button("← Voltar à conciliação"):
        st.session_state["tela"] = "conciliacao"
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
    if st.button("← Voltar à conciliação"):
        st.session_state["tela"] = "conciliacao"
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
    if st.button("← Voltar à conciliação"):
        st.session_state["tela"] = "conciliacao"
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
    if st.button("← Voltar à conciliação"):
        st.session_state["tela"] = "conciliacao"
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


if "usuario_logado" not in st.session_state:
    _tela_login()
    st.stop()

if st.session_state.get("deve_trocar_senha"):
    _tela_trocar_senha(obrigatoria=True)
    st.stop()

if st.session_state.get("mostrar_trocar_senha"):
    _tela_trocar_senha(obrigatoria=False)
    st.stop()

if st.session_state.get("tela") == "gerenciar_escritorios":
    if st.session_state.get("papel_usuario") != auth.PAPEL_SUPER_GLOBAL:
        st.session_state["tela"] = "conciliacao"
    else:
        _tela_gerenciar_escritorios()
        st.stop()

if st.session_state.get("tela") == "gerenciar_usuarios":
    if st.session_state.get("papel_usuario") not in (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO):
        st.session_state["tela"] = "conciliacao"
    else:
        _tela_gerenciar_usuarios()
        st.stop()

if st.session_state.get("tela") == "historico":
    if st.session_state.get("papel_usuario") not in (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO):
        st.session_state["tela"] = "conciliacao"
    else:
        _tela_historico()
        st.stop()

if st.session_state.get("tela") == "gerenciar_clientes":
    _tela_gerenciar_clientes()
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

st.title("🏦 Conciliação Bancária Automatizada")
st.caption(f"{st.session_state.get('escritorio_nome')} · "
           "Extrato/fluxo de caixa × razão contábil × balancete → espelho + arquivo de importação Domínio")

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
        _escolha_cliente = st.selectbox("Empresa (cliente) *", _opcoes_cliente, key="sel_cliente_empresa")
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
    st.warning(
        "⚠️ Esse caminho é lido no **servidor** onde o app está rodando (não no seu computador). "
        "Como este sistema fica hospedado na nuvem (hub.redeg7.com), ele não enxerga pastas do seu "
        "PC — use \"Upload de arquivos\" acima para enviar os arquivos diretamente daqui. Esta opção "
        "só funciona quando o app roda localmente na própria máquina onde os arquivos estão."
    )
    pasta_str = st.text_input("Caminho da pasta com os arquivos", placeholder=r"C:\Clientes\EmpresaX\2026-01")
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

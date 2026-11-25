"""Regras do admissoes.py: deduplicação, estados, trava de aprovação e
isolamento por escritório."""

from __future__ import annotations

import pytest

import admissoes as adm
import auth
import clientes
from conftest import ESC_A, ESC_B

ADMIN = auth.PAPEL_ADMIN_ESCRITORIO
PREVIA = {"nome_cargo": "Auxiliar de padaria", "servico": 1, "data_admissao": "2026-11-20"}


def _nova(id_externo="AC-1", canal="acessorias", empresa="101", docs=None, escritorio=ESC_A):
    linha, dup = adm.receber_solicitacao(escritorio, canal, id_externo, empresa, docs or ["ficha.pdf"])
    assert not dup
    return linha


def _ate_aprovacao(previa=None):
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    return adm.registrar_previa(a["id"], ESC_A, "agente", previa or PREVIA)


def _ate_aprovada():
    a = _ate_aprovacao()
    return adm.aprovar(a["id"], ESC_A, "dp_admin", ADMIN, a["previa_hash"])


def _status(admissao_id, escritorio=ESC_A):
    return adm.obter(admissao_id, escritorio)["status"]


# ---------------------------------------------------------------- entrada

def test_recebe_solicitacao_na_fila(db):
    a = _nova()
    assert a["status"] == adm.QUEUED
    assert a["cliente_id"] is not None
    eventos = adm.listar_eventos(a["id"], ESC_A)
    assert [e["para"] for e in eventos] == [adm.QUEUED]


def test_deduplica_por_canal_e_id_externo(db):
    a = _nova("AC-9")
    b, dup = adm.receber_solicitacao(ESC_A, "acessorias", "AC-9", "101", ["ficha.pdf"])
    assert dup and b["id"] == a["id"]
    assert len(adm.listar(ESC_A)) == 1


def test_mesmo_id_em_outro_canal_ou_escritorio_nao_e_duplicado(db):
    _nova("X-1", canal="acessorias")
    _, dup_canal = adm.receber_solicitacao(ESC_A, "onvio", "X-1", "101")
    _, dup_esc = adm.receber_solicitacao(ESC_B, "acessorias", "X-1", "201")
    assert not dup_canal and not dup_esc


def test_canal_invalido(db):
    with pytest.raises(adm.TransicaoInvalida):
        adm.receber_solicitacao(ESC_A, "email", "1", "101")


def test_empresa_fora_do_cadastro_entra_bloqueada_e_volta_quando_cadastrada(db):
    a, _ = adm.receber_solicitacao(ESC_A, "whatsapp", "W-1", "999")
    assert a["status"] == adm.BLOCKED and a["cliente_id"] is None
    assert adm.reservar_proxima(ESC_A, "agente") is None
    with pytest.raises(adm.TransicaoInvalida):
        adm.devolver_a_fila(a["id"], ESC_A, "dp_user")
    clientes.criar_cliente(ESC_A, "Nova Empresa", "999")
    b = adm.devolver_a_fila(a["id"], ESC_A, "dp_user", "Empresa cadastrada")
    assert b["status"] == adm.QUEUED and b["cliente_id"] is not None


def test_reenvio_com_documento_novo_tira_de_aguardando_documentos(db):
    a = _nova("AC-2")
    adm.reservar_proxima(ESC_A, "agente")
    adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.AWAITING_DOCUMENTS, "Falta o ASO")
    b, dup = adm.receber_solicitacao(ESC_A, "acessorias", "AC-2", "101", ["ficha.pdf", "aso.pdf"])
    assert dup
    assert b["status"] == adm.QUEUED
    assert b["documentos"] == ["ficha.pdf", "aso.pdf"]


# ---------------------------------------------------------------- fila

def test_reserva_uma_vez_so_e_por_escritorio(db):
    a = _nova()
    _nova("B-1", empresa="201", escritorio=ESC_B)
    r = adm.reservar_proxima(ESC_A, "agente")
    assert r["id"] == a["id"] and r["status"] == adm.CLAIMED and r["fase"] == adm.FASE_PREPARO
    assert adm.reservar_proxima(ESC_A, "agente") is None
    assert adm.reservar_proxima(ESC_B, "agente_b")["escritorio_id"] == ESC_B


def test_outro_agente_nao_mexe_na_tarefa_reservada(db):
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    with pytest.raises(adm.SemPermissao):
        adm.atualizar_pelo_agente(a["id"], ESC_A, "dp_user", adm.FAILED, "x")


def test_agente_nao_pode_ir_direto_para_aprovada_ou_concluida_no_preparo(db):
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    for estado in (adm.APPROVED, adm.COMPLETED, adm.AWAITING_APPROVAL, adm.QUEUED):
        with pytest.raises(adm.TransicaoInvalida):
            adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", estado)


def test_bloqueio_exige_motivo(db):
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    with pytest.raises(adm.TransicaoInvalida):
        adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.BLOCKED, "")
    adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.BLOCKED, "Sessão RDS sem Domínio aberto")
    assert _status(a["id"]) == adm.BLOCKED


def test_falha_no_preparo_devolvida_volta_para_a_fila(db):
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.FAILED, "Domínio travou")
    b = adm.devolver_a_fila(a["id"], ESC_A, "dp_user")
    assert b["status"] == adm.QUEUED


def test_nao_devolve_estado_final(db):
    a = _ate_aprovacao()
    adm.rejeitar(a["id"], ESC_A, "dp_admin", ADMIN, "Cargo errado")
    with pytest.raises(adm.TransicaoInvalida):
        adm.devolver_a_fila(a["id"], ESC_A, "dp_admin")


# ---------------------------------------------------------------- aprovação

def test_previa_vai_para_aprovacao(db):
    a = _ate_aprovacao()
    assert a["status"] == adm.AWAITING_APPROVAL
    assert a["previa_hash"] == adm.hash_previa(PREVIA)


def test_hash_da_previa_nao_depende_da_ordem_das_chaves(db):
    assert adm.hash_previa({"a": 1, "b": 2}) == adm.hash_previa({"b": 2, "a": 1})


def test_usuario_comum_aprova(db):
    a = _ate_aprovacao()
    adm.aprovar(a["id"], ESC_A, "dp_user", auth.PAPEL_USUARIO, a["previa_hash"])
    assert _status(a["id"]) == adm.APPROVED


def test_papel_desconhecido_nao_aprova(db):
    a = _ate_aprovacao()
    with pytest.raises(adm.SemPermissao):
        adm.aprovar(a["id"], ESC_A, "dp_user", "visitante", a["previa_hash"])
    assert _status(a["id"]) == adm.AWAITING_APPROVAL


def test_quem_preparou_nao_aprova(db):
    a = _ate_aprovacao()
    with pytest.raises(adm.SemPermissao):
        adm.aprovar(a["id"], ESC_A, "agente", ADMIN, a["previa_hash"])


def test_aprovacao_exige_a_previa_que_foi_vista(db):
    a = _ate_aprovacao()
    with pytest.raises(adm.TransicaoInvalida):
        adm.aprovar(a["id"], ESC_A, "dp_admin", ADMIN, adm.hash_previa({"outra": "previa"}))
    with pytest.raises(adm.TransicaoInvalida):
        adm.aprovar(a["id"], ESC_A, "dp_admin", ADMIN, "")
    assert _status(a["id"]) == adm.AWAITING_APPROVAL


def test_nao_aprova_fora_de_aguardando_aprovacao(db):
    a = _nova()
    with pytest.raises(adm.TransicaoInvalida):
        adm.aprovar(a["id"], ESC_A, "dp_admin", ADMIN, adm.hash_previa(PREVIA))


def test_aprovacao_libera_gravacao_e_conclusao(db):
    a = _ate_aprovada()
    assert a["status"] == adm.APPROVED and a["decidido_por"] == "dp_admin"
    r = adm.reservar_proxima(ESC_A, "agente")
    assert r["fase"] == adm.FASE_GRAVACAO
    c = adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.COMPLETED, protocolo="1.2.3456")
    assert c["status"] == adm.COMPLETED and c["protocolo"] == "1.2.3456"
    trilha = [(e["de"], e["para"]) for e in adm.listar_eventos(a["id"], ESC_A)]
    assert (adm.AWAITING_APPROVAL, adm.APPROVED) in trilha and (adm.CLAIMED, adm.COMPLETED) in trilha


def test_aprovadas_tem_prioridade_na_fila(db):
    a = _ate_aprovada()
    _nova("AC-depois")
    assert adm.reservar_proxima(ESC_A, "agente")["id"] == a["id"]


def test_previa_nao_muda_depois_de_aprovada(db):
    a = _ate_aprovada()
    adm.reservar_proxima(ESC_A, "agente")
    with pytest.raises(adm.TransicaoInvalida):
        adm.registrar_previa(a["id"], ESC_A, "agente", {"nome_cargo": "Gerente"})


def test_sem_aprovacao_nao_conclui_nem_com_banco_adulterado(db):
    """Defesa em profundidade: mesmo se alguém mexer direto no banco para
    pôr a tarefa em fase gravacao, concluir exige a aprovação gravada."""
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    with auth.conectar() as conn:
        conn.execute("UPDATE admissoes SET fase = 'gravacao' WHERE id = %s", (a["id"],))
        conn.commit()
    with pytest.raises(adm.SemPermissao):
        adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.COMPLETED, protocolo="x")


def test_aprovacao_que_nao_confere_volta_para_o_dp(db):
    a = _ate_aprovada()
    with auth.conectar() as conn:
        conn.execute("UPDATE admissoes SET previa_hash = 'adulterado' WHERE id = %s", (a["id"],))
        conn.commit()
    assert adm.reservar_proxima(ESC_A, "agente") is None
    assert _status(a["id"]) == adm.AWAITING_APPROVAL


def test_falha_na_gravacao_volta_para_aprovacao_sem_a_aprovacao_antiga(db):
    a = _ate_aprovada()
    adm.reservar_proxima(ESC_A, "agente")
    adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.FAILED, "eSocial fora do ar")
    b = adm.devolver_a_fila(a["id"], ESC_A, "dp_admin", "Conferi no Domínio: nada gravado")
    assert b["status"] == adm.AWAITING_APPROVAL
    assert b["aprovado_hash"] is None and b["decidido_por"] is None
    assert adm.reservar_proxima(ESC_A, "agente") is None
    # a conta do agente continua sem poder aprovar a própria prévia
    with pytest.raises(adm.SemPermissao):
        adm.aprovar(a["id"], ESC_A, "agente", ADMIN, b["previa_hash"])
    adm.aprovar(a["id"], ESC_A, "dp_admin", ADMIN, b["previa_hash"])
    assert adm.reservar_proxima(ESC_A, "agente")["fase"] == adm.FASE_GRAVACAO


def test_rejeicao_exige_motivo_e_encerra(db):
    a = _ate_aprovacao()
    with pytest.raises(adm.TransicaoInvalida):
        adm.rejeitar(a["id"], ESC_A, "dp_admin", ADMIN, "")
    r = adm.rejeitar(a["id"], ESC_A, "dp_admin", ADMIN, "ASO vencido")
    assert r["status"] == adm.REJECTED
    assert adm.reservar_proxima(ESC_A, "agente") is None


def test_desfazer_aprovacao_antes_do_agente_pegar(db):
    a = _ate_aprovada()
    adm.rejeitar(a["id"], ESC_A, "dp_admin", ADMIN, "Cliente desistiu")
    assert adm.reservar_proxima(ESC_A, "agente") is None


# ---------------------------------------------------------------- isolamento

def test_outro_escritorio_nao_ve_nem_decide(db):
    a = _ate_aprovacao()
    assert adm.obter(a["id"], ESC_B) is None
    assert adm.listar(ESC_B) == []
    assert adm.listar_eventos(a["id"], ESC_B) == []
    with pytest.raises(adm.AdmissaoNaoEncontrada):
        adm.aprovar(a["id"], ESC_B, "dp_admin", ADMIN, a["previa_hash"])
    with pytest.raises(adm.AdmissaoNaoEncontrada):
        adm.registrar_previa(a["id"], ESC_B, "agente_b", PREVIA)


def test_filtros_da_lista(db):
    _nova("A-1", canal="acessorias")
    _nova("O-1", canal="onvio")
    assert {l["canal"] for l in adm.listar(ESC_A, canal="onvio")} == {"onvio"}
    assert len(adm.listar(ESC_A, status=[adm.QUEUED])) == 2
    assert adm.listar(ESC_A, status=[adm.BLOCKED]) == []
    assert adm.contagem_por_status(ESC_A) == {adm.QUEUED: 2}


# ---------------------------------------------------------------- chave dos canais

def test_chave_do_canal(db):
    chave = adm.gerar_chave_canal(ESC_A, "dp_admin")
    assert adm.escritorio_da_chave(chave) == ESC_A
    assert adm.info_chave_canal(ESC_A)["prefixo"] == chave[:10]
    nova = adm.gerar_chave_canal(ESC_A, "dp_admin")
    assert adm.escritorio_da_chave(chave) is None
    assert adm.escritorio_da_chave(nova) == ESC_A
    adm.revogar_chave_canal(ESC_A)
    assert adm.escritorio_da_chave(nova) is None
    assert adm.escritorio_da_chave("") is None
    with auth.conectar() as conn:
        guardado = conn.execute("SELECT chave_hash FROM admissoes_chaves").fetchall()
    assert all(nova not in l["chave_hash"] for l in guardado)


def test_versao_do_modulo_bate_com_as_novidades():
    # a cada atualização: suba admissoes.VERSAO e registre a novidade no topo
    assert adm.NOVIDADES[0][0] == adm.VERSAO
    versoes = [tuple(int(x) for x in v.split(".")) for v, _, _ in adm.NOVIDADES]
    assert versoes == sorted(versoes, reverse=True) and len(set(versoes)) == len(versoes)


# ---------------------------------------------------------------- presas e conclusão

def _envelhecer(admissao_id, minutos):
    with auth.conectar() as conn:
        conn.execute("UPDATE admissoes SET atualizado_em = now() - make_interval(mins => %s) WHERE id = %s",
                     (minutos, admissao_id))
        conn.commit()


def test_preparo_preso_volta_sozinho_para_a_fila(db):
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    _envelhecer(a["id"], adm.PRESA_PREPARO_MIN - 1)
    assert adm.liberar_presas(ESC_A) == 0 and _status(a["id"]) == adm.CLAIMED
    _envelhecer(a["id"], adm.PRESA_PREPARO_MIN + 1)
    # a próxima reserva já libera e pega de novo
    b = adm.reservar_proxima(ESC_A, "outro-agente")
    assert b["id"] == a["id"] and b["reservado_por"] == "outro-agente"
    assert any("não respondeu" in (e["motivo"] or "") for e in adm.listar_eventos(a["id"], ESC_A))


def test_gravacao_presa_vira_bloqueada(db):
    a = _ate_aprovada()
    adm.reservar_proxima(ESC_A, "agente")
    _envelhecer(a["id"], adm.PRESA_PREPARO_MIN + 1)
    assert adm.liberar_presas(ESC_A) == 0
    _envelhecer(a["id"], adm.PRESA_GRAVACAO_MIN + 1)
    assert adm.liberar_presas(ESC_A) == 1
    b = adm.obter(a["id"], ESC_A)
    assert b["status"] == adm.BLOCKED and "Confira no Domínio" in b["motivo"]
    # não volta sozinha para gravar de novo
    assert adm.reservar_proxima(ESC_A, "agente") is None


def test_presas_de_outro_escritorio_nao_mexe(db):
    a = _nova()
    adm.reservar_proxima(ESC_A, "agente")
    _envelhecer(a["id"], 999)
    assert adm.liberar_presas(ESC_B) == 0 and _status(a["id"]) == adm.CLAIMED


def _ate_conferencia():
    a = _ate_aprovada()
    adm.reservar_proxima(ESC_A, "agente")
    return adm.atualizar_pelo_agente(a["id"], ESC_A, "agente", adm.BLOCKED, "Modo conferência: confira e salve")


def test_dp_conclui_depois_da_conferencia(db):
    a = _ate_conferencia()
    b = adm.concluir(a["id"], ESC_A, "func", auth.PAPEL_USUARIO, "matrícula 123")
    assert b["status"] == adm.COMPLETED and b["protocolo"] == "matrícula 123" and b["motivo"] is None


def test_nao_conclui_antes_da_aprovacao(db):
    a = _ate_aprovacao()
    with pytest.raises(adm.TransicaoInvalida):
        adm.concluir(a["id"], ESC_A, "dp_admin", ADMIN)
    c = _nova("AC-2")
    adm.reservar_proxima(ESC_A, "agente")
    adm.atualizar_pelo_agente(c["id"], ESC_A, "agente", adm.BLOCKED, "faltou empresa")
    with pytest.raises(adm.TransicaoInvalida):
        adm.concluir(c["id"], ESC_A, "dp_admin", ADMIN)


def test_concluida_errada_volta_para_a_fila_do_zero(db):
    a = _ate_conferencia()
    adm.concluir(a["id"], ESC_A, "dp_admin", ADMIN)
    with pytest.raises(adm.TransicaoInvalida):
        adm.reabrir(a["id"], ESC_A, "dp_admin", ADMIN, "")
    b = adm.reabrir(a["id"], ESC_A, "dp_admin", ADMIN, "cargo ficou errado")
    assert b["status"] == adm.QUEUED and b["previa"] is None and b["aprovado_hash"] is None
    assert b["fase"] is None and b["reservado_por"] is None
    # recomeça pelo preparo e precisa de nova aprovação
    assert adm.reservar_proxima(ESC_A, "agente")["fase"] == adm.FASE_PREPARO
    with pytest.raises(adm.TransicaoInvalida):
        adm.reabrir(a["id"], ESC_A, "dp_admin", ADMIN, "de novo")

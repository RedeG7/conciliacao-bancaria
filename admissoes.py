#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Admissões: solicitações de admissão de empregado vindas dos canais
(Acessórias, ONVIO, WhatsApp), fila para o agente da sessão RDS e
aprovação humana do DP antes de qualquer gravação no Domínio/eSocial.

Mesmo padrão de clientes.py / rpa/core.py: tabelas no Postgres do Hub (via
auth.conectar()), fila com SELECT ... FOR UPDATE SKIP LOCKED (sem Redis) e
tudo isolado por escritorio_id.

Ciclo de vida (coluna status):

    queued ─► claimed ─► awaiting_documents ─┐
                 │   ├─► blocked ────────────┼─► (DP devolve) ─► queued
                 │   ├─► failed ─────────────┘
                 │   └─► awaiting_approval ─► approved ─► claimed (fase gravacao) ─► completed
                 │                        └─► rejected          ├─► blocked/failed ─► (DP devolve) ─► awaiting_approval
                 └─ (fase gravacao travada) ─► (DP devolve) ─► awaiting_approval

A coluna `fase` diz o que o agente está fazendo numa tarefa `claimed`:
  - "preparo": conferir documentos e montar a PRÉVIA do cadastro, sem salvar
  - "gravacao": só depois de aprovada no Hub - salvar no Domínio e transmitir

Trava de aprovação (regra 9 da skill cadastro-empregado-dominio): o agente
só recebe uma tarefa em fase "gravacao" se ela foi aprovada por uma pessoa
no Hub, e a aprovação fica presa ao hash da prévia que essa pessoa viu
(aprovado_hash). Se a prévia mudar, a aprovação não vale. Só existe
`completed` vindo da fase gravacao com aprovado_hash == previa_hash.
Falha ou bloqueio na gravação nunca volta sozinho para a fila: a operação
não é idempotente, então o DP concilia e aprova de novo.

LGPD: a prévia (dados do empregado) fica só na coluna `previa`; eventos e
mensagens de erro nunca copiam esses dados.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from typing import Any, Optional

from psycopg.types.json import Jsonb

import auth
import clientes

CANAIS = ("acessorias", "onvio", "whatsapp")
# Versão do módulo, mostrada na tela. A cada atualização: suba VERSAO e
# acrescente a entrada no topo de NOVIDADES (o teste confere que batem).
# O programa do agente tem versão própria em attended_worker/VERSION_ADMISSOES
# (é ela que dispara a atualização automática do .exe).
VERSAO = "1.5"
NOVIDADES = [
    ("1.5", "15/11/2026", [
        "A tela de Admissões se atualiza sozinha quando uma solicitação muda de situação (confere a cada "
        "10 s) e mostra um aviso no canto da tela.",
        "Pop-up \"Admissão aguardando aprovação\" quando chega prévia para aprovar, com botão que abre a "
        "solicitação direto.",
        "Agente 1.4: preenchimento no Domínio mais calmo na sessão RDS (espera a tela responder depois de "
        "cada clique e digitação, digita mais devagar).",
        "Troca de empresa: só troca se a empresa ativa for outra; fecha as janelas abertas, usa o ícone do "
        "prédio, digita o código e clica em Acessar. Confere pelo CNPJ/razão social (apelido diferente na "
        "lista não bloqueia). Se abrir a empresa errada, refaz a rota até a certa (até 3 vezes).",
    ]),
    ("1.4", "14/11/2026", [
        "Serviço, Função, Departamento, Centro de custo e Sindicato: o agente usa o que veio no cadastro "
        "(código ou nome); sem informação, ou se não existir no Domínio, usa o código 1.",
        "Agente 1.3: toda vez que abre, consulta o Hub e, se tiver versão nova, baixa e reabre sozinho "
        "antes de mostrar a janela (mesmo nome de arquivo, atalhos continuam valendo).",
    ]),
    ("1.3", "14/11/2026", [
        "Botão \"Marcar como concluída\" depois de conferir e salvar no Domínio; concluída pode voltar para a fila.",
        "Tarefa presa \"Com o agente\" volta sozinha: preparo para a fila em 20 min; gravação vira bloqueada em 90 min.",
        "ASO deixou de ser obrigatório: sem ASO nos anexos, a prévia sai e o DP confere o ASO antes de aprovar.",
        "Contador \"Com o agente\" no topo da tela.",
        "Agente 1.2 (atualiza sozinho): ASO opcional na leitura.",
    ]),
    ("1.2", "14/11/2026", [
        "Número da versão e novidades na tela de Admissões.",
        "Versão do agente nos botões de download.",
    ]),
    ("1.1", "14/11/2026", [
        "Agente também no computador local (opção \"Onde o Domínio está\" na janela do agente).",
        "Botões para baixar o agente e passo a passo de instalação em Canais e agente.",
    ]),
    ("1.0", "14/11/2026", [
        "Módulo de Admissões no RPA Folha: fila, prévia do agente e aprovação do DP.",
        "Integração com o Acessórias e aba IA (Claude ou OpenAI); IA desligada lê o formulário do Acessórias.",
        "Atalho admissao.redeg7.com.",
    ]),
]

CANAL_ROTULO = {"acessorias": "Acessórias", "onvio": "ONVIO", "whatsapp": "WhatsApp"}

QUEUED = "queued"
CLAIMED = "claimed"
AWAITING_DOCUMENTS = "awaiting_documents"
AWAITING_APPROVAL = "awaiting_approval"
BLOCKED = "blocked"
FAILED = "failed"
APPROVED = "approved"
REJECTED = "rejected"
COMPLETED = "completed"

STATUS_ROTULO = {
    QUEUED: "Na fila",
    CLAIMED: "Com o agente",
    AWAITING_DOCUMENTS: "Aguardando documentos",
    AWAITING_APPROVAL: "Aguardando aprovação",
    BLOCKED: "Bloqueada",
    FAILED: "Falhou",
    APPROVED: "Aprovada",
    REJECTED: "Rejeitada",
    COMPLETED: "Concluída",
}

FASE_PREPARO = "preparo"
FASE_GRAVACAO = "gravacao"

# o que o agente pode informar sobre uma tarefa que ele reservou, por fase
# (awaiting_approval só por registrar_previa, que exige a prévia)
_SAIDAS_AGENTE = {
    FASE_PREPARO: {AWAITING_DOCUMENTS, BLOCKED, FAILED},
    FASE_GRAVACAO: {COMPLETED, BLOCKED, FAILED},
}
# de onde o DP pode devolver uma tarefa (claimed = agente travou/fechou)
_DEVOLVIVEIS = {AWAITING_DOCUMENTS, BLOCKED, FAILED, CLAIMED}

# reserva sem resposta do agente (programa fechado, travado, sessão caiu):
# preparo não grava nada, então volta para a fila; gravação pode ter
# deixado algo no Domínio, então vira bloqueada para o DP conferir
PRESA_PREPARO_MIN = 20
PRESA_GRAVACAO_MIN = 90

PAPEIS_APROVADORES = (auth.PAPEL_SUPER_GLOBAL, auth.PAPEL_ADMIN_ESCRITORIO)

MAX_DOCUMENTOS = 50
MAX_TEXTO = 1000
MAX_PREVIA_BYTES = 64 * 1024


class AdmissaoNaoEncontrada(LookupError):
    pass


class TransicaoInvalida(ValueError):
    pass


MOTIVO_SEM_EMPRESA = "Empresa não está no cadastro de clientes do escritório"


class SemPermissao(PermissionError):
    pass


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def garantir_schema() -> None:
    clientes.garantir_schema()
    with auth.conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admissoes (
                id SERIAL PRIMARY KEY,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                canal TEXT NOT NULL,
                id_externo TEXT NOT NULL,
                empresa_ref TEXT NOT NULL,
                cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                fase TEXT,
                motivo TEXT,
                documentos JSONB NOT NULL DEFAULT '[]'::jsonb,
                previa JSONB,
                previa_hash TEXT,
                aprovado_hash TEXT,
                reservado_por TEXT,
                reservado_em TIMESTAMPTZ,
                decidido_por TEXT,
                decidido_em TIMESTAMPTZ,
                decisao_obs TEXT,
                protocolo TEXT,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (escritorio_id, canal, id_externo)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS admissoes_fila ON admissoes (escritorio_id, status, criado_em)"
        )
        # assunto/resumo como veio do canal (ex.: assunto da solicitação no Acessórias)
        conn.execute("ALTER TABLE admissoes ADD COLUMN IF NOT EXISTS resumo TEXT")
        # nome da empresa como veio do canal (mostra quem pediu mesmo antes
        # de a empresa estar no cadastro de clientes)
        conn.execute("ALTER TABLE admissoes ADD COLUMN IF NOT EXISTS empresa_nome TEXT")
        # trilha de auditoria: toda mudança de estado, com quem e por quê.
        # Sem FK para usuarios: o registro continua valendo se a pessoa sair.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admissoes_eventos (
                id BIGSERIAL PRIMARY KEY,
                admissao_id INTEGER NOT NULL REFERENCES admissoes(id) ON DELETE CASCADE,
                de TEXT,
                para TEXT NOT NULL,
                autor TEXT NOT NULL,
                origem TEXT NOT NULL,
                motivo TEXT,
                quando TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        # chave dos canais (um por escritório): só o hash fica no banco, o
        # texto aparece uma vez na tela ao gerar
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admissoes_chaves (
                escritorio_id TEXT PRIMARY KEY REFERENCES escritorios(id),
                chave_hash TEXT NOT NULL UNIQUE,
                prefixo TEXT NOT NULL,
                criada_por TEXT NOT NULL,
                criada_em TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.commit()


# ---------------------------------------------------------------------------
# Chave dos canais
# ---------------------------------------------------------------------------

def _hash_chave(chave: str) -> str:
    return hashlib.sha256(chave.encode("utf-8")).hexdigest()


def gerar_chave_canal(escritorio_id: str, criada_por: str) -> str:
    """Gera (ou troca) a chave do escritório e devolve o texto, que não é
    guardado - a chave anterior para de funcionar na hora."""
    chave = "adm_" + secrets.token_urlsafe(32)
    with auth.conectar() as conn:
        conn.execute("""
            INSERT INTO admissoes_chaves (escritorio_id, chave_hash, prefixo, criada_por)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (escritorio_id) DO UPDATE SET
                chave_hash = EXCLUDED.chave_hash, prefixo = EXCLUDED.prefixo,
                criada_por = EXCLUDED.criada_por, criada_em = now()
        """, (escritorio_id, _hash_chave(chave), chave[:10], criada_por))
        conn.commit()
    return chave


def info_chave_canal(escritorio_id: str) -> Optional[dict]:
    with auth.conectar() as conn:
        return conn.execute(
            "SELECT prefixo, criada_por, criada_em FROM admissoes_chaves WHERE escritorio_id = %s",
            (escritorio_id,),
        ).fetchone()


def revogar_chave_canal(escritorio_id: str) -> None:
    with auth.conectar() as conn:
        conn.execute("DELETE FROM admissoes_chaves WHERE escritorio_id = %s", (escritorio_id,))
        conn.commit()


def escritorio_da_chave(chave: Optional[str]) -> Optional[str]:
    if not chave:
        return None
    with auth.conectar() as conn:
        linha = conn.execute(
            "SELECT escritorio_id FROM admissoes_chaves WHERE chave_hash = %s", (_hash_chave(chave),)
        ).fetchone()
    return linha["escritorio_id"] if linha else None


# ---------------------------------------------------------------------------
# Auxiliares
# ---------------------------------------------------------------------------

def hash_previa(previa: dict) -> str:
    """Hash estável da prévia (ordem das chaves não importa)."""
    texto = json.dumps(previa, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def _texto(valor: Optional[str]) -> str:
    return (valor or "").strip()[:MAX_TEXTO]


def _evento(conn, admissao_id: int, de: Optional[str], para: str, autor: str, origem: str,
            motivo: str = "") -> None:
    conn.execute(
        "INSERT INTO admissoes_eventos (admissao_id, de, para, autor, origem, motivo) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (admissao_id, de, para, autor, origem, _texto(motivo) or None),
    )


def _travar(conn, admissao_id: int, escritorio_id: str) -> dict:
    linha = conn.execute(
        "SELECT * FROM admissoes WHERE id = %s AND escritorio_id = %s FOR UPDATE",
        (admissao_id, escritorio_id),
    ).fetchone()
    if not linha:
        raise AdmissaoNaoEncontrada("Admissão não encontrada")
    return linha


def _cliente_por_ref(conn, escritorio_id: str, empresa_ref: str) -> Optional[dict]:
    """Empresa pelo código no Domínio ou, se a referência for um CNPJ/CPF
    (com ou sem máscara), pelo CNPJ do cadastro de clientes."""
    cliente = conn.execute(
        "SELECT id, nome FROM clientes WHERE escritorio_id = %s AND codigo_dominio = %s",
        (escritorio_id, empresa_ref),
    ).fetchone()
    digitos = clientes.so_digitos(empresa_ref)
    if not cliente and len(digitos) in (11, 14):
        cliente = conn.execute(
            "SELECT id, nome FROM clientes WHERE escritorio_id = %s AND cnpj = %s ORDER BY id LIMIT 1",
            (escritorio_id, digitos),
        ).fetchone()
    return cliente


def _limpar_documentos(documentos: Optional[list]) -> list[str]:
    limpos: list[str] = []
    for d in documentos or []:
        d = str(d).strip()[:500]
        if d and d not in limpos:
            limpos.append(d)
    if len(limpos) > MAX_DOCUMENTOS:
        raise TransicaoInvalida(f"No máximo {MAX_DOCUMENTOS} documentos por solicitação")
    return limpos


# ---------------------------------------------------------------------------
# Entrada pelos canais
# ---------------------------------------------------------------------------

def receber_solicitacao(
    escritorio_id: str, canal: str, id_externo: str, empresa_ref: str,
    documentos: Optional[list] = None, autor: str = "", resumo: str = "", empresa_nome: str = "",
) -> tuple[dict, bool]:
    """Cria a solicitação ou devolve a que já existe para canal + ID externo
    (retorna (admissao, duplicada)). Reenvio com documentos novos acrescenta
    as referências e, se ela estava aguardando documentos, volta para a fila.
    Empresa fora do cadastro de clientes do escritório entra como blocked."""
    canal = (canal or "").strip().lower()
    if canal not in CANAIS:
        raise TransicaoInvalida("Canal inválido")
    id_externo = (id_externo or "").strip()
    empresa_ref = (empresa_ref or "").strip()
    if not id_externo or len(id_externo) > 200 or not empresa_ref or len(empresa_ref) > 200:
        raise TransicaoInvalida("ID externo e empresa são obrigatórios (até 200 caracteres)")
    docs = _limpar_documentos(documentos)
    autor = autor or f"canal:{canal}"
    resumo = " ".join((resumo or "").split())[:300] or None
    empresa_nome = " ".join((empresa_nome or "").split())[:200] or None

    with auth.conectar() as conn:
        cliente = _cliente_por_ref(conn, escritorio_id, empresa_ref)
        status = QUEUED if cliente else BLOCKED
        motivo = "" if cliente else MOTIVO_SEM_EMPRESA
        nova = conn.execute("""
            INSERT INTO admissoes (escritorio_id, canal, id_externo, empresa_ref, cliente_id,
                                   status, motivo, documentos, resumo, empresa_nome)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (escritorio_id, canal, id_externo) DO NOTHING
            RETURNING *
        """, (escritorio_id, canal, id_externo, empresa_ref, cliente["id"] if cliente else None,
              status, motivo or None, Jsonb(docs), resumo, empresa_nome)).fetchone()
        if nova:
            _evento(conn, nova["id"], None, status, autor, "canal", motivo or "Solicitação recebida")
            conn.commit()
            return nova, False

        existente = conn.execute(
            "SELECT * FROM admissoes WHERE escritorio_id = %s AND canal = %s AND id_externo = %s FOR UPDATE",
            (escritorio_id, canal, id_externo),
        ).fetchone()
        if (resumo and not existente["resumo"]) or (empresa_nome and not existente["empresa_nome"]):
            existente = conn.execute(
                "UPDATE admissoes SET resumo = COALESCE(resumo, %s), empresa_nome = COALESCE(empresa_nome, %s) "
                "WHERE id = %s RETURNING *", (resumo, empresa_nome, existente["id"]),
            ).fetchone()
        novos = [d for d in docs if d not in (existente["documentos"] or [])]
        if novos:
            todos = list(existente["documentos"] or []) + novos
            if len(todos) > MAX_DOCUMENTOS:
                raise TransicaoInvalida(f"No máximo {MAX_DOCUMENTOS} documentos por solicitação")
            status_antes = existente["status"]
            novo_status = QUEUED if status_antes == AWAITING_DOCUMENTS else status_antes
            existente = conn.execute(
                "UPDATE admissoes SET documentos = %s, status = %s, "
                "motivo = CASE WHEN %s = %s THEN NULL ELSE motivo END, atualizado_em = now() "
                "WHERE id = %s RETURNING *",
                (Jsonb(todos), novo_status, novo_status, QUEUED, existente["id"]),
            ).fetchone()
            _evento(conn, existente["id"], status_antes, novo_status, autor, "canal",
                    f"{len(novos)} documento(s) novo(s) recebido(s)")
        conn.commit()
        return existente, True


# ---------------------------------------------------------------------------
# Agente (sessão RDS)
# ---------------------------------------------------------------------------

def liberar_presas(escritorio_id: str) -> int:
    """Tarefas reservadas há tempo demais sem resposta do agente (ver
    PRESA_*_MIN). Retorna quantas foram liberadas."""
    with auth.conectar() as conn:
        presas = conn.execute("""
            SELECT id, fase FROM admissoes
            WHERE escritorio_id = %s AND status = %s AND (
                (fase = %s AND atualizado_em < now() - make_interval(mins => %s)) OR
                (fase = %s AND atualizado_em < now() - make_interval(mins => %s)))
            FOR UPDATE SKIP LOCKED
        """, (escritorio_id, CLAIMED, FASE_PREPARO, PRESA_PREPARO_MIN,
              FASE_GRAVACAO, PRESA_GRAVACAO_MIN)).fetchall()
        for p in presas:
            if p["fase"] == FASE_GRAVACAO:
                motivo = (f"O agente não respondeu em {PRESA_GRAVACAO_MIN} min durante o preenchimento no Domínio. "
                          "Confira no Domínio o que ficou na tela antes de devolver.")
                conn.execute("UPDATE admissoes SET status = %s, motivo = %s, atualizado_em = now() WHERE id = %s",
                             (BLOCKED, motivo, p["id"]))
                _evento(conn, p["id"], CLAIMED, BLOCKED, "sistema", "sistema", motivo)
            else:
                motivo = f"O agente não respondeu em {PRESA_PREPARO_MIN} min - voltou para a fila"
                conn.execute("""
                    UPDATE admissoes SET status = %s, fase = NULL, reservado_por = NULL, reservado_em = NULL,
                                         motivo = NULL, atualizado_em = now()
                    WHERE id = %s
                """, (QUEUED, p["id"]))
                _evento(conn, p["id"], CLAIMED, QUEUED, "sistema", "sistema", motivo)
        conn.commit()
    return len(presas)


def reservar_proxima(escritorio_id: str, agente: str) -> Optional[dict]:
    """Reserva a próxima tarefa do escritório para o agente. Aprovadas vêm
    antes (terminar o que o DP já liberou) e entram na fase gravacao; as da
    fila entram na fase preparo. SKIP LOCKED: dois agentes nunca pegam a
    mesma tarefa. Antes, libera as reservas presas (liberar_presas)."""
    liberar_presas(escritorio_id)
    with auth.conectar() as conn:
        linha = conn.execute("""
            SELECT * FROM admissoes
            WHERE escritorio_id = %s AND status IN (%s, %s)
            ORDER BY (status = %s) DESC, criado_em, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        """, (escritorio_id, QUEUED, APPROVED, APPROVED)).fetchone()
        if not linha:
            return None
        fase = FASE_GRAVACAO if linha["status"] == APPROVED else FASE_PREPARO
        if fase == FASE_GRAVACAO and (not linha["aprovado_hash"] or linha["aprovado_hash"] != linha["previa_hash"]):
            # não deveria acontecer (aprovar() grava os dois juntos) - se
            # acontecer, a aprovação não vale e volta para o DP
            conn.execute(
                "UPDATE admissoes SET status = %s, aprovado_hash = NULL, atualizado_em = now() WHERE id = %s",
                (AWAITING_APPROVAL, linha["id"]),
            )
            _evento(conn, linha["id"], APPROVED, AWAITING_APPROVAL, "sistema", "sistema",
                    "Aprovação não confere com a prévia atual")
            conn.commit()
            return None
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, fase = %s, reservado_por = %s, reservado_em = now(),
                                 atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (CLAIMED, fase, agente, linha["id"])).fetchone()
        _evento(conn, linha["id"], QUEUED if fase == FASE_PREPARO else APPROVED, CLAIMED, agente, "agente",
                "Reservada para gravação aprovada" if fase == FASE_GRAVACAO else "Reservada para preparo")
        conn.commit()
    return linha


def empresa_da_admissao(linha: dict) -> Optional[dict]:
    """Empresa do cadastro ligada à admissão: o código no Domínio é a
    empresa que o agente ativa antes de cadastrar o empregado."""
    if not linha.get("cliente_id"):
        return None
    with auth.conectar() as conn:
        c = conn.execute(
            "SELECT nome, codigo_dominio, cnpj FROM clientes WHERE id = %s AND escritorio_id = %s",
            (linha["cliente_id"], linha["escritorio_id"]),
        ).fetchone()
    if not c:
        return None
    return {"codigo_dominio": str(c["codigo_dominio"]), "nome": c["nome"], "cnpj": c.get("cnpj") or ""}


def obter_reservada(admissao_id: int, escritorio_id: str, agente: str) -> dict:
    """A tarefa só é entregue (documentos inclusos) a quem a reservou."""
    with auth.conectar() as conn:
        linha = _travar_do_agente(conn, admissao_id, escritorio_id, agente)
        conn.rollback()
    return linha


def _travar_do_agente(conn, admissao_id: int, escritorio_id: str, agente: str) -> dict:
    linha = _travar(conn, admissao_id, escritorio_id)
    if linha["status"] != CLAIMED:
        raise TransicaoInvalida("A tarefa não está reservada")
    if linha["reservado_por"] != agente:
        raise SemPermissao("A tarefa está reservada por outro agente")
    return linha


def registrar_previa(admissao_id: int, escritorio_id: str, agente: str, previa: dict) -> dict:
    """Fase preparo: o agente entrega a prévia do cadastro (o que ele
    preencheria no Domínio, sem salvar) e a tarefa vai para o DP aprovar."""
    if not isinstance(previa, dict) or not previa:
        raise TransicaoInvalida("A prévia precisa ser um objeto com os dados do cadastro")
    if len(json.dumps(previa, ensure_ascii=False).encode("utf-8")) > MAX_PREVIA_BYTES:
        raise TransicaoInvalida("Prévia grande demais")
    with auth.conectar() as conn:
        linha = _travar_do_agente(conn, admissao_id, escritorio_id, agente)
        if linha["fase"] != FASE_PREPARO:
            raise TransicaoInvalida("A prévia não pode mudar depois de aprovada")
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, previa = %s, previa_hash = %s, aprovado_hash = NULL,
                                 decidido_por = NULL, decidido_em = NULL, decisao_obs = NULL,
                                 motivo = NULL, atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (AWAITING_APPROVAL, Jsonb(previa), hash_previa(previa), admissao_id)).fetchone()
        _evento(conn, admissao_id, CLAIMED, AWAITING_APPROVAL, agente, "agente", "Prévia enviada para conferência")
        conn.commit()
    return linha


def atualizar_pelo_agente(
    admissao_id: int, escritorio_id: str, agente: str, status: str,
    motivo: str = "", protocolo: str = "",
) -> dict:
    """Saídas da tarefa reservada. Na fase preparo: aguardando documentos,
    bloqueada ou falhou. Na fase gravacao: concluída (com protocolo),
    bloqueada ou falhou - concluir exige a aprovação ainda valendo."""
    with auth.conectar() as conn:
        linha = _travar_do_agente(conn, admissao_id, escritorio_id, agente)
        if status not in _SAIDAS_AGENTE.get(linha["fase"], set()):
            raise TransicaoInvalida(f"Estado '{status}' não permitido na fase '{linha['fase']}'")
        if status == COMPLETED:
            if not linha["decidido_por"] or not linha["aprovado_hash"] or linha["aprovado_hash"] != linha["previa_hash"]:
                raise SemPermissao("Sem aprovação registrada no Hub para esta prévia")
        if status in (BLOCKED, FAILED, AWAITING_DOCUMENTS) and not _texto(motivo):
            raise TransicaoInvalida("Informe o motivo")
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, motivo = %s, protocolo = COALESCE(%s, protocolo),
                                 atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (status, _texto(motivo) or None, _texto(protocolo)[:200] or None, admissao_id)).fetchone()
        _evento(conn, admissao_id, CLAIMED, status, agente, "agente", motivo or ("Concluída" if status == COMPLETED else ""))
        conn.commit()
    return linha


# ---------------------------------------------------------------------------
# Decisões do DP (tela do Hub)
# ---------------------------------------------------------------------------

def pode_aprovar(papel: Optional[str]) -> bool:
    return papel in PAPEIS_APROVADORES


def aprovar(admissao_id: int, escritorio_id: str, usuario: str, papel: str,
            previa_hash_vista: str, observacao: str = "") -> dict:
    """Registra a aprovação humana da prévia que a pessoa VIU na tela
    (previa_hash_vista). Quem montou a prévia (conta do agente) não aprova."""
    if not pode_aprovar(papel):
        raise SemPermissao("Só administradores do escritório aprovam admissões")
    with auth.conectar() as conn:
        linha = _travar(conn, admissao_id, escritorio_id)
        if linha["status"] != AWAITING_APPROVAL:
            raise TransicaoInvalida("A admissão não está aguardando aprovação")
        if not linha["previa_hash"] or linha["previa_hash"] != previa_hash_vista:
            raise TransicaoInvalida("A prévia mudou desde que você abriu a tela - confira de novo")
        if usuario == linha["reservado_por"]:
            raise SemPermissao("Quem preparou a prévia não pode aprová-la")
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, aprovado_hash = previa_hash, decidido_por = %s,
                                 decidido_em = now(), decisao_obs = %s, atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (APPROVED, usuario, _texto(observacao) or None, admissao_id)).fetchone()
        _evento(conn, admissao_id, AWAITING_APPROVAL, APPROVED, usuario, "usuario", observacao or "Aprovada")
        conn.commit()
    return linha


def rejeitar(admissao_id: int, escritorio_id: str, usuario: str, papel: str, motivo: str) -> dict:
    """Rejeita a prévia (ou desfaz uma aprovação que o agente ainda não pegou)."""
    if not pode_aprovar(papel):
        raise SemPermissao("Só administradores do escritório rejeitam admissões")
    if len(_texto(motivo)) < 3:
        raise TransicaoInvalida("Informe o motivo da rejeição")
    with auth.conectar() as conn:
        linha = _travar(conn, admissao_id, escritorio_id)
        if linha["status"] not in (AWAITING_APPROVAL, APPROVED):
            raise TransicaoInvalida("Só dá para rejeitar admissão aguardando aprovação ou aprovada")
        de = linha["status"]
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, aprovado_hash = NULL, decidido_por = %s, decidido_em = now(),
                                 decisao_obs = %s, atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (REJECTED, usuario, _texto(motivo), admissao_id)).fetchone()
        _evento(conn, admissao_id, de, REJECTED, usuario, "usuario", motivo)
        conn.commit()
    return linha


def devolver_a_fila(admissao_id: int, escritorio_id: str, usuario: str, motivo: str = "") -> dict:
    """DP resolveu a pendência (documento chegou, empresa cadastrada, agente
    travado). Fase preparo volta para a fila; problema na fase gravacao volta
    para aguardando aprovação, sem a aprovação antiga (precisa conciliar no
    Domínio antes de tentar de novo)."""
    with auth.conectar() as conn:
        linha = _travar(conn, admissao_id, escritorio_id)
        if linha["status"] not in _DEVOLVIVEIS:
            raise TransicaoInvalida("Esta admissão não pode voltar para a fila")
        cliente_id = linha["cliente_id"]
        if cliente_id is None:
            cliente = _cliente_por_ref(conn, escritorio_id, linha["empresa_ref"])
            if not cliente:
                raise TransicaoInvalida("Cadastre a empresa em Gerenciar Clientes antes de devolver")
            cliente_id = cliente["id"]
        if linha["fase"] == FASE_GRAVACAO:
            novo, fase = AWAITING_APPROVAL, FASE_PREPARO
        else:
            novo, fase = QUEUED, None
        de = linha["status"]
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, fase = %s, cliente_id = %s, motivo = NULL,
                                 aprovado_hash = NULL, decidido_por = NULL, decidido_em = NULL,
                                 reservado_por = CASE WHEN %s = %s THEN reservado_por ELSE NULL END,
                                 atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (novo, fase, cliente_id, novo, AWAITING_APPROVAL, admissao_id)).fetchone()
        _evento(conn, admissao_id, de, novo, usuario, "usuario", motivo or "Devolvida pelo DP")
        conn.commit()
    return linha


def concluir(admissao_id: int, escritorio_id: str, usuario: str, papel: str, observacao: str = "") -> dict:
    """O DP conferiu e salvou o cadastro no Domínio (modo conferência: o
    agente preenche e para antes de salvar). Só depois da aprovação."""
    if not pode_aprovar(papel):
        raise SemPermissao("Só administradores do escritório concluem admissões")
    with auth.conectar() as conn:
        linha = _travar(conn, admissao_id, escritorio_id)
        if linha["fase"] != FASE_GRAVACAO or linha["status"] not in (BLOCKED, FAILED):
            raise TransicaoInvalida("Só dá para concluir depois da aprovação, quando o agente devolveu a tarefa")
        de = linha["status"]
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, motivo = NULL, protocolo = COALESCE(%s, protocolo),
                                 atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (COMPLETED, _texto(observacao)[:200] or None, admissao_id)).fetchone()
        _evento(conn, admissao_id, de, COMPLETED, usuario, "usuario", observacao or "Concluída pelo DP")
        conn.commit()
    return linha


def reabrir(admissao_id: int, escritorio_id: str, usuario: str, papel: str, motivo: str) -> dict:
    """Concluída que não ficou certa: volta para a fila do zero (o agente
    monta a prévia de novo e ela passa pela aprovação outra vez)."""
    if not pode_aprovar(papel):
        raise SemPermissao("Só administradores do escritório reabrem admissões")
    if len(_texto(motivo)) < 3:
        raise TransicaoInvalida("Informe o que não ficou certo")
    with auth.conectar() as conn:
        linha = _travar(conn, admissao_id, escritorio_id)
        if linha["status"] != COMPLETED:
            raise TransicaoInvalida("Só admissão concluída pode ser reaberta")
        linha = conn.execute("""
            UPDATE admissoes SET status = %s, fase = NULL, previa = NULL, previa_hash = NULL,
                                 aprovado_hash = NULL, decidido_por = NULL, decidido_em = NULL,
                                 decisao_obs = NULL, reservado_por = NULL, reservado_em = NULL,
                                 motivo = NULL, protocolo = NULL, atualizado_em = now()
            WHERE id = %s RETURNING *
        """, (QUEUED, admissao_id)).fetchone()
        _evento(conn, admissao_id, COMPLETED, QUEUED, usuario, "usuario", motivo)
        conn.commit()
    return linha


def religar_empresas(escritorio_id: str, autor: str = "sistema") -> int:
    """Solicitações bloqueadas só por falta da empresa no cadastro: se a
    empresa já foi cadastrada (código ou CNPJ), liga e manda para a fila.
    Devolve quantas foram religadas."""
    religadas = 0
    with auth.conectar() as conn:
        pendentes = conn.execute(
            "SELECT id, empresa_ref FROM admissoes WHERE escritorio_id = %s AND status = %s "
            "AND cliente_id IS NULL AND fase IS NULL FOR UPDATE",
            (escritorio_id, BLOCKED),
        ).fetchall()
        for p in pendentes:
            cliente = _cliente_por_ref(conn, escritorio_id, p["empresa_ref"])
            if not cliente:
                continue
            conn.execute(
                "UPDATE admissoes SET cliente_id = %s, status = %s, motivo = NULL, atualizado_em = now() "
                "WHERE id = %s", (cliente["id"], QUEUED, p["id"]),
            )
            _evento(conn, p["id"], BLOCKED, QUEUED, autor, "sistema",
                    f"Empresa encontrada no cadastro: {cliente['nome']}")
            religadas += 1
        conn.commit()
    return religadas


def vincular_empresa(admissao_id: int, escritorio_id: str, cliente_id: int, usuario: str) -> dict:
    """DP escolhe a empresa do cadastro para uma solicitação que chegou sem
    empresa reconhecida (ou com a errada, antes de o agente pegar)."""
    with auth.conectar() as conn:
        linha = _travar(conn, admissao_id, escritorio_id)
        if linha["fase"] is not None or linha["status"] not in (BLOCKED, QUEUED, AWAITING_DOCUMENTS):
            raise TransicaoInvalida("A empresa só pode ser trocada antes de o agente preparar a prévia")
        cliente = conn.execute(
            "SELECT id, nome FROM clientes WHERE id = %s AND escritorio_id = %s", (cliente_id, escritorio_id),
        ).fetchone()
        if not cliente:
            raise AdmissaoNaoEncontrada("Empresa não encontrada neste escritório")
        de = linha["status"]
        novo = QUEUED if de == BLOCKED and linha["cliente_id"] is None else de
        linha = conn.execute(
            "UPDATE admissoes SET cliente_id = %s, status = %s, "
            "motivo = CASE WHEN %s <> %s THEN NULL ELSE motivo END, atualizado_em = now() "
            "WHERE id = %s RETURNING *",
            (cliente["id"], novo, novo, de, admissao_id),
        ).fetchone()
        _evento(conn, admissao_id, de, novo, usuario, "usuario", f"Empresa vinculada: {cliente['nome']}")
        conn.commit()
    return linha


def registrar_manual(escritorio_id: str, usuario: str, canal: str, id_externo: str,
                     empresa_ref: str, documentos: Optional[list] = None) -> tuple[dict, bool]:
    """Solicitação digitada pelo DP na tela (ex.: pedido que chegou pelo
    WhatsApp antes de existir o conector) - mesma regra dos canais."""
    return receber_solicitacao(escritorio_id, canal, id_externo, empresa_ref, documentos, autor=usuario)


# ---------------------------------------------------------------------------
# Consultas (tela)
# ---------------------------------------------------------------------------

def listar(escritorio_id: str, status: Optional[list] = None, canal: Optional[str] = None,
           cliente_id: Optional[int] = None, limite: int = 500) -> list[dict]:
    filtros = ["a.escritorio_id = %s"]
    params: list[Any] = [escritorio_id]
    if status:
        filtros.append("a.status = ANY(%s)")
        params.append(list(status))
    if canal:
        filtros.append("a.canal = %s")
        params.append(canal)
    if cliente_id:
        filtros.append("a.cliente_id = %s")
        params.append(cliente_id)
    params.append(limite)
    with auth.conectar() as conn:
        return conn.execute(f"""
            SELECT a.id, a.canal, a.id_externo, a.empresa_ref, a.cliente_id, c.nome AS cliente_nome,
                   a.status, a.fase, a.motivo, a.resumo, a.empresa_nome, a.criado_em, a.atualizado_em, a.decidido_por,
                   a.protocolo
            FROM admissoes a LEFT JOIN clientes c ON c.id = a.cliente_id
            WHERE {' AND '.join(filtros)}
            ORDER BY a.atualizado_em DESC
            LIMIT %s
        """, params).fetchall()


def obter(admissao_id: int, escritorio_id: str) -> Optional[dict]:
    with auth.conectar() as conn:
        return conn.execute("""
            SELECT a.*, c.nome AS cliente_nome
            FROM admissoes a LEFT JOIN clientes c ON c.id = a.cliente_id
            WHERE a.id = %s AND a.escritorio_id = %s
        """, (admissao_id, escritorio_id)).fetchone()


def obter_por_externo(escritorio_id: str, canal: str, id_externo: str) -> Optional[dict]:
    with auth.conectar() as conn:
        return conn.execute(
            "SELECT * FROM admissoes WHERE escritorio_id = %s AND canal = %s AND id_externo = %s",
            (escritorio_id, canal, id_externo),
        ).fetchone()


def listar_eventos(admissao_id: int, escritorio_id: str) -> list[dict]:
    with auth.conectar() as conn:
        return conn.execute("""
            SELECT e.* FROM admissoes_eventos e JOIN admissoes a ON a.id = e.admissao_id
            WHERE e.admissao_id = %s AND a.escritorio_id = %s ORDER BY e.quando, e.id
        """, (admissao_id, escritorio_id)).fetchall()


def contagem_por_status(escritorio_id: str) -> dict:
    with auth.conectar() as conn:
        linhas = conn.execute(
            "SELECT status, count(*) AS n FROM admissoes WHERE escritorio_id = %s GROUP BY status",
            (escritorio_id,),
        ).fetchall()
    return {l["status"]: l["n"] for l in linhas}

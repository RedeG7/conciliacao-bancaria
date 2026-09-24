#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Autenticacao multi-escritorio (usuario/senha) para o app de conciliacao
bancaria - varios escritorios de contabilidade podem usar o mesmo app ao
mesmo tempo, cada um enxergando so os proprios usuarios.

Backend: PostgreSQL (via psycopg). A string de conexao vem da env var
DATABASE_URL (ex.: postgresql://usuario:senha@db:5432/conciliacao).
Usar um banco de verdade (em vez de JSON em disco) evita corrida de
escrita: duas acoes administrativas simultaneas (ex.: dois admins de
escritorios diferentes criando usuario ao mesmo tempo) nao se pisam,
porque cada operacao e uma transacao atomica no Postgres, e as operacoes
protegidas (impedir remover o ultimo admin) travam a linha do escritorio
com SELECT ... FOR UPDATE antes de decidir.

Senha SEMPRE em hash (PBKDF2-HMAC-SHA256 + salt aleatorio), nunca em texto
puro. Nomes de usuario sao unicos globalmente (login simples, sem precisar
escolher o escritorio na tela) - o escritorio de cada um fica gravado no
proprio cadastro (FK para escritorios, com integridade referencial).

Papeis (do mais amplo ao mais restrito):
  - super_admin_global: enxerga e gerencia TODOS os escritorios e usuarios
    (e quem cria novos escritorios). E o papel do dono/operador do app
    (RedeG7), nao de um escritorio-cliente especifico.
  - admin_escritorio: gerencia (cria/redefine senha/remove) somente os
    usuarios do PROPRIO escritorio - e o "super usuario" que cada escritorio
    tem para resetar a senha de quem esqueceu, sem depender do global.
  - usuario: uso normal, so pode trocar a propria senha.

No primeiro uso (tabelas vazias), `garantir_bootstrap` cria o escritorio
"redeg7" e o usuario padrao "admin" / "admin123" (super_admin_global, com
troca de senha obrigatoria no primeiro login).
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
from typing import Dict, Optional

import psycopg
from psycopg.rows import dict_row

ITERACOES_PBKDF2 = 200_000

DEFAULT_ADMIN_USER = "admin"
DEFAULT_ADMIN_SENHA = "admin123"
DEFAULT_ESCRITORIO_ID = "redeg7"
DEFAULT_ESCRITORIO_NOME = "RedeG7 Soluções em TI"

PAPEL_SUPER_GLOBAL = "super_admin_global"
PAPEL_ADMIN_ESCRITORIO = "admin_escritorio"
PAPEL_USUARIO = "usuario"


# ---------------------------------------------------------------------------
# Conexao
# ---------------------------------------------------------------------------

def _conectar() -> psycopg.Connection:
    """Uma conexao nova por chamada - app de baixo trafego (acoes
    administrativas esporadicas), entao nao vale a pena manter um pool."""
    dsn = os.environ["DATABASE_URL"]
    return psycopg.connect(dsn, row_factory=dict_row)


def conectar() -> psycopg.Connection:
    """Wrapper publico de _conectar() para os demais modulos do app
    (clientes.py, historico.py) reaproveitarem a mesma conexao/DSN sem
    acessar o "privado" diretamente."""
    return _conectar()


def garantir_schema() -> None:
    with _conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS escritorios (
                id TEXT PRIMARY KEY,
                nome TEXT NOT NULL,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                usuario TEXT PRIMARY KEY,
                nome TEXT NOT NULL,
                papel TEXT NOT NULL,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                salt TEXT NOT NULL,
                hash TEXT NOT NULL,
                deve_trocar_senha BOOLEAN NOT NULL DEFAULT false,
                ativo BOOLEAN NOT NULL DEFAULT true
            )
        """)
        # apps_permitidos: lista de ids de app (ver _APPS_HOME em
        # app_conciliacao.py) que o escritorio/usuario pode ver na tela
        # inicial - NULL ou vazio significa "todos" (sem restricao), pra
        # nao quebrar escritorios/usuarios ja cadastrados antes dessa
        # funcionalidade existir. Escritorio limita o teto; usuario refina
        # dentro do que o proprio escritorio ja permite (seguranca em duas
        # camadas, ver _apps_permitidos_efetivos em app_conciliacao.py).
        conn.execute("ALTER TABLE escritorios ADD COLUMN IF NOT EXISTS apps_permitidos TEXT[]")
        conn.execute("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS apps_permitidos TEXT[]")
        # pasta_raiz_local: caminho no PC de quem roda o fluxo attended (ver
        # attended_worker/) onde os PDFs/XMLs baixados manualmente/attended
        # sao organizados em {pasta_raiz}/{codigo}/{competencia}/ - so faz
        # sentido pra quem roda o script localmente, nao e usado pelo worker
        # em nuvem (esse guarda no banco, nao em disco).
        conn.execute("ALTER TABLE escritorios ADD COLUMN IF NOT EXISTS pasta_raiz_local TEXT")
        # issnet_attended_liberado: licenca de uso do script local attended
        # (attended_worker/issnet_attended.py) - super_admin_global pode
        # bloquear a qualquer momento (ex.: escritorio parou de pagar,
        # uso indevido) sem precisar revogar credencial nenhuma. Default
        # TRUE pra nao quebrar quem ja estava usando antes dessa coluna
        # existir.
        conn.execute(
            "ALTER TABLE escritorios ADD COLUMN IF NOT EXISTS issnet_attended_liberado BOOLEAN NOT NULL DEFAULT true"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessoes (
                token TEXT PRIMARY KEY,
                usuario TEXT NOT NULL REFERENCES usuarios(usuario) ON DELETE CASCADE,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                expira_em TIMESTAMPTZ NOT NULL
            )
        """)


# ---------------------------------------------------------------------------
# Hash de senha
# ---------------------------------------------------------------------------

def _hash_senha(senha: str, salt_hex: Optional[str] = None) -> Dict[str, str]:
    if salt_hex is None:
        salt_hex = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", senha.encode("utf-8"), bytes.fromhex(salt_hex), ITERACOES_PBKDF2
    )
    return {"salt": salt_hex, "hash": dk.hex()}


def _verificar_senha(senha: str, salt_hex: str, hash_armazenado: str) -> bool:
    dk = hashlib.pbkdf2_hmac(
        "sha256", senha.encode("utf-8"), bytes.fromhex(salt_hex), ITERACOES_PBKDF2
    )
    return secrets.compare_digest(dk.hex(), hash_armazenado)


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugificar(texto: str) -> str:
    """Vira um id de escritorio simples: minusculas, sem acento/espacos."""
    import unicodedata
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")
    return _SLUG_RE.sub("-", sem_acento.lower()).strip("-") or "escritorio"


# ---------------------------------------------------------------------------
# Bootstrap (primeiro uso)
# ---------------------------------------------------------------------------

def garantir_bootstrap() -> None:
    """Garante que a tabela exista e que sempre haja pelo menos um
    super_admin_global e o escritorio dele. Se ninguem com esse papel
    existir ainda (primeiro uso, ou se todos foram removidos por engano),
    cria/recria o escritorio "redeg7" e o usuario padrao admin/admin123
    com troca de senha obrigatoria no proximo login."""
    garantir_schema()
    with _conectar() as conn:
        conn.execute(
            "INSERT INTO escritorios (id, nome) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
            (DEFAULT_ESCRITORIO_ID, DEFAULT_ESCRITORIO_NOME),
        )
        tem_global = conn.execute(
            "SELECT 1 FROM usuarios WHERE papel = %s LIMIT 1", (PAPEL_SUPER_GLOBAL,)
        ).fetchone()
        if not tem_global:
            h = _hash_senha(DEFAULT_ADMIN_SENHA)
            conn.execute(
                """INSERT INTO usuarios
                       (usuario, nome, papel, escritorio_id, salt, hash, deve_trocar_senha, ativo)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (usuario) DO NOTHING""",
                (DEFAULT_ADMIN_USER, "Administrador", PAPEL_SUPER_GLOBAL, DEFAULT_ESCRITORIO_ID,
                 h["salt"], h["hash"], True, True),
            )
        conn.commit()


# ---------------------------------------------------------------------------
# Autenticacao
# ---------------------------------------------------------------------------

def autenticar(usuario: str, senha: str) -> Optional[dict]:
    """Retorna os dados do usuario se a senha bater, senao None."""
    with _conectar() as conn:
        dados = conn.execute(
            "SELECT * FROM usuarios WHERE usuario = %s", (usuario,)
        ).fetchone()
    if not dados or not _verificar_senha(senha, dados["salt"], dados["hash"]):
        return None
    return dados


def usuario_esta_ativo(dados: dict) -> bool:
    return bool(dados.get("ativo", True))


# ---------------------------------------------------------------------------
# Sessao persistente (cookie) - so pra nao pedir login de novo quando o
# usuario da F5/atualiza a pagina (que abre uma conexao/sessao Streamlit
# nova, perdendo o st.session_state). O token fica num cookie no navegador
# e, server-side, associado ao usuario com prazo de validade - nunca guarda
# a senha nem nada alem do nome do usuario. Revogavel a qualquer momento
# (logout apaga o registro; nao fica "logado pra sempre" sem controle).
# ---------------------------------------------------------------------------

DURACAO_SESSAO_DIAS = 30


def criar_sessao(usuario: str) -> str:
    """Cria uma sessao persistente nova pro usuario e devolve o token (pra
    gravar no cookie do navegador). De quebra, limpa sessoes ja vencidas -
    nao precisa de um job separado so pra isso num app de baixo trafego."""
    token = secrets.token_urlsafe(32)
    with _conectar() as conn:
        conn.execute("DELETE FROM sessoes WHERE expira_em < now()")
        conn.execute(
            "INSERT INTO sessoes (token, usuario, expira_em) VALUES (%s, %s, now() + %s * interval '1 day')",
            (token, usuario, DURACAO_SESSAO_DIAS),
        )
        conn.commit()
    return token


def validar_sessao(token: str) -> Optional[dict]:
    """Devolve os dados do usuario dono do token, se a sessao existir, nao
    tiver vencido, e o usuario continuar ativo - senao None (cookie invalido
    ou vencido simplesmente nao autentica, sem erro pro usuario)."""
    if not token:
        return None
    with _conectar() as conn:
        dados = conn.execute(
            """SELECT u.* FROM sessoes s JOIN usuarios u ON u.usuario = s.usuario
               WHERE s.token = %s AND s.expira_em > now()""",
            (token,),
        ).fetchone()
    if not dados or not usuario_esta_ativo(dados):
        return None
    return dados


def remover_sessao(token: str) -> None:
    """Revoga uma sessao persistente (logout) - o cookie no navegador
    tambem precisa ser apagado separadamente pelo chamador."""
    if not token:
        return
    with _conectar() as conn:
        conn.execute("DELETE FROM sessoes WHERE token = %s", (token,))
        conn.commit()


# ---------------------------------------------------------------------------
# Leitura (para telas de administracao)
# ---------------------------------------------------------------------------

def carregar_usuarios() -> Dict[str, dict]:
    with _conectar() as conn:
        linhas = conn.execute("SELECT * FROM usuarios").fetchall()
    return {l["usuario"]: l for l in linhas}


def carregar_escritorios() -> Dict[str, dict]:
    with _conectar() as conn:
        linhas = conn.execute("SELECT * FROM escritorios").fetchall()
    return {
        l["id"]: {
            "nome": l["nome"], "criado_em": l["criado_em"].isoformat(),
            "apps_permitidos": l.get("apps_permitidos") or [],
            "pasta_raiz_local": l.get("pasta_raiz_local") or "",
            "issnet_attended_liberado": l.get("issnet_attended_liberado", True),
        }
        for l in linhas
    }


def usuarios_do_escritorio(usuarios: Dict[str, dict], escritorio_id: str) -> Dict[str, dict]:
    return {u: d for u, d in usuarios.items() if d.get("escritorio_id") == escritorio_id}


# ---------------------------------------------------------------------------
# Escritorios (tenants)
# ---------------------------------------------------------------------------

def criar_escritorio(nome: str, escritorio_id: Optional[str] = None) -> str:
    """Cria um escritorio novo. Retorna o id efetivo (gera um slug a partir
    do nome se nenhum id explicito for informado; garante que seja unico)."""
    base = slugificar(escritorio_id or nome)
    with _conectar() as conn:
        eid = base
        i = 2
        while True:
            existe = conn.execute("SELECT 1 FROM escritorios WHERE id = %s", (eid,)).fetchone()
            if not existe:
                break
            eid = f"{base}-{i}"
            i += 1
        conn.execute(
            "INSERT INTO escritorios (id, nome) VALUES (%s, %s)", (eid, nome)
        )
        conn.commit()
    return eid


def renomear_escritorio(escritorio_id: str, novo_nome: str) -> bool:
    with _conectar() as conn:
        cur = conn.execute(
            "UPDATE escritorios SET nome = %s WHERE id = %s", (novo_nome, escritorio_id)
        )
        ok = cur.rowcount > 0
        conn.commit()
    return ok


def remover_escritorio(escritorio_id: str, forcar: bool = False) -> "tuple[bool, str]":
    """Remove um escritorio inteiro. Por padrao recusa se ainda houver
    usuarios cadastrados nele (o operador precisa mover/remover primeiro);
    com forcar=True remove o escritorio E todos os seus usuarios de uma vez
    so - EXCETO se isso apagar o ultimo super_admin_global de todo o app,
    ou se for o escritorio padrao (dono do app, nunca removido). A
    contagem e feita dentro de uma transacao com a linha do escritorio
    travada (FOR UPDATE), para duas remocoes concorrentes do mesmo
    escritorio nao passarem as duas pela checagem."""
    if escritorio_id == DEFAULT_ESCRITORIO_ID:
        return False, "Este é o escritório padrão do sistema e não pode ser excluído."

    with _conectar() as conn:
        with conn.transaction():
            existe = conn.execute(
                "SELECT 1 FROM escritorios WHERE id = %s FOR UPDATE", (escritorio_id,)
            ).fetchone()
            if not existe:
                return False, "Escritório não encontrado."

            usuarios_do = conn.execute(
                "SELECT * FROM usuarios WHERE escritorio_id = %s", (escritorio_id,)
            ).fetchall()

            if usuarios_do and not forcar:
                return False, (
                    f"Este escritório ainda tem {len(usuarios_do)} usuário(s) cadastrado(s) - "
                    "remova-os antes ou marque a opção de excluir junto."
                )

            if usuarios_do and forcar:
                globais_dentro = sum(1 for u in usuarios_do if u["papel"] == PAPEL_SUPER_GLOBAL)
                if globais_dentro:
                    globais_fora = conn.execute(
                        "SELECT COUNT(*) AS n FROM usuarios WHERE papel = %s AND escritorio_id <> %s",
                        (PAPEL_SUPER_GLOBAL, escritorio_id),
                    ).fetchone()["n"]
                    if globais_fora == 0:
                        return False, "Excluir esse escritório apagaria o último super_admin_global do sistema - impedido."
                conn.execute("DELETE FROM usuarios WHERE escritorio_id = %s", (escritorio_id,))

            conn.execute("DELETE FROM escritorios WHERE id = %s", (escritorio_id,))

    return True, "Escritório removido."


# ---------------------------------------------------------------------------
# Gestao de usuarios
# ---------------------------------------------------------------------------

def criar_ou_atualizar_usuario(
    usuario: str,
    senha: str,
    escritorio_id: str,
    papel: str = PAPEL_USUARIO,
    nome: str = "",
    deve_trocar_senha: bool = False,
) -> None:
    """Cria um usuario novo ou substitui a senha/papel/escritorio de um
    existente - usado tanto para cadastrar quanto para um admin redefinir
    a senha de alguem (ex.: usuario esqueceu a propria senha). Preserva o
    status ativo/inativo de quem ja existia - redefinir senha nao reativa
    sozinho um usuario que foi inativado de proposito."""
    h = _hash_senha(senha)
    with _conectar() as conn:
        conn.execute(
            """INSERT INTO usuarios (usuario, nome, papel, escritorio_id, salt, hash, deve_trocar_senha, ativo)
               VALUES (%s, %s, %s, %s, %s, %s, %s, true)
               ON CONFLICT (usuario) DO UPDATE SET
                   nome = EXCLUDED.nome,
                   papel = EXCLUDED.papel,
                   escritorio_id = EXCLUDED.escritorio_id,
                   salt = EXCLUDED.salt,
                   hash = EXCLUDED.hash,
                   deve_trocar_senha = EXCLUDED.deve_trocar_senha""",
            (usuario, nome or usuario, papel, escritorio_id, h["salt"], h["hash"], deve_trocar_senha),
        )
        conn.commit()


def redefinir_senha(usuario: str, nova_senha: str, forcar_troca: bool = False) -> bool:
    h = _hash_senha(nova_senha)
    with _conectar() as conn:
        cur = conn.execute(
            "UPDATE usuarios SET salt = %s, hash = %s, deve_trocar_senha = %s WHERE usuario = %s",
            (h["salt"], h["hash"], forcar_troca, usuario),
        )
        ok = cur.rowcount > 0
        conn.commit()
    return ok


def remover_usuario(usuario: str) -> bool:
    """Remove um usuario - nunca remove o ultimo super_admin_global do app
    nem o ultimo admin_escritorio de um escritorio, para nao trancar
    ninguem para fora sem alguem capaz de gerenciar o acesso. A checagem
    trava a linha do proprio usuario (FOR UPDATE) para serializar remocoes
    concorrentes."""
    with _conectar() as conn:
        with conn.transaction():
            dados = conn.execute(
                "SELECT * FROM usuarios WHERE usuario = %s FOR UPDATE", (usuario,)
            ).fetchone()
            if not dados:
                return False

            papel = dados["papel"]
            if papel == PAPEL_SUPER_GLOBAL:
                qtd = conn.execute(
                    "SELECT COUNT(*) AS n FROM usuarios WHERE papel = %s", (PAPEL_SUPER_GLOBAL,)
                ).fetchone()["n"]
                if qtd <= 1:
                    return False
            elif papel == PAPEL_ADMIN_ESCRITORIO:
                qtd = conn.execute(
                    """SELECT COUNT(*) AS n FROM usuarios
                       WHERE papel IN (%s, %s) AND escritorio_id = %s""",
                    (PAPEL_ADMIN_ESCRITORIO, PAPEL_SUPER_GLOBAL, dados["escritorio_id"]),
                ).fetchone()["n"]
                if qtd <= 1:
                    return False

            conn.execute("DELETE FROM usuarios WHERE usuario = %s", (usuario,))

    return True


def definir_status_usuario(usuario: str, ativo: bool) -> "tuple[bool, str]":
    """Ativa ou inativa um usuario - nao apaga o cadastro, so bloqueia o
    login dele. Ao inativar, nunca esvazia o ultimo super_admin_global
    ativo do app nem o ultimo admin_escritorio ativo de um escritorio.
    Mesma protecao via lock de linha que `remover_usuario`."""
    with _conectar() as conn:
        with conn.transaction():
            dados = conn.execute(
                "SELECT * FROM usuarios WHERE usuario = %s FOR UPDATE", (usuario,)
            ).fetchone()
            if not dados:
                return False, "Usuário não encontrado."

            if not ativo:
                papel = dados["papel"]
                if papel == PAPEL_SUPER_GLOBAL:
                    qtd = conn.execute(
                        "SELECT COUNT(*) AS n FROM usuarios WHERE papel = %s AND ativo AND usuario <> %s",
                        (PAPEL_SUPER_GLOBAL, usuario),
                    ).fetchone()["n"]
                    if qtd == 0:
                        return False, "Não é possível inativar: é o último super_admin_global ativo do sistema."
                elif papel == PAPEL_ADMIN_ESCRITORIO:
                    qtd = conn.execute(
                        """SELECT COUNT(*) AS n FROM usuarios
                           WHERE papel IN (%s, %s) AND escritorio_id = %s AND ativo AND usuario <> %s""",
                        (PAPEL_ADMIN_ESCRITORIO, PAPEL_SUPER_GLOBAL, dados["escritorio_id"], usuario),
                    ).fetchone()["n"]
                    if qtd == 0:
                        return False, "Não é possível inativar: é o último admin ativo deste escritório."

            conn.execute("UPDATE usuarios SET ativo = %s WHERE usuario = %s", (ativo, usuario))

    return True, ("Usuário ativado." if ativo else "Usuário inativado.")


# ---------------------------------------------------------------------------
# Permissao de apps (quais telas o escritorio/usuario ve na tela inicial)
# ---------------------------------------------------------------------------

def definir_apps_escritorio(escritorio_id: str, apps: list) -> None:
    """apps vazio grava NULL (equivale a "todos", ver garantir_schema)."""
    with _conectar() as conn:
        conn.execute(
            "UPDATE escritorios SET apps_permitidos = %s WHERE id = %s",
            (apps or None, escritorio_id),
        )
        conn.commit()


def definir_apps_usuario(usuario: str, apps: list) -> None:
    """apps vazio grava NULL (equivale a "herda do escritorio", ver
    garantir_schema)."""
    with _conectar() as conn:
        conn.execute(
            "UPDATE usuarios SET apps_permitidos = %s WHERE usuario = %s",
            (apps or None, usuario),
        )
        conn.commit()


def definir_pasta_raiz_local(escritorio_id: str, pasta: str) -> None:
    """Caminho no PC de quem roda o fluxo attended (ver attended_worker/)
    onde os arquivos baixados manualmente/attended sao organizados em
    {pasta_raiz}/{codigo}/{competencia}/."""
    with _conectar() as conn:
        conn.execute(
            "UPDATE escritorios SET pasta_raiz_local = %s WHERE id = %s",
            (pasta.strip() or None, escritorio_id),
        )
        conn.commit()


def definir_issnet_attended_liberado(escritorio_id: str, liberado: bool) -> None:
    """Liga/desliga a licenca de uso do script local attended (ver
    attended_worker/issnet_attended.py) - o script confere isso antes de
    processar qualquer coisa."""
    with _conectar() as conn:
        conn.execute(
            "UPDATE escritorios SET issnet_attended_liberado = %s WHERE id = %s",
            (liberado, escritorio_id),
        )
        conn.commit()

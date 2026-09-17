#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Autenticacao multi-escritorio (usuario/senha) para o app de conciliacao
bancaria - varios escritorios de contabilidade podem usar o mesmo app ao
mesmo tempo, cada um enxergando so os proprios usuarios.

Dois arquivos JSON locais (por padrao ao lado deste modulo):
  - escritorios.json: {escritorio_id: {nome, criado_em}}
  - usuarios.json:    {usuario: {nome, papel, escritorio_id, salt, hash,
                                  deve_trocar_senha}}

Senha SEMPRE em hash (PBKDF2-HMAC-SHA256 + salt aleatorio), nunca em texto
puro. Nomes de usuario sao unicos globalmente (login simples, sem precisar
escolher o escritorio na tela) - o escritorio de cada um fica gravado no
proprio cadastro.

Papeis (do mais amplo ao mais restrito):
  - super_admin_global: enxerga e gerencia TODOS os escritorios e usuarios
    (e quem cria novos escritorios). E o papel do dono/operador do app
    (RedeG7), nao de um escritorio-cliente especifico.
  - admin_escritorio: gerencia (cria/redefine senha/remove) somente os
    usuarios do PROPRIO escritorio - e o "super usuario" que cada escritorio
    tem para resetar a senha de quem esqueceu, sem depender do global.
  - usuario: uso normal, so pode trocar a propria senha.

No primeiro uso (nenhum arquivo ainda existe), `garantir_bootstrap` cria o
escritorio "redeg7" e o usuario padrao "admin" / "admin123"
(super_admin_global, com troca de senha obrigatoria no primeiro login).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import secrets
from pathlib import Path
from typing import Dict, Optional

ITERACOES_PBKDF2 = 200_000

DEFAULT_ADMIN_USER = "admin"
DEFAULT_ADMIN_SENHA = "admin123"
DEFAULT_ESCRITORIO_ID = "redeg7"
DEFAULT_ESCRITORIO_NOME = "RedeG7 Soluções em TI"

PAPEL_SUPER_GLOBAL = "super_admin_global"
PAPEL_ADMIN_ESCRITORIO = "admin_escritorio"
PAPEL_USUARIO = "usuario"


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


# ---------------------------------------------------------------------------
# Persistencia (JSON local)
# ---------------------------------------------------------------------------

def _carregar_json(path: Path) -> Dict[str, dict]:
    if not Path(path).exists():
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _salvar_json(path: Path, dados: Dict[str, dict]) -> None:
    path = Path(path)
    path.write_text(json.dumps(dados, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        os.chmod(path, 0o600)  # so o dono do arquivo le/escreve, quando o SO suporta
    except OSError:
        pass


def carregar_usuarios(path: Path) -> Dict[str, dict]:
    return _carregar_json(path)


def salvar_usuarios(path: Path, usuarios: Dict[str, dict]) -> None:
    _salvar_json(path, usuarios)


def carregar_escritorios(path: Path) -> Dict[str, dict]:
    return _carregar_json(path)


def salvar_escritorios(path: Path, escritorios: Dict[str, dict]) -> None:
    _salvar_json(path, escritorios)


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugificar(texto: str) -> str:
    """Vira um id de escritorio simples: minusculas, sem acento/espacos."""
    import unicodedata
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")
    return _SLUG_RE.sub("-", sem_acento.lower()).strip("-") or "escritorio"


# ---------------------------------------------------------------------------
# Bootstrap (primeiro uso)
# ---------------------------------------------------------------------------

def garantir_bootstrap(usuarios_path: Path, escritorios_path: Path) -> Dict[str, dict]:
    """Garante que sempre exista pelo menos um super_admin_global e o
    escritorio dele. Se ninguem com esse papel existir ainda (primeiro uso,
    ou se todos foram removidos por engano), cria/recria o escritorio
    "redeg7" e o usuario padrao admin/admin123 com troca de senha
    obrigatoria no proximo login."""
    escritorios = carregar_escritorios(escritorios_path)
    if DEFAULT_ESCRITORIO_ID not in escritorios:
        escritorios[DEFAULT_ESCRITORIO_ID] = {
            "nome": DEFAULT_ESCRITORIO_NOME,
            "criado_em": dt.datetime.now().isoformat(timespec="seconds"),
        }
        salvar_escritorios(escritorios_path, escritorios)

    usuarios = carregar_usuarios(usuarios_path)
    if not any(u.get("papel") == PAPEL_SUPER_GLOBAL for u in usuarios.values()):
        h = _hash_senha(DEFAULT_ADMIN_SENHA)
        usuarios[DEFAULT_ADMIN_USER] = {
            "nome": "Administrador",
            "papel": PAPEL_SUPER_GLOBAL,
            "escritorio_id": DEFAULT_ESCRITORIO_ID,
            "salt": h["salt"],
            "hash": h["hash"],
            "deve_trocar_senha": True,
            "ativo": True,
        }
        salvar_usuarios(usuarios_path, usuarios)
    return usuarios


# ---------------------------------------------------------------------------
# Autenticacao
# ---------------------------------------------------------------------------

def autenticar(usuarios: Dict[str, dict], usuario: str, senha: str) -> bool:
    dados = usuarios.get(usuario)
    if not dados:
        return False
    return _verificar_senha(senha, dados["salt"], dados["hash"])


# ---------------------------------------------------------------------------
# Escritorios (tenants)
# ---------------------------------------------------------------------------

def criar_escritorio(path: Path, nome: str, escritorio_id: Optional[str] = None) -> str:
    """Cria um escritorio novo. Retorna o id efetivo (gera um slug a partir
    do nome se nenhum id explicito for informado; garante que seja unico)."""
    escritorios = carregar_escritorios(path)
    base = slugificar(escritorio_id or nome)
    eid = base
    i = 2
    while eid in escritorios:
        eid = f"{base}-{i}"
        i += 1
    escritorios[eid] = {"nome": nome, "criado_em": dt.datetime.now().isoformat(timespec="seconds")}
    salvar_escritorios(path, escritorios)
    return eid


def usuarios_do_escritorio(usuarios: Dict[str, dict], escritorio_id: str) -> Dict[str, dict]:
    return {u: d for u, d in usuarios.items() if d.get("escritorio_id") == escritorio_id}


def renomear_escritorio(path: Path, escritorio_id: str, novo_nome: str) -> bool:
    escritorios = carregar_escritorios(path)
    if escritorio_id not in escritorios:
        return False
    escritorios[escritorio_id]["nome"] = novo_nome
    salvar_escritorios(path, escritorios)
    return True


def remover_escritorio(
    escritorios_path: Path, usuarios_path: Path, escritorio_id: str, forcar: bool = False
) -> "tuple[bool, str]":
    """Remove um escritorio inteiro. Por padrao recusa se ainda houver
    usuarios cadastrados nele (o operador precisa mover/remover primeiro);
    com forcar=True remove o escritorio E todos os seus usuarios de uma vez
    so - EXCETO se isso apagar o ultimo super_admin_global de todo o app,
    ou se for o escritorio padrao (dono do app, nunca removido). Retorna
    (sucesso, mensagem)."""
    if escritorio_id == DEFAULT_ESCRITORIO_ID:
        return False, "Este é o escritório padrão do sistema e não pode ser excluído."

    escritorios = carregar_escritorios(escritorios_path)
    if escritorio_id not in escritorios:
        return False, "Escritório não encontrado."

    usuarios = carregar_usuarios(usuarios_path)
    do_escritorio = usuarios_do_escritorio(usuarios, escritorio_id)

    if do_escritorio and not forcar:
        return False, (
            f"Este escritório ainda tem {len(do_escritorio)} usuário(s) cadastrado(s) - "
            "remova-os antes ou marque a opção de excluir junto."
        )

    if do_escritorio and forcar:
        globais_dentro = sum(1 for u in do_escritorio.values() if u.get("papel") == PAPEL_SUPER_GLOBAL)
        globais_fora = sum(
            1 for uname, u in usuarios.items()
            if u.get("papel") == PAPEL_SUPER_GLOBAL and uname not in do_escritorio
        )
        if globais_dentro and globais_fora == 0:
            return False, "Excluir esse escritório apagaria o último super_admin_global do sistema - impedido."
        for uname in list(do_escritorio):
            del usuarios[uname]
        salvar_usuarios(usuarios_path, usuarios)

    del escritorios[escritorio_id]
    salvar_escritorios(escritorios_path, escritorios)
    return True, "Escritório removido."


# ---------------------------------------------------------------------------
# Gestao de usuarios
# ---------------------------------------------------------------------------

def criar_ou_atualizar_usuario(
    path: Path,
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
    usuarios = carregar_usuarios(path)
    h = _hash_senha(senha)
    ativo_anterior = usuarios.get(usuario, {}).get("ativo", True)
    usuarios[usuario] = {
        "nome": nome or usuario,
        "papel": papel,
        "escritorio_id": escritorio_id,
        "salt": h["salt"],
        "hash": h["hash"],
        "deve_trocar_senha": deve_trocar_senha,
        "ativo": ativo_anterior,
    }
    salvar_usuarios(path, usuarios)


def usuario_esta_ativo(dados: dict) -> bool:
    return bool(dados.get("ativo", True))


def definir_status_usuario(path: Path, usuario: str, ativo: bool) -> "tuple[bool, str]":
    """Ativa ou inativa um usuario - nao apaga o cadastro, so bloqueia o
    login dele. Ao inativar, nunca esvazia o ultimo super_admin_global
    ativo do app nem o ultimo admin_escritorio ativo de um escritorio (a
    mesma logica de protecao de `remover_usuario`, mas contando so quem
    esta ativo). Retorna (sucesso, mensagem)."""
    usuarios = carregar_usuarios(path)
    if usuario not in usuarios:
        return False, "Usuário não encontrado."
    dados = usuarios[usuario]

    if not ativo:
        papel = dados.get("papel")
        if papel == PAPEL_SUPER_GLOBAL:
            qtd = sum(
                1 for u, d in usuarios.items()
                if u != usuario and d.get("papel") == PAPEL_SUPER_GLOBAL and usuario_esta_ativo(d)
            )
            if qtd == 0:
                return False, "Não é possível inativar: é o último super_admin_global ativo do sistema."
        elif papel == PAPEL_ADMIN_ESCRITORIO:
            eid = dados.get("escritorio_id")
            qtd = sum(
                1 for u, d in usuarios.items()
                if u != usuario and d.get("escritorio_id") == eid
                and d.get("papel") in (PAPEL_ADMIN_ESCRITORIO, PAPEL_SUPER_GLOBAL) and usuario_esta_ativo(d)
            )
            if qtd == 0:
                return False, "Não é possível inativar: é o último admin ativo deste escritório."

    usuarios[usuario]["ativo"] = ativo
    salvar_usuarios(path, usuarios)
    return True, ("Usuário ativado." if ativo else "Usuário inativado.")


def redefinir_senha(path: Path, usuario: str, nova_senha: str, forcar_troca: bool = False) -> bool:
    usuarios = carregar_usuarios(path)
    if usuario not in usuarios:
        return False
    h = _hash_senha(nova_senha)
    usuarios[usuario]["salt"] = h["salt"]
    usuarios[usuario]["hash"] = h["hash"]
    usuarios[usuario]["deve_trocar_senha"] = forcar_troca
    salvar_usuarios(path, usuarios)
    return True


def remover_usuario(path: Path, usuario: str) -> bool:
    """Remove um usuario - nunca remove o ultimo super_admin_global do app
    nem o ultimo admin_escritorio de um escritorio, para nao trancar
    ninguem para fora sem alguem capaz de gerenciar o acesso."""
    usuarios = carregar_usuarios(path)
    if usuario not in usuarios:
        return False
    dados = usuarios[usuario]
    papel = dados.get("papel")
    if papel == PAPEL_SUPER_GLOBAL:
        qtd = sum(1 for u in usuarios.values() if u.get("papel") == PAPEL_SUPER_GLOBAL)
        if qtd <= 1:
            return False
    elif papel == PAPEL_ADMIN_ESCRITORIO:
        eid = dados.get("escritorio_id")
        qtd = sum(
            1 for u in usuarios.values()
            if u.get("papel") in (PAPEL_ADMIN_ESCRITORIO, PAPEL_SUPER_GLOBAL) and u.get("escritorio_id") == eid
        )
        if qtd <= 1:
            return False
    del usuarios[usuario]
    salvar_usuarios(path, usuarios)
    return True

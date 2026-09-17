#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Migracao unica: importa usuarios.json + escritorios.json (formato antigo,
baseado em arquivo) para o Postgres (DATABASE_URL). Roda a criacao do
schema e faz upsert de cada registro - seguro rodar mais de uma vez
(idempotente).

Uso:
    DATABASE_URL=postgresql://... python scripts/migrate_json_to_postgres.py \
        usuarios.json escritorios.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import auth  # noqa: E402


def main() -> None:
    if len(sys.argv) != 3:
        print("Uso: migrate_json_to_postgres.py <usuarios.json> <escritorios.json>")
        sys.exit(1)

    usuarios_path, escritorios_path = sys.argv[1], sys.argv[2]

    auth.garantir_schema()

    escritorios = json.loads(Path(escritorios_path).read_text(encoding="utf-8"))
    usuarios = json.loads(Path(usuarios_path).read_text(encoding="utf-8"))

    with auth._conectar() as conn:  # noqa: SLF001 - script utilitario, acesso direto ok
        for eid, edados in escritorios.items():
            conn.execute(
                """INSERT INTO escritorios (id, nome, criado_em) VALUES (%s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome""",
                (eid, edados["nome"], edados.get("criado_em")),
            )
        conn.commit()
        print(f"{len(escritorios)} escritorio(s) migrado(s).")

        for uname, udados in usuarios.items():
            conn.execute(
                """INSERT INTO usuarios
                       (usuario, nome, papel, escritorio_id, salt, hash, deve_trocar_senha, ativo)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (usuario) DO UPDATE SET
                       nome = EXCLUDED.nome, papel = EXCLUDED.papel,
                       escritorio_id = EXCLUDED.escritorio_id, salt = EXCLUDED.salt,
                       hash = EXCLUDED.hash, deve_trocar_senha = EXCLUDED.deve_trocar_senha,
                       ativo = EXCLUDED.ativo""",
                (
                    uname, udados.get("nome", uname), udados["papel"], udados["escritorio_id"],
                    udados["salt"], udados["hash"], udados.get("deve_trocar_senha", False),
                    udados.get("ativo", True),
                ),
            )
        conn.commit()
        print(f"{len(usuarios)} usuario(s) migrado(s).")


if __name__ == "__main__":
    main()

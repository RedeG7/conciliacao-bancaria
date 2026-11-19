#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Leitura SEM IA: os campos do formulário de solicitação do Acessórias.

O formulário de "Contratação de funcionário" chega como o primeiro
comentário da solicitação, uma linha por campo ("Nome: ...", "Cargo: ...",
"Salário: ..."). Aqui as linhas viram a mesma ficha que a leitura com IA
devolve (admissoes_ia.SCHEMA_FICHA), para a prévia sair igual.

O formulário não traz o ASO nem todos os dados do cadastro: o que faltar
vai para a prévia como "a conferir pelo DP" (só os rótulos), e o DP confere
nos anexos antes de aprovar."""

from __future__ import annotations

import html
import re
import unicodedata

import admissoes_ia as ia

# dados mínimos para a prévia sair pelo formulário (sem eles: aguardando documentos)
OBRIGATORIOS = ("nome", "cpf", "data_nascimento", "cargo", "salario")


def _norm(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode("ascii")
    return " ".join(re.sub(r"[^a-z0-9/ ]", " ", sem_acento.casefold()).split())


# rótulo do formulário (normalizado) -> campo da ficha
_SINONIMOS = {
    "nome": ["nome", "nome completo", "nome do funcionario", "nome do empregado", "nome do colaborador"],
    "cpf": ["cpf", "cnpj/cpf", "cpf/cnpj", "cpf do funcionario"],
    "data_nascimento": ["data de nascimento", "nascimento", "data nascimento", "dt nascimento"],
    "sexo": ["sexo", "genero"],
    "estado_civil": ["estado civil"],
    "nome_mae": ["nome da mae", "mae"],
    "nome_pai": ["nome do pai", "pai"],
    "pis": ["pis", "pis/pasep", "nis", "pis/nis"],
    "rg_numero": ["rg", "identidade", "numero do rg"],
    "ctps_numero": ["ctps", "carteira de trabalho"],
    "cep": ["cep"],
    "logradouro": ["endereco", "logradouro", "rua"],
    "numero": ["numero"],
    "complemento": ["complemento"],
    "bairro": ["bairro"],
    "cidade": ["cidade", "municipio"],
    "uf": ["uf", "estado"],
    "telefone": ["telefone", "celular", "whatsapp", "telefone/celular"],
    "email": ["email", "e mail"],
    "data_admissao": ["data de admissao", "admissao", "data admissao", "data de inicio", "inicio"],
    "cargo": ["cargo", "cargo/funcao"],
    "funcao": ["funcao"],
    "servico": ["servico", "codigo do servico", "tomador", "obra"],
    "departamento": ["departamento", "setor"],
    "centro_custo": ["centro de custo", "centro de custos", "c custo"],
    "sindicato": ["sindicato"],
    "salario": ["salario", "salario base", "remuneracao"],
    "horario_trabalho": ["horario", "horario de trabalho", "jornada"],
    "tipo_contrato": ["tipo de contrato", "contrato"],
    "dias_experiencia": ["dias de experiencia", "experiencia", "contrato de experiencia"],
    "banco": ["banco"],
    "agencia": ["agencia"],
    "conta": ["conta", "conta corrente"],
    "vale_transporte": ["vale transporte", "vt"],
}
_ROTULO_PARA_CAMPO = {s: campo for campo, lista in _SINONIMOS.items() for s in lista}
_OBSERVACAO = {"comentario", "comentarios", "observacao", "observacoes", "obs"}
_LINHA = re.compile(r"^\s*([^:\n]{1,60}?)\s*:\s*(.*?)\s*$")


def _linhas(texto: str) -> list[str]:
    texto = re.sub(r"(?i)<\s*(br|/p|/div|/li|/tr)\s*/?>", "\n", texto or "")
    texto = html.unescape(re.sub(r"<[^>]+>", " ", texto))
    return texto.splitlines()


def ler_formulario(material: dict) -> dict | None:
    """Ficha no formato de admissoes_ia.SCHEMA_FICHA a partir das mensagens
    da solicitação; None se não há nenhum campo de formulário reconhecido."""
    ficha: dict = {chave: None for chave, _ in ia.CAMPOS}
    outros: dict[str, str] = {}
    observacoes: list[str] = []
    achou = False
    for mensagem in material.get("mensagens") or []:
        for linha in _linhas(mensagem):
            m = _LINHA.match(linha)
            if not m or not m.group(2):
                continue
            rotulo, valor = _norm(m.group(1)), m.group(2).strip()[:300]
            campo = _ROTULO_PARA_CAMPO.get(rotulo)
            if campo:
                achou = True
                if ficha[campo] is None:  # vale o primeiro (o formulário vem antes das conversas)
                    ficha[campo] = valor
            elif rotulo in _OBSERVACAO:
                observacoes.append(valor)
            elif len(outros) < 30:
                outros.setdefault(m.group(1).strip()[:60], valor)
    if not achou:
        return None
    if not ficha["cargo"] and ficha["funcao"]:  # muitos formulários chamam o cargo de "Função"
        ficha["cargo"] = ficha["funcao"]
    for campo in ("cpf", "pis", "cep"):
        if ficha[campo]:
            ficha[campo] = re.sub(r"\D", "", ficha[campo]) or None
    ficha.update(dependentes=[], documentos_identificados=["Formulário do Acessórias"],
                 observacoes=[], _outros=outros, _comentarios=observacoes)
    return ficha


def montar_previa(ficha: dict, empresa: dict, material: dict) -> tuple[dict, list[str]]:
    """Prévia pelo formulário. Faltando dado mínimo -> lista de rótulos; o
    resto dos obrigatórios do cadastro (ASO, admissão...) vira conferência do DP."""
    previa, faltando = ia.montar_previa(ficha, empresa, material, obrigatorios=OBRIGATORIOS)
    previa["origem_dos_dados"] = "Formulário do Acessórias (sem IA)"
    conferir = [ia.ROTULO[c] for c in ia.OBRIGATORIOS + ia.CAMPOS_ASO
                if c not in OBRIGATORIOS and not previa.get(c)]
    if conferir:
        previa["a_conferir_pelo_dp"] = conferir
    if ficha.get("_outros"):
        previa["outros_campos_do_formulario"] = dict(ficha["_outros"])
    if ficha.get("_comentarios"):
        previa["comentarios_do_formulario"] = list(ficha["_comentarios"])
    anexos = [d["nome"] for d in material.get("documentos") or []] + \
             [d["nome"] for d in material.get("ignorados") or []]
    previa["anexos_da_solicitacao"] = anexos
    return previa, faltando

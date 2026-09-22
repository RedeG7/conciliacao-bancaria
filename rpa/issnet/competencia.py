"""Calculo da competencia (mes anterior ao mes de execucao).

Regra fixa do escritorio: nunca perguntar, so calcular a partir da data
atual. Cobre meses de 28/29/30/31 dias, inclusive fevereiro bissexto.

Identico a rpa/issweb/competencia.py — cada modulo do hub mantem sua propria
copia (mesmo padrao adotado la) em vez de importar entre modulos, pra um
modulo nunca depender de outro.
"""

import calendar
from datetime import date


def calcular_competencia_anterior(hoje: date | None = None) -> dict:
    hoje = hoje or date.today()
    ano, mes = hoje.year, hoje.month - 1
    if mes == 0:
        mes, ano = 12, ano - 1
    ultimo_dia = calendar.monthrange(ano, mes)[1]
    return {
        "mm_aaaa": f"{mes:02d}/{ano}",
        "mm_aaaa_arquivo": f"{mes:02d} {ano}",
        "mes": mes,
        "ano": ano,
        "data_inicial": f"01/{mes:02d}/{ano}",
        "data_final": f"{ultimo_dia:02d}/{mes:02d}/{ano}",
    }

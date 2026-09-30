"""Competência padrão do RPA NF GO: sempre o mês ANTERIOR ao da execução,
do dia 1 ao último dia do mês (28/29/30/31, inclusive fevereiro bissexto).
A tela do Hub vem pré-preenchida com isso, mas deixa trocar o mês/ano.

Mesmo formato de rpa/issweb/competencia.py e rpa.core.montar_competencia -
o worker usa um ou outro sem precisar saber de qual módulo veio.
"""

from datetime import date

from rpa.core import montar_competencia


def calcular_competencia_anterior(hoje: date | None = None) -> dict:
    hoje = hoje or date.today()
    ano, mes = hoje.year, hoje.month - 1
    if mes == 0:
        mes, ano = 12, ano - 1
    return montar_competencia(mes, ano)

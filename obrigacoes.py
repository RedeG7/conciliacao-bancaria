"""Controle de Obrigações — dashboard de gestão das obrigações acessórias.

Fonte inicial: API do Acessórias (https://api.acessorias.com/documentation).
O Hub copia para um banco próprio (tabelas obr_*, separadas por escritório)
as empresas, departamentos, usuários e entregas (obrigações e tarefas, com
responsáveis e comentários), e a tela (_tela_obrigacoes em
app_conciliacao.py) calcula os indicadores em cima dessa cópia.

Regras que valem para o módulo inteiro:

- Nada é inventado: campo que a origem não trouxe fica vazio e a tela mostra
  "não informado". A API do Acessórias não informa a transmissão ao órgão
  nem o início da execução, então essas colunas ficam "indisponível".
- A situação do Hub é calculada pelas datas (prazo e data de entrega); o
  status original do Acessórias fica guardado ao lado (status_origem).
- Registro que some da origem não é apagado aqui.
- Falha na sincronização não muda as entregas: só gera o alerta de dados
  desatualizados.

Como a carga funciona (limites da API):

- ``deliveries/ListAll`` exige ``DtLastDH`` e só aceita o dia atual ou o
  anterior. Por isso a CARGA COMPLETA consulta empresa por empresa
  (``deliveries/{cnpj}``) dentro da janela de vencimentos configurada, e a
  sincronização INCREMENTAL usa ``ListAll`` com ``DtLastDH`` de ontem.
  Se a última sincronização boa tiver mais de um dia, a próxima volta a ser
  completa sozinha.
- 100 requisições por minuto: o cliente espera entre uma chamada e outra e,
  no HTTP 429, aguarda e tenta de novo.

Novos sistemas de origem entram como outro "conector" com os mesmos métodos
de ConectorAcessorias (empresas, departamentos, usuarios, entregas_empresa,
entregas_alteradas), devolvendo os dados já normalizados por
normalizar_entrega - a tela não muda.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from typing import Callable, Iterable, Optional
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

import auth
from rpa import core as rpa_core

log = logging.getLogger(__name__)

# Versão do app, mostrada na tela. A cada atualização: suba VERSAO e
# acrescente a entrada no topo de NOVIDADES (o teste confere que batem).
VERSAO = "1.5"
NOVIDADES = [
    ("1.5", "23/11/2026", [
        "Super administrador escolhe o escritório no topo da tela e vê o dashboard, as listas, os relatórios "
        "e a integração daquele escritório. Os demais usuários continuam vendo só o próprio.",
    ]),
    ("1.4", "23/11/2026", [
        "Sai o item do menu do Hub: o app abre pelo card em Aplicativos.",
        "Com o app aberto, as telas dele (Dashboard, Obrigações, Empresas, Colaboradores, Envios, Alertas, "
        "Relatórios e Integração) ficam no menu lateral, logo abaixo de \"Aplicativos\".",
        "O app sempre abre no Dashboard.",
    ]),
    ("1.3", "23/11/2026", [
        "Novo item \"Controle de Obrigações\" no menu lateral do Hub, logo abaixo de \"Aplicativos\": "
        "um clique abre o app no Dashboard.",
        "Dentro do app as telas voltam a ser abas no topo (Dashboard, Obrigações, Empresas, Colaboradores, "
        "Envios, Alertas, Relatórios e Integração), como na versão 1.1.",
    ]),
    ("1.2", "23/11/2026", [
        "Menu lateral do módulo: Dashboard, Obrigações, Empresas, Colaboradores, Envios, Alertas, Relatórios e "
        "Integração ficam na barra lateral, abaixo do menu do Hub (antes eram abas no topo).",
        "O item Alertas mostra quantas obrigações estão em atraso.",
    ]),
    ("1.1", "23/11/2026", [
        "Dashboard: os quatro painéis de gráficos agora têm o mesmo tamanho (largura e altura).",
    ]),
    ("1.0", "23/11/2026", [
        "Novo app: Controle de Obrigações, integrado ao Acessórias.",
        "Dashboard com total, concluídas, pendentes, em atraso, taxa de cumprimento no prazo e "
        "produtividade por colaborador, com filtros por período, departamento, empresa, colaborador e situação.",
        "Telas de obrigações, empresas (histórico por CNPJ), colaboradores, envios ao cliente e alertas de "
        "vencimento; exportação em Excel e PDF.",
        "Sincronização com o Acessórias: carga completa por empresa e atualização automática de hora em hora, "
        "com histórico das sincronizações e aviso de dados desatualizados.",
    ]),
]

FUSO = ZoneInfo("America/Sao_Paulo")
ACESSORIAS_URL = "https://api.acessorias.com"
PROVEDOR_ACESSORIAS = "acessorias"

# ---------------------------------------------------------------- situações

PENDENTE = "pendente"
ATRASADA = "atrasada"
CONCLUIDA_PRAZO = "concluida_prazo"
CONCLUIDA_ATRASO = "concluida_atraso"
DISPENSADA = "dispensada"
NAO_IDENTIFICADA = "nao_identificada"

SITUACOES = {
    PENDENTE: "Pendente",
    ATRASADA: "Em atraso",
    CONCLUIDA_PRAZO: "Concluída no prazo",
    CONCLUIDA_ATRASO: "Concluída com atraso",
    DISPENSADA: "Dispensada",
    NAO_IDENTIFICADA: "Não identificada",
}
CONCLUIDAS = (CONCLUIDA_PRAZO, CONCLUIDA_ATRASO)

# envio ao cliente (só com evidência na origem)
ENVIO_LIDA = "lida"
ENVIO_REGISTRADO = "enviada"
ENVIO_AGUARDANDO = "aguardando"
ENVIO_NAO_SE_APLICA = "nao_se_aplica"
ENVIOS = {
    ENVIO_LIDA: "Lida pelo cliente",
    ENVIO_REGISTRADO: "Envio registrado",
    ENVIO_AGUARDANDO: "Sem confirmação de envio",
    ENVIO_NAO_SE_APLICA: "—",
}

# tipos de evento (comentários do Acessórias)
EV_LEITURA = "leitura"
EV_ENVIO = "envio"
EV_STATUS = "status"
EV_ANEXO = "anexo"
EV_OUTRO = "outro"
EVENTOS = {EV_LEITURA: "Leitura", EV_ENVIO: "Envio", EV_STATUS: "Mudança de status",
           EV_ANEXO: "Anexo", EV_OUTRO: "Comentário"}

TIPOS = {"O": "Obrigação", "T": "Tarefa"}

SINC_COMPLETA = "completa"
SINC_INCREMENTAL = "incremental"
SINC_RODANDO = "rodando"
SINC_OK = "ok"
SINC_ERRO = "erro"
SINC_INTERROMPIDA = "interrompida"

DADOS_DESATUALIZADOS_H = 26  # sem sincronização boa há mais que isso -> alerta
MESES_ATRAS_PADRAO = 3
MESES_FRENTE_PADRAO = 2
_MAX_PAGINAS = 200
_TIMEOUT_S = 60


class ErroIntegracao(Exception):
    """Falha ao falar com o sistema de origem (mensagem pronta para a tela)."""


# ---------------------------------------------------------------- utilidades

def so_digitos(texto) -> str:
    return "".join(c for c in str(texto or "") if c.isdigit())


def formatar_cnpj(texto) -> str:
    d = so_digitos(texto)
    if len(d) == 14:
        return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"
    if len(d) == 11:
        return f"{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}"
    return str(texto or "")


def _sem_acento(texto: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", str(texto or "").lower())
                   if unicodedata.category(c) != "Mn")


def ler_data(valor) -> Optional[date]:
    """'2026-11-20', '20/11/2026' ou '2026-11-20 10:00:00' -> date. Vazio,
    '0000-00-00' e lixo -> None."""
    if isinstance(valor, datetime):
        return valor.date()
    if isinstance(valor, date):
        return valor
    texto = str(valor or "").strip()[:10]
    if not texto or texto.startswith("0000"):
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(texto, fmt).date()
        except ValueError:
            continue
    return None


def ler_data_hora(valor) -> Optional[datetime]:
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=FUSO)
    texto = str(valor or "").strip()
    if not texto or texto.startswith("0000"):
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M",
                "%d/%m/%Y %H:%M"):
        try:
            return datetime.strptime(texto[:19], fmt).replace(tzinfo=FUSO)
        except ValueError:
            continue
    d = ler_data(texto)
    return datetime(d.year, d.month, d.day, tzinfo=FUSO) if d else None


def data_br(valor) -> str:
    if isinstance(valor, datetime):
        return valor.astimezone(FUSO).strftime("%d/%m/%Y %H:%M")
    d = ler_data(valor)
    return d.strftime("%d/%m/%Y") if d else ""


def _texto(valor) -> str:
    return " ".join(str(valor if valor is not None else "").split())


def somar_meses(d: date, meses: int) -> date:
    mes = d.month - 1 + meses
    ano = d.year + mes // 12
    mes = mes % 12 + 1
    dias = [31, 29 if ano % 4 == 0 and (ano % 100 or ano % 400 == 0) else 28, 31, 30, 31, 30,
            31, 31, 30, 31, 30, 31][mes - 1]
    return date(ano, mes, min(d.day, dias))


def janela_sincronizacao(hoje: date, meses_atras: int, meses_frente: int) -> tuple[date, date]:
    """Período de vencimentos buscado na origem: do 1º dia de N meses atrás
    ao último dia de M meses à frente."""
    ini = somar_meses(hoje.replace(day=1), -max(0, meses_atras))
    fim = somar_meses(hoje.replace(day=1), max(0, meses_frente) + 1) - timedelta(days=1)
    return ini, fim


# ---------------------------------------------------------------- regras

def classificar_comentario(texto: str) -> str:
    """Tipo do evento a partir do texto do comentário do Acessórias. Só vira
    envio/leitura com palavra que diga isso - o resto fica "outro"."""
    t = _sem_acento(texto)
    if not t:
        return EV_OUTRO
    if "mudou o status" in t or "alterou o status" in t:
        return EV_STATUS
    if ("guia ja lida" in t or "como lida" in t or "guia lida" in t or "acessou a guia" in t
            or "leu a guia" in t or "visualizou" in t or "fez a leitura" in t or "foi lida" in t
            or "acessada/lida" in t):
        return EV_LEITURA
    if ("enviou" in t or "envio" in t or "enviada" in t or "enviado" in t or "encaminhou" in t
            or "encaminhad" in t or "disponibilizou" in t):
        return EV_ENVIO
    if "anex" in t:
        return EV_ANEXO
    return EV_OUTRO


def situacao(prazo: Optional[date], dt_entrega: Optional[date], status_origem: str, hoje: date) -> str:
    """Situação do Hub, pelas datas. Concluída fora do prazo continua
    concluída (com atraso). Sem prazo válido não entra no cálculo de atraso."""
    st = _sem_acento(status_origem)
    if "dispens" in st:
        return DISPENSADA
    if dt_entrega:
        if not prazo:
            return CONCLUIDA_PRAZO if "atras" not in st else CONCLUIDA_ATRASO
        return CONCLUIDA_PRAZO if dt_entrega <= prazo else CONCLUIDA_ATRASO
    if not prazo:
        return NAO_IDENTIFICADA
    return ATRASADA if hoje > prazo else PENDENTE


def envio_cliente(sit: str, guia_lida: str, eventos: Iterable[dict]) -> tuple[str, Optional[dict]]:
    """Situação do envio ao cliente e o evento que a comprova (o mais
    recente). Leitura vale como prova de que chegou ao cliente."""
    eventos = sorted((e for e in eventos if e.get("tipo") in (EV_LEITURA, EV_ENVIO)),
                     key=lambda e: e.get("data") or datetime.min.replace(tzinfo=FUSO), reverse=True)
    leitura = next((e for e in eventos if e["tipo"] == EV_LEITURA), None)
    envio = next((e for e in eventos if e["tipo"] == EV_ENVIO), None)
    if leitura or _texto(guia_lida):
        return ENVIO_LIDA, envio or leitura
    if envio:
        return ENVIO_REGISTRADO, envio
    if sit in CONCLUIDAS:
        return ENVIO_AGUARDANDO, None
    return ENVIO_NAO_SE_APLICA, None


def normalizar_entrega(empresa: dict, ent: dict) -> dict:
    """Uma entrega do Acessórias (item de "Entregas" de uma empresa) no
    formato do banco do Hub. `empresa` é o objeto pai (ID, Identificador,
    Razao, Fantasia)."""
    cfg = ent.get("Config") if isinstance(ent.get("Config"), dict) else {}
    emp_id = _texto(empresa.get("ID"))
    nome = _texto(ent.get("Nome"))
    competencia = _texto(ent.get("EntCompetencia"))
    prazo = ler_data(ent.get("EntDtPrazo"))
    dt_atraso = ler_data(ent.get("EntDtAtraso"))
    if not prazo and dt_atraso:
        prazo = dt_atraso - timedelta(days=1)
    ent_id = _texto(cfg.get("EntID"))
    if ent_id:
        chave = f"ent:{ent_id}"
    else:  # sem o ID da entrega: chave estável pelos dados que identificam a obrigação
        base = "|".join([emp_id, so_digitos(empresa.get("Identificador")), nome, competencia,
                         str(ent.get("EntDtPrazo") or "")])
        chave = "h:" + hashlib.sha1(base.encode("utf-8")).hexdigest()
    comentarios = []
    for c in ent.get("Comentarios") or []:
        if not isinstance(c, dict):
            continue
        texto = _texto(c.get("Texto"))
        quando = ler_data_hora(c.get("Data"))
        autor = _texto(c.get("Nome"))
        comentarios.append({
            "data": quando, "autor": autor, "email": _texto(c.get("Email")) or None, "texto": texto,
            "tipo": classificar_comentario(texto),
            "hash": hashlib.sha1(f"{c.get('Data')}|{autor}|{texto}".encode("utf-8")).hexdigest(),
        })
    multa = _texto(ent.get("EntMulta")).upper()
    return {
        "chave": chave,
        "ent_id": ent_id or None,
        "empresa_id_externo": emp_id or None,
        "cnpj": so_digitos(empresa.get("Identificador")) or None,
        "empresa_nome": _texto(empresa.get("Razao") or empresa.get("Fantasia")) or None,
        "nome": nome or "(sem nome)",
        "tipo": _texto(cfg.get("Tipo")).upper()[:1] or None,
        "obrigacao_id_externo": _texto(cfg.get("ID")) or None,
        "departamento_id": _texto(cfg.get("DptoID")) or None,
        "departamento_nome": _texto(cfg.get("DptoNome")) or None,
        "competencia": competencia or None,
        "prazo": prazo,
        "dt_atraso": dt_atraso,
        "dt_entrega": ler_data(ent.get("EntDtEntrega")),
        "multa": True if multa == "S" else False if multa == "N" else None,
        "status_origem": _texto(ent.get("Status")) or None,
        "guia_lida": _texto(ent.get("EntGuiaLida")) or None,
        "resp_prazo": _texto(cfg.get("RespPrazo")) or None,
        "resp_prazo_id": _texto(cfg.get("RespPrazoID")) or None,
        "resp_prazo_email": _texto(cfg.get("RespPrazoEmail")) or None,
        "resp_entrega": _texto(cfg.get("RespEntrega") or ent.get("RespEntrega")) or None,
        "resp_entrega_id": _texto(cfg.get("RespEntregaID")) or None,
        "resp_entrega_email": _texto(cfg.get("RespEntregaEmail")) or None,
        "ent_last_dh": ler_data_hora(ent.get("EntLastDH")),
        "comentarios": comentarios,
        "raw": {k: v for k, v in ent.items() if k != "Comentarios"},
    }


def enriquecer(linha: dict, hoje: date, eventos: Optional[list] = None) -> dict:
    """Acrescenta à linha do banco os campos calculados (situação, envio,
    dias de atraso) - sempre na hora, para "hoje" valer."""
    eventos = eventos if eventos is not None else linha.get("eventos") or []
    sit = situacao(linha.get("prazo"), linha.get("dt_entrega"), linha.get("status_origem") or "", hoje)
    env, ev = envio_cliente(sit, linha.get("guia_lida") or "", eventos)
    prazo = linha.get("prazo")
    if sit == ATRASADA:
        dias = (hoje - prazo).days
    elif sit == CONCLUIDA_ATRASO and prazo and linha.get("dt_entrega"):
        dias = (linha["dt_entrega"] - prazo).days
    else:
        dias = 0
    return {**linha, "situacao": sit, "envio": env, "envio_data": ev.get("data") if ev else None,
            "envio_por": ev.get("autor") if ev else None, "dias_atraso": dias,
            "responsavel": linha.get("resp_prazo") or linha.get("resp_entrega")}


# ---------------------------------------------------------------- indicadores

def _pct(parte: int, todo: int) -> Optional[float]:
    return round(100.0 * parte / todo, 1) if todo else None


def indicadores(linhas: list[dict]) -> dict:
    """Números do dashboard a partir das linhas enriquecidas.
    Cumprimento = concluídas no prazo / entregas com prazo (sem dispensadas)."""
    cont = {k: 0 for k in SITUACOES}
    for l in linhas:
        cont[l["situacao"]] += 1
    validas = [l for l in linhas if l["situacao"] != DISPENSADA]
    com_prazo = [l for l in validas if l.get("prazo")]
    concl_prazo = sum(1 for l in com_prazo if l["situacao"] == CONCLUIDA_PRAZO)
    concluidas = cont[CONCLUIDA_PRAZO] + cont[CONCLUIDA_ATRASO]
    env = {k: sum(1 for l in linhas if l["envio"] == k) for k in ENVIOS}
    return {
        "total": len(validas),
        "concluidas": concluidas,
        "concluidas_prazo": cont[CONCLUIDA_PRAZO],
        "concluidas_atraso": cont[CONCLUIDA_ATRASO],
        "pendentes": cont[PENDENTE],
        "atrasadas": cont[ATRASADA],
        "dispensadas": cont[DISPENSADA],
        "nao_identificadas": cont[NAO_IDENTIFICADA],
        "pct_concluidas": _pct(concluidas, len(validas)),
        "pct_pendentes": _pct(cont[PENDENTE], len(validas)),
        "pct_atrasadas": _pct(cont[ATRASADA], len(validas)),
        "cumprimento": _pct(concl_prazo, len(com_prazo)),
        "envios": env,
        "aguardando_envio": env[ENVIO_AGUARDANDO],
    }


def por_colaborador(linhas: list[dict]) -> list[dict]:
    """Produtividade: atribuídas = responsável pelo prazo; entregas
    realizadas = quem fez a entrega no Acessórias (podem ser pessoas
    diferentes). Taxa = concluídas no prazo / atribuídas com prazo."""
    grupos: dict[str, dict] = {}

    def _g(nome: str) -> dict:
        return grupos.setdefault(nome, {"colaborador": nome, "atribuidas": 0, "concluidas": 0, "no_prazo": 0,
                                        "com_atraso": 0, "atrasadas": 0, "pendentes": 0, "entregas_feitas": 0,
                                        "envios": 0, "_com_prazo": 0})

    for l in linhas:
        if l["situacao"] == DISPENSADA:
            continue
        g = _g(l.get("resp_prazo") or "Sem responsável")
        g["atribuidas"] += 1
        if l.get("prazo"):
            g["_com_prazo"] += 1
        if l["situacao"] in CONCLUIDAS:
            g["concluidas"] += 1
        g["no_prazo"] += l["situacao"] == CONCLUIDA_PRAZO
        g["com_atraso"] += l["situacao"] == CONCLUIDA_ATRASO
        g["atrasadas"] += l["situacao"] == ATRASADA
        g["pendentes"] += l["situacao"] == PENDENTE
        if l.get("resp_entrega") and l.get("dt_entrega"):
            _g(l["resp_entrega"])["entregas_feitas"] += 1
        if l.get("envio_por") and l["envio"] in (ENVIO_REGISTRADO, ENVIO_LIDA):
            _g(l["envio_por"])["envios"] += 1
    saida = []
    for g in grupos.values():
        g["taxa"] = _pct(g["no_prazo"], g.pop("_com_prazo"))
        saida.append(g)
    return sorted(saida, key=lambda g: (g["colaborador"] == "Sem responsável", -g["concluidas"], -g["atribuidas"],
                                        g["colaborador"]))


def por_chave(linhas: list[dict], chave: str, vazio: str = "Não informado") -> list[dict]:
    """Indicadores agrupados (departamento_nome, empresa_nome, competencia...)."""
    grupos: dict[str, list] = {}
    for l in linhas:
        grupos.setdefault(l.get(chave) or vazio, []).append(l)
    return sorted(({"grupo": k, **indicadores(v)} for k, v in grupos.items()),
                  key=lambda g: (-g["total"], g["grupo"]))


def alertas(linhas: list[dict], hoje: date, dias: int = 5, ultima_sinc_ok: Optional[datetime] = None,
            agora: Optional[datetime] = None) -> list[dict]:
    """Avisos da tela: dados desatualizados, atrasadas, vencendo nos
    próximos `dias` dias, concluídas sem confirmação de envio e entregas
    sem responsável."""
    agora = agora or datetime.now(FUSO)
    saida = []
    if ultima_sinc_ok is None or (agora - ultima_sinc_ok) > timedelta(hours=DADOS_DESATUALIZADOS_H):
        saida.append({"nivel": "erro", "titulo": "Dados possivelmente desatualizados",
                      "texto": ("Ainda não houve sincronização com o Acessórias." if ultima_sinc_ok is None else
                                f"Última sincronização bem-sucedida em {data_br(ultima_sinc_ok)}."),
                      "qtd": None})
    atrasadas = [l for l in linhas if l["situacao"] == ATRASADA]
    if atrasadas:
        saida.append({"nivel": "erro", "titulo": "Obrigações em atraso", "qtd": len(atrasadas),
                      "texto": "Prazo vencido e ainda sem entrega no Acessórias."})
    vencendo = [l for l in linhas if l["situacao"] == PENDENTE and l.get("prazo")
                and 0 <= (l["prazo"] - hoje).days <= dias]
    if vencendo:
        saida.append({"nivel": "aviso", "titulo": f"Vencem nos próximos {dias} dias", "qtd": len(vencendo),
                      "texto": "Pendentes com prazo até " + data_br(hoje + timedelta(days=dias)) + "."})
    sem_envio = [l for l in linhas if l["envio"] == ENVIO_AGUARDANDO]
    if sem_envio:
        saida.append({"nivel": "info", "titulo": "Concluídas sem confirmação de envio", "qtd": len(sem_envio),
                      "texto": "O Acessórias não registrou leitura nem envio ao cliente."})
    sem_resp = [l for l in linhas if l["situacao"] in (PENDENTE, ATRASADA) and not l.get("resp_prazo")]
    if sem_resp:
        saida.append({"nivel": "info", "titulo": "Pendências sem responsável", "qtd": len(sem_resp),
                      "texto": "Entregas em aberto sem responsável pelo prazo no Acessórias."})
    return saida


def filtrar(linhas: list[dict], departamento=None, empresa=None, colaborador=None, situacoes=None,
            tipo=None, busca: str = "") -> list[dict]:
    termo = _sem_acento(busca).strip()
    saida = []
    for l in linhas:
        if departamento and (l.get("departamento_nome") or "Não informado") != departamento:
            continue
        if empresa and l.get("cnpj") != empresa and l.get("empresa_id_externo") != empresa:
            continue
        if colaborador and colaborador not in (l.get("resp_prazo"), l.get("resp_entrega"), l.get("envio_por")):
            continue
        if situacoes and l["situacao"] not in situacoes:
            continue
        if tipo and l.get("tipo") != tipo:
            continue
        if termo and termo not in _sem_acento(f"{l.get('empresa_nome')} {l.get('nome')} {l.get('cnpj')} "
                                              f"{l.get('resp_prazo')} {l.get('resp_entrega')}"):
            continue
        saida.append(l)
    return saida


# ---------------------------------------------------------------- conector Acessórias

class ConectorAcessorias:
    """Cliente da API do Acessórias para o Controle de Obrigações: Bearer
    token, paginação por `Pagina` até vir lista vazia, intervalo mínimo entre
    chamadas (limite de 100/min) e nova tentativa no HTTP 429."""

    INTERVALO_S = 0.65
    ESPERA_429_S = 30
    TENTATIVAS_429 = 3

    def __init__(self, token: str, base_url: str = ACESSORIAS_URL, abrir: Callable = urllib.request.urlopen,
                 dormir: Callable = time.sleep, relogio: Callable = time.monotonic):
        if not token:
            raise ErroIntegracao("API Token do Acessórias não configurado")
        self._token = token
        self._base = base_url.rstrip("/")
        self._abrir = abrir
        self._dormir = dormir
        self._relogio = relogio
        self._ultima = None
        self.requisicoes = 0

    def _esperar_vez(self) -> None:
        if self._ultima is not None:
            falta = self.INTERVALO_S - (self._relogio() - self._ultima)
            if falta > 0:
                self._dormir(falta)
        self._ultima = self._relogio()

    def _get(self, caminho: str, params: Optional[dict] = None):
        url = f"{self._base}/{caminho.lstrip('/')}"
        if params:
            # flags sem valor (?config&comments) vão como "chave=" - a API trata igual
            url += "?" + urllib.parse.urlencode({k: ("" if v is True else v) for k, v in params.items()
                                                 if v is not None and v is not False})
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self._token}", "Accept": "application/json",
            "User-Agent": "HubObrigacoes/1.0",
        })
        for tentativa in range(self.TENTATIVAS_429 + 1):
            self._esperar_vez()
            self.requisicoes += 1
            try:
                with self._abrir(req, timeout=_TIMEOUT_S) as resp:
                    corpo = resp.read().decode("utf-8") or "null"
                break
            except urllib.error.HTTPError as e:
                if e.code == 429 and tentativa < self.TENTATIVAS_429:
                    self._dormir(self.ESPERA_429_S)
                    continue
                if e.code in (401, 403):
                    raise ErroIntegracao("Acessórias recusou o token (confira o API Token)") from None
                if e.code == 429:
                    raise ErroIntegracao("Acessórias: limite de requisições atingido") from None
                if e.code in (204, 404):
                    return []
                raise ErroIntegracao(f"Acessórias respondeu HTTP {e.code}") from None
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                raise ErroIntegracao(f"Sem conexão com o Acessórias ({type(e).__name__})") from None
        try:
            dados = json.loads(corpo)
        except ValueError:
            raise ErroIntegracao("Resposta inesperada do Acessórias") from None
        if isinstance(dados, dict) and dados.get("Erro"):
            raise ErroIntegracao(f"Acessórias: {str(dados['Erro'])[:200]}")
        return dados

    def _paginas(self, caminho: str, params: dict) -> Iterable[dict]:
        anterior = None
        for pagina in range(1, _MAX_PAGINAS + 1):
            dados = self._get(caminho, {**params, "Pagina": pagina})
            if isinstance(dados, dict):
                dados = [dados]
            lote = [d for d in (dados or []) if isinstance(d, dict)]
            if not lote or lote == anterior:  # lista vazia = fim (ou a API repetiu a última)
                return
            anterior = lote
            yield from lote

    def departamentos(self) -> list[dict]:
        dados = self._get("departments/ListAll") or []
        return [{"id_externo": _texto(d.get("ID")), "nome": _texto(d.get("Nome")),
                 "id_pai": _texto(d.get("IDPai")) or None}
                for d in (dados if isinstance(dados, list) else [dados]) if isinstance(d, dict) and d.get("ID")]

    def usuarios(self) -> list[dict]:
        return [{"id_externo": _texto(u.get("id")), "nome": _texto(u.get("nome")),
                 "email": _texto(u.get("email")) or None,
                 "ativo": _sem_acento(u.get("status")) != "inativo"}
                for u in self._paginas("users/ListAll", {}) if u.get("id")]

    def empresas(self) -> list[dict]:
        saida = []
        for e in self._paginas("companies/ListAll", {}):
            if not e.get("ID"):
                continue
            saida.append({"id_externo": _texto(e.get("ID")), "cnpj": so_digitos(e.get("Identificador")) or None,
                          "razao": _texto(e.get("Razao")) or None, "fantasia": _texto(e.get("Fantasia")) or None,
                          "situacao": _texto(e.get("Status")) or None, "regime": _texto(e.get("Regime")) or None,
                          "raw": e})
        return saida

    def entregas_empresa(self, identificador: str, ini: date, fim: date) -> list[dict]:
        """Entregas de UMA empresa com vencimento na janela (carga completa)."""
        saida = []
        for emp in self._paginas(f"deliveries/{urllib.parse.quote(identificador, safe='')}/",
                                 {"DtInitial": ini.isoformat(), "DtFinal": fim.isoformat(),
                                  "config": True, "comments": True}):
            for ent in emp.get("Entregas") or []:
                if isinstance(ent, dict):
                    saida.append(normalizar_entrega(emp, ent))
        return saida

    def entregas_alteradas(self, desde: datetime, ini: date, fim: date) -> list[dict]:
        """Entregas de todas as empresas alteradas desde `desde` (a API só
        aceita hoje ou ontem em DtLastDH)."""
        saida = []
        for emp in self._paginas("deliveries/ListAll/",
                                 {"DtInitial": ini.isoformat(), "DtFinal": fim.isoformat(),
                                  "DtLastDH": desde.astimezone(FUSO).strftime("%Y-%m-%d %H:%M:%S"),
                                  "config": True, "comments": True}):
            for ent in emp.get("Entregas") or []:
                if isinstance(ent, dict):
                    saida.append(normalizar_entrega(emp, ent))
        return saida


# ---------------------------------------------------------------- banco

def garantir_schema() -> None:
    with auth.conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_config (
                escritorio_id TEXT PRIMARY KEY REFERENCES escritorios(id),
                provedor TEXT NOT NULL DEFAULT 'acessorias',
                ativo BOOLEAN NOT NULL DEFAULT FALSE,
                token_cifrado BYTEA,
                meses_atras INTEGER NOT NULL DEFAULT 3,
                meses_frente INTEGER NOT NULL DEFAULT 2,
                atualizado_por TEXT,
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                ultima_sinc_ok TIMESTAMPTZ,
                ultima_carga_completa TIMESTAMPTZ
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_departamentos (
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                id_externo TEXT NOT NULL,
                nome TEXT NOT NULL,
                id_pai TEXT,
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (escritorio_id, id_externo)
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_colaboradores (
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                id_externo TEXT NOT NULL,
                nome TEXT NOT NULL,
                email TEXT,
                ativo BOOLEAN NOT NULL DEFAULT TRUE,
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (escritorio_id, id_externo)
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_empresas (
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                id_externo TEXT NOT NULL,
                cnpj TEXT,
                razao TEXT,
                fantasia TEXT,
                situacao TEXT,
                regime TEXT,
                raw JSONB,
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (escritorio_id, id_externo)
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_entregas (
                id BIGSERIAL PRIMARY KEY,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                provedor TEXT NOT NULL DEFAULT 'acessorias',
                chave TEXT NOT NULL,
                ent_id TEXT,
                empresa_id_externo TEXT,
                cnpj TEXT,
                empresa_nome TEXT,
                nome TEXT NOT NULL,
                tipo TEXT,
                obrigacao_id_externo TEXT,
                departamento_id TEXT,
                departamento_nome TEXT,
                competencia TEXT,
                prazo DATE,
                dt_atraso DATE,
                dt_entrega DATE,
                multa BOOLEAN,
                status_origem TEXT,
                guia_lida TEXT,
                resp_prazo TEXT,
                resp_prazo_id TEXT,
                resp_prazo_email TEXT,
                resp_entrega TEXT,
                resp_entrega_id TEXT,
                resp_entrega_email TEXT,
                ent_last_dh TIMESTAMPTZ,
                raw JSONB,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                visto_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (escritorio_id, provedor, chave)
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS obr_entregas_prazo ON obr_entregas (escritorio_id, prazo)")
        conn.execute("CREATE INDEX IF NOT EXISTS obr_entregas_cnpj ON obr_entregas (escritorio_id, cnpj)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_eventos (
                id BIGSERIAL PRIMARY KEY,
                entrega_id BIGINT NOT NULL REFERENCES obr_entregas(id) ON DELETE CASCADE,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                tipo TEXT NOT NULL,
                data TIMESTAMPTZ,
                autor TEXT,
                email TEXT,
                texto TEXT,
                origem TEXT NOT NULL DEFAULT 'acessorias',
                hash TEXT NOT NULL,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (entrega_id, hash)
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS obr_eventos_esc ON obr_eventos (escritorio_id, entrega_id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_alteracoes (
                id BIGSERIAL PRIMARY KEY,
                entrega_id BIGINT NOT NULL REFERENCES obr_entregas(id) ON DELETE CASCADE,
                escritorio_id TEXT NOT NULL,
                campo TEXT NOT NULL,
                antes TEXT,
                depois TEXT,
                sinc_id BIGINT,
                criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
            )""")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS obr_sinc (
                id BIGSERIAL PRIMARY KEY,
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                tipo TEXT NOT NULL,
                status TEXT NOT NULL,
                iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                concluido_em TIMESTAMPTZ,
                por TEXT,
                janela_ini DATE,
                janela_fim DATE,
                progresso TEXT,
                mensagem TEXT,
                contagem JSONB
            )""")
        conn.commit()


def _cifrar(token: str) -> bytes:
    return rpa_core._fernet().encrypt(token.encode("utf-8"))


def _decifrar(dados) -> str:
    try:
        return rpa_core._fernet().decrypt(bytes(dados)).decode("utf-8")
    except Exception:  # noqa: BLE001 - chave trocada: trata como sem token
        return ""


def obter_config(escritorio_id: str) -> dict:
    """Configuração sem o token (só se há um salvo e de onde ele vem)."""
    with auth.conectar() as conn:
        linha = conn.execute("SELECT * FROM obr_config WHERE escritorio_id = %s", (escritorio_id,)).fetchone()
    linha = dict(linha) if linha else {"escritorio_id": escritorio_id, "ativo": False, "token_cifrado": None,
                                       "meses_atras": MESES_ATRAS_PADRAO, "meses_frente": MESES_FRENTE_PADRAO,
                                       "ultima_sinc_ok": None, "ultima_carga_completa": None,
                                       "atualizado_por": None, "atualizado_em": None}
    tem_proprio = bool(linha.pop("token_cifrado", None))
    linha["token_salvo"] = tem_proprio
    linha["token_admissoes"] = not tem_proprio and bool(_token_admissoes(escritorio_id))
    return linha


def _token_admissoes(escritorio_id: str) -> str:
    """Token já salvo na integração do Acessórias das Admissões (mesmo
    escritório) - usado quando o Controle de Obrigações não tem um próprio."""
    try:
        import admissoes_canais
        return admissoes_canais._segredos(escritorio_id, admissoes_canais.ACESSORIAS).get("token", "")
    except Exception:  # noqa: BLE001 - tabela das admissões pode nem existir
        return ""


def token(escritorio_id: str) -> str:
    with auth.conectar() as conn:
        linha = conn.execute("SELECT token_cifrado FROM obr_config WHERE escritorio_id = %s",
                             (escritorio_id,)).fetchone()
    proprio = _decifrar(linha["token_cifrado"]) if linha and linha["token_cifrado"] else ""
    return proprio or _token_admissoes(escritorio_id)


def salvar_config(escritorio_id: str, usuario: str, ativo: bool, novo_token: str = "",
                  meses_atras: int = MESES_ATRAS_PADRAO, meses_frente: int = MESES_FRENTE_PADRAO,
                  apagar_token: bool = False) -> None:
    """Token em branco mantém o salvo. Janela limitada a 24 meses atrás e 12 à frente."""
    novo_token = (novo_token or "").strip()
    if len(novo_token) > 2000:
        raise ValueError("Token longo demais")
    meses_atras = max(0, min(24, int(meses_atras)))
    meses_frente = max(0, min(12, int(meses_frente)))
    with auth.conectar() as conn:
        conn.execute("""
            INSERT INTO obr_config (escritorio_id, ativo, token_cifrado, meses_atras, meses_frente,
                                    atualizado_por, atualizado_em)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (escritorio_id) DO UPDATE SET
                ativo = EXCLUDED.ativo,
                token_cifrado = CASE WHEN %s THEN NULL
                                     WHEN EXCLUDED.token_cifrado IS NOT NULL THEN EXCLUDED.token_cifrado
                                     ELSE obr_config.token_cifrado END,
                meses_atras = EXCLUDED.meses_atras, meses_frente = EXCLUDED.meses_frente,
                atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()
        """, (escritorio_id, ativo, _cifrar(novo_token) if novo_token else None, meses_atras, meses_frente,
              usuario, apagar_token))
        conn.commit()


def testar_conexao(escritorio_id: str, conector: Optional[ConectorAcessorias] = None,
                   token_teste: str = "") -> dict:
    """Confere o token: departamentos e a 1ª página de usuários."""
    conector = conector or ConectorAcessorias(token_teste.strip() or token(escritorio_id))
    deps = conector.departamentos()
    usuarios = conector._get("users/ListAll", {"Pagina": 1}) or []
    return {"departamentos": [d["nome"] for d in deps], "usuarios_pagina1": len(usuarios)}


_CAMPOS_ENTREGA = ("ent_id", "empresa_id_externo", "cnpj", "empresa_nome", "nome", "tipo", "obrigacao_id_externo",
                   "departamento_id", "departamento_nome", "competencia", "prazo", "dt_atraso", "dt_entrega",
                   "multa", "status_origem", "guia_lida", "resp_prazo", "resp_prazo_id", "resp_prazo_email",
                   "resp_entrega", "resp_entrega_id", "resp_entrega_email", "ent_last_dh")
# mudanças destes campos ficam no histórico de alterações
_CAMPOS_AUDITADOS = ("prazo", "dt_entrega", "status_origem", "resp_prazo", "resp_entrega", "guia_lida")


def gravar_entregas(conn, escritorio_id: str, entregas: list[dict], sinc_id: Optional[int] = None,
                    provedor: str = PROVEDOR_ACESSORIAS) -> dict:
    """Upsert das entregas normalizadas + comentários (sem duplicar) +
    histórico do que mudou. Nunca apaga."""
    cont = {"novas": 0, "alteradas": 0, "iguais": 0, "eventos": 0}
    for e in entregas:
        antes = conn.execute(
            f"SELECT id, {', '.join(_CAMPOS_AUDITADOS)} FROM obr_entregas "
            "WHERE escritorio_id = %s AND provedor = %s AND chave = %s",
            (escritorio_id, provedor, e["chave"])).fetchone()
        valores = [e.get(c) for c in _CAMPOS_ENTREGA]
        if antes is None:
            entrega_id = conn.execute(
                f"INSERT INTO obr_entregas (escritorio_id, provedor, chave, {', '.join(_CAMPOS_ENTREGA)}, raw) "
                f"VALUES (%s, %s, %s, {', '.join(['%s'] * len(_CAMPOS_ENTREGA))}, %s) RETURNING id",
                (escritorio_id, provedor, e["chave"], *valores, Jsonb(e.get("raw") or {}))).fetchone()["id"]
            cont["novas"] += 1
        else:
            entrega_id = antes["id"]
            mudou = [c for c in _CAMPOS_AUDITADOS if _cmp(antes[c]) != _cmp(e.get(c))]
            for c in mudou:
                conn.execute("INSERT INTO obr_alteracoes (entrega_id, escritorio_id, campo, antes, depois, sinc_id) "
                             "VALUES (%s, %s, %s, %s, %s, %s)",
                             (entrega_id, escritorio_id, c, _cmp(antes[c]) or None, _cmp(e.get(c)) or None, sinc_id))
            conn.execute(
                f"UPDATE obr_entregas SET {', '.join(f'{c} = %s' for c in _CAMPOS_ENTREGA)}, raw = %s, "
                f"visto_em = now(){', atualizado_em = now()' if mudou else ''} WHERE id = %s",
                (*valores, Jsonb(e.get("raw") or {}), entrega_id))
            cont["alteradas" if mudou else "iguais"] += 1
        for c in e.get("comentarios") or []:
            r = conn.execute(
                "INSERT INTO obr_eventos (entrega_id, escritorio_id, tipo, data, autor, email, texto, origem, hash) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (entrega_id, hash) DO NOTHING",
                (entrega_id, escritorio_id, c["tipo"], c["data"], c["autor"], c["email"], c["texto"], provedor,
                 c["hash"]))
            cont["eventos"] += r.rowcount or 0
    return cont


def _cmp(v) -> str:
    if isinstance(v, (date, datetime)):
        return v.isoformat()[:10] if not isinstance(v, datetime) else v.isoformat()
    return "" if v is None else str(v)


def _gravar_cadastros(conn, escritorio_id: str, departamentos: list, usuarios: list, empresas: list) -> None:
    for d in departamentos:
        conn.execute("""INSERT INTO obr_departamentos (escritorio_id, id_externo, nome, id_pai) VALUES (%s,%s,%s,%s)
                        ON CONFLICT (escritorio_id, id_externo) DO UPDATE SET nome = EXCLUDED.nome,
                        id_pai = EXCLUDED.id_pai, atualizado_em = now()""",
                     (escritorio_id, d["id_externo"], d["nome"] or d["id_externo"], d["id_pai"]))
    for u in usuarios:
        conn.execute("""INSERT INTO obr_colaboradores (escritorio_id, id_externo, nome, email, ativo)
                        VALUES (%s,%s,%s,%s,%s) ON CONFLICT (escritorio_id, id_externo) DO UPDATE SET
                        nome = EXCLUDED.nome, email = EXCLUDED.email, ativo = EXCLUDED.ativo, atualizado_em = now()""",
                     (escritorio_id, u["id_externo"], u["nome"] or u["id_externo"], u["email"], u["ativo"]))
    for e in empresas:
        _gravar_empresa(conn, escritorio_id, e)


def _gravar_empresa(conn, escritorio_id: str, e: dict) -> None:
    conn.execute("""INSERT INTO obr_empresas (escritorio_id, id_externo, cnpj, razao, fantasia, situacao, regime, raw)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (escritorio_id, id_externo) DO UPDATE SET
                    cnpj = COALESCE(EXCLUDED.cnpj, obr_empresas.cnpj),
                    razao = COALESCE(EXCLUDED.razao, obr_empresas.razao),
                    fantasia = COALESCE(EXCLUDED.fantasia, obr_empresas.fantasia),
                    situacao = COALESCE(EXCLUDED.situacao, obr_empresas.situacao),
                    regime = COALESCE(EXCLUDED.regime, obr_empresas.regime),
                    raw = COALESCE(EXCLUDED.raw, obr_empresas.raw), atualizado_em = now()""",
                 (escritorio_id, e["id_externo"], e.get("cnpj"), e.get("razao"), e.get("fantasia"),
                  e.get("situacao"), e.get("regime"), Jsonb(e["raw"]) if e.get("raw") else None))


def _empresas_das_entregas(conn, escritorio_id: str, entregas: list[dict]) -> None:
    """Empresas que apareceram só nas entregas (sincronização incremental)."""
    vistas = {}
    for e in entregas:
        if e.get("empresa_id_externo"):
            vistas[e["empresa_id_externo"]] = {"id_externo": e["empresa_id_externo"], "cnpj": e.get("cnpj"),
                                               "razao": e.get("empresa_nome")}
    for e in vistas.values():
        _gravar_empresa(conn, escritorio_id, e)


# ---------------------------------------------------------------- sincronização

def _sinc_atualizar(sinc_id: int, **campos) -> None:
    if not campos:
        return
    with auth.conectar() as conn:
        conn.execute(f"UPDATE obr_sinc SET {', '.join(f'{k} = %s' for k in campos)} WHERE id = %s",
                     (*[Jsonb(v) if isinstance(v, dict) else v for v in campos.values()], sinc_id))
        conn.commit()


def sinc_em_andamento(escritorio_id: str) -> Optional[dict]:
    with auth.conectar() as conn:
        return conn.execute(
            "SELECT * FROM obr_sinc WHERE escritorio_id = %s AND status = %s "
            "AND iniciado_em > now() - interval '6 hours' ORDER BY id DESC LIMIT 1",
            (escritorio_id, SINC_RODANDO)).fetchone()


def listar_sincronizacoes(escritorio_id: str, limite: int = 30) -> list[dict]:
    with auth.conectar() as conn:
        return conn.execute("SELECT * FROM obr_sinc WHERE escritorio_id = %s ORDER BY id DESC LIMIT %s",
                            (escritorio_id, limite)).fetchall()


def modo_automatico(cfg: dict, agora: datetime) -> str:
    """Incremental só quando a última sincronização boa é de hoje ou ontem
    (limite do DtLastDH no ListAll) e já houve uma carga completa."""
    ok, completa = cfg.get("ultima_sinc_ok"), cfg.get("ultima_carga_completa")
    if not ok or not completa:
        return SINC_COMPLETA
    ontem = (agora.astimezone(FUSO) - timedelta(days=1)).date()
    return SINC_INCREMENTAL if ok.astimezone(FUSO).date() >= ontem else SINC_COMPLETA


def sincronizar(escritorio_id: str, por: str = "automático", modo: Optional[str] = None,
                conector: Optional[ConectorAcessorias] = None, agora: Optional[datetime] = None) -> dict:
    """Uma rodada de sincronização do escritório (uma por vez, trava no
    Postgres). modo None = automático (completa ou incremental)."""
    agora = agora or datetime.now(FUSO)
    chave_trava = f"obr_sinc:{escritorio_id}"
    with auth.conectar() as trava:
        if not trava.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS ok", (chave_trava,)).fetchone()["ok"]:
            return {"em_andamento": True}
        try:
            # rodada que ficou "rodando" sem a trava = processo caiu no meio
            trava.execute("UPDATE obr_sinc SET status = %s, concluido_em = now(), "
                          "mensagem = COALESCE(mensagem, 'Interrompida (o servidor reiniciou durante a rodada)') "
                          "WHERE escritorio_id = %s AND status = %s", (SINC_INTERROMPIDA, escritorio_id, SINC_RODANDO))
            trava.commit()
            return _sincronizar(escritorio_id, por, modo, conector, agora)
        finally:
            trava.execute("SELECT pg_advisory_unlock(hashtext(%s))", (chave_trava,))


def _sincronizar(escritorio_id: str, por: str, modo: Optional[str], conector, agora: datetime) -> dict:
    cfg = obter_config(escritorio_id)
    modo = modo or modo_automatico(cfg, agora)
    if modo == SINC_INCREMENTAL and modo_automatico(cfg, agora) == SINC_COMPLETA:
        modo = SINC_COMPLETA  # o ListAll não aceita data de mais de 1 dia atrás
    ini, fim = janela_sincronizacao(agora.astimezone(FUSO).date(), cfg["meses_atras"], cfg["meses_frente"])
    with auth.conectar() as conn:
        sinc_id = conn.execute(
            "INSERT INTO obr_sinc (escritorio_id, tipo, status, por, janela_ini, janela_fim, progresso) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (escritorio_id, modo, SINC_RODANDO, por, ini, fim, "Conectando ao Acessórias...")).fetchone()["id"]
        conn.commit()
    cont = {"empresas": 0, "entregas": 0, "novas": 0, "alteradas": 0, "eventos": 0, "falhas_empresas": 0}
    falhas: list[str] = []
    try:
        conector = conector or ConectorAcessorias(token(escritorio_id))
        if modo == SINC_COMPLETA:
            deps, usuarios, empresas = conector.departamentos(), conector.usuarios(), conector.empresas()
            with auth.conectar() as conn:
                _gravar_cadastros(conn, escritorio_id, deps, usuarios, empresas)
                conn.commit()
            # empresa inativa no Acessórias não tem entregas novas - não gasta requisição com ela
            alvo = [e for e in empresas if e.get("cnpj") and "inativ" not in _sem_acento(e.get("situacao"))]
            cont["empresas"] = len(alvo)
            for n, emp in enumerate(alvo, 1):
                _sinc_atualizar(sinc_id, progresso=f"Empresa {n} de {len(alvo)}: {emp.get('razao') or emp['cnpj']}")
                try:
                    entregas = conector.entregas_empresa(emp["cnpj"], ini, fim)
                except ErroIntegracao as e:
                    if "token" in str(e).lower() or "conexão" in str(e).lower():
                        raise
                    cont["falhas_empresas"] += 1
                    falhas.append(f"{emp.get('razao') or emp['cnpj']}: {e}")
                    continue
                with auth.conectar() as conn:
                    r = gravar_entregas(conn, escritorio_id, entregas, sinc_id)
                    conn.commit()
                cont["entregas"] += len(entregas)
                for k in ("novas", "alteradas", "eventos"):
                    cont[k] += r[k]
        else:
            desde = (cfg["ultima_sinc_ok"].astimezone(FUSO) - timedelta(minutes=15))
            desde = max(desde, datetime.combine(agora.astimezone(FUSO).date() - timedelta(days=1),
                                                datetime.min.time(), tzinfo=FUSO))
            _sinc_atualizar(sinc_id, progresso="Buscando o que mudou desde " + data_br(desde))
            entregas = conector.entregas_alteradas(desde, ini, fim)
            with auth.conectar() as conn:
                _empresas_das_entregas(conn, escritorio_id, entregas)
                r = gravar_entregas(conn, escritorio_id, entregas, sinc_id)
                conn.commit()
            cont["entregas"] = len(entregas)
            cont["empresas"] = len({e.get("empresa_id_externo") for e in entregas})
            for k in ("novas", "alteradas", "eventos"):
                cont[k] += r[k]
    except Exception as e:  # noqa: BLE001 - a rodada sempre termina registrada
        msg = str(e) if isinstance(e, ErroIntegracao) else f"Erro inesperado ({type(e).__name__})"
        if not isinstance(e, ErroIntegracao):
            log.exception("Sincronização de obrigações falhou (%s)", escritorio_id)
        cont["requisicoes"] = getattr(conector, "requisicoes", 0)
        _sinc_atualizar(sinc_id, status=SINC_ERRO, concluido_em=datetime.now(FUSO), mensagem=msg,
                        contagem=cont, progresso=None)
        return {**cont, "erro": msg, "sinc_id": sinc_id}
    cont["requisicoes"] = getattr(conector, "requisicoes", 0)
    msg = (f"{cont['entregas']} entrega(s) lida(s) de {cont['empresas']} empresa(s): {cont['novas']} nova(s), "
           f"{cont['alteradas']} alterada(s), {cont['eventos']} comentário(s) novo(s)")
    if falhas:
        msg += f". {len(falhas)} empresa(s) com erro: " + "; ".join(falhas[:5])
    with auth.conectar() as conn:
        # upsert: o token pode vir das Admissões sem esta tela ter sido salva ainda
        conn.execute("INSERT INTO obr_config (escritorio_id, ultima_sinc_ok, ultima_carga_completa) "
                     "VALUES (%s, %s, %s) ON CONFLICT (escritorio_id) DO UPDATE SET "
                     "ultima_sinc_ok = EXCLUDED.ultima_sinc_ok, "
                     "ultima_carga_completa = COALESCE(EXCLUDED.ultima_carga_completa, "
                     "obr_config.ultima_carga_completa)",
                     (escritorio_id, agora, agora if modo == SINC_COMPLETA else None))
        conn.commit()
    _sinc_atualizar(sinc_id, status=SINC_OK, concluido_em=datetime.now(FUSO), mensagem=msg, contagem=cont,
                    progresso=None)
    return {**cont, "sinc_id": sinc_id, "mensagem": msg, "modo": modo}


def sincronizar_em_segundo_plano(escritorio_id: str, por: str, modo: Optional[str] = None) -> bool:
    """Dispara a rodada numa thread (a carga completa demora: ~1 requisição
    por empresa, no máximo 100 por minuto). False se já há uma rodando."""
    if sinc_em_andamento(escritorio_id):
        return False

    def _rodar():
        try:
            sincronizar(escritorio_id, por, modo)
        except Exception:  # noqa: BLE001
            log.exception("Sincronização de obrigações em segundo plano falhou (%s)", escritorio_id)

    threading.Thread(target=_rodar, name=f"obr-sinc-{escritorio_id}", daemon=True).start()
    return True


def sincronizar_todos() -> None:
    """Rodada automática (api.py) para os escritórios com a integração ativa."""
    with auth.conectar() as conn:
        escritorios = [l["escritorio_id"] for l in conn.execute(
            "SELECT escritorio_id FROM obr_config WHERE ativo").fetchall()]
    for esc in escritorios:
        try:
            sincronizar(esc)
        except Exception as e:  # noqa: BLE001 - registra e segue para o próximo
            log.warning("Sincronização de obrigações falhou para %s: %s", esc, type(e).__name__)


# ---------------------------------------------------------------- consultas

def carregar(escritorio_id: str, ini: date, fim: date, hoje: Optional[date] = None) -> list[dict]:
    """Entregas com prazo no período (e as sem prazo atualizadas nele),
    já enriquecidas com situação e envio."""
    hoje = hoje or datetime.now(FUSO).date()
    with auth.conectar() as conn:
        linhas = conn.execute(
            f"SELECT id, {', '.join(_CAMPOS_ENTREGA)}, atualizado_em, visto_em FROM obr_entregas "
            "WHERE escritorio_id = %s AND ((prazo BETWEEN %s AND %s) OR (prazo IS NULL AND visto_em::date "
            "BETWEEN %s AND %s)) ORDER BY prazo NULLS LAST, empresa_nome, nome",
            (escritorio_id, ini, fim, ini, fim)).fetchall()
        eventos: dict[int, list] = {}
        if linhas:
            for ev in conn.execute(
                    "SELECT entrega_id, tipo, data, autor FROM obr_eventos WHERE escritorio_id = %s "
                    "AND tipo IN (%s, %s) AND entrega_id = ANY(%s)",
                    (escritorio_id, EV_LEITURA, EV_ENVIO, [l["id"] for l in linhas])).fetchall():
                eventos.setdefault(ev["entrega_id"], []).append(ev)
    return [enriquecer(dict(l), hoje, eventos.get(l["id"], [])) for l in linhas]


def detalhe(escritorio_id: str, entrega_id: int) -> Optional[dict]:
    with auth.conectar() as conn:
        e = conn.execute("SELECT * FROM obr_entregas WHERE id = %s AND escritorio_id = %s",
                         (entrega_id, escritorio_id)).fetchone()
        if not e:
            return None
        ev = conn.execute("SELECT * FROM obr_eventos WHERE entrega_id = %s ORDER BY data NULLS LAST, id",
                          (entrega_id,)).fetchall()
        alt = conn.execute("SELECT * FROM obr_alteracoes WHERE entrega_id = %s ORDER BY id DESC LIMIT 50",
                           (entrega_id,)).fetchall()
    return {**enriquecer(dict(e), datetime.now(FUSO).date(), ev), "eventos": ev, "alteracoes": alt}


def historico_empresa(escritorio_id: str, cnpj: str, limite: int = 2000) -> list[dict]:
    hoje = datetime.now(FUSO).date()
    with auth.conectar() as conn:
        linhas = conn.execute(
            f"SELECT id, {', '.join(_CAMPOS_ENTREGA)} FROM obr_entregas WHERE escritorio_id = %s AND cnpj = %s "
            "ORDER BY prazo DESC NULLS LAST LIMIT %s", (escritorio_id, so_digitos(cnpj), limite)).fetchall()
        eventos: dict[int, list] = {}
        if linhas:
            for ev in conn.execute("SELECT entrega_id, tipo, data, autor FROM obr_eventos WHERE "
                                   "entrega_id = ANY(%s) AND tipo IN (%s, %s)",
                                   ([l["id"] for l in linhas], EV_LEITURA, EV_ENVIO)).fetchall():
                eventos.setdefault(ev["entrega_id"], []).append(ev)
    return [enriquecer(dict(l), hoje, eventos.get(l["id"], [])) for l in linhas]


def listar_empresas(escritorio_id: str) -> list[dict]:
    with auth.conectar() as conn:
        return conn.execute("SELECT * FROM obr_empresas WHERE escritorio_id = %s ORDER BY razao",
                            (escritorio_id,)).fetchall()


def listar_colaboradores(escritorio_id: str) -> list[dict]:
    with auth.conectar() as conn:
        return conn.execute("SELECT * FROM obr_colaboradores WHERE escritorio_id = %s ORDER BY nome",
                            (escritorio_id,)).fetchall()


# ---------------------------------------------------------------- relatórios

def linha_relatorio(l: dict) -> dict:
    return {
        "Empresa": l.get("empresa_nome") or "",
        "CNPJ": formatar_cnpj(l.get("cnpj")),
        "Obrigação": l.get("nome") or "",
        "Tipo": TIPOS.get(l.get("tipo") or "", "Não informado"),
        "Departamento": l.get("departamento_nome") or "Não informado",
        "Competência": l.get("competencia") or "",
        "Prazo": data_br(l.get("prazo")),
        "Entrega": data_br(l.get("dt_entrega")),
        "Situação": SITUACOES[l["situacao"]],
        "Dias de atraso": l.get("dias_atraso") or None,
        "Responsável (prazo)": l.get("resp_prazo") or "Não informado",
        "Entregue por": l.get("resp_entrega") or ("Não informado" if l.get("dt_entrega") else ""),
        "Envio ao cliente": ENVIOS[l["envio"]],
        "Data do envio/leitura": data_br(l.get("envio_data")),
        "Enviado por": l.get("envio_por") or "",
        "Transmissão ao órgão": "Indisponível na API",
        "Status no Acessórias": l.get("status_origem") or "",
    }


def gerar_excel(linhas: list[dict], titulo: str, filtros: str = "") -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    cab = PatternFill("solid", fgColor="0F766E")
    branco = Font(color="FFFFFF", bold=True)

    def _aba(ws, dados: list[dict]):
        if not dados:
            ws.append(["Sem registros"])
            return
        ws.append(list(dados[0].keys()))
        for c in ws[ws.max_row]:
            c.fill, c.font, c.alignment = cab, branco, Alignment(vertical="center", wrap_text=True)
        for d in dados:
            ws.append(list(d.values()))
        for i, k in enumerate(dados[0].keys(), 1):
            larg = max(len(str(k)), *(len(str(d[k] if d[k] is not None else "")) for d in dados[:500]))
            ws.column_dimensions[get_column_letter(i)].width = min(48, max(10, larg + 2))
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions

    ind = indicadores(linhas)
    ws = wb.active
    ws.title = "Resumo"
    ws.append([titulo])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append([f"Gerado em {datetime.now(FUSO).strftime('%d/%m/%Y %H:%M')}" + (f" · {filtros}" if filtros else "")])
    ws.append([])
    for rot, v in [("Total (sem dispensadas)", ind["total"]), ("Concluídas", ind["concluidas"]),
                   ("Concluídas no prazo", ind["concluidas_prazo"]),
                   ("Concluídas com atraso", ind["concluidas_atraso"]),
                   ("Pendentes", ind["pendentes"]), ("Em atraso", ind["atrasadas"]),
                   ("Dispensadas", ind["dispensadas"]), ("Não identificadas", ind["nao_identificadas"]),
                   ("Cumprimento no prazo (%)", ind["cumprimento"] if ind["cumprimento"] is not None else "—"),
                   ("Concluídas sem confirmação de envio", ind["aguardando_envio"])]:
        ws.append([rot, v])
    ws.column_dimensions["A"].width = 40
    _aba(wb.create_sheet("Obrigações"), [linha_relatorio(l) for l in linhas])
    _aba(wb.create_sheet("Colaboradores"), [{
        "Colaborador": g["colaborador"], "Atribuídas": g["atribuidas"], "Concluídas": g["concluidas"],
        "No prazo": g["no_prazo"], "Com atraso": g["com_atraso"], "Em atraso": g["atrasadas"],
        "Pendentes": g["pendentes"], "Entregas feitas": g["entregas_feitas"], "Envios": g["envios"],
        "Cumprimento (%)": g["taxa"] if g["taxa"] is not None else "—",
    } for g in por_colaborador(linhas)])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def gerar_pdf(linhas: list[dict], titulo: str, escritorio: str = "", filtros: str = "") -> bytes:
    """Relatório gerencial (A4 deitado): indicadores, colaboradores e a
    lista de pendências/atrasos (até 400 linhas). PyMuPDF a partir de HTML."""
    import html as _h
    import pymupdf

    ind = indicadores(linhas)
    esc = _h.escape

    def _pc(v):
        return "—" if v is None else f"{v:.1f}%".replace(".", ",")

    abertas = sorted((l for l in linhas if l["situacao"] in (ATRASADA, PENDENTE)),
                     key=lambda l: (l["situacao"] != ATRASADA, l.get("prazo") or date.max))[:400]
    css = """* {font-family: sans-serif;} body {font-size: 8.5pt; color: #1e293b;}
    h1 {font-size: 15pt; margin: 0;} h2 {font-size: 11pt; color: #0f766e; margin: 10pt 0 4pt 0;
    border-bottom: 1px solid #99f6e4;} .sub {color: #64748b; font-size: 8pt;}
    table {border-collapse: collapse; width: 100%;} th {background-color: #0f766e; color: #fff; font-size: 7.5pt;
    padding: 2pt; text-align: left;} td {border-bottom: 1px solid #e2e8f0; padding: 2pt; font-size: 7.5pt;}
    .k td {font-size: 10pt; padding: 4pt;} .r {color: #b91c1c;}"""
    kpis = (f"<table class='k'><tr><td><b>{ind['total']}</b><br/>Total</td><td><b>{ind['concluidas']}</b><br/>"
            f"Concluídas ({_pc(ind['pct_concluidas'])})</td><td><b>{ind['pendentes']}</b><br/>Pendentes</td>"
            f"<td class='r'><b>{ind['atrasadas']}</b><br/>Em atraso</td><td><b>{_pc(ind['cumprimento'])}</b><br/>"
            f"Cumprimento no prazo</td><td><b>{ind['aguardando_envio']}</b><br/>Sem confirmação de envio</td>"
            "</tr></table>")
    colab = "".join(
        f"<tr><td>{esc(g['colaborador'])}</td><td>{g['atribuidas']}</td><td>{g['concluidas']}</td>"
        f"<td>{g['no_prazo']}</td><td>{g['atrasadas']}</td><td>{g['pendentes']}</td><td>{g['envios']}</td>"
        f"<td>{_pc(g['taxa'])}</td></tr>" for g in por_colaborador(linhas)[:60])
    abertas_html = "".join(
        f"<tr><td>{esc(l.get('empresa_nome') or '')}</td><td>{esc(l.get('nome') or '')}</td>"
        f"<td>{esc(l.get('departamento_nome') or '')}</td><td>{data_br(l.get('prazo'))}</td>"
        f"<td{' class=r' if l['situacao'] == ATRASADA else ''}>{SITUACOES[l['situacao']]}"
        f"{' (' + str(l['dias_atraso']) + 'd)' if l['dias_atraso'] else ''}</td>"
        f"<td>{esc(l.get('resp_prazo') or 'Não informado')}</td></tr>" for l in abertas)
    corpo = (f"<h1>{esc(titulo)}</h1><div class='sub'>{esc(escritorio)} · gerado em "
             f"{datetime.now(FUSO).strftime('%d/%m/%Y %H:%M')}{' · ' + esc(filtros) if filtros else ''} · "
             "fonte: Acessórias</div><h2>Indicadores</h2>" + kpis +
             "<h2>Produtividade por colaborador</h2><table><tr><th>Colaborador</th><th>Atribuídas</th>"
             "<th>Concluídas</th><th>No prazo</th><th>Em atraso</th><th>Pendentes</th><th>Envios</th>"
             f"<th>Cumprimento</th></tr>{colab}</table>"
             "<h2>Pendências e atrasos</h2><table><tr><th>Empresa</th><th>Obrigação</th><th>Departamento</th>"
             f"<th>Prazo</th><th>Situação</th><th>Responsável</th></tr>{abertas_html or '<tr><td>Nenhuma</td></tr>'}"
             "</table>")
    story = pymupdf.Story(html=corpo, user_css=css)
    buf = io.BytesIO()
    escritor = pymupdf.DocumentWriter(buf)
    pagina = pymupdf.paper_rect("a4-l")
    area = pagina + (28, 28, -28, -28)
    mais = True
    while mais:
        dispositivo = escritor.begin_page(pagina)
        mais, _ = story.place(area)
        story.draw(dispositivo)
        escritor.end_page()
    escritor.close()
    return buf.getvalue()

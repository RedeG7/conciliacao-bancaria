"""Integrações dos canais de Admissões (Acessórias, ONVIO, WhatsApp).

Cada escritório configura os próprios acessos em Administração › Integrações (antes, aba "Canais e agente" da
tela de Admissões). Os campos secretos (tokens) ficam cifrados com a mesma
chave das credenciais do RPA (RPA_ENC_KEY, ver rpa/core.py) e nunca voltam
para a tela.

Acessórias: não avisa o Hub quando chega algo (a API não tem webhook), então
o Hub consulta as solicitações externas de tempos em tempos
(sincronizar_todos, chamado pela api.py) ou quando alguém clica em
"Sincronizar agora". As que são do departamento e do assunto configurados
viram solicitações de admissão (admissoes.receber_solicitacao), com a
empresa encontrada pelo CNPJ do cadastro de clientes.

ONVIO e WhatsApp: os campos já podem ser preenchidos, mas a integração
ainda não foi feita (DISPONIVEL = False) - nada é consultado com eles.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import logging
import socket
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from typing import Callable, Optional

from psycopg.types.json import Jsonb

import admissoes
import auth
import clientes
from rpa import core as rpa_core

log = logging.getLogger(__name__)

ACESSORIAS = "acessorias"
ONVIO = "onvio"
WHATSAPP = "whatsapp"
IA = "ia"  # não é canal de entrada: chaves de IA que o agente usa para ler os documentos

CLAUDE = "claude"
OPENAI = "openai"
FORMULARIO = "formulario"

# campos de cada canal: "segredo" = cifrado e nunca mostrado de volta
CAMPOS: dict[str, list[dict]] = {
    ACESSORIAS: [
        {"chave": "token", "rotulo": "API Token", "segredo": True,
         "ajuda": "No Acessórias: engrenagem (canto superior direito) › API Token. "
                  "Use um usuário do Acessórias só para a integração."},
        {"chave": "departamentos", "rotulo": "Departamentos", "padrao": "Pessoal",
         "ajuda": "Só entram solicitações destes departamentos (separe por vírgula)."},
        {"chave": "palavras", "rotulo": "Palavras no assunto", "padrao": "admissão, contratação",
         "ajuda": "Só entram solicitações cujo assunto ou primeira mensagem tenha uma destas palavras "
                  "(separe por vírgula; acentos e maiúsculas não importam)."},
        {"chave": "dias_retroativos", "rotulo": "Na primeira busca, olhar os últimos (dias)", "padrao": "7",
         "inteiro": True},
    ],
    ONVIO: [
        {"chave": "client_id", "rotulo": "Client ID (API Onvio BR)",
         "ajuda": "Credencial OAuth pedida à equipe da API Onvio BR da Thomson Reuters."},
        {"chave": "client_secret", "rotulo": "Client Secret", "segredo": True},
    ],
    WHATSAPP: [
        {"chave": "phone_number_id", "rotulo": "Phone Number ID",
         "ajuda": "WhatsApp Business Platform (Meta): ID do número no app do Meta for Developers."},
        {"chave": "waba_id", "rotulo": "WhatsApp Business Account ID"},
        {"chave": "access_token", "rotulo": "Access Token", "segredo": True},
        {"chave": "app_secret", "rotulo": "App Secret", "segredo": True,
         "ajuda": "Usado para conferir a assinatura das mensagens que a Meta envia ao Hub."},
    ],
    IA: [
        {"chave": "provedor", "rotulo": "IA usada", "padrao": CLAUDE,
         "opcoes": {CLAUDE: "Claude (Anthropic)", OPENAI: "OpenAI"}},
        {"chave": "anthropic_key", "rotulo": "API Key da Claude (Anthropic)", "segredo": True,
         "ajuda": "console.anthropic.com › API Keys. Lê os documentos e preenche o Domínio na sessão RDS."},
        {"chave": "openai_key", "rotulo": "API Key da OpenAI", "segredo": True,
         "ajuda": "platform.openai.com › API keys. Com a OpenAI o agente só lê os documentos; "
                  "o preenchimento no Domínio com IA é só com a Claude."},
        {"chave": "openai_modelo", "rotulo": "Modelo da OpenAI", "padrao": "gpt-5",
         "ajuda": "Modelo com leitura de PDF/imagem e saída estruturada."},
    ],
}

# nome das abas na tela
ROTULO = {**admissoes.CANAL_ROTULO, IA: "IA (Claude / OpenAI)"}

# chave que precisa estar salva para ativar a IA, conforme o provedor
_CHAVE_DO_PROVEDOR = {CLAUDE: "anthropic_key", OPENAI: "openai_key"}

# canais cuja integração já funciona (os demais só guardam os campos)
DISPONIVEL = {ACESSORIAS: True, ONVIO: False, WHATSAPP: False, IA: True}

ACESSORIAS_URL = "https://api.acessorias.com"
_TIMEOUT_S = 25
_MAX_PAGINAS = 50  # 20 por página no /requests - teto de segurança por rodada


class ConfigInvalida(ValueError):
    pass


class ErroCanal(RuntimeError):
    """Falha ao falar com o canal - a mensagem pode ir para a tela (nunca
    contém o token)."""


# ---------------------------------------------------------------------------
# Schema e configuração
# ---------------------------------------------------------------------------

def garantir_schema() -> None:
    with auth.conectar() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS admissoes_canais_config (
                escritorio_id TEXT NOT NULL REFERENCES escritorios(id),
                canal TEXT NOT NULL,
                ativo BOOLEAN NOT NULL DEFAULT false,
                parametros JSONB NOT NULL DEFAULT '{}'::jsonb,
                segredos_cifrados BYTEA,
                ultima_sinc_em TIMESTAMPTZ,
                ultima_sinc_ok BOOLEAN,
                ultima_sinc_msg TEXT,
                sinc_desde TIMESTAMPTZ,
                atualizado_por TEXT,
                atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (escritorio_id, canal)
            )
        """)
        conn.commit()


def _validar_canal(canal: str) -> str:
    if canal not in CAMPOS:
        raise ConfigInvalida("Canal inválido")
    return canal


def obter_config(escritorio_id: str, canal: str) -> dict:
    """Configuração do canal sem os segredos (só quais estão salvos)."""
    _validar_canal(canal)
    with auth.conectar() as conn:
        linha = conn.execute(
            "SELECT * FROM admissoes_canais_config WHERE escritorio_id = %s AND canal = %s",
            (escritorio_id, canal),
        ).fetchone()
    segredos = _decifrar(linha["segredos_cifrados"]) if linha and linha["segredos_cifrados"] else {}
    parametros = dict(linha["parametros"]) if linha else {}
    for campo in CAMPOS[canal]:
        if not campo.get("segredo") and campo["chave"] not in parametros and "padrao" in campo:
            parametros[campo["chave"]] = campo["padrao"]
    return {
        "canal": canal,
        "ativo": bool(linha and linha["ativo"]),
        "parametros": parametros,
        "segredos_salvos": sorted(k for k, v in segredos.items() if v),
        "ultima_sinc_em": linha["ultima_sinc_em"] if linha else None,
        "ultima_sinc_ok": linha["ultima_sinc_ok"] if linha else None,
        "ultima_sinc_msg": linha["ultima_sinc_msg"] if linha else None,
        "atualizado_por": linha["atualizado_por"] if linha else None,
        "atualizado_em": linha["atualizado_em"] if linha else None,
    }


def _cifrar(segredos: dict) -> bytes:
    return rpa_core._fernet().encrypt(json.dumps(segredos).encode("utf-8"))


def _decifrar(dados: bytes) -> dict:
    return json.loads(rpa_core._fernet().decrypt(bytes(dados)).decode("utf-8"))


def _segredos(escritorio_id: str, canal: str) -> dict:
    with auth.conectar() as conn:
        linha = conn.execute(
            "SELECT segredos_cifrados FROM admissoes_canais_config WHERE escritorio_id = %s AND canal = %s",
            (escritorio_id, canal),
        ).fetchone()
    return _decifrar(linha["segredos_cifrados"]) if linha and linha["segredos_cifrados"] else {}


def salvar_config(escritorio_id: str, canal: str, usuario: str, ativo: bool,
                  valores: dict, limpar_segredos: tuple = ()) -> dict:
    """Grava os campos do canal. Segredo em branco mantém o que já estava
    salvo; para apagar um, passe o nome dele em limpar_segredos."""
    _validar_canal(canal)
    parametros: dict = {}
    novos_segredos: dict = {}
    for campo in CAMPOS[canal]:
        valor = str(valores.get(campo["chave"], "") or "").strip()
        if len(valor) > 2000:
            raise ConfigInvalida(f"{campo['rotulo']}: texto longo demais")
        if campo.get("segredo"):
            if valor:
                novos_segredos[campo["chave"]] = valor
            continue
        if not valor and "padrao" in campo:
            # em branco volta ao padrão: filtro vazio aceitaria qualquer solicitação
            valor = campo["padrao"]
        if campo.get("opcoes") and valor not in campo["opcoes"]:
            raise ConfigInvalida(f"{campo['rotulo']}: opção inválida")
        if campo.get("inteiro") and valor:
            if not valor.isdigit() or not 1 <= int(valor) <= 90:
                raise ConfigInvalida(f"{campo['rotulo']}: informe um número de 1 a 90")
        parametros[campo["chave"]] = valor
    segredos = {**_segredos(escritorio_id, canal), **novos_segredos}
    for chave in limpar_segredos:
        segredos.pop(chave, None)
    if ativo and canal == IA:
        # só a chave da IA escolhida é obrigatória
        chave = _CHAVE_DO_PROVEDOR[parametros["provedor"]]
        if not segredos.get(chave):
            rotulo = next(c["rotulo"] for c in CAMPOS[IA] if c["chave"] == chave)
            raise ConfigInvalida("Para ativar, preencha: " + rotulo)
    elif ativo and DISPONIVEL[canal]:
        faltando = [c["rotulo"] for c in CAMPOS[canal] if c.get("segredo") and not segredos.get(c["chave"])]
        if faltando:
            raise ConfigInvalida("Para ativar, preencha: " + ", ".join(faltando))
    if ativo and not DISPONIVEL[canal]:
        raise ConfigInvalida("A integração deste canal ainda não está disponível - salve sem ativar.")
    with auth.conectar() as conn:
        conn.execute("""
            INSERT INTO admissoes_canais_config
                (escritorio_id, canal, ativo, parametros, segredos_cifrados, atualizado_por, atualizado_em)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (escritorio_id, canal) DO UPDATE SET
                ativo = EXCLUDED.ativo, parametros = EXCLUDED.parametros,
                segredos_cifrados = EXCLUDED.segredos_cifrados,
                atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()
        """, (escritorio_id, canal, ativo, Jsonb(parametros),
              _cifrar(segredos) if segredos else None, usuario))
        conn.commit()
    return obter_config(escritorio_id, canal)


def leitura_do_agente(escritorio_id: str) -> dict:
    """Como o agente lê os documentos: IA desligada -> campos do formulário
    do Acessórias; ligada -> a IA escolhida, com a chave salva no Hub."""
    cfg = obter_config(escritorio_id, IA)
    if not cfg["ativo"]:
        return {"leitura": FORMULARIO}
    provedor = cfg["parametros"].get("provedor") or CLAUDE
    chave = _segredos(escritorio_id, IA).get(_CHAVE_DO_PROVEDOR.get(provedor, ""), "")
    if not chave:
        return {"leitura": FORMULARIO}
    saida = {"leitura": provedor, "chave": chave}
    if provedor == OPENAI:
        saida["modelo"] = cfg["parametros"].get("openai_modelo") or "gpt-5"
    return saida


def _registrar_sinc(escritorio_id: str, canal: str, ok: bool, msg: str,
                    desde: Optional[datetime] = None) -> None:
    with auth.conectar() as conn:
        conn.execute("""
            UPDATE admissoes_canais_config SET ultima_sinc_em = now(), ultima_sinc_ok = %s,
                ultima_sinc_msg = %s, sinc_desde = COALESCE(%s, sinc_desde)
            WHERE escritorio_id = %s AND canal = %s
        """, (ok, msg[:500], desde, escritorio_id, canal))
        conn.commit()


# ---------------------------------------------------------------------------
# Acessórias
# ---------------------------------------------------------------------------

class AcessoriasCliente:
    """Cliente mínimo da API do Acessórias (Bearer token, JSON). Erros de
    negócio vêm com HTTP 200 e a chave "Erro" - viram ErroCanal."""

    def __init__(self, token: str, base_url: str = ACESSORIAS_URL,
                 abrir: Callable = urllib.request.urlopen):
        if not token:
            raise ErroCanal("API Token do Acessórias não configurado")
        self._token = token
        self._base = base_url.rstrip("/")
        self._abrir = abrir

    def _get(self, caminho: str, params: Optional[dict] = None):
        url = f"{self._base}/{caminho.lstrip('/')}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self._token}", "Accept": "application/json",
            "User-Agent": "HubAdmissoes/1.0",
        })
        try:
            with self._abrir(req, timeout=_TIMEOUT_S) as resp:
                corpo = resp.read().decode("utf-8") or "null"
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise ErroCanal("Acessórias recusou o token (confira o API Token)") from None
            if e.code == 429:
                raise ErroCanal("Acessórias: limite de requisições atingido, tente em 1 minuto") from None
            raise ErroCanal(f"Acessórias respondeu HTTP {e.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ErroCanal(f"Sem conexão com o Acessórias ({type(e).__name__})") from None
        try:
            dados = json.loads(corpo)
        except ValueError:
            raise ErroCanal("Resposta inesperada do Acessórias") from None
        if isinstance(dados, dict) and dados.get("Erro"):
            raise ErroCanal(f"Acessórias: {str(dados['Erro'])[:200]}")
        return dados

    def departamentos(self) -> list[str]:
        dados = self._get("departments/ListAll") or []
        return [str(d.get("Nome", "")) for d in dados if isinstance(d, dict)]

    def empresas(self, pagina: int) -> list[dict]:
        dados = self._get("companies/ListAll", {"ativa": "S", "Pagina": pagina})
        return [d for d in (dados or []) if isinstance(d, dict)]

    def solicitacao(self, sol_id: str) -> dict:
        dados = self._get(f"requests/{urllib.parse.quote(str(sol_id), safe='')}")
        if isinstance(dados, list):
            dados = dados[0] if dados else None
        if not isinstance(dados, dict):
            raise ErroCanal("Solicitação não encontrada no Acessórias")
        return dados

    def baixar(self, url: str, limite: int) -> bytes:
        """Baixa um anexo. O token só vai junto para o próprio Acessórias;
        endereço interno/privado é recusado (o link vem de dado externo)."""
        partes = urllib.parse.urlsplit(url)
        host = (partes.hostname or "").lower()
        if partes.scheme != "https" or not host or not _host_publico(host):
            raise ErroCanal("Link de anexo recusado")
        cab = {"User-Agent": "HubAdmissoes/1.0"}
        if host == "acessorias.com" or host.endswith(".acessorias.com"):
            cab["Authorization"] = f"Bearer {self._token}"
        try:
            with self._abrir(urllib.request.Request(url, headers=cab), timeout=_TIMEOUT_S) as resp:
                dados = resp.read(limite + 1)
        except urllib.error.HTTPError as e:
            raise ErroCanal(f"Anexo indisponível (HTTP {e.code})") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise ErroCanal(f"Sem conexão para baixar o anexo ({type(e).__name__})") from None
        if len(dados) > limite:
            raise ErroCanal("Anexo grande demais")
        return dados

    def solicitacoes(self, desde: date, pagina: int) -> list[dict]:
        dados = self._get("requests/ListAll", {
            "SolTipo": "E", "SolUltAtIni": desde.isoformat(), "Pagina": pagina,
        })
        return [d for d in (dados or []) if isinstance(d, dict)]


def _normalizar(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode("ascii")
    return " ".join(sem_acento.casefold().split())


def _lista(texto: str) -> list[str]:
    return [_normalizar(p) for p in (texto or "").split(",") if _normalizar(p)]


def _comentarios(sol: dict) -> list[dict]:
    """SolInteracoes vem como lista de listas de comentários."""
    saida: list[dict] = []
    for grupo in sol.get("SolInteracoes") or []:
        for c in (grupo if isinstance(grupo, list) else [grupo]):
            if isinstance(c, dict):
                saida.append(c)
    return saida


def _anexos(sol: dict) -> list[str]:
    nomes: list[str] = []
    for c in _comentarios(sol):
        for anx in c.get("CmtAnx") or []:
            nome = str((anx or {}).get("Nome") or "").strip()
            if nome and nome not in nomes:
                nomes.append(nome)
    return nomes[:admissoes.MAX_DOCUMENTOS]


def _host_publico(host: str) -> bool:
    try:
        enderecos = {i[4][0] for i in socket.getaddrinfo(host, 443)}
    except OSError:
        return False
    for e in enderecos:
        ip = ipaddress.ip_address(e.split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return bool(enderecos)


# o que o agente consegue mandar para leitura (PDF e imagem)
TIPOS_DOCUMENTO = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
}
MAX_ANEXO_BYTES = 15 * 1024 * 1024
MAX_MATERIAL_BYTES = 30 * 1024 * 1024


def _tipo_documento(nome: str) -> Optional[str]:
    nome = nome.lower()
    return next((t for ext, t in TIPOS_DOCUMENTO.items() if nome.endswith(ext)), None)


def material_acessorias(escritorio_id: str, sol_id: str,
                        cliente: Optional[AcessoriasCliente] = None) -> dict:
    """Mensagens e anexos da solicitação, buscados na hora no Acessórias -
    o token fica no Hub e o agente recebe só o conteúdo."""
    cliente = cliente or AcessoriasCliente(_segredos(escritorio_id, ACESSORIAS).get("token", ""))
    sol = cliente.solicitacao(sol_id)
    mensagens, documentos, ignorados = [], [], []
    total = 0
    vistos: set = set()
    for c in _comentarios(sol):
        texto = str(c.get("CmtText") or "").strip()
        if texto:
            mensagens.append(texto[:5000])
        for anx in c.get("CmtAnx") or []:
            nome = str((anx or {}).get("Nome") or "").strip()
            url = str((anx or {}).get("Url") or "").strip()
            if not nome or nome in vistos:
                continue
            vistos.add(nome)
            tipo = _tipo_documento(nome)
            if not tipo or not url:
                ignorados.append({"nome": nome, "motivo": "tipo de arquivo não lido (só PDF e imagem)"
                                  if not tipo else "sem link no Acessórias"})
                continue
            try:
                conteudo = cliente.baixar(url, MAX_ANEXO_BYTES)
            except ErroCanal as exc:
                ignorados.append({"nome": nome, "motivo": str(exc)})
                continue
            if total + len(conteudo) > MAX_MATERIAL_BYTES:
                ignorados.append({"nome": nome, "motivo": "limite de tamanho da solicitação"})
                continue
            total += len(conteudo)
            documentos.append({"nome": nome, "tipo": tipo, "base64": base64.b64encode(conteudo).decode()})
    return {"assunto": str(sol.get("SolAssunto") or ""), "mensagens": mensagens[:50],
            "documentos": documentos, "ignorados": ignorados}


def material_para_agente(escritorio_id: str, linha: dict, cliente=None) -> dict:
    if linha["canal"] == ACESSORIAS:
        return material_acessorias(escritorio_id, linha["id_externo"], cliente)
    # canais ainda sem integração (ou registro manual): só os nomes
    return {"assunto": linha.get("resumo") or "", "mensagens": [], "documentos": [],
            "ignorados": [{"nome": n, "motivo": "canal sem integração para baixar o arquivo"}
                          for n in (linha.get("documentos") or [])]}


def eh_admissao(sol: dict, departamentos: list[str], palavras: list[str]) -> bool:
    if departamentos and not any(d in _normalizar(str(sol.get("DptoNome", ""))) for d in departamentos):
        return False
    comentarios = _comentarios(sol)
    texto = _normalizar(str(sol.get("SolAssunto", "")) + " " +
                        (str(comentarios[0].get("CmtText", "")) if comentarios else ""))
    return not palavras or any(p in texto for p in palavras)


def _encerrada(sol: dict) -> bool:
    return _normalizar(str(sol.get("SolEncerrada", ""))) == "sim" or \
        _normalizar(str(sol.get("SolStatus", ""))).startswith("finaliz")


def testar_acessorias(escritorio_id: str, cliente: Optional[AcessoriasCliente] = None) -> list[str]:
    """Confere o token listando os departamentos do Acessórias."""
    cliente = cliente or AcessoriasCliente(_segredos(escritorio_id, ACESSORIAS).get("token", ""))
    return cliente.departamentos()


def sincronizar_acessorias(escritorio_id: str, autor: str = "sinc:acessorias",
                           cliente: Optional[AcessoriasCliente] = None,
                           hoje: Optional[date] = None) -> dict:
    """Busca as solicitações externas atualizadas no Acessórias e cria/
    atualiza as admissões. Devolve as contagens. Uma rodada por escritório
    de cada vez (trava no Postgres)."""
    cfg = obter_config(escritorio_id, ACESSORIAS)
    if not cfg["ativo"]:
        raise ConfigInvalida("Integração com o Acessórias não está ativa")
    hoje = hoje or date.today()
    with auth.conectar() as trava:
        ok = trava.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS ok",
                           (f"adm_sinc:{escritorio_id}:{ACESSORIAS}",)).fetchone()["ok"]
        if not ok:
            return {"em_andamento": True}
        try:
            return _sincronizar_acessorias(escritorio_id, autor, cfg, cliente, hoje)
        finally:
            trava.execute("SELECT pg_advisory_unlock(hashtext(%s))",
                          (f"adm_sinc:{escritorio_id}:{ACESSORIAS}",))


def _sincronizar_acessorias(escritorio_id: str, autor: str, cfg: dict,
                            cliente: Optional[AcessoriasCliente], hoje: date) -> dict:
    with auth.conectar() as conn:
        desde_salvo = conn.execute(
            "SELECT sinc_desde FROM admissoes_canais_config WHERE escritorio_id = %s AND canal = %s",
            (escritorio_id, ACESSORIAS),
        ).fetchone()["sinc_desde"]
    dias = int(cfg["parametros"].get("dias_retroativos") or 7)
    # a API filtra por dia (SolUltAtIni) - recua 1 dia para não perder nada
    # na virada; repetir uma solicitação é inofensivo (deduplicação)
    # sinc_desde vem do banco em UTC: a data é a do relógio local, como "hoje"
    desde = (desde_salvo.astimezone().date() - timedelta(days=1)) if desde_salvo else hoje - timedelta(days=dias)
    departamentos = _lista(cfg["parametros"].get("departamentos", ""))
    palavras = _lista(cfg["parametros"].get("palavras", ""))
    inicio = datetime.now().astimezone()
    contagem = {"lidas": 0, "admissoes": 0, "novas": 0, "atualizadas": 0, "sem_empresa": 0}
    try:
        cliente = cliente or AcessoriasCliente(_segredos(escritorio_id, ACESSORIAS).get("token", ""))
        for pagina in range(1, _MAX_PAGINAS + 1):
            lote = cliente.solicitacoes(desde, pagina)
            if not lote:
                break
            for sol in lote:
                contagem["lidas"] += 1
                sol_id = str(sol.get("SolID") or "").strip()
                if not sol_id or not eh_admissao(sol, departamentos, palavras):
                    continue
                antes = admissoes.obter_por_externo(escritorio_id, ACESSORIAS, sol_id)
                if _encerrada(sol) and not antes:
                    continue
                contagem["admissoes"] += 1
                cnpj = clientes.so_digitos(str(sol.get("EmpCNPJ") or ""))
                ref = cnpj or f"acessorias-empresa:{sol.get('EmpID') or '?'}"
                linha, duplicada = admissoes.receber_solicitacao(
                    escritorio_id, ACESSORIAS, sol_id, ref, _anexos(sol), autor,
                    resumo=str(sol.get("SolAssunto") or ""), empresa_nome=str(sol.get("EmpNome") or ""),
                )
                if not duplicada:
                    contagem["novas"] += 1
                    if not linha["cliente_id"]:
                        contagem["sem_empresa"] += 1
                elif antes and linha["documentos"] != antes["documentos"]:
                    contagem["atualizadas"] += 1
    except (ErroCanal, admissoes.TransicaoInvalida) as e:
        _registrar_sinc(escritorio_id, ACESSORIAS, False, str(e))
        raise ErroCanal(str(e)) from None
    contagem["religadas"] = admissoes.religar_empresas(escritorio_id, autor)
    msg = (f"{contagem['lidas']} solicitação(ões) lida(s), {contagem['admissoes']} de admissão: "
           f"{contagem['novas']} nova(s), {contagem['atualizadas']} com documento novo")
    if contagem["sem_empresa"]:
        msg += f", {contagem['sem_empresa']} sem empresa no cadastro (CNPJ)"
    _registrar_sinc(escritorio_id, ACESSORIAS, True, msg, desde=inicio)
    return contagem


def importar_empresas_acessorias(escritorio_id: str, usuario: str, id_e_codigo_dominio: bool,
                                 cliente: Optional[AcessoriasCliente] = None) -> dict:
    """Traz as empresas ativas do Acessórias para o cadastro de clientes do
    Hub, para as solicitações serem reconhecidas pelo CNPJ e o agente saber
    qual empresa abrir no Domínio:

    - empresa já cadastrada com o CNPJ: nada muda;
    - cadastrada sem CNPJ e com o mesmo nome (razão ou fantasia): ganha o CNPJ;
    - não cadastrada: se o ID do Acessórias é o código no Domínio
      (id_e_codigo_dominio), é criada com esse código; senão fica de fora
      e entra na contagem sem_codigo (o DP cadastra com o código certo).

    Depois religa as solicitações que estavam bloqueadas por falta da empresa."""
    cliente = cliente or AcessoriasCliente(_segredos(escritorio_id, ACESSORIAS).get("token", ""))
    contagem = {"lidas": 0, "criadas": 0, "cnpj_preenchido": 0, "ja_cadastradas": 0,
                "sem_codigo": 0, "codigo_em_uso": 0}
    existentes = clientes.listar_clientes(escritorio_id)
    por_cnpj = {c["cnpj"] for c in existentes if c.get("cnpj")}
    por_nome = {_normalizar(c["nome"]): c for c in existentes if not c.get("cnpj")}
    codigos = {str(c["codigo_dominio"]) for c in existentes}
    for pagina in range(1, _MAX_PAGINAS * 4 + 1):  # 50 por página
        lote = cliente.empresas(pagina)
        if not lote:
            break
        for emp in lote:
            contagem["lidas"] += 1
            cnpj = clientes.so_digitos(str(emp.get("Identificador") or ""))
            razao = " ".join(str(emp.get("Razao") or emp.get("Fantasia") or "").split())[:200]
            if len(cnpj) not in (11, 14) or not razao:
                continue
            if cnpj in por_cnpj:
                contagem["ja_cadastradas"] += 1
                continue
            mesmo_nome = por_nome.get(_normalizar(razao)) or por_nome.get(_normalizar(str(emp.get("Fantasia") or "")))
            if mesmo_nome:
                clientes.atualizar_cliente(mesmo_nome["id"], escritorio_id, mesmo_nome["nome"],
                                           mesmo_nome["codigo_dominio"], cnpj)
                por_nome.pop(_normalizar(mesmo_nome["nome"]), None)
                por_cnpj.add(cnpj)
                contagem["cnpj_preenchido"] += 1
                continue
            codigo = str(emp.get("ID") or "").strip()
            if not id_e_codigo_dominio or not codigo:
                contagem["sem_codigo"] += 1
                continue
            if codigo in codigos:
                contagem["codigo_em_uso"] += 1
                continue
            ok, _ = clientes.criar_cliente(escritorio_id, razao, codigo, cnpj)
            if ok:
                codigos.add(codigo)
                por_cnpj.add(cnpj)
                contagem["criadas"] += 1
    contagem["religadas"] = admissoes.religar_empresas(escritorio_id, usuario)
    return contagem


def sincronizar_todos() -> None:
    """Uma rodada para todos os escritórios com o Acessórias ativo (chamada
    periódica da api.py). Falha de um escritório não para os outros."""
    with auth.conectar() as conn:
        escritorios = [l["escritorio_id"] for l in conn.execute(
            "SELECT escritorio_id FROM admissoes_canais_config WHERE canal = %s AND ativo",
            (ACESSORIAS,),
        ).fetchall()]
    for esc in escritorios:
        try:
            sincronizar_acessorias(esc)
        except Exception as e:  # noqa: BLE001 - registra e segue para o próximo
            log.warning("Sincronização Acessórias falhou para %s: %s", esc, type(e).__name__)

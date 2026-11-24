# Deploy - Conciliação Bancária

Pipeline: `git push` na `main` → GitHub Actions builda a imagem Docker,
publica no GitHub Container Registry (GHCR) e reinicia os containers no
VPS via SSH. Os dados de usuários/escritórios ficam num **Postgres**
rodando no próprio VPS (container `db`, volume `pgdata`) - sobrevivem a
redeploys da imagem da aplicação (só o container `app` é trocado).

## 1. Provisionar o VPS (HomeHost)

1. Contrate o plano (recomendado: 2 vCPU / 4 GB RAM ou superior — **4 GB é o
   mínimo** se o hub de RPA estiver em uso: o worker sobe um Chromium
   headless por execução, cada instância consome ~300-500 MB de RAM além do
   que o app/Postgres/Caddy já usam).
2. Ao criar o servidor, escolha um Linux 64-bit (Ubuntu 22.04/24.04 ou
   AlmaLinux 9 - o passo de instalar Docker abaixo cobre os dois).
3. Anote o **IP** do servidor.
4. No provedor que gerencia o **DNS do domínio** (confira com `nslookup -type=NS
   seudominio.com` quem são os nameservers - nem sempre é o mesmo provedor do
   VPS), crie um registro **A** apontando um subdomínio (ex:
   `conciliacao.seudominio.com.br`) para esse IP. O Caddy só emite
   certificado HTTPS depois que o DNS propagar.

## 2. Preparar o VPS (uma vez só)

Conecte via SSH (`ssh root@SEU_IP`) e instale o Docker:

```bash
# Ubuntu/Debian:
curl -fsSL https://get.docker.com | sh

# AlmaLinux/RHEL/CentOS (o script acima nao suporta essas distros):
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

Libere as portas 80/443 no firewall, se houver um ativo (`firewalld` é
padrão em AlmaLinux/RHEL):

```bash
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

Crie a pasta do projeto e o pacote da imagem como **público** no GHCR (mais
simples que gerenciar um token de leitura no VPS - a imagem não carrega
nenhum dado sensível, só o código):

```bash
mkdir -p /opt/conciliacao-bancaria
```

No GitHub: **Package → conciliacao-bancaria → Package settings → Change
visibility → Public**. Repita para o pacote
**conciliacao-bancaria-worker** depois do primeiro build (ele só aparece na
lista de pacotes após o primeiro push que dispara o workflow).

Copie `docker-compose.yml` e `Caddyfile` deste repositório para
`/opt/conciliacao-bancaria/` no servidor (a primeira vez precisa ser manual;
depois disso o GitHub Actions atualiza esses 2 arquivos sozinho a cada
deploy):

```bash
scp docker-compose.yml Caddyfile root@SEU_IP:/opt/conciliacao-bancaria/
```

Crie o arquivo `.env` nessa mesma pasta (gere uma senha forte para o
Postgres, ex.: `openssl rand -base64 24`):

```bash
cat > /opt/conciliacao-bancaria/.env << 'EOF'
DOMINIO=conciliacao.seudominio.com.br
POSTGRES_PASSWORD=cole-aqui-uma-senha-forte
RPA_ENC_KEY=cole-aqui-a-chave-gerada-abaixo
EOF
```

`RPA_ENC_KEY` cifra as credenciais de procurador salvas no hub de RPA (ex.:
login do ISS Web). Gere uma antes de colar acima:

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

**Guarde uma cópia dessa chave em lugar seguro fora do VPS** (ex.: gerenciador
de senhas do escritório) — perdê-la torna as credenciais já cadastradas
irrecuperáveis (não tem "esqueci minha senha" pra isso, precisa recadastrar
tudo). Trocar a chave depois de já ter credenciais salvas também as invalida.

Suba pela primeira vez:

```bash
cd /opt/conciliacao-bancaria
docker compose up -d
```

Acesse `https://SEU_DOMINIO` - o Caddy emite o certificado automaticamente
na primeira requisição (pode levar alguns segundos a primeira vez).

## 3. Configurar os secrets no GitHub

No repositório → **Settings → Secrets and variables → Actions → New
repository secret**, crie:

| Nome | Valor |
|---|---|
| `VPS_HOST` | IP do VPS |
| `VPS_USER` | `root` (ou o usuário SSH que você usa) |
| `VPS_SSH_KEY` | conteúdo da **chave SSH privada** com acesso ao VPS |

A chave pública correspondente precisa estar em
`~/.ssh/authorized_keys` no VPS. Se ainda não tem um par de chaves
dedicado para isso, gere um:

```bash
ssh-keygen -t ed25519 -f deploy_key -N ""
# copia a PUBLICA para o VPS:
ssh-copy-id -i deploy_key.pub root@SEU_IP
# cola o conteudo de deploy_key (a PRIVADA) no secret VPS_SSH_KEY
```

## 4. Deploy automático

A partir daqui, todo `git push` (ou merge de PR) na branch `main` já:
1. Builda as imagens Docker: a do app (`Dockerfile`) e a do worker de RPA
   (`Dockerfile.worker`, com Playwright/Chromium).
2. Publica em `ghcr.io/redeg7/conciliacao-bancaria:latest` e
   `ghcr.io/redeg7/conciliacao-bancaria-worker:latest`.
3. Copia `docker-compose.yml`/`Caddyfile` atualizados para o VPS.
4. Roda `docker compose pull && docker compose up -d` no VPS (o Postgres
   só é recriado se o volume `pgdata` não existir - dados preservados).

Acompanhe em **Actions** no GitHub.

## 5. Primeiro acesso

- Usuário: `admin`
- Senha: `admin123`

O sistema **obriga a troca de senha** no primeiro login. Depois disso, use
"🌐 Gerenciar Escritórios" para cadastrar cada escritório-cliente com seu
próprio admin.

## Migrando de uma instalação antiga (JSON em arquivo → Postgres)

Se o VPS já estava rodando a versão anterior (dados em
`usuarios.json`/`escritorios.json` dentro de um volume Docker), faça
backup desses dois arquivos **antes** de atualizar, depois rode a
migração contra o Postgres já no ar:

```bash
# 1. backup dos arquivos antigos (rodar ANTES de subir a nova versao)
docker exec conciliacao-bancaria cat /app/data/usuarios.json > usuarios.json
docker exec conciliacao-bancaria cat /app/data/escritorios.json > escritorios.json

# 2. atualiza para a versao com Postgres (docker-compose.yml novo + .env
#    com POSTGRES_PASSWORD), sobe os containers normalmente

# 3. roda a migracao (idempotente - seguro rodar mais de uma vez)
docker run --rm --network conciliacao-bancaria_default \
  -v $(pwd):/app -w /app \
  -e DATABASE_URL=postgresql://conciliacao:SENHA_DO_ENV@db:5432/conciliacao \
  python:3.11-slim bash -c \
  'pip install -q "psycopg[binary]" && python scripts/migrate_json_to_postgres.py usuarios.json escritorios.json'
```

As senhas já cadastradas continuam funcionando (o script copia hash+salt
como estão, não re-hasheia nada).

## Backup dos dados (Postgres)

```bash
docker exec conciliacao-db pg_dump -U conciliacao conciliacao > backup-$(date +%Y%m%d).sql
```

Para restaurar: `docker exec -i conciliacao-db psql -U conciliacao conciliacao < backup.sql`

## Atualizar manualmente (sem esperar o push)

```bash
cd /opt/conciliacao-bancaria
docker compose pull && docker compose up -d
```

## RPA NF GO (download de XML de NF-e na SEFAZ-GO)

Card próprio na home do Hub ("🧾 RPA NF GO"). Módulo `sefazgo_nfe`
(`rpa/sefazgo_nfe/`), processado pelo mesmo worker dos outros RPAs - já
incluído em `WORKER_MODULOS` no `docker-compose.yml`.

1. **Credenciais** (na própria tela, cifradas com `RPA_ENC_KEY`, nunca no
   código): CPF + senha do Acesso Restrito da SEFAZ-GO (obrigatório) e o
   certificado A1 (.pfx) do escritório (opcional - apresentado quando o
   portal pede certificado, no lugar da janela de seleção do navegador).
2. **Planilha**: `Código da Empresa`, `Razão Social`, `CNPJ`,
   `Inscrição Estadual` (dá pra baixar o modelo na tela). Cada empresa vira
   duas consultas na fila: ENTRADA e depois SAIDA.
3. **Competência**: vem preenchida com o mês anterior; o período usado é
   do dia 1 ao último dia do mês escolhido.
4. **Resultado por consulta**: `ENTRADA_MMAAAA.zip` / `SAIDA_MMAAAA.zip`,
   print da tela de resultado (evidência), total de notas mostrado pela
   SEFAZ e total de XMLs de nota dentro do ZIP. Se o ZIP vier com MENOS
   notas que a SEFAZ mostrou, a consulta fica como erro (download
   incompleto) e pode ser reprocessada; os arquivos baixados ficam salvos.
5. **Onde ficam os arquivos**: rodando no VPS, no botão "Baixar tudo
   (.zip)" da execução, na estrutura
   `RPA NF GO/<código - empresa>/<MMAAAA>/ENTRADA|SAIDA/`.

**Gravar direto numa pasta do PC do escritório** (ex.: `C:\RPA NF GO`):
rode o worker nesse PC em vez do VPS. Tire `sefazgo_nfe` do
`WORKER_MODULOS` do VPS (senão os dois disputam a fila), abra o túnel pro
Postgres e suba o worker local:

```powershell
ssh -N -L 5432:127.0.0.1:5432 root@SEU_IP   # deixe aberto numa janela
# em outra janela, na pasta do repositorio (pip install -r requirements-worker.txt; playwright install chromium):
$env:DATABASE_URL="postgresql://conciliacao:SENHA_DO_ENV@127.0.0.1:5432/conciliacao"
$env:RPA_ENC_KEY="mesma chave do .env do VPS"
$env:WORKER_MODULOS="sefazgo_nfe"
$env:RPA_SALVAR_EM_DISCO="1"
# a Cloudflare do formulario "Consulta de Notas Recebidas" as vezes pede
# "Verify you are human": o robo espera ate 300s alguem clicar na tela
# (ele mesmo nunca clica nessa verificacao)
$env:RPA_TEMPO_VERIFICACAO_HUMANA="300"
python rpa_worker.py
```

> No servidor (VPS) ninguem pode confirmar a verificacao da Cloudflare: se
> ela pedir "Verify you are human", a consulta fica com erro explicando isso
> - rode essas empresas pelo PC do escritorio.

Os arquivos vão para a "Pasta de destino dos XMLs" informada ao criar a
execução (ou para `RPA_PASTA_DESTINO`, se definida), com a mesma estrutura
de pastas, e continuam aparecendo no Hub.

> O fluxo foi escrito a partir do roteiro manual e validado contra uma
> simulação local do portal - acompanhe a primeira execução real: se a
> SEFAZ usar outro texto em algum botão/campo, a consulta fica com erro e
> o print da tela mostra exatamente em que passo parou.

## Real 4U — Marketing & Comercial (CRM)

Sistema separado (Node.js, pasta `marketing/`) que roda no mesmo VPS do
Hub: serviço `marketing` do `docker-compose.yml`, imagem
`ghcr.io/redeg7/real4u-marketing:latest` (buildada pelo mesmo workflow a
cada push na `main`). Tem **login e banco próprios** (SQLite em
`auth.db`/`real.db`/`demo.db`, no volume Docker `marketing_data`) — não
usa o Postgres nem os usuários do Hub. Na home do Hub aparece o card
"📣 Marketing & Comercial", que abre o CRM numa aba nova.

Fica num **subdomínio próprio**: `mkt.redeg7.com` (padrão do
`docker-compose.yml`; dá pra trocar com `DOMINIO_MARKETING` no `.env`): o
CRM usa `/api` e `/r` na raiz, que colidiriam com as rotas do Hub num
caminho do mesmo domínio.

Ativar (uma vez só):

1. O pacote `real4u-marketing` no GHCR **pode ficar privado**: o deploy
   faz login no GHCR do VPS com o token do próprio workflow (só durante o
   deploy) para baixar as imagens.
2. No DNS do `redeg7.com`, crie um registro **A** `mkt` apontando pro
   mesmo IP do Hub.
3. Nada a fazer no `.env`: o próprio deploy acrescenta
   `COMPOSE_PROFILES=marketing` no `.env` do VPS assim que a imagem do CRM
   puder ser baixada. Se não puder (ex.: o repositório perdeu o acesso ao
   pacote em Package settings → Manage Actions access), o deploy só avisa no
   log e segue com o Hub normal. Opcional - o
   formulário do site (`POST https://mkt.redeg7.com/api/webhooks/form`)
   precisa de `FORM_WEBHOOK_TOKEN=...` (gere com `openssl rand -hex 32`) no
   `.env`, colocado à mão.
4. Rode o workflow de novo (Actions → Build e Deploy → Re-run, ou o próximo
   merge na `main`) - ou suba na mão: `cd /opt/conciliacao-bancaria && docker compose pull && docker compose up -d && docker compose restart caddy`
5. Acesse `https://mkt.redeg7.com` e crie o administrador do CRM no
   primeiro acesso (depois, Configurações › Usuários para a equipe).

**Login único:** quem está logado no Hub e clica no card entra direto no
CRM, sem senha. O card passa por `/api/sso/marketing` (api.py), que confere
a sessão do Hub e manda um bilhete assinado de 60s para
`https://mkt.redeg7.com/sso` (`marketing/src/sso.js`). No primeiro acesso o
usuário é criado no CRM: admin do Hub vira Administrador e os demais
Comercial (dá pra trocar o perfil em Configurações › Usuários). O segredo
compartilhado `MARKETING_SSO_SECRET` é gerado sozinho no `.env` pelo deploy.

**Dados separados por escritório:** cada escritório do Hub tem o próprio
arquivo de dados no CRM (`real-<id do escritório>.db` no volume
`marketing_data`). Quem entra pelo card só vê contatos, campanhas, funil,
usuários e logo do próprio escritório - igual às outras telas do Hub. O
escritório vem do usuário do Hub a cada entrada (se ele mudar de escritório
no Hub, passa a ver o escritório novo). O **super administrador** do Hub vê todos
os escritórios: no menu do CRM aparece "Escritório" para escolher qual
abrir (igual aos outros módulos do Hub). **Formulário do site:** cada escritório gera o próprio código em
Integrações › Formulários (botão "Gerar código"); o lead enviado com esse
código entra só naquele escritório. (Legado: `FORM_WEBHOOK_TOKEN` no `.env`,
com `?escritorio=<id>` ou `FORM_DEFAULT_OFFICE`.)

**Meta Ads:** cada escritório conecta a própria conta em Integrações › Meta
Ads (ID da conta de anúncios + token de um usuário do sistema do Business
Manager com `ads_read`). O token fica cifrado no `auth.db` (chave derivada de
`MARKETING_SSO_SECRET`). Sincroniza sozinho a cada 6 horas (últimos 7 dias;
`META_SYNC_HOURS` muda o intervalo) e pelo botão "Sincronizar agora" (30 dias).

**Google Ads:** precisa, **uma vez para a plataforma toda**, das credenciais
da RedeG7 no `.env` do VPS; depois cada escritório conecta a própria conta em
Integrações › Google Ads (ID do cliente + botão "Conectar com Google").

1. No Google Ads da conta administradora (MCC) da RedeG7: **Administrador ›
   Central de API** › solicitar o **developer token** (nível "Básico" para usar
   em contas reais - o Google analisa o pedido).
2. No **Google Cloud Console**: criar um projeto, **ativar a "Google Ads API"**,
   configurar a **tela de consentimento OAuth** (tipo Externo, publicada) e
   criar uma **credencial OAuth "Aplicativo da Web"** com o URI de
   redirecionamento `https://mkt.redeg7.com/oauth/google/callback`.
3. No `.env` do VPS:

   ```bash
   GOOGLE_ADS_DEVELOPER_TOKEN=...
   GOOGLE_ADS_CLIENT_ID=....apps.googleusercontent.com
   GOOGLE_ADS_CLIENT_SECRET=...
   # opcional: MCC usada por padrão no acesso às contas dos clientes
   GOOGLE_ADS_LOGIN_CUSTOMER_ID=1234567890
   ```

   e rodar o deploy de novo (ou `docker compose up -d marketing`).

Sincroniza a cada 6 horas (últimos 7 dias) e pelo botão "Sincronizar agora"
(30 dias): gasto, impressões e cliques por dia, campanha e grupo de anúncios.

**Administrador:** é definido no Hub (admin do escritório ou super
administrador) e vale para a plataforma inteira - no CRM o perfil
Administrador acompanha o Hub a cada entrada pelo card.

Se um escritório tiver "apps permitidos" restritos, libere o app
"Marketing & Comercial" em Gerenciar Escritórios/Usuários para o card
aparecer.

Backup dos dados do CRM (os 3 arquivos SQLite):

```bash
docker run --rm -v conciliacao-bancaria_marketing_data:/data -v $(pwd):/b alpine \
  tar czf /b/marketing-$(date +%Y%m%d).tgz -C /data .
```

## Simulador INSS Obras (inssobras.redeg7.com)

App separado (Node.js, pasta `inss-obras/`, ver `inss-obras/README.md`):
serviço `inssobras` do `docker-compose.yml`, imagem
`ghcr.io/redeg7/inss-obras:latest` (buildada pelo mesmo workflow), banco
SQLite próprio no volume `inssobras_data`. Na home do Hub aparece o card
"🏗️ Simulador INSS Obras" (departamento Fiscal), que abre o simulador numa aba
nova **já logado** (`/api/sso/inssobras` em `api.py`), no escritório do usuário.

Ativar (uma vez só):

1. No DNS do `redeg7.com`, crie um registro **A** `inssobras` apontando pro
   mesmo IP do Hub (o Caddy emite o HTTPS sozinho).
2. Nada a fazer no `.env`: o deploy acrescenta `inssobras` em
   `COMPOSE_PROFILES` assim que a imagem puder ser baixada e gera o
   `INSSOBRAS_SSO_SECRET`. (Outro endereço: `DOMINIO_INSSOBRAS=...` no `.env`.)
3. Depois do primeiro deploy, entre pelo card como **super administrador**,
   vá em Cadastros › Parâmetros: importe a tabela **VAU** (sem ela o simulador
   de obra predial não calcula), a **Selic** e confira com o time fiscal os
   percentuais marcados "validar com o fiscal".
4. Cada escritório pega o **link público** do simulador no Dashboard (ou em
   Cadastros › Escritório, onde também define nome, logo e WhatsApp): quem
   simula por ele vira lead do escritório.

**Certificados digitais (DCTF Web):** o arquivo A1 e a senha dos clientes
ficam cifrados (AES-256-GCM) com `INSSOBRAS_CERT_KEY`, gerada sozinha no
`.env` pelo deploy. **Guarde uma cópia dessa linha do `.env` fora do VPS**:
sem ela os certificados gravados não abrem mais e precisam ser reenviados.

Liberar/bloquear por escritório ou usuário: id `inssobras` em Gerenciar
Escritórios/Usuários do Hub (mesma regra dos outros apps).

## RH (rh.redeg7.com)

App separado (Node.js, pasta `rh/`, ver `rh/README.md`): serviço `rh` do
`docker-compose.yml`, imagem `ghcr.io/redeg7/rh:latest` (buildada pelo mesmo
workflow), banco SQLite próprio no volume `rh_data`. Na home do Hub aparece o
card "👥 RH" (departamento Pessoal), que abre o RH numa aba nova **já logado**
(`/api/sso/rh` em `api.py`), no escritório do usuário.

Ativar (uma vez só):

1. No DNS do `redeg7.com`, crie um registro **A** `rh` apontando pro mesmo IP
   do Hub (o Caddy emite o HTTPS sozinho).
2. Nada a fazer no `.env`: o deploy acrescenta `rh` em `COMPOSE_PROFILES`
   assim que a imagem puder ser baixada e gera o `RH_SSO_SECRET`. (Outro
   endereço: `DOMINIO_RH=...` no `.env`.)
3. Depois do primeiro deploy, entre pelo card como administrador do escritório,
   importe os colaboradores em Configurações › Importar colaboradores e defina o
   papel de cada usuário em Configurações › Usuários e papéis (quem entra começa
   em "Apenas visualização", sem salários, documentos nem saúde).

Liberar/bloquear por escritório ou usuário: id `rh` em Gerenciar
Escritórios/Usuários do Hub (mesma regra dos outros apps).

Backup do volume (dados pessoais e de saúde: guarde com o mesmo cuidado):

```bash
docker run --rm -v conciliacao-bancaria_rh_data:/data -v $(pwd):/b alpine \
  tar czf /b/rh-$(date +%Y%m%d).tgz -C /data .
```

## Admissões (card "🧑‍💼 Admissões", departamento Pessoal)

Atalho `admissao.redeg7.com`: o Caddy redireciona para
`https://hub.redeg7.com/?tela=admissoes` (vale o login do Hub). Precisa do
registro DNS **A** `admissao` apontando pro mesmo IP do Hub; outro endereço:
`DOMINIO_ADMISSAO=...` no `.env`.

Faz parte do próprio Hub (mesma imagem, mesmo Postgres): as tabelas
`admissoes`, `admissoes_eventos` e `admissoes_chaves` são criadas sozinhas
no primeiro acesso (`admissoes.garantir_schema()`). Regras em
`admissoes.py`; rotas em `api.py` (`/api/admissoes/*`); tela em
`app_conciliacao.py` (`_tela_admissoes`); agente em
`attended_worker/admissoes_agent.py`; procedimento do DP em
`skills/cadastro-empregado-dominio/SKILL.md`.

Fluxo: canal → `POST /api/admissoes/eventos` → fila (`queued`) → agente da
sessão RDS monta a prévia sem salvar (`awaiting_approval`) → DP aprova ou
rejeita na tela → só então o agente recebe a tarefa em fase `gravacao` para
salvar no Domínio e transmitir (`completed`). Pendências viram
`awaiting_documents`, `blocked` ou `failed`, e o DP devolve pela tela.

1. **Chave dos canais**: em Admissões › Canais e agente, um administrador do
   escritório gera a chave (aparece uma vez só; o banco guarda só o hash).
   Os conectores enviam com `X-API-Key`:

   ```json
   {"channel": "acessorias", "external_id": "AC-123", "company_ref": "101", "document_refs": ["..."]}
   ```

   `company_ref` é o **código da empresa no Domínio** cadastrado em Gerenciar
   Clientes. Empresa fora do cadastro entra `blocked`. Repetir canal +
   `external_id` não cria outra solicitação (resposta `duplicate: true`). Os
   conectores de Acessórias, ONVIO e WhatsApp ainda não existem: por
   enquanto, use "Registrar solicitação" na tela.
2. **Agente**: crie no Hub uma conta só para ele (papel **Usuário**, com o
   app Admissões liberado). Na sessão RDS, na pasta `attended_worker`:

   ```powershell
   $env:HUB_USUARIO = "agente-rds"
   python admissoes_agent.py
   ```

   Nesta versão o agente **não mexe no Domínio**: toda tarefa volta como
   `blocked` ("automação do Domínio ainda não implementada").
3. **Aprovação**: só administrador do escritório ou super administrador, e
   nunca a conta que preparou a prévia. A aprovação vale só para a prévia
   que a pessoa viu (hash). Se a gravação falhar, a tarefa volta para
   aprovação, e não para a fila: confira no Domínio o que já foi gravado
   antes de aprovar de novo.

Testes (Postgres de teste descartável; o banco é apagado a cada teste):

```powershell
docker run -d --name hub-test-db -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=hub_test -p 55432:5432 postgres:16-alpine
$env:TEST_DATABASE_URL = "postgresql://postgres:teste@127.0.0.1:55432/hub_test"
pip install pytest httpx
python -m pytest tests
```

### Integração com o Acessórias

Cada escritório configura em **RPA Folha › Admissões › Canais e agente › Acessórias**:
o API Token (Acessórias › engrenagem › API Token, de preferência de um usuário só
para a integração), os departamentos e as palavras do assunto que indicam admissão.
O token fica cifrado com a `RPA_ENC_KEY` (a mesma das credenciais do RPA).

- A API do Acessórias não tem webhook: o serviço `api` consulta as solicitações
  externas a cada `ADMISSOES_SINC_INTERVALO_S` segundos (padrão 300; `0` desliga).
  Há também o botão "Sincronizar agora" na tela.
- A empresa é reconhecida pelo **CNPJ** do cadastro em Gerenciar Clientes. Sem CNPJ
  cadastrado, a solicitação entra como "Bloqueada" até o cadastro ser corrigido.
- ONVIO e WhatsApp: os campos já ficam salvos, mas a integração ainda não consulta nada.

## WhatsApp Disparos / AutoEnvioPro (autoenviopro.com.br)

App trazido do Replit ("WhatsApp Planilha Envio"), pasta `whatsapp/` (monorepo
pnpm: front React/Vite + API Express, ver `whatsapp/replit.md`): serviço
`whatsapp` do `docker-compose.yml`, imagem `ghcr.io/redeg7/whatsapp-disparos:latest`
(buildada pelo mesmo workflow). Usa um banco próprio (`whatsapp`) **dentro do
mesmo Postgres do Hub**, criado sozinho pelo container na primeira subida
(`whatsapp/lib/db/ensure-db.mjs` + `drizzle-kit push`). A sessão do WhatsApp
conectado e as imagens dos modelos ficam no volume `whatsapp_data`. Na home do
Hub aparece o card "💬 WhatsApp Disparos" (Marketing & Comercial), que entra
**já logado** (`/api/sso/whatsapp` em `api.py`): o super administrador do Hub
entra como super_admin, os demais como usuário comum.

Ativar (uma vez só):

1. No DNS do `autoenviopro.com.br` (mesmo provedor, servidorestavel.net),
   registros **A** do domínio e do `www` apontando pro mesmo IP do Hub
   (192.96.217.88 - já feito). O Caddy emite o HTTPS sozinho; o `www`
   redireciona para o domínio sem www.
2. Nada a fazer no `.env`: o deploy acrescenta `whatsapp` em
   `COMPOSE_PROFILES` e gera `WHATSAPP_SSO_SECRET`, `WHATSAPP_SESSION_SECRET` e
   `WHATSAPP_ADMIN_PASSWORD` (senha do usuário `admin`, criado só com o banco
   vazio - veja com `grep WHATSAPP_ADMIN_PASSWORD /opt/conciliacao-bancaria/.env`).
   (Outro endereço: `DOMINIO_WHATSAPP=...` no `.env`.)
3. Depois do primeiro deploy, entre pelo card como super administrador, abra
   **Configurações** e leia o QR Code com o celular do WhatsApp que vai
   disparar. A conexão é **uma só para o app inteiro** e fica com o usuário
   que leu o QR Code: para os demais usuários ela aparece como desconectada
   (regra do próprio app, que veio assim do Replit).

**Trazer os dados do Replit (opcional):** no Shell do Repl, gere o dump e
baixe o arquivo; depois, na VPS, restaure **antes** do primeiro acesso (com o
banco ainda vazio, para não misturar com o `admin` criado sozinho):

```bash
# no Shell do Replit
pg_dump "$DATABASE_URL" --no-owner --no-acl --data-only > whatsapp-replit.sql

# na VPS (depois que o container subiu e criou as tabelas)
docker exec -i conciliacao-db psql -U conciliacao -d whatsapp \
  -c "TRUNCATE users, templates, campaigns, contacts, global_contacts, conversations, messages RESTART IDENTITY CASCADE"
docker exec -i conciliacao-db psql -U conciliacao -d whatsapp < whatsapp-replit.sql
```

A sessão do WhatsApp do Replit **não** é copiada (pasta `whatsapp-session`,
credenciais da conta - nunca vai pro git): basta ler o QR Code de novo na VPS.
Desconecte o app do Replit antes, para os dois não disputarem a mesma conta.

Liberar/bloquear por escritório ou usuário: id `whatsapp` em Gerenciar
Escritórios/Usuários do Hub (mesma regra dos outros apps).

Backup:

```bash
docker exec conciliacao-db pg_dump -U conciliacao whatsapp > whatsapp-$(date +%Y%m%d).sql
docker run --rm -v conciliacao-bancaria_whatsapp_data:/data -v $(pwd):/b alpine \
  tar czf /b/whatsapp-data-$(date +%Y%m%d).tgz -C /data .
```

## Calculadora RTC — Regime Regular (card dentro do "🧾 RPA Fiscal")

Cálculo da CBS, do IBS e do Imposto Seletivo (LC 214/2025) pela **calculadora
oficial da Receita Federal**
([ReceitaFederal/calculadora-rtc-regime-regular](https://github.com/ReceitaFederal/calculadora-rtc-regime-regular),
licença MIT), sem alteração no código dela:

- `calculadora-rtc/Dockerfile` baixa o código da Receita na versão fixada em
  `RTC_REF`, gera o banco SQLite das tabelas oficiais (Flyway) e compila o
  `.jar` (Java 25). O deploy publica a imagem `ghcr.io/redeg7/calculadora-rtc`
  e liga sozinho o profile `calculadorartc` no `.env` do VPS.
- O serviço `calculadora-rtc` fica **só na rede interna** do Docker (a API da
  Receita não tem login): sem porta publicada e sem rota no Caddy. O Hub fala
  com ela por `CALCULADORA_RTC_URL` (`http://calculadora-rtc:8080/api/calculadora`).
  Usa até ~512 MB de heap Java (`mem_limit: 768m`).
- A tela fica em `_tela_calculadora_rtc` (app_conciliacao.py); a montagem do
  pedido e a leitura da resposta em `calculadora_rtc.py` (testes em
  `tests/test_calculadora_rtc.py`, sem banco).
- **Atualizar a calculadora** (versão nova da Receita, tabela cClassTrib nova):
  troque `RTC_REF` no Dockerfile, suba `VERSAO`/`NOVIDADES` em
  `calculadora_rtc.py` e faça o push na `main`.
- Conferir no VPS: `docker compose ps calculadora-rtc` e
  `docker compose exec app python -c "import calculadora_rtc as c; print(c.versao())"`.
- Escritório/usuário com lista de apps restrita só vê o card depois de liberar
  "Calculadora RTC — Regime Regular" em Gerenciar Escritórios/Usuários.

## Calculadora RTC — Simples Nacional (card dentro do "🧾 RPA Fiscal")

CBS e IBS do optante pelo Simples (LC 214/2025, NT 2026.005) pela calculadora
oficial da Receita
([ReceitaFederal/calculadora-rtc-simples-nacional](https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional),
licença MIT), sem alteração no código dela. Funciona como a do Regime Regular:

- `calculadora-rtc-sn/Dockerfile` baixa o motor do Simples (`SN_REF`) e gera o
  banco com o Flyway do repo do Regime Regular (`RTC_REF`, como manda o README
  da Receita: o repo do Simples não traz o banco). Imagem
  `ghcr.io/redeg7/calculadora-rtc-sn`, profile `calculadorartcsn` ligado
  sozinho pelo deploy.
- Serviço `calculadora-rtc-sn` só na rede interna, porta 8082; o Hub fala com
  ele por `CALCULADORA_RTC_SN_URL` (`http://calculadora-rtc-sn:8082/api`).
- Usa o cálculo **não assistido** (`/calculadora/observabilidade/simples-nacional/nao-assistido`):
  o usuário informa as alíquotas efetivas de CBS/IBS de cada anexo (as do
  PGDAS-D). O assistido (alíquotas do PGDAS pelo CNPJ) só existe na versão
  online da Receita. O CBS/IBS do Simples começa em 2027: a tela não aceita
  data anterior.
- A lista de cClassTrib da tela vem da calculadora do Regime Regular (se ela
  estiver fora, o cClassTrib é digitado).
- Tela em `_tela_calculadora_rtc_sn` (app_conciliacao.py); pedido e resposta
  em `calculadora_rtc_sn.py` (testes em `tests/test_calculadora_rtc_sn.py`).
  Atualizar: troque `SN_REF`/`RTC_REF` no Dockerfile, suba `VERSAO`/`NOVIDADES`
  em `calculadora_rtc_sn.py` e faça o push na `main`.
- Conferir no VPS: `docker compose ps calculadora-rtc-sn` e
  `docker compose exec app python -c "import calculadora_rtc_sn as c; print(c.versao())"`.

## Gerador de DANFSe (card dentro do "🧾 RPA Fiscal")

PDF do DANFSe (NT 008 SE/CGNFS-e) a partir do XML da NFS-e nacional, pelo
gerador oficial da Receita
([ReceitaFederal/calculadora-rtc-gerador-danfse](https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse),
licença MIT), sem alteração no código dela:

- `gerador-danfse/Dockerfile` baixa o repo na versão fixada (`DANFSE_REF`) e
  compila o serviço Go como o Dockerfile da Receita. Imagem
  `ghcr.io/redeg7/gerador-danfse`, profile `geradordanfse` ligado sozinho pelo
  deploy.
- Serviço `gerador-danfse` só na rede interna, porta 8083; o Hub fala com ele
  por `GERADOR_DANFSE_URL` (`http://gerador-danfse:8083`): `POST /api/danfse`
  com o XML (`stc` = 0 válida, 1 substituída, 2 cancelada; `canhoto`).
- A tela aceita vários XMLs (soltos ou em .zip, até 500 notas, 5 MB por XML) e
  devolve um PDF ou um .zip com todos. Nada fica gravado: os arquivos ficam só
  na sessão do usuário.
- Tela em `_tela_gerador_danfse` (app_conciliacao.py); leitura dos XMLs e .zip
  em `gerador_danfse.py` (testes em `tests/test_gerador_danfse.py`). Atualizar:
  troque `DANFSE_REF` no Dockerfile (e `MOTOR` em `gerador_danfse.py`), suba
  `VERSAO`/`NOVIDADES` e faça o push na `main`.
- Conferir no VPS: `docker compose ps gerador-danfse` e
  `docker compose exec app python -c "import gerador_danfse as g; print(g.disponivel())"`.
- Escritório/usuário com lista de apps restrita só vê o card depois de liberar
  "Gerador de DANFSe" em Gerenciar Escritórios/Usuários.

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

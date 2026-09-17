# Deploy - Conciliação Bancária

Pipeline: `git push` na `main` → GitHub Actions builda a imagem Docker,
publica no GitHub Container Registry (GHCR) e reinicia os containers no
VPS via SSH. Os dados de usuários/escritórios ficam num **Postgres**
rodando no próprio VPS (container `db`, volume `pgdata`) - sobrevivem a
redeploys da imagem da aplicação (só o container `app` é trocado).

## 1. Provisionar o VPS (HomeHost)

1. Contrate o plano (recomendado: 2 vCPU / 4 GB RAM ou superior).
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
visibility → Public**.

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
EOF
```

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
1. Builda a imagem Docker.
2. Publica em `ghcr.io/redeg7/conciliacao-bancaria:latest`.
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

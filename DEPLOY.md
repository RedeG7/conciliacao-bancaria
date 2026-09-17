# Deploy - Conciliação Bancária

Pipeline: `git push` na `main` → GitHub Actions builda a imagem Docker,
publica no GitHub Container Registry (GHCR) e reinicia os containers no
VPS via SSH. Os dados persistentes (`usuarios.json`, `escritorios.json`)
ficam num volume Docker no VPS - **sobrevivem a redeploys**.

## 1. Provisionar o VPS (HomeHost)

1. Contrate o plano (recomendado: 2 vCPU / 4 GB RAM ou superior).
2. Ao criar o servidor, escolha **Ubuntu Server 22.04 ou 24.04 (64-bit)**.
3. Anote o **IP** do servidor.
4. No seu provedor de domínio, crie um registro **A** apontando um
   subdomínio (ex: `conciliacao.seudominio.com.br`) para esse IP.
   O Caddy só emite certificado HTTPS depois que o DNS propagar
   (geralmente minutos, pode levar até algumas horas).

## 2. Preparar o VPS (uma vez só)

Conecte via SSH (`ssh root@SEU_IP`) e rode:

```bash
# Docker + plugin compose
curl -fsSL https://get.docker.com | sh

# pasta do projeto
mkdir -p /opt/conciliacao-bancaria
cd /opt/conciliacao-bancaria

# login no GHCR para poder puxar a imagem (o pacote comeca privado,
# ligado ao repo privado) - crie um Personal Access Token classic com
# escopo "read:packages" em https://github.com/settings/tokens
docker login ghcr.io -u SEU_USUARIO_GITHUB
```

Crie o arquivo `.env` nessa mesma pasta:

```bash
cat > .env << 'EOF'
DOMINIO=conciliacao.seudominio.com.br
EOF
```

Copie `docker-compose.yml` e `Caddyfile` deste repositório para
`/opt/conciliacao-bancaria/` no servidor (a primeira vez precisa ser manual;
depois disso o GitHub Actions atualiza esses 2 arquivos sozinho a cada
deploy). Pode usar `scp` do seu computador:

```bash
scp docker-compose.yml Caddyfile root@SEU_IP:/opt/conciliacao-bancaria/
```

Suba pela primeira vez:

```bash
cd /opt/conciliacao-bancaria
docker compose up -d
```

Acesse `https://SEU_DOMINIO` - o Caddy emite o certificado automaticamente
na primeira requisição.

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
4. Roda `docker compose pull && docker compose up -d` no VPS.

Acompanhe em **Actions** no GitHub.

## 5. Primeiro acesso

- Usuário: `admin`
- Senha: `admin123`

O sistema **obriga a troca de senha** no primeiro login. Depois disso, use
"🌐 Gerenciar Escritórios" para cadastrar cada escritório-cliente com seu
próprio admin.

## Backup dos dados

Os cadastros (`usuarios.json`/`escritorios.json`) vivem no volume Docker
`dados`. Para fazer backup:

```bash
docker run --rm -v conciliacao-bancaria_dados:/data -v $(pwd):/backup \
  alpine tar czf /backup/dados-backup.tar.gz -C /data .
```

## Atualizar manualmente (sem esperar o push)

```bash
cd /opt/conciliacao-bancaria
docker compose pull && docker compose up -d
```

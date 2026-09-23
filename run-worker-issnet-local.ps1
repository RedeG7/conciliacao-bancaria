# Roda o worker de RPA do ISS Net Online (Goiania/Ap. de Goiania) NESTA
# maquina, em vez do VPS - o Cloudflare do portal bloqueia o IP de
# datacenter do servidor, mesmo com Chromium headed (ver rpa_worker.py e
# Dockerfile.worker). Rodando daqui (rede normal/residencial), o navegador
# passa sem ser sinalizado - mesma coisa que acontece quando voce acessa o
# portal manualmente pelo Chrome.
#
# So processa execucoes do modulo issnet_rest_dms (WORKER_MODULOS abaixo) -
# o worker do VPS continua cuidando do ISS Web normalmente e ja foi
# configurado pra IGNORAR o issnet, entao nao ha disputa entre os dois.
#
# Pre-requisito (uma vez so): copiar RPA_ENC_KEY e POSTGRES_PASSWORD de
# producao pra .deploy_keys/local_worker/prod.env - nunca commitar esse
# arquivo (.deploy_keys/ ja esta no .gitignore):
#   ssh -i .deploy_keys/homehost_deploy root@192.96.217.88 "cat /opt/conciliacao-bancaria/.env" > .deploy_keys/local_worker/prod.env
#
# Uso: abra o PowerShell na raiz do repo e rode:
#   .\run-worker-issnet-local.ps1
# Deixa rodando (Ctrl+C pra parar) enquanto voce cria/acompanha as
# execucoes do ISS Net Online na tela do Hub - nao precisa ficar ligado o
# tempo todo, so quando for fechar.

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$KeyFile = Join-Path $RepoRoot ".deploy_keys\homehost_deploy"
$EnvFile = Join-Path $RepoRoot ".deploy_keys\local_worker\prod.env"
$VpsHost = "192.96.217.88"
$TunnelPortaLocal = 5433

if (-not (Test-Path $EnvFile)) {
    Write-Error "Falta $EnvFile com RPA_ENC_KEY e POSTGRES_PASSWORD de producao (ver instrucoes no topo deste script)."
    exit 1
}

$EnvVars = @{}
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        $EnvVars[$matches[1]] = $matches[2].Trim()
    }
}
foreach ($chave in @("RPA_ENC_KEY", "POSTGRES_PASSWORD")) {
    if (-not $EnvVars.ContainsKey($chave) -or -not $EnvVars[$chave]) {
        Write-Error "Faltou '$chave' em $EnvFile."
        exit 1
    }
}

Write-Host "Abrindo tunel SSH ate o Postgres do VPS (porta local $TunnelPortaLocal)..."
$TunnelProcess = Start-Process -FilePath "ssh" -ArgumentList @(
    "-i", $KeyFile,
    "-L", "${TunnelPortaLocal}:127.0.0.1:5432",
    "-N",
    "root@$VpsHost"
) -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 3
if ($TunnelProcess.HasExited) {
    Write-Error "O tunel SSH caiu logo de cara - confira a chave/conexao com o VPS."
    exit 1
}

try {
    $DatabaseUrl = "postgresql://conciliacao:$($EnvVars['POSTGRES_PASSWORD'])@host.docker.internal:${TunnelPortaLocal}/conciliacao"
    Write-Host "Subindo o worker local (so modulo issnet_rest_dms)..."
    docker run --rm -it `
        --add-host=host.docker.internal:host-gateway `
        -e "DATABASE_URL=$DatabaseUrl" `
        -e "RPA_ENC_KEY=$($EnvVars['RPA_ENC_KEY'])" `
        -e "WORKER_MODULOS=issnet_rest_dms" `
        -e "NODE_OPTIONS=--openssl-legacy-provider" `
        ghcr.io/redeg7/conciliacao-bancaria-worker:latest
}
finally {
    Write-Host "Encerrando o tunel SSH..."
    Stop-Process -Id $TunnelProcess.Id -Force -ErrorAction SilentlyContinue
}

# Monta admissoes_agente.exe (Agente de Admissoes da sessao RDS - gui_admissoes.py).
# O deploy (.github/workflows/deploy.yml, job build-nfgo-exe) roda isso num
# runner Windows a cada push na main; este script e pra build manual.
#
# Uso, a partir da RAIZ do repositorio, com o venv de attended_worker:
#   powershell -File attended_worker\build_admissoes.ps1
#
# LEMBRETE: mudou admissoes_agent.py/admissoes_ia.py/tela.py/gui_admissoes.py
# de forma que o agente deve receber -> sobe attended_worker\VERSION_ADMISSOES.

param([string]$Python = "$PSScriptRoot\.venv\Scripts\python.exe")

$versaoPath = Join-Path $PSScriptRoot "VERSION_ADMISSOES"
$iconePath = Join-Path $PSScriptRoot "icon.ico"

Remove-Item -Force (Join-Path $PSScriptRoot "dist\admissoes_agente.exe") -ErrorAction SilentlyContinue

& $Python -m PyInstaller `
    --onefile --windowed --name admissoes_agente `
    --icon "$iconePath" `
    --distpath "$PSScriptRoot\dist" `
    --workpath "$PSScriptRoot\build_admissoes" `
    --specpath "$PSScriptRoot" `
    --paths "$PSScriptRoot" `
    --add-data "$versaoPath;." `
    --hidden-import truststore `
    --hidden-import PIL.ImageGrab `
    --hidden-import tela `
    --collect-submodules anthropic --collect-submodules openai --hidden-import admissoes_formulario `
    --collect-all pywinauto `
    "$PSScriptRoot\gui_admissoes.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output "`nVersao embutida: $(Get-Content $versaoPath)"

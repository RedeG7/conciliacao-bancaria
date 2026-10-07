# Monta nfgo_attended.exe (programa do PC do RPA NF GO - gui_nfgo.py).
# O deploy (.github/workflows/deploy.yml, job build-nfgo-exe) ja roda isso
# num runner Windows a cada push na main; este script e pra build manual.
#
# Uso, a partir da RAIZ do repositorio, com o venv de attended_worker:
#   powershell -File attended_worker\build_nfgo.ps1
#
# LEMBRETE: mudou nfgo_attended.py/gui_nfgo.py/hub_api.py de forma que os
# usuarios devem receber -> sobe attended_worker\VERSION_NFGO (1.0 -> 1.1);
# e isso que faz o programa avisar "Atualizacao disponivel".

param([string]$Python = "$PSScriptRoot\.venv\Scripts\python.exe")

$raiz = (Get-Item $PSScriptRoot).Parent.FullName
$versaoPath = Join-Path $PSScriptRoot "VERSION_NFGO"
$iconePath = Join-Path $PSScriptRoot "icon.ico"

Remove-Item -Force (Join-Path $PSScriptRoot "dist\nfgo_attended.exe") -ErrorAction SilentlyContinue

& $Python -m PyInstaller `
    --onefile --name nfgo_attended `
    --icon "$iconePath" `
    --distpath "$PSScriptRoot\dist" `
    --workpath "$PSScriptRoot\build_nfgo" `
    --specpath "$PSScriptRoot" `
    --paths "$raiz" `
    --hidden-import rpa.sefazgo_nfe.arquivos `
    --add-data "$versaoPath;." `
    --collect-all pywinauto `
    "$PSScriptRoot\gui_nfgo.py"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output "`nVersao embutida: $(Get-Content $versaoPath)"

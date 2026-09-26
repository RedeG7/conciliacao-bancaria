# Recompila issnet_attended.exe (GUI + CLI) com tudo que precisa:
# - VERSION embutido (--add-data) pra tela mostrar a versao e o
#   auto-update funcionar (ver gui.py _checar_atualizacao).
# - pywinauto/pdfplumber com --collect-all (usam import dinamico que o
#   PyInstaller nao acha sozinho por analise estatica).
#
# Uso: rode a partir da RAIZ do repositorio (nao de dentro de
# attended_worker/), com o venv de attended_worker ja criado:
#   powershell -File attended_worker\build.ps1
#
# LEMBRETE: depois de mudar issnet_attended.py/gui.py/hub_api.py de
# forma que os usuarios devem receber, sobe attended_worker\VERSION
# (ex.: 1.0 -> 1.1) ANTES de rodar isso - e o que faz o auto-update
# (attended_worker/gui.py _checar_atualizacao) avisar quem ja tem uma
# copia mais antiga.

$raiz = (Get-Item $PSScriptRoot).Parent.FullName
$versaoPath = Join-Path $PSScriptRoot "VERSION"

Remove-Item -Force (Join-Path $PSScriptRoot "dist\issnet_attended.exe") -ErrorAction SilentlyContinue

& "$PSScriptRoot\.venv\Scripts\python.exe" -m PyInstaller `
    --onefile --name issnet_attended `
    --distpath "$PSScriptRoot\dist" `
    --workpath "$PSScriptRoot\build" `
    --specpath "$PSScriptRoot" `
    --paths "$raiz" `
    --add-data "$versaoPath;." `
    --collect-all pywinauto `
    --collect-all pdfplumber `
    "$PSScriptRoot\gui.py"

Write-Output "`nVersao embutida: $(Get-Content $versaoPath)"

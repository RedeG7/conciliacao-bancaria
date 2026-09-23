"""URLs do portal ISS Net Online — sem nenhuma dependência do Playwright,
pra tanto rpa/issnet/portal.py (worker) quanto app_conciliacao.py (tela do
Hub, fluxo manual) poderem importar isso sem precisar do Chromium instalado.
"""

PORTAL_URLS = {
    "GOIÂNIA": "https://www.issnetonline.com.br/goiania/online/login/login.aspx",
    "APARECIDA DE GOIÂNIA": "https://www.issnetonline.com.br/aparecida/online/login/login.aspx",
}

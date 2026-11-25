# Imagem da Conciliacao Bancaria (Streamlit) - RedeG7
FROM python:3.11-slim

WORKDIR /app

# poppler-utils/build-essential nao sao necessarios para pdfplumber puro.
# curl e usado no HEALTHCHECK. tesseract-ocr (+ pacote de idioma pt) e o
# fallback de OCR para PDFs sem texto embutido (ex.: extrato "impresso em
# PDF" pelo navegador, onde o texto vira desenho em vez de caracteres) -
# ver _ocr_linhas_por_pagina() em conciliacao_bancaria.py.
# libreoffice-writer-nogui converte a minuta revisada do Hub Societario de
# Word para PDF mantendo o layout (minuta_layout.docx_para_pdf); as fontes
# Liberation/Carlito/Caladea tem as mesmas medidas de Times New Roman,
# Arial, Calibri e Cambria, para o PDF nao mudar a paginacao do Word.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tesseract-ocr tesseract-ocr-por \
       libreoffice-writer-nogui fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
       fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# usuarios/escritorios ficam no Postgres (DATABASE_URL, ver docker-compose.yml)
# - nao ha estado persistente dentro do container da app.

EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl --fail http://localhost:8501/_stcore/health || exit 1

ENTRYPOINT ["streamlit", "run", "app_conciliacao.py", \
    "--server.port=8501", "--server.address=0.0.0.0", "--server.headless=true"]

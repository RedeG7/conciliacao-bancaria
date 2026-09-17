# Imagem da Conciliacao Bancaria (Streamlit) - RedeG7
FROM python:3.11-slim

WORKDIR /app

# poppler-utils/build-essential nao sao necessarios para pdfplumber puro,
# mas curl e usado no HEALTHCHECK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# usuarios.json/escritorios.json nunca devem morar dentro da imagem - ficam
# no volume montado em DADOS_DIR (ver docker-compose.yml).
ENV DADOS_DIR=/app/data
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl --fail http://localhost:8501/_stcore/health || exit 1

ENTRYPOINT ["streamlit", "run", "app_conciliacao.py", \
    "--server.port=8501", "--server.address=0.0.0.0", "--server.headless=true"]

FROM node:22-alpine
WORKDIR /app

# Cadeia de certificados da ICP-Brasil: os web services do eSocial usam
# certificado TLS da ICP-Brasil, que o Node não reconhece sozinho. Baixada do
# site oficial do ITI no build; se o download falhar, o build segue e a tela de
# envio ao eSocial mostra "falha de certificado na conexão".
RUN apk add --no-cache openssl unzip wget \
 && mkdir -p /tmp/icp \
 && (wget -q -O /tmp/icp.zip https://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip \
     && unzip -q -o /tmp/icp.zip -d /tmp/icp || echo "aviso: cadeia ICP-Brasil nao baixada") \
 && for f in $(find /tmp/icp -type f); do \
      openssl x509 -inform DER -in "$f" 2>/dev/null || openssl x509 -in "$f" 2>/dev/null || true; \
    done > /etc/ssl/icp-brasil.pem \
 && echo "certificados ICP-Brasil: $(grep -c 'BEGIN CERTIFICATE' /etc/ssl/icp-brasil.pem)" \
 && rm -rf /tmp/icp /tmp/icp.zip
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/icp-brasil.pem

COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "index.js"]

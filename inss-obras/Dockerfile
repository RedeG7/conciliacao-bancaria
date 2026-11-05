FROM node:22-alpine
WORKDIR /app

# Cadeia de certificados da ICP-Brasil: os web services do eSocial usam
# certificado TLS da ICP-Brasil, que o Node não reconhece sozinho. Baixada do
# site oficial do ITI no build. O site do ITI (Let's Encrypt) não envia o
# certificado intermediário "YE1", então ele e as certificações cruzadas são
# baixados antes, do site oficial da Let's Encrypt (com verificação normal), e
# somados à lista de CAs do sistema só para esse download. Se o download falhar,
# o build segue e a tela de envio ao eSocial mostra "falha de certificado".
RUN apk add --no-cache ca-certificates openssl unzip wget \
 && mkdir -p /tmp/icp \
 && for c in int-ye1 root-ye-by-x2 root-x2-by-x1; do \
      wget -nv -O - "https://letsencrypt.org/certs/gen-y/$c.pem" || true; \
    done > /tmp/le.pem \
 && cat /etc/ssl/certs/ca-certificates.crt /tmp/le.pem > /tmp/ca-download.pem \
 && (wget -nv --ca-certificate=/tmp/ca-download.pem -O /tmp/icp.zip https://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip 2>/tmp/icp.log \
     && unzip -q -o /tmp/icp.zip -d /tmp/icp || (echo "aviso: cadeia ICP-Brasil nao baixada:"; cat /tmp/icp.log)) \
 && for f in $(find /tmp/icp -type f); do \
      openssl x509 -inform DER -in "$f" 2>/dev/null || openssl x509 -in "$f" 2>/dev/null || true; \
    done > /etc/ssl/icp-brasil.pem \
 && echo "certificados ICP-Brasil: $(grep -c 'BEGIN CERTIFICATE' /etc/ssl/icp-brasil.pem)" \
 && rm -rf /tmp/icp /tmp/icp.zip /tmp/icp.log /tmp/le.pem /tmp/ca-download.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/icp-brasil.pem

COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "index.js"]

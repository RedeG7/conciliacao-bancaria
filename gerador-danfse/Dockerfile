# Gerador de DANFSe: o gerador OFICIAL da Receita Federal que monta o PDF do
# DANFSe (NT 008 SE/CGNFS-e) a partir do XML da NFS-e nacional
# (https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse, licença
# MIT), sem alteração no código dela. Na montagem baixamos o repo na versão
# fixada e compilamos exatamente como o Dockerfile da Receita; a imagem final
# só tem o binário Go.
#
# Para atualizar: troque DANFSE_REF (e, se o go.mod da Receita pedir, a
# imagem do Go), suba a VERSAO em gerador_danfse.py com a novidade e faça o
# deploy normal.

# mesma imagem do Go usada no Dockerfile da Receita
FROM golang:1.27.1 AS build

ARG DANFSE_REPO=https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse.git
# main de 22/10/2026
ARG DANFSE_REF=8d79e6b2f7fad6375340afcb51c85ed370c64a14
WORKDIR /src
RUN git init -q . && git remote add origin "$DANFSE_REPO" \
    && git fetch -q --depth 1 origin "$DANFSE_REF" && git checkout -q FETCH_HEAD
RUN go mod download
RUN go install github.com/swaggo/swag/cmd/swag@v1.16.6 \
    && /go/bin/swag init -g cmd/danfse/main.go -o ./api/swagger
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /danfse-service ./cmd/danfse

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
ENV TZ=America/Sao_Paulo
WORKDIR /app
COPY --from=build /danfse-service /app/danfse-service
# o processo roda sem root
RUN adduser -S -H danfse
USER danfse
ENV SERVER_PORT=8083
EXPOSE 8083
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8083/health/ready || exit 1
ENTRYPOINT ["/app/danfse-service"]

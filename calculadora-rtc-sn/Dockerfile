# Calculadora RTC - Simples Nacional: a calculadora OFICIAL da Receita Federal
# (https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional, licença
# MIT), sem alteração no código dela. O repo do Simples não traz o banco: as
# tabelas oficiais (atividades, anexos, cClassTrib, NCM/NBS...) saem do
# flyway do repo do Regime Regular, como manda o README da Receita. Na
# montagem baixamos os dois na versão fixada, geramos o banco SQLite e
# compilamos o .jar; a imagem final só tem o Java, o .jar e o banco.
#
# Para atualizar: troque SN_REF (motor do Simples) e/ou RTC_REF (tabelas -
# de preferência a mesma de calculadora-rtc/Dockerfile), suba a VERSAO em
# calculadora_rtc_sn.py com a novidade e faça o deploy normal.

# imagem do Maven (já com Java 25), igual à da calculadora do Regime Regular
FROM maven:3.9.16-eclipse-temurin-25 AS build
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# banco das tabelas oficiais (flyway do Regime Regular)
ARG RTC_REPO=https://github.com/ReceitaFederal/calculadora-rtc-regime-regular.git
# 1.7.2 (19/11/2026)
ARG RTC_REF=f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4
WORKDIR /rr
RUN git init -q . && git remote add origin "$RTC_REPO" \
    && git fetch -q --depth 1 origin "$RTC_REF" && git checkout -q FETCH_HEAD
RUN mkdir -p calculadora/db \
    && mvn -q --batch-mode --errors flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf

# motor do Simples Nacional
ARG SN_REPO=https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional.git
# 1.0.2 (18/11/2026)
ARG SN_REF=a926d5a76095ac0295a6612a9a54db7ffead2396
WORKDIR /src
RUN git init -q . && git remote add origin "$SN_REPO" \
    && git fetch -q --depth 1 origin "$SN_REF" && git checkout -q FETCH_HEAD
RUN mvn -q --batch-mode --errors -DskipTests package && cp target/*.jar /app.jar

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /app.jar /app/app.jar
COPY --from=build /rr/calculadora/db/calculadora-pro.db /app/calculadora/db/calculadora-pro.db
# banco aberto só para leitura pela API; o processo roda sem root
RUN useradd --system --no-create-home rtc && chown -R rtc /app
USER rtc
# -XX:-UseBASE64Intrinsics: mitigação do aviso de segurança do OpenJDK de
# 17/11/2026, pedida no CHANGELOG 1.0.1 da Receita
ENV JAVA_TOOL_OPTIONS="-Xms128m -Xmx512m -XX:-UseBASE64Intrinsics"
EXPOSE 8082
# a API resolve o banco em ./calculadora/db, relativo à pasta de trabalho
ENTRYPOINT ["java", "-Dspring.profiles.active=offline", "-jar", "/app/app.jar"]

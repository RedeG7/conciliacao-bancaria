# Calculadora RTC - Regime Regular: a calculadora OFICIAL da Receita Federal
# (https://github.com/ReceitaFederal/calculadora-rtc-regime-regular, licença
# MIT), sem alteração no código dela. Na montagem da imagem baixamos o código
# na versão fixada em RTC_REF, geramos o banco SQLite das tabelas oficiais
# (Flyway) e compilamos o .jar; a imagem final só tem o Java, o .jar e o banco.
#
# Para atualizar a calculadora (nova versão da Receita, tabela cClassTrib
# nova etc.): troque RTC_REF pelo commit/tag novo, suba a VERSAO em
# calculadora_rtc.py com a novidade e faça o deploy normal.

FROM eclipse-temurin:25-jdk AS build
ARG RTC_REPO=https://github.com/ReceitaFederal/calculadora-rtc-regime-regular.git
# 1.7.2 (19/11/2026)
ARG RTC_REF=f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git remote add origin "$RTC_REPO" \
    && git fetch -q --depth 1 origin "$RTC_REF" && git checkout -q FETCH_HEAD
RUN chmod +x mvnw && mkdir -p calculadora/db \
    && ./mvnw -q --batch-mode --errors flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf \
    && ./mvnw -q --batch-mode --errors -DskipTests package \
    && cp target/*.jar /app.jar

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /app.jar /app/app.jar
COPY --from=build /src/calculadora/db/calculadora-pro.db /app/calculadora/db/calculadora-pro.db
# banco aberto só para leitura pela API; o processo roda sem root
RUN useradd --system --no-create-home rtc && chown -R rtc /app
USER rtc
ENV JAVA_TOOL_OPTIONS="-Xms128m -Xmx512m"
EXPOSE 8080
# a API resolve o banco em ./calculadora/db, relativo à pasta de trabalho
ENTRYPOINT ["java", "-Dspring.profiles.active=offline", "-jar", "/app/app.jar"]

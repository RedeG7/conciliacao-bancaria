# Simulador INSS Obras (inssobras.redeg7.com)

App separado do Hub (Node 22 + Express + SQLite embutido `node:sqlite`) para
escritórios que regularizam INSS de obras de construção civil. Implementa a
especificação `SPEC_SIMULADOR_INSS_OBRAS` (fase 1, ver "Escopo" abaixo).

- **Login:** só pelo card "🏗️ Simulador INSS Obras" do Hub (login único em
  `/api/sso/inssobras` do `api.py`, bilhete conferido em `src/sso.js`).
- **Multiescritório:** cada registro leva o escritório do Hub (`office`) e
  toda consulta filtra por ele. O super administrador do Hub escolhe o
  escritório no topo da tela.
- **Dados:** `DATA_DIR/inssobras.db` (volume `inssobras_data` no Docker).

## Escopo da fase 1

| Spec | Rota | Situação |
|---|---|---|
| Dashboard (contadores, link público, pendências) | `/dash` | ✅ |
| Simulador obra predial (interno) | `/simuladores/obras-prediais` | ✅ |
| Formulário público por escritório (gera lead) | `/simulador/obras-prediais/{token}` | ✅ |
| Resultado público compartilhável | `/calculator/show/{token}/{uuid}` | ✅ |
| Fator de ajuste eSocial / GFIP / GPS espontânea | `/simuladores/fator-de-ajuste-*` | ✅ |
| PJ NF contrato / medição | `/simuladores/obras-contratuais-pj-nf-*` | ✅ |
| Decadência / Parcelamento e-CAC | `/simuladores/decadencia`, `/simuladores/parcelamento` | ✅ |
| "Simular em" (reaproveita a obra predial) | botão na simulação | ✅ |
| Propostas (honorários, impressão/PDF pelo navegador) | `/acompanhamento-de-obras/propostas` | ✅ |
| Clientes, Leads (WhatsApp com mensagem pronta) | `/acompanhamento-de-obras/clientes`, `/ferramentas-extras/leads` | ✅ |
| Tabelas de parâmetros (VAU e Selic com importação CSV) | `/cadastros/parametros` | ✅ |
| Certificados digitais A1 **do procurador do escritório** (cifrados, aviso de vencimento) | `/cadastros/certificados` | ✅ |
| Cliente como empregador (S-1000): procuração eletrônica, certificado do procurador, endereço | `/clientes/{id}?guia=1` | ✅ |
| Autônomos (S-2300), 3 abas, duplicar para outro cliente | `/acompanhamento-de-obras/autonomos` | ✅ |
| Obra (S-1005): CNO, aferição, alvará/habite-se, trabalhadores com datas, paralisações | `/acompanhamento-de-obras/obras` | ✅ |
| Envio DCTFWeb em 6 abas (obra, rubrica S-1010, lotação S-1020, folha S-1200/S-1210, fechamento S-1299) + quadro de cálculo | `/dctf-web` | ✅ recibos registrados à mão |
| Relatório por evento e recibo dos autônomos (imprimir/PDF) | `/dctf-web/visualizar/{id}` | ✅ |
| Guia de envio com os 8 passos detectados pelos dados | `/guia-de-envio` | ✅ |
| Transmissão ao eSocial (XML assinado, lotes, protocolo, logs, S-3000/S-1298) | - | próxima etapa (após o fiscal validar a seção 8 da spec) |
| Contratos, recibos/RPA, fornecedores, CRM kanban, financeiro, drive, TODO | - | próximas fases |

## Regras de cálculo

Ficam em `src/calc.js` (funções puras, testadas em `test/calc.test.js`) e
**não têm nenhum percentual no código**: tudo vem das tabelas de
Cadastros > Parâmetros (`src/params.js`).
O **padrão da plataforma** é mantido pelo super administrador do Hub; o
**administrador de cada escritório** pode ajustar qualquer valor, e o ajuste
vale só para o escritório dele ("Voltar ao padrão" desfaz). O cálculo usa o
ajuste do escritório quando existe (`linhasEfetivas`/`paramReader(office)`
em `src/db.js`). Os valores iniciais vêm marcados
"Valor inicial - validar com o fiscal (IN RFB 2.021/2021)" e o Dashboard
avisa enquanto houver algum sem conferir. VAU e Selic começam vazias:
- **Selic**: vem sozinha da API pública do Banco Central (série 4390, Selic
  acumulada no mês) - ao subir e uma vez por dia, ou pelo botão
  "Atualizar pelo Banco Central" (`src/integracoes.js`; desligar com `SELIC_AUTO=0`).
- **VAU**: não tem API pública (só aparece no SERO, com login). Em
  Cadastros > Parâmetros > VAU, "Colar tabela do SERO": escolha UF e mês, cole
  o texto copiado da tela "Consultar Tabela VAU" e o sistema reconhece cada
  destinação e valor. Também aceita CSV `uf;destinação;AAAA-MM;valor`.
- **Tabela VAU completa** (menu Cadastros > Tabela VAU): importa o arquivo
  JSON/CSV extraído da consulta "Tabela VAU" do e-CAC no formato do módulo VAU
  (`{"registros": [{"competencia", "uf", "casa_popular", ...7 padrões}]}` ou CSV
  `;` com as mesmas colunas). Upsert por (competência, UF, padrão); se uma linha
  for inválida nada é gravado; cada importação fica em `vau_importacao`
  (`src/vau.js`). A tela filtra por UF/ano, mostra a tabela como no e-CAC e
  baixa CSV no mesmo formato. O cálculo usa a VAU vigente (última publicada até
  a competência), como o `get_vau_vigente` do módulo.
  A tela tem 3 abas: **Consultar**, **Importar / atualizar** e **Extrair do
  e-CAC** - esta última traz o botão de favorito (`src/bookmarklet_vau.js`, do
  vau_modulo) que, com o usuário logado no e-CAC, consulta todos os anos e UFs
  do SERO e baixa o JSON para importar. O botão roda só no navegador do
  usuário; nenhuma credencial passa pelo simulador.

Quadro de cálculo da folha (`src/folha.js`): CPP sobre a remuneração da
competência; competência vencida (dia 20 do mês seguinte) leva multa de mora
(0,33%/dia até 20%), Selic acumulada + 1% e MAED (2%/mês até 20%, mínimo
fixo). Valor "calculado" do mês = remuneração mínima do fator de ajuste
(ou a RMT) dividida pelos meses da obra sem paralisação. Tudo em
Cadastros > Parâmetros > DCTFWeb, para o fiscal validar (spec, seção 8).

Obra predial: COD = área × % da categoria × VAU(UF, destinação) − redução de
concreto usinado; RMT = COD × % de mão de obra do tipo de obra; áreas
complementares entram pela % de equivalência na destinação principal; depois
fator social (só PF) e redução de pré-moldados; INSS = RMT × soma das alíquotas.

## Rodar local

```bash
cd inss-obras && npm install && DEV_LOGIN=1 npm start
```

Abra `http://localhost:3000/dev-login` (só com `DEV_LOGIN=1`). Testes: `npm test`.

## Envio ao eSocial (S-1000)

No cadastro completo do cliente (`/clientes/{id}?guia=1`), **Salvar e enviar**
monta o S-1000 (leiaute S-1.3), assina (XMLDSig RSA-SHA256) com o certificado
A1 do procurador do escritório, envia o lote ao web service do eSocial e
consulta o protocolo até sair o recibo, que é gravado no cliente. A tela
`/esocial/envios/{id}` mostra Enviado → Processando → Recebido (ou as
ocorrências e "Tentar novamente"). Ambiente por escritório (Cadastros >
Escritório), padrão **produção restrita**. Endereços, ações SOAP e namespaces
ficam em `src/esocial.js` (bloco do topo); cada envio fica em `esocial_logs`
com o XML enviado e a resposta. O build da imagem baixa a cadeia ICP-Brasil
(`NODE_EXTRA_CA_CERTS`), necessária para a conexão TLS com o eSocial.

Cadastro: CEP preenche o endereço (ViaCEP); CNPJ preenche razão social,
contato e endereço (BrasilAPI); CPF é validado (nome/nascimento pelo CPF exigem
um serviço pago, ainda não contratado).

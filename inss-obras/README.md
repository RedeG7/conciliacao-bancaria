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
| Contratos, recibos/RPA, autônomos, certificados, guia DCTFWeb, CRM kanban, financeiro, drive, TODO | - | próximas fases |

## Regras de cálculo

Ficam em `src/calc.js` (funções puras, testadas em `test/calc.test.js`) e
**não têm nenhum percentual no código**: tudo vem das tabelas de
Cadastros > Parâmetros (`src/params.js`). Os valores iniciais vêm marcados
"Valor inicial - validar com o fiscal (IN RFB 2.021/2021)" e o Dashboard
avisa enquanto houver algum sem conferir. VAU e Selic começam vazias: importe
o CSV publicado (VAU: `uf;destinação;AAAA-MM;valor` · Selic: `AAAA-MM;percentual`).

Obra predial: COD = área × % da categoria × VAU(UF, destinação) − redução de
concreto usinado; RMT = COD × % de mão de obra do tipo de obra; áreas
complementares entram pela % de equivalência na destinação principal; depois
fator social (só PF) e redução de pré-moldados; INSS = RMT × soma das alíquotas.

## Rodar local

```bash
cd inss-obras && npm install && DEV_LOGIN=1 npm start
```

Abra `http://localhost:3000/dev-login` (só com `DEV_LOGIN=1`). Testes: `npm test`.

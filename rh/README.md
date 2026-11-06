# RH (rh.redeg7.com)

App separado do Hub (Node 22 + Express + SQLite embutido `node:sqlite`) para a
gestão de pessoas do escritório. O escopo parte do mapeamento da plataforma de
RH usada hoje, com visual e nomes próprios: não usa código, marca nem conteúdo
daquela plataforma.

- **Login:** só pelo card "👥 RH" do Hub (`/api/sso/rh` do `api.py`, bilhete
  conferido em `src/sso.js`).
- **Multiescritório:** cada registro leva o escritório do Hub (`office`) e toda
  consulta filtra por ele. O super administrador escolhe o escritório no topo.
- **Dados:** `DATA_DIR/rh.db` (volume `rh_data` no Docker).

## Como está organizado

| Arquivo | Papel |
|---|---|
| `src/modelos.js` | Todos os cadastros: campos, colunas e regras. Campo novo entra aqui |
| `src/crud.js` | Lê e valida formulários, monta telas e exportação a partir dos modelos |
| `src/acesso.js` | Papéis e classes de dados sensíveis |
| `src/alertas.js`, `src/metricas.js`, `src/datas.js` | Regras puras, testadas sem banco |
| `src/importar.js` | Importação por CSV de qualquer cadastro e dos resultados de avaliação da Sólides |
| `src/graficos.js` | Gráficos em HTML e CSS |
| `src/comportamental.js` | Questionário próprio de perfil comportamental e cálculo |
| `src/rotas_comportamental.js` | Telas e links do perfil comportamental |
| `src/server.js` | Rotas e telas que não são cadastro simples |

## Escopo

O menu lateral segue os nomes e a organização da plataforma atual (abas e subabas). A tabela abaixo agrupa as telas por assunto, não pelo menu.

A tela Visão Geral (`/desenvolvimento`), em Desenv. e Performance, reúne AVD, PDI e feedbacks. As médias por competência dependem das avaliações por link, ainda não feitas.

| Área | Telas | Situação |
|---|---|---|
| Início | Painel com alertas, aniversariantes | ✅ |
| Pessoas | Colaboradores (ficha com histórico, bloquear, desligar, recontratar), registros, feedbacks, férias, banco de horas, saúde, desligamentos, checklists, dependentes | ✅ |
| Estrutura | Departamentos, cargos, filiais, unidades, motivos de demissão | ✅ |
| Desempenho | Ciclos, avaliações, matriz de potencial, análise de performance, competências, metas, PDI com avaliados sem PDI, treinamentos com validade e alerta de vencimento | ✅ |
| Engajamento | Pesquisas por link anônimo com modelos (Clima, eNPS, Personalizada) e comparação, benefícios, beneficiários, cultura, faturamentos | ✅ |
| Métricas | Colaboradores e desligamentos | ✅ |
| Perfil comportamental | Questionário próprio por link (lista, link geral ou presencial), perfis, métricas, perfil esperado do cargo, busca, comparação, análise de grupo e extrato de envios | ✅ |
| Configurações | Alertas, usuários e papéis, importação CSV em todos os cadastros, auditoria | ✅ |
| Portal do colaborador | Holerites, informes, publicações, arquivos, onboarding | próxima fase |
| Alertas por e-mail, API e webhooks | - | próxima fase |
| Ponto eletrônico | - | fora: continua no sistema de ponto atual |
| Recrutamento e seleção | - | fora: módulo não contratado hoje |

## Papéis

Administrador do escritório no Hub é sempre "Responsável". Os demais começam em
"Apenas visualização" até um Responsável mudar em Configurações.

| Papel | Edita | Apaga | Salários | Dados pessoais | Saúde |
|---|---|---|---|---|---|
| Responsável | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edita, mas não apaga | ✅ | | ✅ | ✅ | ✅ |
| Edita, sem ver salários | ✅ | | | ✅ | ✅ |
| Apenas visualização | | | | | |

O campo que o papel não vê some da tela, da exportação e do salvamento: quem não
vê o salário não consegue apagá-lo sem querer. "Apagar" é exclusão lógica: o
registro sai das telas e continua no banco.

## Pesquisas

O link não pede login e não grava usuário, IP nem hora, só o dia. Os resultados
só aparecem a partir de 3 respostas. O bloqueio de resposta repetida é por cookie
do navegador: serve contra engano, não contra fraude.

## Rodar local

```bash
cd rh && npm install && DEV_LOGIN=1 npm start
```

Abra `http://localhost:3000/dev-login` (só com `DEV_LOGIN=1`). Testes: `npm test`.

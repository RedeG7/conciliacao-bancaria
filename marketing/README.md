# Real 4U — Marketing & Comercial

Sistema web que integra marketing e comercial da Real 4U Contabilidade e Consultoria: campanhas, conteúdos (ganchos, CTAs, UTMs), contatos, funil Kanban, propostas, vendas, perdas e indicadores calculados a partir dos dados registrados.

## Como rodar

Requisito: **Node.js 22.13 ou superior** (usa o SQLite embutido do Node — não precisa instalar banco de dados).

```bash
npm install
npm start
```

Abra `http://localhost:3000`. No primeiro acesso, crie o usuário administrador. Depois, em **Configurações › Usuários**, cadastre a equipe (perfis Administrador, Marketing e Comercial).

Teste automático do fluxo completo (usa um banco temporário):

```bash
npm test
```

### Variáveis de ambiente (opcionais)

| Variável | Para quê |
|---|---|
| `PORT` | Porta do servidor (padrão 3000) |
| `DATA_DIR` | Pasta dos bancos de dados (padrão `./data`) — **faça backup desta pasta** |
| `COOKIE_SECURE=1` | Use quando o sistema estiver publicado com HTTPS |
| `TRUST_PROXY=1` | Quando estiver atrás de um proxy (Nginx, Render, Railway etc.) |
| `FORM_WEBHOOK_TOKEN` | Ativa o recebimento de formulários do site em `POST /api/webhooks/form` |
| `FORM_DEFAULT_OWNER_ID` | Responsável padrão das oportunidades vindas de formulário |

### Onde hospedar

O sistema precisa de uma hospedagem que rode **Node.js 22.13+** e tenha **disco persistente** (os dados ficam em arquivos SQLite). Hospedagem comum de site em PHP/WordPress não roda este sistema.

- **Render** (mais simples): suba esta pasta para um repositório no GitHub, crie um "Blueprint" no Render apontando para ele — o arquivo `render.yaml` já configura disco, variáveis e comandos. O plano gratuito não tem disco persistente; use o pago com disco.
- **VPS ou qualquer serviço com Docker** (Hostinger VPS, DigitalOcean, Railway, Fly.io): use o `Dockerfile` e monte um volume em `/data`.
- **Domínio próprio**: aponte um subdomínio (ex.: `crm.real4u.com.br`) para a hospedagem e ative o HTTPS dela.

Depois do primeiro acesso, crie o administrador e, em Configurações › Usuários, a equipe.

### Ligar o formulário do site

Com `FORM_WEBHOOK_TOKEN` definido, o formulário do site envia os dados para `https://SEU-ENDERECO/api/webhooks/form` (formato no fim deste arquivo). Os links curtos dos conteúdos (`https://SEU-ENDERECO/r/código`) passam a contar cliques assim que o sistema estiver no endereço público.

### Publicar para a equipe

Qualquer servidor com Node 22 e **disco persistente** funciona (VPS, Render, Railway, Fly.io etc.). Coloque atrás de HTTPS, defina `COOKIE_SECURE=1` e `TRUST_PROXY=1`, e aponte `DATA_DIR` para o disco persistente. Os arquivos `data/real.db` (dados reais), `data/demo.db` (fictícios) e `data/auth.db` (usuários) devem entrar no backup.

## O que está implementado

- **Login e perfis** com senha criptografada (scrypt), sessão em cookie HttpOnly, proteção contra CSRF, limite de tentativas e registro de alterações (auditoria).
  - Administrador: tudo. Marketing: campanhas, conteúdos, métricas, custos e cadastro de leads; vê o funil sem mover etapas. Comercial: contatos, oportunidades, etapas, propostas, vendas, perdas, recebimentos e tarefas; vê campanhas e conteúdos.
- **Contatos** (cliente potencial, parceiro de indicação, interessado em curso), várias oportunidades por contato, verificação de duplicidade por telefone e e-mail, arquivamento, pesquisa, filtros, exportação e **importação CSV com prévia** (novo / já cadastrado / repetido no arquivo / erro, com escolha de ação por linha).
- **Funil Kanban** com arrastar e soltar, etapas editáveis, contagem e soma por coluna, tempo na etapa, próxima ação, alerta de atraso, histórico de cada movimentação. Ganho pede data, serviço, tipo de contrato, valor único e mensalidade **separados**; perda pede motivo, objeção e data de retomada.
- **Ficha completa**: dados, perfil, necessidade, dificuldade, urgência, prazo, orçamento, decisão, qualificação por critérios (com justificativa e ajuste manual), origem e interações com UTMs, propostas, recebimentos, anotações, tarefas e histórico.
- **Campanhas**: orçamento, gasto, saldo, gasto por dia, métricas por data (manual ou CSV). A chave data + campanha + conteúdo + origem impede que uma importação repetida some os resultados. Outros custos de marketing e vendas para o CAC completo.
- **Conteúdos, ganchos e CTAs** com gerador de UTMs e **link curto próprio** (`/r/código`) que conta cliques anônimos.
- **Painel** com filtros (período, origem, campanha, conteúdo, serviço, responsável, tipo), duas visões (atividade no período × coorte de leads), dois modelos de atribuição, fórmula e registros de cada indicador, evolução, origem, campanha, gargalos, motivos de perda, oportunidades sem retorno e metas.
- **Comparações** por conteúdo, gancho, CTA, campanha, origem, serviço e responsável, sempre com tamanho da amostra. **Perdas × dimensões**, objeções e retomadas. **Atribuição** em dois modelos sem contar a mesma venda duas vezes.
- **O que melhorar**: fatos observados, hipóteses e testes sugeridos, com regras e volumes mínimos explícitos.
- **Metas** configuráveis por período e serviço (nenhuma meta vem pré-cadastrada).
- **Modo demonstração** em banco separado, com dados claramente fictícios.
- **Logo**: envie o arquivo oficial em Configurações › Logo. Até lá, aparece apenas o nome “Real 4U”.

## O que depende de serviços externos

| Integração | Situação | O que é necessário |
|---|---|---|
| Formulários do site (webhook) | **Implementado** | Definir `FORM_WEBHOOK_TOKEN` e o site enviar os dados para o endereço público do sistema |
| Link curto rastreável | **Implementado** | Sistema publicado em um domínio para uso externo |
| Meta Ads | Estrutura preparada, sem sincronização | Business Manager, app no Meta for Developers, token com `ads_read`, possível revisão do app. Enquanto isso: importação CSV |
| Google Ads | Estrutura preparada, sem sincronização | Conta MCC, developer token aprovado, OAuth no Google Cloud. Enquanto isso: importação CSV |
| WhatsApp Business | Estrutura preparada, sem recebimento | WhatsApp Business Platform (Cloud API), empresa verificada, número dedicado; cobrança por conversa pela Meta |

Sem integração configurada, a tela de Integrações mostra “Não conectado”. Nenhum dado é apresentado como em tempo real.

## Formato do webhook de formulário

```
POST /api/webhooks/form
X-Webhook-Token: <FORM_WEBHOOK_TOKEN>
Content-Type: application/json

{ "nome": "...", "telefone": "...", "email": "...", "empresa": "...", "cidade": "...",
  "servico": "Regularização de obras e INSS da obra", "mensagem": "...",
  "origem": "Site / formulário", "campanha": "...", "conteudo": "...",
  "utm_source": "...", "utm_medium": "...", "utm_campaign": "...", "utm_content": "...", "utm_term": "..." }
```

## Estrutura

```
index.js              inicialização
src/server.js         API, autenticação, permissões, importações e exportações
src/analytics.js      indicadores, atribuição, comparações, perdas e "O que melhorar"
src/logic.js          regras de etapas, qualificação e normalização de dados
src/integrations.js   webhook, link rastreável e situação das integrações
src/db.js / demo.js   esquema do banco, listas iniciais e dados fictícios
public/               interface (HTML, CSS e JavaScript, sem etapa de build)
hosted/               versão que roda dentro do Claude (opcional; gerada com node hosted/build.js)
Dockerfile, render.yaml, .env.example   arquivos de hospedagem
test/fluxo.test.js    teste do fluxo completo
```

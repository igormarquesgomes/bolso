# Bolso — assessor pessoal de gastos

Chat com IA para registrar gastos por texto, voz ou foto de comprovante.
Projeto independente (não compartilha nada com o OddLab).

## Estrutura

- `server.js` — backend Express: serve o frontend e expõe a API
- `public/index.html` — frontend (chat)
- Banco: Supabase (projeto `bolso`), tabela `bolso_gastos`, acesso só via service_role no backend

## Endpoints

Todos exigem o header `X-Bolso-Key: <senha>` (ou `?key=`). Meses em horário de Brasília:

- `POST /bolso/chat` — `{ messages }` → Anthropic (claude-sonnet-4-6) → `{ acao, gastos[], resposta }` (extrai `forma_pagamento` quando dito)
- `GET/POST /bolso/gastos` · `PUT/DELETE /bolso/gastos/:id` — `?ref=aaaa-mm`, inclui `forma_pagamento` e `data`
- `GET/PUT /bolso/perfil` — renda prevista, meta mensal e objetivo (registro único)
- `GET/POST /bolso/entradas` · `DELETE /bolso/entradas/:id` — renda que entrou no mês
- `GET/POST /bolso/fixas` · `PUT /bolso/fixas/:id` — cadastro de despesas fixas (desativar preserva histórico)
- `GET /bolso/fixas/mes?ref=aaaa-mm` — fixas com status calculado (paga / aberta / vencida)
- `POST /bolso/fixas/pagar` — grava pagamento do mês (upsert por despesa+mês)
- `GET/POST /bolso/reserva` · `DELETE /bolso/reserva/:id` — aportes e resgates (resgate maior que o saldo é bloqueado)
- `GET /bolso/resumo?ref=aaaa-mm` — payload único do dashboard: totais, saldo livre, contas a vencer e séries dos 4 gráficos
- `GET /health` — sem senha; mostra quais variáveis estão configuradas

## Variáveis de ambiente (Render)

| Variável | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | sua chave da Anthropic |
| `BOLSO_SUPABASE_URL` | `https://cnxhxerstforgsprkblw.supabase.co` |
| `BOLSO_SUPABASE_KEY` | service_role key do projeto `bolso` (Supabase → Settings → API) |
| `BOLSO_SENHA` | senha de acesso ao app (você escolhe) |

## Deploy no Render

1. Suba este diretório para um repositório Git próprio
2. Render → New → Web Service → conecte o repositório
3. Build command: `npm install` · Start command: `node server.js`
4. Configure as 4 variáveis de ambiente acima
5. Abra a URL do serviço — o app pede a senha no primeiro acesso (fica salva no navegador)

## Rodar localmente

```bash
npm install
set ANTHROPIC_API_KEY=... && set BOLSO_SUPABASE_URL=... && set BOLSO_SUPABASE_KEY=... && set BOLSO_SENHA=... && node server.js
```

Abra http://localhost:3000

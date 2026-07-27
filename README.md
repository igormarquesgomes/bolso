# Bolso — assessor pessoal de gastos

Chat com IA para registrar gastos por texto, voz ou foto de comprovante.
Projeto independente (não compartilha nada com o OddLab).

## Estrutura

- `server.js` — backend Express: serve o frontend e expõe a API
- `public/index.html` — frontend (chat)
- Banco: Supabase (projeto `bolso`), tabela `bolso_gastos`, acesso só via service_role no backend

## Endpoints

Todos exigem o header `X-Bolso-Key: <senha>` (ou `?key=`):

- `POST /bolso/chat` — `{ messages }` → chama a Anthropic (claude-sonnet-4-6) e devolve o JSON da ação
- `GET /bolso/gastos` — gastos do mês corrente (ou `?desde=YYYY-MM-DD`)
- `POST /bolso/gastos` — `{ gastos: [...] }` insere e devolve as linhas criadas
- `DELETE /bolso/gastos/:id` — apaga um gasto
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

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Carrega .env local se existir (no Render as variáveis vêm do painel)
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const linha of env.split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const app = express();
app.use(cors());
// Fotos de comprovante chegam em base64 e excedem o limite padrão de 100kb
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BOLSO_SUPABASE_URL = process.env.BOLSO_SUPABASE_URL;
const BOLSO_SUPABASE_KEY = process.env.BOLSO_SUPABASE_KEY;
const BOLSO_SENHA = process.env.BOLSO_SENHA;

// ─── Auth simples ────────────────────────────────────────────
function auth(req, res, next) {
  if (!BOLSO_SENHA) return res.status(503).json({ error: 'BOLSO_SENHA não configurada no servidor' });
  const chave = req.get('x-bolso-key') || req.query.key;
  if (chave !== BOLSO_SENHA) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// ─── Client Supabase (REST, service_role) ────────────────────
function sb(pathQuery, options = {}) {
  return fetch(`${BOLSO_SUPABASE_URL}/rest/v1/${pathQuery}`, {
    ...options,
    headers: {
      'apikey': BOLSO_SUPABASE_KEY,
      'Authorization': `Bearer ${BOLSO_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

// ─── System prompt ───────────────────────────────────────────
const SYSTEM = `Você é o Bolso, assessor pessoal de gastos do Igor (Brasil). Hoje é DATA_HOJE.
Responda SOMENTE com JSON válido, sem markdown, sem texto fora do JSON.

Formato:
{"acao":"registrar"|"responder"|"apagar_ultimo","gastos":[{"valor":num,"categoria":"mercado|alimentacao|transporte|lazer|contas|saude|casa|outros","descricao":"texto curto","itens":[{"nome":"...","qtd":num,"valor":num}]}],"resposta":"mensagem curta e amigável em pt-BR"}

Regras:
- Se a mensagem descreve um ou mais gastos → acao "registrar", um objeto por gasto. "itens" só quando houver itens discriminados (ex: nota fiscal); senão omita.
- Se for pergunta sobre os gastos → acao "responder", use os dados fornecidos, seja direto e cite valores.
- Se pedir para apagar/desfazer o último → acao "apagar_ultimo".
- "resposta" sempre curta (1-3 frases), tom de parceiro, pode usar 1 emoji.
- Valores em reais. Interprete linguagem informal ("gastei 30 conto no ifood").`;

// ─── POST /bolso/chat — proxy para a API da Anthropic ────────
app.post('/bolso/chat', auth, async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Campo "messages" ausente ou inválido' });
    }
    const dataHoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: SYSTEM.replace('DATA_HOJE', dataHoje),
        messages
      })
    });
    const data = await resp.json();
    if (data.error) {
      console.log(`❌ Bolso IA: ${data.error.message}`);
      return res.status(502).json({ error: 'Falha ao chamar a IA' });
    }
    const usage = data.usage || {};
    console.log(`💬 Bolso chat — in:${usage.input_tokens} out:${usage.output_tokens}`);
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const limpo = texto.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(limpo); }
    catch { parsed = { acao: 'responder', resposta: limpo }; }
    res.json(parsed);
  } catch (e) {
    console.log(`❌ Bolso chat: ${e.message}`);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── GET /bolso/gastos — gastos do mês corrente ──────────────
app.get('/bolso/gastos', auth, async (req, res) => {
  try {
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')
      ? req.query.desde
      : new Date().toISOString().slice(0, 7) + '-01';
    const r = await sb(`bolso_gastos?ts=gte.${desde}&order=ts.asc&limit=500`);
    if (!r.ok) {
      console.log(`❌ Supabase GET: ${r.status} ${await r.text()}`);
      return res.status(502).json({ error: 'Falha ao consultar o banco' });
    }
    res.json(await r.json());
  } catch (e) {
    console.log(`❌ Bolso gastos GET: ${e.message}`);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── POST /bolso/gastos — registrar gastos ───────────────────
app.post('/bolso/gastos', auth, async (req, res) => {
  try {
    const { gastos } = req.body || {};
    if (!Array.isArray(gastos) || gastos.length === 0) {
      return res.status(400).json({ error: 'Campo "gastos" ausente ou inválido' });
    }
    const linhas = gastos.map(g => ({
      valor: Number(g.valor) || 0,
      categoria: g.categoria || 'outros',
      descricao: g.descricao || '',
      itens: Array.isArray(g.itens) ? g.itens : [],
      origem: ['texto', 'voz', 'foto'].includes(g.origem) ? g.origem : 'texto'
    }));
    const r = await sb('bolso_gastos', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(linhas)
    });
    if (!r.ok) {
      console.log(`❌ Supabase POST: ${r.status} ${await r.text()}`);
      return res.status(502).json({ error: 'Falha ao salvar no banco' });
    }
    res.json(await r.json());
  } catch (e) {
    console.log(`❌ Bolso gastos POST: ${e.message}`);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── DELETE /bolso/gastos/:id — apagar um gasto ──────────────
app.delete('/bolso/gastos/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const r = await sb(`bolso_gastos?id=eq.${id}`, {
      method: 'DELETE',
      headers: { 'Prefer': 'return=representation' }
    });
    if (!r.ok) {
      console.log(`❌ Supabase DELETE: ${r.status} ${await r.text()}`);
      return res.status(502).json({ error: 'Falha ao apagar no banco' });
    }
    res.json(await r.json());
  } catch (e) {
    console.log(`❌ Bolso gastos DELETE: ${e.message}`);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Health ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    anthropic: !!ANTHROPIC_API_KEY,
    supabase: !!(BOLSO_SUPABASE_URL && BOLSO_SUPABASE_KEY),
    senha: !!BOLSO_SENHA
  });
});

app.listen(PORT, () => {
  console.log(`Bolso rodando na porta ${PORT}`);
});

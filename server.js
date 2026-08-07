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

const FORMAS = ['credito', 'debito', 'pix', 'dinheiro', 'boleto'];
const TIPOS_ENTRADA = ['salario', 'extra', 'reembolso', 'outros'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Datas em America/Sao_Paulo (UTC-3, sem horário de verão) ─
const tzMs = 3 * 3600 * 1000;
const hojeSP = () => new Date(Date.now() - tzMs).toISOString().slice(0, 10);   // YYYY-MM-DD
const mesSP = () => hojeSP().slice(0, 7);                                       // YYYY-MM
const refValida = r => /^\d{4}-\d{2}$/.test(r || '');
const dataValida = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
function rangeMes(ref) {  // [início, fim) do mês em instantes UTC
  const [a, m] = ref.split('-').map(Number);
  return [
    new Date(Date.UTC(a, m - 1, 1, 3)).toISOString(),
    new Date(Date.UTC(a, m, 1, 3)).toISOString()
  ];
}
function refMenos(ref, n) { // ref 'YYYY-MM' n meses atrás
  const [a, m] = ref.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}
function vencimentoNoMes(ref, dia) { // clampa dia 31 em meses curtos
  const [a, m] = ref.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${ref}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
}
// data 'YYYY-MM-DD' → timestamptz ao meio-dia de Brasília (evita virar de dia)
const tsDeData = d => `${d}T12:00:00-03:00`;
// início do dia (00:00 BRT) de 'YYYY-MM-DD' como instante UTC, p/ limites de intervalo
const boundTs = d => new Date(`${d}T00:00:00-03:00`).toISOString();
const addDia = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// Ciclo da fatura do cartão que FECHA no mês `ref`, dado o dia de fechamento D e
// vencimento V. Contém compras de (D+1 do mês anterior) até (D de ref), inclusive.
function faturaCiclo(ref, D, V) {
  const fecha = vencimentoNoMes(ref, D);              // clampa D em meses curtos
  const prevClose = vencimentoNoMes(refMenos(ref, 1), D);
  const dueRef = V >= D ? ref : refMenos(ref, -1);    // vence no mesmo mês do fechamento (V>D) ou no seguinte
  return {
    fecha, vence: vencimentoNoMes(dueRef, V),
    ini: boundTs(addDia(prevClose, 1)),               // dia seguinte ao fechamento anterior, 00:00
    fim: boundTs(addDia(fecha, 1))                    // dia seguinte ao fechamento, 00:00 (exclusivo)
  };
}

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
async function sbJson(pathQuery, options = {}) {
  // PGRST303 "JWT issued at future": skew de relógio ao traduzir a secret key
  // nova — transitório, resolve em ~1s. 5xx também merece nova tentativa.
  for (let tentativa = 1; ; tentativa++) {
    const r = await sb(pathQuery, options);
    if (r.ok) return r.status === 204 ? null : r.json();
    const corpo = await r.text();
    const transitorio = r.status >= 500 || corpo.includes('PGRST303');
    if (transitorio && tentativa < 3) {
      console.log(`⏳ Supabase ${r.status} (tentativa ${tentativa}), repetindo: ${corpo.slice(0, 120)}`);
      await new Promise(res => setTimeout(res, 1500));
      continue;
    }
    throw new Error(`Supabase ${r.status}: ${corpo.slice(0, 300)}`);
  }
}
const num = v => Number(v) || 0;
function erro500(res, rota, e) {
  console.log(`❌ ${rota}: ${e.message}`);
  res.status(500).json({ error: 'Erro interno' });
}

// ─── System prompt do chat ───────────────────────────────────
const SYSTEM = `Você é o Bolso, assessor pessoal de gastos do Igor (Brasil). Hoje é DATA_HOJE.
Responda SOMENTE com JSON válido, sem markdown, sem texto fora do JSON.

Formato:
{"acao":"registrar"|"responder"|"apagar_ultimo","gastos":[{"valor":num,"categoria":"mercado|alimentacao|alcoolico|doces|transporte|lazer|contas|saude|casa|limpeza|higiene|outros","descricao":"texto curto","forma_pagamento":"credito"|"debito"|"pix"|"dinheiro"|"boleto"|null,"itens":[{"nome":"...","qtd":num,"valor":num,"categoria":"mesma lista"}]}],"resposta":"mensagem curta e amigável em pt-BR"}

Regras:
- Se a mensagem descreve um ou mais gastos → acao "registrar", um objeto por gasto. "itens" só quando houver itens discriminados (ex: nota fiscal); senão omita.
- Classifique CADA item na categoria mais específica: cerveja/vinho/destilados → "alcoolico"; sorvete/chocolate/bolo → "doces"; detergente/sabão → "limpeza"; shampoo/sabonete → "higiene"; comida em geral → "alimentacao". O gasto em si mantém a categoria geral (ex: compra de supermercado → "mercado").
- "forma_pagamento": preencha SOMENTE se o usuário disser como pagou ("no pix", "no cartão", "crédito", "em dinheiro"...). "cartão" sem especificar → "credito". Se não disser, use null — o app vai perguntar.
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
  } catch (e) { erro500(res, 'chat', e); }
});

// ─── Perfil (registro único) ─────────────────────────────────
app.get('/bolso/perfil', auth, async (req, res) => {
  try {
    const rows = await sbJson('bolso_perfil?limit=1');
    res.json(rows[0] || null);
  } catch (e) { erro500(res, 'perfil GET', e); }
});

app.put('/bolso/perfil', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { atualizado_em: new Date().toISOString() };
    if (b.renda_prevista !== undefined) patch.renda_prevista = num(b.renda_prevista);
    if (b.meta_mensal !== undefined) patch.meta_mensal = num(b.meta_mensal);
    if (b.objetivo_nome !== undefined) patch.objetivo_nome = b.objetivo_nome || null;
    if (b.objetivo_valor !== undefined) patch.objetivo_valor = b.objetivo_valor === null ? null : num(b.objetivo_valor);
    if (b.objetivo_prazo !== undefined) patch.objetivo_prazo = dataValida(b.objetivo_prazo) ? b.objetivo_prazo : null;
    if (b.cartao_fechamento !== undefined) { const d = parseInt(b.cartao_fechamento, 10); if (d >= 1 && d <= 31) patch.cartao_fechamento = d; }
    if (b.cartao_vencimento !== undefined) { const d = parseInt(b.cartao_vencimento, 10); if (d >= 1 && d <= 31) patch.cartao_vencimento = d; }
    const atual = await sbJson('bolso_perfil?limit=1');
    if (!atual[0]) return res.status(500).json({ error: 'Perfil não inicializado' });
    const rows = await sbJson(`bolso_perfil?id=eq.${atual[0].id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    res.json(rows[0]);
  } catch (e) { erro500(res, 'perfil PUT', e); }
});

// ─── Entradas ────────────────────────────────────────────────
app.get('/bolso/entradas', auth, async (req, res) => {
  try {
    const ref = refValida(req.query.ref) ? req.query.ref : mesSP();
    const [ini, fim] = rangeMes(ref);
    res.json(await sbJson(`bolso_entradas?ts=gte.${ini}&ts=lt.${fim}&order=ts.desc`));
  } catch (e) { erro500(res, 'entradas GET', e); }
});

app.post('/bolso/entradas', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!num(b.valor) || num(b.valor) <= 0) return res.status(400).json({ error: 'Valor inválido' });
    const linha = {
      valor: num(b.valor),
      tipo: TIPOS_ENTRADA.includes(b.tipo) ? b.tipo : 'salario',
      descricao: b.descricao || null
    };
    if (dataValida(b.data)) linha.ts = tsDeData(b.data);
    const rows = await sbJson('bolso_entradas', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(linha)
    });
    res.json(rows[0]);
  } catch (e) { erro500(res, 'entradas POST', e); }
});

app.delete('/bolso/entradas/:id', auth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    res.json(await sbJson(`bolso_entradas?id=eq.${req.params.id}`, {
      method: 'DELETE', headers: { 'Prefer': 'return=representation' }
    }));
  } catch (e) { erro500(res, 'entradas DELETE', e); }
});

// ─── Gastos ──────────────────────────────────────────────────
app.get('/bolso/gastos', auth, async (req, res) => {
  try {
    // compat: ?desde=YYYY-MM-DD (frontend antigo); padrão: mês corrente por ?ref=YYYY-MM
    if (dataValida(req.query.desde)) {
      return res.json(await sbJson(`bolso_gastos?ts=gte.${req.query.desde}&order=ts.asc&limit=500`));
    }
    const ref = refValida(req.query.ref) ? req.query.ref : mesSP();
    const [ini, fim] = rangeMes(ref);
    res.json(await sbJson(`bolso_gastos?ts=gte.${ini}&ts=lt.${fim}&order=ts.desc&limit=1000`));
  } catch (e) { erro500(res, 'gastos GET', e); }
});

function linhaGasto(g) {
  const linha = {
    valor: num(g.valor),
    categoria: g.categoria || 'outros',
    descricao: g.descricao || '',
    itens: Array.isArray(g.itens) ? g.itens : [],
    origem: ['texto', 'voz', 'foto'].includes(g.origem) ? g.origem : 'texto',
    forma_pagamento: FORMAS.includes(g.forma_pagamento) ? g.forma_pagamento : null
  };
  if (dataValida(g.data)) linha.ts = tsDeData(g.data);
  return linha;
}

app.post('/bolso/gastos', auth, async (req, res) => {
  try {
    const { gastos } = req.body || {};
    if (!Array.isArray(gastos) || gastos.length === 0) {
      return res.status(400).json({ error: 'Campo "gastos" ausente ou inválido' });
    }
    const rows = await sbJson('bolso_gastos', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(gastos.map(linhaGasto))
    });
    res.json(rows);
  } catch (e) { erro500(res, 'gastos POST', e); }
});

app.put('/bolso/gastos/:id', auth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const b = req.body || {};
    const patch = {};
    if (b.valor !== undefined) patch.valor = num(b.valor);
    if (b.categoria !== undefined) patch.categoria = b.categoria || 'outros';
    if (b.descricao !== undefined) patch.descricao = b.descricao || '';
    if (b.forma_pagamento !== undefined) {
      patch.forma_pagamento = FORMAS.includes(b.forma_pagamento) ? b.forma_pagamento : null;
    }
    if (dataValida(b.data)) patch.ts = tsDeData(b.data);
    const rows = await sbJson(`bolso_gastos?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    res.json(rows[0] || null);
  } catch (e) { erro500(res, 'gastos PUT', e); }
});

app.delete('/bolso/gastos/:id', auth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    res.json(await sbJson(`bolso_gastos?id=eq.${req.params.id}`, {
      method: 'DELETE', headers: { 'Prefer': 'return=representation' }
    }));
  } catch (e) { erro500(res, 'gastos DELETE', e); }
});

// ─── Despesas fixas ──────────────────────────────────────────
app.get('/bolso/fixas', auth, async (req, res) => {
  try {
    res.json(await sbJson('bolso_despesas_fixas?order=dia_vencimento.asc'));
  } catch (e) { erro500(res, 'fixas GET', e); }
});

app.post('/bolso/fixas', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const dia = parseInt(b.dia_vencimento, 10);
    const variavel = !!b.valor_variavel;
    // valor só é obrigatório quando NÃO é variável (cartão/energia entram sem valor)
    if (!b.nome || !(dia >= 1 && dia <= 31) || (!variavel && !num(b.valor))) {
      return res.status(400).json({ error: 'Informe nome, dia de vencimento (1-31) e valor (ou marque valor variável)' });
    }
    const rows = await sbJson('bolso_despesas_fixas', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ nome: b.nome, valor: num(b.valor), dia_vencimento: dia, categoria: b.categoria || 'fixas', valor_variavel: variavel })
    });
    res.json(rows[0]);
  } catch (e) { erro500(res, 'fixas POST', e); }
});

app.put('/bolso/fixas/:id', auth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    const b = req.body || {};
    const patch = {};
    if (b.nome !== undefined) patch.nome = b.nome;
    if (b.valor !== undefined) patch.valor = num(b.valor);
    if (b.dia_vencimento !== undefined) {
      const dia = parseInt(b.dia_vencimento, 10);
      if (!(dia >= 1 && dia <= 31)) return res.status(400).json({ error: 'Dia de vencimento inválido' });
      patch.dia_vencimento = dia;
    }
    if (b.categoria !== undefined) patch.categoria = b.categoria || 'fixas';
    if (b.valor_variavel !== undefined) patch.valor_variavel = !!b.valor_variavel;
    if (b.ativa !== undefined) patch.ativa = !!b.ativa;  // desativar preserva histórico
    const rows = await sbJson(`bolso_despesas_fixas?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    res.json(rows[0] || null);
  } catch (e) { erro500(res, 'fixas PUT', e); }
});

// Fixas do mês com status calculado. Ausência de pagamento = "em aberto".
async function fixasDoMes(ref) {
  const [fixas, pagamentos] = await Promise.all([
    sbJson('bolso_despesas_fixas?order=dia_vencimento.asc'),
    sbJson(`bolso_fixas_pagamentos?mes_referencia=eq.${ref}-01`)
  ]);
  const pagoPor = Object.fromEntries(pagamentos.map(p => [p.despesa_id, p]));
  const hoje = hojeSP();
  const ativasNoMes = fixas.filter(f => f.ativa || pagoPor[f.id]); // inativas só com pagamento no mês (histórico)

  // Para fixas de valor variável ainda em aberto, estima pelo último valor pago
  // em meses anteriores (ex: energia do mês passado) — melhora "total previsto".
  const varIds = ativasNoMes.filter(f => f.valor_variavel && !pagoPor[f.id]).map(f => f.id);
  const ultimoPago = {};
  if (varIds.length) {
    const hist = await sbJson(`bolso_fixas_pagamentos?despesa_id=in.(${varIds.join(',')})&mes_referencia=lt.${ref}-01&order=mes_referencia.desc`);
    for (const p of hist) if (!(p.despesa_id in ultimoPago)) ultimoPago[p.despesa_id] = num(p.valor_pago);
  }

  return ativasNoMes.map(f => {
    const pag = pagoPor[f.id] || null;
    const vencimento = vencimentoNoMes(ref, f.dia_vencimento);
    const status = pag ? 'paga' : (vencimento < hoje ? 'vencida' : 'aberta');
    // estimativa: se paga, o valor pago; se variável, o último pago (ou 0 = "a definir"); senão o valor cadastrado
    const estimativa = pag ? num(pag.valor_pago)
      : (f.valor_variavel ? (f.id in ultimoPago ? ultimoPago[f.id] : num(f.valor)) : num(f.valor));
    return {
      ...f, vencimento, status, estimativa,
      valor_pago: pag ? num(pag.valor_pago) : null,
      pago_em: pag ? pag.pago_em : null
    };
  });
}

app.get('/bolso/fixas/mes', auth, async (req, res) => {
  try {
    const ref = refValida(req.query.ref) ? req.query.ref : mesSP();
    res.json(await fixasDoMes(ref));
  } catch (e) { erro500(res, 'fixas/mes GET', e); }
});

app.post('/bolso/fixas/pagar', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!UUID_RE.test(b.despesa_id || '')) return res.status(400).json({ error: 'despesa_id inválido' });
    const ref = refValida(b.mes_referencia) ? b.mes_referencia
      : (dataValida(b.mes_referencia) ? b.mes_referencia.slice(0, 7) : mesSP());
    const linha = {
      despesa_id: b.despesa_id,
      mes_referencia: `${ref}-01`,
      valor_pago: b.valor_pago !== undefined ? num(b.valor_pago) : null,
      pago_em: dataValida(b.pago_em) ? b.pago_em : hojeSP()
    };
    const rows = await sbJson('bolso_fixas_pagamentos?on_conflict=despesa_id,mes_referencia', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(linha)
    });
    res.json(rows[0]);
  } catch (e) { erro500(res, 'fixas/pagar POST', e); }
});

// ─── Reserva ─────────────────────────────────────────────────
async function saldoReserva() {
  const rows = await sbJson('bolso_reserva?select=tipo,valor');
  return rows.reduce((s, r) => s + (r.tipo === 'aporte' ? num(r.valor) : -num(r.valor)), 0);
}

app.get('/bolso/reserva', auth, async (req, res) => {
  try {
    const ref = refValida(req.query.ref) ? req.query.ref : mesSP();
    const [ini, fim] = rangeMes(ref);
    const [extrato, todos] = await Promise.all([
      sbJson('bolso_reserva?order=ts.desc&limit=200'),
      sbJson('bolso_reserva?select=tipo,valor,ts')
    ]);
    const saldo = todos.reduce((s, r) => s + (r.tipo === 'aporte' ? num(r.valor) : -num(r.valor)), 0);
    const doMes = todos.filter(r => r.ts >= ini && r.ts < fim);
    const guardadoMes = doMes.reduce((s, r) => s + (r.tipo === 'aporte' ? num(r.valor) : -num(r.valor)), 0);
    res.json({ saldo_total: saldo, guardado_mes: guardadoMes, extrato });
  } catch (e) { erro500(res, 'reserva GET', e); }
});

app.post('/bolso/reserva', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const valor = num(b.valor);
    if (!['aporte', 'resgate'].includes(b.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if (valor <= 0) return res.status(400).json({ error: 'Valor inválido' });
    if (b.tipo === 'resgate') {
      const saldo = await saldoReserva();
      if (valor > saldo) {
        const saldoBR = saldo.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        return res.status(400).json({ error: `Você tem ${saldoBR} guardado.`, saldo });
      }
    }
    const rows = await sbJson('bolso_reserva', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ tipo: b.tipo, valor, descricao: b.descricao || null })
    });
    res.json(rows[0]);
  } catch (e) { erro500(res, 'reserva POST', e); }
});

app.delete('/bolso/reserva/:id', auth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
    res.json(await sbJson(`bolso_reserva?id=eq.${req.params.id}`, {
      method: 'DELETE', headers: { 'Prefer': 'return=representation' }
    }));
  } catch (e) { erro500(res, 'reserva DELETE', e); }
});

// ─── Resumo — payload único do dashboard ─────────────────────
app.get('/bolso/resumo', auth, async (req, res) => {
  try {
    const ref = refValida(req.query.ref) ? req.query.ref : mesSP();
    const [ini, fim] = rangeMes(ref);
    const refIni6 = refMenos(ref, 5);                 // 6 meses incluindo o ref
    const [ini6] = rangeMes(refIni6);

    // Perfil primeiro: dá o dia de fechamento p/ montar o ciclo da fatura (que cruza meses)
    const perfilRows = await sbJson('bolso_perfil?limit=1');
    const perfil = perfilRows[0] || {};
    const cartaoFech = num(perfil.cartao_fechamento) || 5;
    const cartaoVenc = num(perfil.cartao_vencimento) || 10;
    const ciclo = faturaCiclo(ref, cartaoFech, cartaoVenc);

    const [gastosMes, entradasMes, fixasMes, reservaTudo, gastos6, entradas6, pagamentos6, creditoCiclo] = await Promise.all([
      sbJson(`bolso_gastos?ts=gte.${ini}&ts=lt.${fim}&select=id,ts,valor,categoria,descricao,forma_pagamento,itens&order=ts.desc&limit=1000`),
      sbJson(`bolso_entradas?ts=gte.${ini}&ts=lt.${fim}&select=valor,tipo`),
      fixasDoMes(ref),
      sbJson('bolso_reserva?select=tipo,valor,ts'),
      sbJson(`bolso_gastos?ts=gte.${ini6}&ts=lt.${fim}&select=ts,valor,forma_pagamento`),
      sbJson(`bolso_entradas?ts=gte.${ini6}&ts=lt.${fim}&select=ts,valor`),
      sbJson(`bolso_fixas_pagamentos?mes_referencia=gte.${refIni6}-01&mes_referencia=lte.${ref}-01&select=mes_referencia,valor_pago`),
      sbJson(`bolso_gastos?forma_pagamento=eq.credito&ts=gte.${ciclo.ini}&ts=lt.${ciclo.fim}&select=valor&limit=2000`)
    ]);

    const soma = (arr, f = r => num(r.valor)) => arr.reduce((s, r) => s + f(r), 0);
    const mesDoTs = ts => new Date(new Date(ts).getTime() - tzMs).toISOString().slice(0, 7);
    const ehCredito = g => g.forma_pagamento === 'credito';

    const totEntradas = soma(entradasMes);
    const totGastos = soma(gastosMes);                          // todos (visão de consumo)
    const totGastosCredito = soma(gastosMes.filter(ehCredito)); // vão pra fatura, não pro caixa
    const totGastosCaixa = totGastos - totGastosCredito;        // dinheiro que realmente saiu (débito/pix/etc.)
    const faturaEmFormacao = soma(creditoCiclo);                // compras no crédito do ciclo que fecha em ref
    const fixasAbertas = fixasMes.filter(f => f.status !== 'paga');
    const totFixasAberto = soma(fixasAbertas, f => num(f.estimativa)); // variáveis entram pela estimativa
    const totFixasPago = soma(fixasMes.filter(f => f.status === 'paga'), f => num(f.valor_pago ?? f.valor));

    const reservaMes = reservaTudo.filter(r => r.ts >= ini && r.ts < fim);
    const aportesMes = soma(reservaMes.filter(r => r.tipo === 'aporte'));
    const resgatesMes = soma(reservaMes.filter(r => r.tipo === 'resgate'));
    const guardadoMes = aportesMes - resgatesMes;
    const saldoReservaTotal = soma(reservaTudo, r => r.tipo === 'aporte' ? num(r.valor) : -num(r.valor));

    // Saldo livre: o que ainda dá pra gastar no mês. Compras no crédito NÃO entram
    // aqui — quem pesa é a fatura (lançada como fixa). Só o gasto no caixa (débito/
    // pix/dinheiro/boleto) e as fixas (pagas + em aberto) reduzem o saldo.
    const saldoLivre = totEntradas + resgatesMes - totGastosCaixa - totFixasPago - totFixasAberto - aportesMes;

    // Gráficos — categorias "explodidas": item classificado conta na própria
    // categoria; o restante do gasto cai na categoria geral dele
    const porCategoria = {};
    const somaCat = (cat, v) => { if (v > 0.004) porCategoria[cat] = (porCategoria[cat] || 0) + v; };
    for (const g of gastosMes) {
      let resto = num(g.valor);
      for (const i of (Array.isArray(g.itens) ? g.itens : [])) {
        const v = Math.min(num(i && i.valor), resto);
        if (i && i.categoria && v > 0) { somaCat(i.categoria, v); resto -= v; }
      }
      somaCat(g.categoria || 'outros', resto);
    }
    const porForma = {};
    for (const g of gastosMes) {
      const f = g.forma_pagamento || 'nao_informado';
      porForma[f] = (porForma[f] || 0) + num(g.valor);
    }
    const meses6 = Array.from({ length: 6 }, (_, i) => refMenos(ref, 5 - i));
    const serie6 = meses6.map(m => ({ ref: m, entrou: 0, gastou: 0, guardou: 0 }));
    const porRef = Object.fromEntries(serie6.map(s => [s.ref, s]));
    for (const e of entradas6) { const s = porRef[mesDoTs(e.ts)]; if (s) s.entrou += num(e.valor); }
    for (const g of gastos6) { const s = porRef[mesDoTs(g.ts)]; if (s && !ehCredito(g)) s.gastou += num(g.valor); } // crédito conta via fatura
    for (const p of pagamentos6) { const s = porRef[p.mes_referencia.slice(0, 7)]; if (s) s.gastou += num(p.valor_pago); }
    for (const r of reservaTudo) {
      const s = porRef[mesDoTs(r.ts)];
      if (s) s.guardou += r.tipo === 'aporte' ? num(r.valor) : -num(r.valor);
    }

    const totFixasMes = totFixasPago + totFixasAberto;
    const sobra = Math.max(totEntradas - totGastosCaixa - totFixasMes - guardadoMes, 0);

    const meta = num(perfil.meta_mensal);
    res.json({
      ref,
      hoje: hojeSP(),
      perfil,
      totais: {
        entradas: totEntradas,
        gastos: totGastosCaixa,          // dinheiro que saiu do caixa (sem crédito)
        gastos_credito: totGastosCredito, // compras no crédito do mês (entram na fatura)
        gastos_total: totGastos,          // consumo total (caixa + crédito)
        fixas_pago: totFixasPago,
        fixas_aberto: totFixasAberto,
        aportes: aportesMes,
        resgates: resgatesMes,
        guardado_mes: guardadoMes,
        saldo_livre: saldoLivre,
        falta_meta: Math.max(meta - guardadoMes, 0)
      },
      fatura_cartao: {
        fechamento: cartaoFech, vencimento: cartaoVenc,
        fecha: ciclo.fecha, vence: ciclo.vence,
        total: faturaEmFormacao   // compras no crédito do ciclo que fecha neste mês
      },
      reserva: {
        saldo_total: saldoReservaTotal,
        objetivo_nome: perfil.objetivo_nome || null,
        objetivo_valor: perfil.objetivo_valor !== null && perfil.objetivo_valor !== undefined ? num(perfil.objetivo_valor) : null,
        objetivo_prazo: perfil.objetivo_prazo || null,
        progresso_pct: num(perfil.objetivo_valor) > 0
          ? Math.min(saldoReservaTotal / num(perfil.objetivo_valor) * 100, 100) : null
      },
      contas_a_vencer: fixasAbertas.map(f => ({
        id: f.id, nome: f.nome, valor: num(f.estimativa), vencimento: f.vencimento, status: f.status,
        variavel: !!f.valor_variavel, a_definir: !!f.valor_variavel && !num(f.estimativa)
      })),
      graficos: {
        categorias: Object.entries(porCategoria).map(([categoria, total]) => ({ categoria, total }))
          .sort((a, b) => b.total - a.total),
        formas: Object.entries(porForma).map(([forma, total]) => ({ forma, total }))
          .sort((a, b) => b.total - a.total),
        seis_meses: serie6,
        composicao: { fixas: totFixasMes, variaveis: totGastosCaixa, guardado: Math.max(guardadoMes, 0), sobra }
      },
      gastos_mes: gastosMes
    });
  } catch (e) { erro500(res, 'resumo GET', e); }
});

// ─── Health ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    v: 6,
    anthropic: !!ANTHROPIC_API_KEY,
    supabase: !!(BOLSO_SUPABASE_URL && BOLSO_SUPABASE_KEY),
    senha: !!BOLSO_SENHA
  });
});

app.listen(PORT, () => {
  console.log(`Bolso rodando na porta ${PORT}`);
});

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const cron        = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');

const app       = express();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const PORT      = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

/* ── BOT ── */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, msg => {
  const id = msg.chat.id;
  bot.sendMessage(id,
    `🌿 *WorkHub Bot ativo!*\n\nOlá, *${msg.from.first_name}*!\n\nSeu *Chat ID* é:\n\`${id}\`\n\nCopie este número e cole em *TELEGRAM\\_CHAT\\_ID* nas variáveis do Render.`,
    { parse_mode: 'Markdown' });
  console.log(`📲 /start — Chat ID: ${id}`);
});

bot.onText(/\/status/, async msg => {
  const txt = await buildSummary();
  bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' });
});

bot.onText(/\/tarefas/, msg => {
  const abertas = db.tasks.filter(t => t.col !== 'done');
  if (!abertas.length) { bot.sendMessage(msg.chat.id, '✅ Nenhuma tarefa em aberto!'); return; }
  const prioEmoji = { urgente:'🔴', alta:'🟠', media:'🟡', baixa:'⚪' };
  const colNome   = { todo:'A fazer', doing:'Em andamento', review:'Revisão' };
  const lista = abertas.map(t =>
    `${prioEmoji[t.prio]||'⚪'} *${t.title}*\n   └ ${colNome[t.col]||t.col}${t.due?' · prazo: '+fmtDate(t.due):''}`
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, `📋 *Tarefas em aberto*\n\n${lista}`, { parse_mode:'Markdown' });
});

bot.onText(/\/agenda/, msg => {
  const hoje  = todayISO();
  const limit = addDays(hoje, 7);
  const evs = db.events.filter(e => e.date >= hoje && e.date <= limit)
    .sort((a,b) => (a.date+a.start) > (b.date+b.start) ? 1 : -1);
  if (!evs.length) { bot.sendMessage(msg.chat.id, '📅 Nenhum evento nos próximos 7 dias.'); return; }
  const catEmoji = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' };
  const lista = evs.map(e =>
    `${catEmoji[e.cat]||'📌'} *${e.title}*\n   └ ${fmtDate(e.date)}${e.start?' às '+e.start:''}${e.local?' · '+e.local:''}`
  ).join('\n\n');
  bot.sendMessage(msg.chat.id, `📅 *Agenda — próximos 7 dias*\n\n${lista}`, { parse_mode:'Markdown' });
});

bot.onText(/\/ajuda|\/help/, msg => {
  bot.sendMessage(msg.chat.id,
    `🌿 *WorkHub — Comandos*\n\n/start — Ver seu Chat ID\n/status — Resumo do dia\n/tarefas — Tarefas em aberto\n/agenda — Eventos dos próximos 7 dias\n/ajuda — Esta mensagem`,
    { parse_mode:'Markdown' });
});

/* ── BANCO EM MEMÓRIA ── */
const db = {
  tasks: [
    { id:1, title:'Configurar CI/CD no GitHub Actions', col:'todo',   prio:'alta',    tag:'dev',    due:'2026-07-18' },
    { id:2, title:'Corrigir bug no relatório de vendas', col:'doing',  prio:'urgente', tag:'bug',    due:'2026-07-10' },
    { id:3, title:'Testes unitários — módulo usuários',  col:'review', prio:'media',   tag:'teste',  due:'2026-07-12' },
  ],
  events: [
    { id:1, title:'Sprint Review',        date:'2026-07-09', start:'14:00', cat:'reuniao',  local:'Sala Ágora', remind:15   },
    { id:2, title:'Entrega do módulo v2', date:'2026-07-15', start:'',      cat:'entrega',  local:'',           remind:1440 },
    { id:3, title:'1:1 com gestor',       date:'2026-07-22', start:'10:00', cat:'reuniao',  local:'Sala 3',     remind:30   },
    { id:4, title:'Prazo — relatório Q2', date:'2026-07-25', start:'',      cat:'prazo',    local:'',           remind:1440 },
  ],
};

/* ── ENVIO TELEGRAM ── */
async function sendTelegram(msg) {
  if (!CHAT_ID) { console.warn('⚠️  TELEGRAM_CHAT_ID não definido'); return; }
  try {
    await bot.sendMessage(CHAT_ID, msg, { parse_mode:'Markdown' });
    console.log('✅ Telegram:', msg.slice(0,60));
  } catch(e) { console.error('❌ Telegram erro:', e.message); }
}

async function buildSummary() {
  const hoje = todayISO();
  const evHoje   = db.events.filter(e => e.date === hoje);
  const urgentes = db.tasks.filter(t => t.prio === 'urgente' && t.col !== 'done');
  const vencidas = db.tasks.filter(t => t.due && t.due < hoje && t.col !== 'done');
  let msg = `🌿 *WorkHub — Resumo do dia*\n📅 ${fmtDateFull(hoje)}\n\n`;
  if (evHoje.length) {
    msg += `📌 *Eventos de hoje:*\n`;
    const emoji = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' };
    evHoje.forEach(e => { msg += `${emoji[e.cat]||'📌'} ${e.title}${e.start?' às '+e.start:''}\n`; });
    msg += '\n';
  }
  if (urgentes.length) {
    msg += `🔴 *Tarefas urgentes:*\n`;
    urgentes.forEach(t => { msg += `• ${t.title}\n`; });
    msg += '\n';
  }
  if (vencidas.length) {
    msg += `⚠️ *Tarefas vencidas:*\n`;
    vencidas.forEach(t => { msg += `• ${t.title} (${fmtDate(t.due)})\n`; });
    msg += '\n';
  }
  const aberto = db.tasks.filter(t => t.col !== 'done').length;
  const concluido = db.tasks.filter(t => t.col === 'done').length;
  msg += `📊 ${aberto} em aberto · ${concluido} concluída(s)`;
  return msg;
}

/* ── CRON — ALERTAS AUTOMÁTICOS ── */
cron.schedule('0 8 * * *',  async () => { console.log('⏰ Resumo diário'); await sendTelegram(await buildSummary()); }, { timezone:'America/Sao_Paulo' });
cron.schedule('30 7 * * *', async () => {
  const evs = db.events.filter(e => e.date === todayISO());
  if (!evs.length) return;
  const emoji = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' };
  let msg = `📅 *Você tem ${evs.length} evento(s) hoje!*\n\n`;
  evs.forEach(e => { msg += `${emoji[e.cat]||'📌'} *${e.title}*\n   └ ${e.start?'às '+e.start:'dia inteiro'}${e.local?' · '+e.local:''}\n\n`; });
  await sendTelegram(msg);
}, { timezone:'America/Sao_Paulo' });
cron.schedule('0 9 * * *', async () => {
  const venc = db.tasks.filter(t => t.due && t.due < todayISO() && t.col !== 'done');
  if (!venc.length) return;
  let msg = `⚠️ *Tarefas vencidas!*\n\n`;
  venc.forEach(t => { msg += `🔴 *${t.title}*\n   └ venceu em ${fmtDate(t.due)}\n\n`; });
  await sendTelegram(msg);
}, { timezone:'America/Sao_Paulo' });
cron.schedule('0 18 * * *', async () => {
  const ama = addDays(todayISO(), 1);
  const prox = db.tasks.filter(t => t.due === ama && t.col !== 'done');
  if (!prox.length) return;
  let msg = `⏰ *Prazos amanhã!*\n\n`;
  const pe = { urgente:'🔴', alta:'🟠', media:'🟡', baixa:'⚪' };
  prox.forEach(t => { msg += `${pe[t.prio]||'⚪'} *${t.title}*\n   └ prioridade: ${t.prio}\n\n`; });
  await sendTelegram(msg);
}, { timezone:'America/Sao_Paulo' });
cron.schedule('*/5 * * * *', async () => {
  const agora = new Date();
  const hoje  = todayISO();
  const agoraMin = agora.getHours()*60 + agora.getMinutes();
  for (const ev of db.events) {
    if (ev.date !== hoje || !ev.start || !ev.remind) continue;
    const [h,m] = ev.start.split(':').map(Number);
    const diff = (h*60+m) - agoraMin;
    if (diff === parseInt(ev.remind)) {
      const emoji = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' };
      const label = ev.remind >= 60 ? `${ev.remind/60}h` : `${ev.remind}min`;
      await sendTelegram(`${emoji[ev.cat]||'📌'} *Lembrete: ${ev.title}*\n\n⏱️ Começa em *${label}* (às ${ev.start})${ev.local?'\n📍 '+ev.local:''}`);
    }
  }
});

/* ── API REST ── */
function auth(req,res,next){if(req.headers['x-api-key']!==process.env.API_SECRET)return res.status(401).json({error:'Não autorizado'});next();}
app.get('/api/tasks',        auth, (req,res) => res.json(db.tasks));
app.post('/api/tasks',       auth, (req,res) => { const t={id:Date.now(),...req.body}; db.tasks.push(t); res.status(201).json(t); });
app.put('/api/tasks/:id',    auth, (req,res) => { const i=db.tasks.findIndex(t=>t.id===+req.params.id); if(i<0)return res.status(404).json({error:'Não encontrado'}); db.tasks[i]={...db.tasks[i],...req.body}; res.json(db.tasks[i]); });
app.delete('/api/tasks/:id', auth, (req,res) => { db.tasks=db.tasks.filter(t=>t.id!==+req.params.id); res.json({ok:true}); });
app.get('/api/events',        auth, (req,res) => res.json(db.events));
app.post('/api/events',       auth, (req,res) => { const e={id:Date.now(),...req.body}; db.events.push(e); res.status(201).json(e); });
app.put('/api/events/:id',    auth, (req,res) => { const i=db.events.findIndex(e=>e.id===+req.params.id); if(i<0)return res.status(404).json({error:'Não encontrado'}); db.events[i]={...db.events[i],...req.body}; res.json(db.events[i]); });
app.delete('/api/events/:id', auth, (req,res) => { db.events=db.events.filter(e=>e.id!==+req.params.id); res.json({ok:true}); });
app.post('/api/alert', auth, async (req,res) => { if(!req.body.message)return res.status(400).json({error:'message obrigatório'}); await sendTelegram(req.body.message); res.json({ok:true}); });

app.get('/health', (req,res) => res.json({
  status:'ok',
  uptime: process.uptime().toFixed(0)+'s',
  tasks:  db.tasks.length,
  events: db.events.length,
  telegram: CHAT_ID ? 'configurado ✅' : 'aguardando Chat ID ⚠️',
}));

app.get('/', (req,res) => res.send(`
<html><body style="font-family:sans-serif;padding:40px;max-width:560px;margin:0 auto">
<h2>🌿 WorkHub Backend</h2>
<p>Servidor rodando! <a href="/health">Ver status</a></p>
<h3>Próximo passo:</h3>
<ol>
<li>Abra o Telegram e procure seu bot</li>
<li>Envie <code>/start</code></li>
<li>Copie o <strong>Chat ID</strong> que ele responder</li>
<li>Cole em <strong>TELEGRAM_CHAT_ID</strong> nas variáveis do Render</li>
</ol>
</body></html>`));

/* ── UTILS ── */
function todayISO(){ return new Date().toISOString().slice(0,10); }
function addDays(iso,n){ const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function fmtDate(iso){ const[y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function fmtDateFull(iso){ const dt=new Date(iso+'T12:00:00'); const dias=['domingo','segunda','terça','quarta','quinta','sexta','sábado']; return `${dias[dt.getDay()]}, ${fmtDate(iso)}`; }

app.listen(PORT, () => {
  console.log(`\n🌿 WorkHub rodando na porta ${PORT}`);
  console.log(`📡 Status: http://localhost:${PORT}/health`);
  console.log(`🤖 Telegram: ${CHAT_ID ? 'configurado ✅' : 'aguardando Chat ID ⚠️'}\n`);
});

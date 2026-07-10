require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const cron         = require('node-cron');
const TelegramBot  = require('node-telegram-bot-api');
const { Pool }     = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
        col TEXT DEFAULT 'todo', prio TEXT DEFAULT 'media', tag TEXT DEFAULT 'dev',
        due DATE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY, title TEXT NOT NULL, date DATE NOT NULL,
        start_time TEXT DEFAULT '', end_time TEXT DEFAULT '', cat TEXT DEFAULT 'reuniao',
        local TEXT DEFAULT '', description TEXT DEFAULT '', remind INTEGER DEFAULT 15,
        repeat TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY, title TEXT DEFAULT '', content TEXT DEFAULT '',
        category TEXT DEFAULT '', tags TEXT[] DEFAULT '{}', pinned BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS note_categories (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT 'ti-folder', color TEXT DEFAULT '#1D9E75'
      );
    `);
    console.log('✅ Banco de dados pronto!');
  } catch (e) {
    console.error('❌ Erro ao inicializar banco:', e.message);
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
let bot;

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.onText(/\/start/, msg => { bot.sendMessage(msg.chat.id, `🌿 *WorkHub Bot ativo!*\n\nOlá, *${msg.from.first_name}*!\n\nSeu Chat ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' }); });
  bot.onText(/\/status/, async msg => { bot.sendMessage(msg.chat.id, await buildSummary(), { parse_mode: 'Markdown' }); });
  bot.onText(/\/tarefas/, async msg => { const { rows } = await pool.query(`SELECT * FROM tasks WHERE col != 'done' ORDER BY prio DESC`); if (!rows.length) { bot.sendMessage(msg.chat.id, '✅ Nenhuma tarefa em aberto!'); return; } const pe = { urgente:'🔴', alta:'🟠', media:'🟡', baixa:'⚪' }; const cn = { todo:'A fazer', doing:'Em andamento', review:'Revisão' }; bot.sendMessage(msg.chat.id, `📋 *Tarefas em aberto*\n\n${rows.map(t => `${pe[t.prio]||'⚪'} *${t.title}*\n   └ ${cn[t.col]||t.col}${t.due?' · prazo: '+fmtDate(t.due.toISOString().slice(0,10)):''}`).join('\n\n')}`, { parse_mode:'Markdown' }); });
  bot.onText(/\/agenda/, async msg => { const hoje = todayISO(); const { rows } = await pool.query(`SELECT * FROM events WHERE date >= $1 AND date <= $2 ORDER BY date, start_time`, [hoje, addDays(hoje,7)]); if (!rows.length) { bot.sendMessage(msg.chat.id, '📅 Nenhum evento nos próximos 7 dias.'); return; } const ce = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' }; bot.sendMessage(msg.chat.id, `📅 *Agenda — próximos 7 dias*\n\n${rows.map(e => `${ce[e.cat]||'📌'} *${e.title}*\n   └ ${fmtDate(e.date.toISOString().slice(0,10))}${e.start_time?' às '+e.start_time:''}${e.local?' · '+e.local:''}`).join('\n\n')}`, { parse_mode:'Markdown' }); });
  bot.onText(/\/ajuda|\/help/, msg => { bot.sendMessage(msg.chat.id, `🌿 *WorkHub — Comandos*\n\n/start — Chat ID\n/status — Resumo do dia\n/tarefas — Tarefas em aberto\n/agenda — Próximos 7 dias\n/ajuda — Esta mensagem`, { parse_mode:'Markdown' }); });
}

async function sendTelegram(msg) { if (!bot || !CHAT_ID) return; try { await bot.sendMessage(CHAT_ID, msg, { parse_mode:'Markdown' }); } catch(e) { console.error('❌ Telegram:', e.message); } }

async function buildSummary() {
  const hoje = todayISO();
  const { rows: evHoje }   = await pool.query(`SELECT * FROM events WHERE date = $1`, [hoje]);
  const { rows: urgentes } = await pool.query(`SELECT * FROM tasks WHERE prio = 'urgente' AND col != 'done'`);
  const { rows: vencidas } = await pool.query(`SELECT * FROM tasks WHERE due < $1 AND col != 'done'`, [hoje]);
  const { rows: counts }   = await pool.query(`SELECT col, COUNT(*) FROM tasks GROUP BY col`);
  const aberto = counts.filter(r => r.col !== 'done').reduce((s,r) => s + parseInt(r.count), 0);
  const concluido = counts.find(r => r.col === 'done')?.count || 0;
  let msg = `🌿 *WorkHub — Resumo do dia*\n📅 ${fmtDateFull(hoje)}\n\n`;
  if (evHoje.length) { const ce = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' }; msg += `📌 *Eventos de hoje:*\n`; evHoje.forEach(e => { msg += `${ce[e.cat]||'📌'} ${e.title}${e.start_time?' às '+e.start_time:''}\n`; }); msg += '\n'; }
  if (urgentes.length) { msg += `🔴 *Urgentes:*\n`; urgentes.forEach(t => { msg += `• ${t.title}\n`; }); msg += '\n'; }
  if (vencidas.length) { msg += `⚠️ *Vencidas:*\n`; vencidas.forEach(t => { msg += `• ${t.title}\n`; }); msg += '\n'; }
  msg += `📊 ${aberto} em aberto · ${concluido} concluída(s)`;
  return msg;
}

cron.schedule('0 8 * * *',  async () => { await sendTelegram(await buildSummary()); }, { timezone:'America/Sao_Paulo' });
cron.schedule('30 7 * * *', async () => { const { rows } = await pool.query(`SELECT * FROM events WHERE date = $1`, [todayISO()]); if (!rows.length) return; const ce = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' }; let msg = `📅 *Eventos de hoje (${rows.length}):*\n\n`; rows.forEach(e => { msg += `${ce[e.cat]||'📌'} *${e.title}*\n   └ ${e.start_time?'às '+e.start_time:'dia inteiro'}${e.local?' · '+e.local:''}\n\n`; }); await sendTelegram(msg); }, { timezone:'America/Sao_Paulo' });
cron.schedule('0 9 * * *',  async () => { const { rows } = await pool.query(`SELECT * FROM tasks WHERE due < $1 AND col != 'done'`, [todayISO()]); if (!rows.length) return; let msg = `⚠️ *Tarefas vencidas!*\n\n`; rows.forEach(t => { msg += `🔴 *${t.title}*\n   └ venceu em ${fmtDate(t.due.toISOString().slice(0,10))}\n\n`; }); await sendTelegram(msg); }, { timezone:'America/Sao_Paulo' });
cron.schedule('0 18 * * *', async () => { const ama = addDays(todayISO(),1); const { rows } = await pool.query(`SELECT * FROM tasks WHERE due = $1 AND col != 'done'`, [ama]); if (!rows.length) return; const pe = { urgente:'🔴', alta:'🟠', media:'🟡', baixa:'⚪' }; let msg = `⏰ *Prazos amanhã!*\n\n`; rows.forEach(t => { msg += `${pe[t.prio]||'⚪'} *${t.title}*\n\n`; }); await sendTelegram(msg); }, { timezone:'America/Sao_Paulo' });

function auth(req, res, next) { if (req.headers['x-api-key'] !== process.env.API_SECRET) return res.status(401).json({ error: 'Não autorizado' }); next(); }

app.get('/api/tasks',        auth, async (req, res) => { const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC'); res.json(rows.map(formatTask)); });
app.post('/api/tasks',       auth, async (req, res) => { const { title, description='', col='todo', prio='media', tag='dev', due=null } = req.body; const { rows } = await pool.query(`INSERT INTO tasks (title,description,col,prio,tag,due) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [title, description, col, prio, tag, due||null]); res.status(201).json(formatTask(rows[0])); });
app.put('/api/tasks/:id',    auth, async (req, res) => { const { title, description, col, prio, tag, due } = req.body; const { rows } = await pool.query(`UPDATE tasks SET title=$1,description=$2,col=$3,prio=$4,tag=$5,due=$6,updated_at=NOW() WHERE id=$7 RETURNING *`, [title, description, col, prio, tag, due||null, req.params.id]); if (!rows.length) return res.status(404).json({ error: 'Não encontrado' }); res.json(formatTask(rows[0])); });
app.delete('/api/tasks/:id', auth, async (req, res) => { await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

app.get('/api/events',        auth, async (req, res) => { const { rows } = await pool.query('SELECT * FROM events ORDER BY date, start_time'); res.json(rows.map(formatEvent)); });
app.post('/api/events',       auth, async (req, res) => { const { title, date, start_time='', end_time='', cat='reuniao', local='', description='', remind=15, repeat='' } = req.body; const { rows } = await pool.query(`INSERT INTO events (title,date,start_time,end_time,cat,local,description,remind,repeat) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [title, date, start_time, end_time, cat, local, description, remind, repeat]); res.status(201).json(formatEvent(rows[0])); });
app.put('/api/events/:id',    auth, async (req, res) => { const { title, date, start_time, end_time, cat, local, description, remind, repeat } = req.body; const { rows } = await pool.query(`UPDATE events SET title=$1,date=$2,start_time=$3,end_time=$4,cat=$5,local=$6,description=$7,remind=$8,repeat=$9,updated_at=NOW() WHERE id=$10 RETURNING *`, [title, date, start_time, end_time, cat, local, description, remind, repeat, req.params.id]); if (!rows.length) return res.status(404).json({ error: 'Não encontrado' }); res.json(formatEvent(rows[0])); });
app.delete('/api/events/:id', auth, async (req, res) => { await pool.query('DELETE FROM events WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

app.get('/api/notes',        auth, async (req, res) => { const { rows } = await pool.query('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC'); res.json(rows); });
app.post('/api/notes',       auth, async (req, res) => { const { title='', content='', category='', tags=[], pinned=false } = req.body; const { rows } = await pool.query(`INSERT INTO notes (title,content,category,tags,pinned) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [title, content, category, tags, pinned]); res.status(201).json(rows[0]); });
app.put('/api/notes/:id',    auth, async (req, res) => { const { title, content, category, tags, pinned } = req.body; const { rows } = await pool.query(`UPDATE notes SET title=$1,content=$2,category=$3,tags=$4,pinned=$5,updated_at=NOW() WHERE id=$6 RETURNING *`, [title, content, category, tags, pinned, req.params.id]); if (!rows.length) return res.status(404).json({ error: 'Não encontrado' }); res.json(rows[0]); });
app.delete('/api/notes/:id', auth, async (req, res) => { await pool.query('DELETE FROM notes WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

app.get('/api/categories',        auth, async (req, res) => { const { rows } = await pool.query('SELECT * FROM note_categories ORDER BY id'); res.json(rows); });
app.post('/api/categories',       auth, async (req, res) => { const { name, icon='ti-folder', color='#1D9E75' } = req.body; const { rows } = await pool.query(`INSERT INTO note_categories (name,icon,color) VALUES ($1,$2,$3) RETURNING *`, [name, icon, color]); res.status(201).json(rows[0]); });
app.delete('/api/categories/:id', auth, async (req, res) => { await pool.query('DELETE FROM note_categories WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

app.post('/api/alert', auth, async (req, res) => { if (!req.body.message) return res.status(400).json({ error: 'message obrigatório' }); await sendTelegram(req.body.message); res.json({ ok: true }); });

app.get('/health', async (req, res) => { let db = 'ok'; try { await pool.query('SELECT 1'); } catch(e) { db = 'erro: '+e.message; } res.json({ status:'ok', uptime:process.uptime().toFixed(0)+'s', database:db, telegram: CHAT_ID?'configurado ✅':'aguardando ⚠️' }); });
app.get('/', (req, res) => res.send('<html><body style="font-family:sans-serif;padding:40px"><h2>🌿 WorkHub v2</h2><p><a href="/health">Ver status</a></p></body></html>'));

function todayISO() { return new Date().toISOString().slice(0,10); }
function addDays(iso, n) { const d = new Date(iso+'T12:00:00'); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function fmtDate(iso) { const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }
function fmtDateFull(iso) { const dt = new Date(iso+'T12:00:00'); const dias=['domingo','segunda','terça','quarta','quinta','sexta','sábado']; return `${dias[dt.getDay()]}, ${fmtDate(iso)}`; }
function formatTask(t) { return { ...t, due: t.due ? t.due.toISOString().slice(0,10) : null }; }
function formatEvent(e) { return { ...e, date: e.date ? e.date.toISOString().slice(0,10) : null, start: e.start_time, end: e.end_time }; }

initDB().then(() => { app.listen(PORT, () => { console.log(`\n🌿 WorkHub v2 na porta ${PORT}`); console.log(`🗄️  Banco: ${process.env.DATABASE_URL ? 'PostgreSQL ✅' : '⚠️ não definido'}`); }); });

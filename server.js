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

async function buildEventsMessage() {
  const { rows } = await pool.query(`SELECT * FROM events WHERE date = $1`, [todayISO()]);
  if (!rows.length) return null;
  const ce = { reuniao:'🤝', prazo:'⏰', entrega:'📦', pessoal:'👤', lembrete:'🔔' };
  let msg = `📅 *Eventos de hoje (${rows.length}):*\n\n`;
  rows.forEach(e => {
    msg += `${ce[e.cat]||'📌'} *${e.title}*\n   └ ${e.start_time?'às '+e.start_time:'dia inteiro'}${e.local?' · '+e.local:''}\n\n`;
  });
  return msg;
}

async function buildDeadlinesMessage() {
  const ama = addDays(todayISO(),1);
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE due = $1 AND col != 'done'`, [ama]);
  if (!rows.length) return null;
  const pe = { urgente:'🔴', alta:'🟠', media:'🟡', baixa:'⚪' };
  let msg = `⏰ *Prazos amanhã!*\n\n`;
  rows.forEach(t => {
    msg += `${pe[t.prio]||'⚪'} *${t.title}*\n\n`;
  });
  return msg;
}

async function buildVencidasMessage() {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE due < $1 AND col != 'done'`, [todayISO()]);
  if (!rows.length) return null;
  let msg = `⚠️ *Tarefas vencidas!*\n\n`;
  rows.forEach(t => {
    msg += `🔴 *${t.title}*\n   └ venceu em ${fmtDate(t.due.toISOString().slice(0,10))}\n\n`;
  });
  return msg;
}

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

// Tarefas internas do node-cron
cron.schedule('0 8 * * *',  async () => { await sendTelegram(await buildSummary()); }, { timezone:'America/Sao_Paulo' });
cron.schedule('30 7 * * *', async () => { const msg = await buildEventsMessage(); if (msg) await sendTelegram(msg); }, { timezone:'America/Sao_Paulo' });
cron.schedule('0 9 * * *',  async () => { const msg = await buildVencidasMessage(); if (msg) await sendTelegram(msg); }, { timezone:'America/Sao_Paulo' });
cron.schedule('0 18 * * *', async () => { const msg = await buildDeadlinesMessage(); if (msg) await sendTelegram(msg); }, { timezone:'America/Sao_Paulo' });

// Verificador minuto a minuto para disparo automático de lembretes de eventos
cron.schedule('* * * * *', async () => {
  try {
    const agora = new Date();
    const utcMs = agora.getTime() + (agora.getTimezoneOffset() * 60000);
    const brtDate = new Date(utcMs - (3 * 3600000));
    const hoje = brtDate.toISOString().slice(0, 10);
    const horaAtual = brtDate.toTimeString().slice(0, 5);

    const { rows: events } = await pool.query(`SELECT * FROM events WHERE date = $1`, [hoje]);

    for (const e of events) {
      if (!e.start_time) continue;
      const remindMins = parseInt(e.remind) || 15;
      const [h, m] = e.start_time.split(':').map(Number);
      const evDate = new Date(brtDate);
      evDate.setHours(h, m - remindMins, 0, 0);
      const alertTime = evDate.toTimeString().slice(0, 5);

      if (alertTime === horaAtual) {
        await sendEventTelegram(e, `🔔 Lembrete: Evento em ${remindMins} min!`);
      }
    }
  } catch (err) {
    console.error('❌ Erro cron lembretes:', err.message);
  }
}, { timezone:'America/Sao_Paulo' });

function auth(req, res, next) { if (req.headers['x-api-key'] !== process.env.API_SECRET) return res.status(401).json({ error: 'Não autorizado' }); next(); }

// Rotas de acionamento externo para contornar o Sleep Mode do Render
app.get('/api/cron/events', auth, async (req, res) => {
  try {
    const msg = await buildEventsMessage();
    if (msg) {
      await sendTelegram(msg);
      res.json({ ok: true, sent: true, message: 'Eventos enviados' });
    } else {
      res.json({ ok: true, sent: false, message: 'Nenhum evento hoje' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cron/summary', auth, async (req, res) => {
  try {
    const msg = await buildSummary();
    await sendTelegram(msg);
    res.json({ ok: true, sent: true, message: 'Resumo enviado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cron/deadlines', auth, async (req, res) => {
  try {
    const msg = await buildDeadlinesMessage();
    if (msg) {
      await sendTelegram(msg);
      res.json({ ok: true, sent: true, message: 'Prazos de amanhã enviados' });
    } else {
      res.json({ ok: true, sent: false, message: 'Nenhum prazo para amanhã' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cron/vencidas', auth, async (req, res) => {
  try {
    const msg = await buildVencidasMessage();
    if (msg) {
      await sendTelegram(msg);
      res.json({ ok: true, sent: true, message: 'Aviso de tarefas vencidas enviado' });
    } else {
      res.json({ ok: true, sent: false, message: 'Nenhuma tarefa vencida' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/migrate-data', auth, async (req, res) => {
  const { old_db_url } = req.body;
  if (!old_db_url) return res.status(400).json({ error: 'old_db_url é obrigatório' });
  const oldPool = new Pool({ connectionString: old_db_url, ssl: { rejectUnauthorized: false } });
  try {
    console.log('🔄 Iniciando migração de dados...');
    
    // 1. Categories
    const categories = await oldPool.query('SELECT * FROM note_categories');
    for (const row of categories.rows) {
      await pool.query(
        `INSERT INTO note_categories (id, name, icon, color) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [row.id, row.name, row.icon, row.color]
      );
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('note_categories', 'id'), coalesce(max(id), 1)) FROM note_categories`);

    // 2. Notes
    const notes = await oldPool.query('SELECT * FROM notes');
    for (const row of notes.rows) {
      await pool.query(
        `INSERT INTO notes (id, title, content, category, tags, pinned, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [row.id, row.title, row.content, row.category, row.tags, row.pinned, row.created_at, row.updated_at]
      );
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('notes', 'id'), coalesce(max(id), 1)) FROM notes`);

    // 3. Events
    const events = await oldPool.query('SELECT * FROM events');
    for (const row of events.rows) {
      await pool.query(
        `INSERT INTO events (id, title, date, start_time, end_time, cat, local, description, remind, repeat, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
        [row.id, row.title, row.date, row.start_time, row.end_time, row.cat, row.local, row.description, row.remind, row.repeat, row.created_at, row.updated_at]
      );
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('events', 'id'), coalesce(max(id), 1)) FROM events`);

    // 4. Tasks
    const tasks = await oldPool.query('SELECT * FROM tasks');
    for (const row of tasks.rows) {
      await pool.query(
        `INSERT INTO tasks (id, title, description, col, prio, tag, due, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [row.id, row.title, row.description, row.col, row.prio, row.tag, row.due, row.created_at, row.updated_at]
      );
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('tasks', 'id'), coalesce(max(id), 1)) FROM tasks`);

    res.json({
      ok: true,
      message: 'Migração concluída com sucesso',
      counts: {
        categories: categories.rows.length,
        notes: notes.rows.length,
        events: events.rows.length,
        tasks: tasks.rows.length
      }
    });
  } catch (err) {
    console.error('❌ Erro na migração:', err);
    res.status(500).json({ error: 'Erro na migração: ' + err.message });
  } finally {
    await oldPool.end();
  }
});

app.post('/api/query-old-db', auth, async (req, res) => {
  const { old_db_url, sql } = req.body;
  if (!old_db_url || !sql) return res.status(400).json({ error: 'Parâmetros ausentes' });
  const oldPool = new Pool({ connectionString: old_db_url, ssl: { rejectUnauthorized: false } });
  try {
    const { rows } = await oldPool.query(sql);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await oldPool.end();
  }
});

app.get('/api/env-debug', auth, (req, res) => {
  res.json({ env: Object.keys(process.env).reduce((acc, key) => {
    // Retornar chaves e os primeiros/últimos caracteres para segurança
    const val = process.env[key] || '';
    acc[key] = val.length > 15 ? val.slice(0, 10) + '...' + val.slice(-10) : val;
    return acc;
  }, {}) });
});

app.get('/api/tasks',        auth, async (req, res) => { const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC'); res.json(rows.map(formatTask)); });
app.post('/api/tasks',       auth, async (req, res) => { const { title, description='', col='todo', prio='media', tag='dev', due=null } = req.body; const { rows } = await pool.query(`INSERT INTO tasks (title,description,col,prio,tag,due) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [title, description, col, prio, tag, due||null]); res.status(201).json(formatTask(rows[0])); });
app.put('/api/tasks/:id',    auth, async (req, res) => { const { title, description, col, prio, tag, due } = req.body; const { rows } = await pool.query(`UPDATE tasks SET title=$1,description=$2,col=$3,prio=$4,tag=$5,due=$6,updated_at=NOW() WHERE id=$7 RETURNING *`, [title, description, col, prio, tag, due||null, req.params.id]); if (!rows.length) return res.status(404).json({ error: 'Não encontrado' }); res.json(formatTask(rows[0])); });
app.delete('/api/tasks/:id', auth, async (req, res) => { await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

app.get('/api/events',        auth, async (req, res) => { const { rows } = await pool.query('SELECT * FROM events ORDER BY date, start_time'); res.json(rows.map(formatEvent)); });
app.post('/api/events',       auth, async (req, res) => {
  const { title, date, start_time='', end_time='', cat='reuniao', local='', description='', remind=15, repeat='' } = req.body;
  const { rows } = await pool.query(`INSERT INTO events (title,date,start_time,end_time,cat,local,description,remind,repeat) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [title, date, start_time, end_time, cat, local, description, remind, repeat]);
  const formatted = formatEvent(rows[0]);
  try { await sendEventTelegram(rows[0], 'Novo Evento na Agenda'); } catch(e) { console.error(e); }
  res.status(201).json(formatted);
});
app.put('/api/events/:id',    auth, async (req, res) => {
  const { title, date, start_time, end_time, cat, local, description, remind, repeat } = req.body;
  const { rows } = await pool.query(`UPDATE events SET title=$1,date=$2,start_time=$3,end_time=$4,cat=$5,local=$6,description=$7,remind=$8,repeat=$9,updated_at=NOW() WHERE id=$10 RETURNING *`, [title, date, start_time, end_time, cat, local, description, remind, repeat, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
  const formatted = formatEvent(rows[0]);
  try { await sendEventTelegram(rows[0], 'Evento Atualizado'); } catch(e) { console.error(e); }
  res.json(formatted);
});
app.post('/api/events/:id/notify', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado' });
  await sendEventTelegram(rows[0], '🔔 Alerta de Evento');
  res.json({ ok: true, message: 'Alerta enviado para o Telegram' });
});
app.delete('/api/events/:id', auth, async (req, res) => { await pool.query('DELETE FROM events WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

async function sendEventTelegram(e, action = 'Novo Evento na Agenda') {
  if (!bot || !CHAT_ID) return;
  const ce = { reuniao:'🤝 Reunião', prazo:'⏰ Prazo', entrega:'📦 Entrega', pessoal:'👤 Pessoal', lembrete:'🔔 Lembrete' };
  const dateVal = typeof e.date === 'string' ? e.date : e.date.toISOString().slice(0,10);
  const dStr = fmtDate(dateVal);
  let msg = `📅 *${action}*\n\n`;
  msg += `📌 *${e.title}*\n`;
  msg += `📆 *Data:* ${dStr}${e.start_time ? ' às ' + e.start_time : ''}${e.end_time ? ' até ' + e.end_time : ''}\n`;
  msg += `🏷️ *Categoria:* ${ce[e.cat] || e.cat}\n`;
  if (e.local) msg += `📍 *Local:* ${e.local}\n`;
  if (e.description) msg += `📝 *Descrição:* ${e.description}\n`;
  if (e.remind) msg += `⏰ *Lembrete:* ${e.remind} min antes\n`;
  await sendTelegram(msg);
}

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
function formatTask(t) {
  return {
    ...t,
    due: t.due ? (typeof t.due === 'string' ? t.due.slice(0,10) : t.due.toISOString().slice(0,10)) : null,
    created_at: t.created_at ? (typeof t.created_at === 'string' ? t.created_at : t.created_at.toISOString()) : null
  };
}
function formatEvent(e) { return { ...e, date: e.date ? e.date.toISOString().slice(0,10) : null, start: e.start_time, end: e.end_time }; }

initDB().then(() => { app.listen(PORT, () => { console.log(`\n🌿 WorkHub v2 na porta ${PORT}`); console.log(`🗄️  Banco: ${process.env.DATABASE_URL ? 'PostgreSQL ✅' : '⚠️ não definido'}`); }); });

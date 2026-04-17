'use strict';
/**
 * MisCuentas — Bot Telegram Unificado
 * - Finanzas personales (gastos, ingresos, presupuesto, historial)
 * - Contabilidad (plan de cuentas, clientes, cxc, cxp)
 * - Reportes de negocio (diario, semanal, mensual)
 * - Inventario y productos
 * - Groq Vision para facturas
 * - Gemini AI para NLP
 * - OAuth Telegram ↔ web
 * Mode: polling (VPS)
 */

const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');
const crypto      = require('crypto');
const axios       = require('axios');

// ─── ENV ───────────────────────────────────────────────────────��──────────────
const {
  TELEGRAM_TOKEN,
  DATABASE_URL,
  GEMINI_API_KEY,
  GROQ_API_KEY,
  MISCUENTAS_API = 'https://miscuentas-contable-app-production.up.railway.app',
  SESSION_SECRET  = 'miscuentas_secret_change_me',
} = process.env;

if (!TELEGRAM_TOKEN) { console.error('❌ Missing TELEGRAM_TOKEN'); process.exit(1); }
if (!DATABASE_URL)   { console.error('❌ Missing DATABASE_URL');   process.exit(1); }

// ─── DB ───────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});
pool.on('error', err => console.error('PG pool error:', err.message));

async function query(sql, params = []) {
  const client = await pool.connect();
  try   { return await client.query(sql, params); }
  finally { client.release(); }
}

// ─── BOT (polling) ────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

async function sendMessage(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
}

async function getFileLink(fileId) {
  return bot.getFileLink(fileId);
}

// ─── SESSION TOKENS ───────────────────────────────────────────────────────────
function generateToken(userId) {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload   = `${userId}:${Date.now()}:${expiresAt}`;
  const sig       = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

async function createAuthToken(token, telegramId) {
  const sessionToken = generateToken(telegramId);
  await query(
    `INSERT INTO auth_tokens (token, telegram_id, session_token, created_at)
     VALUES($1,$2,$3,NOW())
     ON CONFLICT (token) DO UPDATE SET
       telegram_id   = EXCLUDED.telegram_id,
       session_token = EXCLUDED.session_token,
       created_at    = NOW()`,
    [token, telegramId, sessionToken]
  );
  return sessionToken;
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
const SYSTEM_ACCOUNTS = [
  { code:'1.1.01', name:'Caja',               type:'asset',     class:1 },
  { code:'1.1.02', name:'Banco',              type:'asset',     class:1 },
  { code:'1.1.03', name:'Inventario',          type:'asset',     class:1 },
  { code:'1.2.01', name:'Cuentas por Cobrar',  type:'asset',     class:1 },
  { code:'2.1.01', name:'Cuentas por Pagar',   type:'liability', class:2 },
  { code:'2.2.01', name:'ITBIS por Pagar',     type:'liability', class:2 },
  { code:'2.2.02', name:'Tarjetas de Crédito', type:'liability', class:2 },
  { code:'3.1.01', name:'Capital',              type:'equity',    class:3 },
  { code:'4.1.01', name:'Ingresos',             type:'income',    class:4 },
  { code:'5.1.01', name:'Costo de Ventas',      type:'cost',      class:5 },
  { code:'6.1.01', name:'Gastos Operativos',    type:'expense',   class:6 },
];

async function createSystemAccounts(userId) {
  for (const acc of SYSTEM_ACCOUNTS) {
    const id = `sys_${userId}_${acc.code.replace(/\./g, '_')}`;
    try {
      await query(
        `INSERT INTO accounts(id,user_id,code,name,type,class,is_system)
         VALUES($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT(user_id,code) DO NOTHING`,
        [id, userId, acc.code, acc.name, acc.type, acc.class]
      );
      await query(
        `INSERT INTO account_balances(account_id,balance) VALUES($1,0) ON CONFLICT(account_id) DO NOTHING`,
        [id]
      );
    } catch(e) { /* ignore dup */ }
  }
}

async function ensureUser(id, lang = 'es') {
  await query(
    `INSERT INTO users(id,lang) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,
    [id, lang]
  );
  await createSystemAccounts(id);
}

async function getUser(id) {
  const r = await query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function getUserLang(id) {
  const r = await query('SELECT lang FROM users WHERE id=$1', [id]);
  return r.rows[0]?.lang || 'es';
}

async function setUserLang(id, lang) {
  await query('UPDATE users SET lang=$2 WHERE id=$1', [id, lang]);
}

async function getMonthTxs(userId, month, year) {
  const r = await query(
    `SELECT * FROM transactions
     WHERE user_id=$1
       AND EXTRACT(MONTH FROM tx_date)=$2
       AND EXTRACT(YEAR  FROM tx_date)=$3
     ORDER BY created_at ASC`,
    [userId, month + 1, year]
  );
  return r.rows;
}

async function insertTx(tx) {
  await query(
    `INSERT INTO transactions(id,user_id,type,amount,description,category,account,tx_date)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tx.id, tx.userId, tx.type, tx.amount, tx.description, tx.category, tx.account, tx.date]
  );
}

async function getBudgets(userId) {
  const r = await query('SELECT category,amount FROM budgets WHERE user_id=$1', [userId]);
  const obj = {};
  r.rows.forEach(row => { obj[row.category] = parseFloat(row.amount); });
  return obj;
}

async function setBudget(userId, category, amount) {
  await query(
    `INSERT INTO budgets(user_id,category,amount) VALUES($1,$2,$3)
     ON CONFLICT(user_id,category) DO UPDATE SET amount=$3`,
    [userId, category, amount]
  );
}

async function getPending(userId) {
  const r = await query('SELECT tx_data FROM pending_tx WHERE user_id=$1', [userId]);
  return r.rows[0]?.tx_data || null;
}

async function setPending(userId, txData) {
  await query(
    `INSERT INTO pending_tx(user_id,tx_data) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET tx_data=$2, created_at=NOW()`,
    [userId, JSON.stringify(txData)]
  );
}

async function clearPending(userId) {
  await query('DELETE FROM pending_tx WHERE user_id=$1', [userId]);
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function uid() { return `tx_${Date.now()}_${Math.random().toString(36).substr(2,6)}`; }

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function fmtRD(n) { return 'RD$ ' + fmt(n); }

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MONTHS_EN = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];

const CAT_EMOJI = {
  comida:'🍽️', transporte:'🚗', servicios:'💡', salud:'🏥',
  entretenimiento:'🎬', ropa:'👕', educacion:'📚', salario:'💼',
  negocio:'🏪', inversion:'📈', prestamo:'🤝', ahorro:'💰', otro:'📦',
  food:'🍽️', transport:'🚗', health:'🏥', entertainment:'🎬',
  clothes:'👕', education:'📚', salary:'💼', business:'🏪', savings:'💰',
};
const ACC_EMOJI = { efectivo:'💵', banco:'🏦', tarjeta:'💳' };

function detectLang(msg = '') {
  const t = msg.toLowerCase();
  const esWords = ['gasté','gaste','pagué','pague','compré','compre','deposité','deposite',
    'cobré','cobre','recibí','recibi','ingresé','ingrese','sueldo','quincena','resumen',
    'cuentas','alertas','historial','presupuesto','ayuda','hola','gracias','si','sí','buenos'];
  return esWords.some(w => t.includes(w)) ? 'es' : 'en';
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
const MSG = {
  welcome: (id, lang) => lang === 'es'
    ? `👋 ¡Qué lo que! Soy *MisCuentas*, tu asistente de finanzas.\n\nPuedes decirme cosas como:\n• _"gasté 500 en comida"_\n• _"me depositaron la quincena 18000"_\n• _"cómo voy este mes?"_\n\nTu ID de Telegram es \`${id}\` — lo necesitas para entrar a la web.\n\nEscribe *ayuda* si quieres ver todo lo que puedo hacer.`
    : `👋 Welcome to *MisCuentas*! I'm your finance assistant.\n\nTry saying:\n• _"spent 50 on food"_\n• _"received salary 2000"_\n• _"how am I doing this month?"_\n\nYour Telegram ID: \`${id}\`\n\nType *help* for all commands.`,

  miid: (id, lang) => lang === 'es'
    ? `Tu ID de Telegram es:\n\n\`${id}\`\n\nCópialo y úsalo para entrar a la web.`
    : `Your Telegram ID:\n\n\`${id}\`\n\nCopy it to log in to the web.`,

  recorded: (tx, lang) => {
    const catE  = CAT_EMOJI[tx.category] || '📦';
    const accE  = ACC_EMOJI[tx.account]  || '💵';
    const arrow = tx.type === 'ingreso' ? '▲' : '▼';
    const esOk  = ['¡Ta bien, anotado! 🔥','Listo, quedó guardado 👌','Lo tengo, no hay problema ✅','Anotado en tu historial 📝','Perfecto, ya lo registré ✨'];
    const enOk  = ['Got it, recorded ✅','Done! Saved to your history 📝','All set 👌'];
    const phrase = lang === 'es' ? esOk[Math.floor(Math.random()*esOk.length)] : enOk[Math.floor(Math.random()*enOk.length)];
    return lang === 'es'
      ? `${phrase}\n\n${arrow} ${catE} *${tx.description}*\n💰 RD$ ${fmt(tx.amount)}\n${accE} ${tx.account}`
      : `${phrase}\n\n${arrow} ${catE} *${tx.description}*\n💰 ${fmt(tx.amount)}\n${accE} ${tx.account}`;
  },

  receiptPreview: (tx, lang) => lang === 'es'
    ? `🧾 Encontré esto en la foto:\n\n📍 *${tx.description}*\n💰 RD$ ${fmt(tx.amount)}\n${CAT_EMOJI[tx.category]||'📦'} ${tx.category}\n\n¿Lo agrego? Responde *sí* o *no*\n_Para otra cuenta: "sí banco" o "sí tarjeta"_`
    : `🧾 Found this in the photo:\n\n📍 *${tx.description}*\n💰 ${fmt(tx.amount)}\n${CAT_EMOJI[tx.category]||'📦'} ${tx.category}\n\nAdd it? Reply *yes* or *no*\n_For another account: "yes bank" or "yes card"_`,

  noPending    : (lang) => lang === 'es' ? 'No tienes nada pendiente por confirmar.' : 'No pending transaction.',
  cancelled    : (lang) => lang === 'es' ? 'Okay, cancelado. ¿Qué más?' : 'Cancelled. What else?',
  notUnderstood: (lang) => lang === 'es'
    ? `Hmm, no entendí bien eso 🤔\n\nPrueba diciéndome algo como:\n• _"gasté 350 en el colmado"_\n• _"me cayó la quincena 18000"_\n• _"cómo voy este mes"_\n\nO escribe *ayuda* para ver todo.`
    : `Hmm, I didn't catch that 🤔\n\nTry:\n• _"spent 50 on food"_\n• _"received salary 2000"_\n• _"how am I doing?"_\n\nType *help* for all commands.`,

  noGroq    : (lang) => lang === 'es' ? 'El análisis de fotos no está disponible ahora mismo.' : 'Photo analysis is not available right now.',
  analyzing : (lang) => lang === 'es' ? '🔍 Analizando la foto...'                              : '🔍 Analyzing image...',
  photoError: (lang) => lang === 'es' ? 'No pude leer bien esa foto. ¿Tienes una más clara?' : 'Could not read that photo clearly. Do you have a clearer one?',
  generalError: (lang) => lang === 'es' ? 'Algo falló por aquí, intenta de nuevo en un momento.' : 'Something went wrong, please try again.',

  help: (lang) => lang === 'es'
    ? `📖 *MisCuentas — Comandos*

━━━━━ 💰 FINANZAS PERSONALES ━━━━━

📊 *Consultas:*
• resumen — Balance del mes
• cuentas — Por cuenta (efectivo/banco/tarjeta)
• alertas — Alertas financieras
• historial — Últimos movimientos
• presupuesto — Ver límites de gastos

📝 *Registrar:*
• gasté 350 en comida
• pagué la luz 1200 con banco
• deposité el sueldo 28000

📷 *Facturas:*
• Envía foto de factura para registrar automáticamente

━━━━━ 📋 CONTABILIDAD ━━━━━

• /plan — Plan de cuentas con saldos
• /clientes — Clientes con deudas
• /ccobrar — Cuentas por cobrar
• /cpagar — Cuentas por pagar
• /agregarcliente — Nuevo cliente
• /agregarproveedor — Nuevo proveedor
• /nuevacobranza [clientId] [monto] [desc]
• /registrarpago [recId] [monto]
• /nuevacuenta [código] [nombre] [tipo]

━━━━━ 📊 REPORTES NEGOCIO ━━━━━

• /reportes diario — Ventas y gastos de hoy
• /reportes semanal — Resumen de la semana
• /reportes mensual — Resumen del mes
• /reportes balance — Balance general
• /monitoreo — Dashboard del negocio
• /alertas stock — Productos con stock bajo
• /alertas pagos — Cobros pendientes
• /productos — Ver inventario
• /entrada [producto] [cantidad] [precio]

━━━━━ 🔐 CUENTA WEB ━━━━━

• /login usuario contraseña — Conectar cuenta web
• /reset — Cancelar operación actual
• /miid — Ver tu Telegram ID`
    : `📖 *MisCuentas — Commands*\n\n• resumen/summary, cuentas, alertas, historial\n• "spent 50 on food" / "received salary 2000"\n• /plan, /clientes, /ccobrar, /cpagar\n• /reportes, /monitoreo, /productos\n• /login usuario contraseña — Conectar cuenta web\n• /reset — Cancelar operación\n• /miid`,
};

// ─── GROQ VISION ──────────────────────────────────────────────────────────────
async function analyzeReceipt(base64, mimeType) {
  if (!GROQ_API_KEY) return null;
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model   : 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{ role:'user', content:[
        { type:'text', text:'Analyze this receipt. Reply ONLY with valid JSON on one line, no markdown:\n{"success":true,"amount":NUMBER,"description":"STORE_NAME","category":"CATEGORY"}\nCATEGORY must be one of: comida,transporte,servicios,salud,entretenimiento,ropa,educacion,negocio,otro\nIf not a receipt reply: {"success":false}' },
        { type:'image_url', image_url:{ url:`data:${mimeType};base64,${base64}` } },
      ]}],
      temperature: 0,
      max_tokens : 150,
    }, { headers:{ Authorization:`Bearer ${GROQ_API_KEY}`, 'Content-Type':'application/json' }, timeout:30000 });
    const raw = r.data.choices?.[0]?.message?.content?.trim() || '';
    const m   = raw.match(/\{[^{}]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch(e) { console.error('analyzeReceipt:', e.message); return null; }
}

// ─── GEMINI AI PARSER ─────────────────────────────────────────────────────────
async function parseWithAI(message) {
  if (!GEMINI_API_KEY) return null;
  const prompt =
    'Eres el asistente financiero de MisCuentas, hablás dominicano. Parsea el mensaje y responde SOLO con JSON válido en una línea, sin markdown.' +
    '\n\nMensaje: ' + message +
    '\n\nFormato: {"type":"ingreso|egreso|comando","amount":number_or_null,"desc":"texto","cat":"categoria","account":"efectivo|banco|tarjeta","cmd":null,"budget_cat":null,"budget_amount":null}' +
    '\n\nCategorías: comida,transporte,servicios,salud,entretenimiento,ropa,educacion,salario,negocio,inversion,prestamo,ahorro,otro' +
    '\n\nReglas de cuenta:' +
    '\n- tarjeta/card/crédito/débito/visa/mastercard → account:tarjeta' +
    '\n- banco/transfer/deposito/cheque/BHD/BanReservas/Popular/Scotiabank → account:banco' +
    '\n- efectivo/cash/billetes/físico → account:efectivo (default)' +
    '\n\nReglas de tipo — INGRESOS (type:ingreso):' +
    '\n- recibí, cobré, me pagaron, me depositaron, me cayó, me entraron, vendí, gané, quincena, sueldo, salario, bono, comisión, venta, ingresé' +
    '\n- Ejemplos: "me depositaron la quincena 18000", "cobré un trabajo 5000", "vendí unas cosas 2500", "me cayeron 800 pesos"' +
    '\n\nReglas de tipo — GASTOS (type:egreso):' +
    '\n- gasté, pagué, compré, se me fue, di, metí, eché, saqué, debe, debo, costó, me costó' +
    '\n- Ejemplos: "eché gasolina 800", "metí 500 al colmado", "pagué la luz 1200", "di 200 de propina", "debo 1500 en la bodega"' +
    '\n- "debo en X" o "le debo a X" → type:egreso (deuda/gasto)' +
    '\n\nCategorías dominicanas:' +
    '\n- colmado/bodega/supermercado/mercado/La Sirena/Nacional → comida' +
    '\n- gasolina/combustible/motoconcho/guagua/Uber/OMSA → transporte' +
    '\n- luz/agua/internet/Claro/Altice/Viva/Netflix/cable → servicios' +
    '\n- médico/farmacia/clínica/salud/medicina/colesterol → salud' +
    '\n- quincena/sueldo/nómina/salario/bono → salario' +
    '\n- chicharrón/negocio/venta/cliente → negocio' +
    '\n\nComandos:' +
    '\n- resumen/balance/cómo voy/cuánto tengo/mis gastos/hoy → cmd:resumen' +
    '\n- cuentas/mis cuentas → cmd:ver_cuentas' +
    '\n- historial/últimos/movimientos → cmd:historial' +
    '\n- ayuda/help/qué puedes hacer → cmd:ayuda' +
    '\n- presupuesto/límite → cmd:presupuesto' +
    '\n- clientes → cmd:clientes' +
    '\n- ccobrar/cxc/cobrar → cmd:ccobrar' +
    '\n- cpagar/cxp/pagar → cmd:cpagar' +
    '\n- alertas → cmd:alertas' +
    '\n- plan/cuentas contables → cmd:plan' +
    '\n- agregarcliente → cmd:agregarcliente' +
    '\n- agregarproveedor → cmd:agregarproveedor' +
    '\n- presupuesto X 500 → cmd:set_budget,budget_cat:X,budget_amount:500' +
    '\n- sí/si/dale/correcto/exacto/ok/yes → cmd:confirmar' +
    '\n- no/cancela/para/cancel → cmd:cancelar';
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      { contents:[{ parts:[{ text:prompt }] }], generationConfig:{ temperature:0.1, maxOutputTokens:200 } },
      { timeout:15000 }
    );
    const text = r.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().replace(/```json|```/g,'').trim();
    if (!text) return null;
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch { return null; }
}

// ─── FALLBACK PARSER ──────────────────────────────────────────────────────────
const CAT_KW = {
  comida         :['comida','almuerzo','desayuno','cena','restaurant','mercado','colmado','pizza','pollo','supermercado','grocery','lunch','dinner','food','bodega','sirena','nacional','fritura','empanada','chimichurri'],
  transporte     :['transporte','gas','gasolina','combustible','taxi','uber','carro','bus','car','fuel','metro','transport','motoconcho','guagua','omsa','peaje'],
  servicios      :['luz','agua','internet','telefono','phone','netflix','spotify','cable','electric','water','service','claro','altice','viva','edesur','edenorte','edeeste'],
  salud          :['salud','medico','doctor','farmacia','pharmacy','medicina','hospital','dentista','health','clinica','pastilla','consulta'],
  entretenimiento:['entretenimiento','cine','movie','fiesta','party','bar','viaje','hotel','travel','entertainment','trago','disco'],
  ropa           :['ropa','zapatos','shoes','camisa','shirt','tienda','store','clothes','tenis','polo'],
  educacion      :['escuela','universidad','libro','book','curso','course','school','education','colegio','taller'],
  salario        :['sueldo','quincena','nomina','payroll','salary','bono','comision'],
  negocio        :['negocio','venta','sale','cliente','client','business','chicharron','producto'],
  ahorro         :['ahorro','fondo','savings'],
  prestamo       :['prestamo','deuda','loan','debt','prestado'],
};
const INC_VERBS = [
  'ingresé','ingrese','recibí','recibi','gané','gane','cobré','cobre',
  'deposité','deposite','quincena','sueldo','salario','recibido','vendí','vendi',
  'received','earned','deposited','salary','sold',
  'me depositaron','me pagaron','me cayeron','me entraron','me cayó','me cayeron',
  'cobré','me dieron','me mandaron','me transfirieron',
];
const EXP_VERBS = [
  'gasté','gaste','pagué','pague','compré','compre',
  'spent','paid','bought','compra','gasto','costo','pagar',
  'eché','eche','metí','meti','di ','saqué','saque','debo','debo en',
  'le debo','me costó','me costo','se me fue',
];

function detectCat(t) {
  for (const [c, kws] of Object.entries(CAT_KW)) if (kws.some(k => t.includes(k))) return c;
  return 'otro';
}
function detectAcc(t) {
  if (['tarjeta','card','credit','credito','debito','visa','mastercard'].some(k => t.includes(k))) return 'tarjeta';
  if (['banco','bank','transfer','transferencia','deposito','deposit','bhd','banreservas','popular','scotiabank','cheque'].some(k => t.includes(k))) return 'banco';
  return 'efectivo';
}

function fallbackParse(msg) {
  const t = msg.trim().toLowerCase().replace(/^\//, '');
  const CMDS = {
    resumen:'resumen', balance:'resumen', summary:'resumen', hoy:'resumen',
    'como voy':'resumen', 'cómo voy':'resumen', 'cuanto tengo':'resumen', 'cuánto tengo':'resumen',
    'mis gastos':'resumen', 'ver resumen':'resumen', 'ver balance':'resumen',
    alertas:'alertas', alerts:'alertas',
    ayuda:'ayuda', help:'ayuda', start:'ayuda', 'que puedes':'ayuda', 'qué puedes':'ayuda',
    'ver cuentas':'ver_cuentas', cuentas:'ver_cuentas', accounts:'ver_cuentas', 'mis cuentas':'ver_cuentas',
    presupuesto:'presupuesto', budget:'presupuesto', limite:'presupuesto', 'límite':'presupuesto',
    historial:'historial', history:'historial', ultimos:'historial', 'últimos':'historial', movimientos:'historial',
    miid:'miid',
    plan:'plan', ver_plan:'plan',
    clientes:'clientes',
    ccobrar:'ccobrar', cxc:'ccobrar',
    cpagar:'cpagar', cxp:'cpagar',
    agregarcliente:'agregarcliente', agregarproveedor:'agregarproveedor',
    setpassword:'setpassword', linkaccount:'linkaccount',
    nuevacobranza:'nuevacobranza', registrarpago:'registrarpago', nuevacuenta:'nuevacuenta',
    si:'confirmar', 'sí':'confirmar', yes:'confirmar', confirm:'confirmar',
    dale:'confirmar', correcto:'confirmar', exacto:'confirmar', ok:'confirmar', va:'confirmar',
    no:'cancelar', cancel:'cancelar', cancela:'cancelar', para:'cancelar', 'para eso':'cancelar',
  };
  if (CMDS[t]) return { type:'comando', cmd:CMDS[t] };
  // Match commands with args (e.g. "setpassword user pass")
  const cmdWord = t.split(/\s+/)[0];
  if (CMDS[cmdWord]) return { type:'comando', cmd:CMDS[cmdWord] };

  const bm = t.match(/(?:presupuesto|budget)\s+(\w+)\s+(\d+(?:[.,]\d+)?)/);
  if (bm) return { type:'comando', cmd:'set_budget', budget_cat:bm[1], budget_amount:parseFloat(bm[2].replace(',','.')) };

  const confirmAcc = t.match(/^(?:si|sí|yes|confirm)\s+(banco|bank|tarjeta|card|efectivo|cash)$/);
  if (confirmAcc) return { type:'comando', cmd:'confirmar', account:detectAcc(confirmAcc[1]) };

  const am = t.match(/(\d+(?:[.,]\d+)?)/);
  if (!am) return null;
  const amount = parseFloat(am[1].replace(',','.'));
  if (!amount || amount <= 0) return null;

  const hasInc = INC_VERBS.some(v => t.includes(v));
  const hasExp = EXP_VERBS.some(v => t.includes(v));
  let type;
  if (hasInc && !hasExp) type = 'ingreso';
  else if (hasExp) type = 'egreso';
  else {
    const np = t.match(/\d+(?:[.,]\d+)?\s+(?:en|de|para|for|on)\s+(.+)/i);
    if (np) return { type:'egreso', amount, desc:np[1].trim(), cat:detectCat(np[1]+' '+t), account:detectAcc(t) };
    return null;
  }

  let desc = t
    .replace(/\d+(?:[.,]\d+)?/g,'')
    .replace(/\b(el|la|los|las|un|una|de|del|con|al|en|por|para|a|mi|the|an|for|on|at|in|with|from)\b/gi,' ')
    .replace(/\s+/g,' ').trim();
  if (!desc || desc.length < 2) {
    if (t.includes('quincena')) desc = 'Quincena';
    else if (t.includes('sueldo') || t.includes('salary')) desc = 'Salary';
    else desc = type === 'ingreso' ? 'Income' : 'Expense';
  }
  desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  return { type, amount, desc, cat:detectCat(t), account:detectAcc(t) };
}

// ─── API HELPER (reportes/inventario via endpoints del servidor) ──────────────
async function apiCall(path, method = 'GET', data = null, sessionToken = null) {
  try {
    const res = await axios({
      url    : MISCUENTAS_API + path,
      method,
      data,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
      },
      timeout: 15000,
    });
    return res.data;
  } catch(e) {
    return e.response?.data || { error: e.message };
  }
}

async function getSessionToken(chatId) {
  const r = await query(
    `SELECT session_token FROM auth_tokens WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [String(chatId)]
  );
  return r.rows[0]?.session_token || null;
}

// ─── MESSAGE HANDLER (finanzas personales — directo a DB) ────────────────────
async function handleText(msgText, chatId) {
  const id  = String(chatId);
  const msg = msgText.trim();
  const now = new Date();

  let user = await getUser(id);
  if (!user) {
    const lang = detectLang(msg);
    await ensureUser(id, lang);
    user = { id, lang };
    await sendMessage(chatId, MSG.welcome(id, lang));
    // Segundo mensaje: guía de primer paso
    await new Promise(r => setTimeout(r, 1200));
    await sendMessage(chatId, lang === 'es'
      ? `Para empezar, dime cuál aplica:\n\n*1️⃣ Ya tengo cuenta en miscuentas.app*\nEscribe: \`/login tuusuario tucontraseña\`\n\n*2️⃣ Soy nuevo, quiero crear mi cuenta*\nEscribe: \`/login tuusuario tucontraseña\`\n_(yo creo la cuenta automáticamente)_\n\n*3️⃣ Solo quiero anotar gastos por aquí*\nDime algo como: _"gasté 200 en comida"_`
      : `To get started:\n\n*1️⃣ I already have an account*\nType: \`/login username password\`\n\n*2️⃣ I'm new here*\nType: \`/login username password\`\n_(I'll create your account automatically)_\n\n*3️⃣ Just track expenses here*\nTell me: _"spent 50 on food"_`
    );
    return;
  }
  const lang = user.lang || 'es';

  if (/^\/miid$|^miid$/i.test(msg)) {
    await sendMessage(chatId, MSG.miid(id, lang));
    return;
  }

  // ── /login siempre tiene prioridad, ignora estado pendiente ──
  if (/^\/login\s+\S+\s+\S/i.test(msg)) {
    const m = msg.match(/^\/login\s+(\S+)\s+(.+)$/i);
    if (!m) { await sendMessage(chatId, '❌ Uso: `/login usuario contraseña`'); return; }
    const username = m[1].toLowerCase();
    const password = m[2].trim();
    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      await sendMessage(chatId, '❌ Ese usuario no funciona — usa solo letras, números y guiones bajos (3-30 caracteres).'); return;
    }
    if (password.length < 6) { await sendMessage(chatId, '❌ La contraseña necesita al menos 6 caracteres.'); return; }
    const hash = crypto.pbkdf2Sync(password, username, 100000, 64, 'sha512').toString('hex');
    const existingCred = await query('SELECT user_id, password_hash FROM user_credentials WHERE username=$1', [username]);
    if (existingCred.rows[0]) {
      if (existingCred.rows[0].password_hash !== hash) {
        await sendMessage(chatId, '❌ Esa contraseña no es correcta. Intenta de nuevo.'); return;
      }
      const webUserId = existingCred.rows[0].user_id;
      if (webUserId !== id) {
        const tgTxs = await query('SELECT COUNT(*) FROM transactions WHERE user_id=$1', [id]);
        if (parseInt(tgTxs.rows[0].count) > 0) {
          await sendMessage(chatId, '⚠️ *Conflicto de cuentas*\n\nTienes datos en Telegram y en la web. Contacta al desarrollador.'); return;
        }
        // Eliminar cuentas/credenciales del TG user antes de migrar (evita duplicate key en accounts)
        await query(`DELETE FROM accounts WHERE user_id=$1`, [id]);
        await query(`DELETE FROM user_credentials WHERE user_id=$1`, [id]);
        for (const table of ['transactions','budgets','clients','receivables','vendors','payables']) {
          await query(`UPDATE ${table} SET user_id=$1 WHERE user_id=$2`, [webUserId, id]);
        }
        await query(`DELETE FROM users WHERE id=$1`, [id]);
      }
      await clearPending(id);
      await sendMessage(chatId, `¡Bienvenido de vuelta, *${username}*! 👋\n\nYa estás conectado. Puedes usar todos los comandos y la web.`);
      // Mostrar resumen del mes al vincularse
      const _now = new Date();
      const _txs = await query(
        `SELECT type, amount FROM transactions WHERE user_id=$1 AND EXTRACT(MONTH FROM tx_date)=$2 AND EXTRACT(YEAR FROM tx_date)=$3`,
        [webUserId, _now.getMonth()+1, _now.getFullYear()]
      );
      if (_txs.rows.length > 0) {
        const _inc = _txs.rows.filter(t=>t.type==='ingreso').reduce((s,t)=>s+parseFloat(t.amount),0);
        const _exp = _txs.rows.filter(t=>t.type==='egreso').reduce((s,t)=>s+parseFloat(t.amount),0);
        await new Promise(r => setTimeout(r, 800));
        await sendMessage(chatId, `📊 *Tu mes hasta ahora:*\n\n▲ Ingresos: RD$ ${fmt(_inc)}\n▼ Egresos: RD$ ${fmt(_exp)}\n\n${(_inc-_exp)>=0?'✅':'🚨'} Balance: RD$ ${fmt(_inc-_exp)}\n_${_txs.rows.length} movimiento(s)_`);
      }
    } else {
      const myCred = await query('SELECT username FROM user_credentials WHERE user_id=$1', [id]);
      if (myCred.rows[0]) {
        await sendMessage(chatId, `🔒 Ya estás registrado como\n\n👤 *${myCred.rows[0].username}*`); return;
      }
      try {
        await query(
          `INSERT INTO user_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
           ON CONFLICT(user_id) DO UPDATE SET username=$2, password_hash=$3`,
          [id, username, hash]
        );
        await clearPending(id);
        await sendMessage(chatId, `✅ *¡Listo! Cuenta creada*\n\n👤 Usuario: *${username}*\n\nYa puedes entrar a la web.`);
      } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
    }
    return;
  }

  const parsed = await parseWithAI(msg) || fallbackParse(msg);

  // ── Confirmar transacción pendiente ──
  if (parsed?.cmd === 'confirmar') {
    const pending = await getPending(id);
    if (!pending) { await sendMessage(chatId, MSG.noPending(lang)); return; }
    if (parsed.account && parsed.account !== 'efectivo') pending.account = parsed.account;
    const tx = { ...pending, userId:id };
    await insertTx(tx);
    await clearPending(id);
    await sendMessage(chatId, MSG.recorded(tx, lang));
    return;
  }

  // ── Cancelar transacción pendiente ──
  if (parsed?.cmd === 'cancelar') {
    const pending = await getPending(id);
    if (pending) { await clearPending(id); await sendMessage(chatId, MSG.cancelled(lang)); }
    else { await sendMessage(chatId, MSG.noPending(lang)); }
    return;
  }

  // ── Multi-step pending state ──
  const pending = await getPending(id);
  if (pending && pending.step) {
    if (pending.step === 'await_client_name') {
      const name = msg.trim();
      if (!name) { await sendMessage(chatId, '❌ Envía un nombre válido.'); return; }
      const clientId = `cli_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
      try {
        await query(`INSERT INTO clients(id,user_id,name) VALUES($1,$2,$3)`, [clientId, id, name]);
        await clearPending(id);
        await sendMessage(chatId, `👤 ¡Cliente agregado!\n\n*${name}*\nID: \`${clientId}\``);
      } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
      return;
    }
    if (pending.step === 'await_vendor_name') {
      const name = msg.trim();
      if (!name) { await sendMessage(chatId, '❌ Envía un nombre válido.'); return; }
      const vendorId = `ven_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
      try {
        await query(`INSERT INTO vendors(id,user_id,name) VALUES($1,$2,$3)`, [vendorId, id, name]);
        await clearPending(id);
        await sendMessage(chatId, `🏪 ¡Proveedor listo!\n\n*${name}*\nID: \`${vendorId}\``);
      } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
      return;
    }
    if (pending.step === 'await_setpassword_username') {
      const username = msg.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        await sendMessage(chatId, '❌ Ese usuario no funciona — usa solo letras, números y guiones bajos (3-30 caracteres).'); return;
      }
      const existing = await query('SELECT user_id FROM user_credentials WHERE username=$1', [username]);
      if (existing.rows[0] && existing.rows[0].user_id !== id) {
        await sendMessage(chatId, '❌ Ese usuario ya lo tiene alguien más, prueba con otro.'); return;
      }
      await setPending(id, { step:'await_setpassword_password', username, lang });
      await sendMessage(chatId, `✅ Usuario: *${username}*\n\nAhora envía tu contraseña (mínimo 6 caracteres):`);
      return;
    }
    if (pending.step === 'await_setpassword_password') {
      const password = msg.trim();
      if (password.length < 6) { await sendMessage(chatId, '❌ La contraseña necesita al menos 6 caracteres.'); return; }
      const username = pending.username;
      const hash = crypto.pbkdf2Sync(password, username.toLowerCase(), 100000, 64, 'sha512').toString('hex');
      try {
        await query(
          `INSERT INTO user_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
           ON CONFLICT(user_id) DO UPDATE SET username=$2, password_hash=$3`,
          [id, username, hash]
        );
        await clearPending(id);
        await sendMessage(chatId, `✅ *¡Cuenta vinculada!*\n\n👤 Usuario: *${username}*\n\nYa puedes entrar a la web.`);
      } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
      return;
    }
    if (pending.step === 'await_link_username') {
      const username = msg.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        await sendMessage(chatId, '❌ Ese usuario no es válido.'); return;
      }
      await setPending(id, { step:'await_link_password', username, lang });
      await sendMessage(chatId, `✅ Usuario: *${username}*\n\nAhora envía tu contraseña:`);
      return;
    }
    if (pending.step === 'await_link_password') {
      const password  = msg.trim();
      const username  = pending.username;
      const hash      = crypto.pbkdf2Sync(password, username.toLowerCase(), 100000, 64, 'sha512').toString('hex');
      const cred      = await query('SELECT user_id,password_hash FROM user_credentials WHERE username=$1', [username]);
      if (!cred.rows[0]) {
        await sendMessage(chatId, '❌ No encontré ese usuario. ¿Está bien escrito?');
        await setPending(id, { step:'await_link_username', lang }); return;
      }
      if (cred.rows[0].password_hash !== hash) {
        await sendMessage(chatId, '❌ Esa contraseña no es correcta. Intenta de nuevo.');
        await setPending(id, { step:'await_link_password', username, lang }); return;
      }
      const webUserId = cred.rows[0].user_id;
      const tgTxs    = await query('SELECT COUNT(*) FROM transactions WHERE user_id=$1', [id]);
      const tgHasData = parseInt(tgTxs.rows[0].count) > 0;
      if (webUserId !== id) {
        if (tgHasData) {
          await clearPending(id);
          await sendMessage(chatId, '⚠️ *Conflicto de cuentas*\n\nTienes datos tanto en Telegram como en la web. Contacta al desarrollador para unirlas.'); return;
        }
        await query(`DELETE FROM accounts WHERE user_id=$1`, [id]);
        await query(`DELETE FROM user_credentials WHERE user_id=$1`, [id]);
        for (const table of ['transactions','budgets','clients','receivables','vendors','payables']) {
          await query(`UPDATE ${table} SET user_id=$1 WHERE user_id=$2`, [webUserId, id]);
        }
        await query(`DELETE FROM users WHERE id=$1`, [id]);
      }
      await clearPending(id);
      await sendMessage(chatId, `✅ *¡Cuentas unidas!*\n\nYa puedes entrar a la web con:\n👤 *${username}*`);
      return;
    }
    await clearPending(id);
  }

  if (!parsed) { await sendMessage(chatId, MSG.notUnderstood(lang)); return; }

  const { cmd } = parsed;
  const month = now.getMonth();
  const year  = now.getFullYear();
  const MN    = lang === 'es' ? MONTHS_ES : MONTHS_EN;

  if (cmd === 'miid')  { await sendMessage(chatId, MSG.miid(id, lang)); return; }
  if (cmd === 'ayuda') { await sendMessage(chatId, MSG.help(lang)); return; }

  if (cmd === 'resumen') {
    const txs = await getMonthTxs(id, month, year);
    const inc = txs.filter(t=>t.type==='ingreso').reduce((s,t)=>s+parseFloat(t.amount),0);
    const exp = txs.filter(t=>t.type==='egreso').reduce((s,t) =>s+parseFloat(t.amount),0);
    const bal = inc - exp;
    await sendMessage(chatId, lang==='es'
      ? `💰 *Resumen — ${MN[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n_${txs.length} movimiento(s)_`
      : `💰 *Summary — ${MN[month]} ${year}*\n\n▲ Income: *${fmt(inc)}*\n▼ Expenses: *${fmt(exp)}*\n\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n_${txs.length} transaction(s)_`);
    return;
  }

  if (cmd === 'ver_cuentas') {
    const txs  = await getMonthTxs(id, month, year);
    const lines = ['efectivo','banco','tarjeta'].map(acc => {
      const inc = txs.filter(t=>t.type==='ingreso'&&t.account===acc).reduce((s,t)=>s+parseFloat(t.amount),0);
      const exp = txs.filter(t=>t.type==='egreso' &&t.account===acc).reduce((s,t)=>s+parseFloat(t.amount),0);
      return `${ACC_EMOJI[acc]} *${acc}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc-exp)}`;
    });
    await sendMessage(chatId, `🏦 *Cuentas — ${MN[month]}*\n\n${lines.join('\n\n')}`); return;
  }

  if (cmd === 'alertas') {
    const txs     = await getMonthTxs(id, month, year);
    const budgets = await getBudgets(id);
    const inc  = txs.filter(t=>t.type==='ingreso').reduce((s,t)=>s+parseFloat(t.amount),0);
    const exp  = txs.filter(t=>t.type==='egreso').reduce((s,t) =>s+parseFloat(t.amount),0);
    const list = [];
    if (inc > 0) {
      const pct = (exp/inc)*100;
      if      (pct >= 100) list.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
      else if (pct >= 80)  list.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
      else                 list.push(`✅ Finanzas saludables (${pct.toFixed(0)}% gastado)`);
    }
    for (const [cat, limit] of Object.entries(budgets)) {
      const spent = txs.filter(t=>t.type==='egreso'&&t.category===cat).reduce((s,t)=>s+parseFloat(t.amount),0);
      const pct   = (spent/limit)*100;
      const e     = CAT_EMOJI[cat]||'📦';
      if      (pct >= 100) list.push(`🚨 ${e} ${cat}: SUPERADO (${fmt(spent)})`);
      else if (pct >= 80)  list.push(`⚠️ ${e} ${cat}: ${pct.toFixed(0)}% usado`);
    }
    await sendMessage(chatId, `🔔 *Alertas — ${MN[month]}*\n\n${list.join('\n')||'Sin alertas ✅'}`); return;
  }

  if (cmd === 'historial') {
    const txs  = await getMonthTxs(id, month, year);
    const last5 = [...txs].reverse().slice(0,5);
    if (!last5.length) { await sendMessage(chatId, `📭 Sin movimientos en ${MN[month]}`); return; }
    const lines = last5.map(t=>`${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJI[t.category]||'📦'} ${t.description} — ${fmt(t.amount)}`);
    await sendMessage(chatId, `📋 *Recientes — ${MN[month]}*\n\n${lines.join('\n')}`); return;
  }

  if (cmd === 'presupuesto') {
    const budgets = await getBudgets(id);
    const txs     = await getMonthTxs(id, month, year);
    if (!Object.keys(budgets).length) {
      await sendMessage(chatId, `📊 *Sin presupuestos.*\n\nCrea uno:\n• presupuesto comida 5000`); return;
    }
    const lines = Object.entries(budgets).map(([cat, limit]) => {
      const spent = txs.filter(t=>t.type==='egreso'&&t.category===cat).reduce((s,t)=>s+parseFloat(t.amount),0);
      const pct   = Math.min(100,(spent/limit)*100);
      const bar   = '█'.repeat(Math.floor(pct/10))+'░'.repeat(10-Math.floor(pct/10));
      return `${CAT_EMOJI[cat]||'📦'} ${cat}\n   ${bar} ${pct.toFixed(0)}%\n   ${fmt(spent)} / ${fmt(limit)}`;
    });
    await sendMessage(chatId, `📊 *Presupuestos — ${MN[month]}*\n\n${lines.join('\n\n')}`); return;
  }

  if (cmd === 'set_budget') {
    if (!parsed.budget_cat || !parsed.budget_amount || parsed.budget_amount <= 0) {
      await sendMessage(chatId, `💡 Uso: "presupuesto [categoría] [monto]"\n\nEjemplo: presupuesto comida 5000`); return;
    }
    await setBudget(id, parsed.budget_cat, parsed.budget_amount);
    await sendMessage(chatId, `🎯 ¡Presupuesto fijado!\n\n${CAT_EMOJI[parsed.budget_cat]||'📦'} *${parsed.budget_cat}*: ${fmt(parsed.budget_amount)}/mes`); return;
  }

  if (cmd === 'plan' || cmd === 'ver_plan') {
    const r = await query(
      `SELECT a.code,a.name,a.type,COALESCE(ab.balance,0) as balance
       FROM accounts a LEFT JOIN account_balances ab ON ab.account_id=a.id
       WHERE a.user_id=$1 AND a.is_active=TRUE ORDER BY a.class,a.code`, [id]
    );
    if (!r.rows.length) { await sendMessage(chatId, '📋 No hay cuentas registradas.'); return; }
    const typeLabel = { asset:'🏦',liability:'📜',equity:'🏛️',income:'💵',cost:'📉',expense:'📤' };
    const lines = r.rows.map(row=>`${typeLabel[row.type]||'📦'} \`${row.code}\` ${row.name}\n   Balance: ${fmt(row.balance)}`);
    const chunks = [];
    for (let i=0; i<lines.length; i+=20) chunks.push(lines.slice(i,i+20).join('\n'));
    for (const chunk of chunks) await sendMessage(chatId, `📋 *Plan de Cuentas*\n\n${chunk}`);
    return;
  }

  if (cmd === 'clientes') {
    const r = await query(
      `SELECT c.id,c.name,c.phone,COALESCE(SUM(rec.total_amount-rec.paid_amount),0) as outstanding
       FROM clients c LEFT JOIN receivables rec ON rec.client_id=c.id AND rec.status IN ('pending','partial')
       WHERE c.user_id=$1 GROUP BY c.id HAVING COALESCE(SUM(rec.total_amount-rec.paid_amount),0)>0
       ORDER BY outstanding DESC`, [id]
    );
    if (!r.rows.length) { await sendMessage(chatId, '📋 No hay clientes con deudas pendientes.'); return; }
    const lines = r.rows.map(row=>`👤 *${row.name}*\n   ID: \`${row.id}\`\n   Debe: *${fmt(row.outstanding)}*\n   📞 ${row.phone||'N/A'}`);
    await sendMessage(chatId, `👥 *Clientes — CxC*\n\n${lines.join('\n\n')}`); return;
  }

  if (cmd === 'ccobrar' || cmd === 'cxc') {
    const r = await query(
      `SELECT c.name,rec.description,rec.total_amount-rec.paid_amount as outstanding
       FROM receivables rec JOIN clients c ON c.id=rec.client_id
       WHERE rec.user_id=$1 AND rec.status IN ('pending','partial') ORDER BY rec.due_date NULLS LAST`, [id]
    );
    if (!r.rows.length) { await sendMessage(chatId, '✅ No hay cuentas por cobrar.'); return; }
    const total = r.rows.reduce((s,row)=>s+parseFloat(row.outstanding),0);
    const lines = r.rows.slice(0,10).map(row=>`👤 ${row.name}\n   ${row.description}\n   💰 ${fmt(row.outstanding)} pendiente`);
    await sendMessage(chatId, `📋 *Cuentas por Cobrar*\n\n${lines.join('\n\n')}\n\n💰 *Total: ${fmt(total)}*`); return;
  }

  if (cmd === 'cpagar' || cmd === 'cxp') {
    const r = await query(
      `SELECT v.name,p.description,p.total_amount-p.paid_amount as outstanding
       FROM payables p JOIN vendors v ON v.id=p.vendor_id
       WHERE p.user_id=$1 AND p.status IN ('pending','partial') ORDER BY p.due_date NULLS LAST`, [id]
    );
    if (!r.rows.length) { await sendMessage(chatId, '✅ No hay cuentas por pagar.'); return; }
    const total = r.rows.reduce((s,row)=>s+parseFloat(row.outstanding),0);
    const lines = r.rows.slice(0,10).map(row=>`🏪 ${row.name}\n   ${row.description}\n   💰 ${fmt(row.outstanding)} pendiente`);
    await sendMessage(chatId, `📋 *Cuentas por Pagar*\n\n${lines.join('\n\n')}\n\n💰 *Total: ${fmt(total)}*`); return;
  }

  if (cmd === 'agregarcliente') {
    await setPending(id, { step:'await_client_name', lang });
    await sendMessage(chatId, `👤 *Agregar Cliente*\n\nEnvía el nombre del cliente:`); return;
  }
  if (cmd === 'agregarproveedor') {
    await setPending(id, { step:'await_vendor_name', lang });
    await sendMessage(chatId, `🏪 *Agregar Proveedor*\n\nEnvía el nombre del proveedor:`); return;
  }

  // ── /login usuario contraseña — crea o vincula según exista el usuario ──
  if (/^\/login\s+\S+\s+\S/i.test(msg)) {
    const m = msg.match(/^\/login\s+(\S+)\s+(.+)$/i);
    if (!m) { await sendMessage(chatId, '❌ Uso: `/login usuario contraseña`'); return; }
    const username = m[1].toLowerCase();
    const password = m[2].trim();
    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      await sendMessage(chatId, '❌ Ese usuario no funciona — usa solo letras, números y guiones bajos (3-30 caracteres).'); return;
    }
    if (password.length < 6) { await sendMessage(chatId, '❌ La contraseña necesita al menos 6 caracteres.'); return; }
    const hash = crypto.pbkdf2Sync(password, username, 100000, 64, 'sha512').toString('hex');
    const existingCred = await query('SELECT user_id, password_hash FROM user_credentials WHERE username=$1', [username]);
    if (existingCred.rows[0]) {
      // Username existe → intentar vincular
      if (existingCred.rows[0].password_hash !== hash) {
        await sendMessage(chatId, '❌ Esa contraseña no es correcta. Intenta de nuevo.'); return;
      }
      const webUserId = existingCred.rows[0].user_id;
      if (webUserId !== id) {
        const tgTxs = await query('SELECT COUNT(*) FROM transactions WHERE user_id=$1', [id]);
        if (parseInt(tgTxs.rows[0].count) > 0) {
          await sendMessage(chatId, '⚠️ *Conflicto de cuentas*\n\nTienes datos en Telegram y en la web. Contacta al desarrollador.'); return;
        }
        await query(`DELETE FROM accounts WHERE user_id=$1`, [id]);
        await query(`DELETE FROM user_credentials WHERE user_id=$1`, [id]);
        for (const table of ['transactions','budgets','clients','receivables','vendors','payables']) {
          await query(`UPDATE ${table} SET user_id=$1 WHERE user_id=$2`, [webUserId, id]);
        }
        await query(`DELETE FROM users WHERE id=$1`, [id]);
      }
      await clearPending(id);
      await sendMessage(chatId, `✅ *¡Bienvenido de vuelta!*\n\n👤 *${username}*\n\nYa puedes usar la web.`);
    } else {
      // Username nuevo → crear credenciales
      const myCred = await query('SELECT username FROM user_credentials WHERE user_id=$1', [id]);
      if (myCred.rows[0]) {
        await sendMessage(chatId, `🔒 Ya estás registrado como\n\n👤 *${myCred.rows[0].username}*`); return;
      }
      try {
        await query(
          `INSERT INTO user_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
           ON CONFLICT(user_id) DO UPDATE SET username=$2, password_hash=$3`,
          [id, username, hash]
        );
        await clearPending(id);
        await sendMessage(chatId, `✅ *¡Listo! Cuenta creada*\n\n👤 Usuario: *${username}*\n\nYa puedes entrar a la web.`);
      } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
    }
    return;
  }

  if (cmd === 'setpassword') {
    const existingCred = await query('SELECT username FROM user_credentials WHERE user_id=$1', [id]);
    if (existingCred.rows[0]) {
      await sendMessage(chatId, `🔒 Ya estás registrado como\n\n👤 *${existingCred.rows[0].username}*`); return;
    }
    // Support inline: /setpassword usuario contraseña
    const inlineMatch = msg.match(/^\/setpassword\s+(\S+)\s+(.+)$/i);
    if (inlineMatch) {
      const username = inlineMatch[1].toLowerCase();
      const password = inlineMatch[2].trim();
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        await sendMessage(chatId, '❌ Ese usuario no funciona — usa solo letras, números y guiones bajos (3-30 caracteres).'); return;
      }
      if (password.length < 6) { await sendMessage(chatId, '❌ La contraseña necesita al menos 6 caracteres.'); return; }
      const existing = await query('SELECT user_id FROM user_credentials WHERE username=$1', [username]);
      if (existing.rows[0] && existing.rows[0].user_id !== id) {
        await sendMessage(chatId, '❌ Ese usuario ya lo tiene alguien más, prueba con otro.'); return;
      }
      const hash = crypto.pbkdf2Sync(password, username, 100000, 64, 'sha512').toString('hex');
      try {
        await query(
          `INSERT INTO user_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
           ON CONFLICT(user_id) DO UPDATE SET username=$2, password_hash=$3`,
          [id, username, hash]
        );
        await clearPending(id);
        await sendMessage(chatId, `✅ *¡Listo! Cuenta creada*\n\n👤 Usuario: *${username}*\n\nYa puedes entrar a la web.`);
      } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
      return;
    }
    await setPending(id, { step:'await_setpassword_username', lang });
    await sendMessage(chatId, `🔐 *Crear contraseña para la web*\n\nPuedes enviarlo todo junto:\n\`/setpassword usuario contraseña\`\n\nO solo envía tu usuario ahora:`); return;
  }

  if (cmd === 'linkaccount') {
    const existingCred = await query('SELECT username FROM user_credentials WHERE user_id=$1', [id]);
    if (existingCred.rows[0]) {
      await sendMessage(chatId, `🔒 Ya tienes una cuenta vinculada:\n\n👤 *${existingCred.rows[0].username}*`); return;
    }
    // Support inline: /linkaccount usuario contraseña
    const inlineMatch = msg.match(/^\/linkaccount\s+(\S+)\s+(.+)$/i);
    if (inlineMatch) {
      const username = inlineMatch[1].toLowerCase();
      const password = inlineMatch[2].trim();
      if (!/^[a-z0-9_]{3,30}$/.test(username)) {
        await sendMessage(chatId, '❌ Ese usuario no es válido.'); return;
      }
      const hash = crypto.pbkdf2Sync(password, username.toLowerCase(), 100000, 64, 'sha512').toString('hex');
      const cred = await query('SELECT user_id,password_hash FROM user_credentials WHERE username=$1', [username]);
      if (!cred.rows[0]) { await sendMessage(chatId, '❌ No encontré ese usuario. ¿Está bien escrito?'); return; }
      if (cred.rows[0].password_hash !== hash) { await sendMessage(chatId, '❌ Esa contraseña no es correcta. Intenta de nuevo.'); return; }
      const webUserId = cred.rows[0].user_id;
      const tgTxs = await query('SELECT COUNT(*) FROM transactions WHERE user_id=$1', [id]);
      const tgHasData = parseInt(tgTxs.rows[0].count) > 0;
      if (webUserId !== id) {
        if (tgHasData) {
          await sendMessage(chatId, '⚠️ *Conflicto de cuentas*\n\nTienes datos tanto en Telegram como en la web. Contacta al desarrollador para unirlas.'); return;
        }
        await query(`DELETE FROM accounts WHERE user_id=$1`, [id]);
        await query(`DELETE FROM user_credentials WHERE user_id=$1`, [id]);
        for (const table of ['transactions','budgets','clients','receivables','vendors','payables']) {
          await query(`UPDATE ${table} SET user_id=$1 WHERE user_id=$2`, [webUserId, id]);
        }
        await query(`DELETE FROM users WHERE id=$1`, [id]);
      }
      await clearPending(id);
      await sendMessage(chatId, `✅ *¡Cuentas unidas!*\n\nYa puedes entrar a la web con:\n👤 *${username}*`);
      return;
    }
    await setPending(id, { step:'await_link_username', lang });
    await sendMessage(chatId, `🔗 *Vincular cuenta web*\n\nPuedes enviarlo todo junto:\n\`/linkaccount usuario contraseña\`\n\nO solo envía tu usuario ahora:`); return;
  }

  if (cmd === 'nuevacobranza') {
    const r = await query(`SELECT name FROM clients WHERE id=$1 AND user_id=$2`, [parsed?.client_id, id]);
    if (!r.rows[0]) { await sendMessage(chatId, '❌ Cliente no encontrado.'); return; }
    const amt = parsed?.amount;
    if (!amt || amt <= 0) { await sendMessage(chatId, '❌ Monto inválido.'); return; }
    const recId = `rec_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
    try {
      await query(`INSERT INTO receivables(id,user_id,client_id,description,total_amount) VALUES($1,$2,$3,$4,$5)`,
        [recId, id, parsed.client_id, parsed.description||'Cobranza', amt]);
      await sendMessage(chatId, `✅ *CxC creada*\n\n👤 ${r.rows[0].name}\n💰 ${fmt(amt)}\nID: \`${recId}\``);
    } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
    return;
  }

  if (cmd === 'registrarpago') {
    if (!parsed?.receivable_id || !parsed?.amount) {
      await sendMessage(chatId, '❌ Uso: /registrarpago [id_cobranza] [monto]'); return;
    }
    const rec = await query(
      `SELECT r.*,c.name as client_name FROM receivables r JOIN clients c ON c.id=r.client_id
       WHERE r.id=$1 AND r.user_id=$2`, [parsed.receivable_id, id]
    );
    if (!rec.rows[0]) { await sendMessage(chatId, '❌ Cobranza no encontrada.'); return; }
    try {
      await query(`INSERT INTO receivable_payments(id,receivable_id,amount) VALUES($1,$2,$3)`,
        [`rpay_${Date.now()}`, parsed.receivable_id, parsed.amount]);
      await query(
        `UPDATE receivables SET paid_amount=paid_amount+$1,
         status=CASE WHEN paid_amount+$1>=total_amount THEN 'paid' WHEN paid_amount+$1>0 THEN 'partial' ELSE status END
         WHERE id=$2`,
        [parsed.amount, parsed.receivable_id]
      );
      const remaining = parseFloat(rec.rows[0].total_amount) - parseFloat(rec.rows[0].paid_amount) - parsed.amount;
      await sendMessage(chatId, `✅ *Pago registrado*\n\n👤 ${rec.rows[0].client_name}\n💰 ${fmt(parsed.amount)}\nQuedan: ${fmt(Math.max(0,remaining))}`);
    } catch(e) { await sendMessage(chatId, MSG.generalError(lang)); }
    return;
  }

  if (cmd === 'nuevacuenta') {
    if (!parsed?.code || !parsed?.name) {
      await sendMessage(chatId, '❌ Uso: /nuevacuenta [código] [nombre] [tipo]\nTipos: asset, liability, equity, income, cost, expense'); return;
    }
    const accClass = parseInt(parsed.code.charAt(0));
    if (!accClass || accClass < 1 || accClass > 6) {
      await sendMessage(chatId, '❌ Código debe empezar con clase 1-6.'); return;
    }
    const accId = `acc_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
    try {
      await query(`INSERT INTO accounts(id,user_id,code,name,type,class) VALUES($1,$2,$3,$4,$5,$6)`,
        [accId, id, parsed.code, parsed.name, parsed.type||'asset', accClass]);
      await query(`INSERT INTO account_balances(account_id,balance) VALUES($1,0) ON CONFLICT DO NOTHING`, [accId]);
      await sendMessage(chatId, `✅ *Cuenta creada*\n\n\`${parsed.code}\` ${parsed.name}\nTipo: ${parsed.type||'asset'}`);
    } catch(e) {
      await sendMessage(chatId, e.message.includes('unique')
        ? '❌ Ya existe una cuenta con ese código.'
        : MSG.generalError(lang));
    }
    return;
  }

  if (parsed.type === 'ingreso' || parsed.type === 'egreso') {
    const tx = {
      id         : uid(),
      userId     : id,
      type       : parsed.type,
      amount     : parsed.amount,
      description: parsed.desc || (parsed.type==='ingreso' ? 'Income' : 'Expense'),
      category   : parsed.cat  || 'otro',
      account    : parsed.account || 'efectivo',
      date       : now.toISOString().split('T')[0],
    };
    await insertTx(tx);
    const detectedLang = detectLang(msg);
    if (detectedLang !== lang) await setUserLang(id, detectedLang);
    await sendMessage(chatId, MSG.recorded(tx, lang));
    return;
  }

  await sendMessage(chatId, MSG.notUnderstood(lang));
}

// ─── PHOTO HANDLER ────────────────────────────────────────────────────────────
async function handlePhoto(msg, chatId) {
  const id   = String(chatId);
  const user = await getUser(id);
  const lang = user?.lang || 'es';

  if (!GROQ_API_KEY) { await sendMessage(chatId, MSG.noGroq(lang)); return; }

  try {
    const photo = msg.photo?.[msg.photo.length - 1];
    if (!photo) { await sendMessage(chatId, MSG.photoError(lang)); return; }

    await sendMessage(chatId, MSG.analyzing(lang));

    const link = await getFileLink(photo.file_id);
    const res  = await axios.get(link, { responseType:'arraybuffer', timeout:15000 });
    const b64  = Buffer.from(res.data).toString('base64');
    const mime = link.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const result = await analyzeReceipt(b64, mime);
    if (!result?.success) { await sendMessage(chatId, MSG.photoError(lang)); return; }

    const now = new Date();
    const tx  = {
      id         : uid(),
      type       : 'egreso',
      amount     : result.amount,
      description: result.description || 'Receipt',
      category   : result.category    || 'otro',
      account    : 'efectivo',
      date       : now.toISOString().split('T')[0],
    };
    await ensureUser(id, lang);
    await setPending(id, tx);
    await sendMessage(chatId, MSG.receiptPreview(tx, lang));
  } catch(e) {
    console.error('handlePhoto:', e.message);
    await sendMessage(chatId, MSG.photoError(lang));
  }
}

// ─── BUSINESS COMMANDS ────────────────────────────────────────────────────────
async function cmdReportes(chatId, args) {
  const token = await getSessionToken(chatId);
  if (!token) {
    await sendMessage(chatId, '🔐 Necesitas vincular tu cuenta web primero.\nUsa /login usuario contraseña'); return;
  }
  const type = (args || '').toLowerCase();
  await sendMessage(chatId, '📊 Cargando reporte...');

  let endpoint = '/api/reports/balance';
  if      (type.includes('diario') || type.includes('hoy'))    endpoint = '/api/reports/daily';
  else if (type.includes('semanal') || type.includes('semana')) endpoint = '/api/reports/weekly';
  else if (type.includes('mensual') || type.includes('mes'))    endpoint = '/api/reports/monthly';

  const r = await apiCall(endpoint, 'GET', null, token);
  if (r.error || r.message) { await sendMessage(chatId, `❌ ${r.error || r.message}`); return; }

  if (endpoint === '/api/reports/balance') {
    await sendMessage(chatId,
      `📊 *Balance General*\n\n` +
      `💵 Efectivo: ${fmtRD(r.cash||0)}\n📋 Por Cobrar: ${fmtRD(r.accountsReceivable||0)}\n📦 Inventario: ${fmtRD(r.inventory||0)}\n\n` +
      `📑 Por Pagar: ${fmtRD(r.accountsPayable||0)}\n\n` +
      `Ingresos: ${fmtRD(r.totalIncome||0)}\nGastos: ${fmtRD(r.totalExpenses||0)}\nGanancia Neta: *${fmtRD(r.netIncome||0)}*`);
  } else {
    const label = endpoint.includes('daily') ? 'Diario' : endpoint.includes('weekly') ? 'Semanal' : 'Mensual';
    await sendMessage(chatId,
      `📅 *Reporte ${label}*\n\n` +
      `💰 Ingresos: ${fmtRD(r.totalIncome||0)}\n💸 Gastos: ${fmtRD(r.totalExpenses||0)}\n📈 Ganancia: *${fmtRD(r.netIncome||0)}*\n\n` +
      `Ventas: ${r.salesCount||0} | Gastos: ${r.expensesCount||0}`);
  }
}

async function cmdMonitoreo(chatId) {
  const token = await getSessionToken(chatId);
  if (!token) {
    await sendMessage(chatId, '🔐 Necesitas conectar tu cuenta web. Usa '); return;
  }
  await sendMessage(chatId, '👁️ Cargando estado del negocio...');

  const [balance, cxc, cxp, products] = await Promise.all([
    apiCall('/api/reports/balance',     'GET', null, token).catch(()=>({})),
    apiCall('/api/accounts-receivable', 'GET', null, token).catch(()=>[]),
    apiCall('/api/accounts-payable',    'GET', null, token).catch(()=>[]),
    apiCall('/api/products',            'GET', null, token).catch(()=>[]),
  ]);

  const lowStock   = Array.isArray(products) ? products.filter(p=>(p.stock||0)<=(p.minStock||5)) : [];
  const cxcPending = Array.isArray(cxc)      ? cxc.filter(c=>c.status!=='paid') : [];
  const cxpPending = Array.isArray(cxp)      ? cxp.filter(c=>c.status!=='paid') : [];
  const cxcTotal   = cxcPending.reduce((s,c)=>s+(c.amount||0),0);
  const cxpTotal   = cxpPending.reduce((s,c)=>s+(c.amount||0),0);

  let msg = `📊 *Estado del Negocio*\n\n`;
  msg += `💰 *Dinero*\nEfectivo: ${fmtRD(balance.cash||0)}\nGanancia total: ${fmtRD(balance.netIncome||0)}\n\n`;
  msg += `📋 *Cuentas*\nPor cobrar: ${fmtRD(cxcTotal)} (${cxcPending.length} pendientes)\nPor pagar: ${fmtRD(cxpTotal)} (${cxpPending.length} pendientes)\n\n`;
  msg += `📦 *Inventario*\nProductos: ${Array.isArray(products)?products.length:0}\n`;
  msg += lowStock.length > 0 ? `⚠️ Stock bajo: ${lowStock.length} productos` : `✅ Inventario OK`;
  await sendMessage(chatId, msg);
}

async function cmdProductos(chatId) {
  const token = await getSessionToken(chatId);
  if (!token) { await sendMessage(chatId, '🔐 Necesitas conectar tu cuenta web. Usa '); return; }
  const products = await apiCall('/api/products', 'GET', null, token);
  if (!Array.isArray(products)) { await sendMessage(chatId, `❌ ${products.error||'Error obteniendo productos'}`); return; }
  if (!products.length) { await sendMessage(chatId, '📦 No hay productos registrados.'); return; }
  let msg = '📦 *Tus Productos*\n\n';
  products.forEach(p => {
    const low = (p.stock||0)<=(p.minStock||5) ? ' ⚠️' : '';
    msg += `• ${p.name} — Stock: ${p.stock}${low} — ${fmtRD(p.price)}\n`;
  });
  await sendMessage(chatId, msg);
}

async function cmdEntrada(chatId, args) {
  const token = await getSessionToken(chatId);
  if (!token) { await sendMessage(chatId, '🔐 Necesitas conectar tu cuenta web. Usa '); return; }
  if (!args?.trim()) {
    await sendMessage(chatId, `📦 *Registrar Entrada*\n\nUso: /entrada [producto] [cantidad] [precio]\n\nEjemplo: /entrada chicharron 50 2500`); return;
  }
  const parts = args.match(/(\d+(?:\.\d+)?)/g);
  if (!parts) { await sendMessage(chatId, '❌ Incluye al menos la cantidad.\nEjemplo: /entrada chicharron 50'); return; }
  const qty         = parseInt(parts[0]);
  const price       = parts[1] ? parseFloat(parts[1]) : 0;
  const productName = args.replace(/\d+(?:\.\d+)?/g,'').trim();

  const products = await apiCall('/api/products', 'GET', null, token);
  if (!Array.isArray(products)) { await sendMessage(chatId, '❌ No pude obtener los productos.'); return; }

  const product = products.find(p=>p.name.toLowerCase().includes(productName.toLowerCase()));
  if (!product) {
    await sendMessage(chatId, `❌ No encontré "${productName}".\nUsa /productos para ver los nombres exactos.`); return;
  }

  const newStock = (product.stock||0) + qty;
  const upd = await apiCall(`/api/products/${product.id}`, 'PUT', { ...product, stock:newStock }, token);
  if (upd.error) { await sendMessage(chatId, '❌ No pude actualizar el stock.'); return; }

  await sendMessage(chatId,
    `✅ *Entrada registrada*\n\n📦 ${product.name}\n+${qty} unidades\nStock nuevo: ${newStock}${price?`\n💰 Costo: ${fmtRD(price)}`:''}`);
}

async function cmdAlertasStock(chatId) {
  const token = await getSessionToken(chatId);
  if (!token) { await sendMessage(chatId, '🔐 Necesitas conectar tu cuenta web. Usa '); return; }
  const products = await apiCall('/api/products', 'GET', null, token);
  if (!Array.isArray(products)) { await sendMessage(chatId, '❌ No pude obtener los productos.'); return; }
  const lowStock = products.filter(p=>(p.stock||0)<=(p.minStock||5));
  if (!lowStock.length) { await sendMessage(chatId, '✅ ¡Todo bien! No hay productos con stock bajo.'); return; }
  let msg = '🔴 *Productos con stock bajo:*\n\n';
  lowStock.forEach(p=>{ msg += `• ${p.name}: ${p.stock} unidades (mín: ${p.minStock||5})\n`; });
  await sendMessage(chatId, msg);
}


// ─── OAUTH HANDLER ────────────────────────────────────────────────────────────
async function handleOAuthStart(chatId, authToken) {
  try {
    await ensureUser(String(chatId), 'es');
    await createAuthToken(authToken, String(chatId));
    const lang = await getUserLang(String(chatId));
    await sendMessage(chatId, lang==='es'
      ? '✅ ¡Cuenta conectada! Puedes volver a la web. Bienvenido a MisCuentas 💰'
      : '✅ Account connected! Go back to the web. Welcome to MisCuentas 💰');
  } catch(e) { console.error('OAuth error:', e.message); }
}

// ─── BOT MESSAGE HANDLER ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text || '';

  try {
    // OAuth deep link
    if (text.startsWith('/start tg_')) {
      await handleOAuthStart(chatId, text.replace('/start tg_','').trim()); return;
    }
    if (text.startsWith('/start miscuentas?start=')) {
      await handleOAuthStart(chatId, text.replace('/start miscuentas?start=','').trim()); return;
    }
    if (/^\/tg_[a-z0-9]+$/i.test(text)) {
      await handleOAuthStart(chatId, text.replace('/tg_','').trim()); return;
    }
    if (/^\/start miscuentas$/.test(text)) {
      await sendMessage(chatId, '👋 Usa el botón "Iniciar con Telegram" en la web para conectar tu cuenta.'); return;
    }
    if (/^\/start$/.test(text)) {
      await ensureUser(String(chatId), 'es');
      const lang = await getUserLang(String(chatId));
      await sendMessage(chatId, MSG.welcome(String(chatId), lang)); return;
    }

    // Comandos de negocio
    if (/^\/reportes/i.test(text))      { await cmdReportes(chatId, text.replace(/^\/reportes\s*/i,'')); return; }
    if (/^\/balance$/i.test(text))       { await cmdReportes(chatId, 'balance'); return; }
    if (/^\/monitoreo$/i.test(text))     { await cmdMonitoreo(chatId); return; }
    if (/^\/productos$/i.test(text))     { await cmdProductos(chatId); return; }
    if (/^\/entrada/i.test(text))        { await cmdEntrada(chatId, text.replace(/^\/entrada\s*/i,'')); return; }
    if (/^\/alertas\s+stock$/i.test(text)) { await cmdAlertasStock(chatId); return; }

    // Comandos contabilidad (via handleText)
    if (/^\/plan$/i.test(text))             { await handleText('plan', chatId); return; }
    if (/^\/clientes$/i.test(text))         { await handleText('clientes', chatId); return; }
    if (/^\/ccobrar$/i.test(text))          { await handleText('ccobrar', chatId); return; }
    if (/^\/cpagar$/i.test(text))           { await handleText('cpagar', chatId); return; }
    if (/^\/agregarcliente$/i.test(text))   { await handleText('agregarcliente', chatId); return; }
    if (/^\/agregarproveedor$/i.test(text)) { await handleText('agregarproveedor', chatId); return; }
    if (/^\/miid$/i.test(text))             { await handleText('miid', chatId); return; }
    if (/^\/ayuda$/i.test(text))            { await handleText('ayuda', chatId); return; }
    if (/^\/setpassword/i.test(text))        { await handleText(text, chatId); return; }
    if (/^\/linkaccount/i.test(text))       { await handleText(text, chatId); return; }
    if (/^\/login/i.test(text))             { await handleText(text, chatId); return; }
    if (/^\/reset$/i.test(text)) {
      await clearPending(String(chatId));
      await sendMessage(chatId, '🔄 Operación cancelada. Puedes empezar de nuevo.\n\nUsa `/login usuario contraseña` para conectar tu cuenta.');
      return;
    }
    if (/^\/nuevacobranza/i.test(text))     { await handleText(text, chatId); return; }
    if (/^\/registrarpago/i.test(text))     { await handleText(text, chatId); return; }
    if (/^\/nuevacuenta/i.test(text))       { await handleText(text, chatId); return; }

    // Fotos (facturas)
    if (msg.photo?.length > 0) { await handlePhoto(msg, chatId); return; }

    // Texto libre (NLP)
    if (text) { await handleText(text, chatId); }

  } catch(e) {
    console.error('Bot error:', e.message);
    try { await sendMessage(chatId, '❌ Ocurrió un error. Intenta de nuevo.'); } catch {}
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));

// ─── START ────────────────────────────────────────────────────────────────────
console.log('✅ MisCuentas Bot iniciado (polling)');
console.log(`   API:         ${MISCUENTAS_API}`);
console.log(`   DB:          ${DATABASE_URL ? '✓ conectada' : '✗ no configurada'}`);
console.log(`   Groq Vision: ${GROQ_API_KEY ? '✓' : '✗'}`);
console.log(`   Gemini NLP:  ${GEMINI_API_KEY ? '✓' : '✗'}`);

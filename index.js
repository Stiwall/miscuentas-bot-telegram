const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MISCUENTAS_API = process.env.MISCUENTAS_API || 'https://miscuentas-contable-app-production.up.railway.app';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_VL_URL = 'https://api.minimax.io/anthropic/v1/chat/completions';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Global token map - survives process restarts within same instance
const globalTokens = new Map();  // chatId -> jwt token (persistent across calls)

// Session storage - in-memory only (Railway configured with 1 replica to avoid state loss)
const userSessions = {};  // chatId -> { token, userId, state, context, plan }
const userTokens = {};    // chatId -> { jwt, plan } (backup reference)

async function loadSessions() {
  console.log('Bot sessions managed in-memory (1 replica configured in Railway)');
}

async function saveSession(chatId, jwt, plan) {
  // In-memory only - no API persistence needed with 1 replica
}

async function loadSession(chatId) {
  // In-memory only
  if (userTokens[chatId]) return userTokens[chatId];
  return null;
}

async function deleteSession(chatId) {
  delete userSessions[chatId];
  delete userTokens[chatId];
}

function getSession(chatId) {
  if (!userSessions[chatId]) userSessions[chatId] = { token: null, userId: null, state: null, context: {}, plan: null };
  return userSessions[chatId];
}

function resetSession(chatId) {
  const s = getSession(chatId);
  s.state = null; s.context = {};
}

async function persistState(chatId) {
  // In-memory only - no-op with 1 replica
}

function canUse(chatId, feature) {
  const s = getSession(chatId);
  const plan = (s.plan?.plan || '').toLowerCase();
  const planName = s.plan?.plan_name || '';
  if (plan === 'admin' || planName === 'Admin' || plan === 'max' || planName === 'Max') return true;
  if (plan === 'pro') {
    const proBlocked = ['multi_user', 'support_priority', 'backup_premium', 'training'];
    return !proBlocked.includes(feature);
  }
  if (plan === 'free' || plan === 'trial' || !plan) {
    const freeAllowed = ['balance', 'reporte_diario', 'start', 'login', 'logout', 'help'];
    return freeAllowed.includes(feature);
  }
  return true;
}

function planMsg(chatId) {
  const p = getSession(chatId).plan;
  const plan = p?.plan_name || p?.plan || 'trial';
  return '❌ *Acceso denegado*\n\nPlan: ' + plan + '\n\n👉 miscuentas-contable.app/upgrade';
}

async function api(endpoint, method, data, chatId) {
  const s = getSession(chatId);
  const headers = {};
  if (s.token) headers['x-session-token'] = s.token;
  try {
    const r = await axios({ method: method || 'GET', url: MISCUENTAS_API + endpoint, data, headers, timeout: 15000 });
    return r.data;
  } catch (e) { return { error: e.response?.data?.error || e.message }; }
}

async function apiWithToken(token, endpoint, method, data) {
  const headers = {};
  if (token) headers['x-session-token'] = token;
  try {
    const r = await axios({ method: method || 'GET', url: MISCUENTAS_API + endpoint, data, headers, timeout: 15000 });
    return r.data;
  } catch (e) { return { error: e.response?.data?.error || e.message }; }
}

function fmt(amount) {
  return 'RD$ ' + parseFloat(amount || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 });
}

async function groqChat(prompt) {
  if (!GROQ_API_KEY) return null;
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 400 },
      { headers: { Authorization: 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' } });
    const text = r.data.choices[0]?.message?.content?.trim();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

async function analyzeReceiptPhoto(filePath) {
  if (!MINIMAX_API_KEY) return null;
  try {
    const imageBase64 = fs.readFileSync(filePath, { encoding: 'base64' });
    const r = await axios.post(MINIMAX_VL_URL, {
      model: 'MiniMax-VL-01',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageBase64 } },
        { type: 'text', text: "Analiza esta imagen de recibo. Extrae JSON: {\"type\":\"venta|gasto|desconocido\",\"monto\":numero,\"proveedor\":\"nombre\",\"descripcion\":\"texto\",\"productos\":[\"lista\"]}. Si no es recibo, type:\"desconocido\". Solo JSON." }
      ]}],
      max_tokens: 300
    }, { headers: { Authorization: 'Bearer ' + MINIMAX_API_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
    const text = r.data.choices?.[0]?.message?.content?.trim();
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) { console.error('Vision:', e.message); return null; }
}

let morningInterval = null, weeklyInterval = null, lastWeeklyDate = null;

function startMorningAlerts() {
  if (morningInterval) return;
  morningInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 12 && now.getUTCMinutes() === 0) {
      Object.entries(userTokens).forEach(([chatId, sess]) => sendMorningAlert(parseInt(chatId), sess?.jwt).catch(console.error));
    }
  }, 60000);
}

async function sendMorningAlert(chatId, token) {
  const [recs, prods] = await Promise.all([apiWithToken(token, '/api/receivables'), apiWithToken(token, '/api/products')]);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  let msg = '🔔 *Buenos dias!*\n\n';
  if (Array.isArray(recs)) { const u = recs.filter(r => r.status !== 'paid' && (r.due_date || today) <= in7); if (u.length) { msg += '⚠️ *CxC proximas:*\n'; u.slice(0, 5).forEach(r => { msg += '• ' + (r.client_name || 'Cliente') + ': ' + fmt((r.total_amount - r.paid_amount) || r.total_amount) + '\n'; }); msg += '\n'; } }
  if (Array.isArray(prods)) { const low = prods.filter(p => { const c = parseFloat(p.stock_current) || 0, m = parseFloat(p.stock_minimum) || 0; return m > 0 && c <= m; }); if (low.length) { msg += '📦 *Stock bajo:*\n'; low.slice(0, 5).forEach(p => { msg += '• ' + p.name + ': ' + p.stock_current + ' / ' + p.stock_minimum + '\n'; }); } }
  if (msg === '🔔 *Buenos dias!*\n\n') msg += '✅ Sin alertas.';
  try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch (e) { console.error(e.message); }
}

function startWeeklyReminder() {
  if (weeklyInterval) return;
  weeklyInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCDay() === 1 && now.getUTCHours() === 12 && now.getUTCMinutes() === 0) {
      const today = now.toISOString().split('T')[0];
      if (lastWeeklyDate !== today) { lastWeeklyDate = today; Object.entries(userTokens).forEach(([chatId, sess]) => sendWeeklyReminder(parseInt(chatId), sess?.jwt).catch(console.error)); }
    }
  }, 60000);
}

async function sendWeeklyReminder(chatId, token) {
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const [invs, recs, payables] = await Promise.all([apiWithToken(token, '/api/invoices'), apiWithToken(token, '/api/receivables'), apiWithToken(token, '/api/payables')]);
  const wInvs = Array.isArray(invs) ? invs.filter(i => i.date >= weekAgo && i.date <= today) : [];
  const pCXC = Array.isArray(recs) ? recs.filter(r => r.status !== 'paid') : [];
  const pCXP = Array.isArray(payables) ? payables.filter(p => p.status !== 'paid') : [];
  const msg = '📊 *RESUMEN SEMANAL*\n\n🧾 Facturas: ' + wInvs.length + '\n💰 Ventas: ' + fmt(wInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0)) + '\n\n📋 Pendientes:\n🟢 CxC: ' + fmt(pCXC.reduce((s, r) => s + parseFloat((r.total_amount - r.paid_amount) || 0), 0)) + ' (' + pCXC.length + ')\n🔴 CxP: ' + fmt(pCXP.reduce((s, p) => s + parseFloat((p.total_amount - p.paid_amount) || 0), 0)) + ' (' + pCXP.length + ')';
  try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch (e) { console.error(e.message); }
}

startMorningAlerts();
startWeeklyReminder();

const K_PAYMENT = {}; // REMOVED KEYBOARD
const K_YES_NO = {}; // REMOVED KEYBOARD
const K_CONFIRM = {}; // REMOVED KEYBOARD
const K_HIDE = {}; // REMOVED KEYBOARD
const K_CANCEL = {}; // REMOVED KEYBOARD
const K_REPORT = {}; // REMOVED KEYBOARD
const K_PHOTO = { reply_markup: JSON.stringify({ keyboard: [['✅ Sí, registrar'], ['❌ No, cancelar']], one_time_keyboard: true, resize_keyboard: true }) };

function receiptText(invoice, items, clientName) {
  const total = items.reduce((s, i) => s + parseFloat(i.total || 0), 0);
  let t = '\n╔══════════════════════════════╗\n║         FACTURA              ║\n╠══════════════════════════════╣\n';
  t += '║ No: ' + (invoice.invoice_number || invoice.id || '').padEnd(22) + '║\n';
  t += '║ Fecha: ' + (invoice.date || '').padEnd(21) + '║\n╠══════════════════════════════╣\n';
  t += '║ Cliente: ' + (clientName || '').padEnd(20) + '║\n╠══════════════════════════════╣\n';
  items.forEach(i => { t += '║ ' + (i.description || '').substring(0, 22).padEnd(22) + '║\n'; t += '║   x' + i.qty + ' ──────────────── ' + fmt(i.total || 0).padEnd(10) + '║\n'; });
  t += '╠══════════════════════════════╣\n║ TOTAL: ' + fmt(total).padEnd(22) + '║\n╚══════════════════════════════╝\n';
  return t;
}

function getPaymentLabel(m) { return { cash: '💵 Efectivo', credit: '💳 Crédito', card: '💳 Tarjeta', bank: '🏦 Transferencia' }[m] || m; }

async function sendSaleSummary(chatId, ctx) {
  const items = ctx.items || [];
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  let msg = '📄 *FACTURA*\n\n👤 ' + ctx.client + '\n\n';
  items.forEach(i => { msg += '📦 ' + i.description + ' x' + i.qty + ' — ' + fmt(i.total) + '\n'; });
  msg += '\n─────────────\n💰 *Total: ' + fmt(subtotal) + '*\n💳 ' + getPaymentLabel(ctx.paymentMethod) + '\n\n¿Todo bien con esto?_';
  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown',  });
}

async function processSaleFull(chatId, ctx) {
  let clientId = null;
  const clients = await api('/api/clients', 'GET', null, chatId);
  const existing = Array.isArray(clients) ? clients.find(c => c.name === ctx.client) : null;
  if (existing) clientId = existing.id;
  else { const nc = await api('/api/clients', 'POST', { name: ctx.client }, chatId); clientId = nc.id; }
  const items = ctx.items || [];
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const inv = await api('/api/invoices', 'POST', {
    client_id: clientId, client_name: ctx.client,
    items: items.map(i => ({ product_id: i.product_id || null, description: i.description, qty: i.qty, price: i.price, total: i.total })),
    subtotal, tax: 0, total: subtotal,
    date: new Date().toISOString().split('T')[0], payment_method: ctx.paymentMethod, status: 'issued'
  }, chatId);
  if (inv.error) return { success: false, error: inv.error };
  return { success: true, invoice: inv, message: '✅ *FACTURA*\n\n📄 ' + (inv.invoice_number || inv.id) + '\n👤 ' + ctx.client + '\n💰 ' + fmt(subtotal) + '\n💳 ' + getPaymentLabel(ctx.paymentMethod) };
}

async function processExpenseFull(chatId, ctx) {
  let vendorId = null;
  if (ctx.vendor !== 'N/A') {
    const vs = await api('/api/vendors', 'GET', null, chatId);
    const ex = Array.isArray(vs) ? vs.find(v => v.name === ctx.vendor) : null;
    if (ex) vendorId = ex.id;
    else { const nv = await api('/api/vendors', 'POST', { name: ctx.vendor }, chatId); vendorId = nv.id; }
  }
  const payable = await api('/api/payables', 'POST', {
    vendor_id: vendorId, vendor_name: ctx.vendor === 'N/A' ? 'Varios' : ctx.vendor,
    description: ctx.description, total: ctx.amount, balance: ctx.amount,
    date: new Date().toISOString().split('T')[0], payment_method: ctx.paymentMethod, status: 'approved'
  }, chatId);
  if (payable.error) return { success: false, error: payable.error };
  const acctMap = { cash: '1101', bank: '1102', credit: '2101', card: '1105' };
  const creditAcct = acctMap[ctx.paymentMethod] || '1101';
  const accts = await api('/api/accounts', 'GET', null, chatId);
  let expAcct = '6101';
  if (Array.isArray(accts)) { const f = accts.find(a => a.code?.startsWith('6')); if (f) expAcct = f.code; }
  await api('/api/journal', 'POST', {
    date: new Date().toISOString().split('T')[0], description: 'Gasto: ' + ctx.description,
    entries: [{ account_code: expAcct, debit: ctx.amount, credit: 0, memo: ctx.description }, { account_code: creditAcct, debit: 0, credit: ctx.amount, memo: ctx.vendor }],
    reference: payable.id
  }, chatId);
  return { success: true, message: '✅ *GASTO*\n\n📝 ' + ctx.description + '\n🏪 ' + (ctx.vendor === 'N/A' ? 'Varios' : ctx.vendor) + '\n💰 ' + fmt(ctx.amount) + '\n💳 ' + getPaymentLabel(ctx.paymentMethod) };
}

async function sendReport(chatId, kind) {
  const today = new Date().toISOString().split('T')[0];
  let dateFrom = today;
  if (kind === 'weekly') { const d = new Date(); d.setDate(d.getDate() - 7); dateFrom = d.toISOString().split('T')[0]; }
  else if (kind === 'monthly') { const d = new Date(); d.setMonth(d.getMonth() - 1); dateFrom = d.toISOString().split('T')[0]; }

  if (kind === 'cierre') {
    const [inc, , cxc, cxp, prods] = await Promise.all([
      api('/api/income-statement', 'GET', null, chatId), api('/api/balance', 'GET', null, chatId),
      api('/api/receivables', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId),
      api('/api/products', 'GET', null, chatId)
    ]);
    const totalCXC = Array.isArray(cxc) ? cxc.reduce((s, r) => s + parseFloat((r.total_amount - r.paid_amount) || 0), 0) : 0;
    const totalCXP = Array.isArray(cxp) ? cxp.reduce((s, p) => s + parseFloat((p.total_amount - p.paid_amount) || 0), 0) : 0;
    const invVal = Array.isArray(prods) ? prods.reduce((s, p) => s + parseFloat(p.stock_current || 0) * parseFloat(p.cost_price || 0), 0) : 0;
    const pendingCXC = Array.isArray(cxc) ? cxc.filter(r => r.status !== 'paid') : [];
    const pendingCXP = Array.isArray(cxp) ? cxp.filter(p => p.status !== 'paid') : [];
    const lowStock = Array.isArray(prods) ? prods.filter(p => { const c = parseFloat(p.stock_current) || 0, m = parseFloat(p.stock_minimum) || 0; return m > 0 && c <= m; }) : [];
    await bot.sendMessage(chatId,
      '🔒 *CIERRE DE MES*\n\n' +
      '📊 *Estado de Resultados*\n' +
      'Ingresos: ' + fmt(inc?.total_revenue || 0) + '\n' +
      'Gastos: ' + fmt(inc?.total_expenses || 0) + '\n' +
      '*Utilidad: ' + fmt(inc?.net_income || 0) + '*\n\n' +
      '📋 *CxC*\nTotal: ' + fmt(totalCXC) + '\nPendiente: ' + fmt(pendingCXC.reduce((s, r) => s + parseFloat((r.total_amount - r.paid_amount) || 0), 0)) + ' (' + pendingCXC.length + ')\n\n' +
      '📋 *CxP*\nTotal: ' + fmt(totalCXP) + '\nPendiente: ' + fmt(pendingCXP.reduce((s, p) => s + parseFloat((p.total_amount - p.paid_amount) || 0), 0)) + ' (' + pendingCXP.length + ')\n\n' +
      '📦 *Inventario*\nValor: ' + fmt(invVal) + '\n⚠️ Stock critico: ' + lowStock.length,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (kind === 'daily') {
    const [invs, payables, cxc, cxp] = await Promise.all([
      api('/api/invoices', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId),
      api('/api/receivables', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId)
    ]);
    const filtered = Array.isArray(invs) ? invs.filter(i => i.date === today) : [];
    const filteredPay = Array.isArray(payables) ? payables.filter(p => p.date === today) : [];
    const pendingCXC = Array.isArray(cxc) ? cxc.filter(r => r.status !== 'paid') : [];
    const pendingCXP = Array.isArray(cxp) ? cxp.filter(p => p.status !== 'paid') : [];
    const totalSales = filtered.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const totalExp = filteredPay.reduce((s, p) => s + parseFloat(p.total || 0), 0);
    await bot.sendMessage(chatId,
      '📅 *REPORTE DIARIO* (' + today + ')\n\n' +
      '🧾 Facturas: ' + filtered.length + ' — ' + fmt(totalSales) + '\n' +
      '💸 Gastos: ' + filteredPay.length + ' — ' + fmt(totalExp) + '\n' +
      '*Balance: ' + fmt(totalSales - totalExp) + '*\n\n' +
      '📋 *Pendientes*\n🟢 CxC: ' + fmt(pendingCXC.reduce((s, r) => s + parseFloat((r.total_amount - r.paid_amount) || 0), 0)) + '\n🔴 CxP: ' + fmt(pendingCXP.reduce((s, p) => s + parseFloat((p.total_amount - p.paid_amount) || 0), 0)),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (kind === 'weekly') {
    const [invs, payables, cxc, cxp, products] = await Promise.all([
      api('/api/invoices', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId),
      api('/api/receivables', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId),
      api('/api/products', 'GET', null, chatId)
    ]);
    const filtered = Array.isArray(invs) ? invs.filter(i => i.date >= dateFrom && i.date <= today) : [];
    const filteredPay = Array.isArray(payables) ? payables.filter(p => p.date >= dateFrom && p.date <= today) : [];
    const totalSales = filtered.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const totalExp = filteredPay.reduce((s, p) => s + parseFloat(p.total || 0), 0);
    const clientSales = {};
    filtered.forEach(i => { const c = i.client_name || 'Sin nombre'; clientSales[c] = (clientSales[c] || 0) + parseFloat(i.total || 0); });
    const topClients = Object.entries(clientSales).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const lowStock = Array.isArray(products) ? products.filter(p => { const c = parseFloat(p.stock_current) || 0, m = parseFloat(p.stock_minimum) || 0; return m > 0 && c <= m; }) : [];
    let msg = '📆 *REPORTE SEMANAL*\n' + dateFrom + ' → ' + today + '\n\n' +
      '🧾 Facturas: ' + filtered.length + ' — ' + fmt(totalSales) + '\n' +
      '💸 Gastos: ' + filteredPay.length + ' — ' + fmt(totalExp) + '\n' +
      '*Balance: ' + fmt(totalSales - totalExp) + '*\n\n' +
      '🏆 *Top Clientes*\n';
    topClients.forEach(([c, v]) => { msg += '• ' + c + ': ' + fmt(v) + '\n'; });
    msg += '\n📦 Stock bajo: ' + lowStock.length;
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    return;
  }

  if (kind === 'monthly') {
    const [invs, payables, cxc, cxp, products] = await Promise.all([
      api('/api/invoices', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId),
      api('/api/receivables', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId),
      api('/api/products', 'GET', null, chatId)
    ]);
    const filtered = Array.isArray(invs) ? invs.filter(i => i.date >= dateFrom && i.date <= today) : [];
    const filteredPay = Array.isArray(payables) ? payables.filter(p => p.date >= dateFrom && p.date <= today) : [];
    const pendingCXC = Array.isArray(cxc) ? cxc.filter(r => r.status !== 'paid') : [];
    const pendingCXP = Array.isArray(cxp) ? cxp.filter(p => p.status !== 'paid') : [];
    const lowStock = Array.isArray(products) ? products.filter(p => { const c = parseFloat(p.stock_current) || 0, m = parseFloat(p.stock_minimum) || 0; return m > 0 && c <= m; }) : [];
    const invVal = Array.isArray(products) ? products.reduce((s, p) => s + parseFloat(p.stock_current || 0) * parseFloat(p.cost_price || 0), 0) : 0;
    const totalSales = filtered.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const totalExp = filteredPay.reduce((s, p) => s + parseFloat(p.total || 0), 0);
    await bot.sendMessage(chatId,
      '🗓️ *REPORTE MENSUAL*\n' + dateFrom + ' → ' + today + '\n\n' +
      '📊 *Resumen*\n' +
      '🧾 Facturas: ' + filtered.length + ' — ' + fmt(totalSales) + '\n' +
      '💸 Gastos: ' + filteredPay.length + ' — ' + fmt(totalExp) + '\n' +
      '*Utilidad: ' + fmt(totalSales - totalExp) + '*\n\n' +
      '📋 *Cuentas*\n' +
      '🟢 CxC pendiente: ' + fmt(pendingCXC.reduce((s, r) => s + parseFloat((r.total_amount - r.paid_amount) || 0), 0)) + ' (' + pendingCXC.length + ')\n' +
      '🔴 CxP pendiente: ' + fmt(pendingCXP.reduce((s, p) => s + parseFloat((p.total_amount - p.paid_amount) || 0), 0)) + ' (' + pendingCXP.length + ')\n\n' +
      '📦 *Inventario*\n' +
      'Valor: ' + fmt(invVal) + '\n' +
      '⚠️ Stock critico: ' + lowStock.length,
      { parse_mode: 'Markdown' }
    );
  }
}

// ==================== PHOTO HANDLER ====================
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  if (!canUse(chatId, 'photo_receipt')) { await bot.sendMessage(chatId, planMsg(chatId)); return; }
  await bot.sendMessage(chatId, '📸 *Analizando...*', { parse_mode: 'Markdown' });
  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const filePath = '/tmp/receipt_' + chatId + '_' + Date.now() + '.jpg';
    const downloadUrl = 'https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + file.file_path;
    const imgResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(filePath, Buffer.from(imgResponse.data));
    const analysis = await analyzeReceiptPhoto(filePath);
    fs.unlinkSync(filePath);
    if (!analysis || analysis.type === 'desconocido') {
      await bot.sendMessage(chatId, '⚠️ *No lei un recibo en esta imagen.*', { parse_mode: 'Markdown' });
      return;
    }
    s.context.receiptAnalysis = analysis;
    s.state = 'receipt_confirm';
    const typeLabel = analysis.type === 'venta' ? '🧾 Venta' : '💸 Gasto';
    await bot.sendMessage(chatId,
      '📸 *Recibo detectado*\n\n' +
      typeLabel + '\n' +
      '💰 Monto: ' + fmt(analysis.monto) + '\n' +
      (analysis.proveedor ? '🏪 ' + analysis.proveedor + '\n' : '') +
      (analysis.descripcion ? '📝 ' + analysis.descripcion + '\n' : '') +
      (analysis.productos?.length ? '📦 ' + analysis.productos.join(', ') + '\n' : '') +
      '\n_¿Registro esto?_',
      { parse_mode: 'Markdown',  }
    );
  } catch (e) {
    console.error('Photo error:', e.message);
    await bot.sendMessage(chatId, '❌ Error al procesar la imagen.');
  }
});

// ==================== STATE MACHINE ====================

// Interpret user text responses in flow states using Groq
async function interpretFlowResponse(text, state, context) {
  const lower = text.toLowerCase().trim();
  const yesPhrases = ['si', 'sí', 'yes', 'yeah', 'dale', 'ok', 'perfecto', 'continuar', 'continua', 'siguiente', 'confirmar', 'si claro'];
  const noPhrases = ['no', 'nah', 'nop', 'listo', 'terminar', 'fin', 'ya', 'cancelar', 'parar'];
  const cancelPhrases = ['cancelar', 'parar', 'stop', 'abort'];
  
  // Cancel always works
  if (cancelPhrases.some(p => lower.includes(p))) return { action: 'cancel' };
  
  // Payment method
  if (state === 'sale_payment' || state === 'expense_payment' || state === 'receipt_payment') {
    if (lower.includes('efectivo') || lower.includes('cash')) return { action: 'method', method: 'cash' };
    if (lower.includes('crédit') || lower.includes('credito') || lower === 'crédito') return { action: 'method', method: 'credit' };
    if (lower.includes('tarjeta') || lower.includes('débito') || lower.includes('debito')) return { action: 'method', method: 'card' };
    if (lower.includes('transferencia') || lower.includes('banco') || lower.includes('bancario')) return { action: 'method', method: 'bank' };
    if (lower.includes('cancelar')) return { action: 'cancel' };
    return { action: 'retry' };
  }
  
  // Yes/No
  if (state === 'sale_add_more' || state === 'receipt_confirm' || state === 'cobrar_confirm') {
    if (yesPhrases.some(p => lower === p || lower.includes(p))) return { action: 'yes' };
    if (noPhrases.some(p => lower === p || lower.includes(p))) return { action: 'no' };
    return { action: 'retry' };
  }
  
  // Sale confirm
  if (state === 'sale_confirm') {
    if (yesPhrases.some(p => lower === p || lower.includes(p))) return { action: 'yes' };
    if (noPhrases.some(p => lower === p || lower.includes(p))) return { action: 'no' };
    return { action: 'retry' };
  }
  
  // Quantity
  if (state === 'sale_qty') {
    const num = parseInt(text.replace(/[^\d]/g, ''));
    if (num && num > 0) return { action: 'qty', qty: num };
    return { action: 'retry' };
  }
  
  // Amount
  if (state === 'expense_amount' || state === 'cobrar_amount') {
    const num = parseFloat(text.replace(/[^\d.]/g, ''));
    if (num && num > 0) return { action: 'amount', amount: num };
    return { action: 'retry' };
  }
  
  // Client/Description/Vendor - just pass through
  if (state === 'sale_client' || state === 'receipt_client' || state === 'cobrar_client' || state === 'expense_desc' || state === 'expense_vendor') {
    return { action: 'text', value: text.trim() };
  }
  
  // Product selection
  if (state === 'sale_product') {
    const num = parseInt(text);
    if (num > 0 && context.products?.[num - 1]) return { action: 'select', product: context.products[num - 1] };
    const found = context.products?.find(p => p.name.toLowerCase().includes(lower));
    if (found) return { action: 'select', product: found };
    return { action: 'new', name: text.trim() };
  }
  
  // Report type
  if (state === 'report_type') {
    if (lower.includes('diario') || lower.includes('hoy')) return { action: 'report', type: 'daily' };
    if (lower.includes('semanal')) return { action: 'report', type: 'weekly' };
    if (lower.includes('mensual') || lower.includes('mes')) return { action: 'report', type: 'monthly' };
    if (lower.includes('cierre')) return { action: 'report', type: 'cierre' };
    return { action: 'retry' };
  }
  
  return { action: 'text', value: text };
}

async function handleStateMessage(chatId, text) {
  const s = getSession(chatId);
  // Recover token from userTokens if missing from userSessions
  if (!s.token && userTokens[chatId]) s.token = userTokens[chatId].jwt;
  // Ensure token exists before processing state
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); resetSession(chatId); return true; }
  // Interpret user response using Groq/natural language
  const flowResult = await interpretFlowResponse(text, s.state, s.context);
  if (flowResult.action === 'cancel') { resetSession(chatId); await bot.sendMessage(chatId, '❌ Cancelado.'); return true; }
  switch (s.state) {

    case 'receipt_confirm': {
      if (flowResult.action === 'yes') {
        const a = s.context.receiptAnalysis;
        if (a.type === 'gasto') {
          s.state = 'expense_desc';
          s.context.amount = a.monto;
          s.context.description = a.descripcion || a.proveedor || 'Gasto';
          await bot.sendMessage(chatId, '💸 *Registrar gasto*\n\n💰 ' + fmt(a.monto) + '\n📝 ' + s.context.description + '\n\n🏪 *Proveedor?* (o "N/A")', { parse_mode: 'Markdown',  });
        } else {
          s.state = 'receipt_client';
          s.context.receiptData = a;
          await persistState(chatId);
          await bot.sendMessage(chatId, '🧾 *Registrar venta*\n\n💰 ' + fmt(a.monto) + '\n' + (a.productos ? '📦 ' + a.productos.join(', ') + '\n' : '') + '\n👤 *Cliente?*', { parse_mode: 'Markdown',  });
        }
        return true;
      }
      resetSession(chatId); return true;
    }

    case 'receipt_client': {
      s.context.client = text.trim();
      s.state = 'receipt_payment';
      await persistState(chatId);
      await bot.sendMessage(chatId, '💳 *Metodo de pago?*', { parse_mode: 'Markdown',  });
      return true;
    }

    case 'receipt_payment': {
      if (flowResult.action !== 'method') { await bot.sendMessage(chatId, '⚠️ Escribe: efectivo, crédito, tarjeta o transferencia', { parse_mode: 'Markdown' }); return true; }
      s.context.paymentMethod = flowResult.method;
      s.state = 'receipt_confirm_sale';
      await persistState(chatId);
      await bot.sendMessage(chatId,
        '📄 *Resumen*\n\n👤 ' + s.context.client + '\n💰 ' + fmt(s.context.receiptData?.monto) + '\n💳 ' + text + '\n\n¿Todo bien con esto?_',
        { parse_mode: 'Markdown',  }
      );
      return true;
    }

    case 'receipt_confirm_sale': {
      if (flowResult.action === 'yes') {
        await bot.sendMessage(chatId, '⏳...');
        const clients = await api('/api/clients', 'GET', null, chatId);
        let clientId = null;
        const existing = Array.isArray(clients) ? clients.find(c => c.name === s.context.client) : null;
        if (existing) clientId = existing.id;
        else { const nc = await api('/api/clients', 'POST', { name: s.context.client }, chatId); clientId = nc.id; }
        const amount = s.context.receiptData?.monto || s.context.amount;
        const desc = s.context.receiptData?.productos?.join(', ') || s.context.receiptData?.descripcion || 'Venta';
        const inv = await api('/api/invoices', 'POST', {
          client_id: clientId, client_name: s.context.client,
          items: [{ description: desc, qty: 1, price: amount, total: amount }],
          subtotal: amount, tax: 0, total: amount,
          date: new Date().toISOString().split('T')[0], payment_method: s.context.paymentMethod, status: 'issued'
        }, chatId);
        if (inv.error) { await bot.sendMessage(chatId, '❌ ' + inv.error); resetSession(chatId); return true; }
        await bot.sendMessage(chatId, '✅ *VENTA REGISTRADA*\n\n📄 ' + (inv.invoice_number || inv.id) + '\n👤 ' + s.context.client + '\n💰 ' + fmt(amount) + '\n💳 ' + getPaymentLabel(s.context.paymentMethod), { parse_mode: 'Markdown',  });
        resetSession(chatId); return true;
      }
      await bot.sendMessage(chatId, '❌ Cancelada.'); resetSession(chatId); return true;
    }

    case 'sale_client': {
      s.context.client = text.trim();
      s.state = 'sale_product';
      await persistState(chatId);
      await bot.sendMessage(chatId, '⏳...');
      const prods = await api('/api/products', 'GET', null, chatId);
      if (Array.isArray(prods) && prods.length > 0) {
        s.context.products = prods;
        let msg = '📦 *¿Qué vendiste?*\n\n';
        prods.slice(0, 15).forEach((p, i) => { msg += (i + 1) + '. ' + p.name + '\n'; });
        msg += '\n_O escribe_';
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown',  });
      } else { s.context.products = []; await bot.sendMessage(chatId, '📝 *Nombre del producto:*', { parse_mode: 'Markdown',  }); }
      break;
    }

    case 'sale_product': {
      const num = parseInt(text);
      let prod = null;
      if (num > 0 && s.context.products?.[num - 1]) prod = s.context.products[num - 1];
      else { const f = s.context.products?.find(p => p.name.toLowerCase().includes(text.toLowerCase())); prod = f || { name: text.trim(), id: null, sale_price: 0 }; }
      s.context.pendingProduct = prod.name;
      s.context.pendingProductId = prod.id || null;
      s.context.pendingProductPrice = parseFloat(prod.sale_price || prod.price) || 0;
      s.state = 'sale_qty';
      await persistState(chatId);
      await bot.sendMessage(chatId, '📦 *' + prod.name + '*\n\n¿Cantidad?', { parse_mode: 'Markdown',  });
      break;
    }

    case 'sale_qty': {
      const qty = parseInt(text);
      if (!qty || qty <= 0) { await bot.sendMessage(chatId, '⚠️ Inválida:'); return true; }
      if (!s.context.items) s.context.items = [];
      const price = s.context.pendingProductPrice;
      s.context.items.push({ product_id: s.context.pendingProductId, description: s.context.pendingProduct, qty, price, total: qty * price });
      s.state = 'sale_add_more';
      await persistState(chatId);
      await bot.sendMessage(chatId, '✅ ' + s.context.pendingProduct + ' x' + qty + ' — ' + fmt(qty * price) + '\n\n¿Vendiste algo más?', { parse_mode: 'Markdown',  });
      break;
    }

    case 'sale_add_more': {
      if (flowResult.action === 'yes') {
        s.state = 'sale_product';
        await persistState(chatId);
        let msg = '📦 *Siguiente?*\n\n';
        s.context.products?.slice(0, 15).forEach((p, i) => { msg += (i + 1) + '. ' + p.name + '\n'; });
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown',  });
      } else { s.state = 'sale_payment'; await persistState(chatId); await bot.sendMessage(chatId, '💳 *Metodo de pago?*', { parse_mode: 'Markdown',  }); }
      break;
    }

    case 'sale_payment': {
      if (flowResult.action !== 'method') { await bot.sendMessage(chatId, '⚠️ Escribe: efectivo, crédito, tarjeta o transferencia', { parse_mode: 'Markdown' }); return true; }
      s.context.paymentMethod = flowResult.method;
      s.state = 'sale_confirm';
      await persistState(chatId);
      await sendSaleSummary(chatId, s.context);
      break;
    }

    case 'sale_confirm': {
      if (flowResult.action === 'yes') {
        await bot.sendMessage(chatId, '⏳...');
        const result = await processSaleFull(chatId, s.context);
        if (!result.success) { await bot.sendMessage(chatId, '❌ ' + result.error); resetSession(chatId); return true; }
        await bot.sendMessage(chatId, result.message, { parse_mode: 'Markdown',  });
        const invData = await api('/api/invoices/' + result.invoice.id, 'GET', null, chatId);
        if (!invData.error && invData.items) {
          const receipt = receiptText(result.invoice, invData.items, s.context.client);
          await bot.sendMessage(chatId, '🧾 *Factura ' + (result.invoice.invoice_number || result.invoice.id) + '*\n\n```' + receipt + '```', { parse_mode: 'Markdown',  });
        }
        resetSession(chatId); return true;
      }
      await bot.sendMessage(chatId, '❌ Cancelada.'); resetSession(chatId); return true;
    }

    case 'cobrar_client': {
      if (!canUse(chatId, 'cobrar')) { await bot.sendMessage(chatId, planMsg(chatId)); resetSession(chatId); return true; }
      s.context.clientName = text.trim();
      const recs = await api('/api/receivables', 'GET', null, chatId);
      const found = Array.isArray(recs) ? recs.filter(r => (r.client_name || '').toLowerCase().includes(text.toLowerCase()) && r.status !== 'paid') : [];
      if (!found.length) { await bot.sendMessage(chatId, '⚠️ Sin cuentas pendientes.'); resetSession(chatId); return true; }
      s.context.clientRecs = found;
      let msg = '📋 *Cuentas de ' + s.context.clientName + ':*\n\n';
      found.forEach((r, i) => { msg += (i + 1) + '. ' + fmt((r.total_amount - r.paid_amount) || r.total_amount) + ' (' + r.status + ')\n'; });
      msg += '\n💰 *¿Cuanto pago?*';
      s.state = 'cobrar_amount';
      await persistState(chatId);
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown',  });
      break;
    }

    case 'cobrar_amount': {
      const amt = parseFloat(text.replace(/[^\d.]/g, ''));
      if (!amt || amt <= 0) { await bot.sendMessage(chatId, '⚠️ Inválido:'); return true; }
      s.context.payAmount = amt;
      s.context.payRecId = s.context.clientRecs[0]?.id;
      s.state = 'cobrar_confirm';
      await persistState(chatId);
      await bot.sendMessage(chatId, '💰 *' + fmt(amt) + '\n\n¿Todo bien con esto?', { parse_mode: 'Markdown',  });
      break;
    }

    case 'cobrar_confirm': {
      if (flowResult.action === 'yes') {
        await bot.sendMessage(chatId, '⏳...');
        let payment = await api('/api/receivables/' + s.context.payRecId + '/payments', 'POST', { amount: s.context.payAmount, date: new Date().toISOString().split('T')[0], notes: 'Via Telegram' }, chatId);
        if (payment.error) payment = await api('/api/receivable-payments', 'POST', { receivable_id: s.context.payRecId, amount: s.context.payAmount, date: new Date().toISOString().split('T')[0] }, chatId);
        if (payment.error) { await bot.sendMessage(chatId, '❌ ' + payment.error); resetSession(chatId); return true; }
        await bot.sendMessage(chatId, '✅ *PAGO REGISTRADO*\n\n👤 ' + s.context.clientName + '\n💰 ' + fmt(s.context.payAmount), { parse_mode: 'Markdown' });
      } else { await bot.sendMessage(chatId, '❌ Cancelado.'); }
      resetSession(chatId); break;
    }

    case 'expense_amount': {
      const amt = parseFloat(text.replace(/[^\d.]/g, ''));
      if (!amt || amt <= 0) { await bot.sendMessage(chatId, '⚠️ Inválido:'); return true; }
      s.context.amount = amt;
      s.state = 'expense_desc';
      await bot.sendMessage(chatId, '💰 ' + fmt(amt) + '\n\n📝 *Descripcion?*', { parse_mode: 'Markdown',  });
      break;
    }

    case 'expense_desc': {
      s.context.description = text.trim();
      s.state = 'expense_vendor';
      await bot.sendMessage(chatId, '📝 ' + s.context.description + '\n\n🏪 *Proveedor?* (o "N/A")', { parse_mode: 'Markdown',  });
      break;
    }

    case 'expense_vendor': {
      s.context.vendor = text.trim();
      s.state = 'expense_payment';
      await bot.sendMessage(chatId, '🏪 ' + s.context.vendor + '\n💰 ' + fmt(s.context.amount) + '\n\n💳 *Metodo?*', { parse_mode: 'Markdown',  });
      break;
    }

    case 'expense_payment': {
      if (flowResult.action !== 'method') { await bot.sendMessage(chatId, '⚠️ Escribe: efectivo, crédito, tarjeta o transferencia'); return true; }
      s.context.paymentMethod = flowResult.method;
      s.state = null;
      await bot.sendMessage(chatId, '⏳...');
      const r = await processExpenseFull(chatId, s.context);
      await bot.sendMessage(chatId, r.success ? r.message : '❌ ' + r.error, { parse_mode: 'Markdown',  });
      resetSession(chatId); break;
    }

    case 'report_type': {
      const map = { '📅 Diario': 'daily', '📆 Semanal': 'weekly', '🗓️ Mensual': 'monthly', '🔒 Cierre de Mes': 'cierre' };
      const kind = map[text];
      if (!kind) { await bot.sendMessage(chatId, '⚠️ Selecciona:'); return true; }
      if (kind !== 'daily' && !canUse(chatId, 'reporte_completo')) { await bot.sendMessage(chatId, planMsg(chatId)); resetSession(chatId); return true; }
      s.state = null;
      await bot.sendMessage(chatId, '⏳...');
      await sendReport(chatId, kind);
      resetSession(chatId); break;
    }

    default: return false;
  }
  return true;
}

// ==================== COMMANDS ====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  resetSession(chatId);
  await bot.sendMessage(chatId, '🐷 *MisCuentas Bot*\n\n' + (s.token ? '✅ Conectado' : '❌ Sin sesion') + '\n\n/venta /gasto /cobrar /reporte\n/balance /deudas /productos\n/login /logout', { parse_mode: 'Markdown' });
});

bot.onText(/\/login (.+) (.+)/, async (msg, m) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳...');
  const r = await axios.post(MISCUENTAS_API + '/api/auth/login', { username: m[1], password: m[2] }).catch(() => null);
  if (r?.data?.token) {
    const s = getSession(chatId);
    s.token = r.data.token;
    s.userId = r.data.user?.id;
    globalTokens.set(chatId, r.data.token);  // Persist token globally
    try {
      const planRes = await axios.get(MISCUENTAS_API + '/api/auth/plan', { headers: { 'x-session-token': r.data.token } });
      const planData = planRes.data || {};
      s.plan = planData;
      userTokens[chatId] = { jwt: r.data.token, plan: planData };
      await saveSession(chatId, r.data.token, planData);
      if (!planData.bot_access && planData.plan?.toLowerCase() !== 'admin' && planData.plan_name !== 'Admin') {
        await deleteSession(chatId);
        await bot.sendMessage(chatId, '❌ *Acceso denegado al bot*\n\nPlan: ' + (planData.plan_name || planData.plan || 'trial') + '\n\n👉 miscuentas-contable.app/upgrade', { parse_mode: 'Markdown' });
        return;
      }
      const trialInfo = planData.trial_active ? '\n\n📅 Trial: ' + planData.trial_days_left + ' dias restantes' : '';
      await bot.sendMessage(chatId, '✅ *Sesion iniciada*\nPlan: ' + (planData.plan_name || 'Free') + trialInfo, { parse_mode: 'Markdown' });
    } catch (e) {
      s.plan = { plan: 'trial', plan_name: 'Trial' };
      await bot.sendMessage(chatId, '✅ *Sesion iniciada*', { parse_mode: 'Markdown' });
    }
  } else { await bot.sendMessage(chatId, '❌ *Credenciales invalidas*', { parse_mode: 'Markdown' }); }
});

bot.onText(/\/cancelar/, async (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  await bot.sendMessage(chatId, '❌ *Cancelado.*', { parse_mode: 'Markdown' });
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  await deleteSession(chatId);
  resetSession(chatId);
  await bot.sendMessage(chatId, '👋 *Sesion cerrada*', { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  await bot.sendMessage(chatId, '📊...');
  const [b, i] = await Promise.all([api('/api/balance', 'GET', null, chatId), api('/api/income-statement', 'GET', null, chatId)]);
  await bot.sendMessage(chatId, '📊 *Balance*\n\n🟢 Activos: ' + fmt(b?.total_assets) + '\n🔴 Pasivos: ' + fmt(b?.total_liabilities) + '\n🔵 Patrimonio: ' + fmt(b?.equity) + '\n\n💰 Ingreso Neto: ' + fmt(i?.net_income), { parse_mode: 'Markdown' });
});

bot.onText(/\/deudas/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  await bot.sendMessage(chatId, '📋...');
  const [cxc, cxp] = await Promise.all([api('/api/receivables', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId)]);
  const totalCXC = Array.isArray(cxc) ? cxc.reduce((s, r) => s + parseFloat((r.total_amount - r.paid_amount) || 0), 0) : 0;
  const totalCXP = Array.isArray(cxp) ? cxp.reduce((s, p) => s + parseFloat((p.total_amount - p.paid_amount) || 0), 0) : 0;
  await bot.sendMessage(chatId, '📋 *Cuentas*\n\n🟢 Te deben: ' + fmt(totalCXC) + '\n🔴 Debes: ' + fmt(totalCXP), { parse_mode: 'Markdown' });
});

bot.onText(/\/productos/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  const prods = await api('/api/products', 'GET', null, chatId);
  if (!Array.isArray(prods) || !prods.length) { await bot.sendMessage(chatId, '📦 Sin productos'); return; }
  let txt = '📦 *Productos*\n\n';
  prods.slice(0, 10).forEach(p => { txt += '• ' + p.name + ' — Stock: ' + (p.stock_current || 0) + '\n'; });
  await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
});

bot.onText(/\/reporte/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  s.state = 'report_type';
  await bot.sendMessage(chatId, '📊 *Que reporte?*', { parse_mode: 'Markdown',  });
});

bot.onText(/\/cobrar/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  if (!canUse(chatId, 'cobrar')) { await bot.sendMessage(chatId, planMsg(chatId)); return; }
  resetSession(chatId);
  s.state = 'cobrar_client';
  await bot.sendMessage(chatId, '💰 *Registrar pago CxC*\n\n👤 *Nombre del cliente?*', { parse_mode: 'Markdown',  });
});

bot.onText(/\/venta/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  if (!canUse(chatId, 'venta')) { await bot.sendMessage(chatId, planMsg(chatId)); return; }
  resetSession(chatId);
  s.context.items = [];
  s.state = 'sale_client';
  await bot.sendMessage(chatId, '🧾 *REGISTRAR VENTA*\n\n👤 *Nombre del cliente?*', { parse_mode: 'Markdown',  });
});

bot.onText(/\/gasto/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  if (!canUse(chatId, 'gasto')) { await bot.sendMessage(chatId, planMsg(chatId)); return; }
  resetSession(chatId);
  s.state = 'expense_amount';
  await bot.sendMessage(chatId, '💸 *REGISTRAR GASTO*\n\n💰 *Monto?*', { parse_mode: 'Markdown',  });
});

// Handle inline keyboard button clicks (callback_query)
bot.on('callback_query', async (query) => {
  const chatId = String(query.message?.chat?.id);
  const data = query.data;
  if (!chatId || !data) { try { await bot.answerCallbackQuery(query.id); } catch(e) {}; return; }
  const s = getSession(chatId);
  // Recover token from globalTokens if missing
  if (!s.token && globalTokens.has(chatId)) {
    if (!userSessions[chatId]) userSessions[chatId] = {};
    userSessions[chatId].token = globalTokens.get(chatId);
    s.token = userSessions[chatId].token;
  }
  // If still no token, answer with error
  if (!s.token) {
    try { await bot.answerCallbackQuery(query.id, { text: 'Primero /login' }); } catch(e) {}
    return;
  }
  // If no active state, just acknowledge
  if (!s.state || s.state === 'idle') {
    try { await bot.answerCallbackQuery(query.id); } catch(e) {}
    return;
  }
  // Process the callback data as if it were a text message in the current state
  await handleStateMessage(chatId, data);
  try { await bot.answerCallbackQuery(query.id); } catch(e) {}
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const s = getSession(chatId);
  
  // Recover token from globalTokens if missing
  if (!s.token && globalTokens.has(chatId)) {
    if (!userSessions[chatId]) userSessions[chatId] = {};
    userSessions[chatId].token = globalTokens.get(chatId);
    s.token = userSessions[chatId].token;
  }
  
  // Si hay un flujo activo, manejar directamente sin NLP
  if (s.state && s.state !== 'idle') { await handleStateMessage(chatId, text); return; }
  
  if (!s.token) {
    const saved = await loadSession(chatId);
    if (saved) { s.token = saved.jwt; s.plan = saved.plan; }
    else { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  }
  if (!GROQ_API_KEY) {
    if (text.match(/venta|gasto|cobrar|reportes|productos|deudas|balance/i)) {
      await bot.sendMessage(chatId, '🐷 *Usa comandos directos:*\n/venta /gasto /cobrar /reporte /productos /deudas /balance', { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '❌ *No entendí.* /help', { parse_mode: 'Markdown' });
    }
    return;
  }
  const prompt = 'Responde JSON: {"intent":"venta|gasto|cobrar|reportes|balance|deudas|productos|ayuda|desconocido","confidence":"0.0-1.0"}' +
    '\n\nMensaje: ' + text +
    '\n\nEjemplos:' +
    '\n- "registra una venta" → {"intent":"venta","confidence":0.95}' +
    '\n- "balance" → {"intent":"balance","confidence":0.9}' +
    '\n- "registrar gasto" → {"intent":"gasto","confidence":0.9}' +
    '\n- "cobrar" → {"intent":"cobrar","confidence":0.9}' +
    '\n- "reporte" → {"intent":"reportes","confidence":0.85}' +
    '\n\nImportante: NO interpretar CxC, credit, debit, tarjeta, efectivo, banco, transferencia, confirmar, cancelar como comandos. Estos son botones del flujo de venta/gasto/cobro.';
  const result = await groqChat(prompt);
  if (!result || result.intent === 'desconocido' || result.confidence < 0.4) {
    await bot.sendMessage(chatId, '❌ *No entendí.* Prueba: /venta /gasto /cobrar /reporte', { parse_mode: 'Markdown' });
    return;
  }
  switch (result.intent) {
    case 'venta': if (canUse(chatId, 'venta')) { resetSession(chatId); s.context.items = []; s.state = 'sale_client'; await bot.sendMessage(chatId, '🧾 *VENTA*\n\n¿A quién le vendiste?', { parse_mode: 'Markdown',  }); } else { await bot.sendMessage(chatId, planMsg(chatId)); } break;
    case 'gasto': if (canUse(chatId, 'gasto')) { resetSession(chatId); s.state = 'expense_amount'; await bot.sendMessage(chatId, '💸 *GASTO*\n\n💰 Monto?', { parse_mode: 'Markdown',  }); } else { await bot.sendMessage(chatId, planMsg(chatId)); } break;
    case 'cobrar': if (canUse(chatId, 'cobrar')) { resetSession(chatId); s.state = 'cobrar_client'; await bot.sendMessage(chatId, '💰 *COBRAR*\n\n👤 Cliente?', { parse_mode: 'Markdown',  }); } else { await bot.sendMessage(chatId, planMsg(chatId)); } break;
    case 'reportes': s.state = 'report_type'; await bot.sendMessage(chatId, '📊 *Reporte?*', { parse_mode: 'Markdown',  }); break;
    case 'balance': await bot.sendMessage(chatId, '/balance'); break;
    case 'deudas': await bot.sendMessage(chatId, '/deudas'); break;
    case 'productos': await bot.sendMessage(chatId, '/productos'); break;
  }
});

bot.on('polling_error', e => console.error('Polling:', e.code, e.message));
bot.on('error', e => console.error('Bot error:', e));

console.log('🐷 MisCuentas Bot — Full v3');
console.log('API:', MISCUENTAS_API);

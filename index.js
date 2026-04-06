const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MISCUENTAS_API = process.env.MISCUENTAS_API || 'https://miscuentas-contable-app-production.up.railway.app';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const userSessions = {};
const userTokens = {};

function getSession(chatId) {
  if (!userSessions[chatId]) userSessions[chatId] = { token: null, userId: null, state: null, context: {} };
  return userSessions[chatId];
}
function resetSession(chatId) {
  const s = getSession(chatId);
  s.state = null; s.context = {};
}

async function api(endpoint, method = 'GET', data = null, chatId = null) {
  const s = getSession(chatId);
  const headers = {};
  if (s.token) headers['x-session-token'] = s.token;
  try {
    const r = await axios({ method, url: `${MISCUENTAS_API}${endpoint}`, data, headers, timeout: 15000 });
    return r.data;
  } catch (e) { return { error: e.response?.data?.error || e.message }; }
}

async function apiWithToken(token, endpoint, method = 'GET', data = null) {
  const headers = {};
  if (token) headers['x-session-token'] = token;
  try {
    const r = await axios({ method, url: `${MISCUENTAS_API}${endpoint}`, data, headers, timeout: 15000 });
    return r.data;
  } catch (e) { return { error: e.response?.data?.error || e.message }; }
}

function fmt(amount) {
  return `RD$ ${parseFloat(amount || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}`;
}

async function groqChat(prompt) {
  if (!GROQ_API_KEY) return null;
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 400 },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } });
    const text = r.data.choices[0]?.message?.content?.trim();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

// ==================== SCHEDULED ALERTS ====================
let morningInterval = null;
let weeklyInterval = null;
let lastWeeklyDate = null;

function startMorningAlerts() {
  if (morningInterval) return;
  morningInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 12 && now.getUTCMinutes() === 0) {
      Object.entries(userTokens).forEach(([chatId, token]) => {
        sendMorningAlert(parseInt(chatId), token).catch(console.error);
      });
    }
  }, 60000);
  console.log('🌅 Morning alerts started (8am DR = 12:00 UTC)');
}

async function sendMorningAlert(chatId, token) {
  const [recs, prods] = await Promise.all([
    apiWithToken(token, '/api/receivables', 'GET', null),
    apiWithToken(token, '/api/products', 'GET', null)
  ]);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  let msg = '🔔 *Buenos días! Resumen*\n\n';
  if (Array.isArray(recs)) {
    const urgent = recs.filter(r => r.status !== 'paid' && (r.due_date || today) <= in7);
    if (urgent.length > 0) {
      msg += '⚠️ *CxC próximas:*\n';
      urgent.slice(0, 5).forEach(r => { msg += `• ${r.client_name || 'Cliente'}: ${fmt(r.balance || r.total_amount)} (${r.due_date || 'sin fecha'})\n`; });
      msg += '\n';
    }
  }
  if (Array.isArray(prods)) {
    const low = prods.filter(p => { const c = parseFloat(p.stock_current) || 0; const m = parseFloat(p.stock_minimum) || 0; return m > 0 && c <= m; });
    if (low.length > 0) { msg += '📦 *Stock bajo:*\n'; low.slice(0, 5).forEach(p => { msg += `• ${p.name}: ${p.stock_current} / ${p.stock_minimum}\n`; }); }
  }
  if (msg === '🔔 *Buenos días! Resumen*\n\n') msg += '✅ Sin alertas pendientes.';
  try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch (e) { console.error(e.message); }
}

function startWeeklyReminder() {
  if (weeklyInterval) return;
  weeklyInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCDay() === 1 && now.getUTCHours() === 12 && now.getUTCMinutes() === 0) {
      const today = now.toISOString().split('T')[0];
      if (lastWeeklyDate !== today) {
        lastWeeklyDate = today;
        Object.entries(userTokens).forEach(([chatId, token]) => {
          sendWeeklyReminder(parseInt(chatId), token).catch(console.error);
        });
      }
    }
  }, 60000);
  console.log('📅 Weekly reminder started (Monday 8am DR)');
}

async function sendWeeklyReminder(chatId, token) {
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const [invs, recs, payables] = await Promise.all([
    apiWithToken(token, '/api/invoices', 'GET', null),
    apiWithToken(token, '/api/receivables', 'GET', null),
    apiWithToken(token, '/api/payables', 'GET', null)
  ]);
  const weeklyInvs = Array.isArray(invs) ? invs.filter(i => i.date >= weekAgo && i.date <= today) : [];
  const pendingCXC = Array.isArray(recs) ? recs.filter(r => r.status !== 'paid') : [];
  const pendingCXP = Array.isArray(payables) ? payables.filter(p => p.status !== 'paid') : [];
  const msg = `📊 *RESUMEN SEMANAL*\n\n🧾 Facturas: ${weeklyInvs.length}\n💰 Ventas: ${fmt(weeklyInvs.reduce((s, i) => s + parseFloat(i.total || 0), 0))}\n\n📋 Pendientes:\n🟢 CxC: ${fmt(pendingCXC.reduce((s, r) => s + parseFloat(r.balance || 0), 0))} (${pendingCXC.length})\n🔴 CxP: ${fmt(pendingCXP.reduce((s, p) => s + parseFloat(p.balance || 0), 0))} (${pendingCXP.length})`;
  try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch (e) { console.error(e.message); }
}

startMorningAlerts();
startWeeklyReminder();

// ==================== KEYBOARDS ====================
const K_PAYMENT = { reply_markup: JSON.stringify({ keyboard: [['💵 Efectivo', '📋 CxC'], ['💳 Tarjeta', '🏦 Transferencia'], ['❌ Cancelar']], one_time_keyboard: true, resize_keyboard: true }) };
const K_YES_NO = { reply_markup: JSON.stringify({ keyboard: [['✅ Sí, agregar otro', '✅ No, continuar'], ['❌ Cancelar']], one_time_keyboard: true, resize_keyboard: true }) };
const K_CONFIRM = { reply_markup: JSON.stringify({ keyboard: [['✅ Confirmar'], ['❌ Cancelar']], one_time_keyboard: true, resize_keyboard: true }) };
const K_CANCEL = { reply_markup: JSON.stringify({ keyboard: [['❌ Cancelar']], one_time_keyboard: true, resize_keyboard: true }) };
const K_REPORT = { reply_markup: JSON.stringify({ keyboard: [['📅 Diario', '📆 Semanal'], ['🗓️ Mensual', '🔒 Cierre de Mes'], ['❌ Cancelar']], one_time_keyboard: true, resize_keyboard: true }) };

// ==================== RECEIPT TEXT ====================
function receiptText(invoice, items, clientName) {
  const total = items.reduce((s, i) => s + parseFloat(i.total || 0), 0);
  let t = `\n╔══════════════════════════════╗\n║         FACTURA              ║\n╠══════════════════════════════╣\n`;
  t += `║ No: ${(invoice.invoice_number || invoice.id || '').padEnd(22)}║\n`;
  t += `║ Fecha: ${(invoice.date || '').padEnd(21)}║\n`;
  t += `╠══════════════════════════════╣\n`;
  t += `║ Cliente: ${(clientName || '').padEnd(20)}║\n╠══════════════════════════════╣\n`;
  items.forEach(i => { t += `║ ${(i.description || '').substring(0, 22).padEnd(22)}║\n`; t += `║   x${i.qty} ──────────────── ${fmt(i.total || 0).padEnd(10)}║\n`; });
  t += `╠══════════════════════════════╣\n║ TOTAL: ${fmt(total).padEnd(22)}║\n╚══════════════════════════════╝\n`;
  return t;
}

// ==================== STATE MACHINE ====================
async function handleStateMessage(chatId, text) {
  const s = getSession(chatId);
  if (text === '❌ Cancelar') { resetSession(chatId); await bot.sendMessage(chatId, '❌ Cancelado.'); return true; }

  switch (s.state) {

    case 'sale_client': {
      s.context.client = text.trim();
      s.state = 'sale_product';
      await bot.sendMessage(chatId, '⏳...');
      const prods = await api('/api/products', 'GET', null, chatId);
      if (Array.isArray(prods) && prods.length > 0) {
        s.context.products = prods;
        let msg = '📦 *Producto?*\n\n';
        prods.slice(0, 15).forEach((p, i) => { msg += `${i + 1}. ${p.name}\n`; });
        msg += '\n_O escribe_';
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...K_CANCEL });
      } else {
        s.context.products = [];
        await bot.sendMessage(chatId, '📝 *Nombre del producto:*', { parse_mode: 'Markdown', ...K_CANCEL });
      }
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
      await bot.sendMessage(chatId, `📦 *${prod.name}*\n\n¿Cantidad?`, { parse_mode: 'Markdown', ...K_CANCEL });
      break;
    }

    case 'sale_qty': {
      const qty = parseInt(text);
      if (!qty || qty <= 0) { await bot.sendMessage(chatId, '⚠️ Inválida:'); return true; }
      if (!s.context.items) s.context.items = [];
      const price = s.context.pendingProductPrice;
      s.context.items.push({ product_id: s.context.pendingProductId, description: s.context.pendingProduct, qty, price, total: qty * price });
      s.state = 'sale_add_more';
      await bot.sendMessage(chatId, `✅ ${s.context.pendingProduct} x${qty} — ${fmt(qty * price)}\n\n¿Otro?`, { parse_mode: 'Markdown', ...K_YES_NO });
      break;
    }

    case 'sale_add_more': {
      if (text.includes('Sí')) {
        s.state = 'sale_product';
        let msg = '📦 *Siguiente?*\n\n';
        s.context.products?.slice(0, 15).forEach((p, i) => { msg += `${i + 1}. ${p.name}\n`; });
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...K_CANCEL });
      } else {
        s.state = 'sale_payment';
        await bot.sendMessage(chatId, '💳 *Método de pago?*', { parse_mode: 'Markdown', ...K_PAYMENT });
      }
      break;
    }

    case 'sale_payment': {
      const m = { '💵 Efectivo': 'cash', '📋 CxC': 'credit', '💳 Tarjeta': 'card', '🏦 Transferencia': 'bank' };
      const method = m[text];
      if (!method) { await bot.sendMessage(chatId, '⚠️ Selecciona:', { parse_mode: 'Markdown', ...K_PAYMENT }); return true; }
      s.context.paymentMethod = method;
      s.state = 'sale_confirm';
      await sendSaleSummary(chatId, s.context);
      break;
    }

    case 'sale_confirm': {
      if (text === '✅ Confirmar') {
        await bot.sendMessage(chatId, '⏳...');
        const result = await processSaleFull(chatId, s.context);
        if (!result.success) { await bot.sendMessage(chatId, `❌ ${result.error}`); resetSession(chatId); return true; }
        await bot.sendMessage(chatId, result.message, { parse_mode: 'Markdown' });
        const invData = await api(`/api/invoices/${result.invoice.id}`, 'GET', null, chatId);
        if (!invData.error && invData.items) {
          const receipt = receiptText(result.invoice, invData.items, s.context.client);
          await bot.sendMessage(chatId, `🧾 *Factura ${result.invoice.invoice_number || result.invoice.id}*\n\n\`\`\`${receipt}\`\`\``, { parse_mode: 'Markdown' });
        }
        resetSession(chatId);
      } else { await bot.sendMessage(chatId, '❌ Cancelada.'); resetSession(chatId); }
      break;
    }

    // ==================== /COBRAR FLOW ====================
    case 'cobrar_client': {
      s.context.clientName = text.trim();
      const recs = await api('/api/receivables', 'GET', null, chatId);
      const found = Array.isArray(recs) ? recs.filter(r => (r.client_name || '').toLowerCase().includes(text.toLowerCase()) && r.status !== 'paid') : [];
      if (!found.length) { await bot.sendMessage(chatId, '⚠️ Sin cuentas pendientes para ese cliente.'); resetSession(chatId); return true; }
      s.context.clientRecs = found;
      let msg = `📋 *Cuentas de ${s.context.clientName}:*\n\n`;
      found.forEach((r, i) => { msg += `${i + 1}. ${fmt(r.balance || r.total_amount)} (${r.status})\n`; });
      msg += '\n💰 *¿Cuánto pagó?*';
      s.state = 'cobrar_amount';
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...K_CANCEL });
      break;
    }

    case 'cobrar_amount': {
      const amt = parseFloat(text.replace(/[^\d.]/g, ''));
      if (!amt || amt <= 0) { await bot.sendMessage(chatId, '⚠️ Inválido:'); return true; }
      s.context.payAmount = amt;
      s.context.payRecId = s.context.clientRecs[0]?.id;
      s.state = 'cobrar_confirm';
      await bot.sendMessage(chatId, `💰 ${fmt(amt)}\n\n¿Confirmas pago a ${s.context.clientName}?`, { parse_mode: 'Markdown', ...K_CONFIRM });
      break;
    }

    case 'cobrar_confirm': {
      if (text === '✅ Confirmar') {
        await bot.sendMessage(chatId, '⏳...');
        let payment = await api(`/api/receivables/${s.context.payRecId}/payments`, 'POST', { amount: s.context.payAmount, date: new Date().toISOString().split('T')[0], notes: 'Via Telegram' }, chatId);
        if (payment.error) payment = await api('/api/receivable-payments', 'POST', { receivable_id: s.context.payRecId, amount: s.context.payAmount, date: new Date().toISOString().split('T')[0] }, chatId);
        if (payment.error) { await bot.sendMessage(chatId, `❌ ${payment.error}`); resetSession(chatId); return true; }
        await bot.sendMessage(chatId, `✅ *PAGO REGISTRADO*\n\n👤 ${s.context.clientName}\n💰 ${fmt(s.context.payAmount)}`, { parse_mode: 'Markdown' });
      } else { await bot.sendMessage(chatId, '❌ Cancelado.'); }
      resetSession(chatId);
      break;
    }

    // ==================== EXPENSE FLOW ====================
    case 'expense_amount': {
      const amt = parseFloat(text.replace(/[^\d.]/g, ''));
      if (!amt || amt <= 0) { await bot.sendMessage(chatId, '⚠️ Inválido:'); return true; }
      s.context.amount = amt;
      s.state = 'expense_desc';
      await bot.sendMessage(chatId, `💰 ${fmt(amt)}\n\n📝 *Descripción?*`, { parse_mode: 'Markdown', ...K_CANCEL });
      break;
    }

    case 'expense_desc': {
      s.context.description = text.trim();
      s.state = 'expense_vendor';
      await bot.sendMessage(chatId, `📝 ${s.context.description}\n\n🏪 *Proveedor?* (o "N/A")`, { parse_mode: 'Markdown', ...K_CANCEL });
      break;
    }

    case 'expense_vendor': {
      s.context.vendor = text.trim();
      s.state = 'expense_payment';
      await bot.sendMessage(chatId, `🏪 ${s.context.vendor}\n💰 ${fmt(s.context.amount)}\n\n💳 *Método?*`, { parse_mode: 'Markdown', ...K_PAYMENT });
      break;
    }

    case 'expense_payment': {
      const m = { '💵 Efectivo': 'cash', '📋 CxP': 'credit', '💳 Tarjeta': 'card', '🏦 Transferencia': 'bank' };
      const method = m[text];
      if (!method) { await bot.sendMessage(chatId, '⚠️ Selecciona:'); return true; }
      s.context.paymentMethod = method;
      s.state = null;
      await bot.sendMessage(chatId, '⏳...');
      const r = await processExpenseFull(chatId, s.context);
      await bot.sendMessage(chatId, r.success ? r.message : `❌ ${r.error}`, { parse_mode: 'Markdown' });
      resetSession(chatId);
      break;
    }

    // ==================== REPORT FLOW ====================
    case 'report_type': {
      const map = { '📅 Diario': 'daily', '📆 Semanal': 'weekly', '🗓️ Mensual': 'monthly', '🔒 Cierre de Mes': 'cierre' };
      const kind = map[text];
      if (!kind) { await bot.sendMessage(chatId, '⚠️ Selecciona:'); return true; }
      s.state = null;
      await bot.sendMessage(chatId, '⏳...');
      await sendReport(chatId, kind);
      resetSession(chatId);
      break;
    }

    default: return false;
  }
  return true;
}

// ==================== HELPERS ====================
async function sendSaleSummary(chatId, ctx) {
  const items = ctx.items || [];
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const labels = { cash: '💵 Efectivo', credit: '📋 CxC', card: '💳 Tarjeta', bank: '🏦 Transferencia' };
  let msg = `📄 *FACTURA*\n\n👤 ${ctx.client}\n\n`;
  items.forEach(i => { msg += `📦 ${i.description} x${i.qty} — ${fmt(i.total)}\n`; });
  msg += `\n─────────────\n💰 *Total: ${fmt(subtotal)}*\n💳 ${labels[ctx.paymentMethod]}\n\n_Confirmas?_`;
  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...K_CONFIRM });
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
  return { success: true, invoice: inv, message: `✅ *FACTURA*\n\n📄 ${inv.invoice_number || inv.id}\n👤 ${ctx.client}\n💰 ${fmt(subtotal)}\n💳 ${getPaymentLabel(ctx.paymentMethod)}` };
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
    date: new Date().toISOString().split('T')[0], description: `Gasto: ${ctx.description}`,
    entries: [{ account_code: expAcct, debit: ctx.amount, credit: 0, memo: ctx.description }, { account_code: creditAcct, debit: 0, credit: ctx.amount, memo: ctx.vendor }],
    reference: payable.id
  }, chatId);
  return { success: true, message: `✅ *GASTO*\n\n📝 ${ctx.description}\n🏪 ${ctx.vendor === 'N/A' ? 'Varios' : ctx.vendor}\n💰 ${fmt(ctx.amount)}\n💳 ${getPaymentLabel(ctx.paymentMethod)}` };
}

function getPaymentLabel(m) { return { cash: '💵 Efectivo', credit: '📋 CxC', card: '💳 Tarjeta', bank: '🏦 Transferencia' }[m] || m; }

async function sendReport(chatId, kind) {
  const today = new Date().toISOString().split('T')[0];
  let dateFrom = today;
  if (kind === 'weekly') { const d = new Date(); d.setDate(d.getDate() - 7); dateFrom = d.toISOString().split('T')[0]; }
  else if (kind === 'monthly') { const d = new Date(); d.setMonth(d.getMonth() - 1); dateFrom = d.toISOString().split('T')[0]; }

  if (kind === 'cierre') {
    const [inc, bal, cxc, cxp, prods] = await Promise.all([
      api('/api/income-statement', 'GET', null, chatId),
      api('/api/balance', 'GET', null, chatId),
      api('/api/receivables', 'GET', null, chatId),
      api('/api/payables', 'GET', null, chatId),
      api('/api/products', 'GET', null, chatId)
    ]);
    const totalCXC = Array.isArray(cxc) ? cxc.reduce((s, r) => s + parseFloat(r.balance || 0), 0) : 0;
    const totalCXP = Array.isArray(cxp) ? cxp.reduce((s, p) => s + parseFloat(p.balance || 0), 0) : 0;
    const invVal = Array.isArray(prods) ? prods.reduce((s, p) => s + parseFloat(p.stock_current || 0) * parseFloat(p.cost_price || 0), 0) : 0;
    await bot.sendMessage(chatId,
      `🔒 *CIERRE DE MES*\n\n📊 *Estado de Resultados*\nIngresos: ${fmt(inc?.total_revenue || 0)}\nGastos: ${fmt(inc?.total_expenses || 0)}\n*Utilidad: ${fmt(inc?.net_income || 0)}*\n\n📋 *Cuentas*\n🟢 CxC: ${fmt(totalCXC)}\n🔴 CxP: ${fmt(totalCXP)}\n\n📦 Inventario: ${Array.isArray(prods) ? prods.length : 0} productos\nValor: ${fmt(invVal)}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const invs = await api('/api/invoices', 'GET', null, chatId);
  const filtered = Array.isArray(invs) ? invs.filter(i => i.date >= dateFrom && i.date <= today) : [];
  const payables = await api('/api/payables', 'GET', null, chatId);
  const filteredPay = Array.isArray(payables) ? payables.filter(p => p.date >= dateFrom && p.date <= today) : [];
  const totalSales = filtered.reduce((s, i) => s + parseFloat(i.total || 0), 0);
  const totalExp = filteredPay.reduce((s, p) => s + parseFloat(p.total || 0), 0);
  const labels = { daily: '📅 Diario', weekly: '📆 Semanal', monthly: '🗓️ Mensual' };
  await bot.sendMessage(chatId,
    `${labels[kind]} *REPORTE*\n\n📅 ${dateFrom} → ${today}\n\n🧾 Facturas: ${filtered.length}\n💰 Ventas: ${fmt(totalSales)}\n\n💸 Gastos: ${filteredPay.length}\n💸 Total: ${fmt(totalExp)}\n\n*Balance: ${fmt(totalSales - totalExp)}*`,
    { parse_mode: 'Markdown' }
  );
}

// ==================== COMMANDS ====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  resetSession(chatId);
  await bot.sendMessage(chatId, `🐷 *MisCuentas Bot*\n\n${s.token ? '✅ Conectado' : '❌ Sin sesión'}\n\n/venta /gasto /cobrar /reporte\n/balance /deudas /productos\n/login /logout`, { parse_mode: 'Markdown' });
});


bot.onText(/\/login (.+) (.+)/, async (msg, m) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳...');
  const r = await axios.post(`${MISCUENTAS_API}/api/auth/login`, { username: m[1], password: m[2] }).catch(() => null);
  if (r?.data?.token) {
    const s = getSession(chatId);
    s.token = r.data.token;
    s.userId = r.data.user?.id;

    // Check bot_access in plan
    try {
      const planRes = await axios.get(`${MISCUENTAS_API}/api/auth/plan`, {
        headers: { 'x-session-token': r.data.token }
      });
      const planData = planRes.data || {};
      const currentPlan = planData.plan_name || planData.plan || 'trial';
      if (!planData.bot_access && currentPlan !== 'Admin') {
        delete userTokens[chatId];
        await bot.sendMessage(chatId,
          `❌ *Acceso denegado al bot*\n\nTu plan actual: ${currentPlan}\n\n📱 Actualiza a *Plan Pro* (RD$990/mes) para usar el bot\n👉 miscuentas-contable.app/upgrade`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
      // Plan OK - bot access granted
      userTokens[chatId] = r.data.token;
      const trialInfo = planData.trial_active ? `\n\n📅 Trial: ${planData.trial_days_left} días restantes` : '';
      await bot.sendMessage(chatId, `✅ *Sesión iniciada*\nPlan: ${planData.plan_name}${trialInfo}`, { parse_mode: 'Markdown' });
    } catch (e) {
      // If plan check fails, still allow access with token
      userTokens[chatId] = r.data.token;
      await bot.sendMessage(chatId, '✅ *Sesión iniciada*', { parse_mode: 'Markdown' });
    }
  } else { await bot.sendMessage(chatId, '❌ *Credenciales inválidas*', { parse_mode: 'Markdown' }); }
});
bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  delete userTokens[chatId];
  resetSession(chatId);
  await bot.sendMessage(chatId, '👋 *Sesión cerrada*', { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  await bot.sendMessage(chatId, '📊...');
  const [b, i] = await Promise.all([api('/api/balance', 'GET', null, chatId), api('/api/income-statement', 'GET', null, chatId)]);
  await bot.sendMessage(chatId, `📊 *Balance*\n\n🟢 Activos: ${fmt(b?.total_assets)}\n🔴 Pasivos: ${fmt(b?.total_liabilities)}\n🔵 Patrimonio: ${fmt(b?.equity)}\n\n💰 Ingreso Neto: ${fmt(i?.net_income)}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/deudas/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  await bot.sendMessage(chatId, '📋...');
  const [cxc, cxp] = await Promise.all([api('/api/receivables', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId)]);
  const totalCXC = Array.isArray(cxc) ? cxc.reduce((s, r) => s + parseFloat(r.balance || 0), 0) : 0;
  const totalCXP = Array.isArray(cxp) ? cxp.reduce((s, p) => s + parseFloat(p.balance || 0), 0) : 0;
  await bot.sendMessage(chatId, `📋 *Cuentas*\n\n🟢 Te deben: ${fmt(totalCXC)}\n🔴 Debes: ${fmt(totalCXP)}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/productos/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  const prods = await api('/api/products', 'GET', null, chatId);
  if (!Array.isArray(prods) || !prods.length) { await bot.sendMessage(chatId, '📦 Sin productos'); return; }
  let txt = '📦 *Productos*\n\n';
  prods.slice(0, 10).forEach(p => { txt += `• ${p.name} — Stock: ${p.stock_current || 0}\n`; });
  await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
});

bot.onText(/\/reporte/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  s.state = 'report_type';
  await bot.sendMessage(chatId, '📊 *Qué reporte?*', { parse_mode: 'Markdown', ...K_REPORT });
});

bot.onText(/\/cobrar/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  resetSession(chatId);
  s.state = 'cobrar_client';
  await bot.sendMessage(chatId, '💰 *Registrar pago de CxC*\n\n👤 *Nombre del cliente?*', { parse_mode: 'Markdown', ...K_CANCEL });
});

bot.onText(/\/venta/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  resetSession(chatId);
  s.context.items = [];
  s.state = 'sale_client';
  await bot.sendMessage(chatId, '🧾 *REGISTRAR VENTA*\n\n👤 *Nombre del cliente?*', { parse_mode: 'Markdown', ...K_CANCEL });
});

bot.onText(/\/gasto/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  resetSession(chatId);
  s.state = 'expense_amount';
  await bot.sendMessage(chatId, '💸 *REGISTRAR GASTO*\n\n💰 *Monto?*', { parse_mode: 'Markdown', ...K_CANCEL });
});

// Natural language
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const s = getSession(chatId);

  if (s.state) {
    const handled = await handleStateMessage(chatId, text);
    if (handled) return;
  }
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero /login*'); return; }
  if (!GROQ_API_KEY) return;

  const prompt = `Responde SOLO con JSON: {"intent": "venta|gasto|cobrar|balance|deudas|reportes|productos|ayuda|desconocido", "confidence": 0.0-1.0}
Mensaje: "${text}"
Ejemplos:
- "registra una venta" → {"intent":"venta","confidence":0.95}
- "registrar gasto" → {"intent":"gasto","confidence":0.9}
- "cobrar" → {"intent":"cobrar","confidence":0.9}
- "balance" → {"intent":"balance","confidence":0.9}
- "reporte" → {"intent":"reportes","confidence":0.85}`;

  const result = await groqChat(prompt);
  if (!result) return;

  switch (result.intent) {
    case 'venta':
      resetSession(chatId); s.context.items = []; s.state = 'sale_client';
      await bot.sendMessage(chatId, '🧾 *VENTA*\n\n👤 Cliente?', { parse_mode: 'Markdown', ...K_CANCEL });
      break;
    case 'gasto':
      resetSession(chatId); s.state = 'expense_amount';
      await bot.sendMessage(chatId, '💸 *GASTO*\n\n💰 Monto?', { parse_mode: 'Markdown', ...K_CANCEL });
      break;
    case 'cobrar':
      resetSession(chatId); s.state = 'cobrar_client';
      await bot.sendMessage(chatId, '💰 *COBRAR*\n\n👤 Cliente?', { parse_mode: 'Markdown', ...K_CANCEL });
      break;
    case 'reportes':
      s.state = 'report_type';
      await bot.sendMessage(chatId, '📊 *Reporte?*', { parse_mode: 'Markdown', ...K_REPORT });
      break;
    case 'balance': await bot.sendMessage(chatId, '/balance'); break;
    case 'deudas': await bot.sendMessage(chatId, '/deudas'); break;
    case 'productos': await bot.sendMessage(chatId, '/productos'); break;
  }
});

// Errors
bot.on('polling_error', e => console.error('Polling:', e.code, e.message));
bot.on('error', e => console.error('Bot error:', e));

console.log('🐷 MisCuentas Bot — Full');
console.log(`📡 ${MISCUENTAS_API}`);

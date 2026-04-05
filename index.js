const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ==================== CONFIG ====================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MISCUENTAS_API = process.env.MISCUENTAS_API || 'https://miscuentas-contable-app-production.up.railway.app';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant';

// ==================== BOT INIT ====================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ==================== SESSION STORE ====================
const userSessions = {};

function getSession(chatId) {
  if (!userSessions[chatId]) {
    userSessions[chatId] = { token: null, userId: null, state: null, context: {} };
  }
  return userSessions[chatId];
}

function resetSession(chatId) {
  const s = getSession(chatId);
  s.state = null;
  s.context = {};
}

// ==================== API HELPERS ====================
async function api(endpoint, method = 'GET', data = null, chatId = null) {
  const s = getSession(chatId);
  const headers = {};
  if (s.token) headers['x-session-token'] = s.token;
  try {
    const r = await axios({ method, url: `${MISCUENTAS_API}${endpoint}`, data, headers, timeout: 15000 });
    return r.data;
  } catch (e) {
    return { error: e.response?.data?.error || e.message };
  }
}

function fmt(amount) {
  return `RD$ ${parseFloat(amount || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}`;
}

// ==================== GROQ NLP ====================
async function groqChat(prompt) {
  if (!GROQ_API_KEY) return null;
  try {
    const r = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 400 },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    const text = r.data.choices[0]?.message?.content?.trim();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

// ==================== KEYBOARDS ====================
const PAYMENT_KEYBOARD = {
  reply_markup: JSON.stringify({
    keyboard: [
      [{ text: '💵 Efectivo' }, { text: '📋 CxC' }],
      [{ text: '💳 Tarjeta' }, { text: '🏦 Transferencia' }],
      [{ text: '❌ Cancelar' }]
    ],
    one_time_keyboard: true,
    resize_keyboard: true
  })
};

const YES_NO_KEYBOARD = {
  reply_markup: JSON.stringify({
    keyboard: [
      [{ text: '✅ Sí, agregar otro' }],
      [{ text: '✅ No, continuar' }],
      [{ text: '❌ Cancelar' }]
    ],
    one_time_keyboard: true,
    resize_keyboard: true
  })
};

const CONFIRM_KEYBOARD = {
  reply_markup: JSON.stringify({
    keyboard: [
      [{ text: '✅ Confirmar' }],
      [{ text: '❌ Cancelar' }]
    ],
    one_time_keyboard: true,
    resize_keyboard: true
  })
};

const CANCEL_KEYBOARD = {
  reply_markup: JSON.stringify({
    keyboard: [[{ text: '❌ Cancelar' }]],
    one_time_keyboard: true,
    resize_keyboard: true
  })
};

const REPORT_MENU_KEYBOARD = {
  reply_markup: JSON.stringify({
    keyboard: [
      [{ text: '📅 Diario' }],
      [{ text: '📆 Semanal' }],
      [{ text: '🗓️ Mensual' }],
      [{ text: '🔒 Cierre de Mes' }],
      [{ text: '❌ Cancelar' }]
    ],
    one_time_keyboard: true,
    resize_keyboard: true
  })
};

// ==================== STATE MACHINE ====================
// States:
// null → idle
// 'sale_client' → ask client name
// 'sale_product' → ask product
// 'sale_qty' → ask quantity
// 'sale_add_more' → ask if add another
// 'sale_payment' → ask payment method
// 'sale_confirm' → show summary + confirm
// 'expense_amount' → ask amount
// 'expense_desc' → ask description
// 'expense_vendor' → ask vendor
// 'expense_payment' → ask payment
// 'report_type' → report menu selected

async function handleStateMessage(chatId, text) {
  const s = getSession(chatId);

  if (text === '❌ Cancelar') {
    resetSession(chatId);
    await bot.sendMessage(chatId, '❌ Operación cancelada.', { parse_mode: 'Markdown' });
    return true;
  }

  switch (s.state) {

    // ==================== SALE FLOW ====================
    case 'sale_client': {
      s.context.client = text.trim();
      s.state = 'sale_product';

      // Load products
      await bot.sendMessage(chatId, '⏳ Cargando productos...', { parse_mode: 'Markdown' });
      const prods = await api('/api/products', 'GET', null, chatId);

      if (Array.isArray(prods) && prods.length > 0) {
        s.context.products = prods;
        let msg = '📦 *¿Qué producto vendiste?*\n\n';
        prods.slice(0, 15).forEach((p, i) => {
          msg += `${i + 1}. ${p.name}\n`;
        });
        msg += '\n_O escribe el nombre_';
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
      } else {
        s.context.products = [];
        await bot.sendMessage(chatId, '📝 *¿Qué producto?*\n(Escribe el nombre)', { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
      }
      break;
    }

    case 'sale_product': {
      const num = parseInt(text);
      let selectedProduct = null;

      if (num > 0 && s.context.products && s.context.products[num - 1]) {
        selectedProduct = s.context.products[num - 1];
      } else {
        // Search by name
        const found = s.context.products?.find(p =>
          p.name.toLowerCase().includes(text.toLowerCase())
        );
        selectedProduct = found || {
          name: text.trim(),
          id: null,
          price: s.context.items?.length > 0 ? 0 : null
        };
      }

      s.context.pendingProduct = selectedProduct.name;
      s.context.pendingProductId = selectedProduct.id || null;
      s.context.pendingProductPrice = parseFloat(selectedProduct.price) || 0;
      s.state = 'sale_qty';

      await bot.sendMessage(chatId,
        `📦 *${selectedProduct.name}*\n\n` +
        `¿Cuántas unidades?`,
        { parse_mode: 'Markdown', ...CANCEL_KEYBOARD }
      );
      break;
    }

    case 'sale_qty': {
      const qty = parseInt(text);
      if (!qty || qty <= 0) {
        await bot.sendMessage(chatId, '⚠️ Cantidad inválida. Ingresa un número positivo:');
        return true;
      }

      // Add item to list
      if (!s.context.items) s.context.items = [];

      const price = s.context.pendingProductPrice || 0;
      s.context.items.push({
        product_id: s.context.pendingProductId,
        description: s.context.pendingProduct,
        qty,
        price,
        total: qty * price
      });

      s.state = 'sale_add_more';
      await bot.sendMessage(chatId,
        `✅ *Agregado*\n\n` +
        `${s.context.pendingProduct} x${qty} — ${fmt(qty * price)}\n\n` +
        `¿Agregar otro producto?`,
        { parse_mode: 'Markdown', ...YES_NO_KEYBOARD }
      );
      break;
    }

    case 'sale_add_more': {
      if (text.includes('Sí') || text.includes('sí')) {
        // Reset pending and go back to product selection
        s.context.pendingProduct = null;
        s.context.pendingProductId = null;
        s.context.pendingProductPrice = 0;
        s.state = 'sale_product';

        let msg = '📦 *¿Qué otro producto?*\n\n';
        if (s.context.products?.length > 0) {
          s.context.products.slice(0, 15).forEach((p, i) => {
            msg += `${i + 1}. ${p.name}\n`;
          });
        }
        msg += '\n_O escribe el nombre_';
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
      } else {
        // Continue to payment
        s.state = 'sale_payment';
        await bot.sendMessage(chatId, '💳 *¿Método de pago?*', { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD });
      }
      break;
    }

    case 'sale_payment': {
      const methodMap = { '💵 Efectivo': 'cash', '📋 CxC': 'credit', '💳 Tarjeta': 'card', '🏦 Transferencia': 'bank' };
      const method = methodMap[text];
      if (!method) {
        await bot.sendMessage(chatId, '⚠️ Selecciona una opción del teclado:', { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD });
        return true;
      }
      s.context.paymentMethod = method;

      // Show summary for confirmation
      s.state = 'sale_confirm';
      await sendSaleSummary(chatId, s.context);
      break;
    }

    case 'sale_confirm': {
      if (text === '✅ Confirmar') {
        await bot.sendMessage(chatId, '⏳ Procesando factura...', { parse_mode: 'Markdown' });

        const result = await processSaleFull(chatId, s.context);

        if (!result.success) {
          await bot.sendMessage(chatId, `❌ Error: ${result.error}`);
          resetSession(chatId);
          return true;
        }

        await bot.sendMessage(chatId, result.message, { parse_mode: 'Markdown' });
        resetSession(chatId);
      } else {
        await bot.sendMessage(chatId, '❌ Factura cancelada.', { parse_mode: 'Markdown' });
        resetSession(chatId);
      }
      break;
    }

    // ==================== EXPENSE FLOW ====================
    case 'expense_amount': {
      const amount = parseFloat(text.replace(/[^\d.]/g, ''));
      if (!amount || amount <= 0) {
        await bot.sendMessage(chatId, '⚠️ Monto inválido:');
        return true;
      }
      s.context.amount = amount;
      s.state = 'expense_desc';
      await bot.sendMessage(chatId, `💰 ${fmt(amount)}\n\n📝 *¿Descripción del gasto?*`, { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
      break;
    }

    case 'expense_desc': {
      s.context.description = text.trim();
      s.state = 'expense_vendor';
      await bot.sendMessage(chatId, `📝 ${s.context.description}\n\n🏪 *¿Proveedor?* (o "N/A")`, { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
      break;
    }

    case 'expense_vendor': {
      s.context.vendor = text.trim();
      s.state = 'expense_payment';
      await bot.sendMessage(chatId,
        `🏪 ${s.context.vendor}\n` +
        `📝 ${s.context.description}\n` +
        `💰 ${fmt(s.context.amount)}\n\n` +
        `💳 *¿Método de pago?*`,
        { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD }
      );
      break;
    }

    case 'expense_payment': {
      const methodMap = { '💵 Efectivo': 'cash', '📋 CxP': 'credit', '💳 Tarjeta': 'card', '🏦 Transferencia': 'bank' };
      const method = methodMap[text];
      if (!method) {
        await bot.sendMessage(chatId, '⚠️ Selecciona una opción:', { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD });
        return true;
      }
      s.context.paymentMethod = method;
      s.state = null;

      await bot.sendMessage(chatId, '⏳ Registrando gasto...', { parse_mode: 'Markdown' });
      const result = await processExpenseFull(chatId, s.context);

      if (!result.success) {
        await bot.sendMessage(chatId, `❌ Error: ${result.error}`);
        resetSession(chatId);
        return true;
      }

      await bot.sendMessage(chatId, result.message, { parse_mode: 'Markdown' });
      resetSession(chatId);
      break;
    }

    // ==================== REPORT FLOW ====================
    case 'report_type': {
      const reportMap = {
        '📅 Diario': 'daily',
        '📆 Semanal': 'weekly',
        '🗓️ Mensual': 'monthly',
        '🔒 Cierre de Mes': 'cierre'
      };
      const reportKind = reportMap[text];
      if (!reportKind) {
        await bot.sendMessage(chatId, '⚠️ Selecciona una opción:', { parse_mode: 'Markdown', ...REPORT_MENU_KEYBOARD });
        return true;
      }
      s.state = null;
      await bot.sendMessage(chatId, '⏳ Generando reporte...', { parse_mode: 'Markdown' });
      await sendReport(chatId, reportKind);
      resetSession(chatId);
      break;
    }

    default:
      return false;
  }
  return true;
}

// ==================== SALE SUMMARY ====================
async function sendSaleSummary(chatId, context) {
  const items = context.items || [];
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const methodLabels = { cash: '💵 Efectivo', credit: '📋 CxC', card: '💳 Tarjeta', bank: '🏦 Transferencia' };

  let msg = `📄 *FACTURA*\n\n`;
  msg += `👤 Cliente: ${context.client}\n\n`;

  items.forEach(item => {
    msg += `📦 ${item.description} x${item.qty} — ${fmt(item.total)}\n`;
  });

  msg += `\n─────────────\n`;
  msg += `💰 *Total: ${fmt(subtotal)}*\n`;
  msg += `💳 Pago: ${methodLabels[context.paymentMethod] || context.paymentMethod}\n\n`;
  msg += `_¿Confirmas esta factura?_`;

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...CONFIRM_KEYBOARD });
}

// ==================== PROCESS SALE FULL ====================
async function processSaleFull(chatId, context) {
  // 1. Crear/buscar cliente
  let clientId = null;
  const clients = await api('/api/clients', 'GET', null, chatId);
  const existingClient = Array.isArray(clients) ? clients.find(c => c.name === context.client) : null;
  if (existingClient) {
    clientId = existingClient.id;
  } else {
    const newClient = await api('/api/clients', 'POST', { name: context.client }, chatId);
    clientId = newClient.id;
  }

  // 2. Crear invoice con todos los items
  const items = context.items || [];
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);

  const invoiceData = {
    client_id: clientId,
    client_name: context.client,
    items: items.map(item => ({
      product_id: item.product_id || null,
      description: item.description,
      qty: item.qty,
      price: item.price,
      total: item.total
    })),
    subtotal,
    tax: 0,
    total: subtotal,
    date: new Date().toISOString().split('T')[0],
    payment_method: context.paymentMethod,
    status: 'issued'
  };

  const invoice = await api('/api/invoices', 'POST', invoiceData, chatId);

  if (invoice.error) {
    return { success: false, error: invoice.error };
  }

  return {
    success: true,
    invoice,
    message:
      `✅ *FACTURA CREADA*\n\n` +
      `📄 Factura: ${invoice.invoice_number || invoice.id}\n` +
      `👤 Cliente: ${context.client}\n` +
      `💰 Total: ${fmt(subtotal)}\n` +
      `💳 ${getPaymentLabel(context.paymentMethod)}`
  };
}

// ==================== PROCESS EXPENSE FULL ====================
async function processExpenseFull(chatId, context) {
  let vendorId = null;
  if (context.vendor !== 'N/A') {
    const vendors = await api('/api/vendors', 'GET', null, chatId);
    const existingVendor = Array.isArray(vendors) ? vendors.find(v => v.name === context.vendor) : null;
    if (existingVendor) {
      vendorId = existingVendor.id;
    } else {
      const newVendor = await api('/api/vendors', 'POST', { name: context.vendor }, chatId);
      vendorId = newVendor.id;
    }
  }

  const payableData = {
    vendor_id: vendorId,
    vendor_name: context.vendor === 'N/A' ? 'Varios' : context.vendor,
    description: context.description,
    total: context.amount,
    balance: context.amount,
    date: new Date().toISOString().split('T')[0],
    payment_method: context.paymentMethod,
    status: 'approved'
  };

  const payable = await api('/api/payables', 'POST', payableData, chatId);

  if (payable.error) {
    return { success: false, error: payable.error };
  }

  // Journal entry
  const accountMap = { cash: '1101', bank: '1102', credit: '2101', card: '1105' };
  const creditAccount = accountMap[context.paymentMethod] || '1101';

  const accounts = await api('/api/accounts', 'GET', null, chatId);
  let expenseAccount = '6101';
  if (Array.isArray(accounts) && accounts.length > 0) {
    const found = accounts.find(a => a.code?.startsWith('6'));
    if (found) expenseAccount = found.code;
  }

  await api('/api/journal', 'POST', {
    date: new Date().toISOString().split('T')[0],
    description: `Gasto: ${context.description}`,
    entries: [
      { account_code: expenseAccount, debit: context.amount, credit: 0, memo: context.description },
      { account_code: creditAccount, debit: 0, credit: context.amount, memo: context.vendor === 'N/A' ? 'Varios' : context.vendor }
    ],
    reference: payable.id
  }, chatId);

  return {
    success: true,
    payable,
    message:
      `✅ *GASTO REGISTRADO*\n\n` +
      `📝 ${context.description}\n` +
      `🏪 ${context.vendor === 'N/A' ? 'Varios' : context.vendor}\n` +
      `💰 ${fmt(context.amount)}\n` +
      `💳 ${getPaymentLabel(context.paymentMethod)}`
  };
}

function getPaymentLabel(method) {
  const labels = { cash: '💵 Efectivo', credit: '📋 CxC', card: '💳 Tarjeta', bank: '🏦 Transferencia' };
  return labels[method] || method;
}

// ==================== REPORTS ====================
async function sendReport(chatId, kind) {
  const today = new Date().toISOString().split('T')[0];

  if (kind === 'cierre') {
    // Cierre de mes — preview completo
    const cierre = await api(`/api/cierre/preview`, 'GET', null, chatId);

    if (cierre.error) {
      // Fallback: build from individual endpoints
      const [income, balance, receivables, payables, products] = await Promise.all([
        api('/api/income-statement', 'GET', null, chatId),
        api('/api/balance', 'GET', null, chatId),
        api('/api/receivables', 'GET', null, chatId),
        api('/api/payables', 'GET', null, chatId),
        api('/api/products', 'GET', null, chatId)
      ]);

      const totalCXC = Array.isArray(receivables) ? receivables.reduce((s, r) => s + parseFloat(r.balance || 0), 0) : 0;
      const totalCXP = Array.isArray(payables) ? payables.reduce((s, p) => s + parseFloat(p.balance || 0), 0) : 0;
      const netIncome = parseFloat(income.net_income || 0);
      const totalRevenue = parseFloat(income.total_revenue || 0);
      const totalExpenses = parseFloat(income.total_expenses || 0);

      const msg =
        `🔒 *CIERRE DE MES*\n\n` +
        `📊 *Estado de Resultados*\n` +
        `Ingresos: ${fmt(totalRevenue)}\n` +
        `Gastos: ${fmt(totalExpenses)}\n` +
        `*Utilidad Neta: ${fmt(netIncome)}*\n\n` +
        `📋 *Cuentas*\n` +
        `🟢 CxC (te deben): ${fmt(totalCXC)}\n` +
        `🔴 CxP (debes): ${fmt(totalCXP)}\n\n` +
        `📦 *Inventario*\n` +
        `Productos: ${Array.isArray(products) ? products.length : 0}\n` +
        `Valor total: ${fmt(Array.isArray(products) ? products.reduce((s, p) => s + parseFloat(p.stock_current || 0) * parseFloat(p.cost_price || 0), 0) : 0)}`;

      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } else {
      // Use cierre data directly
      const msg =
        `🔒 *CIERRE DE MES*\n\n` +
        `📊 *Estado de Resultados*\n` +
        `Ingresos: ${fmt(cierre.totalRevenue || 0)}\n` +
        `Gastos: ${fmt(cierre.totalExpenses || 0)}\n` +
        `*Utilidad Neta: ${fmt(cierre.netIncome || 0)}*\n\n` +
        `📋 *Cuentas*\n` +
        `🟢 CxC (te deben): ${fmt(cierre.totalCXC || 0)}\n` +
        `🔴 CxP (debes): ${fmt(cierre.totalCXP || 0)}`;

      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Daily / Weekly / Monthly — usar income-statement con filtro de fecha
  let dateFrom = today;
  if (kind === 'weekly') {
    const d = new Date(); d.setDate(d.getDate() - 7);
    dateFrom = d.toISOString().split('T')[0];
  } else if (kind === 'monthly') {
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    dateFrom = d.toISOString().split('T')[0];
  }

  // Get invoices in date range
  const invoices = await api('/api/invoices', 'GET', null, chatId);
  const filteredInvoices = Array.isArray(invoices)
    ? invoices.filter(inv => inv.date >= dateFrom && inv.date <= today)
    : [];

  const totalSales = filteredInvoices.reduce((s, inv) => s + parseFloat(inv.total || 0), 0);
  const invoiceCount = filteredInvoices.length;

  // Get expenses
  const payables = await api('/api/payables', 'GET', null, chatId);
  const filteredPayables = Array.isArray(payables)
    ? payables.filter(p => p.date >= dateFrom && p.date <= today)
    : [];
  const totalExpenses = filteredPayables.reduce((s, p) => s + parseFloat(p.total || 0), 0);

  const labels = { daily: '📅 Diario', weekly: '📆 Semanal', monthly: '🗓️ Mensual' };

  const msg =
    `${labels[kind]} *REPORTE*\n\n` +
    `📅 Período: ${dateFrom} → ${today}\n\n` +
    `🧾 *Facturas:* ${invoiceCount}\n` +
    `💰 Ventas: ${fmt(totalSales)}\n\n` +
    `💸 *Gastos:* ${filteredPayables.length}\n` +
    `💸 Total Gastos: ${fmt(totalExpenses)}\n\n` +
    `*Balance: ${fmt(totalSales - totalExpenses)}*`;

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// ==================== COMMAND HANDLERS ====================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  resetSession(chatId);
  const connected = s.token ? '✅ Conectado a MisCuentas' : '❌ No has iniciado sesión';

  await bot.sendMessage(chatId,
    `🐷 *MisCuentas Bot*\n\n${connected}\n\n` +
    `*Comandos:*\n` +
    `/start - Mensaje inicio\n` +
    `/login - Iniciar sesión\n` +
    `/venta - Registrar venta\n` +
    `/gasto - Registrar gasto\n` +
    `/reporte - Ver reportes\n` +
    `/balance - Balance general\n` +
    `/deudas - CxC y CxP\n` +
    `/productos - Ver productos\n` +
    `/logout - Cerrar sesión`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/login (.+) (.+)/, async (msg, m) => {
  const chatId = msg.chat.id;
  const [username, password] = [m[1], m[2]];
  await bot.sendMessage(chatId, '⏳ Verificando...');
  const r = await axios.post(`${MISCUENTAS_API}/api/auth/login`, { username, password }).catch(() => null);
  if (r?.data?.token) {
    const s = getSession(chatId);
    s.token = r.data.token;
    s.userId = r.data.user?.id;
    await bot.sendMessage(chatId, '✅ *Sesión iniciada*', { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(chatId, '❌ *Credenciales inválidas*', { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  await bot.sendMessage(chatId, '👋 *Sesión cerrada*', { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  await bot.sendMessage(chatId, '📊 Cargando...');
  const [b, i] = await Promise.all([api('/api/balance', 'GET', null, chatId), api('/api/income-statement', 'GET', null, chatId)]);
  if (b.error) { await bot.sendMessage(chatId, `❌ ${b.error}`); return; }
  await bot.sendMessage(chatId,
    `📊 *Balance*\n\n` +
    `🟢 Activos: ${fmt(b.total_assets)}\n` +
    `🔴 Pasivos: ${fmt(b.total_liabilities)}\n` +
    `🔵 Patrimonio: ${fmt(b.equity)}\n\n` +
    `💰 Ingreso Neto: ${fmt(i.net_income)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/deudas/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  await bot.sendMessage(chatId, '📋 Cargando...');
  const [cxc, cxp] = await Promise.all([api('/api/receivables', 'GET', null, chatId), api('/api/payables', 'GET', null, chatId)]);
  const totalCXC = Array.isArray(cxc) ? cxc.reduce((sum, r) => sum + parseFloat(r.balance || 0), 0) : 0;
  const totalCXP = Array.isArray(cxp) ? cxp.reduce((sum, p) => sum + parseFloat(p.balance || 0), 0) : 0;
  await bot.sendMessage(chatId,
    `📋 *Cuentas*\n\n` +
    `🟢 *Te deben:* ${fmt(totalCXC)}\n` +
    `🔴 *Debes:* ${fmt(totalCXP)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/productos/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  const prods = await api('/api/products', 'GET', null, chatId);
  if (!Array.isArray(prods) || prods.length === 0) { await bot.sendMessage(chatId, '📦 Sin productos'); return; }
  let text = '📦 *Productos*\n\n';
  prods.slice(0, 10).forEach(p => { text += `• ${p.name} — Stock: ${p.stock_current || 0}\n`; });
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/reporte/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  s.state = 'report_type';
  await bot.sendMessage(chatId, '📊 *¿Qué reporte quieres?*', { parse_mode: 'Markdown', ...REPORT_MENU_KEYBOARD });
});

// ==================== SALE FLOW START ====================
bot.onText(/\/venta/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  resetSession(chatId);
  s.context.items = [];
  s.state = 'sale_client';
  await bot.sendMessage(chatId, '🧾 *REGISTRAR VENTA*\n\n👤 *¿Nombre del cliente?*', { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
});

// ==================== EXPENSE FLOW START ====================
bot.onText(/\/gasto/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  resetSession(chatId);
  s.state = 'expense_amount';
  await bot.sendMessage(chatId, '💸 *REGISTRAR GASTO*\n\n💰 *¿Monto?* (ej: 500)', { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
});

// ==================== NATURAL LANGUAGE ====================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const s = getSession(chatId);

  if (s.state) {
    const handled = await handleStateMessage(chatId, text);
    if (handled) return;
  }

  if (!s.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*\n/login username password', { parse_mode: 'Markdown' });
    return;
  }

  if (!GROQ_API_KEY) return;

  const prompt = `Interpreta este mensaje. Responde SOLO con JSON:
{
  "intent": "venta|gasto|balance|deudas|reportes|productos|ayuda|desconocido",
  "confidence": 0.0-1.0,
  "response": "respuesta curta"
}
Mensaje: "${text}"
Ejemplos:
- "registra una venta" → {"intent":"venta","confidence":0.95}
- "muestrame el balance" → {"intent":"balance","confidence":0.9}
- "un reporte de ventas" → {"intent":"reportes","confidence":0.85}`;

  const result = await groqChat(prompt);
  if (!result) return;

  switch (result.intent) {
    case 'venta':
      resetSession(chatId);
      s.context.items = [];
      s.state = 'sale_client';
      await bot.sendMessage(chatId, '🧾 *REGISTRAR VENTA*\n\n👤 *¿Nombre del cliente?*', { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
      break;
    case 'gasto':
      resetSession(chatId);
      s.state = 'expense_amount';
      await bot.sendMessage(chatId, '💸 *REGISTRAR GASTO*\n\n💰 *¿Monto?*', { parse_mode: 'Markdown', ...CANCEL_KEYBOARD });
      break;
    case 'reportes':
      s.state = 'report_type';
      await bot.sendMessage(chatId, '📊 *¿Qué reporte quieres?*', { parse_mode: 'Markdown', ...REPORT_MENU_KEYBOARD });
      break;
    case 'balance':
      await bot.sendMessage(chatId, '/balance');
      break;
    case 'deudas':
      await bot.sendMessage(chatId, '/deudas');
      break;
    case 'productos':
      await bot.sendMessage(chatId, '/productos');
      break;
  }
});

// ==================== ERRORS ====================
bot.on('polling_error', e => console.error('Polling:', e.code, e.message));
bot.on('error', e => console.error('Bot error:', e));

console.log('🐷 MisCuentas Bot — Rediseñado');
console.log(`📡 ${MISCUENTAS_API}`);

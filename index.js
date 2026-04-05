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
// userSessions[chatId] = { token, userId, state, context }
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
    const r = await axios({ method, url: `${MISCUENTAS_API}${endpoint}`, data, headers, timeout: 12000 });
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

const CANCEL_KEYBOARD = {
  reply_markup: JSON.stringify({
    keyboard: [[{ text: '❌ Cancelar' }],
    one_time_keyboard: true,
    resize_keybook: true
  })
};

// ==================== STATE MACHINE ====================
// States: null | 'sale_amount' | 'sale_client' | 'sale_payment' | 'expense_amount' | 'expense_vendor' | 'expense_payment'

async function handleStateMessage(chatId, text) {
  const s = getSession(chatId);

  // Cancelar cualquier flujo
  if (text === '❌ Cancelar') {
    resetSession(chatId);
    await bot.sendMessage(chatId, '❌ Operación cancelada.', { parse_mode: 'Markdown' });
    return true;
  }

  switch (s.state) {

    // ==================== VENTA FLOW ====================
    case 'sale_amount': {
      const amount = parseFloat(text.replace(/[^\d.]/g, ''));
      if (!amount || amount <= 0) {
        await bot.sendMessage(chatId, '⚠️ Monto inválido. Ingresa un número positivo:');
        return true;
      }
      s.context.amount = amount;
      s.state = 'sale_client';
      await bot.sendMessage(chatId, `💰 Monto: ${fmt(amount)}\n\n🏪 ¿Nombre del cliente?`, {
        parse_mode: 'Markdown', ...PAYMENT_KEYBOARD
      });
      break;
    }

    case 'sale_client': {
      s.context.client = text.trim();
      s.state = 'sale_payment';
      await bot.sendMessage(chatId,
        `👤 Cliente: ${s.context.client}\n` +
        `💰 Monto: ${fmt(s.context.amount)}\n\n` +
        `💳 ¿Método de pago?`,
        { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD }
      );
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
      s.state = null;

      await bot.sendMessage(chatId, '⏳ Registrando venta...', { parse_mode: 'Markdown' });

      // 1. Crear cliente si no existe
      let clientId = null;
      const clients = await api('/api/clients', 'GET', null, chatId);
      const existingClient = Array.isArray(clients) ? clients.find(c => c.name === s.context.client) : null;
      if (existingClient) {
        clientId = existingClient.id;
      } else {
        const newClient = await api('/api/clients', 'POST', { name: s.context.client }, chatId);
        clientId = newClient.id;
      }

      // 2. Crear invoice
      const invoiceData = {
        client_id: clientId,
        client_name: s.context.client,
        items: [{
          description: `Venta a ${s.context.client}`,
          qty: 1,
          price: s.context.amount,
          total: s.context.amount
        }],
        subtotal: s.context.amount,
        tax: 0,
        total: s.context.amount,
        date: new Date().toISOString().split('T')[0],
        payment_method: method
      };

      const invoice = await api('/api/invoices', 'POST', invoiceData, chatId);

      // 3. Si es CxC, crear receivable
      if (method === 'credit' && clientId) {
        const receivableData = {
          client_id: clientId,
          client_name: s.context.client,
          description: `Factura ${invoice.invoice_number || invoice.id}`,
          total: s.context.amount,
          balance: s.context.amount,
          date: new Date().toISOString().split('T')[0]
        };
        await api('/api/receivables', 'POST', receivableData, chatId);
      }

      await bot.sendMessage(chatId,
        `✅ *VENTA REGISTRADA*\n\n` +
        `🏪 Cliente: ${s.context.client}\n` +
        `💰 Monto: ${fmt(s.context.amount)}\n` +
        `💳 Pago: ${text}\n` +
        `📄 Factura: ${invoice.invoice_number || invoice.id}`,
        { parse_mode: 'Markdown' }
      );

      resetSession(chatId);
      break;
    }

    // ==================== GASTO FLOW ====================
    case 'expense_amount': {
      const amount = parseFloat(text.replace(/[^\d.]/g, ''));
      if (!amount || amount <= 0) {
        await bot.sendMessage(chatId, '⚠️ Monto inválido. Ingresa un número positivo:');
        return true;
      }
      s.context.amount = amount;
      s.state = 'expense_vendor';
      await bot.sendMessage(chatId, `💰 Monto: ${fmt(amount)}\n\n🏪 ¿Nombre del proveedor o gasto?`, {
        parse_mode: 'Markdown', ...PAYMENT_KEYBOARD
      });
      break;
    }

    case 'expense_vendor': {
      s.context.vendor = text.trim();
      s.state = 'expense_payment';
      await bot.sendMessage(chatId,
        `🏪 Proveedor: ${s.context.vendor}\n` +
        `💰 Monto: ${fmt(s.context.amount)}\n\n` +
        `💳 ¿Método de pago?`,
        { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD }
      );
      break;
    }

    case 'expense_payment': {
      const methodMap = { '💵 Efectivo': 'cash', '📋 CxP': 'credit', '💳 Tarjeta': 'card', '🏦 Transferencia': 'bank' };
      const method = methodMap[text];
      if (!method) {
        await bot.sendMessage(chatId, '⚠️ Selecciona una opción del teclado:', { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD });
        return true;
      }
      s.context.paymentMethod = method;
      s.state = null;

      await bot.sendMessage(chatId, '⏳ Registrando gasto...', { parse_mode: 'Markdown' });

      // 1. Crear vendor si no existe
      let vendorId = null;
      const vendors = await api('/api/vendors', 'GET', null, chatId);
      const existingVendor = Array.isArray(vendors) ? vendors.find(v => v.name === s.context.vendor) : null;
      if (existingVendor) {
        vendorId = existingVendor.id;
      } else {
        const newVendor = await api('/api/vendors', 'POST', { name: s.context.vendor }, chatId);
        vendorId = newVendor.id;
      }

      // 2. Crear payable (gasto)
      const payableData = {
        vendor_id: vendorId,
        vendor_name: s.context.vendor,
        description: `Gasto: ${s.context.vendor}`,
        total: s.context.amount,
        balance: s.context.amount,
        date: new Date().toISOString().split('T')[0],
        payment_method: method
      };

      const payable = await api('/api/payables', 'POST', payableData, chatId);

      // 3. Si es CxP, ya está creado — el payable representa la deuda

      await bot.sendMessage(chatId,
        `✅ *GASTO REGISTRADO*\n\n` +
        `🏪 Proveedor: ${s.context.vendor}\n` +
        `💰 Monto: ${fmt(s.context.amount)}\n` +
        `💳 Pago: ${text}\n` +
        `📄 Referencia: ${payable.id || payable.payable_number || 'N/A'}`,
        { parse_mode: 'Markdown' }
      );

      resetSession(chatId);
      break;
    }

    default:
      return false; // No era mensaje de estado
  }
  return true;
}

// ==================== COMMAND HANDLERS ====================

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  resetSession(chatId);
  const connected = s.token ? '✅ Conectado a MisCuentas' : '❌ No has iniciado sesión';

  await bot.sendMessage(chatId,
    `🐷 *MisCuentas Bot*\n\n${connected}\n\n` +
    `*Comandos disponibles:*\n` +
    `/start - Este mensaje\n` +
    `/login - Iniciar sesión\n` +
    `/balance - Ver balance\n` +
    `/deudas - CxC y CxP\n` +
    `/venta - Registrar venta\n` +
    `/gasto - Registrar gasto\n` +
    `/productos - Ver productos\n` +
    `/logout - Cerrar sesión`,
    { parse_mode: 'Markdown' }
  );
});

// /login
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

// /logout
bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  await bot.sendMessage(chatId, '👋 *Sesión cerrada*', { parse_mode: 'Markdown' });
});

// /balance
bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión* /login', { parse_mode: 'Markdown' }); return; }
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

// /deudas
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

// /productos
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

// /venta — iniciaflujo
bot.onText(/\/venta/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  resetSession(chatId);
  s.state = 'sale_amount';
  await bot.sendMessage(chatId,
    `🧾 *REGISTRAR VENTA*\n\n` +
    `¿Cuál es el *monto*? (ej: 1500)`,
    { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD }
  );
});

// /gasto — iniciaflujo
bot.onText(/\/gasto/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s.token) { await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' }); return; }
  resetSession(chatId);
  s.state = 'expense_amount';
  await bot.sendMessage(chatId,
    `💸 *REGISTRAR GASTO*\n\n` +
    `¿Cuál es el *monto*? (ej: 500)`,
    { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD }
  );
});

// ==================== NATURAL LANGUAGE ====================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const s = getSession(chatId);

  // Si está en estado conversacional, procesar ahí
  if (s.state) {
    const handled = await handleStateMessage(chatId, text);
    if (handled) return;
  }

  // Sin sesión — solo permitir ayuda
  if (!s.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión:*\n/login username password', { parse_mode: 'Markdown' });
    return;
  }

  // Detectar intención con Groq
  if (!GROQ_API_KEY) {
    await bot.sendMessage(chatId, 'Usa /venta o /gasto para registrar transacciones.', { parse_mode: 'Markdown' });
    return;
  }

  const prompt = `Interpreta este mensaje de un usuario de contabilidad. Responde SOLO con JSON:

{
  "intent": "venta|gasto|balance|deudas|productos|ayuda|desconocido",
  "confidence": 0.0-1.0,
  "response": "respuesta corta en español"
}

Mensaje: "${text}"

Ejemplos:
- "registra una venta" → {"intent":"venta","confidence":0.95,"response":"Entendido. ¿Cuál es el monto?"}
- "un gasto de luz" → {"intent":"gasto","confidence":0.9,"response":"Perfecto. ¿Cuánto gastaste?"}
- "cuánto me deben" → {"intent":"deudas","confidence":0.9,"response":"Buscando tus cuentas..."}
- "muestrame el balance" → {"intent":"balance","confidence":0.85,"response":"Obteniendo tu balance..."}`;

  const result = await groqChat(prompt);
  if (!result) {
    await bot.sendMessage(chatId, 'Usa /venta o /gasto para registrar transacciones.', { parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, result.response, { parse_mode: 'Markdown' });

  switch (result.intent) {
    case 'venta':
      resetSession(chatId);
      s.state = 'sale_amount';
      await bot.sendMessage(chatId, '¿Cuál es el *monto*?', { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD });
      break;
    case 'gasto':
      resetSession(chatId);
      s.state = 'expense_amount';
      await bot.sendMessage(chatId, '¿Cuál es el *monto*?', { parse_mode: 'Markdown', ...PAYMENT_KEYBOARD });
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

console.log('🐷 MisCuentas Bot — Conversacional');
console.log(`📡 ${MISCUENTAS_API}`);

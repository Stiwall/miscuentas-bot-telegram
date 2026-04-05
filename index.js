const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Configuración
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8660449850:AAG0Tpf6Hjn5OuvHS8VpLnhTB0tGXbdlJhY';
const MISCUENTAS_API = process.env.MISCUENTAS_API || 'https://miscuentas-contable-app-production.up.railway.app';

// Inicializar bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store de sesiones (en memoria - para producción usar Redis/DB)
const userSessions = {};

// Helper: obtener o crear sesión de usuario
function getSession(chatId) {
  if (!userSessions[chatId]) {
    userSessions[chatId] = { token: null, userId: null };
  }
  return userSessions[chatId];
}

// Helper: hacer request a la API de MisCuentas
async function apiRequest(endpoint, method = 'GET', data = null, chatId = null) {
  const session = getSession(chatId);
  const headers = {};
  if (session.token) {
    headers['x-session-token'] = session.token;
  }

  try {
    const response = await axios({
      method,
      url: `${MISCUENTAS_API}${endpoint}`,
      data,
      headers,
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      return { error: error.response.data?.error || 'Error del servidor' };
    }
    return { error: 'No se pudo conectar al servidor' };
  }
}

// Formatear número como moneda RD
function formatMoney(amount) {
  return `RD$ ${parseFloat(amount || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}`;
}

// ==================== COMANDOS ====================

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  let status = session.token ? '✅ Conectado a MisCuentas' : '❌ No has iniciado sesión';

  await bot.sendMessage(chatId, 
    `🐷 *MisCuentas Bot*\n\n` +
    `${status}\n\n` +
    `Comandos disponibles:\n` +
    `/start - Este mensaje\n` +
    `/login - Iniciar sesión\n` +
    `/balance - Ver balance general\n` +
    `/deudas - Cuentas por cobrar/pagar\n` +
    `/venta - Registrar venta\n` +
    `/gasto - Registrar gasto\n` +
    `/logout - Cerrar sesión`,
    { parse_mode: 'Markdown' }
  );
});

// /login
bot.onText(/\/login/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(chatId, 
    '🔐 *Iniciar Sesión*\n\n' +
    'Envía tu username y password así:\n' +
    '/login username password\n\n' +
    'Ejemplo: /login Stickbot s221.3435n',
    { parse_mode: 'Markdown' }
  );
});

// Manejar /login username password
bot.onText(/\/login (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const username = match[1];
  const password = match[2];

  await bot.sendMessage(chatId, '⏳ Verificando credenciales...');

  try {
    const response = await axios.post(`${MISCUENTAS_API}/api/auth/login`, {
      username,
      password
    });

    if (response.data.token) {
      const session = getSession(chatId);
      session.token = response.data.token;
      session.userId = response.data.user?.id;

      await bot.sendMessage(chatId, '✅ *Sesión iniciada correctamente*', { parse_mode: 'Markdown' });
    }
  } catch (error) {
    await bot.sendMessage(chatId, '❌ *Credenciales inválidas*\n\nVerifica tu username y password.', { parse_mode: 'Markdown' });
  }
});

// /logout
bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.token = null;
  session.userId = null;

  await bot.sendMessage(chatId, '👋 *Sesión cerrada*', { parse_mode: 'Markdown' });
});

// /balance
bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *No has iniciado sesión*\n\nUsa /login para conectarte.', { parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, '📊 *Cargando balance...*', { parse_mode: 'Markdown' });

  try {
    const [balance, income, cashflow] = await Promise.all([
      apiRequest('/api/balance', 'GET', null, chatId),
      apiRequest('/api/income-statement', 'GET', null, chatId),
      apiRequest('/api/cashflow', 'GET', null, chatId)
    ]);

    if (balance.error) {
      await bot.sendMessage(chatId, `❌ Error: ${balance.error}`);
      return;
    }

    const assets = parseFloat(balance.total_assets || 0);
    const liabilities = parseFloat(balance.total_liabilities || 0);
    const equity = parseFloat(balance.equity || 0);
    const netIncome = parseFloat(income.net_income || 0);

    let message = '📊 *Balance General*\n\n';
    message += `🟢 Activos: ${formatMoney(assets)}\n`;
    message += `🔴 Pasivos: ${formatMoney(liabilities)}\n`;
    message += `🔵 Patrimonio: ${formatMoney(equity)}\n\n`;
    message += `💰 Ingreso Neto: ${formatMoney(netIncome)}\n`;
    message += `\n_Cashflow: ${formatMoney(cashflow.net || 0)}_`;

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await bot.sendMessage(chatId, '❌ *Error al obtener balance*\n\n' + error.message, { parse_mode: 'Markdown' });
  }
});

// /deudas
bot.onText(/\/deudas/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *No has iniciado sesión*\n\nUsa /login para conectarte.', { parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, '⏳ *Cargando deudas...*', { parse_mode: 'Markdown' });

  try {
    const [receivables, payables] = await Promise.all([
      apiRequest('/api/receivables', 'GET', null, chatId),
      apiRequest('/api/payables', 'GET', null, chatId)
    ]);

    let message = '📋 *Cuentas por Cobrar/Pagar*\n\n';

    // CxC (lo que te deben)
    const totalReceivables = receivables.reduce((sum, r) => sum + parseFloat(r.balance || r.total || 0), 0);
    message += `🟢 *Cuentas por Cobrar:* ${formatMoney(totalReceivables)}\n`;

    if (receivables.length > 0) {
      message += '\n_Top 3 clientes:_\n';
      receivables.slice(0, 3).forEach(r => {
        message += `• ${r.client_name || 'Cliente'}: ${formatMoney(r.balance || r.total || 0)}\n`;
      });
    }

    message += '\n';

    // CxP (lo que debes)
    const totalPayables = payables.reduce((sum, p) => sum + parseFloat(p.balance || p.total || 0), 0);
    message += `🔴 *Cuentas por Pagar:* ${formatMoney(totalPayables)}\n`;

    if (payables.length > 0) {
      message += '\n_Top 3 proveedores:_\n';
      payables.slice(0, 3).forEach(p => {
        message += `• ${p.vendor_name || 'Proveedor'}: ${formatMoney(p.balance || p.total || 0)}\n`;
      });
    }

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await bot.sendMessage(chatId, '❌ *Error al obtener deudas*', { parse_mode: 'Markdown' });
  }
});

// /venta - Registrar venta simple
bot.onText(/\/venta/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *No has iniciado sesión*\n\nUsa /login para conectarte.', { parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, 
    '🧾 *Registrar Venta*\n\n' +
    'Envía los datos así:\n' +
    '/venta descripcion monto\n\n' +
    'Ejemplo: /venta Chicharron 1500',
    { parse_mode: 'Markdown' }
  );
});

// Manejar /venta descripcion monto
bot.onText(/\/venta (.+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const description = match[1];
  const amount = parseFloat(match[2]);

  await bot.sendMessage(chatId, '⏳ *Registrando venta...*', { parse_mode: 'Markdown' });

  // Obtener productos para encontrar uno que coincida
  const products = await apiRequest('/api/products', 'GET', null, chatId);
  const product = products.find(p => p.name.toLowerCase().includes(description.toLowerCase()));

  if (!product) {
    await bot.sendMessage(chatId, '⚠️ *Producto no encontrado*\n\nUsa /productos para ver los disponibles.', { parse_mode: 'Markdown' });
    return;
  }

  // Crear invoice/factura simplificada
  const invoiceData = {
    client_name: 'Cliente Mostrador',
    items: [{
      product_id: product.id,
      description: product.name,
      qty: 1,
      price: amount,
      total: amount
    }],
    subtotal: amount,
    tax: 0,
    total: amount,
    date: new Date().toISOString().split('T')[0],
    payment_method: 'cash'
  };

  const result = await apiRequest('/api/invoices', 'POST', invoiceData, chatId);

  if (result.error) {
    await bot.sendMessage(chatId, `❌ Error: ${result.error}`);
    return;
  }

  await bot.sendMessage(chatId, 
    `✅ *Venta registrada*\n\n` +
    `${product.name}\n` +
    `Monto: ${formatMoney(amount)}\n` +
    `Factura: ${result.invoice_number || result.id}`,
    { parse_mode: 'Markdown' }
  );
});

// /gasto - Registrar gasto simple
bot.onText(/\/gasto/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *No has iniciado sesión*\n\nUsa /login para conectarte.', { parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, 
    '💸 *Registrar Gasto*\n\n' +
    'Envía los datos así:\n' +
    '/gasto descripcion monto\n\n' +
    'Ejemplo: /gasto Compra materiales 500',
    { parse_mode: 'Markdown' }
  );
});

// Manejar /gasto descripcion monto
bot.onText(/\/gasto (.+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const description = match[1];
  const amount = parseFloat(match[2]);

  await bot.sendMessage(chatId, '⏳ *Registrando gasto...*', { parse_mode: 'Markdown' });

  // Crear payable (gasto simple)
  const expenseData = {
    vendor_name: 'Gasto Vario',
    description: description,
    total: amount,
    date: new Date().toISOString().split('T')[0]
  };

  const result = await apiRequest('/api/payables', 'POST', expenseData, chatId);

  if (result.error) {
    await bot.sendMessage(chatId, `❌ Error: ${result.error}`);
    return;
  }

  await bot.sendMessage(chatId, 
    `✅ *Gasto registrado*\n\n` +
    `${description}\n` +
    `Monto: ${formatMoney(amount)}`,
    { parse_mode: 'Markdown' }
  );
});

// /productos - Ver productos
bot.onText(/\/productos/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *No has iniciado sesión*', { parse_mode: 'Markdown' });
    return;
  }

  const products = await apiRequest('/api/products', 'GET', null, chatId);

  if (!products || products.length === 0) {
    await bot.sendMessage(chatId, '📦 *No hay productos*\n\nCrea productos en MisCuentas web.', { parse_mode: 'Markdown' });
    return;
  }

  let message = '📦 *Productos*\n\n';
  products.slice(0, 10).forEach(p => {
    message += `• ${p.name} — Stock: ${p.stock_current || 0}\n`;
  });

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// Manejar mensajes未知
bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  
  if (!session.token) {
    bot.sendMessage(chatId, 'Usa /start para ver comandos disponibles.');
  }
});

// Errores
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

console.log('🐷 MisCuentas Bot iniciado');
console.log(`📡 API: ${MISCUENTAS_API}`);

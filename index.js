const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ==================== CONFIGURACIÓN ====================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // Required
const MISCUENTAS_API = process.env.MISCUENTAS_API || 'https://miscuentas-contable-app-production.up.railway.app';
const GROQ_API_KEY = process.env.GROQ_API_KEY; // Required
const GROQ_MODEL = 'llama-3.1-8b-instant';

// ==================== INICIALIZAR BOT ====================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store de sesiones
const userSessions = {};

function getSession(chatId) {
  if (!userSessions[chatId]) {
    userSessions[chatId] = { token: null, userId: null };
  }
  return userSessions[chatId];
}

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

function formatMoney(amount) {
  return `RD$ ${parseFloat(amount || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 })}`;
}

// ==================== GROQ - LENGUAJE NATURAL ====================
async function processNaturalLanguage(message, chatId) {
  const session = getSession(chatId);

  // Construir contexto con información del usuario
  let contextInfo = '';
  if (session.token) {
    contextInfo = 'El usuario ha iniciado sesión en MisCuentas.';
  } else {
    contextInfo = 'El usuario NO ha iniciado sesión - debe usar /login primero.';
  }

  const prompt = `Eres un asistente que interpreta comandos de contabilidad en lenguaje natural.

Información del usuario: ${contextInfo}

Mensaje del usuario: "${message}"

Debes identificar la INTENCIÓN y extraer los DATOS relevantes.

Responde SOLO con JSON en este formato exacto (sin texto adicional):
{
  "intent": "venta|gasto|consulta_balance|consulta_deudas|consulta_productos|ayuda|desconocido",
  "confidence": 0.0-1.0,
  "data": {
    "descripcion": "descripción del producto/gasto",
    "monto": numero_sin_formato,
    "tipo": "opcional: tipo de consulta (cxc|cxp|balance|income)"
  },
  "response": "Respuesta curta en español para el usuario"
}

Ejemplos:
- "registra una venta de 500 pesos de chicharrón" → {"intent": "venta", "confidence": 0.95, "data": {"descripcion": "chicharrón", "monto": 500}, "response": "Entendido. Registrando venta de Chicharrón por RD$500..."}
- "cuánto me deben" → {"intent": "consulta_deudas", "confidence": 0.9, "data": {"tipo": "cxc"}, "response": "Buscando cuánto te deben..."}
- "registra un gasto de luz de 2000" → {"intent": "gasto", "confidence": 0.95, "data": {"descripcion": "luz", "monto": 2000}, "response": "Entendido. Registrando gasto de Luz por RD$2000..."}
- "muestrame el balance" → {"intent": "consulta_balance", "confidence": 0.85, "data": {}, "response": "Obteniendo tu balance..."}
- "hola qué tal" → {"intent": "ayuda", "confidence": 1.0, "data": {}, "response": "¡Hola! Soy tu asistente de MisCuentas. Puedo ayudarte con ventas, gastos, consultas de balance y más. Usa /start para ver comandos."}
- "qué productos tengo" → {"intent": "consulta_productos", "confidence": 0.9, "data": {}, "response": "Buscando tus productos..."}
`;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const result = response.data.choices[0]?.message?.content?.trim();
    
    if (!result) {
      return { intent: 'desconocido', confidence: 0, data: {}, response: 'No pude entender tu mensaje. Prueba con /start para ver los comandos disponibles.' };
    }

    // Parsear JSON de la respuesta
    try {
      const parsed = JSON.parse(result);
      return parsed;
    } catch (parseError) {
      // Si no es JSON válido, devolver como texto plano
      return { intent: 'desconocido', confidence: 0, data: {}, response: result };
    }
  } catch (error) {
    console.error('Groq error:', error.response?.data || error.message);
    return { 
      intent: 'desconocido', 
      confidence: 0, 
      data: {}, 
      response: 'Error conectando al servicio de IA. Usa los comandos directos como /venta, /gasto, /balance.' 
    };
  }
}

// ==================== PROCESAR LENGUAJE NATURAL ====================
async function handleNaturalLanguage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Ignorar comandos directos
  if (text.startsWith('/')) return;

  await bot.sendMessage(chatId, '🤖 Procesando...');

  const result = await processNaturalLanguage(text, chatId);

  switch (result.intent) {
    case 'venta':
      await handleVentaNLP(chatId, result.data);
      break;
    case 'gasto':
      await handleGastoNLP(chatId, result.data);
      break;
    case 'consulta_balance':
      await bot.sendMessage(chatId, result.response);
      await sendBalance(chatId);
      break;
    case 'consulta_deudas':
      await bot.sendMessage(chatId, result.response);
      await sendDeudas(chatId);
      break;
    case 'consulta_productos':
      await bot.sendMessage(chatId, result.response);
      await sendProductos(chatId);
      break;
    case 'ayuda':
      await bot.sendMessage(chatId, result.response);
      break;
    default:
      await bot.sendMessage(chatId, result.response);
  }
}

// ==================== HANDLERS NLP ====================
async function handleVentaNLP(chatId, data) {
  const session = getSession(chatId);
  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*\nUsa /login username password', { parse_mode: 'Markdown' });
    return;
  }

  const monto = data.monto;
  const descripcion = data.descripcion || 'Producto';

  // Buscar producto
  const products = await apiRequest('/api/products', 'GET', null, chatId);
  const product = products?.find(p => 
    p.name.toLowerCase().includes(descripcion.toLowerCase())
  );

  if (!product) {
    // Crear venta sin producto específico
    const invoiceData = {
      client_name: 'Cliente Mostrador',
      items: [{
        description: descripcion,
        qty: 1,
        price: monto,
        total: monto
      }],
      subtotal: monto,
      tax: 0,
      total: monto,
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
      `${descripcion}\n` +
      `Monto: ${formatMoney(monto)}\n` +
      `Factura: ${result.invoice_number || result.id}`,
      { parse_mode: 'Markdown' }
    );
  } else {
    const invoiceData = {
      client_name: 'Cliente Mostrador',
      items: [{
        product_id: product.id,
        description: product.name,
        qty: 1,
        price: monto,
        total: monto
      }],
      subtotal: monto,
      tax: 0,
      total: monto,
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
      `Monto: ${formatMoney(monto)}`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function handleGastoNLP(chatId, data) {
  const session = getSession(chatId);
  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*\nUsa /login username password', { parse_mode: 'Markdown' });
    return;
  }

  const monto = data.monto;
  const descripcion = data.descripcion || 'Gasto vario';

  // Buscar si existe una cuenta de gasto que coincida
  const accounts = await apiRequest('/api/accounts', 'GET', null, chatId);
  const expenseAccount = accounts?.find(a => 
    a.name.toLowerCase().includes(descripcion.toLowerCase()) ||
    a.code.includes(descripcion.substring(0, 3))
  );

  // Crear payable (gasto)
  const payableData = {
    vendor_name: 'Gasto Vario',
    description: descripcion,
    total: monto,
    date: new Date().toISOString().split('T')[0]
  };

  const result = await apiRequest('/api/payables', 'POST', payableData, chatId);

  if (result.error) {
    await bot.sendMessage(chatId, `❌ Error: ${result.error}`);
    return;
  }

  await bot.sendMessage(chatId, 
    `✅ *Gasto registrado*\n\n` +
    `${descripcion}\n` +
    `Monto: ${formatMoney(monto)}`,
    { parse_mode: 'Markdown' }
  );
}

// ==================== HELPERS ====================
async function sendBalance(chatId) {
  try {
    const [balance, income] = await Promise.all([
      apiRequest('/api/balance', 'GET', null, chatId),
      apiRequest('/api/income-statement', 'GET', null, chatId)
    ]);

    if (balance.error) {
      await bot.sendMessage(chatId, `❌ ${balance.error}`);
      return;
    }

    const assets = parseFloat(balance.total_assets || 0);
    const liabilities = parseFloat(balance.total_liabilities || 0);
    const equity = parseFloat(balance.equity || 0);
    const netIncome = parseFloat(income.net_income || 0);

    let message = '📊 *Balance*\n\n';
    message += `🟢 Activos: ${formatMoney(assets)}\n`;
    message += `🔴 Pasivos: ${formatMoney(liabilities)}\n`;
    message += `🔵 Patrimonio: ${formatMoney(equity)}\n\n`;
    message += `💰 Ingreso Neto: ${formatMoney(netIncome)}`;

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await bot.sendMessage(chatId, '❌ Error al obtener balance');
  }
}

async function sendDeudas(chatId) {
  try {
    const [receivables, payables] = await Promise.all([
      apiRequest('/api/receivables', 'GET', null, chatId),
      apiRequest('/api/payables', 'GET', null, chatId)
    ]);

    const totalCXC = receivables?.reduce((sum, r) => sum + parseFloat(r.balance || r.total || 0), 0) || 0;
    const totalCXP = payables?.reduce((sum, p) => sum + parseFloat(p.balance || p.total || 0), 0) || 0;

    let message = '📋 *Cuentas*\n\n';
    message += `🟢 *Te deben:* ${formatMoney(totalCXC)}\n`;
    message += `🔴 *Debes:* ${formatMoney(totalCXP)}\n\n`;

    if (totalCXC > 0) {
      message += `_Top clientes:_\n`;
      receivables.slice(0, 3).forEach(r => {
        message += `• ${r.client_name || 'Cliente'}: ${formatMoney(r.balance || r.total || 0)}\n`;
      });
    }

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await bot.sendMessage(chatId, '❌ Error al obtener deudas');
  }
}

async function sendProductos(chatId) {
  const products = await apiRequest('/api/products', 'GET', null, chatId);

  if (!products || products.length === 0) {
    await bot.sendMessage(chatId, '📦 *No hay productos*', { parse_mode: 'Markdown' });
    return;
  }

  let message = '📦 *Productos*\n\n';
  products.slice(0, 10).forEach(p => {
    message += `• ${p.name} — Stock: ${p.stock_current || 0}\n`;
  });

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// ==================== COMANDOS ====================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const status = session.token ? '✅ Conectado' : '❌ No has iniciado sesión';

  await bot.sendMessage(chatId,
    `🐷 *MisCuentas Bot*\n\n` +
    `${status}\n\n` +
    `*Comandos:*\n` +
    `/start - Este mensaje\n` +
    `/login - Iniciar sesión\n` +
    `/balance - Ver balance\n` +
    `/deudas - CxC y CxP\n` +
    `/venta - Registrar venta\n` +
    `/gasto - Registrar gasto\n` +
    `/productos - Ver productos\n` +
    `/logout - Cerrar sesión\n\n` +
    `*Lenguaje natural:*\n` +
    `También puedes escribir en自然的语言 como:\n` +
    `"registra una venta de 500 pesos de chicharrón"\n` +
    `"cuánto me deben"\n` +
    `"registra un gasto de luz de 2000"`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/login (.+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const username = match[1];
  const password = match[2];

  await bot.sendMessage(chatId, '⏳ Verificando...');

  try {
    const response = await axios.post(`${MISCUENTAS_API}/api/auth/login`, { username, password });

    if (response.data.token) {
      const session = getSession(chatId);
      session.token = response.data.token;
      session.userId = response.data.user?.id;

      await bot.sendMessage(chatId, '✅ *Sesión iniciada*', { parse_mode: 'Markdown' });
    }
  } catch (error) {
    await bot.sendMessage(chatId, '❌ *Credenciales inválidas*', { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.token = null;
  session.userId = null;
  await bot.sendMessage(chatId, '👋 *Sesión cerrada*', { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' });
    return;
  }
  await bot.sendMessage(chatId, '📊 *Cargando balance...*', { parse_mode: 'Markdown' });
  await sendBalance(chatId);
});

bot.onText(/\/deudas/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' });
    return;
  }
  await bot.sendMessage(chatId, '📋 *Cargando deudas...*', { parse_mode: 'Markdown' });
  await sendDeudas(chatId);
});

bot.onText(/\/productos/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' });
    return;
  }
  await bot.sendMessage(chatId, '📦 *Cargando productos...*', { parse_mode: 'Markdown' });
  await sendProductos(chatId);
});

bot.onText(/\/venta (.+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const desc = match[1];
  const monto = parseFloat(match[2]);
  const session = getSession(chatId);

  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, '🧾 *Registrando venta...*', { parse_mode: 'Markdown' });

  const products = await apiRequest('/api/products', 'GET', null, chatId);
  const product = products?.find(p => p.name.toLowerCase().includes(desc.toLowerCase()));

  const invoiceData = {
    client_name: 'Cliente Mostrador',
    items: [{
      ...(product && { product_id: product.id }),
      description: product ? product.name : desc,
      qty: 1,
      price: monto,
      total: monto
    }],
    subtotal: monto,
    tax: 0,
    total: monto,
    date: new Date().toISOString().split('T')[0],
    payment_method: 'cash'
  };

  const result = await apiRequest('/api/invoices', 'POST', invoiceData, chatId);

  if (result.error) {
    await bot.sendMessage(chatId, `❌ ${result.error}`);
    return;
  }

  await bot.sendMessage(chatId, 
    `✅ *Venta registrada*\n\n${product?.name || desc}\nMonto: ${formatMoney(monto)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/gasto (.+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const desc = match[1];
  const monto = parseFloat(match[2]);
  const session = getSession(chatId);

  if (!session.token) {
    await bot.sendMessage(chatId, '❌ *Primero inicia sesión*', { parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, '💸 *Registrando gasto...*', { parse_mode: 'Markdown' });

  const payableData = {
    vendor_name: 'Gasto Vario',
    description: desc,
    total: monto,
    date: new Date().toISOString().split('T')[0]
  };

  const result = await apiRequest('/api/payables', 'POST', payableData, chatId);

  if (result.error) {
    await bot.sendMessage(chatId, `❌ ${result.error}`);
    return;
  }

  await bot.sendMessage(chatId, 
    `✅ *Gasto registrado*\n\n${desc}\nMonto: ${formatMoney(monto)}`,
    { parse_mode: 'Markdown' }
  );
});

// ==================== MENSAJES EN LENGUAJE NATURAL ====================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  
  // Si no ha iniciado sesión, solo procesar mensajes de login o mostrar ayuda
  if (!session.token) {
    const result = await processNaturalLanguage(msg.text, chatId);
    if (result.intent === 'ayuda') {
      await bot.sendMessage(chatId, result.response);
    } else {
      await bot.sendMessage(chatId, '❌ *Primero inicia sesión*\n\nUsa: /login username password', { parse_mode: 'Markdown' });
    }
    return;
  }
  
  // Procesar lenguaje natural
  await handleNaturalLanguage(msg);
});

// ==================== ERRORES ====================
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// ==================== INICIO ====================
console.log('🐷 MisCuentas Bot con NLP iniciado');
console.log(`📡 API: ${MISCUENTAS_API}`);
console.log(`🧠 Groq Model: ${GROQ_MODEL}`);

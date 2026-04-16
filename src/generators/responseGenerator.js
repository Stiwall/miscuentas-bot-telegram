/**
 * Generador de respuestas naturales y conversacionales
 */

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fmt(amount) {
  return 'RD$' + parseFloat(amount || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 });
}

// ---- SALUDOS ----
function greeting(name) {
  const h = new Date().getHours();
  const base = h < 12
    ? pick(['Buenos días', 'Buen día', '¡Buenos días!'])
    : h < 18
    ? pick(['Buenas tardes', 'Hola, buenas tardes'])
    : pick(['Buenas noches', 'Buenas 🌙']);
  return name ? `${base}, ${name}` : base;
}

// ---- INICIO ----
function startMessage(isLoggedIn) {
  if (isLoggedIn) {
    return pick([
      '¡Hola! ¿En qué te ayudo?\n\n/venta /gasto /cobrar /reporte\n/balance /deudas /productos',
      '¡Aquí estoy! ¿Qué necesitas?\n\n/venta /gasto /cobrar /reporte\n/balance /deudas /productos',
      'Listo para trabajar 💪\n\n/venta /gasto /cobrar /reporte\n/balance /deudas /productos'
    ]);
  }
  return pick([
    '¡Hola! Soy el bot de MisCuentas 🐷\n\nPara empezar usa /login con tu usuario y contraseña.',
    '¡Bienvenido! Soy tu asistente de MisCuentas 🐷\n\nInicia sesión con /login usuario contraseña',
  ]);
}

// ---- LOGIN ----
function loginSuccess(planName, trialDaysLeft) {
  const trial = trialDaysLeft ? `\n⏳ Trial: ${trialDaysLeft} días restantes` : '';
  return pick([
    `✅ ¡Bienvenido! Plan: ${planName}${trial}`,
    `🔓 Sesión iniciada. Plan: ${planName}${trial}`,
    `¡Listo! Ya entraste. Plan: ${planName}${trial}`,
  ]);
}

function loginFail() {
  return pick([
    '❌ Usuario o contraseña incorrectos. ¿Los revisas?',
    '❌ No pude entrar. Verifica tu usuario y contraseña.',
    '❌ Credenciales inválidas. Intenta de nuevo.',
  ]);
}

function loginRequired() {
  return pick([
    '🔐 Necesitas iniciar sesión primero. Usa /login',
    '❌ Primero haz /login para entrar.',
    '⚠️ No estás conectado. Usa /login usuario contraseña',
  ]);
}

function logoutMessage() {
  return pick([
    '👋 ¡Hasta luego! Sesión cerrada.',
    '🔒 Listo, cerraste sesión. ¡Cuídate!',
    '👋 Sesión terminada. ¡Hasta pronto!',
  ]);
}

// ---- VENTAS ----
function askSaleClient() {
  return pick([
    '🧾 Vamos a registrar la venta.\n\n¿A quién le vendiste?',
    '💰 ¡Otra venta! ¿De quién es el cliente?',
    '🛒 Registrando venta... ¿nombre del cliente?',
  ]);
}

function askSaleProduct(products) {
  if (!products || products.length === 0) {
    return pick([
      '📦 ¿Qué vendiste? Escribe el nombre del producto.',
      '📝 ¿Cuál fue el producto?',
    ]);
  }
  let msg = pick(['📦 ¿Qué vendiste?', '🛒 ¿Cuál producto?', '📋 ¿Qué le diste?']) + '\n\n';
  products.slice(0, 15).forEach((p, i) => { msg += `${i + 1}. ${p.name}\n`; });
  msg += '\n_O escribe el nombre_';
  return msg;
}

function askQty(productName) {
  return pick([
    `📦 *${productName}*\n\n¿Cuántas unidades?`,
    `*${productName}* — ¿Qué cantidad?`,
    `¿Cuántos *${productName}* vendiste?`,
  ]);
}

function addMoreItems() {
  return pick([
    '✅ Agregado. ¿Vendiste algo más?',
    '👍 Anotado. ¿Otro producto?',
    '✔️ Listo. ¿Más cosas?',
  ]);
}

function saleConfirmed(invoiceNumber, clientName, amount, paymentLabel) {
  const reaction = parseFloat(amount) > 5000
    ? pick(['🎉 ¡Buena venta!', '💪 ¡Excelente!', '🚀 ¡Así se hace!'])
    : pick(['✅ Registrado.', '👍 Listo.', '💾 Guardado.']);
  return `${reaction}\n\n📄 ${invoiceNumber}\n👤 ${clientName}\n💰 ${fmt(amount)}\n💳 ${paymentLabel}`;
}

function saleCancelled() {
  return pick(['❌ Venta cancelada.', '🚫 Cancelado, sin problema.', '↩️ Venta descartada.']);
}

// ---- GASTOS ----
function askExpenseAmount() {
  return pick([
    '💸 Registrando gasto... ¿cuánto fue?',
    '💰 ¿Cuál fue el monto del gasto?',
    '📝 ¿De cuánto es el gasto?',
  ]);
}

function askExpenseDesc(amount) {
  return pick([
    `💰 ${fmt(amount)}\n\n📝 ¿En qué fue ese gasto?`,
    `${fmt(amount)} — ¿Descripción del gasto?`,
    `OK, ${fmt(amount)}. ¿Qué fue?`,
  ]);
}

function askExpenseVendor(desc) {
  return pick([
    `📝 ${desc}\n\n🏪 ¿Proveedor? (o escribe "N/A")`,
    `"${desc}" — ¿A quién le pagaste? (N/A si no aplica)`,
  ]);
}

function expenseConfirmed(amount, desc) {
  const reaction = parseFloat(amount) > 5000
    ? pick(['😬 Gasto grande.', '📊 Registrado.'])
    : pick(['✅ Gasto anotado.', '💾 Guardado.', '👍 Listo.']);
  return `${reaction}\n\n💸 ${fmt(amount)}\n📝 ${desc}`;
}

// ---- COBROS ----
function askCobrarClient() {
  return pick([
    '💰 ¿A qué cliente vas a cobrar?',
    '👤 ¿Nombre del cliente que va a pagar?',
    '💵 ¿De quién es el pago?',
  ]);
}

function cobrarRegistered(clientName, amount) {
  return pick([
    `✅ Pago registrado.\n\n👤 ${clientName}\n💰 ${fmt(amount)}`,
    `💰 Cobro anotado.\n\n👤 ${clientName} — ${fmt(amount)}`,
    `👍 Listo. ${clientName} pagó ${fmt(amount)}`,
  ]);
}

// ---- BALANCE ----
function balanceMessage(assets, liabilities, equity, netIncome) {
  const income = parseFloat(netIncome) || 0;
  const insight = income > 0
    ? pick(['📈 Vas en positivo.', '💪 Buena utilidad.', '👍 En verde.'])
    : income < 0
    ? pick(['⚠️ Utilidad negativa, ojo.', '📉 Hay pérdida este período.'])
    : '⚖️ En punto de equilibrio.';

  return `📊 *Balance general*\n\n🟢 Activos: ${fmt(assets)}\n🔴 Pasivos: ${fmt(liabilities)}\n🔵 Patrimonio: ${fmt(equity)}\n\n💰 Ingreso neto: ${fmt(netIncome)}\n\n${insight}`;
}

// ---- DEUDAS ----
function deudasMessage(totalCXC, totalCXP) {
  const cxc = parseFloat(totalCXC) || 0;
  const cxp = parseFloat(totalCXP) || 0;
  let insight = '';

  if (cxc > cxp) insight = pick(['📈 Te deben más de lo que debes. Bien.', '👍 Estás en posición positiva.']);
  else if (cxp > cxc) insight = pick(['⚠️ Debes más de lo que te deben.', '📊 Ojo con las cuentas por pagar.']);
  else insight = '⚖️ Equilibrado.';

  return `📋 *Cuentas pendientes*\n\n🟢 Te deben: ${fmt(cxc)}\n🔴 Debes: ${fmt(cxp)}\n\n${insight}`;
}

// ---- PRODUCTOS ----
function productosMessage(prods) {
  if (!prods || !prods.length) return pick(['📦 No tienes productos registrados.', '🗃️ Sin productos aún.']);
  const lowStock = prods.filter(p => {
    const cur = parseFloat(p.stock_current) || 0;
    const min = parseFloat(p.stock_minimum) || 0;
    return min > 0 && cur <= min;
  });
  let txt = '📦 *Productos*\n\n';
  prods.slice(0, 10).forEach(p => { txt += `• ${p.name} — Stock: ${p.stock_current || 0}\n`; });
  if (lowStock.length) txt += `\n⚠️ ${lowStock.length} producto(s) con stock bajo`;
  return txt;
}

// ---- ERRORES / CANCELACIONES ----
function cancelled() {
  return pick(['↩️ Cancelado.', '🚫 Ok, cancelado.', '❌ Listo, descartado.']);
}

function accessDenied(planName) {
  return `🔒 Tu plan *${planName}* no incluye esto.\n\n👉 miscuentas-contable.app/upgrade`;
}

function notUnderstood() {
  return pick([
    '🤔 No entendí bien. Prueba con /venta, /gasto, /cobrar o /reporte',
    '❓ ¿Qué necesitas? Puedo ayudarte con /venta /gasto /cobrar /reporte',
    '💬 No capté. Intenta decirme qué quieres hacer o usa un comando.',
  ]);
}

function networkError() {
  return pick([
    '⚠️ Hubo un problema de conexión. Intenta de nuevo.',
    '🌐 Error temporal. ¿Vuelves a intentar?',
    '📡 Algo falló. Intenta en un momento.',
  ]);
}

// ---- LOADING ----
function loading() {
  return pick(['⏳', '🔄', '⏳ Un momento...']);
}

module.exports = {
  greeting, startMessage,
  loginSuccess, loginFail, loginRequired, logoutMessage,
  askSaleClient, askSaleProduct, askQty, addMoreItems, saleConfirmed, saleCancelled,
  askExpenseAmount, askExpenseDesc, askExpenseVendor, expenseConfirmed,
  askCobrarClient, cobrarRegistered,
  balanceMessage, deudasMessage, productosMessage,
  cancelled, accessDenied, notUnderstood, networkError, loading
};

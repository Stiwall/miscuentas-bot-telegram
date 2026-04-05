# 🐷 MisCuentas Bot Telegram

Bot de Telegram para gestionar tu contabilidad desde el móvil con **lenguaje natural** (Groq Llama).

## Comandos

- `/start` - Mensaje de inicio
- `/login username password` - Iniciar sesión
- `/balance` - Ver balance general
- `/deudas` - Cuentas por cobrar/pagar
- `/venta descripcion monto` - Registrar venta
- `/gasto descripcion monto` - Registrar gasto
- `/productos` - Ver productos
- `/logout` - Cerrar sesión

## 💬 Lenguaje Natural

También puedes escribir naturalmente:

```
"registra una venta de 500 pesos de chicharrón"
"cuánto me deben"
"registra un gasto de luz de 2000"
"muestrame el balance"
"qué productos tengo"
```

## Setup

```bash
npm install
```

## Variables de Entorno (requeridas)

```env
TELEGRAM_TOKEN=tu_token_del_bot
GROQ_API_KEY=tu_api_key_de_groq
MISCUENTAS_API=https://miscuentas-contable-app-production.up.railway.app
```

## Deploy en Railway

1. Conecta tu GitHub repo a Railway
2. Agrega las variables:
   - `TELEGRAM_TOKEN`
   - `GROQ_API_KEY`
   - `MISCUENTAS_API`
3. Deploy automático

## Uso Local

```bash
export TELEGRAM_TOKEN=tu_token
export GROQ_API_KEY=tu_key
export MISCUENTAS_API=https://miscuentas-contable-app-production.up.railway.app
npm start
```

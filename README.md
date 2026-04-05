# 🐷 MisCuentas Bot Telegram

Bot de Telegram para gestionar tu contabilidad desde el móvil.

## Comandos

- `/start` - Mensaje de inicio
- `/login` - Iniciar sesión
- `/balance` - Ver balance general
- `/deudas` - Cuentas por cobrar/pagar
- `/venta` - Registrar venta rápida
- `/gasto` - Registrar gasto
- `/productos` - Ver productos
- `/logout` - Cerrar sesión

## Setup

```bash
npm install
```

## Variables de Entorno

```env
TELEGRAM_TOKEN=tu_token_del_bot
MISCUENTAS_API=https://miscuentas-contable-app-production.up.railway.app
```

## Deploy en Railway

1. Conecta tu GitHub repo a Railway
2. Agrega la variable `TELEGRAM_TOKEN`
3. Deploy automático

## Uso Local

```bash
TELEGRAM_TOKEN=tu_token npm start
```

## Ejemplos

```
/login Stickbot tu_password
/balance
/venta Chicharron 1500
/gasto Compra materiales 500
```

# DexterAI Extended — Live Mode

Modo en vivo con OpenBB Platform integrado, WebSocket streaming, alertas BUY/SELL y trading manual con confirmación.

## Quick start

```powershell
npm install
copy .env.example .env       # edita lo que necesites (o deja todo vacío para modo lectura)
npm run live
```

`npm run live` ejecuta `start_live.ps1`, que:

1. Crea un venv en `openbb_worker/.venv` si no existe
2. Instala el SDK de OpenBB (~3-5 min la primera vez)
3. Arranca **OpenBB Platform API** en `http://127.0.0.1:6900`
4. Arranca **Node + WebSocket** en `http://localhost:3005`
5. Abre tu browser por default

`Ctrl+C` cierra ambos procesos.

---

## Qué cambió respecto al modo clásico

| Antes (npm start) | Ahora (npm run live) |
|---|---|
| 13 símbolos hardcodeados | Cualquier ticker buscable via OpenBB (50k+) |
| Alertas en SQLite, mudas | Toast + sonido + Windows native + Telegram |
| Refresco F5 | Ticks vía WebSocket cada 5s (autoajustable) |
| Indicadores sueltos | Decisión consolidada BUY/SELL/HOLD con score |
| Sin órdenes | Modal de confirmación → Alpaca paper/live |
| 1 fuente (Yahoo) | OpenBB + Yahoo (fallback) — FRED, SEC, CFTC gratis |

---

## Variables de entorno relevantes

Ver `.env.example`. Las claves:

- **`TRADING_MODE`** — `disabled` (default, seguro), `paper`, `live`. Si está disabled, el botón "Ejecutar orden" aparece bloqueado.
- **`ALPACA_API_KEY` / `ALPACA_SECRET_KEY`** — solo necesarias si `TRADING_MODE != disabled`. Obtener en https://alpaca.markets/
- **`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`** — Si están seteadas, cada alerta y señal se mandan también a Telegram. Sin ellas, todo sigue funcionando vía WebSocket.
- **`FRED_API_KEY`** — Opcional, gratis. Habilita data macroeconómica vía OpenBB.

---

## Verificación end-to-end

1. **OpenBB up:** `curl http://127.0.0.1:6900/api/v1/equity/search?query=NVDA&provider=yfinance`
2. **Cliente Node:** `curl http://localhost:3005/api/openbb/search?q=tesla`
3. **WebSocket en vivo:** abrir `http://localhost:3005`, ver el `LIVE` ticker arriba con precios cambiando.
4. **Universe libre:** escribir "MSFT" en el buscador (header derecha) → click en el resultado → aparece en watchlist + ticker + se suscribe al WS.
5. **Alert push:** después de unos minutos, las alertas técnicas (RSI/MACD/BB) llegan como toast al panel derecho. Si `TELEGRAM_*` están seteadas, también al móvil.
6. **Signal card:** cuando el motor de señales detecta convergencia BUY/SELL, aparece la tarjeta sobre el chart con razones, stop loss y take profit.
7. **Modal de orden (paper):**
   - Setea `TRADING_MODE=paper` + ALPACA credentials.
   - Reinicia (`npm run live`).
   - Click "Ejecutar orden" → modal aparece → checkbox "Entiendo..." → "Confirmar".
   - Verifica en `/api/orders/positions` que la posición existe.
8. **Modo disabled (default):** el botón "Ejecutar orden" aparece deshabilitado con tooltip.

---

## Arquitectura

```
Browser :3005
  ├── REST  → /api/openbb/*, /api/watchlist, /api/orders/*, /api/signals
  └── WS    → /ws  (ticks + alertas + señales push)

Node Express :3005
  ├── routes/openbb.js     ──┐
  ├── routes/watchlist.js     │
  ├── routes/orders.js        ├── usa lib/openbbClient, broker, db
  ├── routes/signals.js       │
  ├── lib/liveStream.js  (WebSocket + cron de ticks/señales)
  ├── lib/signalEngine.js (fusión BUY/SELL/HOLD)
  ├── lib/notifier.js   (fan-out WS / Telegram / native)
  └── lib/broker.js     (Alpaca paper/live)

OpenBB Platform API :6900
  └── python openbb_worker/start.py
      providers: yfinance, sec, cftc, fred (con key opcional)
```

---

## Seguridad

- `TRADING_MODE=disabled` es el default. Ningún path automático puede enviar una orden — solo `POST /api/orders/confirm` con `confirmed:true`, y este endpoint solo lo invoca el modal después del clic humano.
- El modal exige checkbox "Entiendo que es dinero real" antes de habilitar el botón Confirmar.
- Cada orden enviada se persiste en SQLite (tabla `ordenes`) con timestamp y `signal_id` origen.
- OpenBB corre en loopback (`127.0.0.1`) — no es accesible desde la red.
- Telegram es opt-in: sin tokens, simplemente no se intenta enviar.

---

## Troubleshooting

- **"OpenBB aún cargando" al arrancar:** la primera carga del SDK toma 60-120s. Revisa `openbb_worker/openbb.log`.
- **`/api/openbb/search` falla:** asegúrate que el worker esté arriba (`curl http://127.0.0.1:6900/api/v1/equity/search?query=AAPL`). Sin él, el sistema cae automáticamente a `yfinance` directo, pero el buscador no funciona.
- **Telegram no llega:** verifica que ya hablaste con tu bot al menos una vez (sino, `chat_id` no recibe). Test rápido:
  ```powershell
  curl "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/sendMessage?chat_id=$env:TELEGRAM_CHAT_ID&text=test"
  ```
- **Windows native notification no aparece:** la primera vez el browser pide permiso. Si rechazaste por accidente, ve a chrome://settings/content/notifications.
- **WebSocket no conecta:** verifica que estás en `http://localhost:3005` (no `127.0.0.1` ni IP) y que tu antivirus/firewall no esté bloqueando puerto 3005.

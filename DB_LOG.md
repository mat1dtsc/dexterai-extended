# DB_LOG.md — Base de Datos Time-Series v3.0

## Resumen

Se migró el sistema de persistencia SQLite a un esquema time-series robusto, portable a PostgreSQL, con pipeline de actualización automática cada 5 minutos.

## Archivos creados/modificados

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `lib/db_v2.js` | **Creado** | Módulo de persistencia time-series con batch inserts, queries por rango, limpieza automática |
| `lib/sync.js` | **Creado** | Pipeline de sincronización: tick, OHLCV, fundamentales, métricas |
| `cron/sync_pipeline.js` | **Creado** | Cron job standalone que corre el pipeline completo cada 5 min |
| `routes/quote.js` | **Modificado** | `/api/quote` ahora lee DB primero (cache 5 min), luego Yahoo |
| `test_db.js` | **Creado** | 19 tests que cubren inserts, lecturas, pipeline y compatibilidad legado |

## Esquema de tablas

### `precios_tick`
Precios tick-level cada 5 minutos. Cache primario para quotes.
- `symbol`, `price`, `change`, `change_pct`, `volume`, `market_state`, `source`, `ts`
- Índice: `(symbol, ts DESC)`

### `historico_ohlcv`
Velas históricas (1d, 1h, etc). Soporta múltiples intervalos.
- `symbol`, `timestamp`, `open`, `high`, `low`, `close`, `volume`, `interval`, `source`
- Índice: `(symbol, timestamp DESC, interval)`
- Unique: `(symbol, timestamp, interval)`

### `fundamentales_snapshot`
Snapshot diario de datos fundamentales por símbolo.
- `symbol`, `pe`, `forward_pe`, `eps`, `market_cap`, `dividend_yield`, `beta`, etc.
- Índice: `(symbol, ts DESC)`

### `metricas_diarias`
Métricas técnicas calculadas con `lib/indicators.js`.
- `symbol`, `sma_20/50/200`, `rsi_14`, `macd`, `macd_signal`, `bb_upper/lower`, `atr_14`, `stoch_k/d`, `entry_score`
- Índice: `(symbol, ts DESC)`

### `alertas_historial`
Registro histórico de alertas generadas.
- `symbol`, `tipo`, `mensaje`, `nivel`, `score`, `rsi_14`, `macd`, `price`, `ts`
- Índice: `(symbol, ts DESC)`

### `update_log`
Log de todas las operaciones de sync para trazabilidad.
- `type`, `symbol`, `records_inserted`, `duration_ms`, `error`, `ts`
- Índice: `(type, ts DESC)`

## API db_v2.js

### Inserts (batch, más rápido que uno por uno)
- `insertTickBatch(records)` — records = array de {symbol, price, change, change_pct, volume, market_state, source, ts}
- `insertOhlcvBatch(symbol, ohlcv, interval, source)` — ohlcv = array de {timestamp, open, high, low, close, volume}
- `insertFundamentalsBatch(records)` — records = array de snapshots
- `insertMetricsBatch(records)` — records = array de métricas calculadas
- `insertAlertasBatch(records)` — records = array de alertas
- `logUpdate(type, symbol, recordsInserted, durationMs, error)` — trazabilidad

### Lecturas
- `getLastTick(symbol)` — último precio guardado
- `getTicksRange(symbol, fromTs, toTs)` — rango de ticks
- `getOhlcvRange(symbol, fromTs, toTs, interval)` — rango de velas
- `getLastOhlcv(symbol, interval)` — última vela
- `getLastFundamentals(symbol)` — último snapshot fundamental
- `getLastMetrics(symbol)` — últimas métricas calculadas
- `getLastAlert(symbol)` — última alerta
- `getLastUpdate(type, symbol)` — última operación de sync
- `hasOhlcvToday(symbol, interval)` — ¿hay datos de hoy?
- `getSymbolsWithData(table)` — símbolos con datos en una tabla
- `countRecords(table, symbol)` — conteo de registros
- `getDbStats()` — estadísticas de todas las tablas

### Limpieza
- `cleanupOldData(table, days)` — borra datos más viejos de X días
- `cleanupAll(days)` — limpia todas las tablas

### Compatibilidad legado (db.js)
- `guardarAlerta`, `obtenerAlertas`, `guardarOptimizacion`, `obtenerOptimizaciones`
- `guardarCapmMetrics`, `obtenerCapm`, `guardarPrecioCache`, `obtenerPrecioCache`

## Pipeline sync.js

### Funciones
- `syncTick(symbols)` — quotes actuales, guarda en `precios_tick`
- `syncOhlcv(symbols, period, interval)` — histórico, guarda en `historico_ohlcv`
- `syncFundamentals(symbols)` — fundamentales, guarda en `fundamentales_snapshot`
- `syncMetrics(symbols)` — calcula indicadores, guarda en `metricas_diarias`
- `syncAll(symbols)` — corre todo el pipeline en secuencia
- `syncSmart(symbols)` — solo actualiza lo que falta (tick si >5min, OHLCV si no hay hoy)

## Cron job

```bash
node cron/sync_pipeline.js
```

Hace:
1. Sync tick para todos los símbolos (en batches de 5, con sleep 1s)
2. Sync OHLCV solo para símbolos sin datos de hoy (batches de 5, sleep 1.5s)
3. Calcula métricas para todos
4. Limpieza automática de datos >90 días

## Endpoint modificado

`GET /api/quote?symbol=NDX`
- Primero busca en `precios_tick` (último dato <5min)
- Si es fresco, lo devuelve con `cached: true`
- Si es viejo o no existe, va a Yahoo, guarda en DB, devuelve

## Tests

```bash
node test_db.js
```

19 tests que cubren:
- Inicialización de tablas
- Batch inserts (tick, OHLCV, fundamentales, métricas, alertas)
- Lecturas por rango y último dato
- Pipeline syncTick, syncOhlcv, syncMetrics (con Yahoo real)
- Limpieza de datos
- Compatibilidad con API legado

## Próximos pasos

- [ ] Agregar `syncFundamentals` al cron job (actualmente solo en `syncAll`)
- [ ] Configurar `node-cron` o `systemd timer` para ejecutar cada 5 min
- [ ] Migrar `lib/db.js` completamente a `lib/db_v2.js` en todo el proyecto
- [ ] PostgreSQL: el esquema es portable, solo cambiar driver sqlite3→pg
- [ ] Partitioning: en PostgreSQL usar `PARTITION BY RANGE (ts)`
- [ ] Backfill: script para poblar histórico de los últimos 2 años

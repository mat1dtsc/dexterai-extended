'use strict';
/**
 * test_db.js — Tests de la base de datos time-series v3
 * Uso: node test_db.js
 */
var db = require('./lib/db_v2');
var sync = require('./lib/sync');
var indicators = require('./lib/indicators');

var TEST_SYMBOLS = ['NDX', 'AAPL', 'BTC-USD'];
var PASSED = 0;
var FAILED = 0;

function assert(cond, msg) {
  if (cond) { PASSED++; console.log('  ✓', msg); }
  else { FAILED++; console.error('  ✗', msg); }
}

function section(title) {
  console.log('\n[TEST]', title);
}

// ─── 1. Init ─────────────────────────────────────────────────────────────────
section('1. Inicialización de base de datos');
db.initDb();
console.log('  Base inicializada en', process.env.VERCEL ? '/tmp/dexter.db' : './data/dexter.db');

// ─── 2. Insert tick batch ──────────────────────────────────────────────────────
section('2. Insert batch: precios_tick');
var tickRecords = [
  { symbol: 'TEST', price: 15000, change: 100, change_pct: 0.67, volume: 5000000, market_state: 'REGULAR', source: 'test', ts: Math.floor(Date.now()/1000) },
  { symbol: 'TEST2', price: 200, change: -2, change_pct: -0.99, volume: 1000000, market_state: 'REGULAR', source: 'test', ts: Math.floor(Date.now()/1000) }
];
db.insertTickBatch(tickRecords).then(function(r) {
  assert(r.inserted === 2, 'Insertó 2 ticks');

  // 3. Lectura último tick
  section('3. Lectura: getLastTick');
  return db.getLastTick('TEST');
}).then(function(row) {
  assert(row !== null, 'getLastTick devuelve row');
  assert(row.symbol === 'TEST', 'Símbolo correcto');
  assert(row.price === 15000, 'Precio correcto');

  // 4. Range query
  section('4. Lectura: getTicksRange');
  var now = Math.floor(Date.now()/1000);
  return db.getTicksRange('TEST', now - 3600, now);
}).then(function(rows) {
  assert(rows.length >= 1, 'Range devuelve al menos 1 row');

  // 5. Insert OHLCV batch
  section('5. Insert batch: OHLCV');
  var ohlcv = [
    { timestamp: Math.floor(Date.now()/1000) - 86400*3, open: 100, high: 105, low: 98, close: 102, volume: 1000000 },
    { timestamp: Math.floor(Date.now()/1000) - 86400*2, open: 102, high: 108, low: 101, close: 107, volume: 1200000 },
    { timestamp: Math.floor(Date.now()/1000) - 86400*1, open: 107, high: 110, low: 106, close: 109, volume: 900000 }
  ];
  return db.insertOhlcvBatch('TEST', ohlcv, '1d', 'test');
}).then(function(r) {
  assert(r.inserted === 3, 'Insertó 3 candles');

  // 6. Lectura OHLCV
  section('6. Lectura: getOhlcvRange');
  var now = Math.floor(Date.now()/1000);
  return db.getOhlcvRange('TEST', now - 86400*5, now, '1d');
}).then(function(rows) {
  assert(rows.length >= 3, 'OHLCV range devuelve >=3 rows');

  // 7. Insert fundamentales
  section('7. Insert batch: fundamentales');
  return db.insertFundamentalsBatch([{
    symbol: 'TEST', pe: 25.5, forward_pe: 22.1, eps: 4.2,
    market_cap: 2500000000000, dividend_yield: 0.015, beta: 1.1,
    fifty_two_week_high: 180, fifty_two_week_low: 120,
    revenue_growth: 0.08, profit_margins: 0.22,
    debt_to_equity: 0.45, total_debt: 100000000000, total_cash: 200000000000,
    sector: 'Technology', industry: 'Software',
    ts: Math.floor(Date.now()/1000)
  }]);
}).then(function(r) {
  assert(r.inserted === 1, 'Insertó 1 fundamental');

  // 8. Lectura fundamentales
  section('8. Lectura: getLastFundamentals');
  return db.getLastFundamentals('TEST');
}).then(function(row) {
  assert(row !== null, 'Fundamental encontrado');
  assert(row.beta === 1.1, 'Beta correcto');

  // 9. Insert métricas
  section('9. Insert batch: métricas');
  return db.insertMetricsBatch([{
    symbol: 'TEST', sma_20: 105, sma_50: 100, sma_200: 95,
    rsi_14: 55, macd: 1.2, macd_signal: 0.8,
    bb_upper: 115, bb_lower: 95, atr_14: 3.5,
    stoch_k: 60, stoch_d: 58, entry_score: 72,
    ts: Math.floor(Date.now()/1000)
  }]);
}).then(function(r) {
  assert(r.inserted === 1, 'Insertó 1 métrica');

  // 10. Lectura métricas
  section('10. Lectura: getLastMetrics');
  return db.getLastMetrics('TEST');
}).then(function(row) {
  assert(row !== null, 'Métrica encontrada');
  assert(row.entry_score === 72, 'Entry score correcto');

  // 11. Insert alertas
  section('11. Insert batch: alertas');
  return db.insertAlertasBatch([{
    symbol: 'TEST', tipo: 'COMPRA', mensaje: 'RSI en sobreventa',
    nivel: 'info', score: 85, rsi_14: 28, macd: -0.5, price: 95,
    ts: Math.floor(Date.now()/1000)
  }]);
}).then(function(r) {
  assert(r.inserted === 1, 'Insertó 1 alerta');

  // 12. Update log
  section('12. Log de actualización');
  return db.logUpdate('test', 'TEST', 5, 123, null);
}).then(function(r) {
  assert(r.id > 0, 'Log insertado con id');

  // 13. Count records
  section('13. Count records');
  return db.countRecords('precios_tick', 'TEST');
}).then(function(count) {
  assert(count >= 1, 'Count precios_tick >= 1 (' + count + ')');
  return db.countRecords('historico_ohlcv', 'TEST');
}).then(function(count) {
  assert(count >= 3, 'Count historico_ohlcv >= 3 (' + count + ')');

  // 14. Stats
  section('14. DB Stats');
  return db.getDbStats();
}).then(function(stats) {
  assert(stats.precios_tick >= 2, 'Stats precios_tick >= 2');
  assert(stats.historico_ohlcv >= 3, 'Stats historico_ohlcv >= 3');

  // 15. Pipeline syncTick (Yahoo real, opcional)
  section('15. Pipeline syncTick (Yahoo)');
  return sync.syncTick(['NDX']);
}).then(function(result) {
  assert(result.ok >= 0, 'syncTick completó (ok=' + result.ok + ', inserted=' + result.inserted + ')');
  console.log('  syncTick result:', JSON.stringify(result));

  // 16. Pipeline syncOhlcv (Yahoo real)
  section('16. Pipeline syncOhlcv (Yahoo)');
  return sync.syncOhlcv(['NDX'], '5d', '1d');
}).then(function(result) {
  assert(result.ok >= 0, 'syncOhlcv completó (ok=' + result.ok + ', inserted=' + result.inserted + ')');
  console.log('  syncOhlcv result:', JSON.stringify(result));

  // 17. Pipeline syncMetrics
  section('17. Pipeline syncMetrics (Yahoo)');
  return sync.syncMetrics(['NDX']);
}).then(function(result) {
  assert(result.ok >= 0, 'syncMetrics completó (ok=' + result.ok + ', inserted=' + result.inserted + ')');
  console.log('  syncMetrics result:', JSON.stringify(result));

  // 18. Limpieza
  section('18. Limpieza de datos de test');
  return db.cleanupOldData('precios_tick', 0); // borrar todo viejo (0 días = borra todo)
}).then(function(r) {
  // 19. Verificar que db_v2 tiene funciones legado
  section('19. Compatibilidad legado');
  return db.guardarAlerta('LEGACY', 'test', 'mensaje', 50, 40, 0.5, 100);
}).then(function(r) {
  assert(r.inserted === 1, 'guardarAlerta legado funciona');
  return db.obtenerAlertas('LEGACY', 1);
}).then(function(rows) {
  assert(rows.length >= 1, 'obtenerAlertas legado funciona');

  // Resumen
  console.log('\n====================================');
  console.log('RESULTADOS: ' + PASSED + ' pasados, ' + FAILED + ' fallidos');
  console.log('====================================');
  process.exit(FAILED > 0 ? 1 : 0);
}).catch(function(err) {
  console.error('\n[TEST] ERROR FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});

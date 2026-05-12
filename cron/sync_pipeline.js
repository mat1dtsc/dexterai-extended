'use strict';
/**
 * cron/sync_pipeline.js — Pipeline de actualización automática cada 5 minutos
 * Uso: node cron/sync_pipeline.js
 */
var path = require('path');
require(path.join(__dirname, '..', 'lib', 'db_v2.js')).initDb();

var sync = require('../lib/sync');
var db = require('../lib/db_v2');
var marketData = require('../lib/marketData');

var SYMBOLS = marketData.DEFAULT_SYMBOLS || [
  'NDX', 'GSPC', 'DJI', 'GC=F', 'CL=F', 'BTC-USD', 'ETH-USD', 'EURUSD=X'
];

var BATCH_SIZE = 5; // Yahoo rate limit friendly

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function run() {
  console.log('\n[PIPELINE] ====== Inicio ' + new Date().toISOString() + ' ======');
  console.log('[PIPELINE] Símbolos:', SYMBOLS.join(', '));

  var start = Date.now();

  // Paso 1: syncTick en batches (para no saturar Yahoo)
  var tickPromises = [];
  for (var i = 0; i < SYMBOLS.length; i += BATCH_SIZE) {
    var batch = SYMBOLS.slice(i, i + BATCH_SIZE);
    tickPromises.push(
      sync.syncTick(batch).then(function(r) {
        console.log('[PIPELINE] Tick batch: ok=' + r.ok + ' inserted=' + r.inserted + ' failed=' + r.failed);
        return sleep(1000); // 1s entre batches
      })
    );
  }

  Promise.all(tickPromises).then(function() {
    console.log('[PIPELINE] Ticks completados');

    // Paso 2: OHLCV solo para símbolos que no tengan datos de hoy
    var ohlcvPromises = [];
    return Promise.all(SYMBOLS.map(function(sym) {
      return db.hasOhlcvToday(sym, '1d').then(function(has) {
        return { symbol: sym, has: has };
      });
    })).then(function(statuses) {
      var needOhlcv = statuses.filter(function(s) { return !s.has; }).map(function(s) { return s.symbol; });
      console.log('[PIPELINE] OHLCV necesita:', needOhlcv.length > 0 ? needOhlcv.join(', ') : 'ninguno');

      for (var i = 0; i < needOhlcv.length; i += BATCH_SIZE) {
        var batch = needOhlcv.slice(i, i + BATCH_SIZE);
        ohlcvPromises.push(
          sync.syncOhlcv(batch, '1y', '1d').then(function(r) {
            console.log('[PIPELINE] OHLCV batch: ok=' + r.ok + ' inserted=' + r.inserted + ' failed=' + r.failed);
            return sleep(1500); // 1.5s entre batches
          })
        );
      }
      return Promise.all(ohlcvPromises);
    });
  }).then(function() {
    console.log('[PIPELINE] OHLCV completados');

    // Paso 3: Métricas para todos los símbolos
    return sync.syncMetrics(SYMBOLS);
  }).then(function(metricsResult) {
    console.log('[PIPELINE] Métricas: ok=' + metricsResult.ok + ' inserted=' + metricsResult.inserted);

    // Paso 4: Limpieza automática (datos más viejos de 90 días)
    return db.cleanupAll(90);
  }).then(function(cleanupResult) {
    console.log('[PIPELINE] Limpieza:', JSON.stringify(cleanupResult.map(function(c) {
      return c.table + ':' + c.deleted;
    })));

    var duration = Date.now() - start;
    console.log('[PIPELINE] ====== Fin ' + duration + 'ms ======\n');

    // Si se corre como script standalone, salir
    if (require.main === module) {
      process.exit(0);
    }
  }).catch(function(err) {
    console.error('[PIPELINE] ERROR:', err.message);
    db.logUpdate('pipeline', null, 0, Date.now() - start, err.message);
    if (require.main === module) {
      process.exit(1);
    }
  });
}

// Si se ejecuta directamente
if (require.main === module) {
  db.initDb();
  run();
}

module.exports = { run: run };

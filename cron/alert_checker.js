'use strict';
/**
 * cron/alert_checker.js — Verificación de alertas cada 5 minutos
 * Ejecutar con: node cron/alert_checker.js
 */
var data = require('../lib/marketData');
var ind = require('../lib/indicators');
var alerts = require('../lib/alerts');
var db = require('../lib/db');

var FALLBACK_SYMBOLS = [
  'NDX', 'GSPC', 'DJI', 'GC=F', 'CL=F',
  'BZ=F', 'BTC-USD', 'ETH-USD', 'EURUSD=X', 'USDCLP=X'
];

function resolveSymbols() {
  if (process.env.ALERT_SYMBOLS) {
    return Promise.resolve(process.env.ALERT_SYMBOLS.split(','));
  }
  return db.simbolosDeWatchlistsActivas().then(function(syms) {
    return syms && syms.length ? syms : FALLBACK_SYMBOLS;
  }).catch(function() { return FALLBACK_SYMBOLS; });
}

function checkAlerts() {
  return resolveSymbols().then(function(symbols) {
    console.log('[ALERTS] Iniciando revisión de', symbols.length, 'activos -', new Date().toISOString());
    return _runChecks(symbols);
  });
}

function _runChecks(symbols) {

  var promises = [];
  for (var i = 0; i < symbols.length; i++) {
    (function(sym) {
      promises.push(
        data.getHistorical(sym, '1y', '1d').then(function(parsed) {
          if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 50) return null;
          // Filtrar velas corruptas (igual que en routes/analysis.js)
          var ohlcv = parsed.ohlcv.filter(function(v) {
            return ind.isValidNumber(v.close) && ind.isValidNumber(v.high) && ind.isValidNumber(v.low);
          });
          if (ohlcv.length < 50) return null; // no suficientes después de filtrar
          var n = ohlcv.length;
          var closes = ohlcv.map(function(c) { return c.close; });
          var highs = ohlcv.map(function(c) { return c.high; });
          var lows = ohlcv.map(function(c) { return c.low; });

          var rsiS = ind.calcRSISeries(closes, 14);
          var macdD = ind.calcMACDSeries(closes);
          var bbD = ind.calcBBSeries(closes, 20, 2);
          var ma50s = ind.calcSMASeries(closes, 50);
          var swLows = ind.findSwingLows(lows.slice(-80), 4);
          var price = closes[n - 1];
          var supports = swLows.filter(function(s) { return s < price; }).slice(0, 5);

          var entry = ind.calcEntryScore({
            rsi14: rsiS[n - 1], price: price, ma50: ma50s[n - 1], ma200: null,
            macd: macdD.macd[n - 1], macdSig: macdD.signal[n - 1],
            bbUp: bbD.upper[n - 1], bbLow: bbD.lower[n - 1], supports: supports
          });

          var datosAlerta = {
            price: price,
            score: entry.score,
            rsi14: rsiS[n - 1],
            prevRsi: rsiS[n - 2],
            macd: macdD.macd[n - 1],
            macdSig: macdD.signal[n - 1],
            prevMacd: macdD.macd[n - 2],
            prevMacdSig: macdD.signal[n - 2],
            bbLow: bbD.lower[n - 1],
            bbUp: bbD.upper[n - 1],
            changePct: (price - closes[n - 2]) / closes[n - 2] * 100
          };

          return alerts.verificarAlertas(sym, datosAlerta);
        }).catch(function(err) {
          console.error('[ALERTS] Error en', sym, ':', err.message);
          return null;
        })
      );
    })(symbols[i]);
  }

  return Promise.all(promises).then(function(results) {
    var totalAlertas = results.reduce(function(sum, r) { return sum + (r && r.total || 0); }, 0);
    var conAlertas = results.filter(function(r) { return r && r.total > 0; });
    console.log('[ALERTS] Revisión completa:', totalAlertas, 'alertas en', conAlertas.length, 'activos');
    for (var i = 0; i < conAlertas.length; i++) {
      var a = conAlertas[i];
      console.log('  [', a.symbol, ']', a.alertas.map(function(al) { return al.tipo + ':' + al.mensaje; }).join(' | '));
    }
    console.log('[ALERTS] Finalizado -', new Date().toISOString());
    return { total: totalAlertas, symbolsAlerted: conAlertas.length };
  }).catch(function(err) {
    console.error('[ALERTS] Error general:', err.message);
  });
}

// Ejecutar inmediatamente si se corre directamente
if (require.main === module) {
  checkAlerts();
}

module.exports = { checkAlerts: checkAlerts };

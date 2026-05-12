'use strict';
/**
 * routes/alerts.js — Configuración y verificación de alertas
 */
var express = require('express');
var router = express.Router();
var data = require('../lib/marketData');
var ind = require('../lib/indicators');
var alerts = require('../lib/alerts');
var db = require('../lib/db');

var DEFAULT_SYMBOLS = ['NDX', 'GSPC', 'GC=F', 'CL=F', 'BTC-USD', 'ETH-USD'];

// GET /api/alerts/check — Verificar alertas manualmente para símbolos
router.get('/check', function(req, res) {
  var symbols = req.query.symbols ? req.query.symbols.split(',') : DEFAULT_SYMBOLS;
  var promises = [];

  for (var i = 0; i < symbols.length; i++) {
    (function(sym) {
      promises.push(
        data.getHistorical(sym, '1y', '1d').then(function(parsed) {
          if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 50) return null;
        var ohlcv = parsed.ohlcv;
        var n = ohlcv.length;
        var closes = ohlcv.map(function(c) { return c.close; });
        var highs = ohlcv.map(function(c) { return c.high; });
        var lows = ohlcv.map(function(c) { return c.low; });

        var rsiS = ind.calcRSISeries(closes, 14);
        var macdD = ind.calcMACDSeries(closes);
        var bbD = ind.calcBBSeries(closes, 20, 2);

        var price = closes[n-1];
        var changePct = (price - closes[n-2]) / closes[n-2] * 100;
        var rsi14 = rsiS[n-1];
        var prevRsi = rsiS[n-2];
        var macdC = macdD.macd[n-1];
        var macdSigC = macdD.signal[n-1];
        var prevMacd = macdD.macd[n-2];
        var prevMacdSig = macdD.signal[n-2];
        var bbUpC = bbD.upper[n-1];
        var bbLowC = bbD.lower[n-1];
        var ma50s = ind.calcSMASeries(closes, 50);
        var swLows = ind.findSwingLows(lows.slice(-80), 4);
        var supports = swLows.filter(function(s) { return s < price; }).slice(0, 5);

        var entry = ind.calcEntryScore({
          rsi14: rsi14, price: price, ma50: ma50s[n-1], ma200: null,
          macd: macdC, macdSig: macdSigC, bbUp: bbUpC, bbLow: bbLowC, supports: supports
        });

        var datosAlerta = {
          price: price,
          score: entry.score,
          rsi14: rsi14,
          prevRsi: prevRsi,
          macd: macdC,
          macdSig: macdSigC,
          prevMacd: prevMacd,
          prevMacdSig: prevMacdSig,
          bbLow: bbLowC,
          bbUp: bbUpC,
          changePct: changePct
        };

          return alerts.verificarAlertas(sym, datosAlerta);
        }).catch(function(err) {
          return { symbol: sym, alertas: [], total: 0, error: err.message };
        })
      );
    })(symbols[i]);
  }

  Promise.all(promises).then(function(results) {
    var conAlertas = results.filter(function(r) { return r.total > 0; });
    res.json({
      revisados: symbols.length,
      conAlertas: conAlertas.length,
      resultados: results
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/alerts/history — Ver historial de alertas
router.get('/history', function(req, res) {
  var symbol = req.query.symbol;
  var limite = req.query.limit || 50;
  db.obtenerAlertas(symbol, limite).then(function(rows) {
    res.json({ historial: rows });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;

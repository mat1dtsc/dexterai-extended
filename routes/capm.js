'use strict';
/**
 * routes/capm.js — Endpoints CAPM, Betas, Alpha de Jensen (v3: yahoo-finance2)
 */
var express = require('express');
var router = express.Router();
var data = require('../lib/marketData');
var capm = require('../lib/capm');
var db = require('../lib/db');

// Activos por defecto para análisis
var DEFAULT_SYMBOLS = ['NDX', 'GSPC', 'GC=F', 'CL=F', 'BTC-USD', 'ETH-USD'];

// GET /api/capm/betas — Calcular 5 betas para activos
router.get('/betas', function(req, res) {
  var symbols = req.query.symbols ? req.query.symbols.split(',') : DEFAULT_SYMBOLS;
  var benchmark = req.query.benchmark || '^GSPC'; // S&P 500 como default
  var rf = req.query.rf !== undefined ? parseFloat(req.query.rf) : 0.02 / 252;

  var promises = [];
  for (var i = 0; i < symbols.length; i++) {
    (function(sym) {
      promises.push(
        data.getHistorical(sym, '1y', '1d').then(function(parsed) {
          if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 30) return null;
          return {
            symbol: sym,
            closes: parsed.ohlcv.map(function(c) { return c.close; })
          };
        }).catch(function() { return null; })
      );
    })(symbols[i]);
  }

  // Fetch benchmark
  promises.push(
    data.getHistorical(benchmark, '1y', '1d').then(function(parsed) {
      if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 30) return null;
      return {
        symbol: benchmark,
        closes: parsed.ohlcv.map(function(c) { return c.close; })
      };
    }).catch(function() { return null; })
  );

  Promise.all(promises).then(function(results) {
    var benchmarkData = results.pop();
    var activos = results.filter(function(r) { return r !== null && r.closes.length >= 30; });

    if (!benchmarkData || benchmarkData.closes.length < 30) {
      return res.status(400).json({ error: 'Benchmark sin datos suficientes', benchmark: benchmark });
    }
    if (activos.length === 0) {
      return res.status(400).json({ error: 'Sin activos con datos suficientes' });
    }

    var resultados = capm.calcularCapmMultiple(activos, benchmarkData.closes, rf);

    // Guardar en DB
    for (var i = 0; i < resultados.length; i++) {
      var r = resultados[i];
      if (!r.error) {
        db.guardarCapmMetrics(
          r.symbol, r.cincoBetas, rf, r.rm, r.ri, r.sigma, r.trackingError, r.ventanaDias
        ).catch(function() {});
      }
    }

    res.json({
      benchmark: benchmark,
      rf: rf,
      rfAnual: rf * 252,
      resultados: resultados
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/capm/history — Historial de betas por símbolo
router.get('/history', function(req, res) {
  var symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
  db.obtenerCapm(symbol, req.query.limit || 10).then(function(rows) {
    res.json({ symbol: symbol, historial: rows });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/capm/compare — Comparar Sharpe, Treynor, Alpha entre activos
router.get('/compare', function(req, res) {
  var symbols = req.query.symbols ? req.query.symbols.split(',') : DEFAULT_SYMBOLS;
  var benchmark = req.query.benchmark || '^GSPC';
  var rf = req.query.rf !== undefined ? parseFloat(req.query.rf) : 0.02 / 252;

  var promises = [];
  for (var i = 0; i < symbols.length; i++) {
    (function(sym) {
      promises.push(
        data.getHistorical(sym, '1y', '1d').then(function(parsed) {
          if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 30) return null;
          return { symbol: sym, closes: parsed.ohlcv.map(function(c) { return c.close; }) };
        }).catch(function() { return null; })
      );
    })(symbols[i]);
  }
  promises.push(
    data.getHistorical(benchmark, '1y', '1d').then(function(parsed) {
      if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 30) return null;
      return { symbol: benchmark, closes: parsed.ohlcv.map(function(c) { return c.close; }) };
    }).catch(function() { return null; })
  );

  Promise.all(promises).then(function(results) {
    var benchmarkData = results.pop();
    var activos = results.filter(function(r) { return r !== null; });

    if (!benchmarkData) return res.status(400).json({ error: 'Benchmark sin datos' });

    var resultados = capm.calcularCapmMultiple(activos, benchmarkData.closes, rf);

    // Tabla comparativa resumida
    var comparativa = resultados.map(function(r) {
      if (r.error) return { symbol: r.symbol, error: r.error };
      return {
        symbol: r.symbol,
        betaMercado: r.betaMercado,
        alphaJensen: r.alphaJensen,
        sharpe: r.sharpe,
        treynor: r.treynor,
        informationRatio: r.informationRatio,
        rendimientoLog: r.ri,
        sigma: r.sigma,
        r2: r.r2,
        cincoBetas: r.cincoBetas
      };
    });

    // Ranking por Sharpe
    var rankingSharpe = comparativa
      .filter(function(c) { return !c.error; })
      .sort(function(a, b) { return b.sharpe - a.sharpe; });

    // Ranking por Alpha
    var rankingAlpha = comparativa
      .filter(function(c) { return !c.error; })
      .sort(function(a, b) { return b.alphaJensen - a.alphaJensen; });

    res.json({
      benchmark: benchmark,
      comparativa: comparativa,
      rankingSharpe: rankingSharpe,
      rankingAlpha: rankingAlpha
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;

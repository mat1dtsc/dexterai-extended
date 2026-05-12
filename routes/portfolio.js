'use strict';
/**
 * routes/portfolio.js — Endpoints Markowitz
 */
var express = require('express');
var router = express.Router();
var data = require('../lib/marketData');
var portfolio = require('../lib/portfolio');
var db = require('../lib/db');

// POST /api/portfolio/optimize — Optimización Markowitz
router.post('/optimize', function(req, res) {
  var symbols = req.body.symbols || ['GSPC', 'NDX', 'GC=F', 'CL=F'];
  var nSim = req.body.simulaciones || 10000;
  var rf = req.body.rf !== undefined ? req.body.rf : 0.02 / 252;

  var promises = [];
  for (var i = 0; i < symbols.length; i++) {
    (function(sym) {
      promises.push(
        data.getHistorical(sym, '1y', '1d').then(function(parsed) {
          if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 30) {
            return null;
          }
          return {
            symbol: sym,
            closes: parsed.ohlcv.map(function(c) { return c.close; })
          };
        }).catch(function() { return null; })
      );
    })(symbols[i]);
  }

  Promise.all(promises).then(function(results) {
    var activos = results.filter(function(r) { return r !== null && r.closes.length >= 30; });
    if (activos.length < 2) {
      return res.status(400).json({ error: 'Se necesitan al menos 2 activos con datos', activos: activos.length });
    }

    var opt = portfolio.optimizarMarkowitz(activos, nSim, rf);

    // Guardar en DB
    db.guardarOptimizacion(
      opt.symbols,
      opt.maximoSharpe.pesos,
      opt.maximoSharpe.rendimientoAnual,
      opt.maximoSharpe.riesgoAnual,
      opt.maximoSharpe.sharpeAnual,
      'max_sharpe',
      opt.minLen
    ).catch(function() {});

    // Formato que espera el frontend
    var optimo = {
      pesos: {},
      rendimientoAnual: opt.maximoSharpe.rendimientoAnual,
      riesgoAnual: opt.maximoSharpe.riesgoAnual,
      sharpe: opt.maximoSharpe.sharpeAnual
    };
    for (var i = 0; i < opt.symbols.length; i++) {
      optimo.pesos[opt.symbols[i]] = opt.maximoSharpe.pesos[i];
    }

    res.json({
      symbols: opt.symbols,
      nSimulaciones: opt.nSimulaciones,
      minLen: opt.minLen,
      optimo: optimo,
      minimaVarianza: opt.minimaVarianza,
      frontera: opt.fronteraEficiente.slice(0, 50),
      covarianza: opt.covarianza,
      rendimientosMediosDiarios: opt.rendimientosMediosDiarios
    });

  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/portfolio/history — Historial de optimizaciones
router.get('/history', function(req, res) {
  db.obtenerOptimizaciones(req.query.limit || 20).then(function(rows) {
    res.json({ optimizaciones: rows });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;

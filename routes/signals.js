'use strict';
/**
 * routes/signals.js — Lista, escanea y consume señales
 */
var express = require('express');
var router = express.Router();
var db = require('../lib/db');
var marketData = require('../lib/marketData');
var signalEngine = require('../lib/signalEngine');

// Scan en vivo: para cada símbolo, devuelve la decisión actual y los scores
// long/short continuos. No persiste — es solo lectura.
router.get('/scan', function(req, res) {
  var raw = (req.query.symbols || '').toString();
  var symbolsP = raw
    ? Promise.resolve(raw.split(',').map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean))
    : db.simbolosDeWatchlistsActivas();

  symbolsP.then(function(symbols) {
    if (!symbols || symbols.length === 0) return res.json({ analyses: [] });
    return Promise.all(symbols.map(function(sym) {
      return marketData.getHistorical(sym, '1y', '1d').then(function(parsed) {
        if (!parsed || !parsed.ohlcv) return { symbol: sym, error: 'sin datos' };
        var s = signalEngine.computeSignal(parsed.ohlcv);
        s.symbol = sym;
        return s;
      }).catch(function(err) {
        return { symbol: sym, error: err.message };
      });
    })).then(function(analyses) {
      res.json({ analyses: analyses, ts: Date.now() });
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

router.get('/', function(req, res) {
  var symbol = req.query.symbol ? String(req.query.symbol).trim().toUpperCase() : null;
  var limit = parseInt(req.query.limit, 10) || 50;
  db.obtenerSenales(symbol, limit).then(function(rows) {
    var parsed = (rows || []).map(function(r) {
      var reasons = [];
      try { reasons = JSON.parse(r.reasons || '[]'); } catch(e) {}
      return {
        id: r.id, symbol: r.symbol, action: r.action, score: r.score, reasons: reasons,
        price: r.price, stop_loss: r.stop_loss, take_profit: r.take_profit,
        ts: r.ts, consumido: !!r.consumido
      };
    });
    res.json({ signals: parsed });
  }).catch(function(err) { res.status(500).json({ error: err.message }); });
});

router.post('/:id/consume', function(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  db.marcarSenalConsumida(id).then(function(r) { res.json(r); })
    .catch(function(err) { res.status(500).json({ error: err.message }); });
});

module.exports = router;

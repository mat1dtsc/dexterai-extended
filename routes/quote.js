'use strict';
/**
 * routes/quote.js — Precios en tiempo real (v3: yahoo-finance2)
 */
var express = require('express');
var router = express.Router();
var data = require('../lib/marketData');
var db = require('../lib/db_v2');

// GET /api/quote — Precio actual (con cache DB de 5 min)
router.get('/', function(req, res) {
  var symbol = req.query.symbol || 'NDX';
  var maxAgeSec = req.query.fresh ? 0 : 5 * 60; // 5 minutos por defecto

  db.getLastTick(symbol).then(function(row) {
    if (row && (Math.floor(Date.now()/1000) - row.ts) <= maxAgeSec) {
      // Dato fresco en base, devolverlo
      return res.json({
        symbol: row.symbol,
        price: row.price,
        change: row.change,
        changePercent: row.change_pct,
        volume: row.volume,
        marketState: row.market_state,
        source: 'db_cache',
        ts: row.ts * 1000,
        cached: true
      });
    }
    // Dato viejo o no existe, ir a Yahoo
    return data.getQuote(symbol).then(function(q) {
      // Guardar en base para próximas consultas
      db.insertTickBatch([{
        symbol: q.symbol || symbol,
        price: q.price,
        change: q.change,
        change_pct: q.changePercent,
        volume: q.volume,
        market_state: q.marketState,
        source: 'yahoo-finance2',
        ts: Math.floor(Date.now()/1000)
      }]).catch(function(err) {
        console.error('[quote] Error guardando tick:', err.message);
      });
      res.json(q);
    });
  }).catch(function(err) {
    // Fallback a Yahoo si la base falla
    data.getQuote(symbol).then(function(q) {
      res.json(q);
    }).catch(function(err2) {
      res.status(500).json({ error: err2.message, symbol: symbol });
    });
  });
});

// GET /api/quote/intraday — Velas intradiarias
router.get('/intraday', function(req, res) {
  var symbol = req.query.symbol || 'NDX';
  var interval = req.query.interval || '5m';
  var period = '5d';
  if (interval === '1m') period = '1d';
  else if (interval === '15m') period = '1mo';
  else if (interval === '30m') period = '1mo';
  else if (interval === '1h') period = '3mo';
  
  data.getHistorical(symbol, period, interval).then(function(parsed) {
    var candles = parsed.ohlcv || [];
    if (interval === '1m') {
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var todayTs = today.getTime() / 1000;
      candles = candles.filter(function(c) { return c.timestamp >= todayTs; });
    }
    res.json({
      symbol: symbol,
      candles: candles,
      currentPrice: parsed.meta.regularMarketPrice,
      marketState: parsed.meta.marketState || 'UNKNOWN',
      interval: interval,
      ts: Date.now()
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/quote/historical — Datos históricos
router.get('/historical', function(req, res) {
  var symbol = req.query.symbol || 'NDX';
  var interval = req.query.interval || '1d';
  var range = req.query.range || '1y';
  data.getHistorical(symbol, range, interval).then(function(parsed) {
    res.json({
      symbol: symbol,
      ohlcv: parsed.ohlcv,
      meta: parsed.meta,
      ts: Date.now()
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/quote/fundamentals — Datos fundamentales
router.get('/fundamentals', function(req, res) {
  var symbol = req.query.symbol || 'AAPL';
  data.getFundamentals(symbol).then(function(f) {
    res.json(f);
  }).catch(function(err) {
    res.status(500).json({ error: err.message, symbol: symbol });
  });
});

// GET /api/quote/batch/fundamentals — Batch fundamentales
router.get('/batch/fundamentals', function(req, res) {
  var symbols = req.query.symbols ? req.query.symbols.split(',') : ['AAPL', 'MSFT', 'GOOGL'];
  data.getFundamentalsBatch(symbols).then(function(result) {
    res.json({
      ok: result.ok,
      failed: result.failed,
      data: result.data,
      errors: result.errors,
      ts: Date.now()
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/quote/batch — Múltiples quotes
router.get('/batch', function(req, res) {
  var symbols = req.query.symbols ? req.query.symbols.split(',') : data.DEFAULT_SYMBOLS;
  data.getQuotesBatch(symbols).then(function(result) {
    // marketData.js devuelve formato procesado: {ok, failed, quotes, errors, ts}
    res.json({
      ok: result.ok,
      failed: result.failed,
      quotes: result.quotes,
      errors: result.errors,
      ts: Date.now()
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// GET /api/quote/status — Estado del sistema de market data
router.get('/status', function(req, res) {
  var status = data.getStatus();
  res.json({
    circuitState: status.circuitState,
    failureCount: status.failureCount,
    metrics: status.metrics,
    cacheKeys: status.cacheKeys,
    rateLimit: status.rateLimit,
    ts: Date.now()
  });
});

// GET /api/quote/metrics — Métricas de latencia y cache
router.get('/metrics', function(req, res) {
  res.json({
    metrics: data.getMetrics(),
    circuitState: data.getStatus().circuitState,
    ts: Date.now()
  });
});

module.exports = router;

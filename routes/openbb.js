'use strict';
/**
 * routes/openbb.js — Expone el cliente OpenBB al frontend
 */
var express = require('express');
var router = express.Router();
var obb = require('../lib/openbbClient');

router.get('/health', function(req, res) {
  obb.ping().then(function(r) { res.json(r); });
});

router.get('/status', function(req, res) {
  res.json(obb.getStatus());
});

router.get('/search', function(req, res) {
  var q = String(req.query.q || req.query.query || '').trim();
  if (!q) { res.status(400).json({ error: 'param q requerido' }); return; }
  obb.searchEquity(q).then(function(data) {
    res.json(data);
  }).catch(function(err) {
    res.status(502).json({ error: err.message });
  });
});

router.get('/quote', function(req, res) {
  var symbol = String(req.query.symbol || '').trim();
  if (!symbol) { res.status(400).json({ error: 'symbol requerido' }); return; }
  obb.getQuote(symbol).then(function(data) { res.json(data); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/historical', function(req, res) {
  var symbol = String(req.query.symbol || '').trim();
  if (!symbol) { res.status(400).json({ error: 'symbol requerido' }); return; }
  obb.getHistorical(symbol, {
    interval: req.query.interval,
    start_date: req.query.start_date,
    end_date: req.query.end_date
  }).then(function(data) { res.json(data); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/fundamentals', function(req, res) {
  var symbol = String(req.query.symbol || '').trim();
  if (!symbol) { res.status(400).json({ error: 'symbol requerido' }); return; }
  obb.getFundamentals(symbol).then(function(data) { res.json(data); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/news', function(req, res) {
  var symbol = String(req.query.symbol || '').trim();
  if (!symbol) { res.status(400).json({ error: 'symbol requerido' }); return; }
  var limit = parseInt(req.query.limit, 10) || 20;
  obb.getNews(symbol, limit).then(function(data) { res.json(data); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/economy/calendar', function(req, res) {
  obb.getEconomyCalendar().then(function(data) { res.json(data); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/insider', function(req, res) {
  var symbol = String(req.query.symbol || '').trim();
  if (!symbol) { res.status(400).json({ error: 'symbol requerido' }); return; }
  obb.getInsiderTrading(symbol).then(function(data) { res.json(data); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/cot', function(req, res) {
  var symbol = String(req.query.symbol || '').trim();
  if (!symbol) { res.status(400).json({ error: 'symbol/id requerido' }); return; }
  obb.getCOT(symbol).then(function(data) { res.json(data); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

module.exports = router;

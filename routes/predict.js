'use strict';
/**
 * routes/predict.js — Expone el servicio ML al frontend.
 */
var express = require('express');
var router = express.Router();
var ml = require('../lib/mlClient');

router.get('/health', function(req, res) {
  ml.health().then(function(r) { res.json(r); });
});

router.get('/trained', function(req, res) {
  ml.trained().then(function(r) { res.json(r); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/', function(req, res) {
  var symbol = (req.query.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
  ml.predict(symbol).then(function(r) { res.json(r); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/batch', function(req, res) {
  var raw = (req.query.symbols || '').trim();
  if (!raw) return res.status(400).json({ error: 'symbols requerido' });
  ml.predictBatch(raw.split(',')).then(function(r) { res.json(r); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/metrics/:symbol', function(req, res) {
  ml.metrics(req.params.symbol).then(function(r) { res.json(r); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

module.exports = router;

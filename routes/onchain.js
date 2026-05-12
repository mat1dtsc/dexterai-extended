'use strict';
/**
 * routes/onchain.js — Endpoints on-chain Bitcoin
 *
 *  GET /api/onchain/btc/metrics            → lista de métricas disponibles + último valor
 *  GET /api/onchain/btc/series?metric=X&days=N → serie temporal de una métrica
 *  GET /api/onchain/btc/whales?days=N&min_btc=M → whale txs recientes
 *  GET /api/onchain/btc/summary            → snapshot actual con cambio % a 7d/30d
 */
var express = require('express');
var router = express.Router();
var sqlite3 = require('sqlite3').verbose();
var path = require('path');

var DB_PATH = process.env.VERCEL ? '/tmp/dexter.db' : path.join(__dirname, '..', 'data', 'dexter.db');
var db = new sqlite3.Database(DB_PATH);

function nowSec() { return Math.floor(Date.now() / 1000); }

router.get('/btc/metrics', function(req, res) {
  db.all(
    `SELECT metric, COUNT(*) AS points,
            (SELECT value FROM btc_onchain_metrics m2 WHERE m2.metric = m.metric ORDER BY ts DESC LIMIT 1) AS last_value,
            (SELECT ts    FROM btc_onchain_metrics m2 WHERE m2.metric = m.metric ORDER BY ts DESC LIMIT 1) AS last_ts
     FROM btc_onchain_metrics m
     GROUP BY metric
     ORDER BY metric`,
    [],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ metrics: rows || [] });
    }
  );
});

router.get('/btc/series', function(req, res) {
  var metric = String(req.query.metric || '').trim();
  var days = parseInt(req.query.days, 10) || 180;
  if (!metric) return res.status(400).json({ error: 'param metric requerido' });
  var cutoff = nowSec() - days * 24 * 3600;
  db.all(
    'SELECT ts, value FROM btc_onchain_metrics WHERE metric = ? AND ts >= ? ORDER BY ts',
    [metric, cutoff],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ metric: metric, days: days, points: rows || [] });
    }
  );
});

router.get('/btc/whales', function(req, res) {
  var days = parseInt(req.query.days, 10) || 7;
  var minBtc = parseFloat(req.query.min_btc) || 100;
  var cutoff = nowSec() - days * 24 * 3600;
  db.all(
    'SELECT txid, ts, btc_amount, usd_value, from_label, to_label, direction FROM btc_whale_txs WHERE ts >= ? AND btc_amount >= ? ORDER BY ts DESC LIMIT 500',
    [cutoff, minBtc],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });

      var toExchange = (rows || []).filter(function(r) { return r.direction === 'to_exchange'; });
      var totalToExch = toExchange.reduce(function(a, b) { return a + (b.btc_amount || 0); }, 0);
      res.json({
        days: days,
        min_btc: minBtc,
        count: (rows || []).length,
        total_to_exchange_btc: totalToExch,
        whales: rows || []
      });
    }
  );
});

router.get('/btc/summary', function(req, res) {
  var now = nowSec();
  var d7 = now - 7 * 86400;
  var d30 = now - 30 * 86400;

  db.all(
    `SELECT m1.metric,
            m1.value AS current_value,
            m1.ts    AS current_ts,
            (SELECT value FROM btc_onchain_metrics WHERE metric = m1.metric AND ts <= ? ORDER BY ts DESC LIMIT 1) AS v7,
            (SELECT value FROM btc_onchain_metrics WHERE metric = m1.metric AND ts <= ? ORDER BY ts DESC LIMIT 1) AS v30
     FROM (
       SELECT metric, MAX(ts) AS ts FROM btc_onchain_metrics GROUP BY metric
     ) mx
     JOIN btc_onchain_metrics m1 ON m1.metric = mx.metric AND m1.ts = mx.ts
     ORDER BY m1.metric`,
    [d7, d30],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      var out = (rows || []).map(function(r) {
        var pct7 = (r.v7 && r.v7 !== 0) ? ((r.current_value - r.v7) / r.v7) * 100 : null;
        var pct30 = (r.v30 && r.v30 !== 0) ? ((r.current_value - r.v30) / r.v30) * 100 : null;
        return {
          metric: r.metric,
          current_value: r.current_value,
          current_ts: r.current_ts,
          pct_change_7d: pct7,
          pct_change_30d: pct30
        };
      });
      res.json({ summary: out, generated_at: now });
    }
  );
});

module.exports = router;

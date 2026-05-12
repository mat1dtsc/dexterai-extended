'use strict';
/**
 * routes/congress.js — Endpoints para data de trading de congresistas US
 *
 *  GET /api/congress/recent?days=30&limit=50&min_amount=10000&tx_type=purchase
 *  GET /api/congress/politicians                  → ranking por # trades
 *  GET /api/congress/politician/:name?days=365    → historial de un político
 *  GET /api/congress/ticker/:symbol?days=365      → quién operó un ticker
 *  GET /api/congress/leaders?metric=volume        → top políticos por volumen
 *  GET /api/congress/top-tickers?days=30          → tickers más comprados
 *  POST /api/congress/replicate                   → crea watchlist con top tickers
 */
var express = require('express');
var router = express.Router();
var sqlite3 = require('sqlite3').verbose();
var path = require('path');

var DB_PATH = process.env.VERCEL ? '/tmp/dexter.db' : path.join(__dirname, '..', 'data', 'dexter.db');
var db = new sqlite3.Database(DB_PATH);
var libDb = require('../lib/db');

function nowSec() { return Math.floor(Date.now() / 1000); }

// GET /recent
router.get('/recent', function(req, res) {
  var days = parseInt(req.query.days, 10) || 30;
  var limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  var minAmount = parseFloat(req.query.min_amount) || 0;
  var txType = req.query.tx_type ? String(req.query.tx_type).toLowerCase() : null;
  var politician = req.query.politician ? String(req.query.politician).trim() : null;
  var ticker = req.query.ticker ? String(req.query.ticker).trim().toUpperCase() : null;

  var cutoff = nowSec() - days * 24 * 3600;
  var sql = `SELECT politician, chamber, party, ticker, asset_description,
                    transaction_date, disclosure_date, tx_type, amount_min, amount_max
             FROM congress_trades
             WHERE transaction_date >= ?
               AND COALESCE(amount_min, 0) >= ?`;
  var params = [cutoff, minAmount];

  if (txType)     { sql += ' AND tx_type = ?'; params.push(txType); }
  if (politician) { sql += ' AND politician LIKE ?'; params.push('%' + politician + '%'); }
  if (ticker)     { sql += ' AND ticker = ?'; params.push(ticker); }

  sql += ' ORDER BY transaction_date DESC, disclosure_date DESC LIMIT ?';
  params.push(limit);

  db.all(sql, params, function(err, rows) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ trades: rows || [], filters: { days: days, min_amount: minAmount, tx_type: txType, politician: politician, ticker: ticker }, count: (rows || []).length });
  });
});

// GET /politicians
router.get('/politicians', function(req, res) {
  db.all(
    `SELECT politician, chamber, MAX(party) AS party,
            COUNT(*) AS n_trades,
            SUM(CASE WHEN tx_type='purchase' THEN 1 ELSE 0 END) AS n_purchases,
            SUM(CASE WHEN tx_type LIKE 'sale%' THEN 1 ELSE 0 END) AS n_sales,
            SUM(COALESCE(amount_min, 0)) AS volume_min,
            SUM(COALESCE(amount_max, 0)) AS volume_max,
            date(MAX(transaction_date), 'unixepoch') AS last_trade
     FROM congress_trades
     GROUP BY politician, chamber
     ORDER BY n_trades DESC`,
    [],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ politicians: rows || [] });
    }
  );
});

// GET /politician/:name
router.get('/politician/:name', function(req, res) {
  var name = String(req.params.name).trim();
  var days = parseInt(req.query.days, 10) || 365;
  var cutoff = nowSec() - days * 24 * 3600;
  db.all(
    `SELECT politician, chamber, party, ticker, asset_description,
            transaction_date, disclosure_date, tx_type, amount_min, amount_max
     FROM congress_trades
     WHERE politician = ? AND transaction_date >= ?
     ORDER BY transaction_date DESC LIMIT 500`,
    [name, cutoff],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ politician: name, days: days, trades: rows || [] });
    }
  );
});

// GET /ticker/:symbol
router.get('/ticker/:symbol', function(req, res) {
  var symbol = String(req.params.symbol).trim().toUpperCase();
  var days = parseInt(req.query.days, 10) || 365;
  var cutoff = nowSec() - days * 24 * 3600;
  db.all(
    `SELECT politician, chamber, party, transaction_date, disclosure_date,
            tx_type, amount_min, amount_max, asset_description
     FROM congress_trades
     WHERE ticker = ? AND transaction_date >= ?
     ORDER BY transaction_date DESC LIMIT 300`,
    [symbol, cutoff],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      // Stats
      var summary = { purchases: 0, sales: 0, vol_min: 0, vol_max: 0, politicians: new Set() };
      (rows || []).forEach(function(r) {
        if (r.tx_type === 'purchase') summary.purchases++;
        if (r.tx_type && r.tx_type.indexOf('sale') === 0) summary.sales++;
        summary.vol_min += r.amount_min || 0;
        summary.vol_max += r.amount_max || 0;
        summary.politicians.add(r.politician);
      });
      summary.unique_politicians = summary.politicians.size;
      delete summary.politicians;
      res.json({ symbol: symbol, days: days, trades: rows || [], summary: summary });
    }
  );
});

// GET /top-tickers — los más operados en la ventana
router.get('/top-tickers', function(req, res) {
  var days = parseInt(req.query.days, 10) || 30;
  var limit = parseInt(req.query.limit, 10) || 25;
  var cutoff = nowSec() - days * 24 * 3600;
  db.all(
    `SELECT ticker,
            COUNT(*) AS n_trades,
            SUM(CASE WHEN tx_type='purchase' THEN 1 ELSE 0 END) AS purchases,
            SUM(CASE WHEN tx_type LIKE 'sale%' THEN 1 ELSE 0 END) AS sales,
            COUNT(DISTINCT politician) AS n_politicians,
            SUM(COALESCE(amount_min, 0)) AS vol_min,
            SUM(COALESCE(amount_max, 0)) AS vol_max,
            date(MAX(transaction_date),'unixepoch') AS last_trade
     FROM congress_trades
     WHERE ticker IS NOT NULL AND transaction_date >= ?
     GROUP BY ticker
     ORDER BY n_trades DESC
     LIMIT ?`,
    [cutoff, limit],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ days: days, tickers: rows || [] });
    }
  );
});

// GET /leaders — top políticos por volumen reciente
router.get('/leaders', function(req, res) {
  var days = parseInt(req.query.days, 10) || 90;
  var metric = (req.query.metric || 'volume').toLowerCase(); // volume | count
  var limit = parseInt(req.query.limit, 10) || 25;
  var cutoff = nowSec() - days * 24 * 3600;
  var orderBy = metric === 'count' ? 'n_trades DESC' : 'vol_max DESC';
  db.all(
    `SELECT politician, chamber, MAX(party) AS party,
            COUNT(*) AS n_trades,
            SUM(COALESCE(amount_min, 0)) AS vol_min,
            SUM(COALESCE(amount_max, 0)) AS vol_max,
            date(MAX(transaction_date),'unixepoch') AS last_trade
     FROM congress_trades
     WHERE transaction_date >= ?
     GROUP BY politician
     ORDER BY ` + orderBy + `
     LIMIT ?`,
    [cutoff, limit],
    function(err, rows) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ days: days, metric: metric, leaders: rows || [] });
    }
  );
});

// POST /replicate — crea watchlist con top tickers que cierto político/grupo compró
router.post('/replicate', function(req, res) {
  var body = req.body || {};
  var name = (body.watchlist_name || 'Política Replica').trim();
  var days = parseInt(body.days, 10) || 90;
  var politician = body.politician || null;
  var topN = parseInt(body.top_n, 10) || 15;
  var purchasesOnly = body.purchases_only !== false; // default true
  var cutoff = nowSec() - days * 24 * 3600;

  var sql = `SELECT ticker, COUNT(*) AS n, SUM(COALESCE(amount_min,0)) AS vmin
             FROM congress_trades
             WHERE ticker IS NOT NULL AND transaction_date >= ?`;
  var params = [cutoff];
  if (politician) { sql += ' AND politician = ?'; params.push(politician); }
  if (purchasesOnly) sql += " AND tx_type = 'purchase'";
  sql += ' GROUP BY ticker ORDER BY n DESC, vmin DESC LIMIT ?';
  params.push(topN);

  db.all(sql, params, function(err, rows) {
    if (err) return res.status(500).json({ error: err.message });
    var tickers = (rows || []).map(function(r) { return r.ticker; });
    if (!tickers.length) return res.status(404).json({ error: 'sin tickers para replicar' });
    libDb.crearWatchlist(name, tickers).then(function(r) {
      res.status(201).json({
        ok: true,
        watchlist_id: r.id,
        watchlist_name: name,
        tickers: tickers,
        source: { politician: politician, days: days, purchases_only: purchasesOnly }
      });
    }).catch(function(e) {
      var status = /UNIQUE/i.test(e.message) ? 409 : 500;
      res.status(status).json({ error: e.message });
    });
  });
});

// GET /stats — global
router.get('/stats', function(req, res) {
  db.get(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT politician) AS n_politicians,
            COUNT(DISTINCT ticker) AS n_tickers,
            date(MIN(transaction_date),'unixepoch') AS min_date,
            date(MAX(transaction_date),'unixepoch') AS max_date,
            date(MAX(disclosure_date),'unixepoch') AS last_disclosure
     FROM congress_trades`,
    [],
    function(err, row) {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row || {});
    }
  );
});

module.exports = router;

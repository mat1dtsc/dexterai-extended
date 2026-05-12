'use strict';
/**
 * routes/intelligence.js — Inteligencia de mercado: noticias, anomalías, patrones
 */
var express = require('express');
var router = express.Router();
var db = require('../lib/db_v2');
var newsFeed = require('../lib/newsFeed');

// ─── GET /api/intelligence/news?symbol=AAPL&hours=24 ───────────────────────
router.get('/news', function(req, res) {
  var symbol = req.query.symbol;
  var hours = parseInt(req.query.hours) || 24;
  var limit = parseInt(req.query.limit) || 50;
  if (!symbol) {
    res.status(400).json({ error: 'symbol requerido' });
    return;
  }
  db.getNewsForSymbol(symbol.toUpperCase(), hours, limit).then(function(news) {
    res.json({
      symbol: symbol.toUpperCase(),
      hours: hours,
      count: news.length,
      news: news.map(function(n) {
        return {
          headline: n.headline,
          summary: n.summary,
          url: n.url,
          category: n.category,
          sentiment: n.sentiment,
          symbols: n.symbols ? JSON.parse(n.symbols) : [],
          published_at: n.published_at,
          source: n.source
        };
      })
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ─── GET /api/intelligence/anomalies?symbol=AAPL&days=7 ─────────────────────
router.get('/anomalies', function(req, res) {
  var symbol = req.query.symbol;
  var days = parseInt(req.query.days) || 7;
  var limit = parseInt(req.query.limit) || 50;
  var promise = symbol
    ? db.getAnomaliesForSymbol(symbol.toUpperCase(), days, limit)
    : db.getRecentAnomalies(limit);
  promise.then(function(anomalies) {
    res.json({
      symbol: symbol ? symbol.toUpperCase() : 'all',
      days: days,
      count: anomalies.length,
      anomalies: anomalies.map(function(a) {
        return {
          symbol: a.symbol,
          timestamp: a.timestamp,
          price: a.price,
          return_1h: a.return_1h,
          return_1d: a.return_1d,
          return_5d: a.return_5d,
          volume_zscore: a.volume_zscore,
          volatility_spike: a.volatility_spike,
          anomaly_type: a.anomaly_type,
          news_ids: a.news_ids ? JSON.parse(a.news_ids) : []
        };
      })
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ─── GET /api/intelligence/patterns?category=earnings ───────────────────────
router.get('/patterns', function(req, res) {
  var category = req.query.category;
  var limit = parseInt(req.query.limit) || 50;
  db.getPatterns(category, limit).then(function(patterns) {
    res.json({
      category: category || 'all',
      count: patterns.length,
      patterns: patterns.map(function(p) {
        return {
          pattern_name: p.pattern_name,
          category: p.category,
          keyword: p.keyword,
          avg_return_1h: p.avg_return_1h,
          avg_return_1d: p.avg_return_1d,
          avg_return_5d: p.avg_return_5d,
          win_rate: p.win_rate,
          sample_count: p.sample_count,
          confidence: p.confidence,
          last_seen: p.last_seen
        };
      })
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ─── GET /api/intelligence/context?symbol=AAPL ──────────────────────────────
// Devuelve un resumen completo: últimas noticias + anomalías + patrones relevantes
router.get('/context', function(req, res) {
  var symbol = req.query.symbol;
  if (!symbol) {
    res.status(400).json({ error: 'symbol requerido' });
    return;
  }
  var sym = symbol.toUpperCase();
  Promise.all([
    db.getNewsForSymbol(sym, 24, 10),
    db.getAnomaliesForSymbol(sym, 7, 10),
    db.getPatterns(null, 20)
  ]).then(function(results) {
    var news = results[0];
    var anomalies = results[1];
    var patterns = results[2];
    // Filtrar patrones relevantes para este símbolo
    var relevantPatterns = patterns.filter(function(p) {
      return p.symbol_pattern === sym || p.symbol_pattern === 'all';
    });
    res.json({
      symbol: sym,
      context: {
        latest_news: news.slice(0, 5).map(function(n) {
          return {
            headline: n.headline,
            category: n.category,
            sentiment: n.sentiment,
            published_at: n.published_at
          };
        }),
        latest_anomaly: anomalies.length > 0 ? {
          timestamp: anomalies[0].timestamp,
          type: anomalies[0].anomaly_type,
          price: anomalies[0].price,
          return_1h: anomalies[0].return_1h
        } : null,
        patterns: relevantPatterns.slice(0, 5).map(function(p) {
          return {
            pattern_name: p.pattern_name,
            win_rate: p.win_rate,
            avg_return_1d: p.avg_return_1d,
            sample_count: p.sample_count
          };
        })
      }
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ─── POST /api/intelligence/fetch (forzar fetch manual de noticias) ──────────
router.post('/fetch', function(req, res) {
  newsFeed.fetchAllNews().then(function(news) {
    return db.insertNewsBatch(news).then(function(result) {
      res.json({
        fetched: news.length,
        inserted: result.inserted,
        latest: news.slice(0, 5).map(function(n) {
          return { headline: n.headline, category: n.category, symbols: n.symbols };
        })
      });
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;

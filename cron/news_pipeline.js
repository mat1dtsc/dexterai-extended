'use strict';
/**
 * cron/news_pipeline.js — Pipeline de inteligencia de mercado
 * Corre cada 15 minutos: obtiene noticias, detecta anomalías, correlaciona
 */

var newsFeed = require('../lib/newsFeed');
var db = require('../lib/db_v2');
var anomalyDetector = require('../lib/anomalyDetector');
var marketData = require('../lib/marketData');

var SYMBOLS_TO_TRACK = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'BTC-USD', 'ETH-USD', 'SPY', 'NDX'];

function log(msg) {
  var ts = new Date().toISOString();
  console.log('[' + ts + '] [NewsPipeline] ' + msg);
}

// ─── Paso 1: Obtener y guardar noticias ────────────────────────────────────
function step1_fetchNews() {
  log('Obteniendo noticias de RSS...');
  return newsFeed.fetchAllNews().then(function(news) {
    if (news.length === 0) {
      log('No se obtuvieron noticias (RSS puede estar bloqueado)');
      return { inserted: 0, news: [] };
    }
    return db.insertNewsBatch(news).then(function(result) {
      log('Noticias insertadas: ' + result.inserted + ' de ' + news.length);
      return { inserted: result.inserted, news: news };
    });
  });
}

// ─── Paso 2: Detectar anomalías recientes ──────────────────────────────────
function step2_detectAnomalies() {
  log('Detectando anomalías de precio...');
  var promises = SYMBOLS_TO_TRACK.map(function(symbol) {
    return marketData.getHistorical(symbol, '1mo', '1d').then(function(parsed) {
      if (!parsed || !parsed.ohlcv || parsed.ohlcv.length < 30) return null;
      var ohlcv = parsed.ohlcv.filter(function(v) {
        return v.close !== null && v.close !== undefined && !isNaN(v.close);
      });
      var result = anomalyDetector.detectAnomalies(symbol, ohlcv, []);
      return result.anomalies;
    }).catch(function(err) {
      log('Error en anomalías ' + symbol + ': ' + err.message);
      return [];
    });
  });
  return Promise.all(promises).then(function(results) {
    var all = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i]) all = all.concat(results[i]);
    }
    // Solo las últimas 48 horas
    var cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
    var recent = all.filter(function(a) { return a.timestamp > cutoff; });
    log('Anomalías detectadas recientes: ' + recent.length);
    return recent;
  });
}

// ─── Paso 3: Correlacionar noticias con anomalías ───────────────────────────
function step3_correlate(news, anomalies) {
  log('Correlacionando noticias con anomalías...');
  var correlations = [];
  for (var i = 0; i < anomalies.length; i++) {
    var anom = anomalies[i];
    // Buscar noticias en las 6 horas previas a la anomalía
    var windowStart = anom.timestamp - 6 * 3600;
    var windowEnd = anom.timestamp + 2 * 3600;
    var matchingNews = news.filter(function(n) {
      return n.symbols.indexOf(anom.symbol) !== -1 &&
             n.published_at >= windowStart &&
             n.published_at <= windowEnd;
    });
    if (matchingNews.length > 0) {
      correlations.push({
        symbol: anom.symbol,
        anomaly: anom,
        news: matchingNews,
        correlation_type: 'news_driven'
      });
      // Guardar anomalía con news_ids
      var newsIds = matchingNews.map(function(n) { return n.headline.substring(0, 40); });
      anom.news_ids = newsIds;
      db.insertAnomaly(anom).catch(function(e) { /* silent */ });
    }
  }
  log('Correlaciones encontradas: ' + correlations.length);
  return correlations;
}

// ─── Paso 4: Actualizar patrones aprendidos ────────────────────────────────
function step4_updatePatterns(correlations) {
  log('Actualizando patrones...');
  for (var i = 0; i < correlations.length; i++) {
    var c = correlations[i];
    for (var j = 0; j < c.news.length; j++) {
      var news = c.news[j];
      var patternName = news.category + ': ' + news.headline.substring(0, 40);
      // Calcular métricas del patrón
      var ret1h = c.anomaly.return_1h || 0;
      var ret1d = c.anomaly.return_1d || 0;
      var win = ret1h > 0 ? 1 : 0;
      // Verificar si ya existe
      db.getPatterns(news.category, 100).then(function(patterns) {
        var existing = null;
        for (var k = 0; k < patterns.length; k++) {
          if (patterns[k].keyword === news.category) existing = patterns[k];
        }
        if (existing) {
          var n = existing.sample_count + 1;
          var newAvg1h = ((existing.avg_return_1h || 0) * (n - 1) + ret1h) / n;
          var newAvg1d = ((existing.avg_return_1d || 0) * (n - 1) + ret1d) / n;
          var newWinRate = ((existing.win_rate || 0) * (n - 1) + win * 100) / n;
          db.insertPattern({
            pattern_name: existing.pattern_name,
            category: news.category,
            keyword: news.category,
            symbol_pattern: c.symbol,
            avg_return_1h: newAvg1h,
            avg_return_1d: newAvg1d,
            win_rate: newWinRate,
            sample_count: n,
            confidence: Math.min(n / 10, 1.0),
            last_seen: Math.floor(Date.now() / 1000)
          }).catch(function(e) { /* silent */ });
        } else {
          db.insertPattern({
            pattern_name: patternName,
            category: news.category,
            keyword: news.category,
            symbol_pattern: c.symbol,
            avg_return_1h: ret1h,
            avg_return_1d: ret1d,
            win_rate: win * 100,
            sample_count: 1,
            confidence: 0.1,
            last_seen: Math.floor(Date.now() / 1000)
          }).catch(function(e) { /* silent */ });
        }
      }).catch(function(e) { /* silent */ });
    }
  }
}

// ─── Pipeline completo ───────────────────────────────────────────────────────
function runPipeline() {
  var start = Date.now();
  log('=== INICIANDO PIPELINE ===');
  var allNews = [];
  step1_fetchNews().then(function(result) {
    allNews = result.news;
    return step2_detectAnomalies();
  }).then(function(anomalies) {
    return step3_correlate(allNews, anomalies);
  }).then(function(correlations) {
    step4_updatePatterns(correlations);
    var duration = Date.now() - start;
    log('=== PIPELINE COMPLETADO en ' + duration + 'ms ===');
    return db.logUpdate('news_pipeline', null, allNews.length, duration, null);
  }).catch(function(err) {
    log('ERROR en pipeline: ' + err.message);
    return db.logUpdate('news_pipeline', null, 0, Date.now() - start, err.message);
  });
}

// ─── Ejecutar si se corre directamente ─────────────────────────────────────
if (require.main === module) {
  db.initDb();
  runPipeline();
}

module.exports = { runPipeline: runPipeline };

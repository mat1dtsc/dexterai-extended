'use strict';
/**
 * lib/sync.js — Pipeline de sincronización time-series
 * Usa lib/marketData.js para obtener datos y lib/db_v2.js para persistir
 */
var marketData = require('./marketData');
var db = require('./db_v2');
var indicators = require('./indicators');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function nowSec() { return Math.floor(Date.now() / 1000); }

function log(msg) {
  console.log('[sync]', msg);
}

// ─── syncTick: quotes actuales ────────────────────────────────────────────────
function syncTick(symbols) {
  var start = Date.now();
  if (!Array.isArray(symbols)) symbols = [symbols];
  log('syncTick: ' + symbols.join(', '));

  return marketData.getQuotesBatch(symbols).then(function(result) {
    var records = [];
    var okQuotes = result.quotes || [];
    okQuotes.forEach(function(q) {
      if (!q.symbol || q.price === null || q.price === undefined) return;
      records.push({
        symbol: q.symbol,
        price: q.price,
        change: q.change !== undefined ? q.change : null,
        change_pct: q.changePercent !== undefined ? q.changePercent : null,
        volume: q.volume !== undefined ? q.volume : null,
        market_state: q.marketState || null,
        source: 'yahoo-finance2',
        ts: nowSec()
      });
    });

    return db.insertTickBatch(records).then(function(insertResult) {
      var duration = Date.now() - start;
      db.logUpdate('tick', null, insertResult.inserted, duration, null);
      log('syncTick: insertados ' + insertResult.inserted + ' de ' + records.length + ' en ' + duration + 'ms');
      return {
        ok: okQuotes.length,
        failed: result.failed || 0,
        inserted: insertResult.inserted,
        duration: duration
      };
    });
  }).catch(function(err) {
    var duration = Date.now() - start;
    db.logUpdate('tick', null, 0, duration, err.message);
    log('syncTick ERROR: ' + err.message);
    return { ok: 0, failed: symbols.length, inserted: 0, duration: duration, error: err.message };
  });
}

// ─── syncOhlcv: histórico OHLCV ────────────────────────────────────────────
function syncOhlcv(symbols, period, interval) {
  var start = Date.now();
  if (!Array.isArray(symbols)) symbols = [symbols];
  period = period || '1y';
  interval = interval || '1d';
  log('syncOhlcv: ' + symbols.join(', ') + ' [' + period + ', ' + interval + ']');

  return marketData.getHistoricalBatch(symbols, period, interval).then(function(result) {
    var totalInserted = 0;
    var fulfilled = result.data || [];
    var promises = [];

    fulfilled.forEach(function(parsed) {
      if (!parsed.symbol || !parsed.ohlcv || parsed.ohlcv.length === 0) return;
      promises.push(
        db.insertOhlcvBatch(parsed.symbol, parsed.ohlcv, interval, 'yahoo-finance2')
          .then(function(r) { totalInserted += r.inserted; })
      );
    });

    return Promise.all(promises).then(function() {
      var duration = Date.now() - start;
      db.logUpdate('ohlcv', null, totalInserted, duration, null);
      log('syncOhlcv: insertados ' + totalInserted + ' candles en ' + duration + 'ms');
      return {
        ok: fulfilled.length,
        failed: result.failed || 0,
        inserted: totalInserted,
        duration: duration
      };
    });
  }).catch(function(err) {
    var duration = Date.now() - start;
    db.logUpdate('ohlcv', null, 0, duration, err.message);
    log('syncOhlcv ERROR: ' + err.message);
    return { ok: 0, failed: symbols.length, inserted: 0, duration: duration, error: err.message };
  });
}

// ─── syncFundamentals: datos fundamentales ───────────────────────────────────
function syncFundamentals(symbols) {
  var start = Date.now();
  if (!Array.isArray(symbols)) symbols = [symbols];
  log('syncFundamentals: ' + symbols.join(', '));

  return marketData.getFundamentalsBatch(symbols).then(function(result) {
    var records = [];
    var fulfilled = result.data || [];
    fulfilled.forEach(function(f) {
      if (!f.symbol) return;
      records.push({
        symbol: f.symbol,
        pe: f.pe,
        forward_pe: f.forwardPE,
        eps: f.eps,
        market_cap: f.marketCap,
        dividend_yield: f.dividendYield,
        beta: f.beta,
        fifty_two_week_high: f.fiftyTwoWeekHigh,
        fifty_two_week_low: f.fiftyTwoWeekLow,
        revenue_growth: f.revenueGrowth,
        profit_margins: f.profitMargins,
        debt_to_equity: f.debtToEquity,
        total_debt: f.totalDebt,
        total_cash: f.totalCash,
        sector: f.sector,
        industry: f.industry,
        ts: nowSec()
      });
    });

    return db.insertFundamentalsBatch(records).then(function(insertResult) {
      var duration = Date.now() - start;
      db.logUpdate('fundamentals', null, insertResult.inserted, duration, null);
      log('syncFundamentals: insertados ' + insertResult.inserted + ' de ' + records.length + ' en ' + duration + 'ms');
      return {
        ok: fulfilled.length,
        failed: result.failed || 0,
        inserted: insertResult.inserted,
        duration: duration
      };
    });
  }).catch(function(err) {
    var duration = Date.now() - start;
    db.logUpdate('fundamentals', null, 0, duration, err.message);
    log('syncFundamentals ERROR: ' + err.message);
    return { ok: 0, failed: symbols.length, inserted: 0, duration: duration, error: err.message };
  });
}

// ─── syncMetrics: calcula indicadores y guarda ───────────────────────────────
function syncMetrics(symbols) {
  var start = Date.now();
  if (!Array.isArray(symbols)) symbols = [symbols];
  log('syncMetrics: ' + symbols.join(', '));

  var records = [];
  var promises = symbols.map(function(sym) {
    return db.getOhlcvRange(sym, nowSec() - 400 * 24 * 60 * 60, nowSec(), '1d')
      .then(function(rows) {
        if (!rows || rows.length < 50) {
          log('syncMetrics: ' + sym + ' sin datos suficientes (' + (rows ? rows.length : 0) + ' rows)');
          return null;
        }
        var closes = rows.map(function(r) { return r.close; }).reverse();
        var highs = rows.map(function(r) { return r.high; }).reverse();
        var lows = rows.map(function(r) { return r.low; }).reverse();

        var sma20 = indicators.calcSMASeries(closes, 20);
        var sma50 = indicators.calcSMASeries(closes, 50);
        var sma200 = indicators.calcSMASeries(closes, 200);
        var rsi14 = indicators.calcRSISeries(closes, 14);
        var macdSeries = indicators.calcMACDSeries(closes);
        var bbSeries = indicators.calcBBSeries(closes, 20, 2);
        var atr14 = indicators.calcATRSeries(highs, lows, closes, 14);
        var stochK = indicators.calcStochSeries(closes, highs, lows, 14);
        var stochD = indicators.calcSMASeries(stochK, 3);

        var lastIdx = closes.length - 1;
        var price = closes[lastIdx];

        var score = indicators.calcEntryScore({
          price: price,
          rsi14: rsi14[lastIdx],
          ma50: sma50[lastIdx],
          ma200: sma200[lastIdx],
          macd: macdSeries.macd[lastIdx],
          macdSig: macdSeries.signal[lastIdx],
          bbUp: bbSeries.upper[lastIdx],
          bbLow: bbSeries.lower[lastIdx],
          supports: [],
          resistances: []
        });

        records.push({
          symbol: sym,
          sma_20: sma20[lastIdx],
          sma_50: sma50[lastIdx],
          sma_200: sma200[lastIdx],
          rsi_14: rsi14[lastIdx],
          macd: macdSeries.macd[lastIdx],
          macd_signal: macdSeries.signal[lastIdx],
          bb_upper: bbSeries.upper[lastIdx],
          bb_lower: bbSeries.lower[lastIdx],
          atr_14: atr14[lastIdx],
          stoch_k: stochK[lastIdx],
          stoch_d: stochD[lastIdx],
          entry_score: score ? score.score : null,
          ts: nowSec()
        });
      }).catch(function(err) {
        log('syncMetrics: ' + sym + ' error — ' + err.message);
      });
  });

  return Promise.all(promises).then(function() {
    return db.insertMetricsBatch(records).then(function(insertResult) {
      var duration = Date.now() - start;
      db.logUpdate('metrics', null, insertResult.inserted, duration, null);
      log('syncMetrics: insertados ' + insertResult.inserted + ' de ' + records.length + ' en ' + duration + 'ms');
      return {
        ok: records.length,
        inserted: insertResult.inserted,
        duration: duration
      };
    });
  }).catch(function(err) {
    var duration = Date.now() - start;
    db.logUpdate('metrics', null, 0, duration, err.message);
    log('syncMetrics ERROR: ' + err.message);
    return { ok: 0, inserted: 0, duration: duration, error: err.message };
  });
}

// ─── syncAll: corre todo el pipeline ─────────────────────────────────────────
function syncAll(symbols) {
  var start = Date.now();
  if (!Array.isArray(symbols)) symbols = [symbols];
  log('=== syncAll START: ' + symbols.length + ' símbolos ===');

  return syncTick(symbols)
    .then(function(tickResult) {
      log('syncAll: tick completo');
      return syncOhlcv(symbols, '1y', '1d').then(function(ohlcvResult) {
        return { tick: tickResult, ohlcv: ohlcvResult };
      });
    })
    .then(function(partial) {
      log('syncAll: ohlcv completo');
      return syncFundamentals(symbols).then(function(fundResult) {
        partial.fundamentals = fundResult;
        return partial;
      });
    })
    .then(function(partial) {
      log('syncAll: fundamentals completo');
      return syncMetrics(symbols).then(function(metricsResult) {
        partial.metrics = metricsResult;
        return partial;
      });
    })
    .then(function(result) {
      var duration = Date.now() - start;
      log('=== syncAll DONE en ' + duration + 'ms ===');
      result.totalDuration = duration;
      return result;
    })
    .catch(function(err) {
      var duration = Date.now() - start;
      log('=== syncAll ERROR: ' + err.message + ' (' + duration + 'ms) ===');
      return { error: err.message, totalDuration: duration };
    });
}

// ─── syncSmart: solo lo que falta ────────────────────────────────────────────
function syncSmart(symbols) {
  if (!Array.isArray(symbols)) symbols = [symbols];
  log('=== syncSmart START: ' + symbols.length + ' símbolos ===');

  var promises = symbols.map(function(sym) {
    return db.getLastTick(sym).then(function(lastTick) {
      var needsTick = !lastTick || (nowSec() - lastTick.ts) > 5 * 60;
      return db.hasOhlcvToday(sym, '1d').then(function(hasToday) {
        return { symbol: sym, needsTick: needsTick, needsOhlcv: !hasToday };
      });
    });
  });

  return Promise.all(promises).then(function(statuses) {
    var needTick = statuses.filter(function(s) { return s.needsTick; }).map(function(s) { return s.symbol; });
    var needOhlcv = statuses.filter(function(s) { return s.needsOhlcv; }).map(function(s) { return s.symbol; });

    log('syncSmart: ' + needTick.length + ' necesitan tick, ' + needOhlcv.length + ' necesitan OHLCV');

    var p = Promise.resolve({});
    if (needTick.length > 0) {
      p = p.then(function() { return syncTick(needTick); });
    }
    if (needOhlcv.length > 0) {
      p = p.then(function() { return syncOhlcv(needOhlcv, '1y', '1d'); });
    }
    return p.then(function() {
      return syncMetrics(symbols);
    }).then(function(metricsResult) {
      log('=== syncSmart DONE ===');
      return {
        tickSymbols: needTick,
        ohlcvSymbols: needOhlcv,
        metrics: metricsResult
      };
    });
  });
}

module.exports = {
  syncTick: syncTick,
  syncOhlcv: syncOhlcv,
  syncFundamentals: syncFundamentals,
  syncMetrics: syncMetrics,
  syncAll: syncAll,
  syncSmart: syncSmart,
  nowSec: nowSec
};

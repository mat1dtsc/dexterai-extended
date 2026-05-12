'use strict';
/**
 * lib/data_v2.js — Fetcher de datos con yahoo-finance2
 * Características: retry con backoff, cache TTL, Promise.allSettled, rate limiting
 */

var YahooFinance = require('yahoo-finance2').default;
var yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
var cache = require('./cache');

// ─── Rate limiter simple ──────────────────────────────────────────────────────
var lastRequestTime = 0;
var MIN_INTERVAL_MS = 250; // máximo 4 requests/segundo

function throttle() {
  return new Promise(function(resolve) {
    var now = Date.now();
    var wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestTime));
    lastRequestTime = now + wait;
    setTimeout(resolve, wait);
  });
}

// ─── Retry con exponential backoff ────────────────────────────────────────────
function fetchWithRetry(fn, maxRetries) {
  maxRetries = maxRetries || 3;
  return new Promise(function(resolve, reject) {
    function attempt(n) {
      fn().then(resolve).catch(function(err) {
        if (n >= maxRetries) {
          reject(new Error('Max retries (' + maxRetries + ') exceeded: ' + err.message));
          return;
        }
        var delay = Math.pow(2, n) * 1000; // 1s, 2s, 4s
        console.log('[data_v2] Retry #' + (n + 1) + ' after ' + delay + 'ms — ' + err.message);
        setTimeout(function() { attempt(n + 1); }, delay);
      });
    }
    attempt(0);
  });
}

// ─── Mapeo de símbolos internos ───────────────────────────────────────────────
var SYMBOL_MAP = {
  'NDX':      { yahoo: 'NDX',        nombre: 'NASDAQ 100' },
  'GSPC':     { yahoo: '^GSPC',      nombre: 'S&P 500' },
  'DJI':      { yahoo: '^DJI',       nombre: 'Dow Jones' },
  'GDAXI':    { yahoo: '^GDAXI',     nombre: 'DAX' },
  'FTSE':     { yahoo: '^FTSE',      nombre: 'FTSE 100' },
  'N225':     { yahoo: '^N225',      nombre: 'Nikkei 225' },
  'GC=F':     { yahoo: 'GC=F',       nombre: 'Oro' },
  'CL=F':     { yahoo: 'CL=F',       nombre: 'Petróleo WTI' },
  'BZ=F':     { yahoo: 'BZ=F',       nombre: 'Petróleo Brent' },
  'USDCLP=X': { yahoo: 'USDCLP=X',   nombre: 'USD/CLP' },
  'BTC-USD':  { yahoo: 'BTC-USD',    nombre: 'Bitcoin' },
  'ETH-USD':  { yahoo: 'ETH-USD',    nombre: 'Ethereum' },
  'EURUSD=X': { yahoo: 'EURUSD=X',   nombre: 'EUR/USD' }
};

var DEFAULT_SYMBOLS = Object.keys(SYMBOL_MAP);

function resolveSymbol(sym) {
  var mapped = SYMBOL_MAP[sym];
  return mapped ? mapped.yahoo : sym;
}

function resolveNombre(sym) {
  var mapped = SYMBOL_MAP[sym];
  return mapped ? mapped.nombre : sym;
}

// ─── Cache key helper ─────────────────────────────────────────────────────────
function cacheKey(symbol, type) {
  return type + ':' + symbol;
}

// ─── Quote con cache y retry ─────────────────────────────────────────────────
function getQuote(symbol) {
  var yahooSym = resolveSymbol(symbol);
  var key = cacheKey(symbol, 'quote');
  var cached = cache.get(key);
  if (cached) {
    console.log('[data_v2] Cache hit:', symbol);
    return Promise.resolve(cached);
  }

  return throttle().then(function() {
    return fetchWithRetry(function() {
      return yahooFinance.quote(yahooSym, { fields: ['regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'regularMarketPreviousClose', 'marketState'] }, { validateResult: false });
    });
  }).then(function(result) {
    var q = {
      symbol: symbol,
      nombre: resolveNombre(symbol),
      price: result.regularMarketPrice || result.price || 0,
      change: result.regularMarketChange || result.change || 0,
      changePct: result.regularMarketChangePercent || result.changePercent || 0,
      prevClose: result.regularMarketPreviousClose || result.previousClose || 0,
      marketState: result.marketState || 'UNKNOWN',
      source: 'yahoo-finance2',
      ts: Date.now()
    };
    cache.set(key, q, 30000); // cache 30 segundos para quotes
    return q;
  });
}

// ─── Histórico con cache y retry ──────────────────────────────────────────────
function getHistorical(symbol, period, interval) {
  var yahooSym = resolveSymbol(symbol);
  period = period || '1y';
  interval = interval || '1d';
  var key = cacheKey(symbol, 'hist:' + period + ':' + interval);
  var cached = cache.get(key);
  if (cached) {
    console.log('[data_v2] Cache hit:', symbol, period, interval);
    return Promise.resolve(cached);
  }

  // Convertir period a timestamps
  var now = Math.floor(Date.now() / 1000);
  var period1;
  switch(period) {
    case '1d': period1 = now - 1 * 24 * 60 * 60; break;
    case '5d': period1 = now - 5 * 24 * 60 * 60; break;
    case '1mo': period1 = now - 30 * 24 * 60 * 60; break;
    case '3mo': period1 = now - 90 * 24 * 60 * 60; break;
    case '6mo': period1 = now - 180 * 24 * 60 * 60; break;
    case '1y': period1 = now - 365 * 24 * 60 * 60; break;
    case '2y': period1 = now - 730 * 24 * 60 * 60; break;
    case '5y': period1 = now - 1825 * 24 * 60 * 60; break;
    case '10y': period1 = now - 3650 * 24 * 60 * 60; break;
    case 'ytd': 
      var d = new Date(); 
      d.setMonth(0, 1); 
      d.setHours(0, 0, 0, 0);
      period1 = Math.floor(d.getTime() / 1000);
      break;
    case 'max': period1 = 0; break;
    default: period1 = now - 365 * 24 * 60 * 60;
  }

  return throttle().then(function() {
    return fetchWithRetry(function() {
      return yahooFinance.chart(yahooSym, { period1: period1, period2: now, interval: interval }, { validateResult: false });
    });
  }).then(function(result) {
    var q = result.quotes || [];
    var ohlcv = q.map(function(c) {
      return {
        timestamp: c.date ? Math.floor(new Date(c.date).getTime() / 1000) : null,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0
      };
    }).filter(function(c) { return c.close !== null && c.close !== undefined; });

    var meta = result.meta || {};
    var parsed = {
      symbol: symbol,
      nombre: resolveNombre(symbol),
      ohlcv: ohlcv,
      meta: {
        regularMarketPrice: meta.regularMarketPrice,
        chartPreviousClose: meta.chartPreviousClose,
        marketState: meta.marketState
      }
    };
    cache.set(key, parsed, 120000); // cache 2 minutos para histórico
    return parsed;
  });
}

// ─── Batch quotes con allSettled ──────────────────────────────────────────────
function getQuotesBatch(symbols) {
  var promises = symbols.map(function(sym) {
    return getQuote(sym).then(function(q) {
      return { status: 'fulfilled', value: q };
    }).catch(function(err) {
      console.error('[data_v2] Quote failed:', sym, err.message);
      return { status: 'rejected', reason: err.message, symbol: sym };
    });
  });
  return Promise.allSettled ? Promise.allSettled(promises.map(function(p) {
    return p.then(function(r) { return r.value || r; });
  })) : Promise.all(promises);
}

// ─── Batch histórico con allSettled ─────────────────────────────────────────────
function getHistoricalBatch(symbols, period, interval) {
  var promises = symbols.map(function(sym) {
    return getHistorical(sym, period, interval).then(function(d) {
      return { status: 'fulfilled', value: d };
    }).catch(function(err) {
      console.error('[data_v2] Historical failed:', sym, err.message);
      return { status: 'rejected', reason: err.message, symbol: sym };
    });
  });
  return Promise.allSettled ? Promise.allSettled(promises.map(function(p) {
    return p.then(function(r) { return r.value || r; });
  })) : Promise.all(promises);
}

// ─── Test de conectividad ─────────────────────────────────────────────────────
function testConnectivity() {
  return getQuote('AAPL').then(function() {
    return { ok: true, message: 'Yahoo Finance v2 conectado' };
  }).catch(function(err) {
    return { ok: false, message: err.message };
  });
}

module.exports = {
  SYMBOL_MAP: SYMBOL_MAP,
  DEFAULT_SYMBOLS: DEFAULT_SYMBOLS,
  getQuote: getQuote,
  getHistorical: getHistorical,
  getQuotesBatch: getQuotesBatch,
  getHistoricalBatch: getHistoricalBatch,
  testConnectivity: testConnectivity,
  resolveSymbol: resolveSymbol,
  resolveNombre: resolveNombre,
  _cache: cache,
  _throttle: throttle,
  _fetchWithRetry: fetchWithRetry
};

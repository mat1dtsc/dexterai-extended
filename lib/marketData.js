'use strict';
/**
 * lib/marketData.js — Módulo robusto de datos de mercado
 * 
 * Capacidades:
 * - Retry con backoff exponencial: 5 intentos (1s, 2s, 4s, 8s, 16s)
 * - Cache TTL inteligente: quotes 5min, histórico 1h, fundamentales 24h
 * - Promise.allSettled: fallo parcial no rompe todo
 * - Rate limiting: máximo 10 requests/segundo
 * - Circuit breaker: 5 fallos seguidos → espera 60s
 * 
 * Reemplazo drop-in para lib/data_v2.js
 */

var YahooFinance = require('yahoo-finance2').default;
var yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
var cache = require('./cache');

// ─── Configuración ───────────────────────────────────────────────────────────
var CONFIG = {
  retry: {
    maxRetries: 5,
    delays: [1000, 2000, 4000, 8000, 16000] // backoff exponencial
  },
  cache: {
    quoteTTL: 5 * 60 * 1000,       // 5 minutos
    historicalTTL: 60 * 60 * 1000,  // 1 hora
    fundamentalTTL: 24 * 60 * 60 * 1000 // 24 horas
  },
  rateLimit: {
    maxRequestsPerSecond: 10,
    minIntervalMs: 100 // 1000ms / 10 = 100ms
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 60 * 1000 // 60 segundos
  },
  debug: process.env.MARKETDATA_DEBUG === 'true' // logs verbose solo si se activa
};

// ─── Debug Logger ────────────────────────────────────────────────────────────
function log(msg) {
  if (CONFIG.debug) console.log('[marketData]', msg);
}

// ─── Validación de números ─────────────────────────────────────────────────
function validateNumber(primary, fallback, fieldName) {
  if (primary !== undefined && primary !== null && !isNaN(primary) && isFinite(primary)) {
    return primary;
  }
  if (fallback !== undefined && fallback !== null && !isNaN(fallback) && isFinite(fallback)) {
    return fallback;
  }
  log('Dato inválido para ' + fieldName + ': primary=' + primary + ', fallback=' + fallback);
  return null;
}

// ─── Métricas de Latencia ────────────────────────────────────────────────────
var metrics = {
  requests: 0,
  totalLatencyMs: 0,
  errors: 0,
  cacheHits: 0,
  cacheMisses: 0,
  lastReset: Date.now()
};

function recordLatency(elapsed) {
  metrics.requests++;
  metrics.totalLatencyMs += elapsed;
}
function recordCacheHit() { metrics.cacheHits++; }
function recordCacheMiss() { metrics.cacheMisses++; }
function recordError() { metrics.errors++; }
function getMetrics() {
  return {
    requests: metrics.requests,
    avgLatencyMs: metrics.requests > 0 ? Math.round(metrics.totalLatencyMs / metrics.requests) : 0,
    errors: metrics.errors,
    cacheHits: metrics.cacheHits,
    cacheMisses: metrics.cacheMisses,
    cacheHitRate: (metrics.cacheHits + metrics.cacheMisses) > 0 ? Math.round(100 * metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)) : 0,
    since: new Date(metrics.lastReset).toISOString()
  };
}
function resetMetrics() {
  metrics = { requests: 0, totalLatencyMs: 0, errors: 0, cacheHits: 0, cacheMisses: 0, lastReset: Date.now() };
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────
var rateLimitPromise = Promise.resolve();
var lastRequestTime = 0;

function scheduleRequest() {
  rateLimitPromise = rateLimitPromise.then(function() {
    var now = Date.now();
    var wait = Math.max(0, CONFIG.rateLimit.minIntervalMs - (now - lastRequestTime));
    lastRequestTime = now + wait;
    if (wait > 0) {
      return new Promise(function(resolve) { setTimeout(resolve, wait); });
    }
  });
  return rateLimitPromise;
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
var failureCount = 0;
var circuitState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
var lastFailureTime = 0;

function recordSuccess() {
  failureCount = Math.max(0, failureCount - 1);
  if (circuitState === 'HALF_OPEN') {
    circuitState = 'CLOSED';
    failureCount = 0;
    log('Circuit breaker cerrado — todo OK');
  }
}

function recordFailure() {
  failureCount++;
  lastFailureTime = Date.now();
  if (failureCount >= CONFIG.circuitBreaker.failureThreshold && circuitState !== 'OPEN') {
    circuitState = 'OPEN';
    log('Circuit breaker ABIERTO — demasiados fallos seguidos. Esperando ' + 
      (CONFIG.circuitBreaker.resetTimeoutMs / 1000) + 's');
  }
}

function checkCircuit() {
  if (circuitState === 'CLOSED') return Promise.resolve();
  if (circuitState === 'OPEN') {
    var elapsed = Date.now() - lastFailureTime;
    if (elapsed >= CONFIG.circuitBreaker.resetTimeoutMs) {
      circuitState = 'HALF_OPEN';
      log('Circuit breaker en HALF_OPEN — probando conexión');
      return Promise.resolve();
    }
    var remaining = Math.ceil((CONFIG.circuitBreaker.resetTimeoutMs - elapsed) / 1000);
    return Promise.reject(new Error('Circuit breaker OPEN — espera ' + remaining + 's más'));
  }
  return Promise.resolve(); // HALF_OPEN deja pasar
}

// ─── Retry con Exponential Backoff + manejo 429 ────────────────────────────
function fetchWithRetry(fn, context) {
  context = context || 'fetch';
  return new Promise(function(resolve, reject) {
    function attempt(n) {
      var start = Date.now();
      fn().then(function(result) {
        recordLatency(Date.now() - start);
        resolve(result);
      }).catch(function(err) {
        recordLatency(Date.now() - start);
        recordError();
        var is429 = err.message && (err.message.includes('429') || err.message.includes('Too Many Requests') || err.message.includes('rate limit'));
        if (n >= CONFIG.retry.maxRetries - 1) {
          reject(new Error('[' + context + '] Max retries (' + CONFIG.retry.maxRetries + ') exceeded: ' + err.message));
          return;
        }
        var delay = CONFIG.retry.delays[n] || CONFIG.retry.delays[CONFIG.retry.delays.length - 1];
        if (is429) {
          delay = Math.max(delay, 30000); // mínimo 30s si es 429
          log('Retry #' + (n + 1) + ' [429 detectado] esperando ' + delay + 'ms [' + context + ']');
        } else {
          log('Retry #' + (n + 1) + '/' + CONFIG.retry.maxRetries + 
            ' after ' + delay + 'ms [' + context + '] — ' + err.message);
        }
        setTimeout(function() { attempt(n + 1); }, delay);
      });
    }
    attempt(0);
  });
}

// ─── Sanitización de símbolos ────────────────────────────────────────────────
function sanitizeSymbol(sym) {
  if (typeof sym !== 'string') return '';
  return sym.trim().toUpperCase().replace(/\s+/g, '');
}

// ─── Mapeo de símbolos ───────────────────────────────────────────────────────
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
  sym = sanitizeSymbol(sym);
  var mapped = SYMBOL_MAP[sym];
  return mapped ? mapped.yahoo : sym;
}

function resolveNombre(sym) {
  sym = sanitizeSymbol(sym);
  var mapped = SYMBOL_MAP[sym];
  return mapped ? mapped.nombre : sym;
}

function cacheKey(symbol, type) {
  return type + ':' + symbol;
}

// ─── Quote individual con cache, retry, rate limit, circuit breaker ─────────
function getQuote(symbol) {
  var cleanSymbol = sanitizeSymbol(symbol);
  if (!cleanSymbol) {
    return Promise.reject(new Error('Símbolo vacío o inválido'));
  }
  var yahooSym = resolveSymbol(cleanSymbol);
  var key = cacheKey(cleanSymbol, 'quote');
  var cached = cache.get(key);
  if (cached) {
    recordCacheHit();
    return Promise.resolve(cached);
  }
  recordCacheMiss();

  return checkCircuit().then(function() {
    return scheduleRequest();
  }).then(function() {
    return fetchWithRetry(function() {
      return yahooFinance.quote(yahooSym, { 
        fields: ['regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 
                 'regularMarketPreviousClose', 'marketState', 'regularMarketOpen',
                 'regularMarketDayHigh', 'regularMarketDayLow', 'regularMarketVolume'] 
      }, { validateResult: false }).then(function(result) {
        if (!result || typeof result !== 'object') {
          throw new Error('Respuesta vacía o inválida de Yahoo Finance para ' + symbol);
        }
        return result;
      });
    }, 'quote:' + symbol);
  }).then(function(result) {
    var q = {
      symbol: cleanSymbol,
      nombre: resolveNombre(cleanSymbol),
      price: validateNumber(result.regularMarketPrice, result.price, 'price'),
      open: validateNumber(result.regularMarketOpen, null, 'open'),
      high: validateNumber(result.regularMarketDayHigh, null, 'high'),
      low: validateNumber(result.regularMarketDayLow, null, 'low'),
      volume: validateNumber(result.regularMarketVolume, null, 'volume'),
      change: validateNumber(result.regularMarketChange, result.change, 'change'),
      changePct: validateNumber(result.regularMarketChangePercent, result.changePercent, 'changePct'),
      prevClose: validateNumber(result.regularMarketPreviousClose, result.previousClose, 'prevClose'),
      marketState: result.marketState || 'UNKNOWN',
      source: 'yahoo-finance2',
      ts: Date.now(),
      _raw: {
        hasRegularMarketPrice: result.regularMarketPrice !== undefined,
        hasRegularMarketChange: result.regularMarketChange !== undefined,
        hasRegularMarketChangePercent: result.regularMarketChangePercent !== undefined
      }
    };
    cache.set(key, q, CONFIG.cache.quoteTTL);
    recordSuccess();
    return q;
  }).catch(function(err) {
    recordFailure();
    throw err;
  });
}

// ─── Histórico con cache, retry, rate limit, circuit breaker ────────────────
function getHistorical(symbol, period, interval) {
  var yahooSym = resolveSymbol(symbol);
  period = period || '1y';
  interval = interval || '1d';
  var key = cacheKey(symbol, 'hist:' + period + ':' + interval);
  var cached = cache.get(key);
  if (cached) {
    recordCacheHit();
    return Promise.resolve(cached);
  }
  recordCacheMiss();

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

  return checkCircuit().then(function() {
    return scheduleRequest();
  }).then(function() {
    return fetchWithRetry(function() {
      return yahooFinance.chart(yahooSym, { period1: period1, period2: now, interval: interval }, { validateResult: false });
    }, 'hist:' + symbol);
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
    cache.set(key, parsed, CONFIG.cache.historicalTTL);
    recordSuccess();
    return parsed;
  }).catch(function(err) {
    recordFailure();
    throw err;
  });
}

// ─── Datos fundamentales ──────────────────────────────────────────────────────
function getFundamentals(symbol) {
  var yahooSym = resolveSymbol(symbol);
  var key = cacheKey(symbol, 'fundamentals');
  var cached = cache.get(key);
  if (cached) {
    recordCacheHit();
    return Promise.resolve(cached);
  }
  recordCacheMiss();

  return checkCircuit().then(function() {
    return scheduleRequest();
  }).then(function() {
    return fetchWithRetry(function() {
      return yahooFinance.quoteSummary(yahooSym, { modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData'] }, { validateResult: false });
    }, 'fund:' + symbol);
  }).then(function(result) {
    var summary = result.summaryDetail || {};
    var stats = result.defaultKeyStatistics || {};
    var financial = result.financialData || {};
    var profile = result.summaryProfile || {};
    
    var fundamentals = {
      symbol: symbol,
      nombre: resolveNombre(symbol),
      pe: validateNumber(summary.trailingPE, summary.forwardPE, 'pe'),
      forwardPE: validateNumber(summary.forwardPE, null, 'forwardPE'),
      eps: summary.trailingPE ? validateNumber(summary.previousClose / summary.trailingPE, null, 'eps') : null,
      epsTrailingTwelveMonths: validateNumber(stats.trailingEps, null, 'epsTrailing'),
      marketCap: validateNumber(summary.marketCap, stats.marketCap, 'marketCap'),
      dividendYield: validateNumber(summary.dividendYield, null, 'dividendYield'),
      beta: validateNumber(summary.beta, null, 'beta'),
      fiftyTwoWeekHigh: validateNumber(summary.fiftyTwoWeekHigh, null, 'fiftyTwoWeekHigh'),
      fiftyTwoWeekLow: validateNumber(summary.fiftyTwoWeekLow, null, 'fiftyTwoWeekLow'),
      fiftyTwoWeekChange: validateNumber(stats.fiftyTwoWeekChange, null, 'fiftyTwoWeekChange'),
      revenueGrowth: validateNumber(financial.revenueGrowth, null, 'revenueGrowth'),
      profitMargins: validateNumber(financial.profitMargins, null, 'profitMargins'),
      operatingMargins: validateNumber(financial.operatingMargins, null, 'operatingMargins'),
      returnOnEquity: validateNumber(financial.returnOnEquity, null, 'returnOnEquity'),
      returnOnAssets: validateNumber(financial.returnOnAssets, null, 'returnOnAssets'),
      debtToEquity: validateNumber(financial.debtToEquity, null, 'debtToEquity'),
      currentRatio: validateNumber(financial.currentRatio, null, 'currentRatio'),
      quickRatio: validateNumber(financial.quickRatio, null, 'quickRatio'),
      totalDebt: validateNumber(financial.totalDebt, null, 'totalDebt'),
      totalCash: validateNumber(financial.totalCash, null, 'totalCash'),
      totalRevenue: validateNumber(financial.totalRevenue, null, 'totalRevenue'),
      grossMargins: validateNumber(financial.grossMargins, null, 'grossMargins'),
      ebitdaMargins: validateNumber(financial.ebitdaMargins, null, 'ebitdaMargins'),
      sector: profile.sector || null,
      industry: profile.industry || null,
      website: profile.website || null,
      employees: validateNumber(stats.fullTimeEmployees, null, 'employees'),
      enterpriseValue: validateNumber(stats.enterpriseValue, null, 'enterpriseValue'),
      bookValue: validateNumber(stats.bookValue, null, 'bookValue'),
      priceToBook: validateNumber(stats.priceToBook, null, 'priceToBook'),
      source: 'yahoo-finance2',
      ts: Date.now(),
      _completeness: {
        hasPE: summary.trailingPE !== undefined || summary.forwardPE !== undefined,
        hasMarketCap: summary.marketCap !== undefined || stats.marketCap !== undefined,
        hasBeta: summary.beta !== undefined,
        hasRevenueGrowth: financial.revenueGrowth !== undefined,
        hasMargins: financial.profitMargins !== undefined || financial.operatingMargins !== undefined
      }
    };
    cache.set(key, fundamentals, CONFIG.cache.fundamentalTTL);
    recordSuccess();
    return fundamentals;
  }).catch(function(err) {
    recordFailure();
    throw err;
  });
}

// ─── Batch quotes con Promise.allSettled ─────────────────────────────────────
function getQuotesBatch(symbols) {
  if (!Array.isArray(symbols)) {
    return Promise.reject(new Error('symbols debe ser un array'));
  }
  
  var promises = symbols.map(function(sym) {
    return getQuote(sym).then(function(q) {
      return { status: 'fulfilled', value: q };
    }).catch(function(err) {
      log('Quote failed: ' + sym + ' — ' + err.message);
      return { status: 'rejected', reason: err.message, symbol: sym };
    });
  });
  
  return Promise.allSettled(promises).then(function(results) {
    var fulfilled = [];
    var rejected = [];
    results.forEach(function(r) {
      if (r.status === 'fulfilled' && r.value.status === 'fulfilled') {
        fulfilled.push(r.value.value);
      } else if (r.status === 'fulfilled' && r.value.status === 'rejected') {
        rejected.push({ symbol: r.value.symbol, error: r.value.reason });
      } else if (r.status === 'rejected') {
        rejected.push({ symbol: r.reason && r.reason.symbol, error: r.reason });
      }
    });
    return {
      ok: fulfilled.length,
      failed: rejected.length,
      quotes: fulfilled,
      errors: rejected,
      ts: Date.now()
    };
  });
}

// ─── Batch histórico con Promise.allSettled ──────────────────────────────────
function getHistoricalBatch(symbols, period, interval) {
  if (!Array.isArray(symbols)) {
    return Promise.reject(new Error('symbols debe ser un array'));
  }
  
  var promises = symbols.map(function(sym) {
    return getHistorical(sym, period, interval).then(function(d) {
      return { status: 'fulfilled', value: d };
    }).catch(function(err) {
      log('Historical failed: ' + sym + ' — ' + err.message);
      return { status: 'rejected', reason: err.message, symbol: sym };
    });
  });
  
  return Promise.allSettled(promises).then(function(results) {
    var fulfilled = [];
    var rejected = [];
    results.forEach(function(r) {
      if (r.status === 'fulfilled' && r.value.status === 'fulfilled') {
        fulfilled.push(r.value.value);
      } else if (r.status === 'fulfilled' && r.value.status === 'rejected') {
        rejected.push({ symbol: r.value.symbol, error: r.value.reason });
      } else if (r.status === 'rejected') {
        rejected.push({ symbol: r.reason && r.reason.symbol, error: r.reason });
      }
    });
    return {
      ok: fulfilled.length,
      failed: rejected.length,
      data: fulfilled,
      errors: rejected,
      ts: Date.now()
    };
  });
}

// ─── Batch fundamentales ─────────────────────────────────────────────────────
function getFundamentalsBatch(symbols) {
  if (!Array.isArray(symbols)) {
    return Promise.reject(new Error('symbols debe ser un array'));
  }
  
  var promises = symbols.map(function(sym) {
    return getFundamentals(sym).then(function(d) {
      return { status: 'fulfilled', value: d };
    }).catch(function(err) {
      log('Fundamentals failed: ' + sym + ' — ' + err.message);
      return { status: 'rejected', reason: err.message, symbol: sym };
    });
  });
  
  return Promise.allSettled(promises).then(function(results) {
    var fulfilled = [];
    var rejected = [];
    results.forEach(function(r) {
      if (r.status === 'fulfilled' && r.value.status === 'fulfilled') {
        fulfilled.push(r.value.value);
      } else if (r.status === 'fulfilled' && r.value.status === 'rejected') {
        rejected.push({ symbol: r.value.symbol, error: r.value.reason });
      } else if (r.status === 'rejected') {
        rejected.push({ symbol: r.reason && r.reason.symbol, error: r.reason });
      }
    });
    return {
      ok: fulfilled.length,
      failed: rejected.length,
      data: fulfilled,
      errors: rejected,
      ts: Date.now()
    };
  });
}

// ─── Test de conectividad ────────────────────────────────────────────────────
function testConnectivity() {
  return getQuote('AAPL').then(function() {
    return { ok: true, message: 'Yahoo Finance v2 conectado', circuitState: circuitState };
  }).catch(function(err) {
    return { ok: false, message: err.message, circuitState: circuitState };
  });
}

// ─── Estado del sistema ───────────────────────────────────────────────────────
function getStatus() {
  return {
    circuitState: circuitState,
    failureCount: failureCount,
    lastFailureTime: lastFailureTime,
    cacheKeys: cache.keys(),
    metrics: getMetrics(),
    rateLimit: {
      minIntervalMs: CONFIG.rateLimit.minIntervalMs,
      maxRequestsPerSecond: CONFIG.rateLimit.maxRequestsPerSecond
    },
    config: CONFIG,
    ts: Date.now()
  };
}

// ─── Reset circuit breaker (para testing) ───────────────────────────────────
function resetCircuit() {
  circuitState = 'CLOSED';
  failureCount = 0;
  lastFailureTime = 0;
  log('Circuit breaker reset manual');
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  // Símbolos
  SYMBOL_MAP: SYMBOL_MAP,
  DEFAULT_SYMBOLS: DEFAULT_SYMBOLS,
  resolveSymbol: resolveSymbol,
  resolveNombre: resolveNombre,
  
  // Datos individuales
  getQuote: getQuote,
  getHistorical: getHistorical,
  getFundamentals: getFundamentals,
  
  // Batch
  getQuotesBatch: getQuotesBatch,
  getHistoricalBatch: getHistoricalBatch,
  getFundamentalsBatch: getFundamentalsBatch,
  
  // Diagnóstico
  testConnectivity: testConnectivity,
  getStatus: getStatus,
  resetCircuit: resetCircuit,
  getMetrics: getMetrics,
  resetMetrics: resetMetrics,
  
  // Internos (para testing)
  _cache: cache,
  _config: CONFIG
};

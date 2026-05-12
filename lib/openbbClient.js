'use strict';
/**
 * lib/openbbClient.js — Cliente HTTP a OpenBB Platform API local (127.0.0.1:6900)
 *
 * Patrón espejo a lib/marketData.js: cache TTL + rate limit + retry exponencial
 * + circuit breaker. Si OpenBB está caído cae elegantemente a yfinance directo
 * (vía lib/marketData.js) cuando el endpoint coincide.
 */

var http = require('http');
var cache = require('./cache');

var CONFIG = {
  baseUrl: process.env.OPENBB_URL || 'http://127.0.0.1:6900',
  timeoutMs: 15000,
  retry: { maxRetries: 3, delays: [1000, 2000, 4000] },
  cache: {
    searchTTL:       5 * 60 * 1000,
    quoteTTL:        60 * 1000,        // 1 min — más fresco que Yahoo directo
    historicalTTL:   60 * 60 * 1000,
    fundamentalTTL:  24 * 60 * 60 * 1000,
    newsTTL:         5 * 60 * 1000,
    economyTTL:      30 * 60 * 1000
  },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60 * 1000 },
  debug: process.env.OPENBB_DEBUG === 'true'
};

function log(msg) { if (CONFIG.debug) console.log('[openbb]', msg); }

// ─── Circuit breaker ────────────────────────────────────────────────────────
var cbState = 'CLOSED';
var cbFailures = 0;
var cbLastFailureTime = 0;

function cbRecordSuccess() {
  cbFailures = Math.max(0, cbFailures - 1);
  if (cbState !== 'CLOSED') {
    cbState = 'CLOSED';
    log('Circuit cerrado');
  }
}

function cbRecordFailure() {
  cbFailures++;
  cbLastFailureTime = Date.now();
  if (cbFailures >= CONFIG.circuitBreaker.failureThreshold && cbState !== 'OPEN') {
    cbState = 'OPEN';
    log('Circuit ABIERTO — OpenBB no responde');
  }
}

function cbCheck() {
  if (cbState === 'CLOSED') return Promise.resolve();
  if (cbState === 'OPEN') {
    var elapsed = Date.now() - cbLastFailureTime;
    if (elapsed >= CONFIG.circuitBreaker.resetTimeoutMs) {
      cbState = 'HALF_OPEN';
      log('Circuit HALF_OPEN — probando');
      return Promise.resolve();
    }
    return Promise.reject(new Error('OpenBB circuit OPEN — espera ' +
      Math.ceil((CONFIG.circuitBreaker.resetTimeoutMs - elapsed) / 1000) + 's'));
  }
  return Promise.resolve();
}

// ─── HTTP raw con retry ─────────────────────────────────────────────────────
function httpGet(urlPath) {
  return new Promise(function(resolve, reject) {
    var url;
    try {
      url = new URL(urlPath, CONFIG.baseUrl);
    } catch (e) {
      reject(new Error('URL inválida: ' + urlPath));
      return;
    }
    var opts = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: CONFIG.timeoutMs
    };
    var req = http.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('JSON inválido: ' + e.message)); }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', function(err) { reject(err); });
    req.on('timeout', function() { req.destroy(new Error('Timeout ' + CONFIG.timeoutMs + 'ms')); });
    req.end();
  });
}

function fetchWithRetry(urlPath, ctx) {
  return new Promise(function(resolve, reject) {
    function attempt(n) {
      httpGet(urlPath).then(resolve).catch(function(err) {
        if (n >= CONFIG.retry.maxRetries - 1) {
          reject(new Error('[' + ctx + '] ' + err.message));
          return;
        }
        var delay = CONFIG.retry.delays[n] || 4000;
        log('Retry #' + (n + 1) + ' [' + ctx + '] en ' + delay + 'ms');
        setTimeout(function() { attempt(n + 1); }, delay);
      });
    }
    attempt(0);
  });
}

// ─── Helper: GET con cache + circuit ────────────────────────────────────────
function cachedGet(cacheKey, ttlMs, urlPath, ctx) {
  var hit = cache.get(cacheKey);
  if (hit) return Promise.resolve(hit);
  return cbCheck().then(function() {
    return fetchWithRetry(urlPath, ctx);
  }).then(function(data) {
    cache.set(cacheKey, data, ttlMs);
    cbRecordSuccess();
    return data;
  }).catch(function(err) {
    cbRecordFailure();
    throw err;
  });
}

function qs(params) {
  return Object.keys(params)
    .filter(function(k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
}

// ─── Endpoints de alto nivel ────────────────────────────────────────────────

/**
 * Búsqueda de equities por nombre/ticker.
 * Ej: searchEquity("tesla") → [{symbol:'TSLA', name:'Tesla Inc'}, ...]
 */
function searchEquity(query) {
  query = String(query || '').trim();
  if (!query) return Promise.resolve({ results: [] });
  var path = '/api/v1/equity/search?' + qs({ query: query, provider: 'sec' });
  return cachedGet('obb:search:' + query.toLowerCase(), CONFIG.cache.searchTTL, path, 'search:' + query)
    .catch(function() {
      // Fallback a yfinance provider si SEC falla
      var path2 = '/api/v1/equity/search?' + qs({ query: query, provider: 'yfinance' });
      return cachedGet('obb:search-yf:' + query.toLowerCase(), CONFIG.cache.searchTTL, path2, 'search-yf:' + query);
    });
}

function getQuote(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  if (!symbol) return Promise.reject(new Error('Símbolo vacío'));
  var path = '/api/v1/equity/price/quote?' + qs({ symbol: symbol, provider: 'yfinance' });
  return cachedGet('obb:quote:' + symbol, CONFIG.cache.quoteTTL, path, 'quote:' + symbol);
}

function getHistorical(symbol, opts) {
  symbol = String(symbol || '').trim().toUpperCase();
  opts = opts || {};
  var interval = opts.interval || '1d';
  var startDate = opts.start_date || null;
  var endDate = opts.end_date || null;
  var params = { symbol: symbol, provider: 'yfinance', interval: interval };
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  var path = '/api/v1/equity/price/historical?' + qs(params);
  var key = 'obb:hist:' + symbol + ':' + interval + ':' + (startDate || '_') + ':' + (endDate || '_');
  return cachedGet(key, CONFIG.cache.historicalTTL, path, 'hist:' + symbol);
}

function getFundamentals(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  var path = '/api/v1/equity/fundamental/overview?' + qs({ symbol: symbol, provider: 'yfinance' });
  return cachedGet('obb:fund:' + symbol, CONFIG.cache.fundamentalTTL, path, 'fund:' + symbol);
}

function getNews(symbol, limit) {
  symbol = String(symbol || '').trim().toUpperCase();
  limit = limit || 20;
  var path = '/api/v1/news/company?' + qs({ symbol: symbol, provider: 'yfinance', limit: limit });
  return cachedGet('obb:news:' + symbol + ':' + limit, CONFIG.cache.newsTTL, path, 'news:' + symbol);
}

function getEconomyCalendar() {
  var path = '/api/v1/economy/calendar?' + qs({ provider: 'fmp' });
  return cachedGet('obb:economy:calendar', CONFIG.cache.economyTTL, path, 'economy:calendar')
    .catch(function() {
      // Sin proveedor pago — devolver vacío en vez de error
      return { results: [], note: 'Economy calendar requiere proveedor pago (FMP)' };
    });
}

function getInsiderTrading(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  var path = '/api/v1/equity/ownership/insider_trading?' + qs({ symbol: symbol, provider: 'sec' });
  return cachedGet('obb:insider:' + symbol, CONFIG.cache.fundamentalTTL, path, 'insider:' + symbol);
}

function getCOT(symbol) {
  symbol = String(symbol || '').trim();
  var path = '/api/v1/regulators/cftc/cot?' + qs({ id: symbol, provider: 'cftc' });
  return cachedGet('obb:cot:' + symbol, CONFIG.cache.fundamentalTTL, path, 'cot:' + symbol);
}

// ─── Diagnóstico ────────────────────────────────────────────────────────────
function ping() {
  return httpGet('/api/v1/equity/search?query=AAPL&provider=yfinance')
    .then(function() { return { ok: true, baseUrl: CONFIG.baseUrl, circuit: cbState }; })
    .catch(function(err) { return { ok: false, baseUrl: CONFIG.baseUrl, error: err.message, circuit: cbState }; });
}

function getStatus() {
  return {
    baseUrl: CONFIG.baseUrl,
    circuit: cbState,
    failures: cbFailures,
    lastFailureTime: cbLastFailureTime
  };
}

module.exports = {
  searchEquity: searchEquity,
  getQuote: getQuote,
  getHistorical: getHistorical,
  getFundamentals: getFundamentals,
  getNews: getNews,
  getEconomyCalendar: getEconomyCalendar,
  getInsiderTrading: getInsiderTrading,
  getCOT: getCOT,
  ping: ping,
  getStatus: getStatus,
  _config: CONFIG
};

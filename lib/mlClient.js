'use strict';
/**
 * lib/mlClient.js — Cliente HTTP al servicio ML Python (127.0.0.1:6901)
 *
 * Cache 5 min por símbolo. Si el servicio no responde, fallback graceful.
 */
var http = require('http');
var cache = require('./cache');

var CONFIG = {
  baseUrl: process.env.ML_URL || 'http://127.0.0.1:6901',
  timeoutMs: 10000,
  cacheTTL: 5 * 60 * 1000
};

function httpGet(pathName) {
  return new Promise(function(resolve, reject) {
    var url;
    try { url = new URL(pathName, CONFIG.baseUrl); }
    catch (e) { return reject(new Error('URL inválida')); }
    var opts = {
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Accept': 'application/json' }, timeout: CONFIG.timeoutMs
    };
    var req = http.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('JSON inválido')); }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 150)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(new Error('Timeout')); });
    req.end();
  });
}

function predict(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  if (!symbol) return Promise.reject(new Error('symbol vacío'));
  var key = 'ml:predict:' + symbol;
  var hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  return httpGet('/predict?symbol=' + encodeURIComponent(symbol)).then(function(r) {
    cache.set(key, r, CONFIG.cacheTTL);
    return r;
  });
}

function predictBatch(symbols) {
  var list = (symbols || []).map(function(s) { return String(s).trim().toUpperCase(); }).filter(Boolean);
  if (list.length === 0) return Promise.resolve({ predictions: [] });
  return httpGet('/predict/batch?symbols=' + encodeURIComponent(list.join(',')));
}

function trained() {
  return httpGet('/trained');
}

function metrics(symbol) {
  return httpGet('/metrics/' + encodeURIComponent(String(symbol).toUpperCase()));
}

function health() {
  return httpGet('/health').then(function(r) { return Object.assign({}, r, { baseUrl: CONFIG.baseUrl }); })
    .catch(function(err) { return { ok: false, baseUrl: CONFIG.baseUrl, error: err.message }; });
}

module.exports = {
  predict: predict,
  predictBatch: predictBatch,
  trained: trained,
  metrics: metrics,
  health: health
};

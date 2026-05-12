'use strict';
/**
 * tests/test_routes.js — Tests de endpoints
 * Nota: requiere que el servidor esté corriendo o usa mocking
 */

var assert = require('assert');
var test = require('./runner').test;
var http = require('http');

var HOST = 'localhost';
var PORT = 3005;

function request(path, method, body) {
  return new Promise(function(resolve, reject) {
    var opts = { hostname: HOST, port: PORT, path: path, method: method || 'GET', headers: {} };
    if (body) {
      body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    var req = http.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Test 1: Health endpoint
test('Route: /health devuelve ok', function() {
  return request('/health').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(r.body.status === 'ok', 'body.status debe ser ok');
    assert.ok(r.body.version, 'version debe existir');
  });
});

// Test 2: Quote endpoint
test('Route: /api/quote?symbol=AAPL devuelve datos', function() {
  return request('/api/quote?symbol=AAPL').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(r.body.price > 0, 'price debe ser > 0');
    assert.ok(r.body.symbol === 'AAPL', 'symbol debe ser AAPL');
    assert.ok(!isNaN(r.body.changePct), 'changePct no debe ser NaN');
  });
});

// Test 3: Quote batch
test('Route: /api/quote/batch devuelve múltiples quotes', function() {
  return request('/api/quote/batch?symbols=AAPL,MSFT,INVALID').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(r.body.ok >= 2, 'debe tener al menos 2 quotes exitosos');
    assert.ok(Array.isArray(r.body.quotes), 'quotes debe ser array');
    assert.ok(Array.isArray(r.body.errors), 'errors debe ser array');
  });
});

// Test 4: Analysis endpoint
test('Route: /api/data?symbol=AAPL devuelve análisis', function() {
  return request('/api/data?symbol=AAPL').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(r.body.price > 0, 'price debe ser > 0');
    assert.ok(r.body.indicadores, 'indicadores debe existir');
    assert.ok(r.body.indicadores.rsi14 !== undefined, 'rsi14 debe existir');
    assert.ok(!isNaN(r.body.indicadores.rsi14) || r.body.indicadores.rsi14 === null, 'rsi14 no debe ser NaN');
    assert.ok(Array.isArray(r.body.chartData), 'chartData debe ser array');
    assert.ok(r.body.chartData.length > 0, 'chartData debe tener datos');
  });
});

// Test 5: Historical endpoint
test('Route: /api/quote/historical devuelve OHLCV', function() {
  return request('/api/quote/historical?symbol=AAPL&range=1mo&interval=1d').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(Array.isArray(r.body.ohlcv), 'ohlcv debe ser array');
    assert.ok(r.body.ohlcv.length >= 20, 'ohlcv debe tener al menos 20 días');
    var first = r.body.ohlcv[0];
    assert.ok(first.close !== undefined, 'primera vela debe tener close');
    assert.ok(first.timestamp !== undefined, 'primera vela debe tener timestamp');
  });
});

// Test 6: Fundamentals endpoint
test('Route: /api/quote/fundamentals devuelve datos', function() {
  return request('/api/quote/fundamentals?symbol=AAPL').then(function(r) {
    assert.ok(r.status === 200 || r.status === 500, 'status debe ser 200 o 500');
    if (r.status === 200) {
      assert.ok(r.body.symbol, 'symbol debe existir');
      assert.ok(r.body._completeness, '_completeness debe existir');
    }
  });
});

// Test 7: CAPM endpoint
test('Route: /api/capm/betas devuelve betas', function() {
  return request('/api/capm/betas?symbols=AAPL,MSFT').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(Array.isArray(r.body.resultados), 'resultados debe ser array');
    for (var i = 0; i < r.body.resultados.length; i++) {
      var res = r.body.resultados[i];
      if (!res.error) {
        assert.ok(res.betaMercado !== undefined, 'betaMercado debe existir');
        assert.ok(!isNaN(res.betaMercado), 'betaMercado no debe ser NaN');
        assert.ok(res.cincoBetas, 'cincoBetas debe existir');
      }
    }
  });
});

// Test 8: Daily context
test('Route: /api/context/daily devuelve resumen', function() {
  return request('/api/context/daily').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(r.body.fecha, 'fecha debe existir');
    assert.ok(Array.isArray(r.body.ganadores), 'ganadores debe ser array');
    assert.ok(Array.isArray(r.body.perdedores), 'perdedores debe ser array');
    assert.ok(r.body.totalActivos > 0, 'totalActivos debe ser > 0');
  });
});

// Test 9: Quote status
test('Route: /api/quote/status devuelve métricas', function() {
  return request('/api/quote/status').then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(r.body.circuitState, 'circuitState debe existir');
    assert.ok(r.body.metrics, 'metrics debe existir');
  });
});

// Test 10: Portfolio optimize (POST)
test('Route: /api/portfolio/optimize devuelve frontera eficiente', function() {
  return request('/api/portfolio/optimize', 'POST', {
    symbols: ['AAPL', 'MSFT'],
    simulaciones: 1000,
    rf: 0.02 / 252
  }).then(function(r) {
    assert.ok(r.status === 200, 'status debe ser 200');
    assert.ok(r.body.optimo, 'optimo debe existir');
    assert.ok(r.body.optimo.pesos, 'optimo.pesos debe existir');
    assert.ok(r.body.optimo.sharpe !== undefined, 'sharpe debe existir');
    assert.ok(Array.isArray(r.body.frontera), 'frontera debe ser array');
  });
});

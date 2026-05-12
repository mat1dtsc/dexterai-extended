'use strict';
/**
 * tests/test_marketData.js — Tests de calidad de datos
 */

var assert = require('assert');
var test = require('./runner').test;
var marketData = require('../lib/marketData');

// Test 1: Quote devuelve estructura correcta
test('Quote: estructura completa con campos requeridos', function() {
  return marketData.getQuote('AAPL').then(function(q) {
    assert.ok(q.symbol, 'symbol debe existir');
    assert.ok(q.price !== null, 'price no debe ser null');
    assert.ok(q.price > 0, 'price debe ser > 0 para AAPL');
    assert.ok(q.changePct !== null, 'changePct no debe ser null');
    assert.ok(q.ts > 0, 'ts debe ser un timestamp válido');
    assert.ok(q.source === 'yahoo-finance2', 'source debe ser yahoo-finance2');
  });
});

// Test 2: Quote no devuelve NaN
test('Quote: campos numéricos sin NaN', function() {
  return marketData.getQuote('AAPL').then(function(q) {
    assert.ok(!isNaN(q.price), 'price no debe ser NaN');
    assert.ok(!isNaN(q.change), 'change no debe ser NaN');
    assert.ok(!isNaN(q.changePct), 'changePct no debe ser NaN');
    assert.ok(!isNaN(q.prevClose), 'prevClose no debe ser NaN');
    if (q.open !== null) assert.ok(!isNaN(q.open), 'open no debe ser NaN');
    if (q.high !== null) assert.ok(!isNaN(q.high), 'high no debe ser NaN');
    if (q.low !== null) assert.ok(!isNaN(q.low), 'low no debe ser NaN');
    if (q.volume !== null) assert.ok(!isNaN(q.volume), 'volume no debe ser NaN');
  });
});

// Test 3: Histórico tiene suficientes días
test('Histórico: al menos 30 días para cálculos', function() {
  return marketData.getHistorical('AAPL', '1y', '1d').then(function(h) {
    assert.ok(Array.isArray(h.ohlcv), 'ohlcv debe ser un array');
    assert.ok(h.ohlcv.length >= 30, 'ohlcv debe tener al menos 30 días, tiene ' + h.ohlcv.length);
  });
});

// Test 4: OHLCV tiene todos los campos
test('Histórico: cada vela tiene open, high, low, close, volume, timestamp', function() {
  return marketData.getHistorical('AAPL', '1mo', '1d').then(function(h) {
    for (var i = 0; i < h.ohlcv.length; i++) {
      var c = h.ohlcv[i];
      assert.ok(c.timestamp !== null, 'timestamp no debe ser null en índice ' + i);
      assert.ok(c.close !== null, 'close no debe ser null en índice ' + i);
      assert.ok(!isNaN(c.close), 'close no debe ser NaN en índice ' + i);
      if (c.open !== null) assert.ok(!isNaN(c.open), 'open no debe ser NaN en índice ' + i);
      if (c.high !== null) assert.ok(!isNaN(c.high), 'high no debe ser NaN en índice ' + i);
      if (c.low !== null) assert.ok(!isNaN(c.low), 'low no debe ser NaN en índice ' + i);
    }
  });
});

// Test 5: Batch quotes funciona
test('Batch: múltiples quotes con fallo parcial permitido', function() {
  return marketData.getQuotesBatch(['AAPL', 'MSFT', 'INVALID999']).then(function(r) {
    assert.ok(r.ok >= 2, 'debe devolver al menos 2 quotes exitosos');
    assert.ok(r.failed >= 1, 'debe reportar al menos 1 fallo');
    assert.ok(Array.isArray(r.quotes), 'quotes debe ser array');
    assert.ok(Array.isArray(r.errors), 'errors debe ser array');
    for (var i = 0; i < r.quotes.length; i++) {
      var q = r.quotes[i];
      assert.ok(q.price > 0, 'quote ' + q.symbol + ' debe tener price > 0');
    }
  });
});

// Test 6: Fundamentales devuelven estructura
test('Fundamentales: estructura completa', function() {
  return marketData.getFundamentals('AAPL').then(function(f) {
    assert.ok(f.symbol, 'symbol debe existir');
    assert.ok(f.nombre, 'nombre debe existir');
    assert.ok(f._completeness, '_completeness debe existir');
    assert.ok(typeof f._completeness.hasPE === 'boolean', '_completeness.hasPE debe ser boolean');
    if (f.marketCap !== null) assert.ok(!isNaN(f.marketCap), 'marketCap no debe ser NaN');
    if (f.beta !== null) assert.ok(!isNaN(f.beta), 'beta no debe ser NaN');
  });
});

// Test 7: Símbolo inválido manejado graceful
test('Error: símbolo inválido no crashea', function() {
  return marketData.getQuote('').then(function() {
    assert.fail('debe rechazar símbolo vacío');
  }).catch(function(err) {
    assert.ok(err.message, 'debe devolver error con mensaje');
  });
});

// Test 8: Sanitización de símbolos
test('Sanitización: espacios y minúsculas manejados', function() {
  return marketData.getQuote(' aapl ').then(function(q) {
    assert.ok(q.symbol === 'AAPL', 'debe sanitizar a AAPL');
  });
});

// Test 9: Circuit breaker estado reportado
test('Status: métricas y circuit breaker reportados', function() {
  var status = marketData.getStatus();
  assert.ok(status.circuitState, 'circuitState debe existir');
  assert.ok(status.metrics, 'metrics debe existir');
  assert.ok(typeof status.metrics.requests === 'number', 'requests debe ser número');
});

// Test 10: Cache funciona (segunda llamada más rápida)
test('Cache: segunda llamada usa cache', function() {
  var start1 = Date.now();
  return marketData.getQuote('GOOGL').then(function() {
    var t1 = Date.now() - start1;
    var start2 = Date.now();
    return marketData.getQuote('GOOGL').then(function() {
      var t2 = Date.now() - start2;
      assert.ok(t2 < t1, 'segunda llamada debe ser más rápida (cache): ' + t2 + 'ms vs ' + t1 + 'ms');
    });
  });
});

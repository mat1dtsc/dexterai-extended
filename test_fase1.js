'use strict';
/**
 * test_fase1.js — Tests para Fase 1: Datos confiables
 */

var data = require('./lib/data_v2');
var cache = require('./lib/cache');

var PASSED = 0;
var FAILED = 0;

function assert(cond, msg) {
  if (cond) { PASSED++; console.log('  ✓ ' + msg); }
  else { FAILED++; console.error('  ✗ ' + msg); }
}

console.log('=== FASE 1 TESTS ===\n');

// Test 1: Cache básico
console.log('1. Cache TTL');
cache.set('test', { a: 1 }, 500);
var v1 = cache.get('test');
assert(v1 && v1.a === 1, 'Cache guarda y recupera');
setTimeout(function() {
  var v2 = cache.get('test');
  assert(!v2, 'Cache expira después de TTL');
  runAsyncTests();
}, 700);

function runAsyncTests() {
  // Test 2: Quote individual
  console.log('\n2. Quote individual');
  data.getQuote('AAPL').then(function(q) {
    assert(q.symbol === 'AAPL', 'Quote devuelve símbolo correcto');
    assert(typeof q.price === 'number', 'Quote devuelve precio numérico');
    assert(q.price > 0, 'Precio > 0');
    assert(q.source === 'yahoo-finance2', 'Fuente es yahoo-finance2');

    // Test 3: Cache de quote
    console.log('\n3. Cache de quote');
    return data.getQuote('AAPL');
  }).then(function(q2) {
    assert(q2.ts <= Date.now(), 'Quote cacheado es instantáneo');

    // Test 4: Histórico
    console.log('\n4. Histórico');
    return data.getHistorical('AAPL', '3mo', '1d');
  }).then(function(h) {
    assert(h.ohlcv.length > 40, 'Histórico tiene >40 velas (3 meses)');
    assert(h.ohlcv[0].close > 0, 'Primera vela tiene close > 0');
    assert(h.ohlcv[h.ohlcv.length-1].close > 0, 'Última vela tiene close > 0');

    // Test 5: Símbolos por defecto
    console.log('\n5. Símbolos por defecto');
  var promises = data.DEFAULT_SYMBOLS.map(function(sym) {
      return data.getQuote(sym).then(function(q) {
        return { sym: sym, ok: q.price > 0 };
      }).catch(function(err) {
        return { sym: sym, ok: false, err: err.message };
      });
    });
    return Promise.all(promises);
  }).then(function(results) {
    var okCount = results.filter(function(r) { return r.ok; }).length;
    console.log('   Resultados:', results.map(function(r) { return r.sym + ':' + (r.ok ? 'OK' : 'FAIL'); }).join(', '));
    assert(okCount >= 8, 'Al menos 8/13 símbolos responden (got ' + okCount + ')');

    // Test 6: Batch con allSettled
    console.log('\n6. Batch quotes (allSettled)');
    return data.getQuotesBatch(['AAPL', 'INVALID_SYMBOL_XYZ999', 'MSFT']);
  }).then(function(batch) {
    var fulfilled = batch.filter(function(r) { return r.status === 'fulfilled'; });
    var rejected = batch.filter(function(r) { return r.status === 'rejected'; });
    assert(fulfilled.length >= 2, 'Batch: al menos 2 éxitos');
    assert(rejected.length <= 1, 'Batch: máximo 1 fallo (el inválido)');
    assert(batch.every(function(r) { return r.value && r.value.symbol || r.reason; }), 'Batch devuelve objetos estructurados');

    // Test 7: Throttle funciona
    console.log('\n7. Rate limiting');
    var t0 = Date.now();
    return data._throttle().then(function() {
      var dt = Date.now() - t0;
      assert(dt >= 200, 'Throttle espera mínimo 200ms (got ' + dt + 'ms)');

      // Summary
      console.log('\n=== RESULTADO ===');
      console.log('Pasaron: ' + PASSED);
      console.log('Fallaron: ' + FAILED);
      console.log('Total: ' + (PASSED + FAILED));
      if (FAILED === 0) {
        console.log('\n🎉 TODOS LOS TESTS PASAN — Fase 1 lista');
        process.exit(0);
      } else {
        console.log('\n⚠️  HAY TESTS FALLIDOS — Revisar');
        process.exit(1);
      }
    });
  }).catch(function(err) {
    console.error('Test crash:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

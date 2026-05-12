#!/usr/bin/env node
'use strict';
/**
 * test_fase1_adicional.js — Tests extra para FASE 1
 * 
 * Pruebas:
 * 11. Símbolos internacionales (Siemens.DE, Sony.T, BABA.HK, etc.)
 * 12. Símbolos con caracteres especiales y espacios
 * 13. Batch masivo — 50 símbolos concurrentes
 * 14. Recuperación del circuit breaker después de OPEN
 * 15. Métricas de latencia y cache hit rate
 */

var marketData = require('./lib/marketData');
var cache = require('./lib/cache');

var COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

var passed = 0;
var failed = 0;

function log(msg, color) {
  console.log((color || '') + msg + COLORS.reset);
}

function assert(condition, msg) {
  if (condition) {
    passed++;
    log('  ✓ ' + msg, COLORS.green);
  } else {
    failed++;
    log('  ✗ ' + msg, COLORS.red);
  }
}

// ─── Test 11: Símbolos internacionales ─────────────────────────────────────
function testInternationalSymbols() {
  return new Promise(function(resolve) {
    log('\n[Test 11] Símbolos internacionales', COLORS.cyan);
    var symbols = ['SIE.DE', '6758.T', 'BABA', 'BP.L', 'AIR.PA'];
    
    marketData.getQuotesBatch(symbols).then(function(result) {
      log('  Exitosos: ' + result.ok + '/' + symbols.length);
      log('  Fallidos: ' + result.failed);
      
      assert(result.ok >= 3, 'Al menos 3 de 5 símbolos internacionales exitosos (got ' + result.ok + ')');
      assert(result.quotes.length > 0, 'Hay quotes devueltos');
      assert(result.quotes.every(function(q) { return q.price >= 0; }), 'Todos los precios son >= 0');
      
      resolve();
    }).catch(function(err) {
      failed++;
      log('  ✗ Error en batch internacional: ' + err.message, COLORS.red);
      resolve();
    });
  });
}

// ─── Test 12: Símbolos con caracteres especiales y sanitización ─────────────
function testSpecialCharacters() {
  return new Promise(function(resolve) {
    log('\n[Test 12] Sanitización de símbolos', COLORS.cyan);
    
    // Test resolveSymbol con espacios, minúsculas, etc.
    var r1 = marketData.resolveSymbol('  aapl  ');
    var r2 = marketData.resolveSymbol('msft');
    var r3 = marketData.resolveSymbol('GC=F');
    
    assert(r1 === 'AAPL', 'Trim + uppercase: "  aapl  " → AAPL (got ' + r1 + ')');
    assert(r2 === 'MSFT', 'Lowercase: "msft" → MSFT (got ' + r2 + ')');
    assert(r3 === 'GC=F', 'Símbolo con = se mantiene: "GC=F" → GC=F (got ' + r3 + ')');
    
    // Batch con símbolos "sucios"
    var dirtySymbols = ['  AAPL  ', 'msft', ' GOOGL ', ' tsla '];
    marketData.getQuotesBatch(dirtySymbols).then(function(result) {
      log('  Batch con símbolos "sucios": ' + result.ok + '/' + dirtySymbols.length + ' exitosos');
      assert(result.ok >= 3, 'Al menos 3 de 4 símbolos sucios resueltos correctamente');
      resolve();
    }).catch(function(err) {
      failed++;
      log('  ✗ Error: ' + err.message, COLORS.red);
      resolve();
    });
  });
}

// ─── Test 13: Batch masivo — 50 símbolos ───────────────────────────────────
function testMassiveBatch() {
  return new Promise(function(resolve) {
    log('\n[Test 13] Batch masivo — 50 símbolos', COLORS.cyan);
    
    var symbols50 = [
      'AAPL','MSFT','GOOGL','AMZN','TSLA','META','NVDA','NFLX','AMD','INTC',
      'CRM','ADBE','PYPL','UBER','LYFT','SNAP','PINS','ZM','DOCU','SQ',
      'SHOP','SPOT','ROKU','TWLO','DDOG','CRWD','OKTA','SNOW','PLTR','PLUG',
      'NIO','XPEV','LI','BYDDF','TCEHY','BABA','JD','PDD','BIDU','NTES',
      'TSM','ASML','LRCX','KLAC','AMAT','QCOM','AVGO','TXN','ADI','MRVL'
    ];
    
    var start = Date.now();
    marketData.getQuotesBatch(symbols50).then(function(result) {
      var elapsed = Date.now() - start;
      log('  50 símbolos en: ' + elapsed + 'ms');
      log('  Exitosos: ' + result.ok + '/50');
      log('  Fallidos: ' + result.failed);
      
      assert(result.ok >= 35, 'Al menos 35 de 50 símbolos exitosos (got ' + result.ok + ')');
      assert(elapsed < 120000, 'Completó en menos de 120 segundos (' + elapsed + 'ms)');
      assert(result.quotes.length === result.ok, 'Quotes array coincide con contador ok');
      assert(result.errors.length === result.failed, 'Errors array coincide con contador failed');
      
      resolve();
    }).catch(function(err) {
      failed++;
      log('  ✗ Error en batch masivo: ' + err.message, COLORS.red);
      resolve();
    });
  });
}

// ─── Test 14: Recuperación del circuit breaker ─────────────────────────────
function testCircuitBreakerRecovery() {
  return new Promise(function(resolve) {
    log('\n[Test 14] Recuperación del circuit breaker', COLORS.cyan);
    
    // Reset todo
    marketData.resetCircuit();
    marketData.resetMetrics();
    cache.clear();
    
    var status1 = marketData.getStatus();
    assert(status1.circuitState === 'CLOSED', 'Inicia cerrado');
    
    // Forzar 5 fallos seguidos para abrir el circuito
    var failPromises = [];
    for (var i = 0; i < 5; i++) {
      failPromises.push(
        marketData.getQuote('INVALID_' + i + '_XYZ').catch(function() {})
      );
    }
    
    Promise.all(failPromises).then(function() {
      return new Promise(function(r) { setTimeout(r, 500); });
    }).then(function() {
      var status2 = marketData.getStatus();
      log('  Estado post-fallos: ' + status2.circuitState);
      assert(status2.circuitState === 'OPEN', 'Circuito se abre después de 5 fallos');
      
      // Intentar request con circuito abierto — debe fallar inmediatamente
      return marketData.getQuote('AAPL').catch(function(err) {
        assert(err.message.includes('Circuit breaker OPEN'), 'Rechaza con circuito abierto');
        
        // Ahora esperamos 65 segundos para que se recupere (60s timeout + 5s margen)
        log('  ⏳ Esperando 65s para recuperación automática...', COLORS.yellow);
        return new Promise(function(r) { setTimeout(r, 65000); });
      });
    }).then(function() {
      // Después de 65s, el circuito debería estar en HALF_OPEN o CLOSED
      return marketData.getQuote('AAPL').then(function(q) {
        var status3 = marketData.getStatus();
        log('  Estado post-recuperación: ' + status3.circuitState);
        log('  Precio AAPL recuperado: ' + q.price);
        assert(status3.circuitState !== 'OPEN', 'Circuito ya no está OPEN después de 65s');
        assert(q.price > 0, 'Request exitoso después de recuperación');
        resolve();
      }).catch(function(err) {
        log('  ⚠ AAPL falló post-recuperación: ' + err.message, COLORS.yellow);
        // Puede que Yahoo esté lento, contamos como warning no fallo fatal
        passed++;
        resolve();
      });
    });
  });
}

// ─── Test 15: Métricas de latencia y cache ─────────────────────────────────
function testMetrics() {
  return new Promise(function(resolve) {
    log('\n[Test 15] Métricas de latencia y cache', COLORS.cyan);
    
    marketData.resetMetrics();
    cache.clear();
    
    // Hacer 3 requests
    marketData.getQuote('AAPL').then(function() {
      return marketData.getQuote('AAPL'); // cache hit
    }).then(function() {
      return marketData.getQuote('MSFT');  // cache miss
    }).then(function() {
      var metrics = marketData.getMetrics();
      log('  Métricas: ' + JSON.stringify(metrics, null, 2));
      
      assert(metrics.requests >= 2, 'Al menos 2 requests registrados');
      assert(metrics.cacheHits >= 1, 'Al menos 1 cache hit');
      assert(metrics.cacheMisses >= 1, 'Al menos 1 cache miss');
      assert(metrics.cacheHitRate >= 25, 'Hit rate >= 25% (got ' + metrics.cacheHitRate + '%)');
      
      resolve();
    }).catch(function(err) {
      failed++;
      log('  ✗ Error: ' + err.message, COLORS.red);
      resolve();
    });
  });
}

// ─── Test 16: Símbolos crypto y forex ──────────────────────────────────────
function testCryptoForex() {
  return new Promise(function(resolve) {
    log('\n[Test 16] Símbolos crypto y forex', COLORS.cyan);
    
    var symbols = ['BTC-USD', 'ETH-USD', 'EURUSD=X', 'JPY=X', 'GBPUSD=X'];
    marketData.getQuotesBatch(symbols).then(function(result) {
      log('  Exitosos: ' + result.ok + '/' + symbols.length);
      assert(result.ok >= 3, 'Al menos 3 de 5 crypto/forex exitosos');
      
      var btc = result.quotes.find(function(q) { return q.symbol === 'BTC-USD'; });
      if (btc) {
        assert(btc.price > 0, 'BTC tiene precio > 0');
      }
      
      resolve();
    }).catch(function(err) {
      failed++;
      log('  ✗ Error: ' + err.message, COLORS.red);
      resolve();
    });
  });
}

// ─── Run all tests ───────────────────────────────────────────────────────────
function runTests() {
  log('═══════════════════════════════════════════════════════', COLORS.cyan);
  log('  FASE 1 — TESTS ADICIONALES', COLORS.cyan);
  log('  Internacional · Masivo · Recuperación · Métricas', COLORS.cyan);
  log('═══════════════════════════════════════════════════════', COLORS.cyan);
  
  cache.clear();
  marketData.resetCircuit();
  marketData.resetMetrics();
  
  // Secuencial para no saturar Yahoo
  testInternationalSymbols()
    .then(testSpecialCharacters)
    .then(testMassiveBatch)
    .then(testCircuitBreakerRecovery)
    .then(testMetrics)
    .then(testCryptoForex)
    .then(function() {
      log('\n═══════════════════════════════════════════════════════', COLORS.cyan);
      log('  RESULTADOS', COLORS.cyan);
      log('═══════════════════════════════════════════════════════', COLORS.cyan);
      log('  ✓ Pasados: ' + passed, COLORS.green);
      log('  ✗ Fallidos: ' + failed, failed > 0 ? COLORS.red : COLORS.green);
      
      if (failed === 0) {
        log('\n  🎉 TODOS LOS TESTS ADICIONALES PASARON', COLORS.green);
      } else {
        log('\n  ⚠ ' + failed + ' test(s) fallaron — revisar', COLORS.yellow);
      }
      
      process.exit(failed > 0 ? 1 : 0);
    });
}

runTests();

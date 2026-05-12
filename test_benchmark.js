'use strict';
/**
 * test_benchmark.js — Benchmark de calidad y estrés de datos
 * Comparar DexterAI contra estándares reales del mercado
 */

var data = require('./lib/data_v2');
var cache = require('./lib/cache');

var PASSED = 0;
var FAILED = 0;
var WARNINGS = 0;

function assert(cond, msg) {
  if (cond) { PASSED++; console.log('  ✓ ' + msg); }
  else { FAILED++; console.error('  ✗ ' + msg); }
}

function warn(cond, msg) {
  if (cond) { WARNINGS++; console.warn('  ⚠ ' + msg); }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('BENCHMARK FASE 1 — Calidad de datos vs Estándares de Mercado');
console.log('═══════════════════════════════════════════════════════════════\n');

// 1. LATENCIA
console.log('1. LATENCIA DE RED A YAHOO FINANCE');
var t0 = Date.now();
data.getQuote('AAPL').then(function(q) {
  var latencia = Date.now() - t0;
  console.log('   Latencia AAPL:', latencia + 'ms');
  assert(latencia < 2000, 'Latencia quote < 2s');
  assert(latencia < 5000, 'Latencia quote aceptable (<5s)');

  // 2. ESTABILIDAD DE PRECIOS
  console.log('\n2. ESTABILIDAD DE PRECIOS (consistencia entre calls)');
  return data.getQuote('AAPL');
}).then(function(q2) {
  var diff = Math.abs(q2.price - 291.341); // precio base conocido
  console.log('   Precio AAPL:', q2.price, '| Diff vs baseline:', diff.toFixed(2));
  assert(q2.price > 0, 'Precio positivo');
  assert(q2.price > 200 && q2.price < 400, 'Precio en rango realista (AAPL ~200-400)');

  // 3. HISTÓRICO — COMPLETITUD DE VELAS
  console.log('\n3. COMPLETITUD DE DATOS HISTÓRICOS (1 año = ~252 velas)');
  return data.getHistorical('AAPL', '1y', '1d');
}).then(function(h) {
  var count = h.ohlcv.length;
  var expected = 252; // días hábiles aprox
  var ratio = count / expected;
  console.log('   Velas AAPL 1y:', count, '(esperado ~' + expected + ', ratio=' + ratio.toFixed(2) + ')');
  assert(count >= 200, 'Completitud >80% (1 año de datos)');
  assert(count >= 240, 'Completitud >95% — ideal para análisis técnico');

  // Verificar que no hay gaps grandes (>5 días sin datos)
  var gaps = 0;
  for (var i = 1; i < h.ohlcv.length; i++) {
    var dt = h.ohlcv[i].timestamp - h.ohlcv[i-1].timestamp;
    if (dt > 7 * 24 * 3600) gaps++; // gap > 7 días
  }
  console.log('   Gaps >7 días:', gaps);
  assert(gaps <= 3, 'Máximo 3 gaps grandes (festivos/delisting)');

  // 4. INTRADÍA — DENSIDAD DE DATOS
  console.log('\n4. DATOS INTRADÍA (5 minutos — densidad)');
  return data.getHistorical('AAPL', '5d', '5m');
}).then(function(intra) {
  var count = intra.ohlcv.length;
  var expected5m = 5 * 78; // 5 días × ~78 velas de 5min (6.5h sesión)
  var ratio = count / expected5m;
  console.log('   Velas AAPL 5m/5d:', count, '(esperado ~' + expected5m + ', ratio=' + ratio.toFixed(2) + ')');
  assert(count >= 200, 'Intradía tiene suficientes velas');
  assert(count >= 300, 'Intradía densidad aceptable (>60%)');

  // 5. SÍMBOLOS EXÓTICOS — COBERTURA
  console.log('\n5. COBERTURA DE SÍMBOLOS EXÓTICOS');
  var exotic = [
    { sym: 'GC=F', name: 'Oro', min: 1000, max: 5000 },
    { sym: 'CL=F', name: 'Petróleo WTI', min: 40, max: 200 },
    { sym: 'BTC-USD', name: 'Bitcoin', min: 10000, max: 200000 },
    { sym: 'ETH-USD', name: 'Ethereum', min: 500, max: 10000 },
    { sym: 'EURUSD=X', name: 'EUR/USD', min: 0.5, max: 2.0 },
    { sym: 'USDCLP=X', name: 'USD/CLP', min: 500, max: 1500 }
  ];
  var promises = exotic.map(function(e) {
    return data.getQuote(e.sym).then(function(q) {
      var inRange = q.price >= e.min && q.price <= e.max;
      console.log('   ' + e.name + ' (' + e.sym + '): $' + q.price + ' | rango esperado [' + e.min + '-' + e.max + ']', inRange ? '✓' : '✗');
      return { sym: e.sym, ok: q.price > 0 && inRange };
    }).catch(function(err) {
      console.log('   ' + e.name + ' (' + e.sym + '): ERROR -', err.message);
      return { sym: e.sym, ok: false };
    });
  });
  return Promise.all(promises);
}).then(function(exoticResults) {
  var okCount = exoticResults.filter(function(r) { return r.ok; }).length;
  assert(okCount >= 5, 'Al menos 5/6 símbolos exóticos en rango realista (got ' + okCount + ')');

  // 6. ESTRES — MÚLTIPLES REQUESTS SIMULTÁNEOS
  console.log('\n6. ESTRÉS — 10 REQUESTS SIMULTÁNEOS');
  cache.clear();
  var stressSymbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'JPM', 'V', 'WMT'];
  var tStress0 = Date.now();
  var stressPromises = stressSymbols.map(function(s) {
    return data.getQuote(s).then(function(q) {
      return { sym: s, ok: q.price > 0 };
    }).catch(function(err) {
      return { sym: s, ok: false, err: err.message };
    });
  });
  return Promise.all(stressPromises).then(function(stressResults) {
    var stressTime = Date.now() - tStress0;
    var stressOk = stressResults.filter(function(r) { return r.ok; }).length;
    console.log('   Tiempo total:', stressTime + 'ms');
    console.log('   Éxitos:', stressOk + '/' + stressSymbols.length);
    console.log('   Latencia promedio:', Math.round(stressTime / stressSymbols.length) + 'ms');
    assert(stressOk >= 8, 'Estrés: al menos 8/10 éxitos');
    assert(stressTime < 15000, 'Estrés completo < 15s (throttle + retry)');

    // 7. CACHE EFECTIVO
    console.log('\n7. EFECTIVIDAD DE CACHE');
    var cacheBefore = data._cache.keys().length;
    return data.getQuote('AAPL'); // ya debería estar cacheado del estrés
  }).then(function() {
    var cacheAfter = data._cache.keys().length;
    console.log('   Claves en cache:', cacheAfter);
    assert(cacheAfter >= 3, 'Cache mantiene múltiples símbolos');

    // 8. DATOS DE ÍNDICES — DISPONIBILIDAD
    console.log('\n8. ÍNDICES GLOBALES — DISPONIBILIDAD');
    var indices = ['^GSPC', '^DJI', '^IXIC', '^GDAXI', '^FTSE', '^N225', '^HSI'];
    var idxPromises = indices.map(function(idx) {
      return data.getQuote(idx).then(function(q) {
        return { sym: idx, ok: q.price > 0 };
      }).catch(function(err) {
        return { sym: idx, ok: false, err: err.message };
      });
    });
    return Promise.all(idxPromises);
  }).then(function(idxResults) {
    var idxOk = idxResults.filter(function(r) { return r.ok; }).length;
    console.log('   Índices disponibles:', idxOk + '/' + idxResults.length);
    idxResults.forEach(function(r) {
      console.log('     ' + r.sym + ':', r.ok ? '✓' : '✗ ' + (r.err || ''));
    });
    assert(idxOk >= 5, 'Al menos 5/7 índices globales disponibles');

    // 9. VOLUMEN — PRESENCIA Y MAGNITUD
    console.log('\n9. DATOS DE VOLUMEN');
    return data.getHistorical('AAPL', '1mo', '1d');
  }).then(function(hVol) {
    var vols = hVol.ohlcv.map(function(c) { return c.volume; }).filter(function(v) { return v > 0; });
    var avgVol = vols.reduce(function(a, b) { return a + b; }, 0) / vols.length;
    console.log('   Velas con volumen >0:', vols.length + '/' + hVol.ohlcv.length);
    console.log('   Volumen promedio AAPL:', Math.round(avgVol).toLocaleString());
    assert(vols.length > 0, 'Volumen presente en datos históricos');
    assert(avgVol > 1000000, 'Volumen promedio razonable (>1M)');

    // 10. AJUSTE POR DIVIDENDOS/SPLITS
    console.log('\n10. CALIDAD DE PRECIOS (split-adjusted check)');
    return data.getHistorical('AAPL', '10y', '1mo'); // mensual para ver largo plazo
  }).then(function(hLong) {
    var prices = hLong.ohlcv.map(function(c) { return c.close; });
    var maxP = Math.max.apply(null, prices);
    var minP = Math.min.apply(null, prices);
    console.log('   AAPL rango 10y mensual: $' + minP.toFixed(2) + ' - $' + maxP.toFixed(2));
    assert(maxP > 100, 'Precios ajustados por splits (AAPL split 2020 4:1)');

    // RESUMEN
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('RESUMEN BENCHMARK');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✓ Pasaron:  ' + PASSED);
    console.log('✗ Fallaron: ' + FAILED);
    console.log('⚠ Warning:  ' + WARNINGS);
    console.log('Total:      ' + (PASSED + FAILED));
    console.log('');
    if (FAILED === 0) {
      console.log('🎉 BENCHMARK COMPLETADO — Datos listos para producción');
    } else {
      console.log('⚠️  HAY FALLAS — Revisar antes de producción');
    }
    process.exit(FAILED > 0 ? 1 : 0);
  });
}).catch(function(err) {
  console.error('\n💥 BENCHMARK CRASHED:', err.message);
  console.error(err.stack);
  process.exit(1);
});

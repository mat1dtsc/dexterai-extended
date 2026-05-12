'use strict';
/**
 * tests/runner.js — Test runner simple (sin dependencias externas)
 * Uso: node tests/runner.js
 */

var assert = require('assert');
var path = require('path');

var tests = [];
var passed = 0;
var failed = 0;

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

function run() {
  console.log('\n=== DEXTERAI EXTENDED — TESTS DE CALIDAD DE DATOS ===\n');
  var start = Date.now();

  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    try {
      var result = t.fn();
      if (result && typeof result.then === 'function') {
        // Es una promesa, manejar async
        (function(t) {
          result.then(function() {
            passed++;
            console.log('  ✓', t.name);
          }).catch(function(err) {
            failed++;
            console.log('  ✗', t.name);
            console.log('    →', err.message || err);
          });
        })(t);
      } else {
        passed++;
        console.log('  ✓', t.name);
      }
    } catch (err) {
      failed++;
      console.log('  ✗', t.name);
      console.log('    →', err.message || err);
    }
  }

  // Esperar promesas
  setTimeout(function() {
    var elapsed = Date.now() - start;
    console.log('\n─────────────────────────────────');
    console.log('Total:', tests.length, '| ✓', passed, '| ✗', failed);
    console.log('Tiempo:', elapsed + 'ms');
    console.log(failed === 0 ? '✓ TODOS LOS TESTS PASARON' : '✗ HAY TESTS FALLIDOS');
    console.log('─────────────────────────────────\n');
    process.exit(failed > 0 ? 1 : 0);
  }, 30000); // Esperar hasta 30s para async
}

module.exports = { test: test, run: run };

// Si se corre directamente
if (require.main === module) {
  // Cargar todos los test files
  require('./test_marketData.js');
  require('./test_indicators.js');
  require('./test_routes.js');
  run();
}

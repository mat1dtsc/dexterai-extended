#!/usr/bin/env node
'use strict';
/**
 * monitor.js — Monitoreo continuo de Fase 1
 * Ejecutar cada 30 minutos para verificar salud del sistema.
 */

var http = require('http');
var childProcess = require('child_process');

var PORT = process.env.PORT || 3005;
var HOST = 'localhost';

var ENDPOINTS = [
  { path: '/api/quote?symbol=AAPL', name: 'Quote AAPL' },
  { path: '/api/quote/batch?symbols=AAPL,MSFT,GOOGL,AMZN,TSLA', name: 'Batch 5 symbols' },
  { path: '/api/context/daily', name: 'Context Daily' }
];

var REPORT = {
  timestamp: new Date().toISOString(),
  checks: [],
  allOk: true,
  restarted: false
};

function httpGet(path) {
  return new Promise(function(resolve, reject) {
    var start = Date.now();
    var req = http.get({ hostname: HOST, port: PORT, path: path, timeout: 15000 }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        var elapsed = Date.now() - start;
        resolve({ statusCode: res.statusCode, data: data, elapsed: elapsed });
      });
    });
    req.on('error', function(err) { reject(err); });
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
  });
}

function restartServer() {
  console.log('[MONITOR] ⚠ Servidor no responde. Intentando reinicio...');
  try {
    childProcess.execSync('cd /root/.openclaw/workspace/dexterai-extended && bash restart.sh', { timeout: 30000 });
    console.log('[MONITOR] ✅ Reinicio ejecutado');
    return true;
  } catch(e) {
    console.log('[MONITOR] ❌ Fallo reinicio:', e.message);
    return false;
  }
}

function runCheck(endpoint) {
  return httpGet(endpoint.path).then(function(result) {
    var ok = result.statusCode === 200;
    var check = {
      name: endpoint.name,
      path: endpoint.path,
      statusCode: result.statusCode,
      elapsedMs: result.elapsed,
      ok: ok
    };
    if (!ok) {
      try {
        var parsed = JSON.parse(result.data);
        check.error = parsed.error || 'HTTP ' + result.statusCode;
      } catch(e) {
        check.error = 'HTTP ' + result.statusCode;
      }
    }
    REPORT.checks.push(check);
    if (!ok) REPORT.allOk = false;
    console.log('[MONITOR]', ok ? '✅' : '❌', endpoint.name, '|', result.elapsed + 'ms', ok ? '' : '| ' + check.error);
    return check;
  }).catch(function(err) {
    var check = {
      name: endpoint.name,
      path: endpoint.path,
      ok: false,
      error: err.message,
      elapsedMs: -1
    };
    REPORT.checks.push(check);
    REPORT.allOk = false;
    console.log('[MONITOR] ❌', endpoint.name, '| ERROR:', err.message);
    return check;
  });
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('  MONITOREO FASE 1 —', new Date().toLocaleString('es-CL'));
  console.log('═══════════════════════════════════════');

  // Check 1: servidor vivo
  try {
    await httpGet('/health');
    console.log('[MONITOR] ✅ Servidor respondiendo en puerto', PORT);
  } catch(e) {
    console.log('[MONITOR] ❌ Servidor no responde:', e.message);
    REPORT.allOk = false;
    REPORT.restarted = restartServer();
    if (REPORT.restarted) {
      console.log('[MONITOR] ⏳ Esperando 5s para que arranque...');
      await new Promise(function(r) { setTimeout(r, 5000); });
    }
  }

  for (var i = 0; i < ENDPOINTS.length; i++) {
    await runCheck(ENDPOINTS[i]);
  }

  var total = REPORT.checks.length;
  var passed = REPORT.checks.filter(function(c) { return c.ok; }).length;

  console.log('\n───────────────────────────────────────');
  console.log('  Resultado:', passed + '/' + total, 'OK');
  console.log('───────────────────────────────────────');

  if (!REPORT.allOk) {
    console.log('[MONITOR] ⚠️ ALGUNOS CHECKS FALLARON');
    process.exit(1);
  } else {
    console.log('[MONITOR] 🎉 TODO OK');
    process.exit(0);
  }
}

main();

'use strict';
/**
 * daemon_fase1.js — Proceso autónomo de mejora continua Fase 1
 * Corre en background indefinidamente sin intervención humana
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'DAEMON_LOG.md');
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutos
const IMPROVE_INTERVAL = 30 * 60 * 1000; // 30 minutos

let cycle = 0;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

function ensureLog() {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, '# Daemon Fase 1 — Log Autónomo\n\n');
  }
}

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3005/health', (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

function restartServer() {
  try {
    execSync('pkill -9 -f "server\.js" 2>/dev/null; sleep 2');
    const cmd = 'nohup node ' + path.join(__dirname, 'server.js') + ' > /tmp/dexter-server.log 2>&1 &';
    execSync(cmd);
    log('Servidor reiniciado');
    return true;
  } catch (e) {
    log('ERROR reiniciando servidor: ' + e.message);
    return false;
  }
}

function runTests() {
  try {
    const out = execSync('node ' + path.join(__dirname, 'tests/runner.js'), { encoding: 'utf8', timeout: 120000 });
    const passed = out.includes('✓ TODOS LOS TESTS PASARON');
    const totalMatch = out.match(/Total: (\d+) \| ✓ (\d+)/);
    const total = totalMatch ? totalMatch[1] : '?';
    const ok = totalMatch ? totalMatch[2] : '?';
    return { passed, total, ok, output: out.slice(-200) };
  } catch (e) {
    const out = e.stdout || e.message || '';
    const totalMatch = out.match(/Total: (\d+) \| ✓ (\d+)/);
    return { passed: false, total: totalMatch ? totalMatch[1] : '?', ok: totalMatch ? totalMatch[2] : '?', output: out.slice(-200) };
  }
}

async function cycleCheck() {
  cycle++;
  log(`=== Ciclo #${cycle} ===`);
  
  // 1. Verificar servidor
  const serverOk = await checkServer();
  if (!serverOk) {
    log('⚠ Servidor no responde, reiniciando...');
    restartServer();
    await sleep(5000);
  } else {
    log('✓ Servidor OK');
  }
  
  // 2. Correr tests
  const testResult = runTests();
  if (testResult.passed) {
    log(`✓ Tests: ${testResult.ok}/${testResult.total} pasando`);
  } else {
    log(`✗ Tests FALLANDO: ${testResult.ok}/${testResult.total}`);
    log(`  Output: ${testResult.output.replace(/\n/g, ' ')}`);
  }
  
  // 3. Verificar endpoints clave
  const endpoints = [
    '/api/quote?symbol=AAPL',
    '/api/quote/batch?symbols=AAPL,MSFT',
    '/api/context/daily'
  ];
  for (const ep of endpoints) {
    const ok = await new Promise((resolve) => {
      const req = http.get('http://localhost:3005' + ep, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    });
    log(`  ${ep}: ${ok ? 'OK' : 'FALLA'}`);
  }
  
  log(`=== Fin ciclo #${cycle} ===\n`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  ensureLog();
  log('Daemon Fase 1 iniciado — mejora continua autónoma');
  
  // Loop infinito
  while (true) {
    try {
      await cycleCheck();
    } catch (e) {
      log('ERROR en ciclo: ' + e.message);
    }
    await sleep(CHECK_INTERVAL);
  }
}

main().catch(e => {
  console.error('Daemon crash:', e);
  process.exit(1);
});

'use strict';
/**
 * lib/liveStream.js — WebSocket server para push de ticks y señales
 *
 * Cliente protocolo:
 *   → { type:'subscribe',   symbols:['AAPL','BTC-USD'] }
 *   → { type:'unsubscribe', symbols:['AAPL'] }
 *   → { type:'ping' }
 *
 * Servidor empuja:
 *   ← { type:'hello',  serverTime, mode }
 *   ← { type:'tick',   data:[{symbol,price,changePct,ts}] }
 *   ← { type:'signal', payload:{symbol,action,score,reasons,...} }
 *   ← { type:'alert',  payload:{...} }
 *   ← { type:'pong',   ts }
 *
 * El intervalo de tick se autoajusta: max(5s, symbols * 200ms) para respetar
 * el rate limit de yahoo-finance2 (10 req/s).
 */

var WebSocket = require('ws');
var marketData = require('./marketData');
var signalEngine = require('./signalEngine');
var notifier = require('./notifier');
var db = require('./db');

var DEFAULT_TICK_MS = parseInt(process.env.LIVE_TICK_INTERVAL_MS, 10) || 5000;
var MIN_TICK_MS = 3000;
var SIGNAL_CHECK_INTERVAL_MS = 60 * 1000; // computa señales cada 60s, no en cada tick
var STATE = {
  wss: null,
  symbols: Object.create(null),    // symbol → ref count (subscribers)
  lastSignalCheck: 0,
  signalCache: Object.create(null),// symbol → last computed signal
  tickTimer: null,
  signalTimer: null,
  histCache: Object.create(null)   // symbol → {ts, ohlcv}
};

function broadcast(msg) {
  if (!STATE.wss) return;
  var data = JSON.stringify(msg);
  STATE.wss.clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (e) {}
    }
  });
}

function activeSymbols() {
  return Object.keys(STATE.symbols).filter(function(s) { return STATE.symbols[s] > 0; });
}

function adjustedInterval() {
  var n = activeSymbols().length;
  if (n === 0) return DEFAULT_TICK_MS;
  // Respeta rate limit: ~10 req/s en yahoo-finance2 → al menos 100ms por símbolo
  // Damos margen 200ms. Pero nunca bajamos de MIN_TICK_MS.
  return Math.max(MIN_TICK_MS, Math.max(DEFAULT_TICK_MS, n * 200));
}

function doTick() {
  var symbols = activeSymbols();
  if (symbols.length === 0) return;
  marketData.getQuotesBatch(symbols).then(function(res) {
    var data = (res.quotes || []).map(function(q) {
      return {
        symbol: q.symbol,
        price: q.price,
        changePct: q.changePct,
        change: q.change,
        marketState: q.marketState,
        ts: q.ts || Date.now()
      };
    });
    if (data.length > 0) broadcast({ type: 'tick', data: data, ts: Date.now() });
  }).catch(function(err) {
    console.error('[liveStream] tick error:', err.message);
  });
}

var ACTIONABLE = { LONG: true, SHORT: true, EXIT_LONG: true, EXIT_SHORT: true };

function checkSignalFor(symbol) {
  // Cachea histórico 1y/1d 30min para no martillar Yahoo
  var c = STATE.histCache[symbol];
  var freshP = (c && Date.now() - c.ts < 30 * 60 * 1000)
    ? Promise.resolve(c.ohlcv)
    : marketData.getHistorical(symbol, '1y', '1d').then(function(parsed) {
        if (!parsed || !Array.isArray(parsed.ohlcv) || parsed.ohlcv.length < 60) return null;
        STATE.histCache[symbol] = { ts: Date.now(), ohlcv: parsed.ohlcv };
        return parsed.ohlcv;
      });

  return freshP.then(function(ohlcv) {
    if (!ohlcv) return null;
    var sig = signalEngine.computeSignal(ohlcv);
    sig.symbol = symbol;

    var prev = STATE.signalCache[symbol];
    var changed = !prev || prev.action !== sig.action ||
                  Math.abs((prev.score || 0) - (sig.score || 0)) > 10;
    STATE.signalCache[symbol] = sig;

    // Solo notificar cuando la acción es accionable (no HOLD) y cambió
    if (changed && ACTIONABLE[sig.action]) {
      db.guardarSenal(sig).then(function(r) {
        sig.id = r.id;
      }).catch(function(e) { console.error('[liveStream] guardarSenal:', e.message); });

      notifier.notify({
        kind: 'signal',
        symbol: symbol,
        action: sig.action,
        direction: sig.direction,
        score: sig.score,
        long_score: sig.long_score,
        short_score: sig.short_score,
        price: sig.price,
        stop_loss: sig.stop_loss,
        take_profit: sig.take_profit,
        reasons: sig.reasons,
        level: 'alto',
        message: sig.action + ' ' + symbol + ' @ ' + (sig.price || 0).toFixed(4)
      }).catch(function(e) { console.error('[liveStream] notify:', e.message); });
    }
    return sig;
  }).catch(function(err) {
    console.error('[liveStream] checkSignal', symbol, ':', err.message);
    return null;
  });
}

function doSignalSweep() {
  var symbols = activeSymbols();
  if (symbols.length === 0) return;
  // Procesar en serie para respetar rate limit
  symbols.reduce(function(prom, sym) {
    return prom.then(function() { return checkSignalFor(sym); });
  }, Promise.resolve()).then(function() {
    // Después del sweep, empujar un snapshot de TODOS los análisis (incluyendo HOLD)
    // para que la UI dibuje el "panel de oportunidades" continuo.
    var analyses = symbols.map(function(s) {
      var c = STATE.signalCache[s];
      if (!c) return { symbol: s, action: 'HOLD', score: 0, long_score: 0, short_score: 0 };
      return {
        symbol: s,
        action: c.action,
        direction: c.direction,
        score: c.score,
        long_score: c.long_score,
        short_score: c.short_score,
        price: c.price,
        indicators: c.indicators
      };
    });
    broadcast({ type: 'analysis', data: analyses, ts: Date.now() });
  });
}

function rescheduleTimers() {
  if (STATE.tickTimer) { clearInterval(STATE.tickTimer); STATE.tickTimer = null; }
  if (activeSymbols().length === 0) return;
  var interval = adjustedInterval();
  STATE.tickTimer = setInterval(doTick, interval);
  // primer tick inmediato
  setTimeout(doTick, 100);
  console.log('[liveStream] interval ajustado a', interval, 'ms para', activeSymbols().length, 'símbolos');
}

function handleClientMessage(ws, raw) {
  var msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'subscribe':
      if (Array.isArray(msg.symbols)) {
        msg.symbols.forEach(function(s) {
          s = String(s || '').trim().toUpperCase();
          if (!s) return;
          if (!ws._subs) ws._subs = Object.create(null);
          if (ws._subs[s]) return; // ya suscrito
          ws._subs[s] = true;
          STATE.symbols[s] = (STATE.symbols[s] || 0) + 1;
        });
        rescheduleTimers();
        try { ws.send(JSON.stringify({ type: 'subscribed', symbols: Object.keys(ws._subs || {}) })); } catch(e) {}
      }
      break;
    case 'unsubscribe':
      if (Array.isArray(msg.symbols)) {
        msg.symbols.forEach(function(s) {
          s = String(s || '').trim().toUpperCase();
          if (!s || !ws._subs || !ws._subs[s]) return;
          delete ws._subs[s];
          STATE.symbols[s] = Math.max(0, (STATE.symbols[s] || 0) - 1);
          if (STATE.symbols[s] === 0) delete STATE.symbols[s];
        });
        rescheduleTimers();
      }
      break;
    case 'ping':
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch(e) {}
      break;
    default:
      // ignorar
  }
}

function attach(httpServer) {
  STATE.wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', function(req, socket, head) {
    if (req.url === '/ws' || req.url.indexOf('/ws?') === 0) {
      STATE.wss.handleUpgrade(req, socket, head, function(ws) {
        STATE.wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  STATE.wss.on('connection', function(ws, req) {
    ws._subs = Object.create(null);
    ws._isAlive = true;
    ws.on('pong', function() { ws._isAlive = true; });
    ws.on('message', function(raw) { handleClientMessage(ws, raw); });
    ws.on('close', function() {
      if (ws._subs) {
        Object.keys(ws._subs).forEach(function(s) {
          STATE.symbols[s] = Math.max(0, (STATE.symbols[s] || 0) - 1);
          if (STATE.symbols[s] === 0) delete STATE.symbols[s];
        });
      }
      rescheduleTimers();
    });

    try {
      ws.send(JSON.stringify({
        type: 'hello',
        serverTime: Date.now(),
        mode: process.env.TRADING_MODE || 'disabled',
        telegramConfigured: notifier.isTelegramConfigured(),
        tickIntervalMs: adjustedInterval()
      }));
    } catch (e) {}
  });

  // Heartbeat — limpia conexiones zombies
  setInterval(function() {
    if (!STATE.wss) return;
    STATE.wss.clients.forEach(function(ws) {
      if (ws._isAlive === false) { try { ws.terminate(); } catch(e) {} return; }
      ws._isAlive = false;
      try { ws.ping(); } catch(e) {}
    });
  }, 30000);

  // Registrar broadcaster en notifier
  notifier.setBroadcaster(broadcast);

  // Signal sweep periódico (independiente de los ticks)
  STATE.signalTimer = setInterval(doSignalSweep, SIGNAL_CHECK_INTERVAL_MS);

  console.log('[liveStream] WebSocket server montado en /ws');
}

module.exports = {
  attach: attach,
  broadcast: broadcast,
  activeSymbols: activeSymbols,
  _state: STATE
};

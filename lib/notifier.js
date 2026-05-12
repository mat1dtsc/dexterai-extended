'use strict';
/**
 * lib/notifier.js — Fan-out de eventos a múltiples canales
 *
 * Canales:
 *  - WebSocket: el propio liveStream.js (registrado vía setBroadcaster)
 *  - Telegram: si TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID están en env
 *  - Windows native: lo dispara el browser via Notification API en respuesta
 *    al evento WebSocket — no requiere código de servidor adicional
 *
 * Dedup: una misma (symbol, kind, action) no se envía más de una vez por
 * DEDUP_WINDOW_MS (default 15min). Esto evita floods.
 */

var https = require('https');

var DEDUP_WINDOW_MS = parseInt(process.env.NOTIFY_DEDUP_WINDOW_MS, 10) || 15 * 60 * 1000;
var dedup = Object.create(null); // key → last-sent ts

var wsBroadcaster = null;

function setBroadcaster(fn) { wsBroadcaster = fn; }

function dedupKey(ev) {
  return [ev.kind || 'event', ev.symbol || '_', ev.action || ev.tipo || '_'].join('|');
}

function shouldSend(ev) {
  var key = dedupKey(ev);
  var last = dedup[key] || 0;
  var now = Date.now();
  if (now - last < DEDUP_WINDOW_MS) return false;
  dedup[key] = now;
  return true;
}

var ACTION_LABEL = {
  LONG:       'ENTRADA LARGA',
  SHORT:      'ENTRADA CORTA',
  EXIT_LONG:  'SALIR DE LARGO',
  EXIT_SHORT: 'CUBRIR CORTO',
  BUY:        'COMPRAR',
  SELL:       'VENDER'
};
var ACTION_EMOJI = {
  LONG: '🟢⬆️', SHORT: '🔴⬇️', EXIT_LONG: '🟡✋', EXIT_SHORT: '🟡✋',
  BUY: '🟢', SELL: '🔴'
};

function formatTelegram(ev) {
  var emoji = ACTION_EMOJI[ev.action] || '📊';
  if (!ev.action && ev.kind === 'alert' && ev.level === 'alto') emoji = '⚠️';
  var label = ACTION_LABEL[ev.action] || ev.action || ev.tipo || 'ALERTA';

  var lines = [];
  lines.push(emoji + ' *' + label + '* — `' + (ev.symbol || '—') + '`');
  if (ev.message) lines.push(ev.message);
  if (ev.price != null)        lines.push('Precio: ' + Number(ev.price).toFixed(4));
  if (ev.score != null)        lines.push('Score: ' + ev.score + '/100');
  if (ev.long_score != null && ev.short_score != null) {
    lines.push('Long: ' + ev.long_score + '   Short: ' + ev.short_score);
  }
  if (ev.stop_loss != null)    lines.push('Stop loss: ' + Number(ev.stop_loss).toFixed(4));
  if (ev.take_profit != null)  lines.push('Take profit: ' + Number(ev.take_profit).toFixed(4));
  if (Array.isArray(ev.reasons) && ev.reasons.length) {
    lines.push('Razones:');
    ev.reasons.forEach(function(r) { lines.push('  • ' + r); });
  }
  return lines.join('\n');
}

function sendTelegram(text) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  var chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Promise.resolve({ skipped: 'no-config' });

  return new Promise(function(resolve) {
    var payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    var opts = {
      hostname: 'api.telegram.org',
      path: '/bot' + token + '/sendMessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ sent: true });
        } else {
          console.error('[notifier][telegram]', res.statusCode, body.slice(0, 200));
          resolve({ sent: false, error: 'HTTP ' + res.statusCode });
        }
      });
    });
    req.on('error', function(err) {
      console.error('[notifier][telegram] error:', err.message);
      resolve({ sent: false, error: err.message });
    });
    req.on('timeout', function() { req.destroy(); resolve({ sent: false, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

/**
 * notify(event)
 * event = { kind:'alert'|'signal', symbol, action?, message?, level?, score?,
 *           price?, stop_loss?, take_profit?, reasons?, data? }
 */
function notify(event) {
  if (!event || !event.symbol) return Promise.resolve({ skipped: 'no-symbol' });

  if (!shouldSend(event)) {
    return Promise.resolve({ skipped: 'dedup' });
  }

  // 1. WebSocket → UI (toast + sonido + Notification API la dispara el cliente)
  if (wsBroadcaster) {
    try { wsBroadcaster({ type: event.kind || 'alert', payload: event, ts: Date.now() }); }
    catch (e) { console.error('[notifier][ws] error:', e.message); }
  }

  // 2. Telegram (best effort)
  var telegramP = sendTelegram(formatTelegram(event));

  return telegramP.then(function(tgRes) {
    return { ws: !!wsBroadcaster, telegram: tgRes };
  });
}

function isTelegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

module.exports = {
  notify: notify,
  setBroadcaster: setBroadcaster,
  isTelegramConfigured: isTelegramConfigured,
  _formatTelegram: formatTelegram
};

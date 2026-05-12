'use strict';
/**
 * lib/broker.js — Cliente Alpaca (paper/live) con gate TRADING_MODE
 *
 * Seguridad:
 *  - TRADING_MODE=disabled (default) → placeOrder lanza error
 *  - TRADING_MODE=paper             → usa paper-api.alpaca.markets
 *  - TRADING_MODE=live              → usa api.alpaca.markets
 *
 *  Solo routes/orders.js debe llamar a placeOrder. Ningún path automático.
 */

var https = require('https');

function mode() { return (process.env.TRADING_MODE || 'disabled').toLowerCase(); }

function baseHost() {
  return mode() === 'live' ? 'api.alpaca.markets' : 'paper-api.alpaca.markets';
}

function hasCredentials() {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
}

function headers() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
    'Content-Type': 'application/json'
  };
}

function alpacaRequest(method, pathName, body) {
  return new Promise(function(resolve, reject) {
    var payload = body ? JSON.stringify(body) : null;
    var hdr = headers();
    if (payload) hdr['Content-Length'] = Buffer.byteLength(payload);
    var opts = {
      hostname: baseHost(),
      port: 443,
      path: pathName,
      method: method,
      headers: hdr,
      timeout: 15000
    };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          var msg = (parsed && (parsed.message || parsed.code)) ? JSON.stringify(parsed) : raw.slice(0, 200);
          reject(new Error('Alpaca HTTP ' + res.statusCode + ': ' + msg));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(new Error('Alpaca timeout 15s')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function assertEnabled() {
  var m = mode();
  if (m === 'disabled') throw new Error('Trading deshabilitado (TRADING_MODE=disabled). Setea TRADING_MODE=paper o live en .env');
  if (!hasCredentials()) throw new Error('Faltan ALPACA_API_KEY/ALPACA_SECRET_KEY en .env');
  return m;
}

function getAccount() {
  if (!hasCredentials()) return Promise.reject(new Error('Faltan credenciales Alpaca'));
  return alpacaRequest('GET', '/v2/account');
}

function getPositions() {
  if (!hasCredentials()) return Promise.reject(new Error('Faltan credenciales Alpaca'));
  return alpacaRequest('GET', '/v2/positions');
}

function getOrders(limit) {
  if (!hasCredentials()) return Promise.reject(new Error('Faltan credenciales Alpaca'));
  return alpacaRequest('GET', '/v2/orders?status=all&limit=' + (limit || 50) + '&direction=desc');
}

function cancelOrder(id) {
  assertEnabled();
  return alpacaRequest('DELETE', '/v2/orders/' + encodeURIComponent(id));
}

/**
 * placeOrder({symbol, qty, side, type, limit_price?, stop_loss?, take_profit?, time_in_force?})
 */
function placeOrder(req) {
  var m = assertEnabled();
  if (!req || !req.symbol || !req.qty || !req.side) {
    return Promise.reject(new Error('placeOrder requiere {symbol, qty, side}'));
  }
  var side = String(req.side).toLowerCase();
  if (side !== 'buy' && side !== 'sell') return Promise.reject(new Error('side debe ser buy o sell'));

  var type = (req.type || 'market').toLowerCase();
  var body = {
    symbol: String(req.symbol).toUpperCase(),
    qty: String(req.qty),
    side: side,
    type: type,
    time_in_force: req.time_in_force || (type === 'market' ? 'day' : 'gtc')
  };
  if (type === 'limit' && req.limit_price != null) body.limit_price = String(req.limit_price);
  if (type === 'stop'  && req.stop_price  != null) body.stop_price  = String(req.stop_price);

  // Bracket order si vienen SL+TP
  if (req.stop_loss != null && req.take_profit != null) {
    body.order_class = 'bracket';
    body.stop_loss = { stop_price: String(req.stop_loss) };
    body.take_profit = { limit_price: String(req.take_profit) };
  } else if (req.stop_loss != null) {
    body.order_class = 'oto';
    body.stop_loss = { stop_price: String(req.stop_loss) };
  }

  return alpacaRequest('POST', '/v2/orders', body).then(function(r) {
    return { mode: m, order: r };
  });
}

function status() {
  return {
    mode: mode(),
    host: baseHost(),
    hasCredentials: hasCredentials()
  };
}

module.exports = {
  mode: mode,
  status: status,
  hasCredentials: hasCredentials,
  getAccount: getAccount,
  getPositions: getPositions,
  getOrders: getOrders,
  placeOrder: placeOrder,
  cancelOrder: cancelOrder
};

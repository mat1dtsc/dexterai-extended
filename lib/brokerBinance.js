'use strict';
/**
 * lib/brokerBinance.js — Cliente Binance Spot + Futures USDⓈ-M
 *
 *  Modos de seguridad:
 *    BINANCE_MODE=disabled  → ninguna orden (default)
 *    BINANCE_MODE=testnet   → testnet.binance.vision / testnet.binancefuture.com
 *    BINANCE_MODE=live      → api.binance.com / fapi.binance.com
 *
 *  Symbol mapping:
 *    yahoo "BTC-USD"  → binance "BTCUSDT"
 *    yahoo "ETH-USD"  → binance "ETHUSDT"
 *    Cualquier "*-USD" → "*USDT" (asumiendo perpetuo USDT)
 *
 *  Firma: HMAC-SHA256 sobre query string + parámetro `signature`
 *  Permissions API key: para Futures, "Enable Futures Trading"
 */
var crypto = require('crypto');
var https = require('https');

function mode() { return (process.env.BINANCE_MODE || 'disabled').toLowerCase(); }
function hasCreds() { return !!(process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY); }
function defaultLev() { return parseInt(process.env.BINANCE_DEFAULT_LEVERAGE, 10) || 5; }

function hosts() {
  var live = mode() === 'live';
  return {
    spot:    live ? 'api.binance.com'  : 'testnet.binance.vision',
    futures: live ? 'fapi.binance.com' : 'testnet.binancefuture.com'
  };
}

function toBinanceSymbol(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  // BTC-USD → BTCUSDT  (asumimos par USDT)
  if (symbol.endsWith('-USD')) return symbol.slice(0, -4) + 'USDT';
  if (symbol.endsWith('USDT')) return symbol;
  if (symbol.endsWith('USDC')) return symbol;
  if (symbol.endsWith('-USDT')) return symbol.replace('-', '');
  return symbol;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
function buildQuery(params) {
  return Object.keys(params)
    .filter(function(k) { return params[k] !== undefined && params[k] !== null; })
    .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
}

function sign(qs) {
  return crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY || '').update(qs).digest('hex');
}

function request(host, method, pathName, params, isSigned) {
  return new Promise(function(resolve, reject) {
    params = params || {};
    var qs;
    if (isSigned) {
      params.timestamp = Date.now();
      params.recvWindow = params.recvWindow || 5000;
      qs = buildQuery(params);
      qs += '&signature=' + sign(qs);
    } else {
      qs = buildQuery(params);
    }

    var fullPath = pathName + (qs ? '?' + qs : '');
    // Para POST/DELETE Binance acepta params en query también
    var opts = {
      hostname: host,
      port: 443,
      path: fullPath,
      method: method,
      headers: {
        'X-MBX-APIKEY': process.env.BINANCE_API_KEY || '',
        'Accept': 'application/json'
      },
      timeout: 15000
    };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch(e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          var msg = parsed && (parsed.msg || parsed.code) ? JSON.stringify(parsed) : raw.slice(0, 200);
          reject(new Error('Binance HTTP ' + res.statusCode + ': ' + msg));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(new Error('Binance timeout 15s')); });
    req.end();
  });
}

function assertEnabled(venue) {
  var m = mode();
  if (m === 'disabled') throw new Error('Binance deshabilitado (BINANCE_MODE=disabled). Setea testnet o live en .env');
  if (!hasCreds()) throw new Error('Faltan BINANCE_API_KEY/BINANCE_SECRET_KEY en .env');
  if (venue && (venue !== 'spot' && venue !== 'futures')) throw new Error('venue inválido: ' + venue);
  return m;
}

// ─── SPOT ──────────────────────────────────────────────────────────────────
function getSpotAccount() {
  if (!hasCreds()) return Promise.reject(new Error('Faltan credenciales Binance'));
  return request(hosts().spot, 'GET', '/api/v3/account', {}, true).then(function(r) {
    var nonZero = (r.balances || []).filter(function(b) {
      return parseFloat(b.free) > 0 || parseFloat(b.locked) > 0;
    });
    return Object.assign({}, r, { balances: nonZero });
  });
}

function getSpotPrice(symbol) {
  var binSym = toBinanceSymbol(symbol);
  return request(hosts().spot, 'GET', '/api/v3/ticker/price', { symbol: binSym }, false);
}

function placeSpotOrder(req) {
  var m = assertEnabled('spot');
  if (!req || !req.symbol || !req.qty || !req.side) {
    return Promise.reject(new Error('placeSpotOrder requiere {symbol, qty, side}'));
  }
  var side = String(req.side).toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return Promise.reject(new Error('side debe ser BUY o SELL'));

  var params = {
    symbol: toBinanceSymbol(req.symbol),
    side: side,
    type: (req.type || 'MARKET').toUpperCase(),
    quantity: String(req.qty)
  };
  if (params.type === 'LIMIT') {
    if (req.limit_price == null) return Promise.reject(new Error('LIMIT requiere limit_price'));
    params.price = String(req.limit_price);
    params.timeInForce = req.time_in_force || 'GTC';
  }
  return request(hosts().spot, 'POST', '/api/v3/order', params, true)
    .then(function(r) { return { mode: m, venue: 'spot', order: r }; });
}

// ─── FUTURES USDⓈ-M ────────────────────────────────────────────────────────
function getFuturesAccount() {
  if (!hasCreds()) return Promise.reject(new Error('Faltan credenciales Binance'));
  return request(hosts().futures, 'GET', '/fapi/v2/account', {}, true);
}

function getFuturesPositions() {
  if (!hasCreds()) return Promise.reject(new Error('Faltan credenciales Binance'));
  return request(hosts().futures, 'GET', '/fapi/v2/positionRisk', {}, true).then(function(rows) {
    return (rows || []).filter(function(p) { return parseFloat(p.positionAmt) !== 0; });
  });
}

function setLeverage(symbol, leverage) {
  assertEnabled('futures');
  return request(hosts().futures, 'POST', '/fapi/v1/leverage', {
    symbol: toBinanceSymbol(symbol),
    leverage: Math.max(1, Math.min(125, parseInt(leverage, 10) || defaultLev()))
  }, true);
}

function placeFuturesOrder(req) {
  var m = assertEnabled('futures');
  if (!req || !req.symbol || !req.qty || !req.side) {
    return Promise.reject(new Error('placeFuturesOrder requiere {symbol, qty, side}'));
  }

  // Validar side: BUY abre LONG (o cierra SHORT), SELL abre SHORT (o cierra LONG)
  var side = String(req.side).toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return Promise.reject(new Error('side debe ser BUY o SELL'));

  var symbol = toBinanceSymbol(req.symbol);
  var leverage = req.leverage || defaultLev();

  // Setear leverage primero (si falla, no abortamos — Binance puede tener el mismo lev cacheado)
  return setLeverage(symbol, leverage).catch(function(e) {
    console.warn('[binance] setLeverage warning:', e.message);
    return null;
  }).then(function() {
    var params = {
      symbol: symbol,
      side: side,
      type: (req.type || 'MARKET').toUpperCase(),
      quantity: String(req.qty)
    };
    if (params.type === 'LIMIT') {
      if (req.limit_price == null) return Promise.reject(new Error('LIMIT requiere limit_price'));
      params.price = String(req.limit_price);
      params.timeInForce = req.time_in_force || 'GTC';
    }
    // reduceOnly: true para cierres puros (EXIT_LONG, EXIT_SHORT)
    if (req.reduce_only) params.reduceOnly = 'true';

    return request(hosts().futures, 'POST', '/fapi/v1/order', params, true).then(function(orderResp) {
      // Si vino SL/TP, lanzamos órdenes adicionales reduceOnly
      var slTp = [];
      var oppositeSide = (side === 'BUY') ? 'SELL' : 'BUY';
      if (req.stop_loss != null) {
        slTp.push(request(hosts().futures, 'POST', '/fapi/v1/order', {
          symbol: symbol,
          side: oppositeSide,
          type: 'STOP_MARKET',
          stopPrice: String(req.stop_loss),
          closePosition: 'true'
        }, true).catch(function(e) { return { error: 'SL: ' + e.message }; }));
      }
      if (req.take_profit != null) {
        slTp.push(request(hosts().futures, 'POST', '/fapi/v1/order', {
          symbol: symbol,
          side: oppositeSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: String(req.take_profit),
          closePosition: 'true'
        }, true).catch(function(e) { return { error: 'TP: ' + e.message }; }));
      }

      if (slTp.length === 0) return { mode: m, venue: 'futures', order: orderResp, leverage: leverage };
      return Promise.all(slTp).then(function(brackets) {
        return { mode: m, venue: 'futures', order: orderResp, leverage: leverage, brackets: brackets };
      });
    });
  });
}

function cancelFuturesOrder(symbol, orderId) {
  assertEnabled('futures');
  return request(hosts().futures, 'DELETE', '/fapi/v1/order', {
    symbol: toBinanceSymbol(symbol),
    orderId: orderId
  }, true);
}

function getOpenFuturesOrders() {
  if (!hasCreds()) return Promise.reject(new Error('Faltan credenciales Binance'));
  return request(hosts().futures, 'GET', '/fapi/v1/openOrders', {}, true);
}

function status() {
  return {
    mode: mode(),
    hosts: hosts(),
    hasCredentials: hasCreds(),
    defaultLeverage: defaultLev()
  };
}

module.exports = {
  mode: mode,
  hasCredentials: hasCreds,
  status: status,
  toBinanceSymbol: toBinanceSymbol,
  // Spot
  getSpotAccount: getSpotAccount,
  getSpotPrice: getSpotPrice,
  placeSpotOrder: placeSpotOrder,
  // Futures
  getFuturesAccount: getFuturesAccount,
  getFuturesPositions: getFuturesPositions,
  setLeverage: setLeverage,
  placeFuturesOrder: placeFuturesOrder,
  cancelFuturesOrder: cancelFuturesOrder,
  getOpenFuturesOrders: getOpenFuturesOrders
};

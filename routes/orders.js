'use strict';
/**
 * routes/orders.js — Endpoints para account/positions/orders y confirmar órdenes
 *
 * IMPORTANTE: POST /confirm es el ÚNICO entry point que crea órdenes reales.
 * Solo se debe invocar desde la UI tras confirmación humana del usuario.
 *
 * Enrutamiento por venue:
 *   venue='alpaca'           → lib/broker.js  (acciones US)
 *   venue='binance_spot'     → lib/brokerBinance.js  (cripto spot)
 *   venue='binance_futures'  → lib/brokerBinance.js  (cripto futures con leverage)
 */
var express = require('express');
var router = express.Router();
var broker = require('../lib/broker');
var binance = require('../lib/brokerBinance');
var db = require('../lib/db');

router.get('/mode', function(req, res) {
  res.json({
    alpaca: broker.status(),
    binance: binance.status()
  });
});

router.get('/account', function(req, res) {
  if (!broker.hasCredentials()) {
    return res.json({
      mode: broker.mode(),
      configured: false,
      message: 'Sin ALPACA_API_KEY — modo solo lectura'
    });
  }
  broker.getAccount().then(function(acc) {
    res.json({ mode: broker.mode(), configured: true, account: acc });
  }).catch(function(err) {
    res.status(502).json({ error: err.message, mode: broker.mode() });
  });
});

router.get('/positions', function(req, res) {
  if (!broker.hasCredentials()) return res.json({ positions: [] });
  broker.getPositions().then(function(pos) { res.json({ positions: pos }); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/', function(req, res) {
  Promise.all([
    broker.hasCredentials() ? broker.getOrders(50).catch(function() { return []; }) : Promise.resolve([]),
    db.obtenerOrdenes(50).catch(function() { return []; })
  ]).then(function(results) {
    res.json({ alpaca: results[0], local: results[1] });
  });
});

router.post('/confirm', function(req, res) {
  var body = req.body || {};
  if (!body.confirmed) {
    return res.status(400).json({ error: 'Falta confirmed=true' });
  }
  if (!body.symbol || !body.qty || !body.side) {
    return res.status(400).json({ error: 'Faltan campos symbol/qty/side' });
  }

  var venue = (body.venue || 'alpaca').toLowerCase();
  var placeP;

  if (venue === 'binance_spot') {
    placeP = binance.placeSpotOrder({
      symbol: body.symbol,
      qty: body.qty,
      side: body.side,
      type: body.type || 'market',
      limit_price: body.limit_price,
      time_in_force: body.time_in_force
    });
  } else if (venue === 'binance_futures') {
    placeP = binance.placeFuturesOrder({
      symbol: body.symbol,
      qty: body.qty,
      side: body.side,
      type: body.type || 'market',
      limit_price: body.limit_price,
      stop_loss: body.stop_loss,
      take_profit: body.take_profit,
      leverage: body.leverage,
      reduce_only: !!body.reduce_only,
      time_in_force: body.time_in_force
    });
  } else {
    // default: alpaca
    placeP = broker.placeOrder({
      symbol: body.symbol,
      qty: body.qty,
      side: body.side,
      type: body.type || 'market',
      limit_price: body.limit_price,
      stop_loss: body.stop_loss,
      take_profit: body.take_profit,
      time_in_force: body.time_in_force
    });
  }

  placeP.then(function(r) {
    var ord = r.order || {};
    var brokerOrderId = ord.id || ord.orderId || ord.clientOrderId || null;
    return db.guardarOrden({
      alpaca_id: brokerOrderId ? String(brokerOrderId) : null,
      symbol: body.symbol,
      side: body.side,
      qty: body.qty,
      type: body.type || 'market',
      limit_price: body.limit_price,
      stop_loss: body.stop_loss,
      take_profit: body.take_profit,
      status: ord.status || 'submitted',
      mode: venue + ':' + (r.mode || 'unknown'),
      signal_id: body.signal_id || null,
      raw: r
    }).then(function(saved) {
      console.log('[ORDER]', venue.toUpperCase(), (r.mode || '').toUpperCase(),
                  body.side, body.qty, body.symbol,
                  (r.leverage ? ' x' + r.leverage : ''),
                  '→', brokerOrderId);
      res.json({ ok: true, venue: venue, mode: r.mode, order: ord, leverage: r.leverage, brackets: r.brackets, localId: saved.id });
    });
  }).catch(function(err) {
    res.status(502).json({ error: err.message, venue: venue });
  });
});

router.delete('/:id', function(req, res) {
  broker.cancelOrder(req.params.id).then(function(r) { res.json({ ok: true, result: r }); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

module.exports = router;

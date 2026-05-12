'use strict';
/**
 * routes/binance.js — Endpoints específicos de Binance (account/positions/etc).
 * El POST de órdenes va por /api/orders/confirm con venue='binance_spot'|'binance_futures'.
 */
var express = require('express');
var router = express.Router();
var bn = require('../lib/brokerBinance');

router.get('/status', function(req, res) {
  res.json(bn.status());
});

router.get('/account', function(req, res) {
  if (!bn.hasCredentials()) {
    return res.json({
      mode: bn.mode(),
      configured: false,
      message: 'Sin BINANCE_API_KEY — modo solo lectura'
    });
  }
  Promise.all([
    bn.getSpotAccount().catch(function(e) { return { error: e.message }; }),
    bn.getFuturesAccount().catch(function(e) { return { error: e.message }; })
  ]).then(function(r) {
    res.json({
      mode: bn.mode(),
      configured: true,
      spot: r[0],
      futures: r[1]
    });
  });
});

router.get('/positions', function(req, res) {
  if (!bn.hasCredentials()) return res.json({ positions: [] });
  bn.getFuturesPositions().then(function(positions) { res.json({ positions: positions }); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/orders/open', function(req, res) {
  if (!bn.hasCredentials()) return res.json({ orders: [] });
  bn.getOpenFuturesOrders().then(function(orders) { res.json({ orders: orders }); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.delete('/orders/:symbol/:orderId', function(req, res) {
  bn.cancelFuturesOrder(req.params.symbol, req.params.orderId)
    .then(function(r) { res.json(r); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

router.get('/price', function(req, res) {
  var symbol = String(req.query.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' });
  bn.getSpotPrice(symbol).then(function(r) { res.json(r); })
    .catch(function(err) { res.status(502).json({ error: err.message }); });
});

module.exports = router;

'use strict';
/**
 * tests/test_indicators.js — Tests de indicadores técnicos
 */

var assert = require('assert');
var test = require('./runner').test;
var ind = require('../lib/indicators');

// Generar datos de prueba realistas
function generatePrices(n, startPrice, volatility) {
  n = n || 100; startPrice = startPrice || 100; volatility = volatility || 0.02;
  var prices = [startPrice];
  for (var i = 1; i < n; i++) {
    var change = (Math.random() - 0.5) * volatility;
    prices.push(prices[i-1] * (1 + change));
  }
  return prices;
}

function generateOHLCV(n) {
  var ohlcv = [];
  var price = 100;
  for (var i = 0; i < n; i++) {
    var change = (Math.random() - 0.5) * 0.02;
    var close = price * (1 + change);
    var high = close * (1 + Math.random() * 0.01);
    var low = close * (1 - Math.random() * 0.01);
    var open = price;
    ohlcv.push({ open: open, high: high, low: low, close: close, volume: Math.floor(Math.random() * 1000000) });
    price = close;
  }
  return ohlcv;
}

// Test 1: SMA no devuelve NaN
test('SMA: no devuelve NaN con datos válidos', function() {
  var prices = generatePrices(50);
  var sma = ind.calcSMASeries(prices, 20);
  for (var i = 0; i < sma.length; i++) {
    if (sma[i] !== null) {
      assert.ok(!isNaN(sma[i]), 'SMA[' + i + '] no debe ser NaN');
      assert.ok(isFinite(sma[i]), 'SMA[' + i + '] debe ser finito');
    }
  }
});

// Test 2: EMA no devuelve NaN
test('EMA: no devuelve NaN con datos válidos', function() {
  var prices = generatePrices(50);
  var ema = ind.calcEMASeries(prices, 20);
  for (var i = 0; i < ema.length; i++) {
    if (ema[i] !== null) {
      assert.ok(!isNaN(ema[i]), 'EMA[' + i + '] no debe ser NaN');
      assert.ok(isFinite(ema[i]), 'EMA[' + i + '] debe ser finito');
    }
  }
});

// Test 3: RSI en rango [0, 100]
test('RSI: valor en rango [0, 100]', function() {
  var prices = generatePrices(30);
  var rsi = ind.calcRSI(prices, 14);
  assert.ok(rsi !== null, 'RSI no debe ser null');
  assert.ok(!isNaN(rsi), 'RSI no debe ser NaN');
  assert.ok(rsi >= 0 && rsi <= 100, 'RSI debe estar en [0, 100], es ' + rsi);
});

// Test 4: RSI series
test('RSISeries: todos los valores válidos o null', function() {
  var prices = generatePrices(50);
  var rsiS = ind.calcRSISeries(prices, 14);
  assert.ok(rsiS.length === prices.length, 'RSI series debe tener misma longitud');
  for (var i = 0; i < rsiS.length; i++) {
    if (rsiS[i] !== null) {
      assert.ok(!isNaN(rsiS[i]), 'RSISeries[' + i + '] no debe ser NaN');
      assert.ok(rsiS[i] >= 0 && rsiS[i] <= 100, 'RSISeries[' + i + '] debe estar en [0, 100]');
    }
  }
});

// Test 5: MACD no NaN
test('MACD: no devuelve NaN', function() {
  var prices = generatePrices(50);
  var macd = ind.calcMACDSeries(prices);
  for (var i = 0; i < macd.macd.length; i++) {
    if (macd.macd[i] !== null) assert.ok(!isNaN(macd.macd[i]), 'MACD[' + i + '] no debe ser NaN');
    if (macd.signal[i] !== null) assert.ok(!isNaN(macd.signal[i]), 'Signal[' + i + '] no debe ser NaN');
    if (macd.histogram[i] !== null) assert.ok(!isNaN(macd.histogram[i]), 'Histogram[' + i + '] no debe ser NaN');
  }
});

// Test 6: Bollinger Bands orden correcto
test('BB: upper >= middle >= lower', function() {
  var prices = generatePrices(50);
  var bb = ind.calcBBSeries(prices, 20, 2);
  for (var i = 0; i < bb.upper.length; i++) {
    if (bb.upper[i] !== null) {
      assert.ok(bb.upper[i] >= bb.middle[i], 'BB upper[' + i + '] debe ser >= middle[' + i + ']');
      assert.ok(bb.middle[i] >= bb.lower[i], 'BB middle[' + i + '] debe ser >= lower[' + i + ']');
    }
  }
});

// Test 7: ATR positivo
test('ATR: valor positivo', function() {
  var ohlcv = generateOHLCV(30);
  var highs = ohlcv.map(function(c) { return c.high; });
  var lows = ohlcv.map(function(c) { return c.low; });
  var closes = ohlcv.map(function(c) { return c.close; });
  var atr = ind.calcATR(highs, lows, closes, 14);
  assert.ok(atr !== null, 'ATR no debe ser null');
  assert.ok(atr > 0, 'ATR debe ser positivo, es ' + atr);
  assert.ok(!isNaN(atr), 'ATR no debe ser NaN');
});

// Test 8: Estocástico en [0, 100]
test('Stoch: valor en rango [0, 100]', function() {
  var ohlcv = generateOHLCV(30);
  var closes = ohlcv.map(function(c) { return c.close; });
  var highs = ohlcv.map(function(c) { return c.high; });
  var lows = ohlcv.map(function(c) { return c.low; });
  var stoch = ind.calcStochSeries(closes, highs, lows, 14);
  for (var i = 0; i < stoch.length; i++) {
    if (stoch[i] !== null) {
      assert.ok(!isNaN(stoch[i]), 'Stoch[' + i + '] no debe ser NaN');
      assert.ok(stoch[i] >= 0 && stoch[i] <= 100, 'Stoch[' + i + '] debe estar en [0, 100], es ' + stoch[i]);
    }
  }
});

// Test 9: EntryScore con datos válidos
test('EntryScore: score en [0, 100] con datos completos', function() {
  var ohlcv = generateOHLCV(100);
  var closes = ohlcv.map(function(c) { return c.close; });
  var highs = ohlcv.map(function(c) { return c.high; });
  var lows = ohlcv.map(function(c) { return c.low; });
  var price = closes[closes.length - 1];
  var rsi = ind.calcRSI(closes, 14);
  var ma50 = ind.calcSMASeries(closes, 50)[closes.length - 1];
  var bb = ind.calcBBSeries(closes, 20, 2);
  var macd = ind.calcMACDSeries(closes);
  var swLows = ind.findSwingLows(lows.slice(-80), 4);
  var supports = swLows.filter(function(s) { return s < price; }).slice(0, 5);

  var entry = ind.calcEntryScore({
    rsi14: rsi, price: price, ma50: ma50, ma200: null,
    macd: macd.macd[macd.macd.length - 1], macdSig: macd.signal[macd.signal.length - 1],
    bbUp: bb.upper[bb.upper.length - 1], bbLow: bb.lower[bb.lower.length - 1], supports: supports
  });

  assert.ok(entry.score >= 0 && entry.score <= 100, 'score debe estar en [0, 100], es ' + entry.score);
  assert.ok(!isNaN(entry.score), 'score no debe ser NaN');
  assert.ok(Array.isArray(entry.signals), 'signals debe ser array');
  assert.ok(entry.interpretation, 'interpretation debe existir');
});

// Test 10: EntryScore con datos nulos no crashea
test('EntryScore: no crashea con datos nulos', function() {
  var entry = ind.calcEntryScore({
    rsi14: null, price: null, ma50: null, ma200: null,
    macd: null, macdSig: null, bbUp: null, bbLow: null, supports: []
  });
  assert.ok(entry.score === 50, 'score debe ser 50 por defecto, es ' + entry.score);
});

// Test 11: Validación de arrays maneja NaN gracefulmente
test('Validación: array con NaN manejado gracefulmente', function() {
  var result = ind.calcSMASeries([1, 2, NaN, 4], 2);
  // Las posiciones con NaN deberían resultar en null, no en crash
  assert.ok(Array.isArray(result), 'debe devolver un array');
  assert.ok(result.length === 4, 'debe tener misma longitud');
  // Posición 2 (índice 2) tiene NaN en input, la SMA de [2, NaN] debería ser null
  assert.ok(result[2] === null || isNaN(result[2]), 'posición con NaN debe ser null o NaN');
});

// Test 12: Validación: arrays de longitud incorrecta
test('Validación: array muy corto rechazado', function() {
  try {
    ind.calcRSI([1, 2], 14);
    assert.fail('debe lanzar error con array corto');
  } catch (e) {
    assert.ok(e.message.includes('necesita al menos'), 'debe reportar error de longitud');
  }
});

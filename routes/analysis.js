'use strict';
/**
 * routes/analysis.js — Análisis técnico completo v3.1
 * Mejoras: validación de datos mínimos, manejo de NaN, verificación de ohlcv
 */
var express = require('express');
var router = express.Router();
var data = require('../lib/marketData');
var ind = require('../lib/indicators');

var MIN_DIAS_ANALISIS = 30; // Mínimo para indicadores significativos

function safeNumber(n) {
  return (n !== null && n !== undefined && !isNaN(n) && isFinite(n)) ? n : null;
}

router.get('/', function(req, res) {
  var symbol = req.query.symbol || 'NDX';
  
  data.getHistorical(symbol, '1y', '1d').then(function(parsed) {
    var ohlcv = parsed.ohlcv || [];
    var n = ohlcv.length;
    
    // Filtrar velas con datos inválidos (null/NaN en close/high/low) antes de procesar
    ohlcv = ohlcv.filter(function(v) {
      return ind.isValidNumber(v.close) && ind.isValidNumber(v.high) && ind.isValidNumber(v.low);
    });
    n = ohlcv.length;
    
    if (n < 2) {
      return res.status(400).json({ 
        error: 'Datos insuficientes para ' + symbol, 
        disponibles: n, 
        requeridos: MIN_DIAS_ANALISIS 
      });
    }

    var closes = ohlcv.map(function(c) { return c.close; });
    var highs  = ohlcv.map(function(c) { return c.high; });
    var lows   = ohlcv.map(function(c) { return c.low; });

    var ma20s  = ind.calcSMASeries(closes, 20);
    var ma50s  = ind.calcSMASeries(closes, 50);
    var ma200s = n >= 200 ? ind.calcSMASeries(closes, 200) : ind.calcSMASeries(closes, n);
    var rsiS   = ind.calcRSISeries(closes, 14);
    var macdD  = ind.calcMACDSeries(closes);
    var bbD    = ind.calcBBSeries(closes, 20, 2);
    var stochS = ind.calcStochSeries(closes, highs, lows, 14);
    var stochD = ind.calcSMASeries(stochS, 3);
    var atr    = ind.calcATR(highs, lows, closes, 14);

    var price     = closes[n-1];
    var prevPrice = closes[n-2];
    var change    = price - prevPrice;
    var changePct = prevPrice !== 0 ? (change / prevPrice) * 100 : null;
    
    var rsi14     = safeNumber(rsiS[n-1]);
    var ma20c     = safeNumber(ma20s[n-1]);
    var ma50c     = safeNumber(ma50s[n-1]);
    var ma200c    = safeNumber(ma200s[n-1]);
    var macdC     = safeNumber(macdD.macd[n-1]);
    var macdSigC  = safeNumber(macdD.signal[n-1]);
    var bbUpC     = safeNumber(bbD.upper[n-1]);
    var bbLowC    = safeNumber(bbD.lower[n-1]);
    var stochCur  = safeNumber(stochS[n-1]);
    var stochDCur = safeNumber(stochD[n-1]);
    var atrSafe   = safeNumber(atr);

    var swLows      = ind.findSwingLows(lows.slice(-80), 4);
    var swHighs     = ind.findSwingHighs(highs.slice(-80), 4);
    var supports    = swLows.filter(function(s) { return s < price; }).slice(0, 5);
    var resistances = swHighs.filter(function(h) { return h > price; }).slice(0, 5);
    var yearHigh    = Math.max.apply(null, highs);
    var yearLow     = Math.min.apply(null, lows);

    var histStats = n >= 35 ? ind.calcHistStats(closes, rsiS) : null;
    var entry = ind.calcEntryScore({
      rsi14: rsi14, price: price, ma50: ma50c, ma200: ma200c,
      macd: macdC, macdSig: macdSigC, bbUp: bbUpC, bbLow: bbLowC, supports: supports
    });
    var suggestion = ind.calcSuggestion(price, entry.score, entry.type, atrSafe, supports, resistances, rsi14, ma50c, bbUpC, bbLowC);

    var indicadores = {
      rsi14: rsi14, atr14: atrSafe, macd: macdC, macdSignal: macdSigC,
      stochK: stochCur, stochD: stochDCur
    };
    var bandasBollinger = { upper: bbUpC, lower: bbLowC };
    var sugerencia = {
      score: entry.score,
      interpretacion: entry.interpretation,
      señales: entry.signals
    };

    var chartData = ohlcv.slice(-90).map(function(c, i) {
      var idx = n - 90 + i;
      return {
        timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        ma20: ma20s[idx], ma50: ma50s[idx],
        rsi: rsiS[idx],
        macd: macdD.macd[idx], macdSig: macdD.signal[idx], macdHist: macdD.histogram[idx],
        bbUp: bbD.upper[idx], bbMid: ma20s[idx], bbLow: bbD.lower[idx]
      };
    });

    res.json({
      symbol: symbol, 
      price: price, 
      change: change, 
      changePct: changePct,
      indicadores: indicadores, 
      bandasBollinger: bandasBollinger, 
      sugerencia: sugerencia,
      rsi14: rsi14, 
      stoch: stochCur, 
      atr: atrSafe,
      ma20: ma20c, 
      ma50: ma50c, 
      ma200: ma200c,
      macd: macdC, 
      macdSig: macdSigC, 
      macdHist: (macdC !== null && macdSigC !== null) ? safeNumber(macdC - macdSigC) : null,
      bbUp: bbUpC, 
      bbMid: ma20c, 
      bbLow: bbLowC,
      supports: supports, 
      resistances: resistances,
      yearHigh: yearHigh, 
      yearLow: yearLow,
      entry: entry, 
      suggestion: suggestion, 
      histStats: histStats,
      chartData: chartData, 
      lastUpdate: new Date().toISOString(),
      _meta: {
        diasDisponibles: n,
        datosSuficientes: n >= MIN_DIAS_ANALISIS,
        calculosRealizados: {
          sma20: ma20c !== null,
          sma50: ma50c !== null,
          sma200: ma200c !== null,
          rsi14: rsi14 !== null,
          macd: macdC !== null,
          bb: bbUpC !== null,
          atr14: atrSafe !== null,
          stoch: stochCur !== null
        }
      }
    });

  }).catch(function(err) {
    res.status(500).json({ error: err.message, symbol: symbol });
  });
});

module.exports = router;

'use strict';
/**
 * lib/signalEngine.js — Motor de decisión con 4 acciones direccionales
 *
 * Acciones:
 *   LONG       → abrir posición larga (comprar, esperando subida)
 *   SHORT      → abrir posición corta (vender en descubierto, esperando bajada)
 *   EXIT_LONG  → cerrar largo abierto (tomar ganancia / cortar pérdida)
 *   EXIT_SHORT → cubrir corto abierto (recomprar)
 *   HOLD       → sin convicción, esperar
 *
 * Devuelve también scores separados para long_score, short_score y exit_score
 * para que la UI muestre el "potencial" continuo aunque no haya señal fuerte.
 */

var ind = require('./indicators');

var CONFIG = {
  // Umbrales para emitir señales fuertes (las que se notifican)
  longVotesRequired:  3,
  shortVotesRequired: 3,
  exitLongRsi:        75,   // RSI >= 75 sugiere salir de largo (sobrecompra extrema)
  exitShortRsi:       25,
  // Indicadores
  rsiLongEntry:       35,
  rsiShortEntry:      70,
  bbLongPos:          0.10,
  bbShortPos:         0.90,
  // Risk management
  rrRatio:            2.0,
  minBars:            60
};

function isValid(n) { return n !== null && n !== undefined && !isNaN(n) && isFinite(n); }

function computeSignal(ohlcv) {
  if (!Array.isArray(ohlcv) || ohlcv.length < CONFIG.minBars) {
    return { action: 'HOLD', score: 0, long_score: 0, short_score: 0,
             reasons: ['Datos insuficientes'], indicators: {} };
  }

  var closes = ohlcv.map(function(c) { return c.close; }).filter(isValid);
  var highs  = ohlcv.map(function(c) { return c.high;  }).filter(isValid);
  var lows   = ohlcv.map(function(c) { return c.low;   }).filter(isValid);
  if (closes.length < CONFIG.minBars) {
    return { action: 'HOLD', score: 0, long_score: 0, short_score: 0,
             reasons: ['Datos no válidos'], indicators: {} };
  }

  var n = closes.length;
  var price = closes[n - 1];
  var prevPrice = closes[n - 2];

  var rsiS  = ind.calcRSISeries(closes, 14);
  var macdD = ind.calcMACDSeries(closes);
  var bbD   = ind.calcBBSeries(closes, 20, 2);
  var ma50s = ind.calcSMASeries(closes, 50);
  var ma200s = closes.length >= 200 ? ind.calcSMASeries(closes, 200) : null;
  var swLows = ind.findSwingLows(lows.slice(-80), 4);

  var rsi      = rsiS[n - 1];
  var prevRsi  = rsiS[n - 2];
  var macd     = macdD.macd[n - 1];
  var macdSig  = macdD.signal[n - 1];
  var prevMacd = macdD.macd[n - 2];
  var prevSig  = macdD.signal[n - 2];
  var bbLow    = bbD.lower[n - 1];
  var bbUp     = bbD.upper[n - 1];
  var ma50     = ma50s[n - 1];
  var ma200    = ma200s ? ma200s[n - 1] : null;

  var bbPos = (isValid(bbUp) && isValid(bbLow) && bbUp !== bbLow)
    ? (price - bbLow) / (bbUp - bbLow) : null;
  var macdCrossUp   = isValid(prevMacd) && isValid(prevSig) && isValid(macd) && isValid(macdSig) &&
                      (prevMacd - prevSig) <= 0 && (macd - macdSig) > 0;
  var macdCrossDown = isValid(prevMacd) && isValid(prevSig) && isValid(macd) && isValid(macdSig) &&
                      (prevMacd - prevSig) >= 0 && (macd - macdSig) < 0;
  var trendUp   = isValid(ma200) && isValid(ma50) && ma50 > ma200;
  var trendDown = isValid(ma200) && isValid(ma50) && ma50 < ma200;

  // ─── Votos para LONG (entrada larga) ────────────────────────────────────
  var longVotes = 0;
  var longReasons = [];
  if (isValid(rsi) && rsi <= CONFIG.rsiLongEntry) {
    longVotes++;
    longReasons.push('RSI sobreventa ' + rsi.toFixed(1));
  }
  if (isValid(bbPos) && bbPos <= CONFIG.bbLongPos) {
    longVotes++;
    longReasons.push('Precio en banda inferior BB (' + (bbPos * 100).toFixed(0) + '%)');
  }
  if (macdCrossUp) {
    longVotes++;
    longReasons.push('MACD cruzó al alza');
  }
  if (trendUp) {
    longVotes++;
    longReasons.push('Tendencia alcista (MA50 > MA200)');
  }
  if (isValid(prevRsi) && isValid(rsi) && prevRsi < 30 && rsi >= 30) {
    longVotes++;
    longReasons.push('RSI saliendo de sobreventa');
  }

  // ─── Votos para SHORT (entrada corta) ───────────────────────────────────
  var shortVotes = 0;
  var shortReasons = [];
  if (isValid(rsi) && rsi >= CONFIG.rsiShortEntry) {
    shortVotes++;
    shortReasons.push('RSI sobrecompra ' + rsi.toFixed(1));
  }
  if (isValid(bbPos) && bbPos >= CONFIG.bbShortPos) {
    shortVotes++;
    shortReasons.push('Precio en banda superior BB (' + (bbPos * 100).toFixed(0) + '%)');
  }
  if (macdCrossDown) {
    shortVotes++;
    shortReasons.push('MACD cruzó a la baja');
  }
  if (trendDown) {
    shortVotes++;
    shortReasons.push('Tendencia bajista (MA50 < MA200)');
  }
  if (isValid(prevRsi) && isValid(rsi) && prevRsi > 70 && rsi <= 70) {
    shortVotes++;
    shortReasons.push('RSI saliendo de sobrecompra');
  }

  // ─── Scores continuos (0-100) para mostrar en panel de oportunidades ────
  // Cada voto vale 20 puntos, máximo 100
  var longScore = Math.min(100, longVotes * 20);
  var shortScore = Math.min(100, shortVotes * 20);

  // ─── Determinar acción dominante ────────────────────────────────────────
  var action = 'HOLD';
  var reasons = ['Sin convergencia clara — mantener'];
  var score = Math.max(longScore, shortScore);
  var direction = 'neutral';

  // Salidas tienen prioridad: si RSI está extremo en una dirección, sugerir salir
  if (isValid(rsi) && rsi >= CONFIG.exitLongRsi) {
    action = 'EXIT_LONG';
    direction = 'exit_long';
    reasons = ['RSI ' + rsi.toFixed(1) + ' ≥ ' + CONFIG.exitLongRsi + ' — toma de ganancias en largo'];
    if (isValid(bbPos) && bbPos > 0.95) reasons.push('Precio tocando banda superior BB');
    score = Math.min(100, Math.round((rsi - CONFIG.exitLongRsi) * 4 + 60));
  } else if (isValid(rsi) && rsi <= CONFIG.exitShortRsi) {
    action = 'EXIT_SHORT';
    direction = 'exit_short';
    reasons = ['RSI ' + rsi.toFixed(1) + ' ≤ ' + CONFIG.exitShortRsi + ' — cubrir corto'];
    if (isValid(bbPos) && bbPos < 0.05) reasons.push('Precio tocando banda inferior BB');
    score = Math.min(100, Math.round((CONFIG.exitShortRsi - rsi) * 4 + 60));
  } else if (longVotes >= CONFIG.longVotesRequired && longVotes > shortVotes) {
    action = 'LONG';
    direction = 'long';
    reasons = longReasons;
    score = longScore;
  } else if (shortVotes >= CONFIG.shortVotesRequired && shortVotes > longVotes) {
    action = 'SHORT';
    direction = 'short';
    reasons = shortReasons;
    score = shortScore;
  } else if (longScore > shortScore && longScore >= 40) {
    // Inclinación a largo sin convicción plena → "watch long"
    reasons = ['Inclinación alcista parcial: ' + longReasons.slice(0, 2).join(', ')];
    direction = 'lean_long';
  } else if (shortScore > longScore && shortScore >= 40) {
    reasons = ['Inclinación bajista parcial: ' + shortReasons.slice(0, 2).join(', ')];
    direction = 'lean_short';
  }

  // ─── Stop loss y take profit ────────────────────────────────────────────
  var stopLoss = null;
  var takeProfit = null;
  if (action === 'LONG') {
    var supports = swLows.filter(function(s) { return s < price; }).slice(0, 5);
    if (supports.length > 0) {
      stopLoss = supports[0];
      var dist = price - stopLoss;
      if (dist > 0) takeProfit = price + dist * CONFIG.rrRatio;
    }
  } else if (action === 'SHORT') {
    var recentHigh = Math.max.apply(null, highs.slice(-20).filter(isValid));
    if (isValid(recentHigh) && recentHigh > price) {
      stopLoss = recentHigh;
      var distS = stopLoss - price;
      if (distS > 0) takeProfit = price - distS * CONFIG.rrRatio;
    }
  } else if (action === 'EXIT_LONG' || action === 'EXIT_SHORT') {
    // En las salidas, "take profit" = precio actual (es la sugerencia de cerrar);
    // "stop loss" sin sentido aquí
    takeProfit = price;
  }

  return {
    action: action,
    direction: direction,
    score: Math.round(score),
    long_score: longScore,
    short_score: shortScore,
    reasons: reasons,
    long_reasons: longReasons,
    short_reasons: shortReasons,
    price: price,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    indicators: {
      rsi: isValid(rsi) ? +rsi.toFixed(2) : null,
      macd: isValid(macd) ? +macd.toFixed(4) : null,
      macd_signal: isValid(macdSig) ? +macdSig.toFixed(4) : null,
      bb_position: isValid(bbPos) ? +bbPos.toFixed(3) : null,
      ma50: isValid(ma50) ? +ma50.toFixed(2) : null,
      ma200: isValid(ma200) ? +ma200.toFixed(2) : null,
      trend: trendUp ? 'up' : (trendDown ? 'down' : 'neutral'),
      long_votes: longVotes,
      short_votes: shortVotes,
      change_pct: isValid(prevPrice) && prevPrice !== 0 ? +(((price - prevPrice) / prevPrice) * 100).toFixed(3) : null
    },
    ts: Date.now()
  };
}

module.exports = {
  computeSignal: computeSignal,
  _config: CONFIG
};

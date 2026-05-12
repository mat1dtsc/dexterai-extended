'use strict';
/**
 * lib/indicators.js — Indicadores técnicos puros (sin librerías externas)
 * v2.0: Validaciones robustas, manejo de NaN, y verificación de inputs
 */

// ─── Helpers de validación ───────────────────────────────────────────────────
function isValidNumber(n) {
  return n !== null && n !== undefined && !isNaN(n) && isFinite(n);
}

function validateArray(arr, minLen, name) {
  if (!Array.isArray(arr)) throw new Error(name + ' debe ser un array');
  if (arr.length < minLen) throw new Error(name + ' necesita al menos ' + minLen + ' elementos, tiene ' + arr.length);
  return true;
}

function safeNumber(n, fallback) {
  fallback = fallback !== undefined ? fallback : null;
  return isValidNumber(n) ? n : fallback;
}

// ─── Medias Móviles ─────────────────────────────────────────────────────────
function calcSMASeries(arr, period) {
  validateArray(arr, period, 'arr');
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    var s = 0;
    for (var j = i - period + 1; j <= i; j++) s += arr[j];
    out.push(s / period);
  }
  return out;
}

function calcEMASeries(arr, period) {
  validateArray(arr, period, 'arr');
  var k = 2 / (period + 1);
  var out = [], ema = null, seedSum = 0, seedCount = 0;
  for (var i = 0; i < arr.length; i++) {
    if (!isValidNumber(arr[i])) { out.push(null); continue; } // saltar nulls
    if (ema === null) {
      seedSum += arr[i]; seedCount++;
      if (seedCount < period) { out.push(null); continue; }
      ema = seedSum / period;
    } else {
      ema = arr[i] * k + ema * (1 - k);
    }
    out.push(ema);
  }
  return out;
}

// ─── RSI ──────────────────────────────────────────────────────────────────────
function calcRSI(arr, period) {
  validateArray(arr, period + 1, 'arr');
  var g = 0, l = 0;
  for (var i = 1; i <= period; i++) {
    var d = arr[i] - arr[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  var ag = g / period, al = l / period;
  for (var i = period + 1; i < arr.length; i++) {
    var d = arr[i] - arr[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  var rsi = 100 - (100 / (1 + ag / al));
  return isValidNumber(rsi) ? rsi : null;
}

function calcRSISeries(arr, period) {
  if (!Array.isArray(arr) || arr.length < period + 1) {
    return arr.map(function() { return null; });
  }
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (i < period) { out.push(null); continue; }
    try {
      out.push(calcRSI(arr.slice(0, i + 1), period));
    } catch (e) {
      out.push(null);
    }
  }
  return out;
}

// ─── MACD ───────────────────────────────────────────────────────────────────────
function calcMACDSeries(arr) {
  validateArray(arr, 26, 'arr');
  var e12 = calcEMASeries(arr, 12);
  var e26 = calcEMASeries(arr, 26);
  var macdLine = arr.map(function(_, i) {
    return (e12[i] !== null && e26[i] !== null) ? e12[i] - e26[i] : null;
  });
  var validMacd = macdLine.filter(function(v) { return v !== null; });
  var sigEMA = calcEMASeries(validMacd, 9);
  var signal = [], si = 0;
  for (var i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) signal.push(null);
    else signal.push(si < sigEMA.length ? sigEMA[si++] : null);
  }
  var hist = macdLine.map(function(v, i) {
    return (v !== null && signal[i] !== null) ? v - signal[i] : null;
  });
  return { macd: macdLine, signal: signal, histogram: hist };
}

// ─── Bollinger Bands ────────────────────────────────────────────────────────
function calcBBSeries(arr, period, mult) {
  validateArray(arr, period, 'arr');
  mult = mult || 2;
  var sma = calcSMASeries(arr, period);
  var upper = [], lower = [];
  for (var i = 0; i < arr.length; i++) {
    if (sma[i] === null) { upper.push(null); lower.push(null); continue; }
    var s = 0;
    for (var j = i - period + 1; j <= i; j++) s += Math.pow(arr[j] - sma[i], 2);
    var sd = Math.sqrt(s / period);
    upper.push(sma[i] + mult * sd);
    lower.push(sma[i] - mult * sd);
  }
  return { upper: upper, middle: sma, lower: lower };
}

// ─── ATR (Average True Range) ─────────────────────────────────────────────────
function calcATR(highs, lows, closes, period) {
  period = period || 14;
  validateArray(highs, 2, 'highs');
  validateArray(lows, 2, 'lows');
  validateArray(closes, 2, 'closes');
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new Error('highs, lows, y closes deben tener la misma longitud');
  }
  var trs = [];
  for (var i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  if (trs.length === 0) return null;
  var recent = trs.slice(-period);
  return recent.reduce(function(a, b) { return a + b; }, 0) / recent.length;
}

function calcATRSeries(highs, lows, closes, period) {
  period = period || 14;
  validateArray(highs, period + 1, 'highs');
  validateArray(lows, period + 1, 'lows');
  validateArray(closes, period + 1, 'closes');
  if (highs.length !== lows.length || highs.length !== closes.length) {
    throw new Error('highs, lows, y closes deben tener la misma longitud');
  }
  var out = [];
  for (var i = 0; i < closes.length; i++) {
    if (i < period) { out.push(null); continue; }
    var trs = [];
    for (var j = i - period + 1; j <= i; j++) {
      if (!isValidNumber(highs[j]) || !isValidNumber(lows[j]) || !isValidNumber(closes[j]) || !isValidNumber(closes[j - 1])) {
        continue; // saltar velas corruptas en el cálculo
      }
      trs.push(Math.max(
        highs[j] - lows[j],
        Math.abs(highs[j] - closes[j - 1]),
        Math.abs(lows[j] - closes[j - 1])
      ));
    }
    if (trs.length === 0) { out.push(null); continue; }
    out.push(trs.reduce(function(a, b) { return a + b; }, 0) / trs.length);
  }
  return out;
}

// ─── Estocástico ────────────────────────────────────────────────────────────
function calcStochSeries(closes, highs, lows, period) {
  period = period || 14;
  validateArray(closes, period, 'closes');
  validateArray(highs, period, 'highs');
  validateArray(lows, period, 'lows');
  if (closes.length !== highs.length || closes.length !== lows.length) {
    throw new Error('closes, highs, y lows deben tener la misma longitud');
  }
  var out = [];
  for (var i = 0; i < closes.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    var hh = Math.max.apply(null, highs.slice(i - period + 1, i + 1));
    var ll = Math.min.apply(null, lows.slice(i - period + 1, i + 1));
    if (!isValidNumber(hh) || !isValidNumber(ll)) {
      out.push(null);
      continue;
    }
    out.push(hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100);
  }
  return out;
}

// ─── Swing Highs / Lows ───────────────────────────────────────────────────────
function findSwingLows(lows, window) {
  validateArray(lows, window * 2 + 1, 'lows');
  var out = [];
  for (var i = window; i < lows.length - window; i++) {
    if (!isValidNumber(lows[i])) continue; // ignorar nulls
    var ok = true;
    for (var j = i - window; j <= i + window; j++) {
      if (j !== i && isValidNumber(lows[j]) && lows[j] < lows[i]) { ok = false; break; }
    }
    if (ok) out.push(lows[i]);
  }
  return out.sort(function(a, b) { return b - a; });
}

function findSwingHighs(highs, window) {
  validateArray(highs, window * 2 + 1, 'highs');
  var out = [];
  for (var i = window; i < highs.length - window; i++) {
    if (!isValidNumber(highs[i])) continue; // ignorar nulls
    var ok = true;
    for (var j = i - window; j <= i + window; j++) {
      if (j !== i && isValidNumber(highs[j]) && highs[j] > highs[i]) { ok = false; break; }
    }
    if (ok) out.push(highs[i]);
  }
  return out.sort(function(a, b) { return b - a; });
}

// ─── Estadísticas históricas por condición RSI ────────────────────────────────
function calcHistStats(closes, rsiSeries) {
  validateArray(closes, 35, 'closes');
  if (!Array.isArray(rsiSeries) || rsiSeries.length !== closes.length) {
    throw new Error('rsiSeries debe ser un array de igual longitud que closes');
  }
  var n = closes.length;
  var ov = { count: 0, up: 0, ret: 0 };
  var ob = { count: 0, down: 0, ret: 0 };
  var ma = { count: 0, up: 0, ret: 0 };
  var ma50s = calcSMASeries(closes, 50);
  for (var i = 14; i < n - 20; i++) {
    var rsi = rsiSeries[i]; if (rsi === null || !isValidNumber(rsi)) continue;
    if (!isValidNumber(closes[i]) || !isValidNumber(closes[i + 20])) continue;
    var ret20 = (closes[i + 20] - closes[i]) / closes[i] * 100;
    if (rsi < 35) { ov.count++; ov.ret += ret20; if (ret20 > 0) ov.up++; }
    if (rsi > 65) { ob.count++; ob.ret += ret20; if (ret20 < 0) ob.down++; }
    if (ma50s[i] !== null && closes[i - 1] > ma50s[i - 1] && closes[i] <= ma50s[i] * 1.01 && closes[i] > ma50s[i] * 0.99) {
      ma.count++; ma.ret += ret20; if (ret20 > 0) ma.up++;
    }
  }
  return {
    oversold: {
      count: ov.count,
      winPct: ov.count ? Math.round(ov.up / ov.count * 100) : 0,
      avgRet: ov.count ? (ov.ret / ov.count).toFixed(1) : '0.0'
    },
    overbought: {
      count: ob.count,
      winPct: ob.count ? Math.round(ob.down / ob.count * 100) : 0,
      avgRet: ob.count ? (ob.ret / ob.count).toFixed(1) : '0.0'
    },
    ma50Touch: {
      count: ma.count,
      winPct: ma.count ? Math.round(ma.up / ma.count * 100) : 0,
      avgRet: ma.count ? (ma.ret / ma.count).toFixed(1) : '0.0'
    }
  };
}

// ─── Score de entrada ─────────────────────────────────────────────────────────
function calcEntryScore(p) {
  p = p || {};
  var score = 50, signals = [];
  var rsi = safeNumber(p.rsi14);
  var price = safeNumber(p.price);
  var ma50 = safeNumber(p.ma50);
  var ma200 = safeNumber(p.ma200);
  var macd = safeNumber(p.macd);
  var macdSig = safeNumber(p.macdSig);
  var bbUp = safeNumber(p.bbUp);
  var bbLow = safeNumber(p.bbLow);
  var supports = Array.isArray(p.supports) ? p.supports.filter(isValidNumber) : [];

  if (rsi !== null) {
    if      (rsi < 25) { score += 35; signals.push({ t: 'FUERTE',   msg: 'RSI ' + rsi.toFixed(1) + ': Sobreventa extrema', w: '+35' }); }
    else if (rsi < 35) { score += 22; signals.push({ t: 'COMPRA',   msg: 'RSI ' + rsi.toFixed(1) + ': Zona sobreventa', w: '+22' }); }
    else if (rsi < 45) { score += 10; signals.push({ t: 'POSITIVO', msg: 'RSI ' + rsi.toFixed(1) + ': Neutro-bajo favorable', w: '+10' }); }
    else if (rsi > 78) { score -= 32; signals.push({ t: 'EVITAR',   msg: 'RSI ' + rsi.toFixed(1) + ': Sobrecompra extrema', w: '-32' }); }
    else if (rsi > 68) { score -= 18; signals.push({ t: 'ESPERAR',  msg: 'RSI ' + rsi.toFixed(1) + ': Sobrecomprado', w: '-18' }); }
    else if (rsi > 58) { score -= 5;  signals.push({ t: 'NEUTRO',   msg: 'RSI ' + rsi.toFixed(1) + ': Neutro-alto', w: '-5' }); }
  }
  if (ma50 !== null && price !== null) {
    var d50 = (price - ma50) / ma50 * 100;
    if      (d50 > 8)  { score -= 8;  signals.push({ t: 'ESPERAR',  msg: 'Precio +' + d50.toFixed(1) + '% sobre MA50', w: '-8' }); }
    else if (d50 > 0)  { score += 10; signals.push({ t: 'POSITIVO', msg: 'Precio sobre MA50 (+' + d50.toFixed(1) + '%)', w: '+10' }); }
    else if (d50 > -2) { score += 15; signals.push({ t: 'COMPRA',   msg: 'Precio tocando MA50', w: '+15' }); }
    else               { score -= 12; signals.push({ t: 'ESPERAR',  msg: 'Precio bajo MA50 (' + d50.toFixed(1) + '%)', w: '-12' }); }
  }
  if (ma200 !== null && price !== null) {
    if (price > ma200) { score += 10; signals.push({ t: 'POSITIVO', msg: 'Precio sobre MA200: macro alcista', w: '+10' }); }
    else               { score -= 15; signals.push({ t: 'ESPERAR',  msg: 'Precio bajo MA200: macro bajista', w: '-15' }); }
  }
  if (macd !== null && macdSig !== null) {
    var h = macd - macdSig;
    if      (macd > 0 && h > 0) { score += 10; signals.push({ t: 'POSITIVO', msg: 'MACD positivo sobre señal', w: '+10' }); }
    else if (macd < 0 && h > 0) { score += 7;  signals.push({ t: 'POSITIVO', msg: 'MACD cruzando al alza', w: '+7' }); }
    else if (macd > 0 && h < 0) { score -= 5;  signals.push({ t: 'NEUTRO',   msg: 'MACD positivo debilitándose', w: '-5' }); }
    else                        { score -= 12; signals.push({ t: 'ESPERAR',  msg: 'MACD negativo bajo señal', w: '-12' }); }
  }
  if (bbLow !== null && bbUp !== null && price !== null) {
    var bbRange = bbUp - bbLow;
    var pos = bbRange > 0 ? (price - bbLow) / bbRange : 0.5;
    if      (pos <= 0.05) { score += 20; signals.push({ t: 'FUERTE',  msg: 'Precio en banda inferior BB', w: '+20' }); }
    else if (pos <= 0.20) { score += 12; signals.push({ t: 'COMPRA',  msg: 'Cerca banda inferior BB', w: '+12' }); }
    else if (pos >= 0.95) { score -= 18; signals.push({ t: 'EVITAR',  msg: 'Precio en banda superior BB', w: '-18' }); }
    else if (pos >= 0.80) { score -= 10; signals.push({ t: 'ESPERAR', msg: 'Cerca banda superior BB', w: '-10' }); }
  }
  var nearSup = supports.find(function(s) { return s < price; });
  if (nearSup) {
    var ds = (price - nearSup) / nearSup * 100;
    if      (ds < 0.8) { score += 14; signals.push({ t: 'COMPRA',   msg: 'Sobre soporte ' + nearSup.toFixed(0), w: '+14' }); }
    else if (ds < 2.5) { score += 7;  signals.push({ t: 'POSITIVO', msg: 'Cerca soporte ' + nearSup.toFixed(0), w: '+7' }); }
  }

  score = Math.max(0, Math.min(100, score));
  var interp, itype;
  if      (score >= 80) { interp = 'SEÑAL FUERTE DE ENTRADA'; itype = 'strong_buy'; }
  else if (score >= 65) { interp = 'BUENA OPORTUNIDAD';      itype = 'buy'; }
  else if (score >= 50) { interp = 'CONDICION NEUTRAL';       itype = 'neutral'; }
  else if (score >= 35) { interp = 'ESPERAR CONFIRMACION';    itype = 'wait'; }
  else                  { interp = 'NO ENTRAR — RIESGO ELEVADO'; itype = 'strong_wait'; }

  return { score: score, signals: signals, interpretation: interp, type: itype };
}

// ─── Sugerencia operativa ─────────────────────────────────────────────────────
function calcSuggestion(price, score, scoreType, atr, supports, resistances, rsi, ma50, bbUp, bbLow) {
  price = safeNumber(price);
  score = safeNumber(score, 50);
  atr = safeNumber(atr, 0);
  rsi = safeNumber(rsi);
  ma50 = safeNumber(ma50);
  bbUp = safeNumber(bbUp);
  bbLow = safeNumber(bbLow);
  supports = Array.isArray(supports) ? supports.filter(isValidNumber) : [];
  resistances = Array.isArray(resistances) ? resistances.filter(isValidNumber) : [];

  var action, actionType, reasoning = [];

  if      (score >= 65) { action = 'COMPRAR';          actionType = 'buy'; }
  else if (score <= 35) { action = 'CONSIDERAR VENTA'; actionType = 'sell'; }
  else                  { action = 'ESPERAR';          actionType = 'wait'; }

  var nearestSup = supports.find(function(s) { return s < price; });
  var slLong = nearestSup && price ? nearestSup * 0.988 : (price ? price - 2 * atr : 0);
  var nearestRes = resistances[0] || null;
  var tpLong = nearestRes && price ? nearestRes * 0.998 : (price ? price + (price - slLong) * 2.5 : 0);

  var slShort = nearestRes && price ? nearestRes * 1.012 : (price ? price + 2 * atr : 0);
  var nearestSup2 = supports[1] || supports[0] || null;
  var tpShort = nearestSup2 && price ? nearestSup2 * 1.002 : (price ? price - 2 * atr * 2.5 : 0);

  var rrLong = (tpLong > price && price > slLong) ? (tpLong - price) / (price - slLong) : null;
  var rrShort = (slShort > price && price > tpShort) ? (price - tpShort) / (slShort - price) : null;

  if (rsi !== null) {
    if (rsi > 68) reasoning.push('RSI sobrecomprado (' + rsi.toFixed(1) + ')');
    if (rsi < 35) reasoning.push('RSI en sobreventa (' + rsi.toFixed(1) + ')');
  }
  if (ma50 !== null && price !== null) {
    if (price > ma50 * 1.08) reasoning.push('precio muy extendido sobre MA50');
    if (price < ma50 * 0.98) reasoning.push('precio bajo MA50');
  }
  if (bbUp !== null && price !== null) {
    if (price > bbUp * 0.998) reasoning.push('precio sobre banda superior BB');
  }
  if (bbLow !== null && price !== null) {
    if (price < bbLow * 1.002) reasoning.push('precio en banda inferior BB');
  }
  if (nearestSup) reasoning.push('soporte clave en ' + Math.round(nearestSup).toLocaleString('es-CL'));
  if (nearestRes)  reasoning.push('resistencia en ' + Math.round(nearestRes).toLocaleString('es-CL'));

  var actionText;
  if (actionType === 'buy') {
    actionText = 'Condiciones estadísticas favorables para entrada larga. Confirmar con volumen creciente.';
  } else if (actionType === 'sell') {
    actionText = 'Indicadores desfavorables para largos. Considerar salida o esperar mejor punto.';
  } else {
    actionText = 'Mercado sin señal clara. Esperar zona de soporte/resistencia definida.';
  }

  return {
    action: action,
    actionType: actionType,
    actionText: actionText,
    reasoning: reasoning,
    long:  { sl: slLong,  tp: tpLong,  slPct: price ? ((price - slLong)  / price * 100) : null, tpPct: price ? ((tpLong  - price) / price * 100) : null, rr: rrLong  },
    short: { sl: slShort, tp: tpShort, slPct: price ? ((slShort - price)  / price * 100) : null, tpPct: price ? ((price - tpShort) / price * 100) : null, rr: rrShort }
  };
}

module.exports = {
  isValidNumber: isValidNumber,
  validateArray: validateArray,
  safeNumber: safeNumber,
  calcSMASeries: calcSMASeries,
  calcEMASeries: calcEMASeries,
  calcRSI: calcRSI,
  calcRSISeries: calcRSISeries,
  calcMACDSeries: calcMACDSeries,
  calcBBSeries: calcBBSeries,
  calcATR: calcATR,
  calcATRSeries: calcATRSeries,
  calcStochSeries: calcStochSeries,
  findSwingLows: findSwingLows,
  findSwingHighs: findSwingHighs,
  calcHistStats: calcHistStats,
  calcEntryScore: calcEntryScore,
  calcSuggestion: calcSuggestion
};

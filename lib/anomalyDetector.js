'use strict';
/**
 * lib/anomalyDetector.js — Detección de anomalías de precio y volumen
 * Detecta movimientos estadísticamente significativos para correlacionar con noticias
 */

// ─── Detectar anomalías en un símbolo ──────────────────────────────────────
function detectAnomalies(symbol, ohlcv, newsIds) {
  if (!Array.isArray(ohlcv) || ohlcv.length < 30) {
    return { anomalies: [], stats: null };
  }

  var n = ohlcv.length;
  var closes = ohlcv.map(function(c) { return c.close; });
  var volumes = ohlcv.map(function(c) { return c.volume || 0; });
  var highs = ohlcv.map(function(c) { return c.high; });
  var lows = ohlcv.map(function(c) { return c.low; });

  // Calcular estadísticas
  var sma20 = calcSMA(closes, 20);
  var avgVolume = volumes.reduce(function(a, b) { return a + b; }, 0) / volumes.length;
  var volumeStd = calcStdDev(volumes);
  var returns = [];
  for (var i = 1; i < n; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  var avgReturn = returns.reduce(function(a, b) { return a + b; }, 0) / returns.length;
  var returnStd = calcStdDev(returns);

  var anomalies = [];

  for (var i = 20; i < n; i++) {
    var r = returns[i - 1]; // retorno del día i
    var vol = volumes[i];
    var volZscore = volumeStd > 0 ? (vol - avgVolume) / volumeStd : 0;

    // Volatilidad intradía
    var intradayRange = (highs[i] - lows[i]) / closes[i];
    var avgRange = 0;
    for (var j = i - 20; j <= i; j++) {
      avgRange += (highs[j] - lows[j]) / closes[j];
    }
    avgRange /= 21;
    var volSpike = avgRange > 0 ? intradayRange / avgRange : 1;

    // Forward returns (si tenemos datos futuros)
    var ret1h = null, ret1d = null, ret5d = null;
    if (i < n - 1) ret1h = (closes[i + 1] - closes[i]) / closes[i] * 100;
    if (i < n - 5) ret1d = (closes[i + 5] - closes[i]) / closes[i] * 100;
    if (i < n - 20) ret5d = (closes[i + 20] - closes[i]) / closes[i] * 100;

    // Detectar anomalía: retorno > 2σ O volumen > 3σ O volatilidad > 3x
    var isAnomaly = Math.abs(r - avgReturn) > 2 * returnStd ||
                    volZscore > 3 ||
                    volSpike > 3;

    if (isAnomaly) {
      var anomalyType = [];
      if (Math.abs(r - avgReturn) > 2 * returnStd) anomalyType.push(r > 0 ? 'price_spike_up' : 'price_spike_down');
      if (volZscore > 3) anomalyType.push('volume_spike');
      if (volSpike > 3) anomalyType.push('volatility_spike');

      anomalies.push({
        symbol: symbol,
        timestamp: ohlcv[i].timestamp,
        price: closes[i],
        return_1h: ret1h,
        return_1d: ret1d,
        return_5d: ret5d,
        volume_zscore: volZscore,
        volatility_spike: volSpike,
        news_ids: newsIds || [],
        anomaly_type: anomalyType.join('+')
      });
    }
  }

  return {
    anomalies: anomalies,
    stats: {
      avgReturn: avgReturn,
      returnStd: returnStd,
      avgVolume: avgVolume,
      volumeStd: volumeStd
    }
  };
}

// ─── Helpers matemáticos ───────────────────────────────────────────────────
function calcSMA(arr, period) {
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    var s = 0;
    for (var j = i - period + 1; j <= i; j++) s += arr[j];
    out.push(s / period);
  }
  return out;
}

function calcStdDev(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  var mean = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
  var sqDiffs = arr.map(function(v) { return Math.pow(v - mean, 2); });
  var avgSqDiff = sqDiffs.reduce(function(a, b) { return a + b; }, 0) / arr.length;
  return Math.sqrt(avgSqDiff);
}

// ─── Detectar anomalías en múltiples símbolos ────────────────────────────────
function detectAnomaliesBatch(symbolsData) {
  var all = [];
  for (var symbol in symbolsData) {
    var result = detectAnomalies(symbol, symbolsData[symbol].ohlcv, symbolsData[symbol].newsIds);
    all = all.concat(result.anomalies);
  }
  // Ordenar por timestamp descendente
  all.sort(function(a, b) { return b.timestamp - a.timestamp; });
  return all;
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  detectAnomalies: detectAnomalies,
  detectAnomaliesBatch: detectAnomaliesBatch
};

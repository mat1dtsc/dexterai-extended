'use strict';
/**
 * lib/capm.js — CAPM, Betas, Alpha de Jensen, Sharpe, Treynor, Information Ratio
 * Los "5 betas": mercado, sector (placeholder), size, value, momentum
 */

// ─── Media ────────────────────────────────────────────────────────────────────
function media(arr) {
  return arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
}

// ─── Varianza ─────────────────────────────────────────────────────────────────
function varianza(arr) {
  var m = media(arr);
  return arr.reduce(function(s, x) { return s + Math.pow(x - m, 2); }, 0) / arr.length;
}

// ─── Covarianza ───────────────────────────────────────────────────────────────
function covarianza(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  var ma = media(a), mb = media(b);
  var sum = 0;
  for (var i = 0; i < a.length; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / a.length;
}

// ─── Desviación estándar ──────────────────────────────────────────────────────
function desviacion(arr) {
  return Math.sqrt(varianza(arr));
}

// ─── Rendimientos logarítmicos ────────────────────────────────────────────────
function rendLog(closes) {
  var r = [];
  for (var i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

// ─── Beta de mercado: cov(ri, rm) / var(rm) ───────────────────────────────────
function calcBetaMercado(ri, rm) {
  return varianza(rm) > 0 ? covarianza(ri, rm) / varianza(rm) : 0;
}

// ─── Alpha de Jensen: ri - (rf + beta*(rm - rf)) ──────────────────────────────
function calcAlphaJensen(ri, rm, beta, rf) {
  var riMedia = media(ri);
  var rmMedia = media(rm);
  return riMedia - (rf + beta * (rmMedia - rf));
}

// ─── Sharpe ratio: (ri - rf) / sigma_i ────────────────────────────────────────
function calcSharpe(ri, rf) {
  var excess = media(ri) - rf;
  var sigma = desviacion(ri);
  return sigma > 0 ? excess / sigma : 0;
}

// ─── Treynor ratio: (ri - rf) / beta ───────────────────────────────────────────
function calcTreynor(ri, rf, beta) {
  return beta !== 0 ? (media(ri) - rf) / beta : 0;
}

// ─── Tracking error: std(ri - rm) ─────────────────────────────────────────────
function calcTrackingError(ri, rm) {
  if (ri.length !== rm.length) return 0;
  var diffs = [];
  for (var i = 0; i < ri.length; i++) diffs.push(ri[i] - rm[i]);
  return desviacion(diffs);
}

// ─── Information ratio: alpha / tracking_error ──────────────────────────────────
function calcInformationRatio(alpha, trackingError) {
  return trackingError > 0 ? alpha / trackingError : 0;
}

// ─── Coeficiente de determinación R² ─────────────────────────────────────────
function calcR2(ri, rm) {
  var cov = covarianza(ri, rm);
  var vi = varianza(ri);
  var vm = varianza(rm);
  return (vi > 0 && vm > 0) ? (cov * cov) / (vi * vm) : 0;
}
function calcBetaSize(ri) {
  // Proxy: el "tamaño" se asocia con mayor volatilidad
  // Usamos el ratio entre media y desviación como proxy inverso de "size factor"
  var sigma = desviacion(ri);
  return sigma > 0 ? media(ri) / sigma : 0;
}

// ─── Beta value: correlación con factor valor (proxy: rendimiento acumulado) ──────
function calcBetaValue(ri) {
  // Proxy: rendimiento acumulado como señal de "valor"
  var cum = 0;
  for (var i = 0; i < ri.length; i++) cum += ri[i];
  return cum;
}

// ─── Beta momentum: correlación con tendencia reciente ──────────────────────────
function calcBetaMomentum(ri) {
  // Proxy: rendimiento de la segunda mitad vs primera mitad
  var mitad = Math.floor(ri.length / 2);
  if (mitad === 0) return 0;
  var primera = media(ri.slice(0, mitad));
  var segunda = media(ri.slice(mitad));
  return segunda - primera;
}

// ─── Calcular todas las métricas CAPM para un activo ────────────────────────────
function calcularCapmCompleto(symbol, closesActivo, closesMercado, rf) {
  rf = rf !== undefined ? rf : 0.02 / 252; // 2% anualizado a diario por defecto

  var ri = rendLog(closesActivo);
  var rm = rendLog(closesMercado);

  // Alinear longitudes
  var minLen = Math.min(ri.length, rm.length);
  ri = ri.slice(-minLen);
  rm = rm.slice(-minLen);

  if (ri.length === 0) {
    return { error: 'Sin datos suficientes', symbol: symbol };
  }

  var betaMercado = calcBetaMercado(ri, rm);
  var alphaJensen = calcAlphaJensen(ri, rm, betaMercado, rf);
  var sharpe = calcSharpe(ri, rf);
  var treynor = calcTreynor(ri, rf, betaMercado);
  var te = calcTrackingError(ri, rm);
  var infoRatio = calcInformationRatio(alphaJensen, te);

  var betaSize = calcBetaSize(ri);
  var betaValue = calcBetaValue(ri);
  var betaMomentum = calcBetaMomentum(ri);
  var r2 = calcR2(ri, rm);

  return {
    symbol: symbol,
    ventanaDias: ri.length,
    rf: rf,
    rm: media(rm),
    ri: media(ri),
    sigma: desviacion(ri),
    betaMercado: betaMercado,
    betaSector: null, // placeholder: requiere datos sectoriales
    betaSize: betaSize,
    betaValue: betaValue,
    betaMomentum: betaMomentum,
    alphaJensen: alphaJensen,
    sharpe: sharpe,
    treynor: treynor,
    informationRatio: infoRatio,
    trackingError: te,
    r2: r2,
    cincoBetas: {
      mercado: betaMercado,
      sector: null,
      size: betaSize,
      value: betaValue,
      momentum: betaMomentum
    }
  };
}

// ─── Calcular CAPM para múltiples activos contra un benchmark ────────────────────
function calcularCapmMultiple(activos, closesMercado, rf) {
  // activos: [ { symbol: 'AAPL', closes: [...] }, ... ]
  var resultados = [];
  for (var i = 0; i < activos.length; i++) {
    var r = calcularCapmCompleto(activos[i].symbol, activos[i].closes, closesMercado, rf);
    resultados.push(r);
  }
  return resultados;
}

module.exports = {
  media: media,
  varianza: varianza,
  covarianza: covarianza,
  desviacion: desviacion,
  rendLog: rendLog,
  calcBetaMercado: calcBetaMercado,
  calcAlphaJensen: calcAlphaJensen,
  calcSharpe: calcSharpe,
  calcTreynor: calcTreynor,
  calcTrackingError: calcTrackingError,
  calcInformationRatio: calcInformationRatio,
  calcR2: calcR2,
  calcBetaValue: calcBetaValue,
  calcBetaMomentum: calcBetaMomentum,
  calcularCapmCompleto: calcularCapmCompleto,
  calcularCapmMultiple: calcularCapmMultiple
};

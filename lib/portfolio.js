'use strict';
/**
 * lib/portfolio.js — Markowitz completo
 * Rendimientos logarítmicos, matriz de covarianza, frontera eficiente
 */

// ─── Rendimientos logarítmicos: ln(Pt / Pt-1) ─────────────────────────────────
function rendimientosLogaritmicos(closes) {
  var r = [];
  for (var i = 1; i < closes.length; i++) {
    r.push(Math.log(closes[i] / closes[i - 1]));
  }
  return r;
}

// ─── Media aritmética ─────────────────────────────────────────────────────────
function media(arr) {
  return arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
}

// ─── Varianza muestral ────────────────────────────────────────────────────────
function varianza(arr) {
  var m = media(arr);
  return arr.reduce(function(s, x) { return s + Math.pow(x - m, 2); }, 0) / arr.length;
}

// ─── Covarianza entre dos arrays ───────────────────────────────────────────────
function covarianza(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  var ma = media(a), mb = media(b);
  var sum = 0;
  for (var i = 0; i < a.length; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / a.length;
}

// ─── Matriz de covarianza ─────────────────────────────────────────────────────
function matrizCovarianza(rendimientosArray) {
  // rendimientosArray: array de arrays, uno por activo
  var n = rendimientosArray.length;
  var mat = [];
  for (var i = 0; i < n; i++) {
    var fila = [];
    for (var j = 0; j < n; j++) {
      fila.push(covarianza(rendimientosArray[i], rendimientosArray[j]));
    }
    mat.push(fila);
  }
  return mat;
}

// ─── Multiplicar matriz × vector ────────────────────────────────────────────────
function matVec(mat, vec) {
  var out = [];
  for (var i = 0; i < mat.length; i++) {
    var s = 0;
    for (var j = 0; j < mat[i].length; j++) s += mat[i][j] * vec[j];
    out.push(s);
  }
  return out;
}

// ─── Producto punto de dos vectores ────────────────────────────────────────────
function dot(a, b) {
  var s = 0;
  for (var i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ─── Varianza del portafolio: w^T * Σ * w ──────────────────────────────────────
function varianzaPortafolio(pesos, covMat) {
  var temp = matVec(covMat, pesos);
  return dot(pesos, temp);
}

// ─── Generar N portafolios aleatorios (Monte Carlo) ─────────────────────────────
function generarPortafoliosRandom(rendimientosMedios, covMat, nPortafolios, nActivos, rf) {
  rf = rf || 0;
  var portafolios = [];
  for (var k = 0; k < nPortafolios; k++) {
    var pesos = [];
    var sum = 0;
    for (var i = 0; i < nActivos; i++) {
      var w = Math.random();
      pesos.push(w);
      sum += w;
    }
    // Normalizar a 1
    for (var i = 0; i < nActivos; i++) pesos[i] /= sum;

    var rendEsperado = dot(pesos, rendimientosMedios);
    var riesgo = Math.sqrt(varianzaPortafolio(pesos, covMat));
    var sharpe = riesgo > 0 ? (rendEsperado - rf) / riesgo : 0;

    portafolios.push({
      pesos: pesos.slice(),
      rendimiento: rendEsperado,
      riesgo: riesgo,
      sharpe: sharpe
    });
  }
  return portafolios;
}

// ─── Filtrar portafolios en la frontera eficiente ───────────────────────────────
function fronteraEficiente(portafolios) {
  // Un portafolio es eficiente si no existe otro con igual o menor riesgo y mayor rendimiento
  var eficientes = [];
  for (var i = 0; i < portafolios.length; i++) {
    var p = portafolios[i];
    var dominado = false;
    for (var j = 0; j < portafolios.length; j++) {
      if (i === j) continue;
      var q = portafolios[j];
      // q domina a p si q tiene menor o igual riesgo Y mayor rendimiento
      if (q.riesgo <= p.riesgo && q.rendimiento >= p.rendimiento && (q.riesgo < p.riesgo || q.rendimiento > p.rendimiento)) {
        dominado = true;
        break;
      }
    }
    if (!dominado) eficientes.push(p);
  }
  // Ordenar por riesgo ascendente
  eficientes.sort(function(a, b) { return a.riesgo - b.riesgo; });
  return eficientes;
}

// ─── Portafolio de mínima varianza ──────────────────────────────────────────────
function minimaVarianza(portafolios) {
  var min = portafolios[0];
  for (var i = 1; i < portafolios.length; i++) {
    if (portafolios[i].riesgo < min.riesgo) min = portafolios[i];
  }
  return min;
}

// ─── Portafolio de máximo Sharpe ────────────────────────────────────────────────
function maximoSharpe(portafolios) {
  var max = portafolios[0];
  for (var i = 1; i < portafolios.length; i++) {
    if (portafolios[i].sharpe > max.sharpe) max = portafolios[i];
  }
  return max;
}

// ─── Optimización Markowitz completa ────────────────────────────────────────────
function optimizarMarkowitz(activosDatos, nSimulaciones, rf) {
  // activosDatos: { symbol: string, closes: number[] }[]
  nSimulaciones = nSimulaciones || 10000;
  rf = rf || 0;

  var n = activosDatos.length;
  if (n === 0) return { error: 'Sin activos' };

  // Calcular rendimientos logarítmicos por activo
  var rendimientos = [];
  var rendimientosMedios = [];
  var symbols = [];

  for (var i = 0; i < n; i++) {
    var r = rendimientosLogaritmicos(activosDatos[i].closes);
    rendimientos.push(r);
    rendimientosMedios.push(media(r));
    symbols.push(activosDatos[i].symbol);
  }

  // Asegurar misma longitud (usar el mínimo común)
  var minLen = rendimientos.reduce(function(m, r) { return Math.min(m, r.length); }, Infinity);
  for (var i = 0; i < n; i++) {
    rendimientos[i] = rendimientos[i].slice(-minLen);
  }

  var covMat = matrizCovarianza(rendimientos);

  // Simulación Monte Carlo
  var portafolios = generarPortafoliosRandom(rendimientosMedios, covMat, nSimulaciones, n, rf);

  // Frontera eficiente
  var eficientes = fronteraEficiente(portafolios);

  // Portafolios destacados
  var minVar = minimaVarianza(portafolios);
  var maxSharpe = maximoSharpe(portafolios);

  // Anualizar (252 días hábiles)
  var anualizar = function(p) {
    return {
      pesos: p.pesos,
      rendimientoAnual: p.rendimiento * 252,
      riesgoAnual: p.riesgo * Math.sqrt(252),
      sharpeAnual: p.sharpe * Math.sqrt(252)
    };
  };

  return {
    symbols: symbols,
    nSimulaciones: nSimulaciones,
    minLen: minLen,
    covarianza: covMat,
    rendimientosMediosDiarios: rendimientosMedios,
    fronteraEficiente: eficientes.map(anualizar),
    minimaVarianza: anualizar(minVar),
    maximoSharpe: anualizar(maxSharpe),
    rf: rf
  };
}

// ─── Calcular métricas para un portafolio dado ──────────────────────────────────
function evaluarPortafolio(pesos, rendimientosMedios, covMat, rf) {
  rf = rf || 0;
  var rend = dot(pesos, rendimientosMedios);
  var riesgo = Math.sqrt(varianzaPortafolio(pesos, covMat));
  return {
    rendimientoDiario: rend,
    rendimientoAnual: rend * 252,
    riesgoDiario: riesgo,
    riesgoAnual: riesgo * Math.sqrt(252),
    sharpe: riesgo > 0 ? (rend - rf) / riesgo : 0,
    sharpeAnual: riesgo > 0 ? ((rend - rf) * 252) / (riesgo * Math.sqrt(252)) : 0
  };
}

module.exports = {
  rendimientosLogaritmicos: rendimientosLogaritmicos,
  media: media,
  varianza: varianza,
  covarianza: covarianza,
  matrizCovarianza: matrizCovarianza,
  matVec: matVec,
  dot: dot,
  varianzaPortafolio: varianzaPortafolio,
  generarPortafoliosRandom: generarPortafoliosRandom,
  fronteraEficiente: fronteraEficiente,
  minimaVarianza: minimaVarianza,
  maximoSharpe: maximoSharpe,
  optimizarMarkowitz: optimizarMarkowitz,
  evaluarPortafolio: evaluarPortafolio
};

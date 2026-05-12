'use strict';
/**
 * lib/alerts.js — Motor de alertas v2.0
 * Fix: manejo correcto de score=0, validaciones de datos
 */

var db = require('./db');
var ind = require('./indicators');
var notifier = require('./notifier');

function isValidNumber(n) {
  return n !== null && n !== undefined && !isNaN(n) && isFinite(n);
}

function safeNumber(n) {
  return isValidNumber(n) ? n : null;
}

// ─── Evaluar condiciones de alerta ────────────────────────────────────────────
function evaluarAlertas(symbol, datos) {
  var alertas = [];
  var d = datos || {};
  var price = safeNumber(d.price);
  var score = safeNumber(d.score);
  var rsi = safeNumber(d.rsi14);
  var prevRsi = safeNumber(d.prevRsi);
  var macd = safeNumber(d.macd);
  var macdSig = safeNumber(d.macdSig);
  var prevMacd = safeNumber(d.prevMacd);
  var prevMacdSig = safeNumber(d.prevMacdSig);
  var bbLow = safeNumber(d.bbLow);
  var bbUp = safeNumber(d.bbUp);
  var changePct = safeNumber(d.changePct);

  // 1. Score fuerte > 80
  if (score !== null && score > 80) {
    alertas.push({
      tipo: 'score_fuerte',
      mensaje: 'Score de entrada ' + score.toFixed(0) + '/100 — señal muy fuerte',
      nivel: 'alto',
      datos: { score: score }
    });
  }

  // 2. RSI cruza 30 o 70
  if (rsi !== null && prevRsi !== null) {
    if (prevRsi >= 30 && rsi < 30) {
      alertas.push({
        tipo: 'rsi_cruce_bajo',
        mensaje: 'RSI cruzó bajo 30 (' + rsi.toFixed(1) + '): sobreventa extrema',
        nivel: 'alto',
        datos: { rsi: rsi, prevRsi: prevRsi }
      });
    }
    if (prevRsi <= 70 && rsi > 70) {
      alertas.push({
        tipo: 'rsi_cruce_alto',
        mensaje: 'RSI cruzó sobre 70 (' + rsi.toFixed(1) + '): sobrecompra extrema',
        nivel: 'alto',
        datos: { rsi: rsi, prevRsi: prevRsi }
      });
    }
  }

  // 3. MACD cruza señal
  if (macd !== null && macdSig !== null && prevMacd !== null && prevMacdSig !== null) {
    var prevHist = prevMacd - prevMacdSig;
    var hist = macd - macdSig;
    if (prevHist <= 0 && hist > 0) {
      alertas.push({
        tipo: 'macd_cruce_alza',
        mensaje: 'MACD cruzó señal al alza: momentum cambiando a positivo',
        nivel: 'medio',
        datos: { macd: macd, macdSig: macdSig }
      });
    }
    if (prevHist >= 0 && hist < 0) {
      alertas.push({
        tipo: 'macd_cruce_baja',
        mensaje: 'MACD cruzó señal a la baja: momentum cambiando a negativo',
        nivel: 'medio',
        datos: { macd: macd, macdSig: macdSig }
      });
    }
  }

  // 4. Precio en banda inferior BB (posición < 0.05)
  if (bbLow !== null && bbUp !== null && price !== null && bbUp !== bbLow) {
    var pos = (price - bbLow) / (bbUp - bbLow);
    if (pos <= 0.05) {
      alertas.push({
        tipo: 'bb_inferior',
        mensaje: 'Precio en banda inferior BB (' + (pos * 100).toFixed(1) + '%): posible rebote',
        nivel: 'alto',
        datos: { bbPosition: pos, price: price }
      });
    }
  }

  // 5. Cambio brusco > 2% en ventana corta
  if (changePct !== null && Math.abs(changePct) > 2) {
    var dir = changePct > 0 ? 'al alza' : 'a la baja';
    alertas.push({
      tipo: 'cambio_brusco',
      mensaje: 'Cambio brusco ' + dir + ': ' + changePct.toFixed(2) + '%',
      nivel: 'medio',
      datos: { changePct: changePct }
    });
  }

  return alertas;
}

// ─── Persistir alertas en SQLite ──────────────────────────────────────────────
function persistirAlertas(symbol, alertas) {
  var promises = [];
  for (var i = 0; i < alertas.length; i++) {
    var a = alertas[i];
    var d = a.datos || {};
    promises.push(
      db.guardarAlerta(
        symbol,
        a.tipo,
        a.mensaje,
        d.score !== undefined ? d.score : null,
        d.rsi !== undefined ? d.rsi : null,
        d.macd !== undefined ? d.macd : null,
        d.price !== undefined ? d.price : null
      )
    );
  }
  return Promise.all(promises);
}

// ─── Verificar y alertar para un símbolo ──────────────────────────────────────
function verificarAlertas(symbol, datos) {
  var alertas = evaluarAlertas(symbol, datos);
  if (alertas.length > 0) {
    return persistirAlertas(symbol, alertas).then(function() {
      // Fan-out: empujar cada alerta al WebSocket y a Telegram
      alertas.forEach(function(a) {
        notifier.notify({
          kind: 'alert',
          symbol: symbol,
          tipo: a.tipo,
          level: a.nivel,
          message: a.mensaje,
          price: datos && datos.price,
          data: a.datos
        }).catch(function(e) {
          console.error('[alerts] notify error:', e.message);
        });
      });
      return { symbol: symbol, alertas: alertas, total: alertas.length };
    });
  }
  return Promise.resolve({ symbol: symbol, alertas: [], total: 0 });
}

module.exports = {
  evaluarAlertas: evaluarAlertas,
  persistirAlertas: persistirAlertas,
  verificarAlertas: verificarAlertas
};

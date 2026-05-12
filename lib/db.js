'use strict';
/**
 * lib/db.js — SQLite persistence v2.0
 * Mejoras: índices, tabla de históricos, función de precios cache
 */
var sqlite3 = require('sqlite3').verbose();
var path = require('path');

var DB_PATH = process.env.VERCEL
  ? '/tmp/dexter.db'
  : path.join(__dirname, '..', 'data', 'dexter.db');

var db = new sqlite3.Database(DB_PATH);

function initDb() {
  db.serialize(function() {
    // Alertas
    db.run(`CREATE TABLE IF NOT EXISTS alertas_historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      tipo TEXT,
      mensaje TEXT,
      score REAL,
      rsi14 REAL,
      macd REAL,
      price REAL,
      ts INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alertas_symbol ON alertas_historial(symbol)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alertas_ts ON alertas_historial(ts)`);

    // Optimizaciones
    db.run(`CREATE TABLE IF NOT EXISTS portfolio_optimizaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbols TEXT,
      pesos TEXT,
      rendimiento_anual REAL,
      riesgo_anual REAL,
      sharpe REAL,
      tipo TEXT,
      ts INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_portfolio_ts ON portfolio_optimizaciones(ts)`);

    // CAPM
    db.run(`CREATE TABLE IF NOT EXISTS capm_betas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT,
      betas TEXT,
      rf REAL,
      rm REAL,
      ri REAL,
      sigma REAL,
      tracking_error REAL,
      ventana INTEGER,
      ts INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_capm_symbol ON capm_betas(symbol)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_capm_ts ON capm_betas(ts)`);

    // Precios cache
    db.run(`CREATE TABLE IF NOT EXISTS precios_cache (
      symbol TEXT PRIMARY KEY,
      price REAL,
      change_pct REAL,
      source TEXT,
      ts INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_precios_ts ON precios_cache(ts)`);

    // Históricos persistentes (para análisis offline)
    db.run(`CREATE TABLE IF NOT EXISTS historico_ohlcv (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      volume REAL,
      interval TEXT DEFAULT '1d',
      source TEXT,
      UNIQUE(symbol, timestamp, interval)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_historico_symbol_ts ON historico_ohlcv(symbol, timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_historico_interval ON historico_ohlcv(interval)`);

    // Watchlists dinámicas
    db.run(`CREATE TABLE IF NOT EXISTS watchlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE NOT NULL,
      simbolos TEXT NOT NULL,
      activa INTEGER DEFAULT 1,
      creada_en INTEGER DEFAULT (strftime('%s','now'))
    )`);

    // Seed: 8 watchlists temáticas si no existen
    var SEEDS = [
      { nombre: 'Mercados Macro', simbolos: [
        'NDX','GSPC','DJI','GDAXI','FTSE','N225',
        'GC=F','CL=F','BZ=F','USDCLP=X','BTC-USD','ETH-USD','EURUSD=X'
      ]},
      { nombre: 'Tech US (Mag7+)', simbolos: [
        'AAPL','MSFT','NVDA','GOOGL','GOOG','AMZN','META','TSLA','AMD','INTC',
        'NFLX','ORCL','CRM','ADBE','AVGO','PYPL','SHOP','SNOW','PLTR','UBER',
        'COIN','SQ','ROKU','SPOT','MU','QCOM','TXN','CSCO','IBM'
      ]},
      { nombre: 'Bancos US', simbolos: [
        'JPM','BAC','WFC','C','GS','MS','USB','PNC','TFC','SCHW',
        'V','MA','AXP','BLK','BX'
      ]},
      { nombre: 'Energía', simbolos: [
        'XOM','CVX','COP','OXY','EOG','SLB','PSX','VLO','MPC','HAL',
        'BP','SHEL','TTE','PBR','ENB','CL=F','BZ=F','NG=F'
      ]},
      { nombre: 'Salud', simbolos: [
        'JNJ','UNH','PFE','LLY','ABBV','MRK','TMO','ABT','DHR','BMY',
        'AMGN','GILD','MDT','CVS','CI','HUM'
      ]},
      { nombre: 'Consumo', simbolos: [
        'WMT','HD','COST','MCD','NKE','SBUX','TGT','LOW','TJX','BKNG',
        'KO','PEP','PG','UL','MO','PM','DIS'
      ]},
      { nombre: 'ETFs Clave', simbolos: [
        'SPY','QQQ','IWM','DIA','VTI','VOO','EFA','EEM',
        'XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE',
        'GLD','SLV','TLT','HYG','VIX'
      ]},
      { nombre: 'Crypto Top', simbolos: [
        'BTC-USD','ETH-USD','SOL-USD','BNB-USD','XRP-USD','ADA-USD','DOGE-USD',
        'AVAX-USD','DOT-USD','MATIC-USD','LINK-USD','LTC-USD','TRX-USD'
      ]},
      { nombre: 'Forex Majors', simbolos: [
        'EURUSD=X','GBPUSD=X','USDJPY=X','USDCHF=X','AUDUSD=X','USDCAD=X','NZDUSD=X',
        'EURGBP=X','EURJPY=X','GBPJPY=X','USDCLP=X','USDMXN=X','USDBRL=X'
      ]}
    ];
    // Migración: borrar watchlist legacy "default" si existe sola
    db.get("SELECT id FROM watchlists WHERE nombre = 'default'", function(err, legacyRow) {
      if (legacyRow) {
        db.run("DELETE FROM watchlists WHERE nombre = 'default'");
      }
      // Insertar cada watchlist solo si no existe (nombre es UNIQUE)
      var stmt = db.prepare('INSERT OR IGNORE INTO watchlists (nombre, simbolos, activa) VALUES (?,?,?)');
      var created = 0;
      SEEDS.forEach(function(s, idx) {
        stmt.run(s.nombre, JSON.stringify(s.simbolos), idx === 0 ? 1 : 0, function(e) {
          if (!e && this.changes > 0) created++;
        });
      });
      stmt.finalize(function() {
        // Asegurar que al menos una esté activa
        db.get('SELECT COUNT(*) AS n FROM watchlists WHERE activa = 1', function(e, r) {
          if (!e && r && r.n === 0) {
            db.run('UPDATE watchlists SET activa = 1 WHERE id = (SELECT MIN(id) FROM watchlists)');
          }
        });
        console.log('[DB] Watchlists temáticas verificadas (' + SEEDS.length + ' presets)');
      });
    });

    // Señales BUY/SELL/HOLD generadas
    db.run(`CREATE TABLE IF NOT EXISTS senales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      score REAL,
      reasons TEXT,
      price REAL,
      stop_loss REAL,
      take_profit REAL,
      ts INTEGER DEFAULT (strftime('%s','now')),
      consumido INTEGER DEFAULT 0
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_senales_symbol_ts ON senales(symbol, ts)`);

    // Órdenes ejecutadas
    db.run(`CREATE TABLE IF NOT EXISTS ordenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alpaca_id TEXT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      type TEXT,
      limit_price REAL,
      stop_loss REAL,
      take_profit REAL,
      status TEXT,
      mode TEXT,
      signal_id INTEGER,
      raw TEXT,
      ts INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ordenes_ts ON ordenes(ts)`);
  });
  console.log('[DB] Conectado a', DB_PATH);
  console.log('[DB] Esquema v2.0 inicializado con índices.');
}

function guardarAlerta(symbol, tipo, mensaje, score, rsi14, macd, price) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT INTO alertas_historial (symbol, tipo, mensaje, score, rsi14, macd, price) VALUES (?,?,?,?,?,?,?)',
      [symbol, tipo, mensaje, score !== undefined ? score : null, rsi14 !== undefined ? rsi14 : null, macd !== undefined ? macd : null, price !== undefined ? price : null],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function obtenerAlertas(symbol, limit) {
  return new Promise(function(resolve, reject) {
    var sql = symbol
      ? 'SELECT * FROM alertas_historial WHERE symbol = ? ORDER BY ts DESC LIMIT ?'
      : 'SELECT * FROM alertas_historial ORDER BY ts DESC LIMIT ?';
    var params = symbol ? [symbol, limit || 50] : [limit || 50];
    db.all(sql, params, function(err, rows) { if (err) reject(err); else resolve(rows); });
  });
}

function guardarOptimizacion(symbols, pesos, rend, riesgo, sharpe, tipo, ventana) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT INTO portfolio_optimizaciones (symbols, pesos, rendimiento_anual, riesgo_anual, sharpe, tipo, ventana) VALUES (?,?,?,?,?,?,?)',
      [JSON.stringify(symbols), JSON.stringify(pesos), rend, riesgo, sharpe, tipo, ventana || null],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function obtenerOptimizaciones(limit) {
  return new Promise(function(resolve, reject) {
    db.all('SELECT * FROM portfolio_optimizaciones ORDER BY ts DESC LIMIT ?', [limit || 20], function(err, rows) {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function guardarCapmMetrics(symbol, betas, rf, rm, ri, sigma, trackingError, ventana) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT INTO capm_betas (symbol, betas, rf, rm, ri, sigma, tracking_error, ventana) VALUES (?,?,?,?,?,?,?,?)',
      [symbol, JSON.stringify(betas), rf, rm, ri, sigma, trackingError, ventana],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function obtenerCapm(symbol, limit) {
  return new Promise(function(resolve, reject) {
    db.all('SELECT * FROM capm_betas WHERE symbol = ? ORDER BY ts DESC LIMIT ?', [symbol, limit || 10], function(err, rows) {
      if (err) reject(err); else resolve(rows);
    });
  });
}

// ─── Precios cache ────────────────────────────────────────────────────────────
function guardarPrecioCache(symbol, price, changePct, source) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT OR REPLACE INTO precios_cache (symbol, price, change_pct, source, ts) VALUES (?,?,?,?,strftime("%s","now"))',
      [symbol, price, changePct, source],
      function(err) { if (err) reject(err); else resolve({ updated: true }); }
    );
  });
}

function obtenerPrecioCache(symbol) {
  return new Promise(function(resolve, reject) {
    db.get('SELECT * FROM precios_cache WHERE symbol = ?', [symbol], function(err, row) {
      if (err) reject(err); else resolve(row || null);
    });
  });
}

// ─── Históricos persistentes ──────────────────────────────────────────────────
function guardarHistoricoOhlcv(symbol, ohlcv, interval, source) {
  return new Promise(function(resolve, reject) {
    var stmt = db.prepare(
      'INSERT OR IGNORE INTO historico_ohlcv (symbol, timestamp, open, high, low, close, volume, interval, source) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    var inserted = 0;
    for (var i = 0; i < ohlcv.length; i++) {
      var c = ohlcv[i];
      if (!c.timestamp || !c.close) continue;
      stmt.run(symbol, c.timestamp, c.open, c.high, c.low, c.close, c.volume, interval || '1d', source || 'yahoo');
      inserted++;
    }
    stmt.finalize(function(err) {
      if (err) reject(err); else resolve({ inserted: inserted });
    });
  });
}

function obtenerHistoricoOhlcv(symbol, interval, limit) {
  return new Promise(function(resolve, reject) {
    db.all(
      'SELECT * FROM historico_ohlcv WHERE symbol = ? AND interval = ? ORDER BY timestamp DESC LIMIT ?',
      [symbol, interval || '1d', limit || 365],
      function(err, rows) { if (err) reject(err); else resolve(rows); }
    );
  });
}

function limpiarHistoricoViejo(dias) {
  dias = dias || 90;
  var cutoff = Math.floor(Date.now() / 1000) - dias * 24 * 60 * 60;
  return new Promise(function(resolve, reject) {
    db.run('DELETE FROM historico_ohlcv WHERE timestamp < ?', [cutoff], function(err) {
      if (err) reject(err); else resolve({ deleted: this.changes });
    });
  });
}

// ─── Watchlists ───────────────────────────────────────────────────────────────
function listarWatchlists() {
  return new Promise(function(resolve, reject) {
    db.all('SELECT id, nombre, simbolos, activa, creada_en FROM watchlists ORDER BY id', [], function(err, rows) {
      if (err) reject(err);
      else resolve((rows || []).map(function(r) {
        var simbolos = [];
        try { simbolos = JSON.parse(r.simbolos); } catch(e) {}
        return { id: r.id, nombre: r.nombre, simbolos: simbolos, activa: !!r.activa, creada_en: r.creada_en };
      }));
    });
  });
}

function obtenerWatchlist(id) {
  return new Promise(function(resolve, reject) {
    db.get('SELECT id, nombre, simbolos, activa, creada_en FROM watchlists WHERE id = ?', [id], function(err, r) {
      if (err) return reject(err);
      if (!r) return resolve(null);
      var simbolos = [];
      try { simbolos = JSON.parse(r.simbolos); } catch(e) {}
      resolve({ id: r.id, nombre: r.nombre, simbolos: simbolos, activa: !!r.activa, creada_en: r.creada_en });
    });
  });
}

function crearWatchlist(nombre, simbolos) {
  return new Promise(function(resolve, reject) {
    db.run('INSERT INTO watchlists (nombre, simbolos, activa) VALUES (?,?,1)',
      [nombre, JSON.stringify(simbolos || [])],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); });
  });
}

function actualizarWatchlist(id, fields) {
  return new Promise(function(resolve, reject) {
    var sets = [];
    var args = [];
    if (fields.nombre !== undefined)   { sets.push('nombre = ?');   args.push(fields.nombre); }
    if (fields.simbolos !== undefined) { sets.push('simbolos = ?'); args.push(JSON.stringify(fields.simbolos)); }
    if (fields.activa !== undefined)   { sets.push('activa = ?');   args.push(fields.activa ? 1 : 0); }
    if (sets.length === 0) return resolve({ updated: 0 });
    args.push(id);
    db.run('UPDATE watchlists SET ' + sets.join(', ') + ' WHERE id = ?', args,
      function(err) { if (err) reject(err); else resolve({ updated: this.changes }); });
  });
}

function eliminarWatchlist(id) {
  return new Promise(function(resolve, reject) {
    db.run('DELETE FROM watchlists WHERE id = ?', [id],
      function(err) { if (err) reject(err); else resolve({ deleted: this.changes }); });
  });
}

function simbolosDeWatchlistsActivas() {
  return new Promise(function(resolve, reject) {
    db.all('SELECT simbolos FROM watchlists WHERE activa = 1', [], function(err, rows) {
      if (err) return reject(err);
      var set = {};
      (rows || []).forEach(function(r) {
        try {
          (JSON.parse(r.simbolos) || []).forEach(function(s) { set[s] = true; });
        } catch(e) {}
      });
      resolve(Object.keys(set));
    });
  });
}

// ─── Señales ──────────────────────────────────────────────────────────────────
function guardarSenal(s) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT INTO senales (symbol, action, score, reasons, price, stop_loss, take_profit) VALUES (?,?,?,?,?,?,?)',
      [s.symbol, s.action, s.score || null, JSON.stringify(s.reasons || []),
       s.price || null, s.stop_loss || null, s.take_profit || null],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function obtenerSenales(symbol, limit) {
  return new Promise(function(resolve, reject) {
    var sql = symbol
      ? 'SELECT * FROM senales WHERE symbol = ? ORDER BY ts DESC LIMIT ?'
      : 'SELECT * FROM senales ORDER BY ts DESC LIMIT ?';
    var params = symbol ? [symbol, limit || 50] : [limit || 50];
    db.all(sql, params, function(err, rows) { if (err) reject(err); else resolve(rows); });
  });
}

function marcarSenalConsumida(id) {
  return new Promise(function(resolve, reject) {
    db.run('UPDATE senales SET consumido = 1 WHERE id = ?', [id],
      function(err) { if (err) reject(err); else resolve({ updated: this.changes }); });
  });
}

// ─── Órdenes ──────────────────────────────────────────────────────────────────
function guardarOrden(o) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT INTO ordenes (alpaca_id, symbol, side, qty, type, limit_price, stop_loss, take_profit, status, mode, signal_id, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [o.alpaca_id || null, o.symbol, o.side, o.qty, o.type || 'market',
       o.limit_price || null, o.stop_loss || null, o.take_profit || null,
       o.status || 'submitted', o.mode || 'paper', o.signal_id || null,
       o.raw ? JSON.stringify(o.raw) : null],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function obtenerOrdenes(limit) {
  return new Promise(function(resolve, reject) {
    db.all('SELECT * FROM ordenes ORDER BY ts DESC LIMIT ?', [limit || 50],
      function(err, rows) { if (err) reject(err); else resolve(rows); });
  });
}

module.exports = {
  initDb: initDb,
  guardarAlerta: guardarAlerta,
  obtenerAlertas: obtenerAlertas,
  guardarOptimizacion: guardarOptimizacion,
  obtenerOptimizaciones: obtenerOptimizaciones,
  guardarCapmMetrics: guardarCapmMetrics,
  obtenerCapm: obtenerCapm,
  guardarPrecioCache: guardarPrecioCache,
  obtenerPrecioCache: obtenerPrecioCache,
  guardarHistoricoOhlcv: guardarHistoricoOhlcv,
  obtenerHistoricoOhlcv: obtenerHistoricoOhlcv,
  limpiarHistoricoViejo: limpiarHistoricoViejo,
  // Watchlists
  listarWatchlists: listarWatchlists,
  obtenerWatchlist: obtenerWatchlist,
  crearWatchlist: crearWatchlist,
  actualizarWatchlist: actualizarWatchlist,
  eliminarWatchlist: eliminarWatchlist,
  simbolosDeWatchlistsActivas: simbolosDeWatchlistsActivas,
  // Señales
  guardarSenal: guardarSenal,
  obtenerSenales: obtenerSenales,
  marcarSenalConsumida: marcarSenalConsumida,
  // Órdenes
  guardarOrden: guardarOrden,
  obtenerOrdenes: obtenerOrdenes
};

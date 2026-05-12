'use strict';
/**
 * lib/db_v2.js — SQLite persistence time-series v3.0
 * Esquema portable a PostgreSQL. Sin features SQLite-específicas.
 */
var sqlite3 = require('sqlite3').verbose();
var path = require('path');

var DB_PATH = process.env.VERCEL
  ? '/tmp/dexter.db'
  : path.join(__dirname, '..', 'data', 'dexter.db');

var db = new sqlite3.Database(DB_PATH);

// ─── Helper: epoch seconds ───────────────────────────────────────────────────
function nowSec() { return Math.floor(Date.now() / 1000); }

// ─── Init ────────────────────────────────────────────────────────────────────
function initDb() {
  db.serialize(function() {
    // Precios tick-level (cada 5 min)
    db.run(`CREATE TABLE IF NOT EXISTS precios_tick (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      change REAL,
      change_pct REAL,
      volume REAL,
      market_state TEXT,
      source TEXT,
      ts INTEGER NOT NULL,
      UNIQUE(symbol, ts)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_precios_tick_symbol_ts ON precios_tick(symbol, ts DESC)`);

    // OHLCV histórico
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
    db.run(`CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_ts_interval ON historico_ohlcv(symbol, timestamp DESC, interval)`);

    // Fundamentales snapshot diario
    db.run(`CREATE TABLE IF NOT EXISTS fundamentales_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      pe REAL,
      forward_pe REAL,
      eps REAL,
      market_cap REAL,
      dividend_yield REAL,
      beta REAL,
      fifty_two_week_high REAL,
      fifty_two_week_low REAL,
      revenue_growth REAL,
      profit_margins REAL,
      debt_to_equity REAL,
      total_debt REAL,
      total_cash REAL,
      sector TEXT,
      industry TEXT,
      ts INTEGER NOT NULL,
      UNIQUE(symbol, ts)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_fundamentales_symbol_ts ON fundamentales_snapshot(symbol, ts DESC)`);

    // Métricas diarias calculadas
    db.run(`CREATE TABLE IF NOT EXISTS metricas_diarias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      sma_20 REAL,
      sma_50 REAL,
      sma_200 REAL,
      rsi_14 REAL,
      macd REAL,
      macd_signal REAL,
      bb_upper REAL,
      bb_lower REAL,
      atr_14 REAL,
      stoch_k REAL,
      stoch_d REAL,
      entry_score REAL,
      ts INTEGER NOT NULL,
      UNIQUE(symbol, ts)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_metricas_symbol_ts ON metricas_diarias(symbol, ts DESC)`);

    // Alertas generadas
    db.run(`CREATE TABLE IF NOT EXISTS alertas_historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      tipo TEXT,
      mensaje TEXT,
      nivel TEXT,
      score REAL,
      rsi_14 REAL,
      macd REAL,
      price REAL,
      ts INTEGER NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alertas_symbol_ts ON alertas_historial(symbol, ts DESC)`);

    // Log de actualizaciones
    db.run(`CREATE TABLE IF NOT EXISTS update_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      symbol TEXT,
      records_inserted INTEGER,
      duration_ms INTEGER,
      error TEXT,
      ts INTEGER NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_update_log_type_ts ON update_log(type, ts DESC)`);

    // Tablas legado (migración progresiva)
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
    db.run(`CREATE TABLE IF NOT EXISTS precios_cache (
      symbol TEXT PRIMARY KEY,
      price REAL,
      change_pct REAL,
      source TEXT,
      ts INTEGER DEFAULT (strftime('%s','now'))
    )`);

    // ─── Migraciones: añadir columnas que faltan en tablas viejas ──────────
    db.run(`ALTER TABLE alertas_historial ADD COLUMN nivel TEXT`, function(err) {
      if (err && !err.message.includes('duplicate column')) console.log('[DBv2] Migración alertas_historial.nivel ya existe o error:', err.message);
    });
    db.run(`ALTER TABLE alertas_historial ADD COLUMN rsi_14 REAL`, function(err) {
      if (err && !err.message.includes('duplicate column')) console.log('[DBv2] Migración alertas_historial.rsi_14 ya existe o error:', err.message);
    });

    // ─── TABLAS DE INTELIGENCIA DE MERCADO ────────────────────────────────
    // Eventos de noticias
    db.run(`CREATE TABLE IF NOT EXISTS news_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      headline TEXT NOT NULL,
      summary TEXT,
      url TEXT,
      symbols TEXT,
      sentiment REAL,
      category TEXT,
      impact_score REAL,
      published_at INTEGER,
      collected_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_news_symbol_published ON news_events(symbols, published_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_news_category ON news_events(category, published_at DESC)`);

    // Movimientos anómalos de precio
    db.run(`CREATE TABLE IF NOT EXISTS price_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price REAL,
      return_1h REAL,
      return_1d REAL,
      return_5d REAL,
      volume_zscore REAL,
      volatility_spike REAL,
      news_ids TEXT,
      anomaly_type TEXT,
      detected_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_anomalies_symbol_ts ON price_anomalies(symbol, timestamp DESC)`);

    // Patrones aprendidos noticia-precio
    db.run(`CREATE TABLE IF NOT EXISTS news_price_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_name TEXT NOT NULL,
      category TEXT,
      keyword TEXT,
      symbol_pattern TEXT,
      avg_return_1h REAL,
      avg_return_1d REAL,
      avg_return_5d REAL,
      win_rate REAL,
      sample_count INTEGER,
      confidence REAL,
      last_seen INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_patterns_category ON news_price_patterns(category, last_seen DESC)`);

    // Contexto macro (FOMC, CPI, etc.)
    db.run(`CREATE TABLE IF NOT EXISTS macro_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_date TEXT,
      description TEXT,
      expected_value REAL,
      actual_value REAL,
      surprise REAL,
      market_impact TEXT,
      affected_sectors TEXT,
      ts INTEGER DEFAULT (strftime('%s','now'))
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_macro_event_type_date ON macro_events(event_type, event_date DESC)`);

    // Bitcoin on-chain metrics (series temporales: hash rate, MVRV, active addrs, etc.)
    db.run(`CREATE TABLE IF NOT EXISTS btc_onchain_metrics (
      metric TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value REAL NOT NULL,
      source TEXT,
      PRIMARY KEY (metric, ts)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_btc_metrics_ts ON btc_onchain_metrics(metric, ts DESC)`);

    // Whale transactions detectadas (BTC > N en una tx, con etiqueta de exchange si aplica)
    db.run(`CREATE TABLE IF NOT EXISTS btc_whale_txs (
      txid TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      btc_amount REAL,
      usd_value REAL,
      from_label TEXT,
      to_label TEXT,
      direction TEXT,
      raw TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_btc_whales_ts ON btc_whale_txs(ts DESC)`);

    // Trades de congresistas US (STOCK Act disclosures)
    db.run(`CREATE TABLE IF NOT EXISTS congress_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      politician TEXT NOT NULL,
      chamber TEXT NOT NULL,
      party TEXT,
      ticker TEXT,
      asset_description TEXT,
      transaction_date INTEGER NOT NULL,
      disclosure_date INTEGER,
      tx_type TEXT,
      amount_min REAL,
      amount_max REAL,
      raw TEXT,
      UNIQUE(politician, ticker, transaction_date, tx_type, amount_min)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_congress_ticker_date ON congress_trades(ticker, transaction_date DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_congress_pol_date ON congress_trades(politician, transaction_date DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_congress_disclosure ON congress_trades(disclosure_date DESC)`);
  });
  console.log('[DBv2] Conectado a', DB_PATH);
  console.log('[DBv2] Esquema time-series v3.0 inicializado.');
}

// ─── Log de actualización ────────────────────────────────────────────────────
function logUpdate(type, symbol, recordsInserted, durationMs, error) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT INTO update_log (type, symbol, records_inserted, duration_ms, error, ts) VALUES (?,?,?,?,?,?)',
      [type, symbol || null, recordsInserted || 0, durationMs || 0, error || null, nowSec()],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

// ─── Batch insert: precios_tick ─────────────────────────────────────────────
function insertTickBatch(records) {
  return new Promise(function(resolve, reject) {
    if (!Array.isArray(records) || records.length === 0) { resolve({ inserted: 0 }); return; }
    var stmt = db.prepare(
      'INSERT OR IGNORE INTO precios_tick (symbol, price, change, change_pct, volume, market_state, source, ts) VALUES (?,?,?,?,?,?,?,?)'
    );
    var inserted = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r.symbol || !r.price || !r.ts) continue;
      stmt.run(r.symbol, r.price, r.change || null, r.change_pct || null, r.volume || null, r.market_state || null, r.source || 'yahoo', r.ts);
      inserted++;
    }
    stmt.finalize(function(err) {
      if (err) reject(err); else resolve({ inserted: inserted });
    });
  });
}

// ─── Batch insert: OHLCV ───────────────────────────────────────────────────
function insertOhlcvBatch(symbol, ohlcv, interval, source) {
  return new Promise(function(resolve, reject) {
    if (!Array.isArray(ohlcv) || ohlcv.length === 0) { resolve({ inserted: 0 }); return; }
    var stmt = db.prepare(
      'INSERT OR IGNORE INTO historico_ohlcv (symbol, timestamp, open, high, low, close, volume, interval, source) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    var inserted = 0;
    for (var i = 0; i < ohlcv.length; i++) {
      var c = ohlcv[i];
      if (!c.timestamp || c.close === null || c.close === undefined) continue;
      stmt.run(symbol, c.timestamp, c.open || null, c.high || null, c.low || null, c.close, c.volume || 0, interval || '1d', source || 'yahoo');
      inserted++;
    }
    stmt.finalize(function(err) {
      if (err) reject(err); else resolve({ inserted: inserted });
    });
  });
}

// ─── Batch insert: fundamentales ───────────────────────────────────────────
function insertFundamentalsBatch(records) {
  return new Promise(function(resolve, reject) {
    if (!Array.isArray(records) || records.length === 0) { resolve({ inserted: 0 }); return; }
    var stmt = db.prepare(
      'INSERT OR IGNORE INTO fundamentales_snapshot (symbol, pe, forward_pe, eps, market_cap, dividend_yield, beta, fifty_two_week_high, fifty_two_week_low, revenue_growth, profit_margins, debt_to_equity, total_debt, total_cash, sector, industry, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    var inserted = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r.symbol || !r.ts) continue;
      stmt.run(
        r.symbol, r.pe || null, r.forward_pe || null, r.eps || null,
        r.market_cap || null, r.dividend_yield || null, r.beta || null,
        r.fifty_two_week_high || null, r.fifty_two_week_low || null,
        r.revenue_growth || null, r.profit_margins || null,
        r.debt_to_equity || null, r.total_debt || null, r.total_cash || null,
        r.sector || null, r.industry || null, r.ts
      );
      inserted++;
    }
    stmt.finalize(function(err) {
      if (err) reject(err); else resolve({ inserted: inserted });
    });
  });
}

// ─── Batch insert: métricas ─────────────────────────────────────────────────
function insertMetricsBatch(records) {
  return new Promise(function(resolve, reject) {
    if (!Array.isArray(records) || records.length === 0) { resolve({ inserted: 0 }); return; }
    var stmt = db.prepare(
      'INSERT OR IGNORE INTO metricas_diarias (symbol, sma_20, sma_50, sma_200, rsi_14, macd, macd_signal, bb_upper, bb_lower, atr_14, stoch_k, stoch_d, entry_score, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    var inserted = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r.symbol || !r.ts) continue;
      stmt.run(
        r.symbol, r.sma_20 || null, r.sma_50 || null, r.sma_200 || null,
        r.rsi_14 || null, r.macd || null, r.macd_signal || null,
        r.bb_upper || null, r.bb_lower || null, r.atr_14 || null,
        r.stoch_k || null, r.stoch_d || null, r.entry_score || null, r.ts
      );
      inserted++;
    }
    stmt.finalize(function(err) {
      if (err) reject(err); else resolve({ inserted: inserted });
    });
  });
}

// ─── Batch insert: alertas ──────────────────────────────────────────────────
function insertAlertasBatch(records) {
  return new Promise(function(resolve, reject) {
    if (!Array.isArray(records) || records.length === 0) { resolve({ inserted: 0 }); return; }
    var stmt = db.prepare(
      'INSERT INTO alertas_historial (symbol, tipo, mensaje, nivel, score, rsi_14, macd, price, ts) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    var inserted = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r.symbol || !r.ts) continue;
      stmt.run(r.symbol, r.tipo || null, r.mensaje || null, r.nivel || null, r.score || null, r.rsi_14 || null, r.macd || null, r.price || null, r.ts);
      inserted++;
    }
    stmt.finalize(function(err) {
      if (err) reject(err); else resolve({ inserted: inserted });
    });
  });
}

// ─── Lectura: último tick ────────────────────────────────────────────────────
function getLastTick(symbol) {
  return new Promise(function(resolve, reject) {
    db.get(
      'SELECT * FROM precios_tick WHERE symbol = ? ORDER BY ts DESC LIMIT 1',
      [symbol],
      function(err, row) { if (err) reject(err); else resolve(row || null); }
    );
  });
}

// ─── Lectura: ticks en rango ─────────────────────────────────────────────────
function getTicksRange(symbol, fromTs, toTs) {
  return new Promise(function(resolve, reject) {
    db.all(
      'SELECT * FROM precios_tick WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC',
      [symbol, fromTs, toTs],
      function(err, rows) { if (err) reject(err); else resolve(rows || []); }
    );
  });
}

// ─── Lectura: OHLCV en rango ─────────────────────────────────────────────────
function getOhlcvRange(symbol, fromTs, toTs, interval) {
  return new Promise(function(resolve, reject) {
    var sql = 'SELECT * FROM historico_ohlcv WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?';
    var params = [symbol, fromTs, toTs];
    if (interval) { sql += ' AND interval = ?'; params.push(interval); }
    sql += ' ORDER BY timestamp DESC';
    db.all(sql, params, function(err, rows) { if (err) reject(err); else resolve(rows || []); });
  });
}

// ─── Lectura: último OHLCV por símbolo ───────────────────────────────────────
function getLastOhlcv(symbol, interval) {
  return new Promise(function(resolve, reject) {
    var sql = 'SELECT * FROM historico_ohlcv WHERE symbol = ?';
    var params = [symbol];
    if (interval) { sql += ' AND interval = ?'; params.push(interval); }
    sql += ' ORDER BY timestamp DESC LIMIT 1';
    db.all(sql, params, function(err, rows) { if (err) reject(err); else resolve(rows && rows[0] ? rows[0] : null); });
  });
}

// ─── Lectura: últimos fundamentales ──────────────────────────────────────────
function getLastFundamentals(symbol) {
  return new Promise(function(resolve, reject) {
    db.get(
      'SELECT * FROM fundamentales_snapshot WHERE symbol = ? ORDER BY ts DESC LIMIT 1',
      [symbol],
      function(err, row) { if (err) reject(err); else resolve(row || null); }
    );
  });
}

// ─── Lectura: últimas métricas ─────────────────────────────────────────────────
function getLastMetrics(symbol) {
  return new Promise(function(resolve, reject) {
    db.get(
      'SELECT * FROM metricas_diarias WHERE symbol = ? ORDER BY ts DESC LIMIT 1',
      [symbol],
      function(err, row) { if (err) reject(err); else resolve(row || null); }
    );
  });
}

// ─── Lectura: última alerta ────────────────────────────────────────────────────
function getLastAlert(symbol) {
  return new Promise(function(resolve, reject) {
    db.get(
      'SELECT * FROM alertas_historial WHERE symbol = ? ORDER BY ts DESC LIMIT 1',
      [symbol],
      function(err, row) { if (err) reject(err); else resolve(row || null); }
    );
  });
}

// ─── Última actualización por tipo ────────────────────────────────────────────
function getLastUpdate(type, symbol) {
  return new Promise(function(resolve, reject) {
    var sql = 'SELECT * FROM update_log WHERE type = ?';
    var params = [type];
    if (symbol) { sql += ' AND symbol = ?'; params.push(symbol); }
    sql += ' ORDER BY ts DESC LIMIT 1';
    db.get(sql, params, function(err, row) { if (err) reject(err); else resolve(row || null); });
  });
}

// ─── Tiene OHLCV de hoy? ─────────────────────────────────────────────────────
function hasOhlcvToday(symbol, interval) {
  return new Promise(function(resolve, reject) {
    var todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    var todayEnd = todayStart + 24 * 60 * 60;
    var sql = 'SELECT COUNT(*) as count FROM historico_ohlcv WHERE symbol = ? AND timestamp >= ? AND timestamp < ?';
    var params = [symbol, todayStart, todayEnd];
    if (interval) { sql += ' AND interval = ?'; params.push(interval); }
    db.get(sql, params, function(err, row) {
      if (err) reject(err); else resolve((row && row.count > 0) ? true : false);
    });
  });
}

// ─── Lista de símbolos con datos ─────────────────────────────────────────────
function getSymbolsWithData(table) {
  return new Promise(function(resolve, reject) {
    var validTables = ['precios_tick', 'historico_ohlcv', 'fundamentales_snapshot', 'metricas_diarias', 'alertas_historial'];
    if (validTables.indexOf(table) === -1) { reject(new Error('Tabla inválida')); return; }
    db.all('SELECT DISTINCT symbol FROM ' + table + ' ORDER BY symbol', [], function(err, rows) {
      if (err) reject(err); else resolve((rows || []).map(function(r) { return r.symbol; }));
    });
  });
}

// ─── Count por tabla ─────────────────────────────────────────────────────────
function countRecords(table, symbol) {
  return new Promise(function(resolve, reject) {
    var sql = 'SELECT COUNT(*) as count FROM ' + table;
    var params = [];
    if (symbol) { sql += ' WHERE symbol = ?'; params.push(symbol); }
    db.get(sql, params, function(err, row) {
      if (err) reject(err); else resolve(row ? row.count : 0);
    });
  });
}

// ─── Limpieza: borrar datos más viejos de X días ─────────────────────────────
function cleanupOldData(table, days) {
  return new Promise(function(resolve, reject) {
    days = days || 90;
    var cutoff = nowSec() - days * 24 * 60 * 60;
    var validTables = ['precios_tick', 'historico_ohlcv', 'fundamentales_snapshot', 'metricas_diarias', 'alertas_historial', 'update_log'];
    if (validTables.indexOf(table) === -1) { reject(new Error('Tabla inválida')); return; }
    var tsCol = (table === 'historico_ohlcv') ? 'timestamp' : 'ts';
    db.run('DELETE FROM ' + table + ' WHERE ' + tsCol + ' < ?', [cutoff], function(err) {
      if (err) reject(err); else resolve({ deleted: this.changes, table: table, cutoff: cutoff });
    });
  });
}

// ─── Limpieza completa (wrapper) ───────────────────────────────────────────────
// historico_ohlcv EXCLUIDA — queremos preservar 15+ años para backtesting/ML.
// Si necesitás purgar histórico, llamá cleanupOldData('historico_ohlcv', N) explícito.
function cleanupAll(days) {
  var tables = ['precios_tick', 'fundamentales_snapshot', 'metricas_diarias', 'alertas_historial', 'update_log'];
  var promises = tables.map(function(t) { return cleanupOldData(t, days); });
  return Promise.all(promises);
}

// ─── Estadísticas de la base ───────────────────────────────────────────────────
function getDbStats() {
  var tables = ['precios_tick', 'historico_ohlcv', 'fundamentales_snapshot', 'metricas_diarias', 'alertas_historial', 'update_log'];
  var promises = tables.map(function(t) {
    return new Promise(function(resolve, reject) {
      db.get('SELECT COUNT(*) as count FROM ' + t, [], function(err, row) {
        if (err) reject(err); else resolve({ table: t, count: row ? row.count : 0 });
      });
    });
  });
  return Promise.all(promises).then(function(results) {
    var stats = {};
    results.forEach(function(r) { stats[r.table] = r.count; });
    return stats;
  });
}

// ─── INTELIGENCIA DE MERCADO ───────────────────────────────────────────────

function insertNewsBatch(records) {
  return new Promise(function(resolve, reject) {
    if (!Array.isArray(records) || records.length === 0) { resolve({ inserted: 0 }); return; }
    var stmt = db.prepare(
      'INSERT OR IGNORE INTO news_events (source, headline, summary, url, symbols, sentiment, category, impact_score, published_at, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    var inserted = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r.headline || !r.source) continue;
      stmt.run(r.source, r.headline, r.summary || null, r.url || null,
        JSON.stringify(r.symbols || []), r.sentiment || null, r.category || null,
        r.impact_score || null, r.published_at || nowSec(), nowSec());
      inserted++;
    }
    stmt.finalize(function(err) { if (err) reject(err); else resolve({ inserted: inserted }); });
  });
}

function getNewsForSymbol(symbol, hours, limit) {
  return new Promise(function(resolve, reject) {
    var cutoff = nowSec() - (hours || 24) * 3600;
    var like = '%"' + symbol + '"%';
    db.all(
      'SELECT * FROM news_events WHERE (symbols LIKE ? OR symbols LIKE ?) AND published_at > ? ORDER BY published_at DESC LIMIT ?',
      [like, '%' + symbol + '%', cutoff, limit || 50],
      function(err, rows) { if (err) reject(err); else resolve(rows || []); }
    );
  });
}

function getNewsByCategory(category, hours, limit) {
  return new Promise(function(resolve, reject) {
    var cutoff = nowSec() - (hours || 24) * 3600;
    db.all(
      'SELECT * FROM news_events WHERE category = ? AND published_at > ? ORDER BY published_at DESC LIMIT ?',
      [category, cutoff, limit || 50],
      function(err, rows) { if (err) reject(err); else resolve(rows || []); }
    );
  });
}

function insertAnomaly(record) {
  return new Promise(function(resolve, reject) {
    if (!record.symbol || !record.timestamp) { resolve({ inserted: 0 }); return; }
    db.run(
      'INSERT INTO price_anomalies (symbol, timestamp, price, return_1h, return_1d, return_5d, volume_zscore, volatility_spike, news_ids, anomaly_type, detected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [record.symbol, record.timestamp, record.price || null, record.return_1h || null,
       record.return_1d || null, record.return_5d || null, record.volume_zscore || null,
       record.volatility_spike || null, JSON.stringify(record.news_ids || []),
       record.anomaly_type || 'unknown', nowSec()],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function getAnomaliesForSymbol(symbol, days, limit) {
  return new Promise(function(resolve, reject) {
    var cutoff = nowSec() - (days || 7) * 24 * 3600;
    db.all(
      'SELECT * FROM price_anomalies WHERE symbol = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT ?',
      [symbol, cutoff, limit || 50],
      function(err, rows) { if (err) reject(err); else resolve(rows || []); }
    );
  });
}

function getRecentAnomalies(limit) {
  return new Promise(function(resolve, reject) {
    db.all(
      'SELECT * FROM price_anomalies ORDER BY timestamp DESC LIMIT ?',
      [limit || 50],
      function(err, rows) { if (err) reject(err); else resolve(rows || []); }
    );
  });
}

function insertPattern(record) {
  return new Promise(function(resolve, reject) {
    if (!record.pattern_name) { resolve({ inserted: 0 }); return; }
    db.run(
      'INSERT OR REPLACE INTO news_price_patterns (pattern_name, category, keyword, symbol_pattern, avg_return_1h, avg_return_1d, avg_return_5d, win_rate, sample_count, confidence, last_seen, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [record.pattern_name, record.category || null, record.keyword || null,
       record.symbol_pattern || null, record.avg_return_1h || null, record.avg_return_1d || null,
       record.avg_return_5d || null, record.win_rate || null, record.sample_count || 0,
       record.confidence || null, record.last_seen || nowSec(), nowSec()],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function getPatterns(category, limit) {
  return new Promise(function(resolve, reject) {
    var sql = category
      ? 'SELECT * FROM news_price_patterns WHERE category = ? ORDER BY confidence DESC, sample_count DESC LIMIT ?'
      : 'SELECT * FROM news_price_patterns ORDER BY confidence DESC, sample_count DESC LIMIT ?';
    var params = category ? [category, limit || 50] : [limit || 50];
    db.all(sql, params, function(err, rows) { if (err) reject(err); else resolve(rows || []); });
  });
}

function insertMacroEvent(record) {
  return new Promise(function(resolve, reject) {
    if (!record.event_type) { resolve({ inserted: 0 }); return; }
    db.run(
      'INSERT INTO macro_events (event_type, event_date, description, expected_value, actual_value, surprise, market_impact, affected_sectors, ts) VALUES (?,?,?,?,?,?,?,?,?)',
      [record.event_type, record.event_date || null, record.description || null,
       record.expected_value || null, record.actual_value || null, record.surprise || null,
       record.market_impact || null, JSON.stringify(record.affected_sectors || []), nowSec()],
      function(err) { if (err) reject(err); else resolve({ id: this.lastID }); }
    );
  });
}

function getMacroEvents(eventType, days, limit) {
  return new Promise(function(resolve, reject) {
    var cutoff = nowSec() - (days || 30) * 24 * 3600;
    var sql = eventType
      ? 'SELECT * FROM macro_events WHERE event_type = ? AND ts > ? ORDER BY ts DESC LIMIT ?'
      : 'SELECT * FROM macro_events WHERE ts > ? ORDER BY ts DESC LIMIT ?';
    var params = eventType ? [eventType, cutoff, limit || 50] : [cutoff, limit || 50];
    db.all(sql, params, function(err, rows) { if (err) reject(err); else resolve(rows || []); });
  });
}

// ─── Legado: wrappers compatibles ────────────────────────────────────────────
function guardarAlerta(symbol, tipo, mensaje, score, rsi14, macd, price) {
  return insertAlertasBatch([{
    symbol: symbol, tipo: tipo, mensaje: mensaje, nivel: 'info',
    score: score, rsi_14: rsi14, macd: macd, price: price, ts: nowSec()
  }]);
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

function guardarPrecioCache(symbol, price, changePct, source) {
  return new Promise(function(resolve, reject) {
    db.run(
      'INSERT OR REPLACE INTO precios_cache (symbol, price, change_pct, source, ts) VALUES (?,?,?,?,?)',
      [symbol, price, changePct, source, nowSec()],
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

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  initDb: initDb,
  nowSec: nowSec,

  // Insert batch
  insertTickBatch: insertTickBatch,
  insertOhlcvBatch: insertOhlcvBatch,
  insertFundamentalsBatch: insertFundamentalsBatch,
  insertMetricsBatch: insertMetricsBatch,
  insertAlertasBatch: insertAlertasBatch,
  logUpdate: logUpdate,

  // Lectura time-series
  getLastTick: getLastTick,
  getTicksRange: getTicksRange,
  getOhlcvRange: getOhlcvRange,
  getLastOhlcv: getLastOhlcv,
  getLastFundamentals: getLastFundamentals,
  getLastMetrics: getLastMetrics,
  getLastAlert: getLastAlert,
  getLastUpdate: getLastUpdate,
  hasOhlcvToday: hasOhlcvToday,
  getSymbolsWithData: getSymbolsWithData,
  countRecords: countRecords,
  getDbStats: getDbStats,

  // Limpieza
  cleanupOldData: cleanupOldData,
  cleanupAll: cleanupAll,

  // Legado compat
  guardarAlerta: guardarAlerta,
  obtenerAlertas: obtenerAlertas,
  guardarOptimizacion: guardarOptimizacion,
  obtenerOptimizaciones: obtenerOptimizaciones,
  guardarCapmMetrics: guardarCapmMetrics,
  obtenerCapm: obtenerCapm,
  guardarPrecioCache: guardarPrecioCache,
  obtenerPrecioCache: obtenerPrecioCache,

  // Inteligencia de mercado
  insertNewsBatch: insertNewsBatch,
  getNewsForSymbol: getNewsForSymbol,
  getNewsByCategory: getNewsByCategory,
  insertAnomaly: insertAnomaly,
  getAnomaliesForSymbol: getAnomaliesForSymbol,
  getRecentAnomalies: getRecentAnomalies,
  insertPattern: insertPattern,
  getPatterns: getPatterns,
  insertMacroEvent: insertMacroEvent,
  getMacroEvents: getMacroEvents,

  // Raw db (para queries avanzadas)
  _db: db
};

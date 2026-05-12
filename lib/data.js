'use strict';
/**
 * lib/data.js — Fetchers de datos de mercado
 * Yahoo Finance v8 + investing.com (fallback)
 */
var https = require('https');
var http = require('http');

// ─── Mapeo de símbolos internos a IDs ─────────────────────────────────────────
// Símbolos internos: limpios (sin URL-encode)
// Yahoo Finance usa ^ para índices, - para crypto
var SYMBOL_MAP = {
  // Símbolo interno  →  { yahoo: 'SYMBOL', investingId: ID }
  'NDX':    { yahoo: '^NDX',    investingId: 13713 },
  'GSPC':   { yahoo: '^GSPC',   investingId: 166 },
  'DJI':    { yahoo: '^DJI',    investingId: 169 },
  'GDAXI':  { yahoo: '^GDAXI',  investingId: 175024 },
  'FTSE':   { yahoo: '^FTSE',   investingId: 27 },
  'N225':   { yahoo: '^N225',   investingId: 36 },
  'GC=F':   { yahoo: 'GC=F',    investingId: 941 },
  'CL=F':   { yahoo: 'CL=F',    investingId: 8849 },
  'BZ=F':   { yahoo: 'BZ=F',    investingId: 8833 },
  'USDCLP=X': { yahoo: 'USDCLP=X', investingId: 2103 },
  'BTC-USD': { yahoo: 'BTC-USD', investingId: 945629 },
  'ETH-USD': { yahoo: 'ETH-USD', investingId: 1010600 },
  'EURUSD=X': { yahoo: 'EURUSD=X', investingId: 1 }
};

// Lista de símbolos por defecto
var DEFAULT_SYMBOLS = Object.keys(SYMBOL_MAP);

// ─── Fetch genérico HTTP/HTTPS ────────────────────────────────────────────────
function httpFetch(url, headers) {
  return new Promise(function(resolve, reject) {
    var mod = url.startsWith('https') ? https : http;
    var opts = { headers: headers || {} };
    if (!opts.headers['User-Agent']) {
      opts.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    }
    mod.get(url, opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message + ' | body: ' + body.substring(0, 200))); }
      });
    }).on('error', reject).setTimeout(10000, function() { this.destroy(new Error('Timeout HTTP')); });
  });
}

// ─── Fetch investing.com ──────────────────────────────────────────────────────
function investingFetch(pairId) {
  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: 'api.investing.com',
      path: '/api/financialdata/' + pairId + '/historical/chart/?period=P1D&interval=PT1M&pointscount=5',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Referer': 'https://www.investing.com/',
        'Origin': 'https://www.investing.com',
        'domain-id': 'www',
        'v': '4'
      }
    };
    var req = https.get(opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try { resolve({ parsed: JSON.parse(body), status: res.statusCode }); }
        catch(e) { reject(new Error('Investing parse [' + res.statusCode + ']: ' + body.substring(0, 300))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, function() { req.destroy(new Error('Investing timeout')); });
  }).then(function(raw) {
    if (raw.status !== 200) throw new Error('Investing HTTP ' + raw.status);
    return raw;
  });
}

// Parsear quote desde investing.com
function parseInvestingQuote(raw) {
  var d = raw.parsed || raw;
  if (d.data && Array.isArray(d.data) && d.data.length) {
    var rows = d.data;
    var last = rows[rows.length - 1];
    var prev = rows.length > 1 ? rows[rows.length - 2] : null;
    var price = parseFloat(last[4]);
    var prevClose = prev ? parseFloat(prev[4]) : price;
    return { price: price, prevClose: prevClose };
  }
  throw new Error('Formato investing.com desconocido');
}

// ─── Yahoo Finance v8 ─────────────────────────────────────────────────────────
function yahooChart(symbol, interval, range) {
  var mapped = SYMBOL_MAP[symbol] || { yahoo: symbol };
  var yahooSym = mapped.yahoo || symbol;
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooSym)
          + '?interval=' + (interval || '1d') + '&range=' + (range || '1y');
  return httpFetch(url);
}

function yahooQuote(symbol) {
  var mapped = SYMBOL_MAP[symbol] || { yahoo: symbol };
  var yahooSym = mapped.yahoo || symbol;
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooSym) + '?interval=1m&range=1d';
  return httpFetch(url).then(function(data) {
    if (!data || !data.chart || !data.chart.result || !data.chart.result[0]) {
      throw new Error('Sin datos Yahoo para ' + symbol);
    }
    var meta = data.chart.result[0].meta;
    var price = meta.regularMarketPrice;
    var prev = meta.chartPreviousClose || meta.previousClose || price;
    return {
      symbol: symbol,
      price: price,
      prevClose: prev,
      change: price - prev,
      changePct: prev > 0 ? (price - prev) / prev * 100 : 0,
      marketState: meta.marketState || 'UNKNOWN',
      source: 'yahoo',
      ts: Date.now()
    };
  });
}

// Extraer OHLCV desde respuesta Yahoo
function parseYahooOHLCV(data) {
  if (!data || !data.chart || !data.chart.result || !data.chart.result[0]) return null;
  var r = data.chart.result[0];
  var q = r.indicators.quote[0];
  var ts = r.timestamp;
  if (!q || !q.close) return null;
  var ohlcv = [];
  for (var i = 0; i < ts.length; i++) {
    if (q.close[i] === null || q.close[i] === undefined) continue;
    ohlcv.push({
      timestamp: ts[i],
      open: q.open[i] || q.close[i],
      high: q.high[i] || q.close[i],
      low: q.low[i] || q.close[i],
      close: q.close[i],
      volume: q.volume[i] || 0
    });
  }
  return { ohlcv: ohlcv, meta: r.meta };
}

// Quote principal con fallback
function getQuote(symbol) {
  var mapped = SYMBOL_MAP[symbol] || { yahoo: symbol };
  // Yahoo primero (más confiable), investing como fallback
  return yahooQuote(symbol).catch(function(err) {
    console.log('[data] Yahoo falló para', symbol, '- fallback a investing:', err.message);
    var pairId = mapped.investingId;
    if (!pairId) throw new Error('Sin investingId para ' + symbol);
    return investingFetch(pairId).then(function(raw) {
      var q = parseInvestingQuote(raw);
      return {
        symbol: symbol,
        price: q.price,
        prevClose: q.prevClose,
        change: q.price - q.prevClose,
        changePct: q.prevClose > 0 ? (q.price - q.prevClose) / q.prevClose * 100 : 0,
        marketState: 'REGULAR',
        source: 'investing',
        ts: Date.now()
      };
    });
  });
}

// Datos históricos
function getHistorical(symbol, interval, range) {
  return yahooChart(symbol, interval, range).then(function(raw) {
    var parsed = parseYahooOHLCV(raw);
    if (!parsed) throw new Error('Sin datos históricos para ' + symbol);
    return parsed;
  });
}

module.exports = {
  SYMBOL_MAP: SYMBOL_MAP,
  DEFAULT_SYMBOLS: DEFAULT_SYMBOLS,
  httpFetch: httpFetch,
  investingFetch: investingFetch,
  parseInvestingQuote: parseInvestingQuote,
  yahooChart: yahooChart,
  yahooQuote: yahooQuote,
  parseYahooOHLCV: parseYahooOHLCV,
  getQuote: getQuote,
  getHistorical: getHistorical
};

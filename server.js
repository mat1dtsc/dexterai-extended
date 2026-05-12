'use strict';
/**
 * server.js — DexterAI Extended v2.0
 * Servidor principal: análisis técnico, Markowitz, CAPM, alertas
 */
var express = require('express');
var path = require('path');
var https = require('https');
var http = require('http');

var app = express();
var PORT = process.env.PORT || 3005;

// ─── Inicializar DB ───────────────────────────────────────────────────────────
var db = require('./lib/db');
db.initDb();
// db_v2 contiene tablas adicionales (news_events, price_anomalies, etc.)
// usadas por cron/news_pipeline. Misma DB, schemas no conflictivos (CREATE IF NOT EXISTS).
try { require('./lib/db_v2').initDb(); } catch(e) { console.warn('[INIT] db_v2 init falló:', e.message); }

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));

// ─── Claude API (chat con analista financiero) ────────────────────────────────
var CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
(function() {
  if (!CLAUDE_KEY) {
    try {
      var fs = require('fs');
      var kf = path.join(__dirname, 'api_key.txt');
      if (fs.existsSync(kf)) {
        CLAUDE_KEY = fs.readFileSync(kf, 'utf8').trim();
        if (CLAUDE_KEY) console.log('[Claude] API key cargada desde api_key.txt');
      }
    } catch(e) {}
  }
})();

app.post('/api/chat', function(req, res) {
  var question = (req.body && req.body.question) ? String(req.body.question).trim() : '';
  var ctx = (req.body && req.body.context) ? String(req.body.context) : '';

  if (!CLAUDE_KEY) {
    res.status(503).json({ error: 'API key no configurada. Crea api_key.txt con ANTHROPIC_API_KEY o define variable de entorno.' });
    return;
  }
  if (!question) { res.status(400).json({ error: 'Pregunta vacía' }); return; }

  var systemPrompt = 'Eres un analista financiero experto en trading de CFDs, índices, commodities, forex y crypto. Respondes en español, conciso y directo. Contexto actual:\n\n' + ctx + '\n\nUsa estos datos cuando el usuario pregunte sobre el instrumento activo. No inventes precios ni datos.';

  var payload = JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    stream: true,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }]
  });

  var opts = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': CLAUDE_KEY,
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  var apiReq = https.request(opts, function(apiRes) {
    var buf = '';
    apiRes.on('data', function(chunk) {
      buf += chunk.toString();
      var lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(function(line) {
        line = line.trim();
        if (!line || !line.startsWith('data: ')) return;
        var raw = line.slice(6);
        if (raw === '[DONE]') { res.write('data: [DONE]\n\n'); return; }
        try {
          var ev = JSON.parse(raw);
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            res.write('data: ' + JSON.stringify({ t: ev.delta.text }) + '\n\n');
          } else if (ev.type === 'message_stop') {
            res.write('data: [DONE]\n\n');
          } else if (ev.type === 'error') {
            res.write('data: ' + JSON.stringify({ e: ev.error ? ev.error.message : 'Error API' }) + '\n\n');
          }
        } catch(e) {}
      });
    });
    apiRes.on('end', function() { res.write('data: [DONE]\n\n'); res.end(); });
    apiRes.on('error', function(err) { res.write('data: ' + JSON.stringify({ e: err.message }) + '\n\n'); res.end(); });
  });

  apiReq.on('error', function(err) { res.write('data: ' + JSON.stringify({ e: err.message }) + '\n\n'); res.end(); });
  apiReq.setTimeout(30000, function() { apiReq.destroy(new Error('Timeout API Claude')); });
  apiReq.write(payload);
  apiReq.end();
});

// ─── Rutas ────────────────────────────────────────────────────────────────────
var quoteRoutes = require('./routes/quote');
var analysisRoutes = require('./routes/analysis');
var portfolioRoutes = require('./routes/portfolio');
var capmRoutes = require('./routes/capm');
var alertsRoutes = require('./routes/alerts');

app.use('/api/quote', quoteRoutes);
app.use('/api/data', analysisRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/capm', capmRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/intelligence', require('./routes/intelligence'));
app.use('/api/openbb', require('./routes/openbb'));
app.use('/api/watchlist', require('./routes/watchlist'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/signals', require('./routes/signals'));
app.use('/api/onchain', require('./routes/onchain'));
app.use('/api/predict', require('./routes/predict'));
app.use('/api/binance', require('./routes/binance'));
app.use('/api/congress', require('./routes/congress'));

// ─── Contexto nocturno — resumen diario ─────────────────────────────────────
app.get('/api/context/daily', function(req, res) {
  var symbols = req.query.symbols ? req.query.symbols.split(',') : ['NDX', 'GSPC', 'GC=F', 'CL=F', 'BTC-USD'];
  var data = require('./lib/marketData');
  var promises = [];

  for (var i = 0; i < symbols.length; i++) {
    (function(sym) {
      promises.push(
        data.getQuote(sym).then(function(q) {
          return { symbol: sym, price: q.price, changePct: q.changePct, source: q.source };
        }).catch(function() { return null; })
      );
    })(symbols[i]);
  }

  Promise.all(promises).then(function(quotes) {
    var valid = quotes.filter(function(q) { return q !== null; });
    var ganadores = valid.filter(function(q) { return q.changePct > 0; }).sort(function(a, b) { return b.changePct - a.changePct; });
    var perdedores = valid.filter(function(q) { return q.changePct < 0; }).sort(function(a, b) { return a.changePct - b.changePct; });

    res.json({
      fecha: new Date().toISOString(),
      totalActivos: valid.length,
      ganadores: ganadores,
      perdedores: perdedores,
      neutral: valid.filter(function(q) { return Math.abs(q.changePct) < 0.1; }),
      quotes: valid
    });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
// ─── Reinicio controlado del servidor ────────────────────────────────────────
console.log('[INIT] Reiniciando servidor...');

// Pre-cargar módulos para evitar delays en primer request
setTimeout(function() {
  var data = require('./lib/marketData');
  data.testConnectivity().then(function(r) {
    console.log('[INIT] Market data:', r.ok ? 'OK' : 'FALLÓ — ' + r.message);
  }).catch(function(e) {
    console.log('[INIT] Market data: Error —', e.message);
  });
}, 500);

// ─── Start / Export for Vercel ─────────────────────────────────────────────
if (process.env.VERCEL) {
  module.exports = app;
} else {
  var httpServer = http.createServer(app);

  // ─── WebSocket live stream ─────────────────────────────────────────────
  try {
    var liveStream = require('./lib/liveStream');
    liveStream.attach(httpServer);
  } catch (e) {
    console.warn('[INIT] liveStream no disponible:', e.message);
  }

  httpServer.listen(PORT, '0.0.0.0', function() {
    console.log('DexterAI Extended v2.0 corriendo en http://0.0.0.0:' + PORT);
    console.log('  WS    ws://0.0.0.0:' + PORT + '/ws');
    console.log('Endpoints:');
    console.log('  GET  /api/quote?symbol=GSPC');
    console.log('  GET  /api/data?symbol=NDX');
    console.log('  POST /api/portfolio/optimize');
    console.log('  GET  /api/capm/betas');
    console.log('  GET  /api/alerts/check');
    console.log('  GET  /api/context/daily');
    console.log('  GET  /api/intelligence/news?symbol=AAPL');
    console.log('  GET  /api/intelligence/anomalies?symbol=AAPL');
    console.log('  GET  /api/intelligence/patterns?category=earnings');
    console.log('  GET  /api/intelligence/context?symbol=AAPL');

    // ─── Scheduler de alertas cada 5 minutos ──────────────────────────────────
    var cron = require('node-cron');
    var alertChecker = require('./cron/alert_checker');
    var ALERT_SYMBOLS = process.env.ALERT_SYMBOLS
      ? process.env.ALERT_SYMBOLS.split(',')
      : ['NDX', 'GSPC', 'DJI', 'GC=F', 'CL=F', 'BZ=F', 'BTC-USD', 'ETH-USD'];

    console.log('\n[ALERTS] Scheduler activo — revisión cada 5 minutos');
    console.log('[ALERTS] Activos monitoreados:', ALERT_SYMBOLS.join(', '));

    cron.schedule('*/5 * * * *', function() {
      console.log('[ALERTS] Revisión automática iniciada:', new Date().toISOString());
      try {
        alertChecker.checkAlerts();
      } catch(e) {
        console.error('[ALERTS] Error en scheduler:', e.message);
      }
    });

    // ─── Scheduler de inteligencia de mercado cada 15 minutos ───────────────
    var newsPipeline = require('./cron/news_pipeline');
    console.log('\n[INTELLIGENCE] Scheduler activo — pipeline cada 15 minutos');
    console.log('[INTELLIGENCE] Fuentes: Yahoo, Seeking Alpha, CNBC, MarketWatch');

    cron.schedule('*/15 * * * *', function() {
      console.log('[INTELLIGENCE] Pipeline iniciado:', new Date().toISOString());
      try {
        newsPipeline.runPipeline();
      } catch(e) {
        console.error('[INTELLIGENCE] Error en pipeline:', e.message);
      }
    });

    // Primera corrida inmediata
    setTimeout(function() {
      try { newsPipeline.runPipeline(); } catch(e) {}
    }, 3000);
  });
}

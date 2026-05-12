const { execSync } = require('child_process');

try {
  execSync('fuser -k 3005/tcp 2>/dev/null');
  console.log('Killed old server');
} catch(e) {}

setTimeout(() => {
  const spawn = require('child_process').spawn;
  const s = spawn('node', ['/root/.openclaw/workspace/dexterai-extended/server.js'], {
    detached: true, stdio: 'ignore'
  });
  s.unref();
  console.log('Server started, PID:', s.pid);

  setTimeout(() => {
    const http = require('http');
    const tests = [
      { name: 'Quote NDX', path: '/api/quote?symbol=NDX' },
      { name: 'Data NDX', path: '/api/data?symbol=NDX' },
      { name: 'Historical NDX', path: '/api/quote/historical?symbol=NDX&interval=1d&range=3mo' },
      { name: 'Intraday NDX', path: '/api/quote/intraday?symbol=NDX' },
      { name: 'CAPM betas', path: '/api/capm/betas?symbols=NDX,GSPC&benchmark=^GSPC' },
      { name: 'CAPM compare', path: '/api/capm/compare?symbols=NDX,GSPC' },
      { name: 'Alerts check', path: '/api/alerts/check' },
      { name: 'Context daily', path: '/api/context/daily' },
      { name: 'Static index', path: '/' }
    ];

    function req(path) {
      return new Promise((resolve, reject) => {
        http.get('http://localhost:3005' + path, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve({ status: res.statusCode, body: body }));
        }).on('error', reject);
      });
    }

    function post(path, data) {
      return new Promise((resolve, reject) => {
        const opts = { hostname: 'localhost', port: 3005, path: path, method: 'POST', headers: { 'Content-Type': 'application/json' } };
        const r = http.request(opts, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve({ status: res.statusCode, body: body }));
        });
        r.on('error', reject);
        r.write(JSON.stringify(data));
        r.end();
      });
    }

    async function run() {
      for (const t of tests) {
        try {
          const r = await req(t.path);
          let ok = 'OK';
          if (r.status !== 200) ok = 'FAIL status=' + r.status;
          else {
            try {
              const d = JSON.parse(r.body);
              if (d.error) ok = 'FAIL error=' + d.error;
              else if (t.name === 'Data NDX') {
                if (!d.indicadores) ok = 'FAIL no indicadores';
                else if (!d.sugerencia) ok = 'FAIL no sugerencia';
                else if (d.indicadores.stochD === undefined) ok = 'FAIL no stochD';
                else ok = 'OK indicadores+sugerencia+stochD';
              } else if (t.name === 'Quote NDX') {
                if (d.price == null) ok = 'FAIL no price';
                else ok = 'OK price=' + d.price;
              } else if (t.name === 'Alerts check') {
                if (!Array.isArray(d.resultados)) ok = 'FAIL no resultados array';
                else ok = 'OK alerts=' + d.resultados.length;
              } else if (t.name === 'Historical NDX') {
                if (!Array.isArray(d.ohlcv)) ok = 'FAIL no ohlcv';
                else ok = 'OK ohlcv=' + d.ohlcv.length;
              }
            } catch(e) {
              if (t.name === 'Static index') {
                if (r.body.includes('<!DOCTYPE html>') || r.body.includes('<html')) ok = 'OK HTML';
                else ok = 'FAIL not HTML';
              }
            }
          }
          console.log(t.name + ': ' + ok);
        } catch(e) {
          console.log(t.name + ': FAIL ' + e.message);
        }
      }

      try {
        const r = await post('/api/portfolio/optimize', { symbols: ['NDX','GSPC'], rf: 0.045 });
        let ok = 'OK';
        if (r.status !== 200) ok = 'FAIL status=' + r.status;
        else {
          const d = JSON.parse(r.body);
          if (d.error) ok = 'FAIL error=' + d.error;
          else if (!d.optimo) ok = 'FAIL no optimo';
          else if (typeof d.optimo.pesos !== 'object') ok = 'FAIL pesos not object';
          else if (!d.frontera) ok = 'FAIL no frontera';
          else ok = 'OK optimo+frontera';
        }
        console.log('Portfolio optimize: ' + ok);
      } catch(e) {
        console.log('Portfolio optimize: FAIL ' + e.message);
      }
    }

    run();
  }, 4000);
}, 1000);

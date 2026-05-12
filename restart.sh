#!/bin/bash
kill $(cat /tmp/dexter.pid 2>/dev/null) 2>/dev/null
sleep 2
cd /root/.openclaw/workspace/dexterai-extended
# Inicializar DB con nuevo esquema
node -e "require('./lib/db_v2').initDb(); console.log('DB reinicializada');"
# Mantener proceso anterior si existe
node server.js &
echo $! > /tmp/dexter.pid
sleep 4
curl -s http://localhost:3005/health
echo ""
curl -s "http://localhost:3005/api/intelligence/news?symbol=AAPL&hours=24&limit=3" | head -c 500
echo ""

# DexterAI Extended — Instalación Local

## ¿Por qué local y no Vercel?

| Característica | Vercel Serverless | Tu computadora |
|----------------|-------------------|----------------|
| Base de datos SQLite | ❌ No persiste | ✅ Persiste forever |
| Cron jobs (alertas cada 5 min) | ❌ No corren | ✅ Corren 24/7 |
| Noticias RSS cada 15 min | ❌ No corren | ✅ Corren 24/7 |
| Datos históricos acumulados | ❌ Se pierden | ✅ Crecen con el tiempo |
| WebSockets / Streaming | ❌ No soportado | ✅ Posible |
| Latencia | ❌ ~200ms | ✅ ~5ms |

**Vercel serverless mata la inteligencia del proyecto.** Local es la única forma de que aprenda patrones con el tiempo.

---

## Requisitos

- Node.js 18+ (recomendado 20+)
- Git
- ~500MB de disco

---

## Instalación en 3 pasos

### Paso 1: Clonar el repo

```bash
git clone https://github.com/mat1dtsc/dexterai-extended.git
cd dexterai-extended
```

### Paso 2: Instalar dependencias

```bash
npm install
```

### Paso 3: Iniciar la base de datos y el servidor

```bash
# Primera vez: crear base de datos
npm run init-db

# Iniciar servidor
npm start
```

El servidor arranca en `http://localhost:3005`

---

## Scripts disponibles

```bash
npm start              # Inicia servidor (puerto 3005)
npm test               # Corre tests de calidad
npm run init-db        # Crea base de datos
npm run cron-alerts    # Corre alertas manualmente
```

---

## ¿Qué corre automáticamente?

Cuando hacés `npm start`, se activan:

1. **Servidor web** — API REST en localhost:3005
2. **Alertas cada 5 minutos** — revisa NDX, SPX, oro, petróleo, crypto
3. **Pipeline de inteligencia cada 15 min** — noticias RSS + detección de anomalías
4. **Base de datos SQLite** — guarda precios, noticias, patrones, alertas

---

## Datos en tiempo real

### Situación actual
- **Yahoo Finance** (lo que usamos): delay de ~15 minutos
- Esto es gratis y funciona bien para análisis, no para scalping

### Opciones para datos más rápidos

| Fuente | Latencia | Costo | Cómo conectar |
|--------|----------|-------|---------------|
| **Yahoo Finance** (actual) | ~15 min | Gratis | Ya funciona |
| **Alpaca** | ~1-5 min | Gratis (plan básico) | API key gratis |
| **Polygon.io** | Real-time | Gratis (5 llamadas/min) | API key |
| **Webull** | ~1 min | Gratis | Web scraping |
| **Finnhub** | Real-time | Gratis (60 llamadas/min) | API key |

### Conectar Alpaca (gratis)

1. Andá a [alpaca.markets](https://alpaca.markets) y creá cuenta
2. Generá API keys (paper trading es gratis)
3. Creá archivo `.env`:
```
ALPACA_API_KEY=PKxxxxxxxxxx
ALPACA_SECRET_KEY=xxxxxxxxxx
```
4. El código ya tiene soporte para Alpaca en `lib/marketData.js`

### Conectar Polygon.io (gratis, 5 req/min)

1. Andá a [polygon.io](https://polygon.io)
2. Registrate (plan gratuito)
3. Agregá a `.env`:
```
POLYGON_API_KEY=xxxxxxxxxx
```

---

## Endpoints principales

| Endpoint | Qué hace |
|----------|----------|
| `GET /health` | Estado del servidor |
| `GET /api/quote?symbol=AAPL` | Precio en vivo |
| `GET /api/data?symbol=AAPL` | Análisis técnico completo |
| `GET /api/quote/historical?symbol=AAPL` | Velas OHLCV |
| `POST /api/portfolio/optimize` | Optimización Markowitz |
| `GET /api/capm/betas` | Betas de CAPM |
| `GET /api/alerts/check` | Chequear alertas |
| `GET /api/context/daily` | Resumen diario del mercado |
| `GET /api/intelligence/news?symbol=AAPL` | Noticias recientes |
| `GET /api/intelligence/anomalies?symbol=AAPL` | Anomalías de precio |
| `GET /api/intelligence/context?symbol=AAPL` | Resumen completo |

---

## Estructura de archivos

```
dexterai-extended/
├── server.js              # Servidor principal
├── lib/
│   ├── db_v2.js           # Base de datos SQLite
│   ├── marketData.js      # Fetch de Yahoo Finance
│   ├── indicators.js      # Indicadores técnicos
│   ├── newsFeed.js        # RSS scraper
│   ├── anomalyDetector.js # Detección de anomalías
│   └── sync.js            # Pipeline de sincronización
├── cron/
│   ├── alert_checker.js   # Alertas cada 5 min
│   ├── news_pipeline.js   # Noticias cada 15 min
│   └── sync_pipeline.js   # Datos cada 5 min
├── routes/
│   ├── quote.js           # Precios
│   ├── analysis.js        # Análisis técnico
│   ├── portfolio.js       # Markowitz
│   ├── capm.js            # CAPM
│   ├── alerts.js          # Alertas
│   └── intelligence.js    # Noticias + anomalías
├── data/
│   └── dexter.db          # Base de datos local
└── tests/                 # Tests de calidad
```

---

## Para que corra 24/7 en tu máquina

### Opción A: PM2 (recomendado)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar con PM2
pm2 start server.js --name "dexterai"

# Guardar configuración
pm2 save
pm2 startup

# Ver logs
pm2 logs dexterai

# Reiniciar
pm2 restart dexterai
```

### Opción B: Docker

```bash
# Construir imagen
docker build -t dexterai .

# Correr
docker run -d -p 3005:3005 -v $(pwd)/data:/app/data dexterai
```

### Opción C: systemd (Linux)

Creá archivo `/etc/systemd/system/dexterai.service`:

```ini
[Unit]
Description=DexterAI Extended
After=network.target

[Service]
Type=simple
User=tu_usuario
WorkingDirectory=/home/tu_usuario/dexterai-extended
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable dexterai
sudo systemctl start dexterai
sudo systemctl status dexterai
```

---

## Datos que se acumulan con el tiempo

Cuando corre localmente, la base de datos crece y aprende:

| Tiempo | Qué tenés |
|--------|-----------|
| 1 día | Precios cada 5 min, ~50 noticias |
| 1 semana | Patrones iniciales de correlación |
| 1 mes | Historial completo, alertas calibradas |
| 3 meses | Patrones sólidos de noticia-precio |
| 6 meses | Base de datos valiosa para backtesting |

---

## Troubleshooting

### Error: Puerto 3005 ocupado
```bash
# Matar proceso en el puerto
npx kill-port 3005
```

### Error: SQLite no inicializa
```bash
rm -rf data/dexter.db
npm run init-db
npm start
```

### Error: Yahoo Finance bloquea requests
Es normal si hacés muchos requests. El código ya tiene retry automático. Si persiste, esperá 5 minutos.

### Error: Noticias RSS no llegan
Algunos feeds bloquean IPs. El sistema intenta 4 fuentes. Si todas fallan, esperá 15 min y reintenta.

---

## Próximos pasos recomendados

1. **Corré `npm start` y dejalo andando 24h**
2. **Mirá `http://localhost:3005` en tu navegador**
3. **Revisá `/api/intelligence/news` después de 15 min**
4. **Conectá una API de datos más rápida** (Alpaca/Polygon) cuando estés listo

---

## Contacto / Issues

Si algo no funciona, abrí un issue en GitHub o revisá los logs:

```bash
# Logs en vivo
tail -f server.log

# Logs con PM2
pm2 logs dexterai
```

---

*DexterAI Extended v2.0 — Monitor financiero autónomo*

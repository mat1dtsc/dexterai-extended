
## 2026-05-12 — Inteligencia de Mercado (Fase 1.5)

### Tablas agregadas a DB v3
- **news_events**: noticias con headline, summary, url, symbols, sentiment, category
- **price_anomalies**: movimientos anómalos de precio con returns forward, volume zscore, volatility spike
- **news_price_patterns**: patrones aprendidos de correlación noticia-precio (win rate, sample count, confidence)
- **macro_events**: eventos macro (FOMC, CPI, employment) con expected vs actual

### Archivos creados
- **lib/newsFeed.js**: RSS scraper con 4 fuentes (Yahoo, Seeking Alpha, CNBC, MarketWatch)
  - Parseo nativo sin xml2js (regex + string manipulation)
  - Clasificación automática por keywords (7 categorías)
  - Detección de símbolos por keyword mapping
  - Sentimiento básico (positivo/negativo por palabras clave)
- **lib/anomalyDetector.js**: Detección de anomalías estadísticas
  - Price spike: retorno > 2σ del promedio
  - Volume spike: volumen > 3σ del promedio
  - Volatility spike: rango intradía > 3x del promedio
  - Forward returns: 1h, 1d, 5d después de la anomalía
- **cron/news_pipeline.js**: Pipeline automático cada 15 minutos
  - Paso 1: Fetch noticias RSS → inserta en DB
  - Paso 2: Detecta anomalías en 11 símbolos
  - Paso 3: Correlaciona noticias con anomalías (ventana 6h)
  - Paso 4: Actualiza patrones aprendidos (promedios, win rate)
- **routes/intelligence.js**: 5 endpoints
  - GET /api/intelligence/news?symbol=AAPL&hours=24
  - GET /api/intelligence/anomalies?symbol=AAPL&days=7
  - GET /api/intelligence/patterns?category=earnings
  - GET /api/intelligence/context?symbol=AAPL (resumen completo)
  - POST /api/intelligence/fetch (forzar fetch manual)

### Estado actual
- Pipeline corriendo cada 15 minutos
- Primera noticia detectada: CNBC sobre Trump + CEOs (AAPL, TSLA)
- Endpoints respondiendo correctamente
- Base de datos v3 con tablas de inteligencia inicializada

### Próxima iteración
- FASE 2: Portfolio real con QP analítica (eliminar Monte Carlo)

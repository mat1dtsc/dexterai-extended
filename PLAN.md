# DexterAI Extended — Plan de Implementación

## Objetivo
Extender el monitor de tu amigo con:
1. **Alertas cada 5 minutos** — señales fuertes, cambios bruscos, crossovers
2. **Análisis Markowitz** — frontera eficiente, ponderaciones óptimas por riesgo
3. **Análisis de Betas (CAPM)** — 5 betas, alpha de Jensen, Sharpe ratio, Treynor
4. **Contexto nocturno** — resumen diario con rendimientos logarítmicos
5. **Persistencia** — SQLite para historial de señales y performance

## Stack
- Backend: Node.js + Express (existente)
- Base de datos: SQLite (nuevo)
- Cron: OpenClaw cron jobs
- APIs: Yahoo Finance v8 (datos), investing.com (fallback)
- Matemáticas: implementación manual (sin dependencias pesadas)

## Estructura de archivos
```
dexterai-extended/
├── server.js                    # Servidor principal (extendido)
├── lib/
│   ├── indicators.js            # Indicadores técnicos (del original)
│   ├── portfolio.js             # Markowitz, optimización
│   ├── capm.js                  # Betas, CAPM, alpha, Sharpe
│   ├── alerts.js                # Motor de alertas
│   ├── data.js                  # Fetchers Yahoo/Investing
│   └── db.js                    # SQLite wrapper
├── routes/
│   ├── quote.js                 # Precios en tiempo real
│   ├── analysis.js              # Análisis técnico completo
│   ├── portfolio.js             # Endpoints Markowitz
│   ├── capm.js                  # Endpoints CAPM/betas
│   └── alerts.js                # Configuración de alertas
├── cron/
│   └── alert_checker.js         # Script de alertas cada 5min
├── data/
│   └── dexter.db                # SQLite
├── public/
│   └── index.html               # Frontend extendido
└── package.json
```

## Endpoints nuevos
- `POST /api/portfolio/optimize` — Optimización Markowitz
- `GET /api/capm/betas` — Cálculo de 5 betas para activos
- `GET /api/alerts/check` — Verificar alertas manualmente
- `POST /api/alerts/config` — Configurar umbrales de alertas
- `GET /api/context/daily` — Resumen nocturno

## Activos soportados
Índices: NASDAQ 100, S&P 500, Dow, DAX, FTSE, Nikkei
Commodities: Oro, Petróleo WTI, Petróleo Brent
Forex: EUR/USD, USD/CLP
Crypto: BTC, ETH
A agregar: más commodities, más forex, más índices

## Alertas (cada 5 min)
- Score > 80 (señal fuerte)
- RSI cruzando 30 o 70
- MACD cruzando señal
- Precio tocando banda inferior BB
- Cambio > 2% en 5 minutos
- Volumen anómalo

## Markowitz
- Matriz de covarianza de rendimientos logarítmicos
- Frontera eficiente (calcular para distintos niveles de riesgo)
- Portafolio de mínima varianza
- Portafolio de máximo Sharpe

## CAPM / 5 Betas
- Beta de mercado (regresión vs S&P 500)
- Betas por sector (si tenemos datos)
- Alpha de Jensen
- Sharpe ratio
- Treynor ratio
- Information ratio

## TODO
- [ ] Crear estructura de directorios
- [ ] Implementar lib/db.js (SQLite)
- [ ] Implementar lib/data.js (fetchers mejorados)
- [ ] Implementar lib/portfolio.js (Markowitz)
- [ ] Implementar lib/capm.js (betas, CAPM)
- [ ] Implementar lib/alerts.js (motor de alertas)
- [ ] Extender server.js con nuevas rutas
- [ ] Configurar cron cada 5 minutos
- [ ] Probar todo

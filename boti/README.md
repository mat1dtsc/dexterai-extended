# BOTI - Agent Autónomo de Análisis Financiero
## Sistema de Inversión Multifactorial con Selección Adaptativa de Portafolios

---

### Arquitectura

```
boti/
├── core/
│   ├── data_engine.py      → Descarga de datos + retornos logarítmicos
│   ├── factor_model.py     → Regresión multifactorial + métricas + optimización
│   └── screener.py         → Motor de exploración y ranking
├── portfolios/
│   └── strategies/         → Definición de portafolios evolutivos
├── signals/
│   └── evaluator.py        → Evaluador de señales BUY/SELL/HOLD
├── data/
│   └── cache/              → Datos descargados localmente
└── notebooks/              → Análisis exploratorio
```

### Modelo Multifactorial

**Factores del Sistema:**
- **rm** (`^GSPC`) → Mercado empresarial general (S&P 500)
- **rtech** (`XLK`) → Sector tecnológico (Technology Select Sector)
- **rbond** (`AGG`) → Mercado de renta fija (Aggregate Bond ETF)
- **rvix** (`^VIX`) → Volatilidad implícita (factor de miedo)
- **rdxy** (`DX-Y.NYB`) → Fuerza del dólar

**Regresión para cada activo:**
```
ri = α + βm·rm + βtech·rtech + βbond·rbond + βvix·rvix + ε
```

**Métricas calculadas:**
- Alfa de Jensen (intercepto anualizado)
- Betas de cada factor (sensibilidad)
- Sharpe Ratio
- Sortino Ratio
- Treynor Ratio
- Max Drawdown
- Calmar Ratio
- VaR 95% / 99%
- Information Ratio vs benchmark

### Portafolios Evolutivos

El sistema genera **N portafolios aleatorios** con restricciones de peso máximo, los evalúa con las métricas anteriores y selecciona los mejores según:
1. Sharpe Ratio (primario)
2. Sortino Ratio (riesgo asimétrico)
3. Retorno anualizado ajustado por riesgo

Los portafolios se **rebalancean periódicamente** según su eficiencia relativa.

### Fase de Ejecución

| Fase | Descripción | Autonomía |
|------|-------------|-----------|
| 1. Análisis | Descarga, cálculo de métricas, generación de señales | ✅ Completa |
| 2. Alertas | Notificación de oportunidades detectadas | ✅ Completa |
| 3. Paper Trading | Ejecución simulada en Alpaca (validación) | ✅ Completa |
| 4. Live Trading | Ejecución real con capital | ❌ Requiere confirmación |

---

*Construido con: Python, pandas, statsmodels, yfinance, numpy*

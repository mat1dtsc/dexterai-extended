# AUDITORÍA HONESTA — DexterAI Extended v2.5
## "Funciona" ≠ "Es correcto"

---

## 🔴 PROBLEMAS ESTRUCTURALES (hacen que sea un juguete)

### 1. Markowitz es estadísticamente inválido

**El código:**
```javascript
for (var k = 0; k < 10000; k++) {
  var pesos = [];
  for (var i = 0; i < nActivos; i++) pesos.push(Math.random());
  // normalizar a 1
}
```

**El problema:**
- Con 4 activos y 10,000 simulaciones, estás muestreando 10k puntos en un simplex 3D. La densidad es bajísima.
- Con 10 activos, es un simplex 9D. 10k puntos son gotas en el océano. **Nunca encontrarás el óptimo real.**
- La frontera eficiente se calcula con O(n²) = 100 millones de comparaciones. En JS puro tarda segundos y bloquea el event loop.
- No hay método analítico (Lagrange, quadratic programming). Es Monte Carlo sin convergencia.
- La covarianza usa `sum / n` (máxima verosimilitud) en vez de `sum / (n-1)` (insesgada). Sesgo estadístico.
- **No hay restricción de no-negatividad explícita.** Aunque random da positivos, no es una constraint.
- **No hay target return optimization.** No puedo decir "dame el portfolio con riesgo mínimo para un retorno objetivo del 8%".

**Fix real:** Implementar resolución analítica para 2 activos (fórmula cerrada). Para N>2, usar quadratic programming (oqps.js o similar) en lugar de Monte Carlo a ciegas.

---

### 2. CAPM "5 betas" es fraudulent

**El código dice:** 5 betas (mercado, sector, size, value, momentum)

**La realidad:**
- `betaMercado`: **REAL** — cov(ri,rm)/var(rm) ✓
- `betaSector`: `null` — placeholder. **NO EXISTE.**
- `betaSize`: `media(ri) / desviacion(ri)` — **ESTO NO ES SIZE.** El factor size de Fama-French es SMB (Small Minus Big market cap). Este cálculo es una ratio sin sentido económico.
- `betaValue`: `sum(ri)` — rendimiento acumulado. **ESTO NO ES VALUE.** HML (High Minus Low book-to-market) requiere datos de book-to-market que no tenemos.
- `betaMomentum`: `segundaMitad - primeraMitad`. **ESTO NO ES MOMENTUM.** WML (Winners Minus Losers) requiere ranking de retornos pasados.

**Fix real:** Eliminar los 3 betas falsos o renombrar a "proxy_size", "proxy_value", "proxy_momentum" con disclaimer claro. O implementar factores reales con datos de Fama-French (requiere descargar archivos de Ken French's data library).

---

### 3. Investing.com está muerto

**El problema:**
- La API de investing.com devuelve 401/403 consistentemente.
- El "fix" fue invertir el orden: Yahoo primero, investing fallback.
- Pero Yahoo tampoco funciona para todos los símbolos (algunos ETFs, índices raros).
- **No hay fuente de datos terciaria.** Si Yahoo falla, no hay plan C.
- Sin fallback real, muchos activos devolverán `error: Sin datos`.

**Fix real:** Agregar Alpha Vantage, IEX Cloud, o Polygon.io como fuentes terciarias. O usar la librería `yahoo-finance2` que maneja rate limiting y retries automáticamente.

---

### 4. Alertas en Vercel = imposible

**El problema:**
- `node-cron` requiere un proceso Node.js corriendo 24/7.
- Vercel es **serverless**: las functions se apagan después de cada request.
- Las alertas cada 5 minutos **NUNCA FUNCIONARÁN** en Vercel.
- Solo funcionan en local o en un VPS con proceso persistente.

**Fix real:**
- Opción A: Usar Vercel Cron Jobs (beta, limitado a ciertos tiers)
- Opción B: Migrar a Railway/Render/ECS donde el proceso corre 24/7
- Opción C: Usar un scheduler externo (GitHub Actions cada 5 min, o AWS Lambda con EventBridge)

---

### 5. SQLite en /tmp = data volátil

**El problema:**
- En Vercel, `/tmp/dexter.db` se borra en cada cold start.
- Toda la data de alertas, optimizaciones, historial CAPM se pierde.
- La DB es un adorno, no una persistencia real.

**Fix real:** Migrar a PostgreSQL (Vercel Postgres, Supabase, Neon) o usar Vercel KV para cache. Para MVP simple, al menos usar Prisma + PostgreSQL.

---

### 6. Análisis técnico es un toy

**El problema:**
- RSI, MACD, Bollinger — todo correcto matemáticamente.
- Pero **no detecta divergencias** (RSI bajando mientras precio sube = señal de venta).
- **No calcula Fibonacci retracements** (38.2%, 50%, 61.8%).
- **No hay pattern recognition** (hombro-cabeza-hombro, doble techo, triángulos).
- **El "score de entrada" es una suma arbitraria:** +35, +22, +10... sin backtesting, sin calibración, sin out-of-sample testing. Es una fórmula inventada que se ve bonita pero no está validada.
- **Volumen no se usa.** Solo se muestra el número, no se analiza (volume profile, OBV, volume divergence).

**Fix real:**
- Agregar detección de divergencias RSI/MACD vs precio.
- Agregar cálculo de niveles Fibonacci desde swing highs/lows.
- Backtestear el score con datos históricos: ¿cuántas veces un score >80 realmente precedió una subida?
- Agregar volumen relativo (volumen actual vs SMA de volumen).

---

### 7. Chat IA = chiste sin API key

**El problema:**
- Sin `ANTHROPIC_API_KEY`, el chat devuelve "Analista IA no disponible".
- No hay fallback a un modelo local ni a respuestas predefinidas inteligentes.
- El streaming SSE está bien implementado, pero depende 100% de un servicio externo de pago.

**Fix real:**
- Agregar un modo "offline" con respuestas template basadas en los datos técnicos actuales.
- O integrar un modelo local vía Ollama/Llama.cpp para análisis básico sin costo.

---

### 8. Yahoo Finance v8 es inestable

**El problema:**
- Yahoo bloquea IPs que hacen muchos requests.
- No hay retry logic con exponential backoff.
- No hay rate limiting propio (esperar entre requests).
- Un símbolo que falla hace que todo el batch falle (Promise.all sin manejo granular).

**Fix real:**
- Agregar retry con backoff: intentar 3 veces con delays crecientes.
- Agregar rate limiter: máximo N requests por segundo.
- Usar `Promise.allSettled` en vez de `Promise.all` para que un símbolo no mate todo el batch.

---

### 9. No hay tests unitarios

**El problema:**
- `test_all.js` solo hace HTTP requests. No testea la lógica matemática.
- No hay tests para: calcular RSI a mano y comparar, verificar que la covarianza es simétrica, comprobar que pesos suman 1, etc.
- Un bug en la fórmula de Sharpe podría pasar desapercibido por meses.

**Fix real:**
- Tests con `mocha` o `node:test` para cada función matemática.
- Tests de propiedad: "pesos siempre suman 1", "varianza siempre >= 0", "R² entre 0 y 1".

---

### 10. El frontend miente

**El problema:**
- La tabla CAPM muestra un "score" calculado como: `(sharpe * 50) + (alpha * 100) + 50`.
- Esta fórmula es **arbitraria y sin sentido financiero.** Un alpha de 0.001 da +0.1 al score. Un sharpe de 0.5 da +25. No está calibrado.
- El usuario ve números que parecen profesionales pero son inventados.
- La pestaña "Portfolio" muestra una frontera eficiente que probablemente no está cerca del óptimo real (por el Monte Carlo ineficiente).

**Fix real:**
- Eliminar el score arbitrario. Mostrar Sharpe, Alpha, R² directamente.
- Agregar percentiles: "Este Sharpe está en el top 25% del mercado" (requiere benchmarking contra S&P500).

---

## 🟡 PROBLEMAS MENORES

### 11. No hay logging real
- `console.log` es el único logging. No hay niveles (debug/info/warn/error).
- No hay tracing de requests (request ID, timestamps).

### 12. No hay caching
- Cada request a `/api/data?symbol=NDX` descarga 1 año de datos de Yahoo.
- Con 10 usuarios refrescando cada 30 segundos, estamos haciendo 20 requests/minuto al mismo símbolo.
- Debería cachear por 1-5 minutos en memoria.

### 13. No hay autenticación
- Cualquiera puede acceder a todos los endpoints.
- No hay rate limiting por IP.
- En Vercel, esto es peligroso (Yahoo bloqueará la IP del proyecto).

### 14. Frontend no es responsive
- En móvil, el layout de 3 columnas se rompe.
- El canvas de chart no redimensiona bien en resize.

---

## 🟢 QUÉ ESTÁ BIEN (no todo es malo)

- La arquitectura modular (lib/, routes/, cron/) es limpia.
- El formato de respuesta JSON está bien estructurado.
- El frontend estilo Bloomberg se ve profesional.
- Los cálculos básicos (RSI, MACD, Bollinger) son matemáticamente correctos.
- La separación frontend/backend permite escalar.
- El sistema de alertas tiene lógica razonable (cambio brusco, RSI extremo, MACD cruce).

---

## 📋 HOJA DE RUTA PARA VERSIÓN EJECUTABLE

### Fase 1: Hacer que los datos sean confiables (1-2 días)
1. Agregar `yahoo-finance2` npm package con auto-retry y rate limiting.
2. Eliminar investing.com (está muerto).
3. Agregar cache en memoria con TTL de 2 minutos para quotes.
4. Implementar `Promise.allSettled` en todos los endpoints batch.

### Fase 2: Hacer que el portfolio sea real (2-3 días)
1. Implementar resolución analítica para 2 activos (fórmula cerrada).
2. Para N>2, integrar una librería de quadratic programming (`quadprog-js` o `cvxopt` vía Python microservice).
3. Eliminar el Monte Carlo de 10k simulaciones.
4. Usar covarianza insesgada: `sum / (n-1)`.

### Fase 3: Hacer que CAPM sea honesto (1 día)
1. Renombrar "5 betas" a "1 beta + 3 proxies".
2. Agregar R² para mostrar qué tan bien explica el modelo.
3. Eliminar el score arbitrario de la tabla.

### Fase 4: Hacer que las alertas funcionen en prod (1 día)
1. Migrar de Vercel a Railway/Render (proceso persistente).
2. O usar GitHub Actions como scheduler cada 5 min.

### Fase 5: Hacer que la data persista (1 día)
1. Migrar de SQLite a PostgreSQL (Supabase o Neon tienen tiers gratuitos).
2. O usar Prisma como ORM.

### Fase 6: Hacer que el análisis técnico sea útil (2-3 días)
1. Agregar detección de divergencias RSI/precio.
2. Agregar niveles Fibonacci.
3. Backtestear el score de entrada con datos históricos.
4. Agregar volumen relativo.

### Fase 7: Tests y robustez (1-2 días)
1. Tests unitarios para todas las funciones matemáticas.
2. Rate limiting por IP.
3. Logging estructurado con Winston.
4. Manejo de errores granular (no devolver 500 genérico).

---

## 💭 CONCLUSIÓN

El proyecto es un **excelente MVP visual** que demuestra que sabes cómo conectar piezas. Pero:
- Los cálculos de portfolio son ineficientes y posiblemente incorrectos para N>3.
- Los "5 betas" son marketing, no matemática.
- Las alertas no funcionarán en producción.
- La data se perderá en cada deploy.
- El análisis técnico no tiene validación.

**Es un prototipo en pañales.** Para ser ejecutable como herramienta de inversión real, necesita Fase 1-7 completa.

¿Quieres que empiece con alguna fase específica?

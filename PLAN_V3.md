# PLAN DE EJECUCIÓN — DexterAI Extended v3.0
## Fecha inicio: 2026-05-12
## Auditor agente activo por 2 días

---

## DEADLINE POR FASE

| Fase | Descripción | Deadline | Estado |
|------|-------------|----------|--------|
| **Fase 1** | Datos confiables (yahoo-finance2, retry, cache, allSettled) | **2026-05-14 02:00** (48h) | 🔴 INICIANDO |
| **Fase 2** | Portfolio real (QP analítica N=2, quadprog-js N>2) | 2026-05-16 | ⚪ |
| **Fase 3** | CAPM honesto (1 beta + 3 proxies, eliminar score fake) | 2026-05-17 | ⚪ |
| **Fase 4** | Alertas en prod (Railway/Render o GitHub Actions) | 2026-05-18 | ⚪ |
| **Fase 5** | Persistencia (PostgreSQL Supabase/Neon) | 2026-05-19 | ⚪ |
| **Fase 6** | Análisis útil (divergencias, Fibonacci, backtest) | 2026-05-22 | ⚪ |
| **Fase 7** | Tests + robustez (mocha, rate limit, logging) | 2026-05-24 | ⚪ |

---

## FASE 1 — DATOS CONFIABLES (48h)
### Objetivos concretos
1. ✅ Reemplazar fetcher manual por `yahoo-finance2` (maneja rate limits, retries, cookies)
2. ✅ Implementar retry con exponential backoff (3 intentos: 1s, 2s, 4s)
3. ✅ Implementar cache en memoria con TTL 2 minutos
4. ✅ Reemplazar `Promise.all` por `Promise.allSettled` en endpoints batch
5. ✅ Eliminar investing.com (está muerto, solo genera ruido)
6. ✅ Agregar fallback graceful: símbolo individual falla ≠ todo el batch falla
7. ✅ Validar que todos los símbolos por defecto devuelven datos reales
8. ✅ Documentar qué símbolos funcionan y cuáles no

### Criterios de aceptación
- [ ] `npm test` pasa (nuevo test suite)
- [ ] Todos los símbolos DEFAULT_SYMBOLS devuelven datos con >95% éxito
- [ ] Rate limiter: máximo 5 req/segundo a Yahoo
- [ ] Cache: segundo request al mismo símbolo < 50ms (lee de memoria)
- [ ] Un símbolo que falla no mata el batch entero

---

## AGENTE AUDITOR
- **ID:** auditor-dexter-v3
- **Duración:** 48 horas (hasta 2026-05-14 02:00)
- **Función:** Revisar cada commit, verificar tests, alertar si deadlines no se cumplen
- **Frecuencia:** Revisión cada 4 horas

---

## NOTAS
- Cada fase tiene su propia branch: `fase/1-datos`, `fase/2-portfolio`, etc.
- Merge a `main` solo después de aprobación del auditor
- Commits semánticos: `fase1: yahoo-finance2 integration`, `fase1: add cache TTL`

# data_engine — Pipeline Python

Pipeline de ingesta histórica + features + on-chain. Genera la materia prima para `backtest/` y `ml/`.

## Setup

```powershell
# Si openbb_worker/.venv ya está creado, podés reutilizarlo (incluye yfinance):
.\openbb_worker\.venv\Scripts\Activate.ps1
pip install -r data_engine\requirements.txt

# O crear un venv dedicado:
python -m venv data_engine\.venv
.\data_engine\.venv\Scripts\Activate.ps1
pip install -r data_engine\requirements.txt
```

## Scripts

### `backfill_ohlcv.py` — backfill histórico

Trae OHLCV diario desde 2010 (o fecha que indiques) a la tabla `historico_ohlcv`.

```powershell
# Todas las watchlists (~157 símbolos, ~5 min)
python data_engine\backfill_ohlcv.py --watchlist all

# Solo una watchlist
python data_engine\backfill_ohlcv.py --watchlist "Tech US (Mag7+)"

# Símbolos sueltos
python data_engine\backfill_ohlcv.py --symbols AAPL,MSFT,NVDA --from 2015-01-01
```

Idempotente: si ya hay filas para `(symbol, timestamp, interval)`, las ignora.

**Verificación**:
```powershell
sqlite3 data\dexter.db "SELECT symbol, COUNT(*), MIN(date(timestamp,'unixepoch')), MAX(date(timestamp,'unixepoch')) FROM historico_ohlcv GROUP BY symbol ORDER BY 2 DESC LIMIT 20"
```

### `onchain_btc.py` — colector on-chain Bitcoin

(Fase 4 — próximo paso)

### `features.py` — generador de features ML

(Fase 3 — próximo paso)

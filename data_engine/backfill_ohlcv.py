"""
data_engine/backfill_ohlcv.py
─────────────────────────────
Backfill masivo de OHLCV diario desde 2010 (o fecha especificada) a SQLite.

Lee símbolos de watchlists activas en data/dexter.db o del flag --symbols.
Idempotente: re-correr no duplica datos (UNIQUE en symbol+timestamp+interval).

CLI:
  python data_engine/backfill_ohlcv.py [--watchlist all|<nombre>]
                                       [--from 2010-01-01]
                                       [--symbols AAPL,MSFT,NVDA]
                                       [--throttle 200]
                                       [--interval 1d]
"""
import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "dexter.db"
LOG_PATH = Path(__file__).parent / "backfill.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("backfill")


def resolve_symbols(args, conn):
    """Determina la lista de símbolos a procesar."""
    if args.symbols:
        return [s.strip().upper() for s in args.symbols.split(",") if s.strip()]

    cur = conn.cursor()
    if args.watchlist == "all":
        cur.execute("SELECT simbolos FROM watchlists")
    else:
        cur.execute("SELECT simbolos FROM watchlists WHERE nombre = ?", (args.watchlist,))
    rows = cur.fetchall()
    seen = set()
    out = []
    for row in rows:
        try:
            for s in json.loads(row[0]) or []:
                s = str(s).strip().upper()
                if s and s not in seen:
                    seen.add(s)
                    out.append(s)
        except json.JSONDecodeError:
            continue
    return out


def yahoo_symbol(sym):
    """
    Algunos símbolos en SQLite van sin el caret de Yahoo. yfinance acepta
    tanto 'NDX' como '^NDX'; intentamos primero el original y, si falla,
    con caret para los conocidos.
    """
    caret_alias = {
        "NDX": "^NDX", "GSPC": "^GSPC", "DJI": "^DJI", "GDAXI": "^GDAXI",
        "FTSE": "^FTSE", "N225": "^N225", "VIX": "^VIX", "TNX": "^TNX",
        "FVX": "^FVX", "IRX": "^IRX", "TYX": "^TYX",
    }
    return caret_alias.get(sym, sym)


def fetch_symbol(symbol, start_date, interval):
    """Descarga OHLCV desde Yahoo Finance con auto_adjust=True."""
    ys = yahoo_symbol(symbol)
    try:
        df = yf.download(
            ys,
            start=start_date,
            interval=interval,
            auto_adjust=True,
            progress=False,
            threads=False,
        )
    except Exception as e:
        return None, str(e)

    if df is None or df.empty:
        return None, "respuesta vacia"

    # yfinance >=0.2.40 siempre devuelve MultiIndex aun para 1 ticker
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df.reset_index()
    df.columns = [str(c).lower() for c in df.columns]

    if "date" in df.columns:
        df["timestamp"] = pd.to_datetime(df["date"]).astype("int64") // 10**9
    elif "datetime" in df.columns:
        df["timestamp"] = pd.to_datetime(df["datetime"]).astype("int64") // 10**9
    elif "index" in df.columns:
        df["timestamp"] = pd.to_datetime(df["index"]).astype("int64") // 10**9
    else:
        return None, "sin columna de fecha (cols=" + ",".join(df.columns) + ")"

    needed = ["timestamp", "open", "high", "low", "close", "volume"]
    for col in needed:
        if col not in df.columns:
            return None, "falta columna " + col
    return df[needed], None


def insert_rows(conn, symbol, df, interval, source="yahoo-finance"):
    """Inserta filas con INSERT OR IGNORE (idempotente)."""
    cur = conn.cursor()
    rows = [
        (
            symbol,
            int(r.timestamp),
            float(r.open) if pd.notna(r.open) else None,
            float(r.high) if pd.notna(r.high) else None,
            float(r.low) if pd.notna(r.low) else None,
            float(r.close) if pd.notna(r.close) else None,
            float(r.volume) if pd.notna(r.volume) else 0.0,
            interval,
            source,
        )
        for r in df.itertuples(index=False)
        if pd.notna(r.close)
    ]
    cur.executemany(
        """INSERT OR IGNORE INTO historico_ohlcv
           (symbol, timestamp, open, high, low, close, volume, interval, source)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    inserted = cur.rowcount
    conn.commit()
    return inserted, len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", default="all", help='Nombre de watchlist o "all"')
    ap.add_argument("--symbols", default=None, help="Lista CSV alternativa")
    ap.add_argument("--from", dest="from_date", default="2010-01-01")
    ap.add_argument("--interval", default="1d", choices=["1d", "1wk", "1mo"])
    ap.add_argument("--throttle", type=int, default=200, help="ms entre símbolos")
    args = ap.parse_args()

    if not DB_PATH.exists():
        log.error("DB no encontrada: %s. Arranca el server Node primero para inicializar.", DB_PATH)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    symbols = resolve_symbols(args, conn)
    if not symbols:
        log.error("Sin símbolos para procesar.")
        sys.exit(1)

    log.info("Backfill iniciado -- %d simbolos, desde %s, interval=%s",
             len(symbols), args.from_date, args.interval)

    summary = []
    failures = []
    t0 = time.time()
    for i, sym in enumerate(symbols, 1):
        df, err = fetch_symbol(sym, args.from_date, args.interval)
        if err is not None:
            log.warning("[%d/%d] %s — ERROR: %s", i, len(symbols), sym, err)
            failures.append((sym, err))
        else:
            inserted, total = insert_rows(conn, sym, df, args.interval)
            min_ts = int(df["timestamp"].min())
            max_ts = int(df["timestamp"].max())
            log.info(
                "[%d/%d] %s -- %d filas nuevas / %d totales (%s -> %s)",
                i, len(symbols), sym, inserted, total,
                datetime.utcfromtimestamp(min_ts).strftime("%Y-%m-%d"),
                datetime.utcfromtimestamp(max_ts).strftime("%Y-%m-%d"),
            )
            summary.append((sym, inserted, total, min_ts, max_ts))
        if args.throttle:
            time.sleep(args.throttle / 1000.0)

    elapsed = time.time() - t0
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM historico_ohlcv")
    total_rows = cur.fetchone()[0]

    log.info("-" * 60)
    log.info("BACKFILL TERMINADO en %.1fs", elapsed)
    log.info("Símbolos OK: %d  Fallidos: %d", len(summary), len(failures))
    log.info("Filas totales en historico_ohlcv: %s", f"{total_rows:,}")
    if failures:
        log.info("Fallidos: %s", ", ".join(f"{s} ({e[:40]})" for s, e in failures[:10]))

    conn.close()


if __name__ == "__main__":
    main()

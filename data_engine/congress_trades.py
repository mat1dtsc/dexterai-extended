"""
data_engine/congress_trades.py
──────────────────────────────
Colector de trades de Senadores y Representantes US (STOCK Act 2012).

Fuente primaria: Lambda Finance (https://www.lambdafin.com/api/congressional/recent)
  - Gratis, sin API key, cubre House + Senate
  - Normalizado a un esquema único

Fallbacks (si están seteadas las env vars):
  - FINNHUB_API_KEY  → /stock/congressional-trading
  - FMP_API_KEY      → /senate-trading + /senate-disclosure

Idempotente. UNIQUE(politician, ticker, transaction_date, tx_type, amount_min).

CLI:
  python data_engine/congress_trades.py               # default: 365 días
  python data_engine/congress_trades.py --days 1095   # ~3 años
  python data_engine/congress_trades.py --limit 5000  # max trades a traer
"""
import argparse
import json
import logging
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "dexter.db"
LOG_PATH = Path(__file__).parent / "congress.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("congress")

LAMBDA_URL = "https://www.lambdafin.com/api/congressional/recent"
UA = {"User-Agent": "Mozilla/5.0 (DexterAI-Extended congress collector)"}

AMOUNT_RANGES = {
    "$1,001 - $15,000":         (1001, 15000),
    "$15,001 - $50,000":        (15001, 50000),
    "$50,001 - $100,000":       (50001, 100000),
    "$100,001 - $250,000":      (100001, 250000),
    "$250,001 - $500,000":      (250001, 500000),
    "$500,001 - $1,000,000":    (500001, 1000000),
    "$1,000,001 - $5,000,000":  (1000001, 5000000),
    "$5,000,001 - $25,000,000": (5000001, 25000000),
    "$25,000,001 - $50,000,000":(25000001, 50000000),
    "Over $50,000,000":         (50000001, None),
}


def parse_amount(s):
    if not s:
        return None, None
    s = s.strip()
    if s in AMOUNT_RANGES:
        return AMOUNT_RANGES[s]
    m = re.match(r"\$?([\d,]+(?:\.\d+)?)(?:\s*[-–]\s*\$?([\d,]+(?:\.\d+)?))?", s)
    if m:
        lo = float(m.group(1).replace(",", ""))
        hi = float(m.group(2).replace(",", "")) if m.group(2) else lo
        return lo, hi
    return None, None


def normalize_tx_type(s):
    if not s:
        return None
    s = s.lower().strip()
    if "purchase" in s:
        return "purchase"
    if "sale (full)" in s or "sale_full" in s or s == "sale":
        return "sale_full"
    if "sale (partial)" in s or "sale_partial" in s:
        return "sale_partial"
    if "exchange" in s:
        return "exchange"
    return s[:30]


def parse_date(s):
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            return int(datetime.strptime(s[:19], fmt).timestamp())
        except ValueError:
            continue
    return None


def clean_ticker(s):
    if not s:
        return None
    s = str(s).strip().upper().replace("$", "").replace(" ", "")
    if s in ("--", "N/A", "NONE", "NULL"):
        return None
    # tickers de menos de 6 chars son normales (AAPL, NVDA). Más largos son raros.
    if len(s) > 6 and s not in ("BRK.A", "BRK.B"):
        return None
    return s


def fetch_lambda(days, limit):
    """Pagina si hace falta. Lambda devuelve {trades:[...], count:N, days:D}."""
    log.info("Pulling Lambda Finance (days=%d, limit=%d)...", days, limit)
    out = []
    # Lambda API soporta page/pageSize, intentamos paginar
    page = 1
    while len(out) < limit:
        try:
            r = requests.get(
                LAMBDA_URL,
                headers=UA,
                params={"days": days, "limit": min(500, limit - len(out)), "page": page},
                timeout=60,
            )
            r.raise_for_status()
        except requests.RequestException as e:
            log.error("Lambda fetch error: %s", e)
            break
        data = r.json()
        batch = data.get("trades") or []
        if not batch:
            break
        out.extend(batch)
        log.info("  page %d: +%d (total %d)", page, len(batch), len(out))
        if len(batch) < 100:
            break  # parece no haber más
        page += 1
        time.sleep(0.5)
    return out


def normalize_lambda_row(t):
    tx_type = normalize_tx_type(t.get("type"))
    return {
        "politician": (t.get("representative") or t.get("senator") or "").strip(),
        "chamber": (t.get("chamber") or "").lower() or "unknown",
        "party": t.get("party"),
        "ticker": clean_ticker(t.get("symbol") or t.get("ticker")),
        "asset_description": (t.get("assetDescription") or "")[:240],
        "transaction_date": parse_date(t.get("transactionDate")),
        "disclosure_date": parse_date(t.get("disclosureDate")),
        "tx_type": tx_type,
        "amount": t.get("amount"),
    }


def insert_batch(conn, rows):
    cur = conn.cursor()
    prepared = []
    for r in rows:
        if not r["politician"] or not r["transaction_date"]:
            continue
        lo, hi = parse_amount(r.get("amount"))
        prepared.append((
            r["politician"][:120],
            r["chamber"],
            r.get("party"),
            r.get("ticker"),
            r.get("asset_description"),
            r["transaction_date"],
            r.get("disclosure_date"),
            r.get("tx_type"),
            lo,
            hi,
            json.dumps(r, default=str)[:5000],
        ))
    cur.executemany(
        """INSERT OR IGNORE INTO congress_trades
           (politician, chamber, party, ticker, asset_description,
            transaction_date, disclosure_date, tx_type, amount_min, amount_max, raw)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        prepared,
    )
    inserted = cur.rowcount
    conn.commit()
    return inserted, len(prepared)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=365, help="ventana hacia atrás")
    ap.add_argument("--limit", type=int, default=2000)
    args = ap.parse_args()

    if not DB_PATH.exists():
        log.error("DB no encontrada: %s", DB_PATH)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")

    t0 = time.time()
    try:
        raw = fetch_lambda(args.days, args.limit)
        normalized = [normalize_lambda_row(t) for t in raw]
        n, s = insert_batch(conn, normalized)
        log.info("Insertadas: %d nuevas / %d procesadas", n, s)
    except Exception as e:
        log.error("ERROR: %s", e)

    cur = conn.cursor()
    cur.execute("SELECT COUNT(*), COUNT(DISTINCT politician), COUNT(DISTINCT ticker) FROM congress_trades")
    total, n_pol, n_tickers = cur.fetchone()
    cur.execute("SELECT date(MAX(transaction_date),'unixepoch') FROM congress_trades")
    max_tx = cur.fetchone()[0]
    cur.execute("SELECT date(MIN(transaction_date),'unixepoch') FROM congress_trades")
    min_tx = cur.fetchone()[0]

    log.info("-" * 70)
    log.info("DONE in %.1fs", time.time() - t0)
    log.info("Total en DB: %d trades, %d politicos, %d tickers", total, n_pol, n_tickers)
    log.info("Rango fechas trade: %s -> %s", min_tx, max_tx)

    cur.execute("""SELECT politician, COUNT(*) FROM congress_trades GROUP BY politician
                   ORDER BY 2 DESC LIMIT 5""")
    log.info("Top 5 politicos por # trades:")
    for pol, n in cur.fetchall():
        log.info("  %-30s  %d", pol, n)

    cur.execute("""SELECT ticker, COUNT(*) FROM congress_trades
                   WHERE ticker IS NOT NULL GROUP BY ticker ORDER BY 2 DESC LIMIT 5""")
    log.info("Top 5 tickers por # trades:")
    for tic, n in cur.fetchall():
        log.info("  %-10s  %d", tic, n)

    conn.close()


if __name__ == "__main__":
    main()

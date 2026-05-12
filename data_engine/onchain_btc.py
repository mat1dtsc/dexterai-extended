"""
data_engine/onchain_btc.py
──────────────────────────
Colector de métricas on-chain Bitcoin desde fuentes GRATUITAS:

  - Blockchain.com  (sin auth)  → series históricas: hash rate, difficulty,
                                   active addresses, transactions, market cap, etc.
  - mempool.space   (sin auth)  → mempool actual, blocks recientes, fee stats
  - Bitquery        (free tier, requiere BITQUERY_API_KEY) → whale txs (BTC > 100)

Idempotente: PRIMARY KEY (metric, ts) y txid evitan duplicados.

CLI:
  python data_engine/onchain_btc.py                   # todas las métricas
  python data_engine/onchain_btc.py --metrics hash-rate,difficulty
  python data_engine/onchain_btc.py --whales-only     # solo whale txs
  python data_engine/onchain_btc.py --backfill-years 5
"""
import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "dexter.db"
LOG_PATH = Path(__file__).parent / "onchain_btc.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("onchain")

# Métricas de Blockchain.com Charts API
BLOCKCHAIN_METRICS = {
    "hash_rate":              "hash-rate",                       # TH/s
    "difficulty":             "difficulty",
    "n_transactions":         "n-transactions",
    "n_unique_addresses":     "n-unique-addresses",              # active addresses
    "mempool_size":           "mempool-size",                    # bytes
    "estimated_tx_volume_usd":"estimated-transaction-volume-usd",
    "market_cap":             "market-cap",
    "miners_revenue":         "miners-revenue",
    "avg_block_size":         "avg-block-size",
    "median_confirm_time":    "median-confirmation-time",
}

BLOCKCHAIN_BASE = "https://api.blockchain.info/charts"

UA = {"User-Agent": "DexterAI-Extended/1.0 (onchain collector)"}


def fetch_blockchain_metric(metric_slug, timespan="all"):
    """
    GET https://api.blockchain.info/charts/{metric}?format=json&timespan=all
    Devuelve [{x: epoch_seconds, y: value}, ...]
    """
    url = f"{BLOCKCHAIN_BASE}/{metric_slug}?format=json&timespan={timespan}"
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    data = r.json()
    values = data.get("values", [])
    return [(int(p["x"]), float(p["y"])) for p in values if p.get("y") is not None]


def insert_metric_series(conn, metric_name, points, source="blockchain.com"):
    """INSERT OR IGNORE en btc_onchain_metrics."""
    cur = conn.cursor()
    cur.executemany(
        "INSERT OR IGNORE INTO btc_onchain_metrics (metric, ts, value, source) VALUES (?,?,?,?)",
        [(metric_name, ts, val, source) for ts, val in points],
    )
    inserted = cur.rowcount
    conn.commit()
    return inserted


def fetch_mempool_snapshot():
    """Snapshot actual del mempool: tx count, vsize, fee mediana."""
    try:
        r = requests.get("https://mempool.space/api/v1/fees/mempool-blocks", headers=UA, timeout=15)
        r.raise_for_status()
        blocks = r.json()
        if not blocks:
            return None
        total_vsize = sum(b.get("blockVSize", 0) for b in blocks)
        total_count = sum(b.get("nTx", 0) for b in blocks)
        median_fee = blocks[0].get("medianFee") if blocks else None
        return {
            "mempool_vsize_now": total_vsize,
            "mempool_tx_count_now": total_count,
            "mempool_median_fee_now": median_fee,
        }
    except Exception as e:
        log.warning("mempool snapshot fallo: %s", e)
        return None


def fetch_mempool_recent_blocks():
    """Últimos 15 blocks con sus stats."""
    try:
        r = requests.get("https://mempool.space/api/v1/blocks", headers=UA, timeout=15)
        r.raise_for_status()
        return r.json()[:15]
    except Exception as e:
        log.warning("mempool blocks fallo: %s", e)
        return []


def fetch_bitquery_whales(api_key, min_btc=100, hours_back=24):
    """
    Whale txs de las últimas N horas via Bitquery GraphQL.
    Requiere registro gratis en https://bitquery.io para obtener API key.
    Free tier: 10k puntos/mes.
    """
    if not api_key:
        log.info("BITQUERY_API_KEY no seteada -- saltando whale txs")
        return []

    query = """
    query ($min: Float!, $since: ISO8601DateTime) {
      bitcoin(network: bitcoin) {
        outputs(
          options: {limit: 100, desc: "block.timestamp.time"}
          time: {since: $since}
          value: {gt: $min}
        ) {
          transaction { hash }
          value
          value_usd: value(in: USD)
          block { timestamp { time(format: "%Y-%m-%dT%H:%M:%SZ") } }
          outputAddress { address annotation }
        }
      }
    }
    """
    since_iso = datetime.now(timezone.utc).isoformat()
    # Para 'since' necesitamos hours_back atrás
    from datetime import timedelta
    since = (datetime.now(timezone.utc) - timedelta(hours=hours_back)).isoformat()

    try:
        r = requests.post(
            "https://graphql.bitquery.io",
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            json={"query": query, "variables": {"min": min_btc, "since": since}},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        outs = (data.get("data") or {}).get("bitcoin", {}).get("outputs", []) or []
        return outs
    except Exception as e:
        log.warning("Bitquery fallo: %s", e)
        return []


EXCHANGE_LABELS = {
    "binance", "coinbase", "kraken", "bitfinex", "huobi", "bitstamp", "okx",
    "gemini", "ftx", "bittrex", "kucoin", "gate.io",
}


def label_address(annotation):
    if not annotation:
        return "unknown"
    a = annotation.lower()
    for ex in EXCHANGE_LABELS:
        if ex in a:
            return f"exchange:{ex}"
    return a[:60]


def insert_whales(conn, outputs):
    cur = conn.cursor()
    rows = []
    for o in outputs:
        tx = o.get("transaction", {})
        block = o.get("block", {}).get("timestamp", {})
        addr = o.get("outputAddress", {})
        if not tx.get("hash") or not block.get("time"):
            continue
        ts_iso = block["time"]
        try:
            ts = int(datetime.strptime(ts_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
        label = label_address(addr.get("annotation", ""))
        direction = "to_exchange" if label.startswith("exchange:") else "wallet"
        rows.append((
            tx["hash"],
            ts,
            float(o.get("value", 0)),
            float(o.get("value_usd", 0) or 0),
            "unknown",
            label,
            direction,
            json.dumps(o),
        ))
    if not rows:
        return 0
    cur.executemany(
        "INSERT OR IGNORE INTO btc_whale_txs (txid, ts, btc_amount, usd_value, from_label, to_label, direction, raw) VALUES (?,?,?,?,?,?,?,?)",
        rows,
    )
    inserted = cur.rowcount
    conn.commit()
    return inserted


def compute_derived(conn):
    """
    Calcula métricas derivadas a partir de las raw:
      - mvrv_proxy: market_cap / estimated_tx_volume_usd_30d (proxy crudo)
      - active_addr_momentum: SMA7 / SMA30
    Las guarda con source='derived'.
    """
    cur = conn.cursor()
    # mvrv_proxy diario
    cur.execute("""
        SELECT mc.ts, mc.value, COALESCE(v.value, 0) as vol
        FROM btc_onchain_metrics mc
        LEFT JOIN btc_onchain_metrics v
          ON v.metric='estimated_tx_volume_usd' AND v.ts=mc.ts
        WHERE mc.metric='market_cap'
        ORDER BY mc.ts
    """)
    rows = cur.fetchall()
    inserted = 0
    derived_rows = []
    for ts, mc, vol in rows:
        if vol > 0:
            mvrv = float(mc) / float(vol)
            if 0 < mvrv < 1000:
                derived_rows.append(("mvrv_proxy", ts, mvrv, "derived"))
    if derived_rows:
        cur.executemany(
            "INSERT OR IGNORE INTO btc_onchain_metrics (metric, ts, value, source) VALUES (?,?,?,?)",
            derived_rows,
        )
        inserted += cur.rowcount

    # active_addr_momentum: ratio MA7 / MA30 sobre n_unique_addresses
    cur.execute("SELECT ts, value FROM btc_onchain_metrics WHERE metric='n_unique_addresses' ORDER BY ts")
    series = cur.fetchall()
    if len(series) > 30:
        import statistics
        deriv = []
        for i in range(30, len(series)):
            window7 = [v for _, v in series[i - 7:i + 1]]
            window30 = [v for _, v in series[i - 30:i + 1]]
            ma7 = statistics.mean(window7)
            ma30 = statistics.mean(window30)
            if ma30 > 0:
                deriv.append(("active_addr_momentum", series[i][0], ma7 / ma30, "derived"))
        if deriv:
            cur.executemany(
                "INSERT OR IGNORE INTO btc_onchain_metrics (metric, ts, value, source) VALUES (?,?,?,?)",
                deriv,
            )
            inserted += cur.rowcount

    conn.commit()
    return inserted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metrics", default="all", help='CSV o "all"')
    ap.add_argument("--whales-only", action="store_true")
    ap.add_argument("--whale-min-btc", type=float, default=100)
    ap.add_argument("--whale-hours", type=int, default=24)
    ap.add_argument("--no-derived", action="store_true")
    args = ap.parse_args()

    if not DB_PATH.exists():
        log.error("DB no encontrada: %s", DB_PATH)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")

    t0 = time.time()

    # 1. Series históricas
    if not args.whales_only:
        which = list(BLOCKCHAIN_METRICS.keys()) if args.metrics == "all" else args.metrics.split(",")
        log.info("Pulling %d blockchain.com metrics...", len(which))
        for name in which:
            slug = BLOCKCHAIN_METRICS.get(name)
            if not slug:
                log.warning("Metric desconocida: %s", name)
                continue
            try:
                points = fetch_blockchain_metric(slug, timespan="all")
                if not points:
                    log.warning("  %s: 0 puntos", name)
                    continue
                inserted = insert_metric_series(conn, name, points)
                log.info("  %s: %d nuevos / %d totales (last=%s)",
                         name, inserted, len(points),
                         datetime.utcfromtimestamp(points[-1][0]).strftime("%Y-%m-%d"))
                time.sleep(0.5)  # ser amables con Blockchain.com
            except Exception as e:
                log.error("  %s FALLO: %s", name, e)

        # Mempool snapshot (estado actual, no histórico)
        snap = fetch_mempool_snapshot()
        if snap:
            now_ts = int(time.time())
            for k, v in snap.items():
                if v is not None:
                    conn.execute(
                        "INSERT OR IGNORE INTO btc_onchain_metrics (metric, ts, value, source) VALUES (?,?,?,?)",
                        (k, now_ts, float(v), "mempool.space"),
                    )
            conn.commit()
            log.info("Mempool snapshot guardado: %s", snap)

    # 2. Whale transactions
    bk_key = os.environ.get("BITQUERY_API_KEY", "").strip()
    whales = fetch_bitquery_whales(bk_key, args.whale_min_btc, args.whale_hours)
    if whales:
        n = insert_whales(conn, whales)
        log.info("Whale txs: %d nuevas guardadas (umbral %s BTC, %dh)", n, args.whale_min_btc, args.whale_hours)
    else:
        log.info("Whale txs: 0 (sin API key o sin txs en ventana)")

    # 3. Derivadas
    if not args.no_derived:
        d = compute_derived(conn)
        log.info("Métricas derivadas: %d filas calculadas (mvrv_proxy, active_addr_momentum)", d)

    # Resumen final
    cur = conn.cursor()
    cur.execute("SELECT metric, COUNT(*), date(MIN(ts),'unixepoch'), date(MAX(ts),'unixepoch') FROM btc_onchain_metrics GROUP BY metric")
    log.info("-" * 70)
    log.info("ESTADO btc_onchain_metrics:")
    for row in cur.fetchall():
        log.info("  %-30s %6d puntos  %s -> %s", row[0], row[1], row[2], row[3])

    cur.execute("SELECT COUNT(*) FROM btc_whale_txs")
    log.info("btc_whale_txs total: %d", cur.fetchone()[0])
    log.info("Duration: %.1fs", time.time() - t0)

    conn.close()


if __name__ == "__main__":
    main()

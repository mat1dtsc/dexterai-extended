"""
backtest/run.py
───────────────
Runner principal del backtester. Aplica una estrategia a uno o varios símbolos
usando vectorbt y persiste métricas + reporte HTML.

CLI:
  python backtest/run.py --symbol AAPL --strategy current_rules --from 2010-01-01
  python backtest/run.py --watchlist "Tech US (Mag7+)" --strategy current_rules
  python backtest/run.py --watchlist all --strategy current_rules --no-html
"""
import argparse
import importlib
import json
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
import vectorbt as vbt

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "dexter.db"
REPORTS_DIR = Path(__file__).parent / "reports"
REPORTS_DIR.mkdir(exist_ok=True)


def load_ohlcv(conn, symbol, start_date=None):
    sql = "SELECT timestamp, open, high, low, close, volume FROM historico_ohlcv WHERE symbol = ?"
    params = [symbol]
    if start_date:
        ts = int(pd.Timestamp(start_date).timestamp())
        sql += " AND timestamp >= ?"
        params.append(ts)
    sql += " ORDER BY timestamp"
    df = pd.read_sql(sql, conn, params=params)
    if df.empty:
        return None
    df.index = pd.to_datetime(df["timestamp"], unit="s")
    df.index.name = None
    return df[["open", "high", "low", "close", "volume"]]


def load_strategy(name):
    return importlib.import_module(f"strategies.{name}")


def resolve_symbols(conn, args):
    if args.symbol:
        return [args.symbol.strip().upper()]
    if args.symbols:
        return [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    cur = conn.cursor()
    if args.watchlist == "all":
        cur.execute("SELECT DISTINCT simbolos FROM watchlists")
    else:
        cur.execute("SELECT simbolos FROM watchlists WHERE nombre = ?", (args.watchlist,))
    out, seen = [], set()
    for row in cur.fetchall():
        try:
            for s in json.loads(row[0] or "[]"):
                s = str(s).strip().upper()
                if s and s not in seen:
                    seen.add(s)
                    out.append(s)
        except json.JSONDecodeError:
            continue
    return out


def run_single(symbol, df, strategy_mod, capital, fee_pct=0.0005):
    """Ejecuta el backtest para un símbolo. Devuelve dict de métricas."""
    sigs = strategy_mod.generate_signals(df)

    close = df["close"]

    # Long-only: usa entries_long para abrir y exits_long para cerrar
    pf_long = vbt.Portfolio.from_signals(
        close,
        entries=sigs["entries_long"],
        exits=sigs["exits_long"],
        init_cash=capital,
        fees=fee_pct,
        freq="1D",
    )

    # Short-only (separada para comparar)
    pf_short = vbt.Portfolio.from_signals(
        close,
        entries=sigs["entries_short"],
        exits=sigs["exits_short"],
        direction="shortonly",
        init_cash=capital,
        fees=fee_pct,
        freq="1D",
    )

    # Buy & hold benchmark
    bh_returns = close.pct_change().dropna()
    bh_total = float(close.iloc[-1] / close.iloc[0] - 1.0)
    bh_sharpe = float(bh_returns.mean() / bh_returns.std() * (252 ** 0.5)) if bh_returns.std() > 0 else 0.0
    bh_max_dd = float(((close / close.cummax()) - 1).min())

    def metrics_of(pf, label):
        try:
            return {
                "label": label,
                "total_return": float(pf.total_return()),
                "sharpe": float(pf.sharpe_ratio()),
                "sortino": float(pf.sortino_ratio()),
                "max_drawdown": float(pf.max_drawdown()),
                "win_rate": float(pf.trades.win_rate()) if pf.trades.count() > 0 else None,
                "profit_factor": float(pf.trades.profit_factor()) if pf.trades.count() > 0 else None,
                "n_trades": int(pf.trades.count()),
                "expectancy": float(pf.trades.expectancy()) if pf.trades.count() > 0 else None,
            }
        except Exception as e:
            return {"label": label, "error": str(e)}

    return {
        "symbol": symbol,
        "n_bars": len(df),
        "date_start": df.index[0].strftime("%Y-%m-%d"),
        "date_end": df.index[-1].strftime("%Y-%m-%d"),
        "long": metrics_of(pf_long, "long"),
        "short": metrics_of(pf_short, "short"),
        "buy_and_hold": {
            "total_return": bh_total,
            "sharpe": bh_sharpe,
            "max_drawdown": bh_max_dd,
        },
        "signals": sigs["info"],
        "_pf_long": pf_long,  # solo para reporte HTML
    }


def persist_run(conn, symbol, strategy_name, params, metrics):
    """Guarda en tabla backtest_runs (la crea si no existe)."""
    conn.execute(
        """CREATE TABLE IF NOT EXISTS backtest_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL,
            strategy TEXT NOT NULL,
            params_json TEXT,
            metrics_json TEXT,
            ts INTEGER DEFAULT (strftime('%s','now'))
        )"""
    )
    conn.execute(
        "INSERT INTO backtest_runs (symbol, strategy, params_json, metrics_json) VALUES (?,?,?,?)",
        (symbol, strategy_name, json.dumps(params or {}), json.dumps(metrics, default=str)),
    )
    conn.commit()


def generate_html_report(symbol, strategy_name, result, out_path):
    """Reporte HTML mínimo con tabla de métricas + plot embebido."""
    pf = result.pop("_pf_long", None)
    plot_html = ""
    if pf is not None:
        try:
            fig = pf.plot()
            plot_html = fig.to_html(include_plotlyjs="cdn", full_html=False)
        except Exception as e:
            plot_html = f"<p style='color:#f55'>Error generando plot: {e}</p>"

    def fmt(v):
        if v is None:
            return "-"
        if isinstance(v, float):
            return f"{v:.4f}"
        return str(v)

    rows = []
    for section in ["long", "short", "buy_and_hold"]:
        m = result[section]
        rows.append(
            f"<tr><th>{section}</th>"
            + "".join(f"<td>{fmt(m.get(k))}</td>" for k in
                      ["total_return", "sharpe", "sortino", "max_drawdown", "win_rate", "n_trades"])
            + "</tr>"
        )

    html = f"""<!DOCTYPE html>
<html><head><meta charset='utf-8'><title>Backtest {symbol} / {strategy_name}</title>
<style>
body {{ font-family: 'Consolas', monospace; background:#0a0a0e; color:#ddd; padding:20px; }}
h1 {{ color:#4a9eff; }}
h2 {{ color:#ffd700; border-bottom:1px solid #333; padding-bottom:4px; }}
table {{ border-collapse:collapse; width:100%; margin:12px 0; }}
th, td {{ padding:8px 12px; border:1px solid #333; text-align:right; }}
th:first-child {{ text-align:left; color:#4a9eff; }}
thead th {{ background:#161620; color:#aaa; }}
.meta {{ color:#888; font-size:12px; }}
</style></head><body>
<h1>{symbol} — {strategy_name}</h1>
<div class='meta'>Periodo: {result['date_start']} a {result['date_end']} | {result['n_bars']} barras |
Señales: LONG={result['signals']['long_signals']} SHORT={result['signals']['short_signals']} |
RSI actual: {result['signals'].get('rsi_last',0):.1f}</div>

<h2>Resultados</h2>
<table>
<thead><tr><th>Modo</th><th>Total Return</th><th>Sharpe</th><th>Sortino</th><th>Max DD</th><th>Win Rate</th><th>Trades</th></tr></thead>
<tbody>{''.join(rows)}</tbody>
</table>

<h2>Curva del long</h2>
{plot_html}
</body></html>"""
    out_path.write_text(html, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--symbols", default=None, help="CSV de símbolos")
    ap.add_argument("--watchlist", default=None)
    ap.add_argument("--strategy", default="current_rules")
    ap.add_argument("--from", dest="from_date", default="2010-01-01")
    ap.add_argument("--capital", type=float, default=10000)
    ap.add_argument("--fee", type=float, default=0.0005, help="Comisión por trade")
    ap.add_argument("--no-html", action="store_true", help="Saltar reporte HTML")
    args = ap.parse_args()

    if not DB_PATH.exists():
        print(f"DB no encontrada: {DB_PATH}")
        sys.exit(1)

    # Permitir import relativo de strategies.*
    sys.path.insert(0, str(Path(__file__).parent))

    conn = sqlite3.connect(str(DB_PATH))
    symbols = resolve_symbols(conn, args)
    if not symbols:
        print("Sin simbolos para procesar")
        sys.exit(1)

    strategy = load_strategy(args.strategy)
    print(f"Backtest: estrategia='{args.strategy}' simbolos={len(symbols)} from={args.from_date}")

    summary = []
    t0 = time.time()
    for i, sym in enumerate(symbols, 1):
        df = load_ohlcv(conn, sym, args.from_date)
        if df is None or len(df) < 200:
            print(f"[{i}/{len(symbols)}] {sym} -- saltado (sin datos suficientes)")
            continue
        try:
            res = run_single(sym, df, strategy, args.capital, args.fee)
        except Exception as e:
            print(f"[{i}/{len(symbols)}] {sym} -- ERROR {e}")
            continue

        # Print resumen
        L = res["long"]
        BH = res["buy_and_hold"]
        print(f"[{i}/{len(symbols)}] {sym}: long_ret={L.get('total_return',0):+.3f} "
              f"sharpe={L.get('sharpe',0):+.2f} "
              f"trades={L.get('n_trades',0)} | "
              f"BH_ret={BH['total_return']:+.3f} BH_sharpe={BH['sharpe']:+.2f}")

        summary.append({
            "symbol": sym,
            "strat_return": L.get("total_return"),
            "strat_sharpe": L.get("sharpe"),
            "strat_trades": L.get("n_trades"),
            "bh_return": BH["total_return"],
            "bh_sharpe": BH["sharpe"],
        })

        persist_run(conn, sym, args.strategy,
                    {"from": args.from_date, "fee": args.fee, "capital": args.capital},
                    {k: v for k, v in res.items() if k != "_pf_long"})

        if not args.no_html and len(symbols) <= 30:
            out = REPORTS_DIR / f"{sym}_{args.strategy}.html"
            try:
                generate_html_report(sym, args.strategy, res, out)
            except Exception as e:
                print(f"  HTML fallo para {sym}: {e}")

    elapsed = time.time() - t0
    print(f"\n--- BACKTEST TERMINADO en {elapsed:.1f}s ---")
    print(f"Simbolos: {len(summary)} / {len(symbols)}")
    if summary:
        df_sum = pd.DataFrame(summary).sort_values("strat_sharpe", ascending=False)
        print("\nTop 10 por Sharpe estrategia:")
        print(df_sum.head(10).to_string(index=False))
        print("\nBottom 5:")
        print(df_sum.tail(5).to_string(index=False))

        # Resumen agregado
        wins_over_bh = sum(1 for r in summary
                           if r["strat_sharpe"] is not None and r["bh_sharpe"] is not None
                           and r["strat_sharpe"] > r["bh_sharpe"])
        print(f"\nEstrategia bate a buy&hold (por Sharpe) en {wins_over_bh}/{len(summary)} simbolos.")

    conn.close()


if __name__ == "__main__":
    main()

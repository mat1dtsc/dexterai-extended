"""
ml/train.py
───────────
Entrena 4 modelos por símbolo con walk-forward validation, compara, persiste
el ganador en ml/models/<symbol>.joblib + métricas en ml/metrics/<symbol>.json.

Modelos:
  1. LightGBM
  2. RandomForest (sklearn)
  3. LogisticRegression (sklearn) con StandardScaler
  4. Baseline lineal: predicción = sign(ret_20)

CLI:
  python ml/train.py --symbol AAPL [--target up_5d] [--models all]
  python ml/train.py --watchlist "Crypto Top"
"""
import argparse
import json
import sqlite3
import sys
import time
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from sklearn.preprocessing import StandardScaler

import lightgbm as lgb

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from data_engine.features import build_features

DB_PATH = ROOT / "data" / "dexter.db"
MODELS_DIR = Path(__file__).parent / "models"
METRICS_DIR = Path(__file__).parent / "metrics"
MODELS_DIR.mkdir(exist_ok=True)
METRICS_DIR.mkdir(exist_ok=True)

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)


def walk_forward_eval(X, y, train_size=504, test_size=63, step=63):
    """
    Genera tuples (X_train, y_train, X_test, y_test) por ventana.
    train_size ~2 años, test ~3 meses, step ~3 meses.
    """
    n = len(X)
    start = 0
    while start + train_size + test_size <= n:
        end_train = start + train_size
        end_test = end_train + test_size
        yield (
            X.iloc[start:end_train],
            y.iloc[start:end_train],
            X.iloc[end_train:end_test],
            y.iloc[end_train:end_test],
        )
        start += step


def sharpe_of_strategy(y_proba, y_true, returns_5d, threshold=0.55):
    """
    Sharpe de una estrategia que va long cuando proba > threshold.
    """
    signal = (y_proba >= threshold).astype(int)
    pnl = signal * returns_5d
    if pnl.std() == 0:
        return 0.0
    return float(pnl.mean() / pnl.std() * np.sqrt(50))  # ~5d period * 50 windows ≈ year


def train_lightgbm(X_train, y_train, X_test, y_test):
    train_set = lgb.Dataset(X_train, label=y_train)
    val_set = lgb.Dataset(X_test, label=y_test, reference=train_set)
    params = {
        "objective": "binary",
        "metric": "auc",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 20,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "verbose": -1,
    }
    model = lgb.train(
        params, train_set, num_boost_round=500,
        valid_sets=[val_set], callbacks=[lgb.early_stopping(30, verbose=False)],
    )
    proba = model.predict(X_test, num_iteration=model.best_iteration)
    return model, proba


def train_rf(X_train, y_train, X_test, y_test):
    model = RandomForestClassifier(n_estimators=200, max_depth=8, n_jobs=-1, random_state=42, class_weight="balanced")
    model.fit(X_train, y_train)
    proba = model.predict_proba(X_test)[:, 1]
    return model, proba


def train_lr(X_train, y_train, X_test, y_test):
    scaler = StandardScaler()
    Xtr = scaler.fit_transform(X_train)
    Xte = scaler.transform(X_test)
    model = LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced", solver="lbfgs")
    model.fit(Xtr, y_train)
    proba = model.predict_proba(Xte)[:, 1]
    return (model, scaler), proba


def linear_baseline(X_test, returns_lookback):
    """Predicción = sigmoide del retorno medio rolling 20. Sin entrenamiento real."""
    if "ret_20" not in X_test.columns:
        return np.full(len(X_test), 0.5)
    r = X_test["ret_20"].values
    return 1 / (1 + np.exp(-10 * r))  # sigmoide escalada


def compute_metrics(y_true, proba, returns_5d):
    pred = (proba >= 0.5).astype(int)
    out = {
        "accuracy": float(accuracy_score(y_true, pred)),
        "auc": float(roc_auc_score(y_true, proba)) if y_true.nunique() == 2 else None,
        "precision": float(precision_score(y_true, pred, zero_division=0)),
        "recall": float(recall_score(y_true, pred, zero_division=0)),
        "sharpe_strategy_55": sharpe_of_strategy(proba, y_true, returns_5d, threshold=0.55),
        "sharpe_strategy_60": sharpe_of_strategy(proba, y_true, returns_5d, threshold=0.60),
        "signal_rate_55": float((proba >= 0.55).mean()),
    }
    return out


def train_symbol(symbol, target="up_5d", models_to_train=("lgb", "rf", "lr", "linear")):
    print(f"\n=== Training {symbol} target={target} ===")
    df = build_features(symbol, target=target)
    if df is None or len(df) < 700:
        print(f"  Skipped: insufficient data ({len(df) if df is not None else 0} rows)")
        return None

    feature_cols = [c for c in df.columns if c != "target"]
    X = df[feature_cols]
    y = df["target"].astype(int)

    # Para sharpe necesitamos los retornos a 5d - los calculamos del feature 'ret_5'
    # (proxy: si tenemos ret_5 ya en features, OK; sino calcular desde close)
    returns_5d = X["ret_5"] if "ret_5" in X.columns else pd.Series(0, index=X.index)

    # Walk-forward
    aggregate = {m: [] for m in models_to_train}
    best_models = {}
    n_windows = 0

    for X_train, y_train, X_test, y_test in walk_forward_eval(X, y):
        n_windows += 1
        ret_test = returns_5d.loc[X_test.index]

        if "lgb" in models_to_train:
            try:
                model, proba = train_lightgbm(X_train, y_train, X_test, y_test)
                aggregate["lgb"].append((y_test.values, proba, ret_test.values))
                best_models["lgb"] = model
            except Exception as e:
                print(f"  lgb failed window {n_windows}: {e}")

        if "rf" in models_to_train:
            try:
                model, proba = train_rf(X_train, y_train, X_test, y_test)
                aggregate["rf"].append((y_test.values, proba, ret_test.values))
                best_models["rf"] = model
            except Exception as e:
                print(f"  rf failed window {n_windows}: {e}")

        if "lr" in models_to_train:
            try:
                model_scaler, proba = train_lr(X_train, y_train, X_test, y_test)
                aggregate["lr"].append((y_test.values, proba, ret_test.values))
                best_models["lr"] = model_scaler
            except Exception as e:
                print(f"  lr failed window {n_windows}: {e}")

        if "linear" in models_to_train:
            proba = linear_baseline(X_test, returns_5d)
            aggregate["linear"].append((y_test.values, proba, ret_test.values))

    if n_windows == 0:
        print("  No windows generated")
        return None

    # Concatenar resultados de todas las ventanas
    summary = {}
    for name, runs in aggregate.items():
        if not runs:
            continue
        y_all = np.concatenate([r[0] for r in runs])
        p_all = np.concatenate([r[1] for r in runs])
        r_all = np.concatenate([r[2] for r in runs])
        summary[name] = compute_metrics(
            pd.Series(y_all), p_all, pd.Series(r_all),
        )

    print(f"  Windows: {n_windows}")
    for name, m in summary.items():
        print(f"  {name:8s}  acc={m['accuracy']:.3f}  auc={m.get('auc') or 0:.3f}  "
              f"sharpe55={m['sharpe_strategy_55']:+.2f}  signal_rate={m['signal_rate_55']:.2f}")

    # Elegir ganador por sharpe55
    ranked = sorted(summary.items(), key=lambda kv: kv[1]["sharpe_strategy_55"], reverse=True)
    best_name = ranked[0][0]
    print(f"  WINNER: {best_name}  (sharpe55={summary[best_name]['sharpe_strategy_55']:+.2f})")

    # Persistir ganador. Entrenamos un modelo final con toda la data para usar en producción.
    if best_name == "lgb":
        final_model, _ = train_lightgbm(X.iloc[:-63], y.iloc[:-63], X.iloc[-63:], y.iloc[-63:])
        joblib.dump({"type": "lgb", "model": final_model, "features": feature_cols},
                    MODELS_DIR / f"{symbol}.joblib")
    elif best_name == "rf":
        final_model = RandomForestClassifier(n_estimators=200, max_depth=8, n_jobs=-1, random_state=42, class_weight="balanced")
        final_model.fit(X, y)
        joblib.dump({"type": "rf", "model": final_model, "features": feature_cols},
                    MODELS_DIR / f"{symbol}.joblib")
    elif best_name == "lr":
        scaler = StandardScaler()
        Xn = scaler.fit_transform(X)
        final_model = LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced", solver="lbfgs")
        final_model.fit(Xn, y)
        joblib.dump({"type": "lr", "model": final_model, "scaler": scaler, "features": feature_cols},
                    MODELS_DIR / f"{symbol}.joblib")
    else:
        # linear baseline: no hay modelo entrenable; lo marcamos
        joblib.dump({"type": "linear", "features": feature_cols},
                    MODELS_DIR / f"{symbol}.joblib")

    meta = {
        "symbol": symbol,
        "target": target,
        "n_rows": len(df),
        "n_features": len(feature_cols),
        "features": feature_cols,
        "n_windows": n_windows,
        "best_model": best_name,
        "metrics": summary,
        "trained_at": int(time.time()),
    }
    (METRICS_DIR / f"{symbol}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--symbols", default=None)
    ap.add_argument("--watchlist", default=None)
    ap.add_argument("--target", default="up_5d")
    ap.add_argument("--models", default="all", help="CSV: lgb,rf,lr,linear")
    args = ap.parse_args()

    if args.models == "all":
        models = ("lgb", "rf", "lr", "linear")
    else:
        models = tuple(args.models.split(","))

    if args.symbol:
        symbols = [args.symbol.upper()]
    elif args.symbols:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    elif args.watchlist:
        conn = sqlite3.connect(str(DB_PATH))
        cur = conn.cursor()
        if args.watchlist == "all":
            cur.execute("SELECT simbolos FROM watchlists")
        else:
            cur.execute("SELECT simbolos FROM watchlists WHERE nombre = ?", (args.watchlist,))
        seen, symbols = set(), []
        for row in cur.fetchall():
            for s in json.loads(row[0] or "[]"):
                s = s.strip().upper()
                if s and s not in seen:
                    seen.add(s)
                    symbols.append(s)
        conn.close()
    else:
        ap.error("Indicar --symbol, --symbols o --watchlist")

    print(f"Training {len(symbols)} symbols, target={args.target}")
    results = []
    t0 = time.time()
    for sym in symbols:
        try:
            r = train_symbol(sym, args.target, models)
            if r:
                results.append(r)
        except Exception as e:
            print(f"{sym} ERROR: {e}")

    print(f"\n--- Total: {len(results)}/{len(symbols)} in {time.time()-t0:.1f}s ---")
    if results:
        print(f"Best models: " + ", ".join(f"{r['symbol']}={r['best_model']}" for r in results[:20]))


if __name__ == "__main__":
    main()

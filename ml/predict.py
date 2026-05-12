"""
ml/predict.py
─────────────
Inferencia: dado un símbolo (con modelo entrenado), devuelve prob_up.

API:
    predict(symbol) -> {
        'symbol': str,
        'prob_up': float,
        'expected_return_5d': float,  # del feature ret_5 del último día (proxy)
        'model_used': 'lgb'|'rf'|'lr'|'linear'|None,
        'confidence': 'high'|'medium'|'low',
        'last_features': dict,  # top 5 features con sus valores
        'metrics_summary': dict
    }
"""
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from data_engine.features import build_inference_features

MODELS_DIR = Path(__file__).parent / "models"
METRICS_DIR = Path(__file__).parent / "metrics"


def _load_metrics(symbol):
    p = METRICS_DIR / f"{symbol}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def predict(symbol):
    symbol = symbol.upper()
    model_path = MODELS_DIR / f"{symbol}.joblib"
    if not model_path.exists():
        return {
            "symbol": symbol,
            "error": "no_model",
            "message": f"Modelo no entrenado. Corre: python ml/train.py --symbol {symbol}",
        }

    bundle = joblib.load(model_path)
    feats_df = build_inference_features(symbol)
    if feats_df is None or feats_df.empty:
        return {"symbol": symbol, "error": "no_features"}

    feature_cols = bundle["features"]
    # Asegurar todas las columnas presentes
    for col in feature_cols:
        if col not in feats_df.columns:
            feats_df[col] = 0
    X = feats_df[feature_cols].iloc[-1:].fillna(0)

    mtype = bundle["type"]
    try:
        if mtype == "lgb":
            proba = float(bundle["model"].predict(X)[0])
        elif mtype == "rf":
            proba = float(bundle["model"].predict_proba(X)[0, 1])
        elif mtype == "lr":
            Xs = bundle["scaler"].transform(X)
            proba = float(bundle["model"].predict_proba(Xs)[0, 1])
        elif mtype == "linear":
            r = float(X["ret_20"].iloc[0]) if "ret_20" in X.columns else 0.0
            proba = float(1 / (1 + np.exp(-10 * r)))
        else:
            return {"symbol": symbol, "error": "unknown_model_type", "type": mtype}
    except Exception as e:
        return {"symbol": symbol, "error": "predict_failed", "detail": str(e)}

    metrics = _load_metrics(symbol)
    auc = None
    confidence = "low"
    sharpe = None
    if metrics and metrics.get("best_model") in metrics.get("metrics", {}):
        m = metrics["metrics"][metrics["best_model"]]
        auc = m.get("auc")
        sharpe = m.get("sharpe_strategy_55")
        if auc and auc > 0.58:
            confidence = "high"
        elif auc and auc > 0.53:
            confidence = "medium"

    # Top features (los con mayor valor absoluto centrado)
    last_feats = X.iloc[0].to_dict()
    sorted_feats = sorted(last_feats.items(), key=lambda kv: abs(kv[1]) if isinstance(kv[1], (int, float)) else 0, reverse=True)
    top_feats = dict(sorted_feats[:5])

    return {
        "symbol": symbol,
        "prob_up": round(proba, 4),
        "expected_return_5d": round(float(X["ret_5"].iloc[0]) if "ret_5" in X.columns else 0.0, 5),
        "model_used": mtype,
        "confidence": confidence,
        "auc": round(auc, 3) if auc is not None else None,
        "sharpe_strategy": round(sharpe, 2) if sharpe is not None else None,
        "top_features": {k: round(v, 4) if isinstance(v, (int, float)) else v for k, v in top_feats.items()},
        "trained_at": metrics.get("trained_at") if metrics else None,
    }


def predict_batch(symbols):
    return [predict(s) for s in symbols]


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", required=True)
    args = ap.parse_args()
    result = predict(args.symbol)
    print(json.dumps(result, indent=2))

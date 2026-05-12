"""
ml/service.py
─────────────
FastAPI service en :6901 que sirve predicciones a Node.

Endpoints:
  GET  /health
  GET  /predict?symbol=AAPL
  GET  /predict/batch?symbols=AAPL,MSFT,...
  GET  /trained        → lista de símbolos con modelo entrenado
  GET  /metrics/<sym>  → métricas del último training
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from ml.predict import predict, predict_batch, METRICS_DIR, MODELS_DIR

app = FastAPI(title="DexterAI ML Service", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3005", "http://127.0.0.1:3005"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    n_trained = len(list(MODELS_DIR.glob("*.joblib")))
    return {"ok": True, "trained_symbols": n_trained}


@app.get("/predict")
def get_predict(symbol: str):
    return predict(symbol)


@app.get("/predict/batch")
def get_batch(symbols: str = Query(..., description="CSV de símbolos")):
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return {"predictions": predict_batch(syms)}


@app.get("/trained")
def trained():
    paths = sorted(MODELS_DIR.glob("*.joblib"))
    out = []
    for p in paths:
        sym = p.stem
        meta_path = METRICS_DIR / f"{sym}.json"
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        out.append({
            "symbol": sym,
            "best_model": meta.get("best_model"),
            "auc": (meta.get("metrics", {}).get(meta.get("best_model", ""), {}) or {}).get("auc"),
            "sharpe": (meta.get("metrics", {}).get(meta.get("best_model", ""), {}) or {}).get("sharpe_strategy_55"),
            "trained_at": meta.get("trained_at"),
        })
    return {"trained": out, "count": len(out)}


@app.get("/metrics/{symbol}")
def metrics(symbol: str):
    p = METRICS_DIR / f"{symbol.upper()}.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail="symbol no entrenado")
    return json.loads(p.read_text(encoding="utf-8"))


if __name__ == "__main__":
    import uvicorn
    port = int(__import__("os").environ.get("ML_PORT", "6901"))
    uvicorn.run("ml.service:app", host="127.0.0.1", port=port, reload=False, log_level="info")

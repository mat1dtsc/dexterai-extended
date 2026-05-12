"""
data_engine/features.py
───────────────────────
Genera features para ML a partir de historico_ohlcv (+ on-chain si symbol=BTC-USD).

API principal:
    build_features(symbol, target='up_5d', horizon=5, threshold_pct=0.02)
        → pandas DataFrame con features + columna 'target' (0/1)
        → CON DROP de las últimas `horizon` filas (sin target todavía)

    build_inference_features(symbol)
        → DataFrame con features de la ÚLTIMA barra (para predicción live)
"""
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "dexter.db"

BTC_ONCHAIN_METRICS = [
    "hash_rate",
    "n_unique_addresses",
    "estimated_tx_volume_usd",
    "miners_revenue",
    "mvrv_proxy",
    "active_addr_momentum",
]


def _load_ohlcv(symbol):
    conn = sqlite3.connect(str(DB_PATH))
    df = pd.read_sql(
        "SELECT timestamp, open, high, low, close, volume FROM historico_ohlcv WHERE symbol = ? ORDER BY timestamp",
        conn,
        params=[symbol],
    )
    conn.close()
    if df.empty:
        return None
    df.index = pd.to_datetime(df["timestamp"], unit="s")
    return df[["open", "high", "low", "close", "volume"]]


def _load_btc_onchain():
    """Carga métricas on-chain BTC pivoteadas por día (1 col por métrica)."""
    conn = sqlite3.connect(str(DB_PATH))
    df = pd.read_sql(
        "SELECT metric, ts, value FROM btc_onchain_metrics WHERE metric IN ({})".format(
            ",".join(["?"] * len(BTC_ONCHAIN_METRICS))
        ),
        conn,
        params=BTC_ONCHAIN_METRICS,
    )
    conn.close()
    if df.empty:
        return None
    df["dt"] = pd.to_datetime(df["ts"], unit="s").dt.normalize()
    pivot = df.pivot_table(index="dt", columns="metric", values="value", aggfunc="last")
    pivot.columns = [f"onchain_{c}" for c in pivot.columns]
    return pivot


def _rsi(close, length=14):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _technical_features(df):
    out = pd.DataFrame(index=df.index)
    c = df["close"]
    h = df["high"]
    l = df["low"]
    v = df["volume"]

    # Retornos
    log_ret = np.log(c / c.shift(1))
    for n in [1, 3, 5, 10, 20, 60]:
        out[f"ret_{n}"] = log_ret.rolling(n).sum()

    # Volatilidad
    out["vol_20"] = log_ret.rolling(20).std() * np.sqrt(252)
    out["vol_60"] = log_ret.rolling(60).std() * np.sqrt(252)

    # RSI
    out["rsi_14"] = _rsi(c, 14)

    # MACD
    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    out["macd"] = macd
    out["macd_signal"] = macd.ewm(span=9, adjust=False).mean()
    out["macd_hist"] = out["macd"] - out["macd_signal"]

    # Bollinger position
    sma20 = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    out["bb_pos"] = (c - (sma20 - 2 * std20)) / ((sma20 + 2 * std20) - (sma20 - 2 * std20)).replace(0, np.nan)
    out["bb_width"] = (4 * std20) / sma20

    # Medias móviles + distancias
    sma50 = c.rolling(50).mean()
    sma200 = c.rolling(200).mean()
    out["sma_ratio_50_200"] = sma50 / sma200
    out["dist_sma50"] = (c - sma50) / sma50
    out["dist_sma200"] = (c - sma200) / sma200

    # ATR aproximado
    tr = pd.concat([h - l, (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    out["atr_14"] = tr.rolling(14).mean() / c

    # Volumen
    vol_ma20 = v.rolling(20).mean()
    vol_std20 = v.rolling(20).std()
    out["vol_zscore"] = (v - vol_ma20) / vol_std20.replace(0, np.nan)
    out["vol_ratio_5_20"] = v.rolling(5).mean() / vol_ma20

    # Range relativo
    out["range_5"] = (h.rolling(5).max() - l.rolling(5).min()) / c

    return out


def build_features(symbol, target="up_5d", horizon=5, threshold_pct=0.02, include_onchain=True):
    """
    Devuelve DataFrame con features + columna 'target' (0/1).
    target='up_5d': 1 si close[t+5]/close[t] > 1 + threshold_pct.
    """
    ohlcv = _load_ohlcv(symbol)
    if ohlcv is None or len(ohlcv) < 250:
        return None

    feats = _technical_features(ohlcv)

    # On-chain solo si es BTC
    if include_onchain and symbol.upper() == "BTC-USD":
        onchain = _load_btc_onchain()
        if onchain is not None:
            onchain.index = pd.to_datetime(onchain.index)
            onchain = onchain.reindex(feats.index.normalize().unique(), method="ffill")
            onchain.index = feats.index[: len(onchain)] if len(onchain) <= len(feats) else onchain.index
            # merge por fecha normalizada
            feats_dt = feats.copy()
            feats_dt["__date"] = feats_dt.index.normalize()
            onchain_dt = onchain.copy()
            onchain_dt["__date"] = onchain_dt.index.normalize() if onchain_dt.index.tz is None else onchain_dt.index.tz_localize(None).normalize()
            merged = feats_dt.merge(onchain_dt.drop_duplicates("__date"), on="__date", how="left")
            merged.index = feats_dt.index
            feats = merged.drop(columns=["__date"])

    # Target
    if target == "up_5d":
        future = ohlcv["close"].shift(-horizon) / ohlcv["close"]
        feats["target"] = (future > (1 + threshold_pct)).astype(int)
    elif target.startswith("up_"):
        # up_<H>: subió X% en H días
        h = int(target.split("_")[1].rstrip("d"))
        future = ohlcv["close"].shift(-h) / ohlcv["close"]
        feats["target"] = (future > (1 + threshold_pct)).astype(int)
    elif target.startswith("ret_"):
        # ret_<H>: regresión, retorno log a H días
        h = int(target.split("_")[1].rstrip("d"))
        feats["target"] = np.log(ohlcv["close"].shift(-h) / ohlcv["close"])
    else:
        raise ValueError(f"target desconocido: {target}")

    # Drop filas sin target (las últimas horizon) y con NaN en features clave
    feats = feats.dropna(subset=["target"])
    feats = feats.dropna(thresh=int(len(feats.columns) * 0.7))  # tolera algunas NaN
    feats = feats.fillna(method="ffill").dropna()
    return feats


def build_inference_features(symbol, include_onchain=True):
    """Features de la última barra disponible — para predicción en vivo."""
    ohlcv = _load_ohlcv(symbol)
    if ohlcv is None or len(ohlcv) < 250:
        return None

    feats = _technical_features(ohlcv)
    if include_onchain and symbol.upper() == "BTC-USD":
        onchain = _load_btc_onchain()
        if onchain is not None:
            for col in onchain.columns:
                feats[col] = onchain[col].reindex(feats.index.normalize().unique(), method="ffill").iloc[-1]
    return feats.dropna(thresh=int(len(feats.columns) * 0.7)).fillna(method="ffill").tail(1)


if __name__ == "__main__":
    import sys
    sym = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    df = build_features(sym)
    if df is None:
        print(f"Sin datos para {sym}")
    else:
        print(f"{sym}: {len(df)} filas, {len(df.columns)-1} features, target balance={df['target'].mean():.3f}")
        print(df.tail(3).iloc[:, -5:])

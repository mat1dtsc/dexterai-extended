"""
backtest/strategies/current_rules.py
─────────────────────────────────────
Replica las reglas de lib/signalEngine.js en Python con pandas_ta.

Devuelve 4 series booleanas alineadas al índice del DataFrame:
  entries_long, exits_long, entries_short, exits_short

Reglas equivalentes a la versión JS:
  LONG si long_votes >= 3
  SHORT si short_votes >= 3
  EXIT_LONG si RSI >= 75
  EXIT_SHORT si RSI <= 25
"""
import numpy as np
import pandas as pd
import pandas_ta as ta


def _rsi_classic(close, length=14):
    """RSI Wilder's classic (igual que lib/indicators.js)."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50)


def generate_signals(df: pd.DataFrame, **params):
    """
    df: DataFrame con columnas open/high/low/close/volume y DatetimeIndex.
    Devuelve dict con entries_long, exits_long, entries_short, exits_short, info.
    """
    p = {
        "rsi_long_entry": 35,
        "rsi_short_entry": 70,
        "rsi_exit_long": 75,
        "rsi_exit_short": 25,
        "bb_long_pos": 0.10,
        "bb_short_pos": 0.90,
        "long_votes_required": 3,
        "short_votes_required": 3,
        **params,
    }

    close = df["close"]
    high = df["high"]
    low = df["low"]

    # Indicadores
    rsi = _rsi_classic(close, 14)
    macd_df = ta.macd(close, fast=12, slow=26, signal=9)
    macd = macd_df.iloc[:, 0]
    macd_signal = macd_df.iloc[:, 2]
    bb = ta.bbands(close, length=20, std=2.0)
    bb_low = bb.iloc[:, 0]
    bb_up = bb.iloc[:, 2]
    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()

    # Derivadas
    bb_pos = (close - bb_low) / (bb_up - bb_low).replace(0, np.nan)
    macd_cross_up = (macd.shift(1) - macd_signal.shift(1) <= 0) & (macd - macd_signal > 0)
    macd_cross_down = (macd.shift(1) - macd_signal.shift(1) >= 0) & (macd - macd_signal < 0)
    trend_up = sma50 > sma200
    trend_down = sma50 < sma200

    # Votos LONG
    long_votes = (
        (rsi <= p["rsi_long_entry"]).astype(int)
        + (bb_pos <= p["bb_long_pos"]).astype(int)
        + macd_cross_up.astype(int)
        + trend_up.astype(int)
        + ((rsi.shift(1) < 30) & (rsi >= 30)).astype(int)
    )
    short_votes = (
        (rsi >= p["rsi_short_entry"]).astype(int)
        + (bb_pos >= p["bb_short_pos"]).astype(int)
        + macd_cross_down.astype(int)
        + trend_down.astype(int)
        + ((rsi.shift(1) > 70) & (rsi <= 70)).astype(int)
    )

    entries_long = long_votes >= p["long_votes_required"]
    entries_short = short_votes >= p["short_votes_required"]
    exits_long = rsi >= p["rsi_exit_long"]
    exits_short = rsi <= p["rsi_exit_short"]

    # Compactar: una entrada solo cuenta si no estábamos ya in-position en esa dirección
    # vectorbt maneja eso internamente con accumulate=False
    return {
        "entries_long": entries_long.fillna(False),
        "exits_long": exits_long.fillna(False),
        "entries_short": entries_short.fillna(False),
        "exits_short": exits_short.fillna(False),
        "info": {
            "long_signals": int(entries_long.sum()),
            "short_signals": int(entries_short.sum()),
            "exit_long_signals": int(exits_long.sum()),
            "exit_short_signals": int(exits_short.sum()),
            "rsi_last": float(rsi.iloc[-1]),
            "bb_pos_last": float(bb_pos.iloc[-1]) if pd.notna(bb_pos.iloc[-1]) else None,
        },
    }


NAME = "current_rules"
DESCRIPTION = "Reglas del signalEngine.js (RSI/MACD/BB/MA votes)"

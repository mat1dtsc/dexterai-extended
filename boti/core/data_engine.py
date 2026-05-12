import numpy as np
import pandas as pd
import yfinance as yf
from statsmodels.api import OLS, add_constant
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

# Ticker proxies para los factores de mercado
BENCHMARKS = {
    'sp500': '^GSPC',          # S&P 500 - mercado empresarial general
    'tech': 'XLK',              # Technology Select Sector SPDR - sector tecnológico
    'qqq': 'QQQ',               # Nasdaq-100 como proxy tech adicional
    'bonds_10y': '^TNX',        # Treasury 10Y yield (en porcentaje, lo convertiremos)
    'bonds_agg': 'AGG',         # iShares Core US Aggregate Bond ETF
    'lqd': 'LQD',               # iShares Investment Grade Corporate Bonds
    'gold': 'GC=F',             # Oro como proxy de commodities
    'oil': 'CL=F',              # Petróleo WTI
    'vix': '^VIX',              # Volatilidad implícita
    'dxy': 'DX-Y.NYB',          # DXY - índice del dólar
}

def download_prices(tickers, period='2y', interval='1d'):
    """
    Descarga precios de cierre ajustados de Yahoo Finance.
    
    Args:
        tickers: lista de strings o string de tickers separados por espacio
        period: período de descarga ('1y', '2y', '5y')
        interval: frecuencia ('1d', '1wk', '1mo')
    
    Returns:
        DataFrame de precios de cierre ajustados
    """
    if isinstance(tickers, list):
        tickers = ' '.join(tickers)
    
    print(f"📡 Descargando datos: {tickers} ...")
    data = yf.download(tickers, period=period, interval=interval, progress=False)
    
    # Manejar caso de ticker único vs múltiples
    if isinstance(data.columns, pd.MultiIndex):
        prices = data['Close']
    else:
        prices = data[['Close']]
        prices.columns = [tickers.split()[0]]
    
    prices = prices.dropna(how='all')
    print(f"   ✅ {len(prices)} días descargados ({prices.index[0].date()} → {prices.index[-1].date()})")
    return prices

def log_returns(prices):
    """
    Calcula retornos logarítmicos diarios: ln(Pt / Pt-1)
    
    Args:
        prices: DataFrame de precios
    
    Returns:
        DataFrame de retornos logarítmicos
    """
    return np.log(prices / prices.shift(1)).dropna()

def annualize_returns(log_rets, periods_per_year=252):
    """
    Anualiza retornos logarítmicos medios.
    """
    return log_rets.mean() * periods_per_year

def annualize_volatility(log_rets, periods_per_year=252):
    """
    Anualiza volatilidad (desviación estándar).
    """
    return log_rets.std() * np.sqrt(periods_per_year)

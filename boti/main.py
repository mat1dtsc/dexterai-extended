import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
from datetime import datetime

from core.data_engine import download_prices, log_returns, BENCHMARKS
from core.factor_model import FactorModel, MetricsEngine, PortfolioOptimizer

class BOTIScreener:
    """
    Motor principal de exploración de mercado.
    Escanea activos, aplica el modelo multifactorial, genera ranking.
    """
    
    def __init__(self, lookback='2y', risk_free=0.045):
        self.lookback = lookback
        self.risk_free = risk_free
        self.factor_model = FactorModel(lookback_days=252)
        self.metrics = MetricsEngine()
        self.optimizer = PortfolioOptimizer(risk_free)
    
    def load_factor_data(self):
        """
        Descarga los factores de mercado (rm, rtech, rbond, vix).
        """
        print("\n" + "="*60)
        print("📥 CARGANDO FACTORES DE MERCADO")
        print("="*60)
        
        factors = {
            'rm': '^GSPC',
            'rtech': 'XLK', 
            'rbond': 'AGG',
            'rvix': '^VIX',
            'rdxy': 'DX-Y.NYB'
        }
        
        prices = download_prices(list(factors.values()), period=self.lookback)
        
        # Renombrar columnas
        col_map = {v: k for k, v in factors.items()}
        prices = prices.rename(columns=col_map)
        
        self.factor_prices = prices
        self.factor_returns = log_returns(prices)
        
        print(f"\n📊 Factores cargados: {list(factors.keys())}")
        print(f"   Período: {self.factor_returns.index[0].date()} → {self.factor_returns.index[-1].date()}")
        print(f"   Observaciones: {len(self.factor_returns)}")
        
        return self.factor_returns
    
    def screen_assets(self, tickers, factor_cols=['rm', 'rtech', 'rbond']):
        """
        Analiza una lista de activos contra los factores.
        
        Args:
            tickers: lista de tickers a analizar
            factor_cols: qué factores usar en la regresión
        
        Returns:
            DataFrame con métricas de cada activo
        """
        print("\n" + "="*60)
        print("🔍 SCREENING DE ACTIVOS")
        print("="*60)
        
        # Descargar precios
        prices = download_prices(tickers, period=self.lookback)
        returns = log_returns(prices)
        
        # Preparar factores (usar solo los solicitados)
        factor_rets = self.factor_returns[factor_cols].dropna()
        
        results = []
        
        for ticker in returns.columns:
            print(f"\n📈 Analizando {ticker}...")
            
            asset_ret = returns[ticker].dropna()
            
            # Regresión multifactorial
            fit = self.factor_model.fit(asset_ret, factor_rets)
            
            if not fit['valid']:
                print(f"   ⚠️ {fit['error']}")
                continue
            
            # Métricas clásicas
            sharpe = self.metrics.sharpe_ratio(asset_ret, self.risk_free)
            sortino = self.metrics.sortino_ratio(asset_ret, self.risk_free)
            mdd = self.metrics.max_drawdown(prices[ticker])
            var95 = self.metrics.var_95(asset_ret) * 100
            var99 = self.metrics.var_99(asset_ret) * 100
            
            # Alfa de Jensen (CAPM simple para referencia)
            jensen_alpha, capm_beta = self.metrics.jensen_alpha(
                asset_ret, factor_rets['rm'], self.risk_free
            )
            
            result = {
                'ticker': ticker,
                'annual_return': asset_ret.mean() * 252,
                'annual_vol': asset_ret.std() * np.sqrt(252),
                'sharpe': sharpe,
                'sortino': sortino,
                'alpha_jensen': jensen_alpha,
                'capm_beta': capm_beta,
                'multifactor_alpha': fit['alpha_annual'],
                'alpha_significant': fit['alpha_significant'],
                'r_squared': fit['r_squared'],
                'max_dd': mdd * 100,
                'var95': var95,
                'var99': var99,
            }
            
            # Añadir betas del modelo multifactorial
            for factor, beta in fit['betas'].items():
                result[f'beta_{factor}'] = beta
                result[f'beta_{factor}_pval'] = fit['beta_pvalues'][factor]
            
            results.append(result)
            
            print(f"   Sharpe: {sharpe:.3f} | Alpha: {fit['alpha_annual']:.3f} | R²: {fit['r_squared']:.3f}")
        
        self.screening_results = pd.DataFrame(results)
        return self.screening_results
    
    def rank_by_efficiency(self, metric='sharpe', min_obs=None):
        """
        Ordena activos por eficiencia.
        """
        df = self.screening_results.copy()
        
        if min_obs:
            df = df[df['annual_vol'] > 0.001]  # Filtrar volatilidad casi nula
        
        df = df.sort_values(metric, ascending=False).reset_index(drop=True)
        df['rank'] = range(1, len(df) + 1)
        
        return df
    
    def build_efficient_portfolios(self, top_assets=10, n_portfolios=2000):
        """
        Construye portafolios eficientes con los mejores activos.
        """
        print("\n" + "="*60)
        print("🏗️ CONSTRUYENDO PORTAFOLIOS EFICIENTES")
        print("="*60)
        
        # Tomar los mejores activos por Sharpe
        ranked = self.rank_by_efficiency('sharpe')
        best = ranked.head(top_assets)
        
        print(f"\n🎯 Top {top_assets} activos por Sharpe:")
        print(best[['ticker', 'sharpe', 'annual_return', 'annual_vol', 'multifactor_alpha']].to_string(index=False))
        
        # Generar portafolios aleatorios
        tickers = best['ticker'].tolist()
        returns_subset = self.factor_returns  # Necesitamos retornos de los activos, no de los factores
        # Hay que recalcular retornos de los activos seleccionados
        
        print(f"\n🔄 Generando {n_portfolios} portafolios aleatorios...")
        # Descargar precios de los top activos
        prices = download_prices(tickers, period=self.lookback)
        asset_returns = log_returns(prices)
        
        portfolios = self.optimizer.random_portfolios(asset_returns, n_portfolios, max_weight=0.35)
        efficient = self.optimizer.efficient_frontier(portfolios, top_n=5, metric='sharpe')
        
        print(f"\n🏆 TOP 5 PORTAFOLIOS EFICIENTES (por Sharpe):")
        display_cols = ['port_id', 'annual_return', 'annual_vol', 'sharpe', 'sortino', 'var95']
        print(efficient[display_cols].to_string(index=False))
        
        # Mostrar composición del mejor
        best_port = efficient.iloc[0]
        print(f"\n📊 COMPOSICIÓN DEL MEJOR PORTAFOLIO (Sharpe={best_port['sharpe']:.3f}):")
        for asset, w in best_port['weights'].items():
            if w > 0.001:
                print(f"   {asset}: {w*100:.1f}%")
        
        self.portfolios = portfolios
        self.efficient_portfolios = efficient
        
        return efficient
    
    def full_report(self):
        """
        Genera reporte completo del screening.
        """
        print("\n" + "="*60)
        print("📋 REPORTE COMPLETO BOTI")
        print("="*60)
        
        ranked = self.rank_by_efficiency('sharpe')
        
        print("\n🏅 RANKING POR SHARPE RATIO:")
        cols = ['rank', 'ticker', 'sharpe', 'annual_return', 'annual_vol', 'multifactor_alpha', 'r_squared']
        print(ranked[cols].head(10).to_string(index=False))
        
        print("\n📉 MÁXIMOS DRAWDOWN:")
        dd_rank = ranked.sort_values('max_dd', ascending=True)[['ticker', 'max_dd', 'sharpe', 'var95']]
        print(dd_rank.head(5).to_string(index=False))
        
        print("\n🔥 ALPHAS SIGNIFICATIVOS (p < 0.05):")
        alphas = ranked[ranked['alpha_significant'] == True][['ticker', 'multifactor_alpha', 'sharpe', 'r_squared']]
        if len(alphas) > 0:
            print(alphas.to_string(index=False))
        else:
            print("   Ningún activo con alpha estadísticamente significativo en este período.")

def run_demo():
    """
    Ejecución de demostración con un universo de activos variado.
    """
    print("\n" + "🤖 "*20)
    print("BOTI - AGENTE AUTÓNOMO DE ANÁLISIS FINANCIERO")
    print("Modelo Multifactorial: rm + rtech + rbond + rvix + rdxy")
    print("🤖 "*20)
    
    # Universo de prueba: tecnología, energía, finanzas, commodities, crypto
    universe = [
        'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META',  # Big Tech
        'AMZN', 'TSLA', 'NFLX', 'CRM', 'AMD',       # Tech/Growth
        'JPM', 'BAC', 'GS', 'V', 'MA',               # Finanzas
        'XOM', 'CVX', 'OXY', 'COP',                  # Energía
        'JNJ', 'PFE', 'UNH', 'ABBV',                # Salud
        'SPY', 'QQQ', 'IWM', 'VTI',                 # ETFs
        'GLD', 'SLV', 'USO',                         # Commodities
        'BTC-USD', 'ETH-USD',                         # Crypto
    ]
    
    boti = BOTIScreener(lookback='2y', risk_free=0.045)
    
    # 1. Cargar factores
    boti.load_factor_data()
    
    # 2. Screener de activos
    boti.screen_assets(universe, factor_cols=['rm', 'rtech', 'rbond', 'rvix'])
    
    # 3. Reporte
    boti.full_report()
    
    # 4. Portafolios eficientes (solo si hay suficientes activos válidos)
    if len(boti.screening_results) >= 5:
        boti.build_efficient_portfolios(top_assets=min(10, len(boti.screening_results)), n_portfolios=2000)
    
    print("\n" + "="*60)
    print("✅ ANÁLISIS COMPLETADO")
    print("="*60)
    
    return boti

if __name__ == '__main__':
    boti = run_demo()

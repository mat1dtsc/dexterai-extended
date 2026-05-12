import numpy as np
import pandas as pd
from statsmodels.api import OLS, add_constant
from scipy import stats

class FactorModel:
    """
    Modelo multifactorial de riesgo para activos individuales.
    
    Regresión: ri = alpha + beta_m * rm + beta_tech * rtech + beta_bond * rbond + epsilon
    
    Donde:
    - ri: retorno logarítmico del activo
    - rm: retorno del mercado (S&P 500)
    - rtech: retorno del sector tecnológico (XLK)
    - rbond: retorno del mercado de bonos (AGG)
    """
    
    def __init__(self, lookback_days=252, min_obs=60):
        self.lookback = lookback_days
        self.min_obs = min_obs  # mínimo de observaciones para regresión válida
    
    def fit(self, asset_returns, factor_returns):
        """
        Corre la regresión multifactorial para un activo.
        
        Args:
            asset_returns: pd.Series de retornos del activo
            factor_returns: pd.DataFrame con columnas [rm, rtech, rbond]
        
        Returns:
            dict con alpha, betas, p-values, r2, residuos, etc.
        """
        # Alinear fechas y limpiar NaN
        data = pd.concat([asset_returns.rename('ri'), factor_returns], axis=1).dropna()
        
        if len(data) < self.min_obs:
            return {
                'valid': False,
                'error': f'Solo {len(data)} observaciones (mínimo {self.min_obs})'
            }
        
        y = data['ri']
        X = data.drop('ri', axis=1)
        X = add_constant(X)  # Añade intercepto (alpha)
        
        model = OLS(y, X).fit()
        
        result = {
            'valid': True,
            'n_obs': len(data),
            'alpha': model.params['const'],
            'alpha_annual': model.params['const'] * 252,
            'alpha_pvalue': model.pvalues['const'],
            'alpha_significant': model.pvalues['const'] < 0.05,
            'betas': {},
            'beta_pvalues': {},
            'r_squared': model.rsquared,
            'adj_r_squared': model.rsquared_adj,
            'resid_std': model.resid.std(),
            'resid_annual_vol': model.resid.std() * np.sqrt(252),
            'sharpe_factor': {},  # Sharpe por factor
            'model': model
        }
        
        for col in factor_returns.columns:
            result['betas'][col] = model.params[col]
            result['beta_pvalues'][col] = model.pvalues[col]
        
        # Sharpe de cada factor (retorno anualizado / vol anualizada)
        for col in factor_returns.columns:
            r = factor_returns[col].dropna()
            if len(r) > 0:
                sharpe = (r.mean() * 252) / (r.std() * np.sqrt(252))
                result['sharpe_factor'][col] = sharpe
        
        return result
    
    def fit_portfolio(self, weights, asset_returns, factor_returns):
        """
        Corre la regresión para un PORTAFOLIO ponderado.
        
        Args:
            weights: dict {ticker: peso} que suma ~1
            asset_returns: pd.DataFrame con retornos de cada activo
            factor_returns: pd.DataFrame de factores
        
        Returns:
            dict con métricas del portafolio
        """
        # Calcular retorno del portafolio
        w = pd.Series(weights)
        common_assets = [a for a in w.index if a in asset_returns.columns]
        w = w[common_assets]
        w = w / w.sum()  # Normalizar
        
        port_returns = (asset_returns[common_assets] @ w).rename('rp')
        
        return self.fit(port_returns, factor_returns)

class MetricsEngine:
    """
    Motor de métricas financieras clásicas.
    """
    
    @staticmethod
    def sharpe_ratio(log_rets, risk_free_annual=0.045, periods_per_year=252):
        """
        Sharpe Ratio = (Rp - Rf) / sigma_p
        
        Args:
            log_rets: pd.Series de retornos logarítmicos
            risk_free_annual: tasa libre de riesgo anualizada (default 4.5%)
        """
        excess = (log_rets.mean() * periods_per_year) - risk_free_annual
        vol = log_rets.std() * np.sqrt(periods_per_year)
        return excess / vol if vol > 0 else np.nan
    
    @staticmethod
    def sortino_ratio(log_rets, risk_free_annual=0.045, periods_per_year=252):
        """
        Sortino Ratio = (Rp - Rf) / downside_std
        """
        excess = (log_rets.mean() * periods_per_year) - risk_free_annual
        downside = log_rets[log_rets < 0].std() * np.sqrt(periods_per_year)
        return excess / downside if downside > 0 else np.nan
    
    @staticmethod
    def max_drawdown(prices):
        """
        Máximo drawdown de una serie de precios.
        """
        peak = prices.cummax()
        drawdown = (prices - peak) / peak
        return drawdown.min()
    
    @staticmethod
    def calmar_ratio(log_rets, prices, risk_free_annual=0.045, periods_per_year=252):
        """
        Calmar Ratio = retorno anualizado / |max_drawdown|
        """
        ret_annual = log_rets.mean() * periods_per_year
        mdd = abs(MetricsEngine.max_drawdown(prices))
        return ret_annual / mdd if mdd > 0 else np.nan
    
    @staticmethod
    def jensen_alpha(ri, rm, rf_annual=0.045, periods_per_year=252):
        """
        Alfa de Jensen clásico (CAPM de un solo factor).
        
        Alfa = Rp - [Rf + beta*(Rm - Rf)]
        """
        rf_daily = rf_annual / periods_per_year
        
        # Beta de CAPM simple
        cov = np.cov(ri.dropna(), rm.loc[ri.index].dropna())
        beta = cov[0,1] / cov[1,1] if cov[1,1] > 0 else np.nan
        
        rp = ri.mean() * periods_per_year
        market_premium = (rm.mean() * periods_per_year) - rf_annual
        
        alpha = rp - (rf_annual + beta * market_premium)
        return alpha, beta
    
    @staticmethod
    def var_95(log_rets, method='historical'):
        """
        Value at Risk al 95%.
        """
        if method == 'historical':
            return np.percentile(log_rets.dropna(), 5)
        elif method == 'parametric':
            mu = log_rets.mean()
            sigma = log_rets.std()
            return mu - 1.645 * sigma
    
    @staticmethod
    def var_99(log_rets, method='historical'):
        """
        Value at Risk al 99%.
        """
        if method == 'historical':
            return np.percentile(log_rets.dropna(), 1)
        elif method == 'parametric':
            mu = log_rets.mean()
            sigma = log_rets.std()
            return mu - 2.326 * sigma
    
    @staticmethod
    def info_ratio(port_returns, benchmark_returns):
        """
        Information Ratio = (Rp - Rb) / tracking_error
        """
        diff = port_returns - benchmark_returns
        return diff.mean() / diff.std() if diff.std() > 0 else np.nan
    
    @staticmethod
    def treynor_ratio(ri, rm, rf_annual=0.045, periods_per_year=252):
        """
        Treynor Ratio = (Rp - Rf) / beta
        """
        cov = np.cov(ri.dropna(), rm.loc[ri.index].dropna())
        beta = cov[0,1] / cov[1,1]
        rp = ri.mean() * periods_per_year
        return (rp - rf_annual) / beta if beta > 0 else np.nan

class PortfolioOptimizer:
    """
    Optimizador de portafolios basado en métricas de eficiencia.
    """
    
    def __init__(self, risk_free=0.045):
        self.risk_free = risk_free
    
    def random_portfolios(self, returns_df, n_portfolios=1000, max_weight=0.3):
        """
        Genera N portafolios aleatorios y calcula métricas.
        
        Args:
            returns_df: pd.DataFrame de retornos logarítmicos
            n_portfolios: número de portafolios a generar
            max_weight: peso máximo por activo
        
        Returns:
            pd.DataFrame con métricas de cada portafolio
        """
        assets = returns_df.columns
        n_assets = len(assets)
        
        results = []
        np.random.seed(42)
        
        for i in range(n_portfolios):
            # Generar pesos aleatorios y normalizar
            w = np.random.random(n_assets)
            w = w / w.sum()
            
            # Aplicar límite máximo si se excede
            while (w > max_weight).any():
                excess_idx = np.where(w > max_weight)[0]
                excess = w[excess_idx].sum() - max_weight * len(excess_idx)
                w[excess_idx] = max_weight
                # Redistribuir exceso entre los que no están en límite
                others = np.where(w < max_weight)[0]
                if len(others) > 0:
                    w[others] += excess / len(others)
                w = w / w.sum()
            
            # Calcular métricas del portafolio
            port_ret = (returns_df @ w)
            
            metrics = {
                'port_id': i,
                'weights': dict(zip(assets, w)),
                'annual_return': port_ret.mean() * 252,
                'annual_vol': port_ret.std() * np.sqrt(252),
                'sharpe': MetricsEngine.sharpe_ratio(port_ret, self.risk_free),
                'sortino': MetricsEngine.sortino_ratio(port_ret, self.risk_free),
                'var95': MetricsEngine.var_95(port_ret) * 100,  # en %
                'var99': MetricsEngine.var_99(port_ret) * 100,
            }
            
            results.append(metrics)
        
        return pd.DataFrame(results)
    
    def efficient_frontier(self, results_df, top_n=10, metric='sharpe'):
        """
        Extrae los mejores portafolios según una métrica.
        
        Args:
            results_df: DataFrame de random_portfolios
            top_n: cuántos portafolios retornar
            metric: 'sharpe', 'sortino', 'annual_return'
        
        Returns:
            DataFrame ordenado de mejores portafolios
        """
        valid = results_df.dropna(subset=[metric])
        return valid.nlargest(top_n, metric)

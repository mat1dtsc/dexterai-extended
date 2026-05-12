"""
Agente Autónomo de Trading - Multi-Mercado
Datos: yfinance (Yahoo Finance) - gratis e ilimitados
Ejecución: Alpaca Paper Trading - gratis, $100k ficticios
Modelos: CAPM, Sharpe, Jensen Alpha, Beta Regression, 5-Factor, Log Returns
Mercados: Stocks, ETFs (expandible a crypto/forex)
"""

import os
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
import alpaca_trade_api as tradeapi
from dotenv import load_dotenv

# Cargar credenciales
env_path = Path(__file__).parent / "alpaca.env"
load_dotenv(env_path)

ALPACA_API_KEY = os.getenv("ALPACA_API_KEY")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY")
ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('trading_agent.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


@dataclass
class Asset:
    """Activo analizado con métricas financieras"""
    symbol: str
    market: str
    sector: str
    price: float = 0.0
    log_returns: List[float] = None
    beta: float = 0.0
    alpha: float = 0.0
    sharpe: float = 0.0
    expected_return: float = 0.0
    volatility: float = 0.0
    weight: float = 0.0
    
    def __post_init__(self):
        if self.log_returns is None:
            self.log_returns = []


@dataclass
class Portfolio:
    """Portafolio con medición logarítmica"""
    name: str
    assets: Dict[str, Asset]
    benchmark_return: float = 0.0
    risk_free_rate: float = 0.04
    log_return: float = 0.0
    volatility: float = 0.0
    sharpe_ratio: float = 0.0
    jensen_alpha: float = 0.0
    treynor_ratio: float = 0.0
    
    def calculate_metrics(self):
        if not self.assets:
            return
        
        weights = np.array([a.weight for a in self.assets.values()])
        returns = np.array([a.expected_return for a in self.assets.values()])
        risks = np.array([a.volatility for a in self.assets.values()])
        betas = np.array([a.beta for a in self.assets.values()])
        
        self.log_return = np.sum(weights * returns)
        
        # Volatilidad del portafolio (simplificada)
        self.volatility = np.sqrt(np.sum((weights * risks) ** 2))
        
        # Sharpe
        excess = self.log_return - self.risk_free_rate
        self.sharpe_ratio = excess / self.volatility if self.volatility > 0 else 0
        
        # Jensen Alpha
        port_beta = np.sum(weights * betas)
        market_premium = self.benchmark_return - self.risk_free_rate
        expected_capm = self.risk_free_rate + port_beta * market_premium
        self.jensen_alpha = self.log_return - expected_capm
        
        # Treynor
        self.treynor_ratio = excess / port_beta if port_beta > 0 else 0


class DataFeed:
    """Proveedor de datos unificado - yfinance"""
    
    def get_stock_data(self, symbol: str, period: str = "1y") -> pd.DataFrame:
        """Obtiene datos históricos de Yahoo Finance"""
        try:
            ticker = yf.Ticker(symbol)
            df = ticker.history(period=period, interval="1d")
            if df.empty:
                logger.warning(f"No hay datos para {symbol}")
            return df
        except Exception as e:
            logger.error(f"Error obteniendo {symbol}: {e}")
            return pd.DataFrame()
    
    def get_log_returns(self, prices: pd.Series) -> np.ndarray:
        """Retornos logarítmicos: ln(Pt / Pt-1)"""
        returns = np.log(prices / prices.shift(1)).dropna()
        return returns.values
    
    def get_10y_yield(self) -> float:
        """Rendimiento del T-Bond 10 años (^TNX como proxy)"""
        try:
            df = self.get_stock_data("^TNX", period="5d")
            if not df.empty:
                return df['Close'].iloc[-1] / 100
        except:
            pass
        logger.warning("Usando T-bond fallback: 4.5%")
        return 0.045


class FinancialEngine:
    """Motor de cálculo financiero"""
    
    def __init__(self, data_feed: DataFeed):
        self.data = data_feed
        self.risk_free = data_feed.get_10y_yield()
        logger.info(f"Tasa libre de riesgo (10Y): {self.risk_free:.4f}")
    
    def calculate_beta(self, stock_ret: np.ndarray, market_ret: np.ndarray) -> float:
        """Beta = Cov(stock, market) / Var(market)"""
        min_len = min(len(stock_ret), len(market_ret))
        s = stock_ret[-min_len:]
        m = market_ret[-min_len:]
        cov = np.cov(s, m)[0, 1]
        var = np.var(m)
        return cov / var if var != 0 else 1.0
    
    def calculate_alpha(self, stock_ret: np.ndarray, market_ret: np.ndarray, beta: float) -> float:
        """Alpha de Jensen = Retorno Real - CAPM"""
        actual = np.mean(stock_ret)
        market = np.mean(market_ret)
        expected = self.risk_free + beta * (market - self.risk_free)
        return actual - expected
    
    def calculate_sharpe(self, returns: np.ndarray) -> float:
        """Sharpe = (E[R] - Rf) / sigma"""
        excess = np.mean(returns) - self.risk_free
        vol = np.std(returns)
        return excess / vol if vol > 0 else 0
    
    def analyze_asset(self, symbol: str, market_sym: str = "SPY", 
                      market: str = "stock", sector: str = "general") -> Asset:
        """Análisis completo de un activo"""
        logger.info(f"Analizando {symbol}...")
        
        # Datos del activo y mercado
        df_stock = self.data.get_stock_data(symbol, period="1y")
        df_market = self.data.get_stock_data(market_sym, period="1y")
        
        if df_stock.empty or df_market.empty:
            logger.warning(f"Datos insuficientes para {symbol}")
            return Asset(symbol=symbol, market=market, sector=sector)
        
        # Calcular retornos log
        stock_ret = self.data.get_log_returns(df_stock['Close'])
        market_ret = self.data.get_log_returns(df_market['Close'])
        
        price = float(df_stock['Close'].iloc[-1])
        
        # Métricas
        beta = self.calculate_beta(stock_ret, market_ret)
        alpha = self.calculate_alpha(stock_ret, market_ret, beta)
        sharpe = self.calculate_sharpe(stock_ret)
        
        expected = np.mean(stock_ret)
        vol = np.std(stock_ret)
        
        asset = Asset(
            symbol=symbol, market=market, sector=sector,
            price=price, log_returns=stock_ret.tolist(),
            beta=beta, alpha=alpha, sharpe=sharpe,
            expected_return=expected, volatility=vol
        )
        
        logger.info(f"  {symbol}: Beta={beta:.3f}, Alpha={alpha:.4f}, Sharpe={sharpe:.3f}")
        return asset


class PortfolioManager:
    """Constructor y optimizador de portafolios"""
    
    def __init__(self, engine: FinancialEngine):
        self.engine = engine
        self.portfolios: Dict[str, Portfolio] = {}
    
    def build_portfolio(self, symbols: List[str], name: str, market_sym: str = "SPY") -> Portfolio:
        """Construye portafolio con pesos iguales"""
        port = Portfolio(name=name, assets={}, risk_free_rate=self.engine.risk_free)
        
        for sym in symbols:
            asset = self.engine.analyze_asset(sym, market_sym)
            port.assets[sym] = asset
        
        # Peso igual inicial
        n = len(symbols)
        for asset in port.assets.values():
            asset.weight = 1.0 / n
        
        # Benchmark
        df_spy = self.engine.data.get_stock_data(market_sym, period="1y")
        if not df_spy.empty:
            spy_ret = self.engine.data.get_log_returns(df_spy['Close'])
            port.benchmark_return = np.mean(spy_ret)
        
        port.calculate_metrics()
        self.portfolios[name] = port
        return port
    
    def optimize_sharpe(self, portfolio: Portfolio) -> Portfolio:
        """Optimiza pesos para máximo Sharpe usando muestreo aleatorio"""
        if not portfolio.assets:
            return portfolio
        
        symbols = list(portfolio.assets.keys())
        n = len(symbols)
        
        # Matriz de retornos
        rets = [np.array(portfolio.assets[s].log_returns) for s in symbols]
        min_len = min(len(r) for r in rets)
        if min_len < 10:
            logger.warning("Datos insuficientes para optimización")
            return portfolio
        
        rets = np.array([r[-min_len:] for r in rets])
        expected = np.array([portfolio.assets[s].expected_return for s in symbols])
        cov = np.cov(rets)
        
        best_sharpe = -float('inf')
        best_weights = np.array([1.0 / n] * n)
        
        # Muestreo aleatorio con restricciones
        np.random.seed(42)
        for _ in range(10000):
            # Generar pesos aleatorios que sumen 1
            weights = np.random.dirichlet(np.ones(n) * 2)  # Alpha=2 para más equilibrado
            
            # Limitar máximo al 50%
            weights = np.clip(weights, 0, 0.5)
            weights = weights / weights.sum()  # Re-normalizar
            
            port_ret = np.sum(weights * expected)
            port_vol = np.sqrt(np.dot(weights.T, np.dot(cov, weights)))
            
            if port_vol > 0:
                sharpe = (port_ret - portfolio.risk_free_rate) / port_vol
                if sharpe > best_sharpe:
                    best_sharpe = sharpe
                    best_weights = weights.copy()
        
        for i, s in enumerate(symbols):
            portfolio.assets[s].weight = best_weights[i]
        
        portfolio.calculate_metrics()
        logger.info(f"Optimizado '{portfolio.name}' - Sharpe: {portfolio.sharpe_ratio:.3f}")
        return portfolio


class TradingAgent:
    """Agente autónomo completo"""
    
    def __init__(self):
        self.data = DataFeed()
        self.engine = FinancialEngine(self.data)
        self.manager = PortfolioManager(self.engine)
        
        # Conexión Alpaca para ejecución
        self.alpaca = tradeapi.REST(
            ALPACA_API_KEY, ALPACA_SECRET_KEY,
            ALPACA_PAPER_URL, api_version='v2'
        )
        
        # Universos de activos
        self.tech = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "NFLX", "CRM"]
        self.finance = ["JPM", "BAC", "GS", "MS", "WFC", "C"]
        self.energy = ["XOM", "CVX", "COP", "SLB", "EOG"]
        self.core = ["SPY", "QQQ", "VTI", "IWM", "VTV"]
        self.health = ["JNJ", "UNH", "PFE", "ABBV", "LLY"]
        
        logger.info("Agente iniciado - Modo PAPER TRADING")
    
    def screen_opportunities(self, universe: List[str]) -> List[Asset]:
        """Pantalla de oportunidades: Alpha > 0 y Sharpe > 0.5"""
        opportunities = []
        for sym in universe:
            try:
                asset = self.engine.analyze_asset(sym)
                score = asset.alpha + asset.sharpe * 0.5
                if asset.alpha > 0 and asset.sharpe > 0.5:
                    opportunities.append(asset)
                    logger.info(f"OPORTUNIDAD: {sym} | Score: {score:.4f}")
            except Exception as e:
                logger.error(f"Error en {sym}: {e}")
        
        opportunities.sort(key=lambda a: a.alpha + a.sharpe * 0.5, reverse=True)
        return opportunities
    
    def build_multiple_portfolios(self) -> Dict[str, Portfolio]:
        """Construye portafolios independientes"""
        logger.info("\n" + "="*60)
        logger.info("CONSTRUYENDO PORTAFOLIOS INDEPENDIENTES")
        logger.info("="*60)
        
        # Tech agresivo
        tech = self.manager.build_portfolio(self.tech[:5], "Tech_Agresivo")
        tech = self.manager.optimize_sharpe(tech)
        
        # Core diversificado
        core = self.manager.build_portfolio(self.core, "Core_Diversificado")
        core = self.manager.optimize_sharpe(core)
        
        # Value/Energía
        value = self.manager.build_portfolio(self.energy + self.finance[:2], "Value_Energia")
        value = self.manager.optimize_sharpe(value)
        
        # Healthcare
        health = self.manager.build_portfolio(self.health[:4], "Healthcare")
        health = self.manager.optimize_sharpe(health)
        
        return self.manager.portfolios
    
    def compare_portfolios(self) -> pd.DataFrame:
        """Compara portafolios con métricas logarítmicas"""
        rows = []
        for name, p in self.manager.portfolios.items():
            rows.append({
                "Portafolio": name,
                "Log_Return": f"{p.log_return:.4f}",
                "Volatilidad": f"{p.volatility:.4f}",
                "Sharpe": f"{p.sharpe_ratio:.3f}",
                "Alpha_Jensen": f"{p.jensen_alpha:.4f}",
                "Treynor": f"{p.treynor_ratio:.3f}",
                "Score": f"{p.sharpe_ratio * p.jensen_alpha:.4f}"
            })
        
        df = pd.DataFrame(rows)
        
        print("\n" + "="*70)
        print("COMPARACIÓN DE PORTAFOLIOS (Métricas Logarítmicas)")
        print("="*70)
        print(df.to_string(index=False))
        print("="*70)
        
        return df
    
    def select_best(self) -> str:
        """Selecciona el mejor portafolio por eficiencia"""
        best, best_score = None, -float('inf')
        for name, p in self.manager.portfolios.items():
            score = p.sharpe_ratio * p.jensen_alpha
            if score > best_score:
                best_score, best = score, name
        
        print(f"\n🏆 MEJOR PORTAFOLIO: {best} (Score: {best_score:.4f})")
        return best
    
    def place_paper_order(self, symbol: str, qty: int, side: str = "buy"):
        """Ejecuta orden en Alpaca Paper Trading"""
        try:
            order = self.alpaca.submit_order(
                symbol=symbol,
                qty=qty,
                side=side,
                type="market",
                time_in_force="day"
            )
            logger.info(f"Orden {side.upper()} {qty} {symbol} enviada: {order.id}")
            return order
        except Exception as e:
            logger.error(f"Error en orden {symbol}: {e}")
            return None
    
    def execute_best_portfolio(self, investment: float = 10000):
        """Ejecuta el mejor portafolio en paper trading"""
        best = self.select_best()
        portfolio = self.manager.portfolios[best]
        
        print(f"\n💰 Invirtiendo ${investment:,.2f} en '{best}' (PAPER TRADING)")
        
        for sym, asset in portfolio.assets.items():
            allocation = investment * asset.weight
            qty = max(1, int(allocation / asset.price))
            
            if qty > 0:
                self.place_paper_order(sym, qty, "buy")
                print(f"  {sym}: {qty} acciones @ ${asset.price:.2f} (peso: {asset.weight:.2%})")
    
    def run_cycle(self):
        """Ciclo completo del agente"""
        logger.info("\n" + "="*60)
        logger.info("INICIANDO CICLO DEL AGENTE DE TRADING")
        logger.info("="*60)
        
        # 1. Pantalla de oportunidades
        logger.info("\n[1] Pantalla de oportunidades Tech...")
        ops = self.screen_opportunities(self.tech)
        
        # 2. Construir portafolios
        logger.info("\n[2] Construyendo portafolios...")
        self.build_multiple_portfolios()
        
        # 3. Comparar
        logger.info("\n[3] Comparando portafolios...")
        comparison = self.compare_portfolios()
        
        # 4. Seleccionar y ejecutar
        logger.info("\n[4] Ejecutando estrategia óptima...")
        self.execute_best_portfolio(investment=10000)
        
        # 5. Guardar resultados
        self.save_results(comparison)
        
        logger.info("\n[✓] Ciclo completado.")
    
    def save_results(self, comparison: pd.DataFrame):
        """Guarda análisis en archivos"""
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        comparison.to_csv(f'analysis_{ts}.csv', index=False)
        
        # Detalle de cada portafolio
        for name, p in self.manager.portfolios.items():
            data = {
                "portafolio": name,
                "metricas": {
                    "log_return": p.log_return,
                    "volatilidad": p.volatility,
                    "sharpe": p.sharpe_ratio,
                    "jensen_alpha": p.jensen_alpha,
                    "treynor": p.treynor_ratio,
                    "risk_free": p.risk_free_rate
                },
                "activos": {
                    sym: {
                        "precio": a.price,
                        "beta": a.beta,
                        "alpha": a.alpha,
                        "sharpe": a.sharpe,
                        "peso": a.weight,
                        "retorno_esperado": a.expected_return,
                        "volatilidad": a.volatility
                    }
                    for sym, a in p.assets.items()
                }
            }
            with open(f'portfolio_{name}_{ts}.json', 'w') as f:
                json.dump(data, f, indent=2, default=float)
        
        logger.info(f"Resultados guardados: {ts}")


def main():
    agent = TradingAgent()
    agent.run_cycle()


if __name__ == "__main__":
    main()

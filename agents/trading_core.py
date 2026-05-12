"""
Autonomous Trading Agent - Multi-Market Portfolio Builder
Implements: CAPM, Sharpe Ratio, Jensen's Alpha, Beta Regression, 
            Logarithmic Returns, 10Y Bond Benchmark
Markets: Stocks (via Alpaca), Crypto, Forex, Commodities (synthetic)
"""

import os
import json
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from pathlib import Path
import math

import numpy as np
import pandas as pd
from dotenv import load_dotenv
import alpaca_trade_api as tradeapi
from alpaca_trade_api.rest import REST

# Load credentials securely
env_path = Path(__file__).parent / "alpaca.env"
load_dotenv(env_path)

# Configuration
ALPACA_API_KEY = os.getenv("ALPACA_API_KEY")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY")
ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"
ALPACA_DATA_URL = "https://data.alpaca.markets"

# Logging setup
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
    """Represents any tradable asset across markets"""
    symbol: str
    market: str  # 'stock', 'crypto', 'forex', 'commodity'
    sector: str
    current_price: float = 0.0
    log_returns: List[float] = None
    beta: float = 0.0
    alpha: float = 0.0
    sharpe: float = 0.0
    expected_return: float = 0.0
    risk: float = 0.0  # std dev of log returns
    weight: float = 0.0
    
    def __post_init__(self):
        if self.log_returns is None:
            self.log_returns = []


@dataclass
class Portfolio:
    """Portfolio with logarithmic measurement"""
    name: str
    assets: Dict[str, Asset]
    benchmark_return: float = 0.0
    total_value: float = 0.0
    log_return: float = 0.0
    volatility: float = 0.0
    sharpe_ratio: float = 0.0
    jensen_alpha: float = 0.0
    treynor_ratio: float = 0.0
    
    def calculate_metrics(self, risk_free_rate: float = 0.04):
        """Calculate all portfolio metrics using log returns"""
        if not self.assets:
            return
            
        weights = []
        returns = []
        risks = []
        betas = []
        
        for asset in self.assets.values():
            weights.append(asset.weight)
            returns.append(asset.expected_return)
            risks.append(asset.risk)
            betas.append(asset.beta)
        
        weights = np.array(weights)
        returns = np.array(returns)
        risks = np.array(risks)
        betas = np.array(betas)
        
        # Portfolio expected return (weighted)
        self.log_return = np.sum(weights * returns)
        
        # Portfolio volatility (simplified, assumes some correlation)
        # For more accuracy, we'd need covariance matrix
        self.volatility = np.sqrt(np.sum((weights * risks) ** 2))
        
        # Sharpe Ratio using log returns
        excess_return = self.log_return - risk_free_rate
        self.sharpe_ratio = excess_return / self.volatility if self.volatility > 0 else 0
        
        # Portfolio beta (weighted average)
        portfolio_beta = np.sum(weights * betas)
        
        # Jensen's Alpha
        # Alpha = Portfolio Return - [Risk Free + Beta * (Market Return - Risk Free)]
        market_premium = self.benchmark_return - risk_free_rate
        expected_by_capm = risk_free_rate + portfolio_beta * market_premium
        self.jensen_alpha = self.log_return - expected_by_capm
        
        # Treynor Ratio
        self.treynor_ratio = excess_return / portfolio_beta if portfolio_beta > 0 else 0
        
        logger.info(f"Portfolio '{self.name}' metrics calculated:")
        logger.info(f"  Log Return: {self.log_return:.4f}")
        logger.info(f"  Volatility: {self.volatility:.4f}")
        logger.info(f"  Sharpe: {self.sharpe_ratio:.4f}")
        logger.info(f"  Jensen Alpha: {self.jensen_alpha:.4f}")
        logger.info(f"  Treynor: {self.treynor_ratio:.4f}")


class MarketDataFeed:
    """Unified data feed for multiple markets"""
    
    def __init__(self):
        self.alpaca = REST(
            ALPACA_API_KEY,
            ALPACA_SECRET_KEY,
            ALPACA_PAPER_URL,
            api_version='v2'
        )
        
    def get_stock_bars(self, symbol: str, days: int = 252) -> pd.DataFrame:
        """Get historical stock data for analysis"""
        try:
            end = datetime.now()
            start = end - timedelta(days=days)
            
            bars = self.alpaca.get_bars(
                symbol,
                timeframe='1D',
                start=start.strftime('%Y-%m-%d'),
                end=end.strftime('%Y-%m-%d'),
                adjustment='all'
            ).df
            
            return bars
        except Exception as e:
            logger.error(f"Error fetching {symbol}: {e}")
            return pd.DataFrame()
    
    def get_log_returns(self, prices: pd.Series) -> np.ndarray:
        """Calculate logarithmic returns: ln(Pt / Pt-1)"""
        returns = np.log(prices / prices.shift(1)).dropna()
        return returns.values
    
    def get_10y_bond_yield(self) -> float:
        """Get current 10-year treasury yield as benchmark"""
        try:
            # Using ^TNX as proxy for 10-year yield
            bars = self.get_stock_bars('TNX', days=5)
            if not bars.empty:
                yield_pct = bars['close'].iloc[-1] / 100  # Convert from percentage
                return yield_pct
        except:
            pass
        
        # Fallback: use a reasonable estimate
        logger.warning("Using fallback 10Y yield: 4.2%")
        return 0.042


class FinancialAnalyzer:
    """Core financial models implementation"""
    
    def __init__(self, data_feed: MarketDataFeed):
        self.data_feed = data_feed
        self.risk_free_rate = data_feed.get_10y_bond_yield()
        
    def calculate_beta(self, stock_returns: np.ndarray, market_returns: np.ndarray) -> float:
        """
        Beta = Cov(stock, market) / Var(market)
        Measures systematic risk relative to market
        """
        if len(stock_returns) != len(market_returns):
            min_len = min(len(stock_returns), len(market_returns))
            stock_returns = stock_returns[-min_len:]
            market_returns = market_returns[-min_len:]
        
        covariance = np.cov(stock_returns, market_returns)[0, 1]
        market_variance = np.var(market_returns)
        
        beta = covariance / market_variance if market_variance != 0 else 1.0
        return beta
    
    def calculate_alpha(self, stock_returns: np.ndarray, market_returns: np.ndarray, beta: float) -> float:
        """
        Jensen's Alpha = Actual Return - Expected Return (by CAPM)
        Alpha > 0: Outperformed market (after risk adjustment)
        Alpha < 0: Underperformed
        """
        actual_return = np.mean(stock_returns)
        market_return = np.mean(market_returns)
        
        # CAPM: E(R) = Rf + Beta * (Rm - Rf)
        expected_return = self.risk_free_rate + beta * (market_return - self.risk_free_rate)
        
        alpha = actual_return - expected_return
        return alpha
    
    def calculate_sharpe(self, returns: np.ndarray) -> float:
        """
        Sharpe Ratio = (E[R] - Rf) / sigma(R)
        Risk-adjusted return measure
        """
        excess_return = np.mean(returns) - self.risk_free_rate
        volatility = np.std(returns)
        
        sharpe = excess_return / volatility if volatility > 0 else 0
        return sharpe
    
    def calculate_5_betas(self, stock_returns: np.ndarray, 
                         market_returns: np.ndarray,
                         size_returns: np.ndarray,
                         value_returns: np.ndarray,
                         momentum_returns: np.ndarray,
                         quality_returns: np.ndarray) -> Dict[str, float]:
        """
        Calculate the 5-factor model betas:
        1. Market beta (CAPM)
        2. Size beta (SMB)
        3. Value beta (HML)
        4. Momentum beta (MOM)
        5. Quality beta (QMJ)
        """
        betas = {}
        
        # Market beta
        betas['market'] = self.calculate_beta(stock_returns, market_returns)
        
        # Other factor betas (simplified - would need proper factor portfolios)
        betas['size'] = self.calculate_beta(stock_returns, size_returns) if len(size_returns) > 0 else 0
        betas['value'] = self.calculate_beta(stock_returns, value_returns) if len(value_returns) > 0 else 0
        betas['momentum'] = self.calculate_beta(stock_returns, momentum_returns) if len(momentum_returns) > 0 else 0
        betas['quality'] = self.calculate_beta(stock_returns, quality_returns) if len(quality_returns) > 0 else 0
        
        return betas
    
    def analyze_stock(self, symbol: str, market_symbol: str = 'SPY') -> Asset:
        """Full analysis of a single stock"""
        logger.info(f"Analyzing {symbol}...")
        
        # Get data
        stock_bars = self.data_feed.get_stock_bars(symbol, days=252)
        market_bars = self.data_feed.get_stock_bars(market_symbol, days=252)
        
        if stock_bars.empty or market_bars.empty:
            logger.warning(f"Insufficient data for {symbol}")
            return Asset(symbol=symbol, market='stock', sector='unknown')
        
        # Calculate log returns
        stock_returns = self.data_feed.get_log_returns(stock_bars['close'])
        market_returns = self.data_feed.get_log_returns(market_bars['close'])
        
        # Current price
        current_price = stock_bars['close'].iloc[-1]
        
        # Calculate metrics
        beta = self.calculate_beta(stock_returns, market_returns)
        alpha = self.calculate_alpha(stock_returns, market_returns, beta)
        sharpe = self.calculate_sharpe(stock_returns)
        
        expected_return = np.mean(stock_returns)
        risk = np.std(stock_returns)
        
        # Create asset
        asset = Asset(
            symbol=symbol,
            market='stock',
            sector='technology',  # Would need sector mapping
            current_price=current_price,
            log_returns=stock_returns.tolist(),
            beta=beta,
            alpha=alpha,
            sharpe=sharpe,
            expected_return=expected_return,
            risk=risk
        )
        
        logger.info(f"{symbol}: Beta={beta:.3f}, Alpha={alpha:.4f}, Sharpe={sharpe:.3f}")
        
        return asset


class PortfolioBuilder:
    """Build and optimize portfolios across markets"""
    
    def __init__(self, analyzer: FinancialAnalyzer):
        self.analyzer = analyzer
        self.portfolios: Dict[str, Portfolio] = {}
        
    def build_stock_portfolio(self, symbols: List[str], name: str = "Stocks_Core") -> Portfolio:
        """Build a stock portfolio with equal weights initially"""
        portfolio = Portfolio(name=name, assets={})
        
        for symbol in symbols:
            asset = self.analyzer.analyze_stock(symbol)
            portfolio.assets[symbol] = asset
            
        # Initial equal weighting
        n = len(symbols)
        for asset in portfolio.assets.values():
            asset.weight = 1.0 / n
            
        # Get benchmark return
        spy_bars = self.analyzer.data_feed.get_stock_bars('SPY', days=252)
        if not spy_bars.empty:
            spy_returns = self.analyzer.data_feed.get_log_returns(spy_bars['close'])
            portfolio.benchmark_return = np.mean(spy_returns)
        
        # Calculate portfolio metrics
        portfolio.calculate_metrics(self.analyzer.risk_free_rate)
        
        self.portfolios[name] = portfolio
        return portfolio
    
    def optimize_weights(self, portfolio: Portfolio, target: str = 'sharpe') -> Portfolio:
        """
        Optimize portfolio weights to maximize Sharpe ratio
        or minimize volatility, or maximize alpha
        """
        from scipy.optimize import minimize
        
        n = len(portfolio.assets)
        if n == 0:
            return portfolio
            
        symbols = list(portfolio.assets.keys())
        
        # Get returns matrix
        returns_matrix = np.array([
            portfolio.assets[s].log_returns for s in symbols
        ])
        
        # Ensure same length
        min_len = min(len(r) for r in returns_matrix)
        returns_matrix = np.array([r[-min_len:] for r in returns_matrix])
        
        # Expected returns and covariance
        expected_returns = np.array([portfolio.assets[s].expected_return for s in symbols])
        cov_matrix = np.cov(returns_matrix)
        
        def negative_sharpe(weights):
            port_return = np.sum(weights * expected_returns)
            port_vol = np.sqrt(np.dot(weights.T, np.dot(cov_matrix, weights)))
            return -(port_return - self.analyzer.risk_free_rate) / port_vol
        
        def portfolio_volatility(weights):
            return np.sqrt(np.dot(weights.T, np.dot(cov_matrix, weights)))
        
        constraints = {'type': 'eq', 'fun': lambda x: np.sum(x) - 1}
        bounds = tuple((0, 0.5) for _ in range(n))  # Max 50% in any single asset
        
        initial_weights = np.array([1.0 / n] * n)
        
        if target == 'sharpe':
            result = minimize(negative_sharpe, initial_weights, 
                            method='SLSQP', bounds=bounds, constraints=constraints)
        elif target == 'min_vol':
            result = minimize(portfolio_volatility, initial_weights,
                            method='SLSQP', bounds=bounds, constraints=constraints)
        else:
            result = minimize(negative_sharpe, initial_weights,
                            method='SLSQP', bounds=bounds, constraints=constraints)
        
        # Update weights
        optimized_weights = result.x
        for i, symbol in enumerate(symbols):
            portfolio.assets[symbol].weight = optimized_weights[i]
        
        # Recalculate
        portfolio.calculate_metrics(self.analyzer.risk_free_rate)
        
        logger.info(f"Optimized portfolio '{portfolio.name}' for {target}")
        logger.info(f"New weights: {dict(zip(symbols, optimized_weights))}")
        
        return portfolio


class TradingAgent:
    """
    Autonomous trading agent that can:
    1. Screen markets for opportunities
    2. Build multiple independent portfolios
    3. Compare performance using log returns
    4. Rebalance based on efficiency
    """
    
    def __init__(self):
        self.data_feed = MarketDataFeed()
        self.analyzer = FinancialAnalyzer(self.data_feed)
        self.builder = PortfolioBuilder(self.analyzer)
        self.portfolios: Dict[str, Portfolio] = {}
        
        # Universe of assets to screen
        self.stock_universe = [
            'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA',  # Tech
            'JPM', 'BAC', 'GS', 'MS',  # Financials
            'JNJ', 'PFE', 'UNH',  # Healthcare
            'XOM', 'CVX', 'COP',  # Energy
            'TSLA', 'F', 'GM',  # Automotive
            'SPY', 'QQQ', 'IWM', 'VTI'  # ETFs
        ]
        
        self.tech_universe = [
            'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA',
            'META', 'NFLX', 'CRM', 'ADBE', 'ORCL',
            'INTC', 'AMD', 'TSM', 'AVGO', 'TXN'
        ]
        
    async def screen_opportunities(self, universe: List[str] = None) -> List[Asset]:
        """Screen universe for best opportunities based on risk-adjusted returns"""
        if universe is None:
            universe = self.stock_universe
            
        opportunities = []
        
        for symbol in universe:
            try:
                asset = self.analyzer.analyze_stock(symbol)
                
                # Score: combine alpha and sharpe
                score = asset.alpha + asset.sharpe * 0.5
                
                if score > 0 and asset.sharpe > 0.5:  # Thresholds
                    opportunities.append(asset)
                    logger.info(f"OPPORTUNITY: {symbol} | Alpha: {asset.alpha:.4f} | Sharpe: {asset.sharpe:.3f}")
                    
            except Exception as e:
                logger.error(f"Error screening {symbol}: {e}")
                
        # Sort by score
        opportunities.sort(key=lambda x: x.alpha + x.sharpe * 0.5, reverse=True)
        
        return opportunities
    
    async def build_multiple_portfolios(self) -> Dict[str, Portfolio]:
        """Build independent portfolios for different strategies"""
        
        # Portfolio 1: Tech-focused (high growth, high beta)
        tech_assets = ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'META']
        tech_portfolio = self.builder.build_stock_portfolio(tech_assets, "Tech_Aggressive")
        tech_portfolio = self.builder.optimize_weights(tech_portfolio, 'sharpe')
        self.portfolios['tech'] = tech_portfolio
        
        # Portfolio 2: Diversified core (SPY-like)
        core_assets = ['SPY', 'QQQ', 'VTI', 'IWM']
        core_portfolio = self.builder.build_stock_portfolio(core_assets, "Core_Diversified")
        core_portfolio = self.builder.optimize_weights(core_portfolio, 'min_vol')
        self.portfolios['core'] = core_portfolio
        
        # Portfolio 3: Value/Sector rotation
        value_assets = ['JPM', 'JNJ', 'XOM', 'CVX', 'BAC']
        value_portfolio = self.builder.build_stock_portfolio(value_assets, "Value_Sector")
        value_portfolio = self.builder.optimize_weights(value_portfolio, 'sharpe')
        self.portfolios['value'] = value_portfolio
        
        return self.portfolios
    
    def compare_portfolios(self) -> pd.DataFrame:
        """Compare all portfolios using logarithmic metrics"""
        data = []
        
        for name, portfolio in self.portfolios.items():
            data.append({
                'Portfolio': name,
                'Log_Return': portfolio.log_return,
                'Volatility': portfolio.volatility,
                'Sharpe': portfolio.sharpe_ratio,
                'Jensen_Alpha': portfolio.jensen_alpha,
                'Treynor': portfolio.treynor_ratio,
                'Efficiency_Score': portfolio.sharpe_ratio * portfolio.jensen_alpha
            })
            
        df = pd.DataFrame(data)
        
        logger.info("\n" + "="*60)
        logger.info("PORTFOLIO COMPARISON (Logarithmic Metrics)")
        logger.info("="*60)
        logger.info(f"\n{df.to_string(index=False)}")
        
        return df
    
    def select_best_portfolio(self) -> str:
        """Select the best performing portfolio based on efficiency"""
        best_name = None
        best_score = -float('inf')
        
        for name, portfolio in self.portfolios.items():
            # Combined score: Sharpe * Alpha (both positive is good)
            score = portfolio.sharpe_ratio * portfolio.jensen_alpha
            
            if score > best_score:
                best_score = score
                best_name = name
                
        logger.info(f"\n🏆 BEST PORTFOLIO: {best_name} (Score: {best_score:.4f})")
        
        return best_name
    
    async def run_cycle(self):
        """One full cycle: screen, build, compare, select"""
        logger.info("\n" + "="*60)
        logger.info("STARTING TRADING AGENT CYCLE")
        logger.info("="*60)
        
        # Step 1: Screen for opportunities
        logger.info("\n[1] Screening market opportunities...")
        opportunities = await self.screen_opportunities(self.tech_universe)
        
        # Step 2: Build portfolios
        logger.info("\n[2] Building independent portfolios...")
        await self.build_multiple_portfolios()
        
        # Step 3: Compare
        logger.info("\n[3] Comparing portfolio efficiency...")
        comparison = self.compare_portfolios()
        
        # Step 4: Select best
        logger.info("\n[4] Selecting optimal strategy...")
        best = self.select_best_portfolio()
        
        # Step 5: Save results
        self.save_results(comparison)
        
        logger.info("\n[✓] Cycle complete.")
        
        return best
    
    def save_results(self, comparison: pd.DataFrame):
        """Save analysis results"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        # Save comparison
        comparison.to_csv(f'portfolio_comparison_{timestamp}.csv', index=False)
        
        # Save detailed portfolio data
        for name, portfolio in self.portfolios.items():
            data = {
                'name': portfolio.name,
                'metrics': {
                    'log_return': portfolio.log_return,
                    'volatility': portfolio.volatility,
                    'sharpe': portfolio.sharpe_ratio,
                    'alpha': portfolio.jensen_alpha,
                    'treynor': portfolio.treynor_ratio
                },
                'assets': {
                    sym: {
                        'price': a.current_price,
                        'beta': a.beta,
                        'alpha': a.alpha,
                        'sharpe': a.sharpe,
                        'weight': a.weight,
                        'expected_return': a.expected_return,
                        'risk': a.risk
                    }
                    for sym, a in portfolio.assets.items()
                }
            }
            
            with open(f'portfolio_{name}_{timestamp}.json', 'w') as f:
                json.dump(data, f, indent=2)
        
        logger.info(f"Results saved with timestamp {timestamp}")


async def main():
    """Main execution"""
    agent = TradingAgent()
    
    # Run one cycle
    best_portfolio = await agent.run_cycle()
    
    print(f"\n🏆 Best Portfolio: {best_portfolio}")
    print(f"Check the generated CSV and JSON files for detailed results.")


if __name__ == "__main__":
    asyncio.run(main())

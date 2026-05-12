"""
Agente de Trading - Análisis Diario
Ejecuta ciclo completo cada día, guarda historia, detecta cambios.
"""

import os
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
import alpaca_trade_api as tradeapi
from dotenv import load_dotenv

env_path = Path(__file__).parent / "alpaca.env"
load_dotenv(env_path)

ALPACA_API_KEY = os.getenv("ALPACA_API_KEY")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY")
ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('daily_analysis.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


class DailyAnalyzer:
    """Analizador diario de mercado"""
    
    def __init__(self):
        self.alpaca = tradeapi.REST(
            ALPACA_API_KEY, ALPACA_SECRET_KEY,
            ALPACA_PAPER_URL, api_version='v2'
        )
        self.today = datetime.now().strftime('%Y-%m-%d')
        self.history_file = 'daily_history.json'
        
        # Universos
        self.universes = {
            'tech': ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'NFLX', 'CRM', 'AMD', 'TSM'],
            'finance': ['JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'BLK'],
            'energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'MPC'],
            'healthcare': ['JNJ', 'UNH', 'PFE', 'ABBV', 'LLY', 'MRK', 'TMO'],
            'core': ['SPY', 'QQQ', 'VTI', 'IWM', 'VTV', 'VOO']
        }
        
    def get_data(self, symbol: str, days: int = 60) -> pd.DataFrame:
        """Datos recientes para análisis de corto plazo"""
        try:
            ticker = yf.Ticker(symbol)
            df = ticker.history(period=f"{days}d", interval="1d")
            return df
        except Exception as e:
            logger.error(f"Error {symbol}: {e}")
            return pd.DataFrame()
    
    def calc_log_returns(self, prices: pd.Series) -> np.ndarray:
        return np.log(prices / prices.shift(1)).dropna().values
    
    def analyze_asset(self, symbol: str, market_sym: str = 'SPY') -> Dict:
        """Análisis completo de un activo"""
        df_stock = self.get_data(symbol, 60)
        df_market = self.get_data(market_sym, 60)
        
        if df_stock.empty or df_market.empty or len(df_stock) < 10:
            return None
        
        stock_ret = self.calc_log_returns(df_stock['Close'])
        market_ret = self.calc_log_returns(df_market['Close'])
        
        # Alinear longitudes
        min_len = min(len(stock_ret), len(market_ret))
        stock_ret = stock_ret[-min_len:]
        market_ret = market_ret[-min_len:]
        
        price = float(df_stock['Close'].iloc[-1])
        prev_price = float(df_stock['Close'].iloc[-2]) if len(df_stock) > 1 else price
        daily_change = (price - prev_price) / prev_price * 100 if prev_price > 0 else 0
        
        # Beta
        cov = np.cov(stock_ret, market_ret)[0, 1]
        var = np.var(market_ret)
        beta = cov / var if var != 0 else 1.0
        
        # Retornos
        expected_return = np.mean(stock_ret)
        volatility = np.std(stock_ret)
        
        # Sharpe (usando 4.5% anual ~= 0.00018 diario)
        risk_free_daily = 0.00018
        sharpe = (expected_return - risk_free_daily) / volatility if volatility > 0 else 0
        
        # Alpha de Jensen
        market_return = np.mean(market_ret)
        expected_capm = risk_free_daily + beta * (market_return - risk_free_daily)
        alpha = expected_return - expected_capm
        
        return {
            'symbol': symbol,
            'price': round(price, 2),
            'daily_change_pct': round(daily_change, 2),
            'beta': round(beta, 3),
            'alpha': round(alpha, 4),
            'sharpe': round(sharpe, 3),
            'expected_return_daily': round(expected_return, 4),
            'volatility_daily': round(volatility, 4),
            'data_points': len(stock_ret)
        }
    
    def analyze_universe(self, universe_name: str) -> List[Dict]:
        """Analiza todo un universo de activos"""
        symbols = self.universes.get(universe_name, [])
        results = []
        
        logger.info(f"Analizando universo '{universe_name}' ({len(symbols)} activos)...")
        
        for sym in symbols:
            result = self.analyze_asset(sym)
            if result:
                results.append(result)
                logger.info(f"  {sym}: β={result['beta']}, α={result['alpha']}, Sharpe={result['sharpe']}, Δ={result['daily_change_pct']}%")
        
        # Ordenar por score combinado
        results.sort(key=lambda x: x['alpha'] + x['sharpe'] * 0.5, reverse=True)
        return results
    
    def build_portfolio(self, assets: List[Dict], name: str) -> Dict:
        """Construye portafolio con pesos optimizados manualmente"""
        if not assets:
            return {'name': name, 'assets': [], 'metrics': {}}
        
        # Tomar top 5 por score
        top_assets = assets[:5]
        
        # Pesos inversos a volatilidad (menos volatil = más peso)
        inv_vols = [1 / max(a['volatility_daily'], 0.001) for a in top_assets]
        total_inv = sum(inv_vols)
        weights = [v / total_inv for v in inv_vols]
        
        # Normalizar a suma 1
        weights = [w / sum(weights) for w in weights]
        
        # Calcular métricas del portafolio
        rets = np.array([a['expected_return_daily'] for a in top_assets])
        vols = np.array([a['volatility_daily'] for a in top_assets])
        betas = np.array([a['beta'] for a in top_assets])
        w = np.array(weights)
        
        port_return = np.sum(w * rets)
        port_vol = np.sqrt(np.sum((w * vols) ** 2))
        port_beta = np.sum(w * betas)
        
        risk_free = 0.00018
        sharpe = (port_return - risk_free) / port_vol if port_vol > 0 else 0
        market_premium = 0.0005  # Aproximado
        alpha = port_return - (risk_free + port_beta * market_premium)
        
        portfolio = {
            'name': name,
            'date': self.today,
            'assets': [
                {
                    'symbol': a['symbol'],
                    'weight': round(w[i], 4),
                    'price': a['price'],
                    'beta': a['beta'],
                    'alpha': a['alpha'],
                    'sharpe': a['sharpe']
                }
                for i, a in enumerate(top_assets)
            ],
            'metrics': {
                'expected_return_daily': round(port_return, 4),
                'volatility_daily': round(port_vol, 4),
                'beta': round(port_beta, 3),
                'sharpe': round(sharpe, 3),
                'jensen_alpha': round(alpha, 4),
                'score': round(sharpe * alpha, 4)
            }
        }
        
        return portfolio
    
    def run_daily_cycle(self) -> Dict:
        """Ciclo completo de un día"""
        logger.info("\n" + "="*70)
        logger.info(f"ANÁLISIS DIARIO - {self.today}")
        logger.info("="*70)
        
        daily_results = {
            'date': self.today,
            'timestamp': datetime.now().isoformat(),
            'universes': {},
            'portfolios': {}
        }
        
        # Analizar cada universo
        for universe_name in self.universes.keys():
            assets = self.analyze_universe(universe_name)
            daily_results['universes'][universe_name] = assets
            
            # Construir portafolio para este universo
            portfolio = self.build_portfolio(assets, f"{universe_name.capitalize()}_Daily")
            daily_results['portfolios'][universe_name] = portfolio
            
            logger.info(f"\n📊 Portafolio {universe_name.upper()}:")
            for a in portfolio['assets']:
                logger.info(f"  {a['symbol']}: {a['weight']:.1%} (β={a['beta']}, Sharpe={a['sharpe']})")
            logger.info(f"  → Sharpe: {portfolio['metrics']['sharpe']}, Alpha: {portfolio['metrics']['jensen_alpha']}")
        
        # Seleccionar mejor portafolio del día
        best_universe = None
        best_score = -float('inf')
        
        for name, port in daily_results['portfolios'].items():
            score = port['metrics']['score']
            if score > best_score:
                best_score = score
                best_universe = name
        
        daily_results['best_portfolio'] = best_universe
        daily_results['best_score'] = best_score
        
        logger.info(f"\n🏆 MEJOR PORTAFOLIO HOY: {best_universe.upper()} (Score: {best_score:.4f})")
        
        return daily_results
    
    def save_results(self, results: Dict):
        """Guarda resultados en historia"""
        # Guardar archivo del día
        filename = f"daily_{self.today}.json"
        with open(filename, 'w') as f:
            json.dump(results, f, indent=2)
        
        # Actualizar historia acumulada
        history = []
        if os.path.exists(self.history_file):
            try:
                with open(self.history_file, 'r') as f:
                    history = json.load(f)
            except:
                pass
        
        # Agregar resumen del día
        summary = {
            'date': results['date'],
            'best_portfolio': results['best_portfolio'],
            'best_score': results['best_score'],
            'portfolios': {
                name: {
                    'sharpe': p['metrics']['sharpe'],
                    'alpha': p['metrics']['jensen_alpha'],
                    'beta': p['metrics']['beta']
                }
                for name, p in results['portfolios'].items()
            }
        }
        
        history.append(summary)
        
        with open(self.history_file, 'w') as f:
            json.dump(history, f, indent=2)
        
        logger.info(f"\n💾 Resultados guardados: {filename}")
    
    def generate_report(self) -> str:
        """Genera reporte comparativo si hay historia"""
        if not os.path.exists(self.history_file):
            return "No hay historial aún."
        
        with open(self.history_file, 'r') as f:
            history = json.load(f)
        
        if len(history) < 2:
            return f"Solo {len(history)} día en historial. Necesitas más días para comparar."
        
        # Analizar tendencias
        report = []
        report.append("\n" + "="*70)
        report.append("REPORTE DE TENDENCIAS - ÚLTIMOS DÍAS")
        report.append("="*70)
        
        # Tabla de portafolios ganadores
        report.append(f"\n{'Fecha':<12} {'Ganador':<15} {'Score':<10} {'Sharpe':<8} {'Alpha':<8}")
        report.append("-" * 60)
        
        for day in history[-10:]:  # Últimos 10 días
            winner = day['best_portfolio']
            score = day['best_score']
            sharpe = day['portfolios'][winner]['sharpe']
            alpha = day['portfolios'][winner]['alpha']
            report.append(f"{day['date']:<12} {winner.upper():<15} {score:<10.4f} {sharpe:<8.3f} {alpha:<8.4f}")
        
        # Conteo de victorias
        report.append("\n" + "-" * 60)
        report.append("VICTORIAS POR PORTAFOLIO (últimos días):")
        wins = {}
        for day in history:
            w = day['best_portfolio']
            wins[w] = wins.get(w, 0) + 1
        
        for port, count in sorted(wins.items(), key=lambda x: x[1], reverse=True):
            pct = count / len(history) * 100
            report.append(f"  {port.upper():<15}: {count} días ({pct:.1f}%)")
        
        report.append("="*70)
        
        return "\n".join(report)
    
    def check_alpaca_positions(self) -> List[Dict]:
        """Ver posiciones actuales en Alpaca Paper"""
        try:
            positions = self.alpaca.list_positions()
            result = []
            for pos in positions:
                result.append({
                    'symbol': pos.symbol,
                    'qty': int(pos.qty),
                    'avg_entry': float(pos.avg_entry_price),
                    'current': float(pos.current_price),
                    'market_value': float(pos.market_value),
                    'unrealized_pl': float(pos.unrealized_pl),
                    'unrealized_plpc': float(pos.unrealized_plpc) * 100
                })
            return result
        except Exception as e:
            logger.error(f"Error obteniendo posiciones: {e}")
            return []
    
    def print_positions(self):
        """Muestra posiciones actuales"""
        positions = self.check_alpaca_positions()
        
        if not positions:
            print("\n📭 No hay posiciones abiertas en Alpaca Paper Trading.")
            return
        
        print("\n" + "="*70)
        print("POSICIONES ACTUALES - ALPACA PAPER TRADING")
        print("="*70)
        print(f"{'Símbolo':<10} {'Cant':<6} {'Entrada':<10} {'Actual':<10} {'Valor':<12} {'P&L':<10}")
        print("-" * 70)
        
        total_value = 0
        total_pl = 0
        
        for pos in positions:
            print(f"{pos['symbol']:<10} {pos['qty']:<6} ${pos['avg_entry']:<9.2f} ${pos['current']:<9.2f} "
                  f"${pos['market_value']:<11.2f} {pos['unrealized_plpc']:+.2f}%")
            total_value += pos['market_value']
            total_pl += pos['unrealized_pl']
        
        print("-" * 70)
        print(f"{'TOTAL':<10} {'':<6} {'':<10} {'':<10} ${total_value:<11.2f} ${total_pl:+.2f}")
        print("="*70)


def main():
    analyzer = DailyAnalyzer()
    
    # Correr análisis de hoy
    results = analyzer.run_daily_cycle()
    analyzer.save_results(results)
    
    # Mostrar posiciones actuales
    analyzer.print_positions()
    
    # Mostrar reporte de tendencias
    report = analyzer.generate_report()
    print(report)
    
    print("\n✅ Análisis diario completo.")
    print("💡 Consejo: Corre este script cada día antes de la apertura del mercado.")


if __name__ == "__main__":
    main()

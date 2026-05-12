"""
Modo SUEÑO del Agente de Trading
Análisis profundo de historia, patrones, claves de movimiento.
Corre en background, escribe hallazgos para que el agente despierte más listo.
"""

import os
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Tuple
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('dream_analysis.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


class DreamAnalyzer:
    """
    Analiza años de datos mientras el mercado duerme.
    Busca:
    - Qué precedió los mayores movimientos (+20%, -20%)
    - Patrones estacionales
    - Correlaciones entre activos en crisis y en boom
    - Factores que anticipan cambios de régimen (alto beta -> bajo beta)
    """
    
    def __init__(self):
        self.memory_file = 'dream_memory.json'
        self.insights_file = 'dream_insights.md'
        
        self.universes = {
            'tech': ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'NFLX', 'CRM', 'AMD', 'TSM', 'INTC', 'ADBE'],
            'finance': ['JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'BLK', 'AXP'],
            'energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'MPC', 'PSX'],
            'healthcare': ['JNJ', 'UNH', 'PFE', 'ABBV', 'LLY', 'MRK', 'TMO', 'ABT'],
            'macro': ['SPY', 'QQQ', 'VTI', 'IWM', 'TLT', 'GLD', 'VIX', 'DXY', 'USO']
        }
        
    def get_historical_data(self, symbol: str, years: int = 3) -> pd.DataFrame:
        """Baja años de datos para análisis profundo"""
        try:
            ticker = yf.Ticker(symbol)
            df = ticker.history(period=f"{years}y", interval="1d")
            if df.empty:
                return pd.DataFrame()
            df['LogReturn'] = np.log(df['Close'] / df['Close'].shift(1))
            df['PctChange'] = df['Close'].pct_change() * 100
            return df.dropna()
        except Exception as e:
            logger.error(f"Error descargando {symbol}: {e}")
            return pd.DataFrame()
    
    def find_major_movements(self, df: pd.DataFrame, threshold: float = 8.0) -> List[Dict]:
        """
        Encuentra días con movimientos extremos (>+8% o <-8%)
        y analiza qué pasó antes
        """
        events = []
        df = df.copy()
        
        for idx in range(10, len(df) - 5):
            pct = df['PctChange'].iloc[idx]
            
            if abs(pct) >= threshold:
                # Ventana de 10 días antes y 5 después
                before = df.iloc[idx-10:idx]
                after = df.iloc[idx:idx+5]
                
                event = {
                    'date': df.index[idx].strftime('%Y-%m-%d'),
                    'symbol': None,  # se llena después
                    'move_pct': round(pct, 2),
                    'direction': 'UP' if pct > 0 else 'DOWN',
                    'volume_spike': round(
                        df['Volume'].iloc[idx] / before['Volume'].mean(), 2
                    ) if 'Volume' in df.columns and before['Volume'].mean() > 0 else 1.0,
                    'volatility_before': round(before['PctChange'].std(), 2),
                    'volatility_after': round(after['PctChange'].std(), 2),
                    'days_declining_before': int((before['Close'].diff() < 0).sum()),
                    'days_rising_before': int((before['Close'].diff() > 0).sum()),
                    'avg_return_before': round(before['PctChange'].mean(), 3),
                    'avg_return_after': round(after['PctChange'].mean(), 3),
                }
                events.append(event)
        
        return events
    
    def analyze_seasonality(self, df: pd.DataFrame) -> Dict:
        """
        Análisis estacional: qué meses/días suelen ser mejores
        """
        df = df.copy()
        df['Month'] = df.index.month
        df['DayOfWeek'] = df.index.dayofweek
        df['Year'] = df.index.year
        
        monthly = df.groupby('Month')['PctChange'].agg(['mean', 'std', 'count'])
        best_month = monthly['mean'].idxmax()
        worst_month = monthly['mean'].idxmin()
        
        dow = df.groupby('DayOfWeek')['PctChange'].mean()
        day_names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
        best_dow = day_names[dow.idxmax()]
        worst_dow = day_names[dow.idxmin()]
        
        return {
            'best_month': best_month,
            'best_month_avg_return': round(monthly.loc[best_month, 'mean'], 3),
            'worst_month': worst_month,
            'worst_month_avg_return': round(monthly.loc[worst_month, 'mean'], 3),
            'best_dayofweek': best_dow,
            'worst_dayofweek': worst_dow,
            'january_effect': round(monthly.loc[1, 'mean'], 3) if 1 in monthly.index else None,
            'october_effect': round(monthly.loc[10, 'mean'], 3) if 10 in monthly.index else None,
        }
    
    def find_beta_regime_changes(self, df: pd.DataFrame, market_df: pd.DataFrame, window: int = 60) -> List[Dict]:
        """
        Encuentra momentos donde el beta de un activo cambió drásticamente
        respecto al mercado. Eso suele anticipar cambio de tendencia.
        """
        if len(df) < window * 3 or len(market_df) < window * 3:
            return []
        
        # Alinear
        merged = pd.merge(
            df[['LogReturn']].rename(columns={'LogReturn': 'stock'}),
            market_df[['LogReturn']].rename(columns={'LogReturn': 'market'}),
            left_index=True, right_index=True
        ).dropna()
        
        if len(merged) < window * 2:
            return []
        
        changes = []
        for i in range(window, len(merged) - window, window // 2):
            before = merged.iloc[i-window:i]
            after = merged.iloc[i:i+window]
            
            beta_before = np.cov(before['stock'], before['market'])[0,1] / np.var(before['market'])
            beta_after = np.cov(after['stock'], after['market'])[0,1] / np.var(after['market'])
            
            if abs(beta_after - beta_before) > 0.5:  # Cambio significativo
                changes.append({
                    'date': merged.index[i].strftime('%Y-%m-%d'),
                    'beta_before': round(beta_before, 2),
                    'beta_after': round(beta_after, 2),
                    'change': round(beta_after - beta_before, 2),
                    'direction': 'More_Market_Sensitive' if beta_after > beta_before else 'Less_Market_Sensitive',
                    'avg_return_after': round(after['stock'].mean(), 4)
                })
        
        return changes
    
    def analyze_correlation_matrix(self, data_dict: Dict[str, pd.DataFrame]) -> pd.DataFrame:
        """
        Matriz de correlación logarítmica entre todos los activos
        Útil para detectar activos que se mueven juntos o divergen
        """
        returns = {}
        for sym, df in data_dict.items():
            if not df.empty and 'LogReturn' in df.columns:
                returns[sym] = df['LogReturn']
        
        if len(returns) < 2:
            return pd.DataFrame()
        
        ret_df = pd.DataFrame(returns).dropna()
        corr = ret_df.corr()
        
        return corr
    
    def generate_insights(self, events: Dict[str, List[Dict]], 
                         seasonality: Dict[str, Dict],
                         beta_changes: Dict[str, List[Dict]],
                         corr_matrix: pd.DataFrame) -> str:
        """
        Genera un texto de insights que el agente leerá al despertar
        """
        lines = []
        lines.append("# 🌙 Insights del Modo Sueño")
        lines.append(f"\n*Generado: {datetime.now().strftime('%Y-%m-%d %H:%M')}*")
        lines.append("*Análisis histórico profundo de los últimos 3 años*\n")
        
        # Eventos extremos
        lines.append("## 📢 Eventos Extremos Detectados\n")
        all_events = []
        for sym, evs in events.items():
            for e in evs:
                e['symbol'] = sym
                all_events.append(e)
        
        if all_events:
            all_events.sort(key=lambda x: abs(x['move_pct']), reverse=True)
            lines.append("### Movimientos más extremos:\n")
            for e in all_events[:10]:
                lines.append(f"- **{e['symbol']}** el {e['date']}: {e['move_pct']:+.1f}% ({e['direction']})")
                lines.append(f"  - Volumen x{e['volume_spike']} vs promedio")
                lines.append(f"  - Volatilidad antes: {e['volatility_before']}, después: {e['volatility_after']}")
                lines.append(f"  - Días bajando antes: {e['days_declining_before']}, subiendo: {e['days_rising_before']}")
        
        # Claves de movimientos
        lines.append("\n## 🔑 Claves que Precedieron Movimientos Extremos\n")
        
        ups = [e for e in all_events if e['direction'] == 'UP']
        downs = [e for e in all_events if e['direction'] == 'DOWN']
        
        if ups:
            avg_decline_before_up = np.mean([e['days_declining_before'] for e in ups])
            lines.append(f"- **Antes de subidas +8%:** promedio de {avg_decline_before_up:.1f} días bajando consecutivos")
            lines.append(f"- Volumen promedio previo: x{np.mean([e['volume_spike'] for e in ups]):.1f}")
        
        if downs:
            avg_rise_before_down = np.mean([e['days_rising_before'] for e in downs])
            lines.append(f"- **Antes de caídas -8%:** promedio de {avg_rise_before_down:.1f} días subiendo consecutivos")
            lines.append(f"- Volumen promedio previo: x{np.mean([e['volume_spike'] for e in downs]):.1f}")
        
        # Estacionalidad
        lines.append("\n## 📅 Patrones Estacionales\n")
        for sym, seas in seasonality.items():
            lines.append(f"\n### {sym}:")
            lines.append(f"- Mejor mes: {seas['best_month']} (retorno avg: {seas['best_month_avg_return']:+.2f}%)")
            lines.append(f"- Peor mes: {seas['worst_month']} (retorno avg: {seas['worst_month_avg_return']:+.2f}%)")
            lines.append(f"- Mejor día de semana: {seas['best_dayofweek']}")
            if seas.get('january_effect'):
                lines.append(f"- Efecto enero: {seas['january_effect']:+.3f}% diario promedio")
        
        # Cambios de beta
        lines.append("\n## 🔄 Cambios de Regimen (Beta)\n")
        total_changes = sum(len(v) for v in beta_changes.values())
        lines.append(f"Se detectaron {total_changes} cambios significativos de beta en 3 años.\n")
        
        for sym, changes in beta_changes.items():
            if changes:
                more_sensitive = [c for c in changes if c['direction'] == 'More_Market_Sensitive']
                less_sensitive = [c for c in changes if c['direction'] == 'Less_Market_Sensitive']
                lines.append(f"- **{sym}**: {len(more_sensitive)} veces se volvió más sensitivo al mercado, {len(less_sensitive)} veces menos.")
        
        lines.append("\n### Qué significa:")
        lines.append("- Cuando un activo **aumenta su beta** repentinamente, suele seguir volatilidad alta.")
        lines.append("- Cuando **disminuye su beta**, puede estar desacoplando (o preparando divergencia).")
        
        # Correlaciones
        if not corr_matrix.empty:
            lines.append("\n## 🔗 Correlaciones Importantes\n")
            # Top correlaciones
            corr_pairs = []
            for i in range(len(corr_matrix.columns)):
                for j in range(i+1, len(corr_matrix.columns)):
                    corr_pairs.append({
                        'pair': f"{corr_matrix.columns[i]}-{corr_matrix.columns[j]}",
                        'corr': corr_matrix.iloc[i, j]
                    })
            
            corr_pairs.sort(key=lambda x: abs(x['corr']), reverse=True)
            lines.append("### Pares más correlacionados (log-returns):\n")
            for p in corr_pairs[:10]:
                lines.append(f"- {p['pair']}: {p['corr']:.3f}")
        
        # Recomendaciones generadas
        lines.append("\n## 💡 Recomendaciones para el Agente Despierto\n")
        lines.append("1. **Si un activo tiene 5+ días bajando con volumen creciente →** alta probabilidad de reverso al alza.")
        lines.append("2. **Si beta aumenta >0.5 en una semana →** reducir posición, volatilidad incoming.")
        lines.append("3. **Si correlación SPY-QQQ baja de 0.95 →** mercado fragmentado, oportunidad de divergencia.")
        lines.append("4. **Octubre y enero →** revisar seasonality antes de tomar posiciones grandes.")
        lines.append("5. **Volumen x3+ en un día verde después de 3 días rojos →** señal de capitulación/compra.")
        
        return "\n".join(lines)
    
    def dream(self):
        """Ciclo completo de sueño"""
        logger.info("\n" + "="*70)
        logger.info("🌙 INICIANDO MODO SUEÑO - ANÁLISIS PROFUNDO DE HISTORIA")
        logger.info("="*70)
        
        # Descargar datos
        all_data = {}
        for category, symbols in self.universes.items():
            logger.info(f"\n📥 Descargando {category}: {symbols}")
            for sym in symbols:
                df = self.get_historical_data(sym, years=3)
                if not df.empty:
                    all_data[sym] = df
                    logger.info(f"  {sym}: {len(df)} días descargados")
        
        # Análisis por activo
        events = {}
        seasonality = {}
        beta_changes = {}
        
        market_data = all_data.get('SPY')
        
        for sym, df in all_data.items():
            logger.info(f"\n🔍 Analizando {sym}...")
            
            # Eventos extremos
            evs = self.find_major_movements(df, threshold=7.0)
            if evs:
                events[sym] = evs
                logger.info(f"  {len(evs)} eventos extremos detectados")
            
            # Estacionalidad
            seas = self.analyze_seasonality(df)
            seasonality[sym] = seas
            
            # Cambios de beta
            if market_data is not None and sym != 'SPY':
                changes = self.find_beta_regime_changes(df, market_data)
                if changes:
                    beta_changes[sym] = changes
                    logger.info(f"  {len(changes)} cambios de régimen de beta")
        
        # Matriz de correlación
        logger.info("\n🔗 Calculando matriz de correlación...")
        corr_matrix = self.analyze_correlation_matrix(all_data)
        
        # Generar insights
        logger.info("\n📝 Generando insights...")
        insights = self.generate_insights(events, seasonality, beta_changes, corr_matrix)
        
        # Guardar
        with open(self.insights_file, 'w') as f:
            f.write(insights)
        
        # Guardar datos crudos
        memory = {
            'timestamp': datetime.now().isoformat(),
            'assets_analyzed': len(all_data),
            'total_events': sum(len(v) for v in events.values()),
            'seasonality_keys': list(seasonality.keys()),
            'beta_changes_count': sum(len(v) for v in beta_changes.values()),
        }
        
        with open(self.memory_file, 'w') as f:
            json.dump(memory, f, indent=2)
        
        logger.info("\n" + "="*70)
        logger.info("✅ MODO SUEÑO COMPLETADO")
        logger.info(f"📄 Insights guardados en: {self.insights_file}")
        logger.info(f"🧠 Memoria guardada en: {self.memory_file}")
        logger.info("="*70)


def main():
    dreamer = DreamAnalyzer()
    dreamer.dream()


if __name__ == "__main__":
    main()

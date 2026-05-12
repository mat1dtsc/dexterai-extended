# DexterAI Extended — Ecosistema completo

## Estructura

```
dexterai-extended/
├── server.js, lib/, routes/, cron/, tests/  # Servidor Node.js
├── agents/                                    # Agentes Python
│   ├── daily.py
│   ├── sleep.py
│   ├── trading.py
│   └── trading_core.py
├── portfolios/                                # Portfolios generados
├── historical/                                # Datos históricos
├── insights/                                  # Análisis y insights
├── boti/                                      # Bot Python adicional
├── config/                                    # Configuraciones
├── data/                                      # Base de datos SQLite
└── README.md
```

## Agentes Python

| Agente | Archivo | Qué hace |
|--------|---------|----------|
| Daily | `agents/daily.py` | Análisis diario del mercado |
| Sleep | `agents/sleep.py` | Análisis nocturno / contexto |
| Trading | `agents/trading.py` | Agente de trading activo |
| Core | `agents/trading_core.py` | Motor central de decisiones |

## Portfolios

En `portfolios/` — archivos JSON generados por los agentes.

## Configuración

Copiá `config/alpaca.env.example` a `config/alpaca.env` y completá tus API keys.
**NUNCA subas `alpaca.env` a GitHub.**

## Inicio rápido

```bash
# Node.js server
npm install
npm run init-db
npm start

# Python agents (en otra terminal)
cd agents
pip install -r requirements.txt
python trading_core.py
```

## Datos que NO van al repo

- `config/alpaca.env` (tiene API keys secretas)
- `*.log` (se regeneran automáticamente)
- Virtualenvs (`boti_env/`)
- Diarios personales (`memorized_diary/`)
- Memoria de agente (`memory/`, `memory_consolidation/`)

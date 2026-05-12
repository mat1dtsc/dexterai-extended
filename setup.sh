#!/bin/bash
#
# setup.sh — Instalación automática de DexterAI Extended
# Uso: bash setup.sh
#

set -e

echo ""
echo "========================================="
echo "  DexterAI Extended — Instalador Local"
echo "========================================="
echo ""

# ─── Verificar Node.js ─────────────────────────────────────────────────────
echo "[1/6] Verificando Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js no está instalado."
    echo "   Descargalo de https://nodejs.org (recomendado: v20 LTS)"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "⚠️  Node.js $NODE_VERSION detectado. Se recomienda v18+"
    read -p "¿Continuar de todos modos? (s/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Ss]$ ]]; then
        exit 1
    fi
fi

echo "✅ Node.js $(node -v) detectado"

# ─── Verificar Git ─────────────────────────────────────────────────────────
echo ""
echo "[2/6] Verificando Git..."
if ! command -v git &> /dev/null; then
    echo "❌ Git no está instalado."
    echo "   Descargalo de https://git-scm.com"
    exit 1
fi
echo "✅ Git detectado"

# ─── Clonar o actualizar repo ──────────────────────────────────────────────
echo ""
echo "[3/6] Descargando proyecto..."
if [ -d "dexterai-extended" ]; then
    echo "📁 Directorio existe. Actualizando..."
    cd dexterai-extended
    git pull origin main
else
    echo "📥 Clonando repositorio..."
    git clone https://github.com/mat1dtsc/dexterai-extended.git
    cd dexterai-extended
fi

# ─── Instalar dependencias ─────────────────────────────────────────────────
echo ""
echo "[4/6] Instalando dependencias..."
npm install
echo "✅ Dependencias instaladas"

# ─── Inicializar base de datos ─────────────────────────────────────────────
echo ""
echo "[5/6] Inicializando base de datos..."
npm run init-db
echo "✅ Base de datos creada"

# ─── Iniciar servidor ──────────────────────────────────────────────────────
echo ""
echo "[6/6] ¡Listo! Iniciando servidor..."
echo ""
echo "========================================="
echo "  🚀 Servidor iniciando en puerto 3005"
echo ""
echo "  📊 Dashboard: http://localhost:3005"
echo "  🔍 Health:    http://localhost:3005/health"
echo "  📰 Noticias:  http://localhost:3005/api/intelligence/news?symbol=AAPL"
echo ""
echo "  ⏱️  Alertas: cada 5 minutos"
echo "  📡 Noticias: cada 15 minutos"
echo ""
echo "  Presioná Ctrl+C para detener"
echo "========================================="
echo ""

npm start

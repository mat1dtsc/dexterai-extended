"""
openbb_worker/start.py — Arranca OpenBB Platform API en localhost:6900

Loopback only, sin auth (es solo para que el Node server local le pegue).
Lee FRED_API_KEY de openbb_worker/.env si existe.
"""
import os
import sys
import logging
from pathlib import Path

WORKER_DIR = Path(__file__).parent
LOG_FILE = WORKER_DIR / "openbb.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("openbb_worker")


def load_env():
    env_file = WORKER_DIR / ".env"
    if not env_file.exists():
        log.info(".env no existe — usando solo proveedores sin auth")
        return
    try:
        from dotenv import load_dotenv
        load_dotenv(env_file)
        log.info("Cargado %s", env_file)
    except ImportError:
        log.warning("python-dotenv no instalado, salteando .env")


def configure_credentials():
    """Setea credenciales en obb.user.credentials si las hay en env."""
    try:
        from openbb import obb
    except ImportError:
        log.error("openbb no instalado. Corre: pip install -r requirements.txt")
        sys.exit(1)

    fred_key = os.environ.get("FRED_API_KEY", "").strip()
    if fred_key:
        try:
            obb.user.credentials.fred_api_key = fred_key
            log.info("FRED_API_KEY configurada")
        except Exception as e:
            log.warning("No pude setear FRED key: %s", e)
    else:
        log.info("Sin FRED_API_KEY — endpoints /economy/* limitados")


def main():
    load_env()
    configure_credentials()

    host = os.environ.get("OPENBB_HOST", "127.0.0.1")
    port = int(os.environ.get("OPENBB_PORT", "6900"))

    log.info("Arrancando OpenBB Platform API en %s:%d", host, port)

    # openbb-platform-api expone el servidor FastAPI auto-generado
    try:
        import uvicorn
        from openbb_platform_api.main import app
    except ImportError as e:
        log.error("openbb-platform-api no instalado: %s", e)
        log.error("Corre: pip install -r requirements.txt")
        sys.exit(1)

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()

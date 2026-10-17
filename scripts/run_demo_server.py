"""Levanta una instancia de demostración aislada para revisar la app en el navegador.

- Usa una base de datos temporal con datos de ejemplo (seed_demo_instance.py); nunca toca backend/agenda.db.
- Crea un dueño de prueba con las credenciales de abajo para poder pasar el login.

Uso:  backend\\.venv\\Scripts\\python scripts\\run_demo_server.py   →  http://127.0.0.1:8010
"""
import os
import secrets
import sys

# Credenciales SOLO de la instancia demo local (no son las del dueño real).
DEMO_EMAIL = "demo@midiario.test"
DEMO_PASSWORD = "demo-midiario-2026"
DEMO_PORT = int(os.getenv("DEMO_PORT", "8010"))

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(SCRIPTS_DIR, "..", "backend")
sys.path.insert(0, SCRIPTS_DIR)

import seed_demo_instance  # noqa: E402  (fija AGENDA_DB a la BD temporal de demo)

os.environ["OWNER_EMAIL"] = DEMO_EMAIL
os.environ["OWNER_USER_ID"] = "me"
os.environ["JWT_SECRET"] = secrets.token_hex(32)
os.environ["CORS_ORIGINS"] = ""

assert "agenda.db" != os.path.basename(seed_demo_instance.DEMO_DB_PATH), "La demo no puede usar la BD real"

import uvicorn  # noqa: E402

import auth  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402


def run():
    seed_demo_instance.seed_demo_database()
    db.set_password_hash("me", auth.hash_password(DEMO_PASSWORD))
    print(f"Demo en http://127.0.0.1:{DEMO_PORT}  (BD: {seed_demo_instance.DEMO_DB_PATH})")
    uvicorn.run(main.app, host="127.0.0.1", port=DEMO_PORT, log_level="warning")


if __name__ == "__main__":
    run()

import os
import sys
import time
import socket
import tempfile
import subprocess
import json
import secrets
import urllib.request
from datetime import datetime, timedelta, timezone

import jwt

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")

def get_free_test_port():
    for _ in range(100):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        if port not in (8000, 8001):
            return port
    raise RuntimeError("Could not find free port for test server")

def make_test_session(user_id: str, jwt_secret: str, session_version: int = 0) -> dict:
    """Emite una sesión JWT válida 24h, igual a la que devuelve /auth/login."""
    expires = datetime.now(timezone.utc) + timedelta(days=1)
    token = jwt.encode({"sub": user_id, "sv": session_version, "exp": int(expires.timestamp())}, jwt_secret, algorithm="HS256")
    return {"token": token, "expires_at": expires.strftime("%Y-%m-%dT%H:%M:%SZ"), "profile": {}}


def launch_authed_browser(playwright, session: dict, **launch_kwargs):
    """Lanza Chromium y hace que cada página o contexto nuevo arranque con la sesión guardada en localStorage."""
    launch_kwargs.setdefault("headless", True)
    browser = playwright.chromium.launch(**launch_kwargs)
    script = f"try {{ localStorage.setItem('diary_session', {json.dumps(json.dumps(session))}); }} catch (e) {{}}"
    original_new_context = browser.new_context

    def new_context(*args, **kwargs):
        ctx = original_new_context(*args, **kwargs)
        ctx.add_init_script(script)
        return ctx

    def new_page(*args, **kwargs):
        ctx = new_context(*args, **kwargs)
        page = ctx.new_page()

        def close_context(_):
            try:
                ctx.close()
            except Exception:
                pass  # el navegador ya se cerró

        page.on("close", close_context)
        return page

    browser.new_context = new_context
    browser.new_page = new_page
    return browser


class TestServerRunner:
    def __init__(self, prefix="agenda_test_"):
        self.temp_dir = tempfile.mkdtemp(prefix=prefix)
        self.temp_db = os.path.join(self.temp_dir, "test_agenda.db")
        
        # Security assertions: verify DB path is isolated & temporary
        assert "tmp" in self.temp_db.lower() or "temp" in self.temp_db.lower(), f"CRITICAL ERROR: AGENDA_DB ({self.temp_db}) must be temporary!"
        assert os.path.abspath(self.temp_db) != os.path.abspath(os.path.join(BACKEND_DIR, "agenda.db")), "CRITICAL ERROR: Test server MUST NOT use real agenda.db!"

        self.port = get_free_test_port()
        assert self.port not in (8000, 8001), f"CRITICAL ERROR: Test server port MUST NOT be 8000 or 8001! Got {self.port}"

        self.url = f"http://127.0.0.1:{self.port}"
        self.proc = None

        # Autenticación de prueba: clave y contraseña aleatorias por ejecución y sesión ya emitida.
        # start() fija la contraseña en una BD nueva, lo que deja session_version en 1.
        self.user_id = "test_user"
        self.email = "test@example.com"
        self.password = secrets.token_urlsafe(12)
        self.jwt_secret = secrets.token_hex(32)
        self.session = make_test_session(self.user_id, self.jwt_secret, session_version=1)
        self.token = self.session["token"]
        self.auth_headers = {"Authorization": f"Bearer {self.token}"}

    def start(self):
        env = os.environ.copy()
        env["AGENDA_DB"] = self.temp_db
        env["DATABASE_PATH"] = self.temp_db
        env["JWT_SECRET"] = self.jwt_secret
        env["OWNER_USER_ID"] = self.user_id
        env["OWNER_EMAIL"] = self.email
        env["PYTHONPATH"] = BACKEND_DIR

        subprocess.run(
            [sys.executable, "set_password.py", "--stdin"],
            input=self.password + "\n", text=True, cwd=BACKEND_DIR, env=env, check=True, capture_output=True
        )

        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(self.port)],
            cwd=BACKEND_DIR,
            env=env
        )

        # Wait for server to respond
        start_time = time.time()
        connected = False
        while time.time() - start_time < 12:
            try:
                urllib.request.urlopen(f"{self.url}/", timeout=1)
                connected = True
                break
            except Exception:
                time.sleep(0.2)

        if not connected:
            self.stop()
            raise RuntimeError(f"Test server failed to start on {self.url} within timeout.")

        return self

    def launch_browser(self, playwright, **launch_kwargs):
        return launch_authed_browser(playwright, self.session, **launch_kwargs)

    def stop(self):
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=3)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None

        if os.path.exists(self.temp_dir):
            try:
                import shutil
                shutil.rmtree(self.temp_dir, ignore_errors=True)
            except Exception:
                pass

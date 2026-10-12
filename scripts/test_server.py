import os
import sys
import time
import socket
import tempfile
import subprocess
import urllib.request

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

    def start(self):
        env = os.environ.copy()
        env["AGENDA_DB"] = self.temp_db
        env["DATABASE_PATH"] = self.temp_db
        env["DEFAULT_USER_ID"] = "test_user"
        env["PYTHONPATH"] = BACKEND_DIR

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

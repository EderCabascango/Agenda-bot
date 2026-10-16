"""Tests de autenticación (correo + contraseña con JWT propio) y perfil.
Verifica que la API falla cerrado, el login del dueño, el cambio de contraseña
(que cierra las demás sesiones), el límite de intentos y el CRUD del perfil.
"""
import os
import subprocess
import sys
import tempfile
import time

import jwt
import pytest

os.environ["AGENDA_DB"] = os.path.join(tempfile.mkdtemp(), "test_auth.db")
os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 32)

from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)
OWNER = "dueno@example.com"
PASSWORD = "clave-segura-123"
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


@pytest.fixture(autouse=True)
def owner_env(monkeypatch):
    monkeypatch.setenv("OWNER_EMAIL", OWNER)
    monkeypatch.setenv("OWNER_USER_ID", "owner_test")
    db.set_password_hash("owner_test", auth.hash_password(PASSWORD))
    auth.login_limiter.reset()
    yield
    auth.login_limiter.reset()


def _login(email=OWNER, password=PASSWORD):
    return client.post("/auth/login", json={"email": email, "password": password})


def _bearer(user="owner_test"):
    return {"Authorization": f"Bearer {auth.issue_session(user)['token']}"}


def test_password_hashing_roundtrip():
    stored = auth.hash_password("secreto-largo")
    assert stored.startswith("scrypt$") and "secreto-largo" not in stored
    assert auth.verify_password("secreto-largo", stored)
    assert not auth.verify_password("otra-cosa", stored)
    assert not auth.verify_password("x", "formato-invalido")


def test_protected_routes_reject_missing_token():
    for method, path in [("get", "/activities"), ("post", "/sync"), ("get", "/profile"), ("get", "/auth/me")]:
        res = client.post(path, json={}) if method == "post" else client.get(path)
        assert res.status_code == 401, path


def test_legacy_user_header_no_longer_grants_access():
    res = client.get("/activities", headers={"X-User-Id": "me", "X-App-Token": "x"})
    assert res.status_code == 401


def test_invalid_and_expired_tokens_are_rejected():
    assert client.get("/activities", headers={"Authorization": "Bearer basura"}).status_code == 401
    forged = jwt.encode({"sub": "owner_test", "exp": int(time.time()) + 60}, "otra-clave-" + "y" * 32, algorithm="HS256")
    assert client.get("/activities", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
    expired = jwt.encode({"sub": "owner_test", "exp": int(time.time()) - 10}, os.environ["JWT_SECRET"], algorithm="HS256")
    res = client.get("/activities", headers={"Authorization": f"Bearer {expired}"})
    assert res.status_code == 401 and "caducado" in res.json()["detail"]


def test_fails_closed_without_jwt_secret(monkeypatch):
    headers = _bearer()
    monkeypatch.delenv("JWT_SECRET")
    assert client.get("/activities", headers=headers).status_code == 503


def test_fails_closed_without_owner_email(monkeypatch):
    monkeypatch.delenv("OWNER_EMAIL")
    assert _login().status_code == 503


def test_fails_closed_without_password_set(monkeypatch):
    monkeypatch.setenv("OWNER_USER_ID", "sin_clave")
    res = _login()
    assert res.status_code == 503 and "set_password" in res.json()["detail"]


def test_login_issues_session_for_owner():
    res = _login(email="  Dueno@Example.com ")
    assert res.status_code == 200
    data = res.json()
    assert data["profile"]["email"] == OWNER
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {data['token']}"})
    assert me.status_code == 200 and me.json()["user_id"] == "owner_test"


def test_login_rejects_wrong_email_or_password_with_same_message():
    wrong_pass = _login(password="incorrecta")
    wrong_mail = _login(email="intruso@example.com")
    assert wrong_pass.status_code == wrong_mail.status_code == 401
    assert wrong_pass.json()["detail"] == wrong_mail.json()["detail"]


def test_login_rate_limit():
    codes = [_login(password="mal").status_code for _ in range(auth.LOGIN_RATE_LIMIT + 1)]
    assert codes[:-1] == [401] * auth.LOGIN_RATE_LIMIT
    assert codes[-1] == 429


def test_change_password_closes_other_sessions():
    other_device = {"Authorization": f"Bearer {_login().json()['token']}"}
    this_device = {"Authorization": f"Bearer {_login().json()['token']}"}

    bad = client.post("/auth/change-password", json={"current_password": "mal", "new_password": "nueva-clave-456"}, headers=this_device)
    assert bad.status_code == 400
    short = client.post("/auth/change-password", json={"current_password": PASSWORD, "new_password": "corta"}, headers=this_device)
    assert short.status_code == 400

    res = client.post("/auth/change-password", json={"current_password": PASSWORD, "new_password": "nueva-clave-456"}, headers=this_device)
    assert res.status_code == 200
    new_headers = {"Authorization": f"Bearer {res.json()['token']}"}

    assert client.get("/profile", headers=new_headers).status_code == 200
    assert client.get("/profile", headers=other_device).status_code == 401
    assert client.get("/profile", headers=this_device).status_code == 401
    assert _login(password=PASSWORD).status_code == 401
    assert _login(password="nueva-clave-456").status_code == 200


def test_profile_update_and_validation():
    h = _bearer("profile_user")
    res = client.put("/profile", json={"first_name": "Wladimir", "last_name": "Eder", "role": "Estudiante"}, headers=h)
    assert res.status_code == 200
    assert client.get("/profile", headers=h).json()["last_name"] == "Eder"

    photo = "data:image/jpeg;base64," + "A" * 100
    assert client.put("/profile", json={"photo": photo}, headers=h).json()["photo"] == photo
    assert client.put("/profile", json={"photo": "javascript:alert(1)"}, headers=h).status_code == 400
    assert client.put("/profile", json={"photo": "https://example.com/x.png"}, headers=h).status_code == 400
    assert client.put("/profile", json={"first_name": "x" * 200}, headers=h).status_code == 400


def test_set_password_cli(tmp_path):
    env = {**os.environ, "AGENDA_DB": str(tmp_path / "cli.db"), "OWNER_EMAIL": OWNER, "OWNER_USER_ID": "cli_user"}
    run = lambda pw: subprocess.run([sys.executable, "set_password.py", "--stdin"], input=pw + "\n",  # noqa: E731
                                    capture_output=True, text=True, cwd=BACKEND_DIR, env=env)
    assert run("corta").returncode == 1
    ok = run("clave-de-prueba-789")
    assert ok.returncode == 0, ok.stderr
    with db._conn(str(tmp_path / "cli.db")) as conn:
        stored = conn.execute("SELECT password_hash FROM credentials WHERE user_id='cli_user'").fetchone()[0]
    assert auth.verify_password("clave-de-prueba-789", stored)

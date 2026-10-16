"""Tests de autenticación (Google + JWT propio) y perfil.
Verifica que la API falla cerrado, que solo el email autorizado entra,
el límite de intentos de login y el CRUD del perfil.
"""
import os
import tempfile
import time

import jwt
import pytest

os.environ["AGENDA_DB"] = os.path.join(tempfile.mkdtemp(), "test_auth.db")
os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 32)

from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)
ALLOWED = "dueno@example.com"


@pytest.fixture(autouse=True)
def google_env(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client.apps.googleusercontent.com")
    monkeypatch.setenv("ALLOWED_EMAIL", ALLOWED)
    monkeypatch.setenv("OWNER_USER_ID", "owner_test")
    auth.login_limiter.reset()
    yield
    auth.login_limiter.reset()


def _fake_google(monkeypatch, email=ALLOWED, verified=True):
    claims = {"email": email, "email_verified": verified, "given_name": "Ana", "family_name": "Pérez",
              "picture": "https://lh3.googleusercontent.com/a/foto"}
    monkeypatch.setattr("google.oauth2.id_token.verify_oauth2_token", lambda *a, **k: claims)


def _bearer(user="owner_test"):
    return {"Authorization": f"Bearer {auth.issue_session(user)['token']}"}


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


def test_fails_closed_without_google_config(monkeypatch):
    monkeypatch.delenv("ALLOWED_EMAIL")
    _fake_google(monkeypatch)
    assert client.post("/auth/google", json={"credential": "x"}).status_code == 503


def test_google_login_issues_session_for_owner(monkeypatch):
    _fake_google(monkeypatch, email="Dueno@Example.com")
    res = client.post("/auth/google", json={"credential": "token-google"})
    assert res.status_code == 200
    data = res.json()
    assert data["profile"]["first_name"] == "Ana" and data["profile"]["email"] == ALLOWED
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {data['token']}"})
    assert me.status_code == 200 and me.json()["user_id"] == "owner_test"


def test_google_login_rejects_other_or_unverified_email(monkeypatch):
    _fake_google(monkeypatch, email="intruso@example.com")
    assert client.post("/auth/google", json={"credential": "x"}).status_code == 403
    _fake_google(monkeypatch, verified=False)
    assert client.post("/auth/google", json={"credential": "x"}).status_code == 403


def test_google_login_rejects_invalid_google_token(monkeypatch):
    def boom(*a, **k):
        raise ValueError("bad token")
    monkeypatch.setattr("google.oauth2.id_token.verify_oauth2_token", boom)
    assert client.post("/auth/google", json={"credential": "x"}).status_code == 401


def test_login_rate_limit(monkeypatch):
    _fake_google(monkeypatch, email="intruso@example.com")
    codes = [client.post("/auth/google", json={"credential": "x"}).status_code for _ in range(auth.LOGIN_RATE_LIMIT + 1)]
    assert codes[:-1] == [403] * auth.LOGIN_RATE_LIMIT
    assert codes[-1] == 429


def test_profile_update_and_validation():
    h = _bearer("profile_user")
    res = client.put("/profile", json={"first_name": "Wladimir", "last_name": "Eder", "role": "Estudiante"}, headers=h)
    assert res.status_code == 200
    assert client.get("/profile", headers=h).json()["last_name"] == "Eder"

    photo = "data:image/jpeg;base64," + "A" * 100
    assert client.put("/profile", json={"photo": photo}, headers=h).json()["photo"] == photo
    assert client.put("/profile", json={"photo": "javascript:alert(1)"}, headers=h).status_code == 400
    assert client.put("/profile", json={"first_name": "x" * 200}, headers=h).status_code == 400


def test_second_login_keeps_edited_profile(monkeypatch):
    h = _bearer()
    client.put("/profile", json={"first_name": "Nombre Propio"}, headers=h)
    _fake_google(monkeypatch)
    res = client.post("/auth/google", json={"credential": "x"})
    assert res.json()["profile"]["first_name"] == "Nombre Propio"


def test_auth_config_is_public():
    res = client.get("/auth/config")
    assert res.status_code == 200 and res.json()["google_client_id"].endswith("googleusercontent.com")

"""Autenticación de un único dueño mediante Google Sign-In + sesión JWT propia.

Falla cerrado: si falta GOOGLE_CLIENT_ID, ALLOWED_EMAIL o JWT_SECRET, ninguna ruta
protegida queda abierta.
"""
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Header, HTTPException, Request

SESSION_DAYS = 30
JWT_ALGORITHM = "HS256"
LOGIN_RATE_LIMIT = 10          # intentos
LOGIN_RATE_WINDOW_SECONDS = 60  # por ventana y por IP


def _jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET", "")
    if len(secret) < 32:
        raise HTTPException(503, "Autenticación no configurada en el servidor (JWT_SECRET).")
    return secret


def owner_user_id() -> str:
    return os.getenv("OWNER_USER_ID", "me")


def issue_session(user_id: str, email: str = "") -> dict:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=SESSION_DAYS)
    token = jwt.encode(
        {"sub": user_id, "email": email, "iat": int(now.timestamp()), "exp": int(exp.timestamp())},
        _jwt_secret(),
        algorithm=JWT_ALGORITHM,
    )
    return {"token": token, "expires_at": exp.strftime("%Y-%m-%dT%H:%M:%SZ")}


def require_user(authorization: str | None = Header(default=None)) -> str:
    """Dependencia de FastAPI: exige 'Authorization: Bearer <jwt>' válido y devuelve el user_id."""
    secret = _jwt_secret()
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sesión requerida.", headers={"WWW-Authenticate": "Bearer"})
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, secret, algorithms=[JWT_ALGORITHM], options={"require": ["sub", "exp"]})
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "La sesión ha caducado.", headers={"WWW-Authenticate": "Bearer"})
    except jwt.PyJWTError:
        raise HTTPException(401, "Sesión inválida.", headers={"WWW-Authenticate": "Bearer"})
    return str(payload["sub"])


def verify_google_token(credential: str) -> dict:
    """Verifica el ID token de Google y exige que sea del email autorizado. Devuelve sus claims."""
    client_id = os.getenv("GOOGLE_CLIENT_ID", "")
    allowed = os.getenv("ALLOWED_EMAIL", "").strip().lower()
    if not client_id or not allowed:
        raise HTTPException(503, "Inicio de sesión con Google no configurado en el servidor.")

    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    try:
        claims = id_token.verify_oauth2_token(credential, google_requests.Request(), client_id)
    except ValueError:
        raise HTTPException(401, "Token de Google inválido.")

    email = str(claims.get("email", "")).lower()
    if not claims.get("email_verified") or email != allowed:
        raise HTTPException(403, "Esta cuenta de Google no tiene acceso a la aplicación.")
    return claims


class RateLimiter:
    """Límite simple en memoria por clave (IP) con ventana deslizante."""

    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str):
        now = time.monotonic()
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if now - t < self.window]
            if len(hits) >= self.limit:
                self._hits[key] = hits
                raise HTTPException(429, "Demasiados intentos. Espera un minuto.")
            hits.append(now)
            self._hits[key] = hits

    def reset(self):
        with self._lock:
            self._hits.clear()


login_limiter = RateLimiter(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"

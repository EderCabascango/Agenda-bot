"""Autenticación de un único dueño con correo + contraseña y sesión JWT propia.

- La contraseña se guarda solo como hash scrypt (biblioteca estándar) en la tabla credentials.
- Se fija o restablece desde el servidor con `python set_password.py`; no hay registro público.
- Falla cerrado: sin JWT_SECRET u OWNER_EMAIL, o sin contraseña fijada, nadie entra.
- Cambiar la contraseña invalida las sesiones abiertas en otros dispositivos (session_version).
"""
import base64
import hashlib
import hmac
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Header, HTTPException, Request

import db

SESSION_DAYS = 30
JWT_ALGORITHM = "HS256"
MIN_PASSWORD_LENGTH = 8
LOGIN_RATE_LIMIT = 10          # intentos
LOGIN_RATE_WINDOW_SECONDS = 60  # por ventana y por IP

# Parámetros scrypt (≈16 MB de memoria por hash): lento para fuerza bruta, rápido para un login.
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_LEN = 2 ** 14, 8, 1, 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_LEN)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, digest_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest_b64)
        digest = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt_b64),
                                n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


# Hash de relleno para que un correo incorrecto tarde lo mismo que una contraseña incorrecta.
_DUMMY_HASH = hash_password(secrets.token_hex(16))


def validate_new_password(password: str):
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"La contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres.")
    if len(password) > 256:
        raise ValueError("La contraseña es demasiado larga.")


def _jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET", "")
    if len(secret) < 32:
        raise HTTPException(503, "Autenticación no configurada en el servidor (JWT_SECRET).")
    return secret


def owner_user_id() -> str:
    return os.getenv("OWNER_USER_ID", "me")


def owner_email() -> str:
    return os.getenv("OWNER_EMAIL", "").strip().lower()


def issue_session(user_id: str, email: str = "") -> dict:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=SESSION_DAYS)
    token = jwt.encode(
        {"sub": user_id, "email": email, "sv": db.get_session_version(user_id),
         "iat": int(now.timestamp()), "exp": int(exp.timestamp())},
        _jwt_secret(),
        algorithm=JWT_ALGORITHM,
    )
    return {"token": token, "expires_at": exp.strftime("%Y-%m-%dT%H:%M:%SZ")}


def require_user(authorization: str | None = Header(default=None)) -> str:
    """Dependencia de FastAPI: exige 'Authorization: Bearer <jwt>' válido y vigente; devuelve el user_id."""
    secret = _jwt_secret()
    unauthorized = lambda msg: HTTPException(401, msg, headers={"WWW-Authenticate": "Bearer"})  # noqa: E731
    if not authorization or not authorization.lower().startswith("bearer "):
        raise unauthorized("Sesión requerida.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, secret, algorithms=[JWT_ALGORITHM], options={"require": ["sub", "exp"]})
    except jwt.ExpiredSignatureError:
        raise unauthorized("La sesión ha caducado.")
    except jwt.PyJWTError:
        raise unauthorized("Sesión inválida.")
    user = str(payload["sub"])
    if int(payload.get("sv", 0)) != db.get_session_version(user):
        raise unauthorized("La sesión se cerró porque la contraseña cambió.")
    return user


def authenticate(email: str, password: str) -> str:
    """Comprueba correo y contraseña del dueño. Devuelve su user_id o lanza 401/503."""
    allowed = owner_email()
    if not allowed:
        raise HTTPException(503, "Inicio de sesión no configurado en el servidor (OWNER_EMAIL).")
    user = owner_user_id()
    stored = db.get_password_hash(user)
    if not stored:
        raise HTTPException(503, "Aún no se ha fijado la contraseña. Ejecuta 'python set_password.py' en el servidor.")
    email_ok = hmac.compare_digest(email.strip().lower().encode("utf-8"), allowed.encode("utf-8"))
    password_ok = verify_password(password, stored if email_ok else _DUMMY_HASH)
    if not (email_ok and password_ok):
        raise HTTPException(401, "Correo o contraseña incorrectos.")
    return user


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

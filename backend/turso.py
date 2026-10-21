"""Conexión a Turso (libSQL en la nube) con la misma interfaz que sqlite3.

db.py usa esta conexión cuando existe TURSO_DATABASE_URL; si no, sigue con el
archivo SQLite local. Habla el protocolo HTTP de Turso (Hrana v3 /v3/pipeline),
así que no necesita dependencias nativas y funciona en Vercel.

Imita lo que db.py usa de sqlite3: execute() con parámetros "?", fetchone/fetchall,
iteración, rowcount, filas accesibles por nombre o índice, commit/rollback y el
context manager que confirma o revierte. Como sqlite3, abre una transacción
implícita antes de INSERT/UPDATE/DELETE/REPLACE y la cierra en commit().
"""
import base64
import os

import httpx

_DML_PREFIXES = ("INSERT", "UPDATE", "DELETE", "REPLACE")
_client: httpx.Client | None = None


def _http() -> httpx.Client:
    # Un cliente compartido mantiene la conexión HTTPS viva entre consultas.
    global _client
    if _client is None:
        _client = httpx.Client(timeout=20.0)
    return _client


def _find_env(exact: str, suffix: str, value_prefix: tuple[str, ...] = ("",)) -> str:
    """La integración de Vercel antepone un prefijo elegido al crearla
    (p. ej. TURSO_DATABASE_DATABASE_URL), así que se acepta cualquier prefijo."""
    if os.getenv(exact):
        return os.environ[exact]
    for name, value in sorted(os.environ.items()):
        if name.startswith("TURSO") and name.endswith(suffix) and value.startswith(value_prefix):
            return value
    return ""


def database_url() -> str:
    return _find_env("TURSO_DATABASE_URL", "_URL", ("libsql://", "https://"))


def default_auth_token() -> str:
    return _find_env("TURSO_AUTH_TOKEN", "_TOKEN")


def is_configured() -> bool:
    return bool(database_url())


class TursoError(Exception):
    pass


class Row:
    """Equivalente a sqlite3.Row: acceso por índice o por nombre de columna."""
    __slots__ = ("_cols", "_values")

    def __init__(self, cols: list[str], values: tuple):
        self._cols = cols
        self._values = values

    def keys(self) -> list[str]:
        return list(self._cols)

    def __getitem__(self, key):
        if isinstance(key, (int, slice)):
            return self._values[key]
        try:
            return self._values[self._cols.index(key)]
        except ValueError:
            raise IndexError(f"No item with that key: {key}") from None

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __repr__(self):
        return f"Row({dict(zip(self._cols, self._values))})"


class Cursor:
    def __init__(self, rows: list[Row], rowcount: int, lastrowid: int | None):
        self._rows = rows
        self._pos = 0
        self.rowcount = rowcount
        self.lastrowid = lastrowid

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        row = self._rows[self._pos]
        self._pos += 1
        return row

    def fetchall(self):
        rest = self._rows[self._pos:]
        self._pos = len(self._rows)
        return rest

    def __iter__(self):
        while (row := self.fetchone()) is not None:
            yield row


def _encode(value) -> dict:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"type": "blob", "base64": base64.b64encode(bytes(value)).decode().rstrip("=")}
    return {"type": "text", "value": str(value)}


def _decode(cell: dict):
    kind = cell.get("type")
    if kind == "null":
        return None
    if kind == "integer":
        return int(cell["value"])
    if kind == "float":
        return float(cell["value"])
    if kind == "blob":
        data = cell.get("base64", "")
        return base64.b64decode(data + "=" * (-len(data) % 4))
    return cell.get("value")


class Connection:
    def __init__(self, url: str | None = None, auth_token: str | None = None):
        url = url or database_url()
        if url.startswith("libsql://"):
            url = "https://" + url[len("libsql://"):]
        self._base_url = url.rstrip("/")
        token = auth_token if auth_token is not None else default_auth_token()
        self._headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._baton: str | None = None
        self.in_transaction = False

    # --- protocolo ---------------------------------------------------------
    def _pipeline(self, sql: str, args: tuple, keep_stream: bool) -> dict:
        requests = [{"type": "execute", "stmt": {"sql": sql, "args": [_encode(a) for a in args]}}]
        if not keep_stream:
            requests.append({"type": "close"})
        resp = _http().post(
            f"{self._base_url}/v3/pipeline",
            json={"baton": self._baton, "requests": requests},
            headers=self._headers,
        )
        if resp.status_code >= 400:
            raise TursoError(f"Turso HTTP {resp.status_code}: {resp.text[:300]}")
        body = resp.json()
        # Turso puede indicar otra URL para seguir con el mismo stream.
        if body.get("base_url"):
            self._base_url = body["base_url"].rstrip("/")
        self._baton = body.get("baton") if keep_stream else None
        result = body["results"][0]
        if result.get("type") == "error":
            self._baton = None
            self.in_transaction = False
            raise TursoError(result["error"].get("message", "Error de Turso"))
        return result["response"]["result"]

    # --- API tipo sqlite3 --------------------------------------------------
    def execute(self, sql: str, params=()) -> Cursor:
        head = sql.lstrip().upper()
        if head.startswith("PRAGMA BUSY_TIMEOUT"):
            return Cursor([], -1, None)  # sin sentido en remoto
        if head.startswith("BEGIN"):
            self.in_transaction = True
        elif head.startswith(_DML_PREFIXES) and not self.in_transaction:
            self._pipeline("BEGIN", (), keep_stream=True)
            self.in_transaction = True

        is_end = head.startswith(("COMMIT", "END", "ROLLBACK"))
        keep = self.in_transaction and not is_end
        result = self._pipeline(sql, tuple(params or ()), keep_stream=keep)
        if is_end:
            self.in_transaction = False

        cols = [c.get("name") or "" for c in result.get("cols", [])]
        rows = [Row(cols, tuple(_decode(v) for v in r)) for r in result.get("rows", [])]
        last = result.get("last_insert_rowid")
        rowcount = result.get("affected_row_count", 0) if not cols else -1
        return Cursor(rows, rowcount, int(last) if last is not None else None)

    def commit(self):
        if self.in_transaction:
            self.execute("COMMIT")

    def rollback(self):
        if self.in_transaction:
            self.execute("ROLLBACK")

    def close(self):
        if self._baton:
            try:
                self.rollback()
            except Exception:
                pass
        self._baton = None
        self.in_transaction = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False


def connect(url: str | None = None, auth_token: str | None = None) -> Connection:
    return Connection(url, auth_token)

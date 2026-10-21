"""Copia el contenido de agenda.db (SQLite local) a la base de datos en la nube.

Dos formas de uso:
    # A través del servidor publicado (no necesita el token de Turso):
    .venv\\Scripts\\python migrar_a_turso.py --url https://tu-app.vercel.app

    # Directo a Turso (con TURSO_DATABASE_URL y TURSO_AUTH_TOKEN en backend/.env.turso):
    .venv\\Scripts\\python migrar_a_turso.py            # se niega si Turso ya tiene datos
    .venv\\Scripts\\python migrar_a_turso.py --force    # reemplaza lo que haya en Turso

El archivo local no se modifica. Por el servidor solo se importa si la nube está vacía.
"""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_DB = os.getenv("AGENDA_DB") or os.path.join(HERE, "agenda.db")
CHUNK_ROWS = 50


def export_local(path: str = LOCAL_DB) -> dict:
    """Esquema y filas de la base local en un dict serializable a JSON."""
    src = sqlite3.connect(path)
    src.row_factory = sqlite3.Row
    tables = []
    for t in src.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ):
        cur = src.execute(f'SELECT * FROM "{t["name"]}"')
        tables.append({
            "name": t["name"], "sql": t["sql"],
            "cols": [d[0] for d in cur.description],
            "rows": [list(r) for r in cur.fetchall()],
        })
    indexes = [r[0] for r in src.execute("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")]
    src.close()
    return {"tables": tables, "indexes": indexes}


def row_counts(dst, names) -> dict:
    remote = {r["name"] for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    return {n: dst.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names if n in remote}


def import_dump(dst, dump: dict, force: bool = False) -> dict:
    """Recrea las tablas del dump en dst (conexión tipo sqlite3) y copia las filas.
    Devuelve {tabla: filas copiadas}. Lanza ValueError si dst ya tiene datos y no se fuerza."""
    names = [t["name"] for t in dump["tables"]]
    existing = {k: v for k, v in row_counts(dst, names).items() if v}
    if existing and not force:
        raise ValueError(f"La base destino ya tiene datos: {existing}")

    for t in dump["tables"]:
        dst.execute(f'DROP TABLE IF EXISTS "{t["name"]}"')
        dst.execute(t["sql"])
    for ix in dump["indexes"]:
        dst.execute(ix.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ", 1))

    copied = {}
    for t in dump["tables"]:
        cols, rows = t["cols"], t["rows"]
        if rows:
            col_sql = ", ".join(f'"{c}"' for c in cols)
            one = "(" + ", ".join("?" * len(cols)) + ")"
            dst.execute("BEGIN")
            # Varias filas por INSERT: menos viajes a la base remota.
            for i in range(0, len(rows), CHUNK_ROWS):
                chunk = rows[i:i + CHUNK_ROWS]
                dst.execute(
                    f'INSERT INTO "{t["name"]}" ({col_sql}) VALUES {", ".join([one] * len(chunk))}',
                    tuple(v for r in chunk for v in r),
                )
            dst.commit()
        copied[t["name"]] = dst.execute(f'SELECT COUNT(*) FROM "{t["name"]}"').fetchone()[0]
        if copied[t["name"]] != len(rows):
            raise ValueError(f"{t['name']}: se copiaron {copied[t['name']]} de {len(rows)} filas")
    return copied


def _via_server(url: str) -> int:
    """Sube el dump al endpoint /admin/import del servidor publicado.
    La sesión se firma con el JWT_SECRET de backend/.env (el mismo que tiene Vercel)."""
    from datetime import datetime, timedelta, timezone

    import httpx
    import jwt
    from dotenv import load_dotenv

    load_dotenv(os.path.join(HERE, ".env"))
    secret = os.getenv("JWT_SECRET", "")
    if len(secret) < 32:
        print("Falta JWT_SECRET en backend/.env")
        return 1
    now = datetime.now(timezone.utc)
    # Con la nube vacía aún no hay credenciales: session_version es 0.
    token = jwt.encode(
        {"sub": os.getenv("OWNER_USER_ID", "me"), "sv": 0,
         "iat": int(now.timestamp()), "exp": int((now + timedelta(minutes=10)).timestamp())},
        secret, algorithm="HS256",
    )
    dump = export_local()
    resp = httpx.post(f"{url.rstrip('/')}/admin/import", json=dump,
                      headers={"Authorization": f"Bearer {token}"}, timeout=120)
    if resp.status_code != 200:
        print(f"Error {resp.status_code}: {resp.text[:500]}")
        return 1
    copied = resp.json()["copied"]
    for t in dump["tables"]:
        print(f"  {t['name']}: {copied.get(t['name'])}/{len(t['rows'])} filas")
    print("Migración completa.")
    return 0


def _direct(force: bool) -> int:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(HERE, ".env.turso"))
    import turso

    if not turso.is_configured():
        print("Falta TURSO_DATABASE_URL (y TURSO_AUTH_TOKEN).")
        return 1
    try:
        copied = import_dump(turso.connect(), export_local(), force=force)
    except ValueError as e:
        print(e)
        print("Usa --force para reemplazarlos.")
        return 1
    for name, n in copied.items():
        print(f"  {name}: {n} filas")
    print("Migración completa.")
    return 0


def main(argv: list[str]) -> int:
    if not os.path.isfile(LOCAL_DB):
        print(f"No existe {LOCAL_DB}")
        return 1
    if "--url" in argv:
        return _via_server(argv[argv.index("--url") + 1])
    return _direct("--force" in argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Persistencia en SQLite con soporte de sincronización incremental,
tombstones (deleted_at), resolución de conflictos por timestamp/versión
y backups automáticos.
"""
import json
import os
import shutil
import sqlite3
import uuid
from datetime import datetime, timezone

DB_PATH = os.getenv("AGENDA_DB", os.path.join(os.path.dirname(__file__), "agenda.db"))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _backup_db_if_exists(db_path: str):
    """Crea una copia de seguridad timestamped de la base de datos antes de aplicar migraciones."""
    if os.path.isfile(db_path) and os.path.getsize(db_path) > 0:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_path = f"{db_path}_backup_{ts}.db"
        if not os.path.exists(backup_path):
            try:
                shutil.copy2(db_path, backup_path)
            except Exception as e:
                print(f"[WARN] No se pudo crear backup de {db_path}: {e}")


def _migrate_schema(conn: sqlite3.Connection):
    """Aplica migraciones hacia adelante manteniendo retrocompatibilidad total."""
    conn.execute(
        """CREATE TABLE IF NOT EXISTS activities (
            user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
            start_time TEXT DEFAULT '', end_time TEXT DEFAULT '', description TEXT DEFAULT '',
            priority TEXT DEFAULT 'medium', tags TEXT DEFAULT '[]', completed INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, id))"""
    )
    cursor = conn.execute("PRAGMA table_info(activities)")
    cols = {row["name"] for row in cursor.fetchall()}

    now = utc_now_iso()
    if "updated_at" not in cols:
        conn.execute("ALTER TABLE activities ADD COLUMN updated_at TEXT DEFAULT ''")
        conn.execute("UPDATE activities SET updated_at = ? WHERE updated_at = '' OR updated_at IS NULL", (now,))
    if "deleted_at" not in cols:
        conn.execute("ALTER TABLE activities ADD COLUMN deleted_at TEXT DEFAULT NULL")
    if "version" not in cols:
        conn.execute("ALTER TABLE activities ADD COLUMN version INTEGER DEFAULT 1")
        conn.execute("UPDATE activities SET version = 1 WHERE version IS NULL")

    conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_sync ON activities (user_id, updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities (user_id, date)")


def _conn() -> sqlite3.Connection:
    _backup_db_if_exists(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    _migrate_schema(conn)
    return conn


def _row(r) -> dict:
    return {
        "id": r["id"],
        "title": r["title"],
        "date": r["date"],
        "startTime": r["start_time"],
        "endTime": r["end_time"],
        "description": r["description"],
        "priority": r["priority"],
        "tags": json.loads(r["tags"] or "[]"),
        "completed": bool(r["completed"]),
        "updated_at": r["updated_at"] or utc_now_iso(),
        "deleted_at": r["deleted_at"],
        "version": r["version"] or 1,
    }


def list_activities(
    user_id: str,
    start: str | None = None,
    end: str | None = None,
    since: str | None = None,
    include_deleted: bool = False
) -> list[dict]:
    """Lista actividades. Si se provee `since`, devuelve todas las modificadas después de esa fecha (incluyendo tombstones)."""
    q, args = "SELECT * FROM activities WHERE user_id=?", [user_id]
    if since:
        q += " AND updated_at > ?"
        args.append(since)
        if not include_deleted:
            # En sync incremental 'since', se suelen necesitar los tombstones; si no se piden, se filtran
            pass
    else:
        if not include_deleted:
            q += " AND deleted_at IS NULL"
        if start:
            q += " AND date >= ?"
            args.append(start)
        if end:
            q += " AND date <= ?"
            args.append(end)

    q += " ORDER BY date, start_time"
    with _conn() as c:
        return [_row(r) for r in c.execute(q, args)]


def get_activity(user_id: str, act_id: str, include_deleted: bool = True) -> dict | None:
    q = "SELECT * FROM activities WHERE user_id=? AND id=?"
    if not include_deleted:
        q += " AND deleted_at IS NULL"
    with _conn() as c:
        r = c.execute(q, (user_id, act_id)).fetchone()
    return _row(r) if r else None


def upsert_activity(user_id: str, a: dict) -> dict:
    a = {**a}
    if not a.get("id"):
        a["id"] = str(uuid.uuid4())

    now = utc_now_iso()
    existing = get_activity(user_id, a["id"], include_deleted=True)
    incoming_ver = a.get("version")
    if existing:
        new_version = (incoming_ver if incoming_ver is not None and incoming_ver > existing["version"]
                       else existing["version"] + 1)
    else:
        new_version = incoming_ver or 1

    updated_at = a.get("updated_at") or now
    deleted_at = a.get("deleted_at")

    with _conn() as c:
        c.execute(
            """INSERT INTO activities (user_id, id, title, date, start_time, end_time, description, priority, tags, completed, updated_at, deleted_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, id) DO UPDATE SET
               title=excluded.title, date=excluded.date, start_time=excluded.start_time,
               end_time=excluded.end_time, description=excluded.description, priority=excluded.priority,
               tags=excluded.tags, completed=excluded.completed, updated_at=excluded.updated_at,
               deleted_at=excluded.deleted_at, version=excluded.version""",
            (
                user_id, a["id"], a.get("title", ""), a.get("date", ""),
                a.get("startTime", ""), a.get("endTime", ""), a.get("description", ""),
                a.get("priority", "medium"), json.dumps(a.get("tags", [])),
                int(bool(a.get("completed", False))), updated_at, deleted_at, new_version
            ),
        )
    return get_activity(user_id, a["id"])


def delete_activity(user_id: str, act_id: str) -> bool:
    """Borrado lógico como tombstone para propagación en sincronización."""
    act = get_activity(user_id, act_id, include_deleted=False)
    if not act:
        return False
    act["deleted_at"] = utc_now_iso()
    act["updated_at"] = utc_now_iso()
    act["version"] = act.get("version", 1) + 1
    upsert_activity(user_id, act)
    return True


def sync_changes(user_id: str, changes: list[dict], since: str | None = None) -> dict:
    """Sincronización transaccional y no destructiva:
    1. Procesa cada cambio entrante con resolución de conflictos (gana el updated_at más reciente).
    2. Devuelve los cambios remotos ocurridos desde `since`.
    """
    applied = 0
    conflicts = []
    now = utc_now_iso()

    with _conn() as conn:
        for item in changes:
            if not isinstance(item, dict) or not item.get("id"):
                raise ValueError("Cada cambio debe contener un 'id' válido")

            act_id = item["id"]
            existing = get_activity(user_id, act_id, include_deleted=True)

            incoming_updated = item.get("updated_at") or now
            item_version = item.get("version") or 1

            if existing:
                existing_updated = existing["updated_at"]
                # Si el registro en servidor es más reciente que el entrante, se marca conflicto y no se sobreescribe
                if existing_updated and incoming_updated < existing_updated:
                    conflicts.append({"id": act_id, "server_version": existing["version"], "server_updated_at": existing_updated})
                    continue

                new_version = max(existing["version"] + 1, item_version)
            else:
                new_version = item_version

            conn.execute(
                """INSERT INTO activities (user_id, id, title, date, start_time, end_time, description, priority, tags, completed, updated_at, deleted_at, version)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(user_id, id) DO UPDATE SET
                   title=excluded.title, date=excluded.date, start_time=excluded.start_time,
                   end_time=excluded.end_time, description=excluded.description, priority=excluded.priority,
                   tags=excluded.tags, completed=excluded.completed, updated_at=excluded.updated_at,
                   deleted_at=excluded.deleted_at, version=excluded.version""",
                (
                    user_id, act_id, item.get("title", ""), item.get("date", ""),
                    item.get("startTime", ""), item.get("endTime", ""), item.get("description", ""),
                    item.get("priority", "medium"), json.dumps(item.get("tags", [])),
                    int(bool(item.get("completed", False))), incoming_updated,
                    item.get("deleted_at"), new_version
                ),
            )
            applied += 1

    # Obtener cambios del servidor desde 'since'
    remote_changes = list_activities(user_id, since=since, include_deleted=True) if since else []
    return {
        "applied": applied,
        "conflicts": conflicts,
        "server_time": now,
        "changes": remote_changes,
    }

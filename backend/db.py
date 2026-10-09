"""Persistencia en SQLite con soporte de sincronización incremental,
tombstones (deleted_at), resolución de conflictos con autoridad del servidor,
purga de tombstones y backups rotativos automáticos.
"""
import json
import os
import shutil
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

DB_PATH = os.getenv("AGENDA_DB", os.path.join(os.path.dirname(__file__), "agenda.db"))
PURGE_DAYS_DEFAULT = 30
_SCHEMA_INITIALIZED = False


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _backup_db_if_exists(db_path: str, max_backups: int = 5):
    """Crea una copia de seguridad timestamped de la base de datos en 'backups/' y conserva sólo las últimas max_backups copias."""
    if os.path.isfile(db_path) and os.path.getsize(db_path) > 0:
        db_dir = os.path.dirname(db_path) or "."
        backup_dir = os.path.join(db_dir, "backups")
        os.makedirs(backup_dir, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        base_name = os.path.basename(db_path)
        backup_name = f"{base_name}_backup_{ts}.db"
        backup_path = os.path.join(backup_dir, backup_name)
        if not os.path.exists(backup_path):
            try:
                shutil.copy2(db_path, backup_path)
            except Exception as e:
                print(f"[WARN] No se pudo crear backup de {db_path}: {e}")

        # Rotación de backups: conservar máximo max_backups
        try:
            backups = sorted([
                os.path.join(backup_dir, f) for f in os.listdir(backup_dir)
                if f.startswith(f"{base_name}_backup_") and f.endswith(".db")
            ], key=os.path.getmtime)
            while len(backups) > max_backups:
                oldest = backups.pop(0)
                if os.path.exists(oldest):
                    os.remove(oldest)
        except Exception as e:
            print(f"[WARN] Error rotando backups: {e}")


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
    if "deleted_at" not in cols:
        conn.execute("ALTER TABLE activities ADD COLUMN deleted_at TEXT DEFAULT NULL")
    if "version" not in cols:
        conn.execute("ALTER TABLE activities ADD COLUMN version INTEGER DEFAULT 1")

    conn.execute("UPDATE activities SET updated_at = ? WHERE updated_at IS NULL OR updated_at = ''", (now,))
    conn.execute("UPDATE activities SET version = 1 WHERE version IS NULL OR version < 1")

    conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_sync ON activities (user_id, updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities (user_id, date)")


def _conn() -> sqlite3.Connection:
    global _SCHEMA_INITIALIZED
    db_path = os.getenv("AGENDA_DB", DB_PATH)
    if not _SCHEMA_INITIALIZED:
        _backup_db_if_exists(db_path)
    conn = sqlite3.connect(db_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    if not _SCHEMA_INITIALIZED:
        _migrate_schema(conn)
        _SCHEMA_INITIALIZED = True
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
    include_deleted: bool = False,
    conn: sqlite3.Connection | None = None
) -> list[dict]:
    """Lista actividades. Si se provee `since`, devuelve todas las modificadas después de esa fecha (incluyendo tombstones si include_deleted=True)."""
    q, args = "SELECT * FROM activities WHERE user_id=?", [user_id]
    if since:
        q += " AND updated_at > ?"
        args.append(since)
        if not include_deleted:
            q += " AND deleted_at IS NULL"
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
    if conn is not None:
        return [_row(r) for r in conn.execute(q, args)]
    with _conn() as c:
        return [_row(r) for r in c.execute(q, args)]


def get_activity(user_id: str, act_id: str, include_deleted: bool = True, conn: sqlite3.Connection | None = None) -> dict | None:
    q = "SELECT * FROM activities WHERE user_id=? AND id=?"
    if not include_deleted:
        q += " AND deleted_at IS NULL"
    if conn is not None:
        r = conn.execute(q, (user_id, act_id)).fetchone()
        return _row(r) if r else None
    with _conn() as c:
        r = c.execute(q, (user_id, act_id)).fetchone()
    return _row(r) if r else None


def upsert_activity(user_id: str, a: dict, conn: sqlite3.Connection | None = None) -> dict:
    """Inserta o actualiza una actividad con timestamp y versión autoritativos del servidor."""
    a = {**a}
    if not a.get("id"):
        a["id"] = str(uuid.uuid4())

    now = utc_now_iso()

    def _exec(c: sqlite3.Connection):
        existing = get_activity(user_id, a["id"], include_deleted=True, conn=c)
        if existing:
            new_version = existing["version"] + 1
        else:
            new_version = a.get("version") or 1

        updated_at = now
        deleted_at = a.get("deleted_at")

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
        return get_activity(user_id, a["id"], include_deleted=True, conn=c)

    if conn is not None:
        return _exec(conn)
    with _conn() as c:
        return _exec(c)


def delete_activity(user_id: str, act_id: str, conn: sqlite3.Connection | None = None) -> bool:
    """Borrado lógico como tombstone para propagación en sincronización."""
    def _exec(c: sqlite3.Connection):
        act = get_activity(user_id, act_id, include_deleted=False, conn=c)
        if not act:
            return False
        act["deleted_at"] = utc_now_iso()
        upsert_activity(user_id, act, conn=c)
        return True

    if conn is not None:
        return _exec(conn)
    with _conn() as c:
        return _exec(c)


def purge_tombstones(user_id: str | None = None, days: int = PURGE_DAYS_DEFAULT) -> int:
    """Elimina físicamente los tombstones más antiguos que N días."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    q = "DELETE FROM activities WHERE deleted_at IS NOT NULL AND deleted_at < ?"
    args = [cutoff]
    if user_id:
        q += " AND user_id = ?"
        args.append(user_id)
    with _conn() as conn:
        cursor = conn.execute(q, args)
        return cursor.rowcount


def sync_changes(user_id: str, changes: list[dict], since: str | None = None, purge_days: int = PURGE_DAYS_DEFAULT) -> dict:
    """Sincronización transaccional con autoridad del servidor:
    1. Si el cliente envía una versión base menor a la versión actual del servidor,
       se rechaza el cambio y se reporta conflicto sin sobrescribir.
    2. El servidor asigna timestamp monotónico y versión incremental.
    3. Si `since` es anterior al período de retención de tombstones (30 días),
       se señaliza `resync_required=True` para requerir full pull.
    """
    applied = 0
    conflicts = []
    now = utc_now_iso()
    resync_required = False

    if since:
        try:
            since_clean = since.replace("Z", "+00:00")
            since_dt = datetime.fromisoformat(since_clean)
            cutoff_dt = datetime.now(timezone.utc) - timedelta(days=purge_days)
            if since_dt < cutoff_dt:
                resync_required = True
        except Exception:
            pass

    with _conn() as conn:
        for item in changes:
            if not isinstance(item, dict) or not item.get("id"):
                raise ValueError("Cada cambio debe contener un 'id' válido")

            act_id = item["id"]
            existing = get_activity(user_id, act_id, include_deleted=True, conn=conn)

            base_version = item.get("base_version")
            if base_version is None and "version" in item:
                base_version = item["version"]

            if existing:
                if base_version is not None and base_version < existing["version"]:
                    conflicts.append({
                        "id": act_id,
                        "server_version": existing["version"],
                        "server_updated_at": existing["updated_at"],
                        "reason": "version_stale"
                    })
                    continue

                new_version = existing["version"] + 1
            else:
                new_version = 1

            deleted_at = item.get("deleted_at")

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
                    int(bool(item.get("completed", False))), now,
                    deleted_at, new_version
                ),
            )
            applied += 1

        if resync_required:
            remote_changes = list_activities(user_id, include_deleted=False, conn=conn)
        elif since:
            remote_changes = list_activities(user_id, since=since, include_deleted=True, conn=conn)
        else:
            remote_changes = []

    return {
        "applied": applied,
        "conflicts": conflicts,
        "server_time": now,
        "resync_required": resync_required,
        "changes": remote_changes,
    }

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


def create_pre_migration_backup(db_path: str) -> str | None:
    """Crea una copia permanente e inmutable 'pre_migration_*.db' que NUNCA se rota."""
    if os.path.isfile(db_path) and os.path.getsize(db_path) > 0:
        db_dir = os.path.dirname(db_path) or "."
        backup_dir = os.path.join(db_dir, "backups")
        os.makedirs(backup_dir, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        base_name = os.path.splitext(os.path.basename(db_path))[0]
        backup_path = os.path.join(backup_dir, f"pre_migration_{base_name}_{ts}.db")
        if not os.path.exists(backup_path):
            try:
                shutil.copy2(db_path, backup_path)
                return backup_path
            except Exception as e:
                print(f"[WARN] No se pudo crear backup pre-migración: {e}")
    return None


def create_automatic_backup(db_path: str, max_backups: int = 5) -> str | None:
    """Crea una copia de respaldo automática y rota conservando solo las últimas max_backups copias (excluyendo pre_migration)."""
    if os.path.isfile(db_path) and os.path.getsize(db_path) > 0:
        db_dir = os.path.dirname(db_path) or "."
        backup_dir = os.path.join(db_dir, "backups")
        os.makedirs(backup_dir, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        base_name = os.path.splitext(os.path.basename(db_path))[0]
        backup_name = f"auto_{base_name}_backup_{ts}.db"
        backup_path = os.path.join(backup_dir, backup_name)
        if not os.path.exists(backup_path):
            try:
                shutil.copy2(db_path, backup_path)
            except Exception as e:
                print(f"[WARN] No se pudo crear backup automático de {db_path}: {e}")

        # Rotación: rota SOLO los archivos auto_*_backup_*.db, nunca toca los pre_migration_*.db
        try:
            backups = sorted([
                os.path.join(backup_dir, f) for f in os.listdir(backup_dir)
                if f.startswith(f"auto_{base_name}_backup_") and f.endswith(".db")
            ], key=os.path.getmtime)
            while len(backups) > max_backups:
                oldest = backups.pop(0)
                if os.path.exists(oldest):
                    os.remove(oldest)
        except Exception as e:
            print(f"[WARN] Error rotando backups: {e}")
        return backup_path
    return None


def _migrate_schema_if_needed(conn: sqlite3.Connection, db_path: str):
    """Verifica si se requiere migración real. Si es así, crea respaldo pre-migración y aplica cambios."""
    # Verificar si la tabla existe
    t_exists = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='activities'").fetchone()

    if not t_exists:
        # Primera inicialización de tabla vacía
        conn.execute(
            """CREATE TABLE activities (
                user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
                start_time TEXT DEFAULT '', end_time TEXT DEFAULT '', description TEXT DEFAULT '',
                priority TEXT DEFAULT 'medium', tags TEXT DEFAULT '[]', completed INTEGER DEFAULT 0,
                updated_at TEXT DEFAULT '', deleted_at TEXT DEFAULT NULL, version INTEGER DEFAULT 1,
                PRIMARY KEY (user_id, id))"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_sync ON activities (user_id, updated_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities (user_id, date)")
        return

    cursor = conn.execute("PRAGMA table_info(activities)")
    cols = {row["name"] for row in cursor.fetchall()}

    missing_cols = {"updated_at", "deleted_at", "version"} - cols
    missing_data = False
    if "updated_at" in cols:
        empty_count = conn.execute("SELECT COUNT(*) FROM activities WHERE updated_at IS NULL OR updated_at = ''").fetchone()[0]
        if empty_count > 0:
            missing_data = True

    if missing_cols or missing_data:
        # Hay migración real pendiente -> crear respaldo permanente pre-migración
        create_pre_migration_backup(db_path)
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
    conn = sqlite3.connect(db_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")

    if not _SCHEMA_INITIALIZED:
        _migrate_schema_if_needed(conn, db_path)
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
    """Lista actividades. Si no se provee `since`, devuelve actividades activas (`deleted_at IS NULL`)."""
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
    1. Si el registro EXISTE en el servidor:
       - Es OBLIGATORIO proveer `base_version`.
       - Si no se provee `base_version` -> conflicto `missing_base_version` (NUNCA sobrescribe).
       - Si `base_version < existing["version"]` -> conflicto `version_stale` (NUNCA sobrescribe).
    2. Si el registro es NUEVO (ID no existe en servidor):
       - No requiere `base_version`, se inserta con `version = 1`.
    3. Si `since` es anterior al período de retención de tombstones (30 días):
       - Se señaliza `resync_required = True`.
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

            if existing:
                if base_version is None:
                    conflicts.append({
                        "id": act_id,
                        "server_version": existing["version"],
                        "server_updated_at": existing["updated_at"],
                        "server_item": existing,
                        "reason": "missing_base_version"
                    })
                    continue

                if base_version < existing["version"]:
                    conflicts.append({
                        "id": act_id,
                        "server_version": existing["version"],
                        "server_updated_at": existing["updated_at"],
                        "server_item": existing,
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

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

DB_PATH = os.getenv("AGENDA_DB", os.getenv("DATABASE_PATH", os.path.join(os.path.dirname(__file__), "agenda.db")))
PURGE_DAYS_DEFAULT = 30
_INITIALIZED_DBS: set[str] = set()


def init_db(db_path: str | None = None):
    """Inicializa y migra la base de datos indicada."""
    conn = _conn(db_path)
    conn.close()


_LAST_ASSIGNED_TS = ""


def utc_now_iso() -> str:
    """Retorna timestamp UTC en formato ISO 8601 con microsegundos."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def monotonic_utc_now_iso() -> str:
    """Garantiza timestamps ISO estrictamente crecientes incluso si el reloj del sistema retrocede."""
    global _LAST_ASSIGNED_TS
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if _LAST_ASSIGNED_TS and now_str <= _LAST_ASSIGNED_TS:
        try:
            clean_last = _LAST_ASSIGNED_TS.rstrip("Z")
            dt = datetime.fromisoformat(clean_last) + timedelta(microseconds=1000)
            now_str = dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        except Exception:
            pass
    _LAST_ASSIGNED_TS = now_str
    return now_str


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
    existing_tables = {
        row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }

    needs_new_tables = not {"subjects", "topics", "focus_sessions", "learning_notes"}.issubset(existing_tables)
    missing_cols = set()
    missing_data = False
    if "activities" in existing_tables:
        cursor = conn.execute("PRAGMA table_info(activities)")
        cols = {row["name"] for row in cursor.fetchall()}
        missing_cols = {"updated_at", "deleted_at", "version"} - cols
        if "updated_at" in cols:
            empty_count = conn.execute("SELECT COUNT(*) FROM activities WHERE updated_at IS NULL OR updated_at = ''").fetchone()[0]
            if empty_count > 0:
                missing_data = True

    if (needs_new_tables and "activities" in existing_tables) or missing_cols or missing_data:
        has_existing_data = False
        try:
            if "activities" in existing_tables:
                c_rows = conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
                if c_rows > 0:
                    has_existing_data = True
        except Exception:
            pass
        if has_existing_data:
            create_pre_migration_backup(db_path)

    # 1. Activities
    if "activities" not in existing_tables:
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
    else:
        cursor = conn.execute("PRAGMA table_info(activities)")
        cols = {row["name"] for row in cursor.fetchall()}
        if "updated_at" not in cols:
            conn.execute("ALTER TABLE activities ADD COLUMN updated_at TEXT DEFAULT ''")
        if "deleted_at" not in cols:
            conn.execute("ALTER TABLE activities ADD COLUMN deleted_at TEXT DEFAULT NULL")
        if "version" not in cols:
            conn.execute("ALTER TABLE activities ADD COLUMN version INTEGER DEFAULT 1")
        now = monotonic_utc_now_iso()
        conn.execute("UPDATE activities SET updated_at = ? WHERE updated_at IS NULL OR updated_at = ''", (now,))
        conn.execute("UPDATE activities SET version = 1 WHERE version IS NULL OR version < 1")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_sync ON activities (user_id, updated_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities (user_id, date)")

    # 2. Subjects
    if "subjects" not in existing_tables:
        conn.execute(
            """CREATE TABLE subjects (
                user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
                color TEXT DEFAULT '#5B6FA0', icon TEXT DEFAULT 'book',
                weekly_goal_minutes INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
                updated_at TEXT DEFAULT '', deleted_at TEXT DEFAULT NULL, version INTEGER DEFAULT 1,
                PRIMARY KEY (user_id, id))"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_subjects_user_sync ON subjects (user_id, updated_at)")

    # 3. Topics
    if "topics" not in existing_tables:
        conn.execute(
            """CREATE TABLE topics (
                user_id TEXT NOT NULL, id TEXT NOT NULL, subject_id TEXT DEFAULT '',
                name TEXT NOT NULL, status TEXT DEFAULT 'pending',
                updated_at TEXT DEFAULT '', deleted_at TEXT DEFAULT NULL, version INTEGER DEFAULT 1,
                PRIMARY KEY (user_id, id))"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_topics_user_sync ON topics (user_id, updated_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_topics_user_subject ON topics (user_id, subject_id)")

    # 4. Focus Sessions
    if "focus_sessions" not in existing_tables:
        conn.execute(
            """CREATE TABLE focus_sessions (
                user_id TEXT NOT NULL, id TEXT NOT NULL, subject_id TEXT DEFAULT NULL,
                topic_ids TEXT DEFAULT '[]', activity_id TEXT DEFAULT NULL,
                method TEXT DEFAULT 'pomodoro', goal TEXT DEFAULT '',
                started_at TEXT DEFAULT '', ended_at TEXT DEFAULT '',
                focus_intervals TEXT DEFAULT '[]', effective_seconds INTEGER DEFAULT 0,
                break_seconds INTEGER DEFAULT 0, cycles_completed INTEGER DEFAULT 0,
                distractions_count INTEGER DEFAULT 0, status TEXT DEFAULT 'completed',
                source TEXT DEFAULT 'timer', iana_timezone TEXT DEFAULT 'UTC',
                updated_at TEXT DEFAULT '', deleted_at TEXT DEFAULT NULL, version INTEGER DEFAULT 1,
                PRIMARY KEY (user_id, id))"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_sync ON focus_sessions (user_id, updated_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_started ON focus_sessions (user_id, started_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_subject ON focus_sessions (user_id, subject_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_activity ON focus_sessions (user_id, activity_id)")

    # 5. Learning Notes
    if "learning_notes" not in existing_tables:
        conn.execute(
            """CREATE TABLE learning_notes (
                user_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT DEFAULT NULL,
                activity_id TEXT DEFAULT NULL, subject_id TEXT DEFAULT NULL, topic_ids TEXT DEFAULT '[]',
                learned_text TEXT DEFAULT '', questions_text TEXT DEFAULT '', resources_text TEXT DEFAULT '',
                next_step_text TEXT DEFAULT '', comprehension_level INTEGER DEFAULT NULL,
                focus_level INTEGER DEFAULT NULL, conflict_of TEXT DEFAULT NULL,
                updated_at TEXT DEFAULT '', deleted_at TEXT DEFAULT NULL, version INTEGER DEFAULT 1,
                PRIMARY KEY (user_id, id))"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_learning_notes_user_sync ON learning_notes (user_id, updated_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_learning_notes_user_subject ON learning_notes (user_id, subject_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_learning_notes_user_session ON learning_notes (user_id, session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_learning_notes_user_activity ON learning_notes (user_id, activity_id)")


COLLECTION_SCHEMAS = {
    "activities": {
        "table": "activities",
        "primary_key": ["user_id", "id"],
        "columns": {
            "title": {"type": str, "max_length": 500, "default": "", "sql_col": "title"},
            "date": {"type": str, "max_length": 50, "default": "", "sql_col": "date"},
            "startTime": {"type": str, "max_length": 20, "default": "", "sql_col": "start_time"},
            "endTime": {"type": str, "max_length": 20, "default": "", "sql_col": "end_time"},
            "description": {"type": str, "max_length": 50000, "default": "", "sql_col": "description"},
            "priority": {"type": str, "max_length": 20, "default": "medium", "sql_col": "priority"},
            "tags": {"type": list, "default": [], "sql_col": "tags", "serialize": json.dumps, "deserialize": lambda v: json.loads(v or "[]")},
            "completed": {"type": bool, "default": False, "sql_col": "completed", "serialize": lambda v: int(bool(v)), "deserialize": lambda v: bool(v)},
        },
        "order_by": "date, start_time"
    },
    "subjects": {
        "table": "subjects",
        "primary_key": ["user_id", "id"],
        "columns": {
            "name": {"type": str, "max_length": 200, "default": "", "sql_col": "name"},
            "color": {"type": str, "max_length": 50, "default": "#5B6FA0", "sql_col": "color"},
            "icon": {"type": str, "max_length": 50, "default": "book", "sql_col": "icon"},
            "weekly_goal_minutes": {"type": int, "min_val": 0, "default": 0, "sql_col": "weekly_goal_minutes"},
            "archived": {"type": bool, "default": False, "sql_col": "archived", "serialize": lambda v: int(bool(v)), "deserialize": lambda v: bool(v)},
        },
        "order_by": "name ASC"
    },
    "topics": {
        "table": "topics",
        "primary_key": ["user_id", "id"],
        "columns": {
            "subject_id": {"type": str, "max_length": 100, "default": "", "sql_col": "subject_id"},
            "name": {"type": str, "max_length": 200, "default": "", "sql_col": "name"},
            "status": {"type": str, "enum": ["pending", "in_progress", "mastered"], "default": "pending", "sql_col": "status"},
        },
        "order_by": "name ASC"
    },
    "focus_sessions": {
        "table": "focus_sessions",
        "primary_key": ["user_id", "id"],
        "columns": {
            "subject_id": {"type": str, "max_length": 100, "default": None, "sql_col": "subject_id", "nullable": True},
            "topic_ids": {"type": list, "default": [], "sql_col": "topic_ids", "serialize": json.dumps, "deserialize": lambda v: json.loads(v or "[]")},
            "activity_id": {"type": str, "max_length": 100, "default": None, "sql_col": "activity_id", "nullable": True},
            "method": {"type": str, "max_length": 50, "default": "pomodoro", "sql_col": "method"},
            "goal": {"type": str, "max_length": 500, "default": "", "sql_col": "goal"},
            "started_at": {"type": str, "max_length": 50, "default": "", "sql_col": "started_at"},
            "ended_at": {"type": str, "max_length": 50, "default": "", "sql_col": "ended_at"},
            "focus_intervals": {"type": list, "default": [], "sql_col": "focus_intervals", "serialize": json.dumps, "deserialize": lambda v: json.loads(v or "[]")},
            "effective_seconds": {"type": int, "min_val": 0, "default": 0, "sql_col": "effective_seconds"},
            "break_seconds": {"type": int, "min_val": 0, "default": 0, "sql_col": "break_seconds"},
            "cycles_completed": {"type": int, "min_val": 0, "default": 0, "sql_col": "cycles_completed"},
            "distractions_count": {"type": int, "min_val": 0, "default": 0, "sql_col": "distractions_count"},
            "status": {"type": str, "enum": ["completed", "abandoned"], "default": "completed", "sql_col": "status"},
            "source": {"type": str, "enum": ["timer", "manual"], "default": "timer", "sql_col": "source"},
            "iana_timezone": {"type": str, "max_length": 100, "default": "UTC", "sql_col": "iana_timezone"},
        },
        "order_by": "started_at DESC"
    },
    "learning_notes": {
        "table": "learning_notes",
        "primary_key": ["user_id", "id"],
        "columns": {
            "session_id": {"type": str, "max_length": 100, "default": None, "sql_col": "session_id", "nullable": True},
            "activity_id": {"type": str, "max_length": 100, "default": None, "sql_col": "activity_id", "nullable": True},
            "subject_id": {"type": str, "max_length": 100, "default": None, "sql_col": "subject_id", "nullable": True},
            "topic_ids": {"type": list, "default": [], "sql_col": "topic_ids", "serialize": json.dumps, "deserialize": lambda v: json.loads(v or "[]")},
            "learned_text": {"type": str, "max_length": 50000, "default": "", "sql_col": "learned_text"},
            "questions_text": {"type": str, "max_length": 50000, "default": "", "sql_col": "questions_text"},
            "resources_text": {"type": str, "max_length": 50000, "default": "", "sql_col": "resources_text"},
            "next_step_text": {"type": str, "max_length": 50000, "default": "", "sql_col": "next_step_text"},
            "comprehension_level": {"type": int, "min_val": 1, "max_val": 5, "default": None, "sql_col": "comprehension_level", "nullable": True},
            "focus_level": {"type": int, "min_val": 1, "max_val": 5, "default": None, "sql_col": "focus_level", "nullable": True},
            "conflict_of": {"type": str, "max_length": 100, "default": None, "sql_col": "conflict_of", "nullable": True},
        },
        "order_by": "updated_at DESC"
    }
}
WHITELISTED_COLLECTIONS = set(COLLECTION_SCHEMAS.keys())


def _conn(custom_path: str | None = None) -> sqlite3.Connection:
    global _INITIALIZED_DBS
    raw_path = custom_path or os.getenv("AGENDA_DB") or os.getenv("DATABASE_PATH") or DB_PATH
    abs_path = os.path.abspath(raw_path)
    conn = sqlite3.connect(abs_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")

    if abs_path not in _INITIALIZED_DBS:
        _migrate_schema_if_needed(conn, abs_path)
        _INITIALIZED_DBS.add(abs_path)
    return conn


def _format_collection_row(collection_name: str, r: sqlite3.Row) -> dict:
    if not r:
        return {}
    schema = COLLECTION_SCHEMAS[collection_name]
    res = {
        "id": r["id"],
        "updated_at": r["updated_at"] or monotonic_utc_now_iso(),
        "deleted_at": r["deleted_at"],
        "version": r["version"] or 1,
    }
    for field_name, field_spec in schema["columns"].items():
        sql_col = field_spec["sql_col"]
        raw_val = r[sql_col] if sql_col in r.keys() else None
        if "deserialize" in field_spec:
            res[field_name] = field_spec["deserialize"](raw_val)
        else:
            res[field_name] = raw_val if raw_val is not None else field_spec.get("default")
    return res


def _row(r) -> dict:
    """Compatibilidad: formatea una fila de la tabla activities."""
    return _format_collection_row("activities", r)


STANDARD_METADATA_FIELDS = {
    "id", "base_version", "deleted_at", "version", "updated_at", "created_at", "user_id"
}


def validate_and_sanitize_item(collection_name: str, item: dict) -> tuple[dict | None, str | None, list[str]]:
    """
    Valida y sanitiza un registro contra el esquema declarativo de la colección.
    Retorna: (sanitized_dict, error_reason_str | None, list_of_unknown_fields)
    """
    if collection_name not in WHITELISTED_COLLECTIONS:
        return None, f"Colección no permitida: '{collection_name}'", []
    if not isinstance(item, dict):
        return None, "El elemento a sincronizar debe ser un objeto JSON (dict)", []
    if not item.get("id") or not isinstance(item["id"], str) or len(item["id"].strip()) == 0:
        return None, "Cada cambio debe contener un 'id' válido (string no vacío)", []
    if len(item["id"]) > 100:
        return None, "El 'id' no puede superar los 100 caracteres", []

    schema = COLLECTION_SCHEMAS[collection_name]
    known_fields = STANDARD_METADATA_FIELDS.union(schema["columns"].keys())
    unknown_fields = [k for k in item.keys() if k not in known_fields]

    sanitized = {
        "id": item["id"].strip(),
        "base_version": item.get("base_version"),
        "deleted_at": item.get("deleted_at"),
        "version": item.get("version"),
    }

    for field_name, field_spec in schema["columns"].items():
        val = item.get(field_name, field_spec.get("default"))
        if val is None and field_spec.get("nullable", False):
            sanitized[field_name] = None
            continue

        expected_type = field_spec["type"]
        if val is not None and not isinstance(val, expected_type):
            if expected_type is str:
                val = str(val)
            elif expected_type is bool:
                val = bool(val)
            elif expected_type is int:
                try:
                    val = int(val)
                except (ValueError, TypeError):
                    return None, f"El campo '{field_name}' debe ser un entero válido", []
            elif expected_type is float:
                try:
                    val = float(val)
                except (ValueError, TypeError):
                    return None, f"El campo '{field_name}' debe ser un número válido", []
            elif expected_type is list and not isinstance(val, list):
                val = []

        if expected_type is str and "max_length" in field_spec and val:
            if len(val) > field_spec["max_length"]:
                return None, f"El campo '{field_name}' excede el límite máximo de {field_spec['max_length']} caracteres", []

        if "enum" in field_spec and val is not None:
            if val not in field_spec["enum"]:
                return None, f"El campo '{field_name}' tiene un valor inválido '{val}'. Permitidos: {field_spec['enum']}", []

        if "min_val" in field_spec and val is not None:
            if val < field_spec["min_val"]:
                return None, f"El campo '{field_name}' debe ser >= {field_spec['min_val']}", []

        if "max_val" in field_spec and val is not None:
            if val > field_spec["max_val"]:
                return None, f"El campo '{field_name}' debe ser <= {field_spec['max_val']}", []

        sanitized[field_name] = val

    # Invariantes específicas para focus_sessions
    if collection_name == "focus_sessions" and not sanitized.get("deleted_at"):
        s_at = sanitized.get("started_at")
        e_at = sanitized.get("ended_at")
        if s_at and e_at and e_at < s_at:
            return None, "ended_at debe ser posterior o igual a started_at", []

        intervals = sanitized.get("focus_intervals") or []
        if not isinstance(intervals, list):
            return None, "focus_intervals debe ser una lista", []
        if len(intervals) > 100:
            return None, "focus_intervals excede el número máximo permitido (100 tramos)", []

        total_interval_seconds = 0
        prev_end = None
        for idx, interval in enumerate(intervals):
            if not isinstance(interval, list) or len(interval) != 2:
                return None, f"El tramo {idx} debe tener formato [inicio_utc, fin_utc]", []
            istart, iend = interval[0], interval[1]
            if not isinstance(istart, str) or not isinstance(iend, str):
                return None, f"Las fechas del tramo {idx} deben ser strings ISO", []
            if iend < istart:
                return None, f"En el tramo {idx}, el fin {iend} no puede ser anterior al inicio {istart}", []
            if s_at and istart < s_at:
                return None, f"El tramo {idx} inicia antes de started_at ({istart} < {s_at})", []
            if e_at and iend > e_at:
                return None, f"El tramo {idx} finaliza después de ended_at ({iend} > {e_at})", []
            if prev_end and istart < prev_end:
                return None, f"El tramo {idx} se solapa con el tramo anterior ({istart} < {prev_end})", []
            prev_end = iend

            try:
                dt1 = datetime.fromisoformat(istart.replace("Z", "+00:00"))
                dt2 = datetime.fromisoformat(iend.replace("Z", "+00:00"))
                total_interval_seconds += int((dt2 - dt1).total_seconds())
            except Exception:
                pass

        src = sanitized.get("source", "timer")
        eff_sec = sanitized.get("effective_seconds", 0)
        if src != "manual" and len(intervals) > 0:
            if abs(total_interval_seconds - eff_sec) > 1:
                return None, f"effective_seconds ({eff_sec}s) no coincide con la suma de los tramos ({total_interval_seconds}s) para source='{src}'", []

        tz = sanitized.get("iana_timezone")
        if tz:
            try:
                import zoneinfo
                if tz not in zoneinfo.available_timezones() and tz != "UTC":
                    return None, f"Zona horaria IANA inválida: '{tz}'", []
            except Exception:
                pass

        topic_ids = sanitized.get("topic_ids")
        if topic_ids and isinstance(topic_ids, list) and len(topic_ids) > 50:
            return None, "El campo 'topic_ids' no puede contener más de 50 temas", []

    if collection_name == "learning_notes":
        topic_ids = sanitized.get("topic_ids")
        if topic_ids and isinstance(topic_ids, list) and len(topic_ids) > 50:
            return None, "El campo 'topic_ids' no puede contener más de 50 temas", []

    return sanitized, None, unknown_fields


def list_collection(
    user_id: str,
    collection_name: str,
    since: str | None = None,
    include_deleted: bool = False,
    filters: dict | None = None,
    conn: sqlite3.Connection | None = None
) -> list[dict]:
    """Lista registros de una colección con soporte para filtrado incremental por `since`."""
    if collection_name not in WHITELISTED_COLLECTIONS:
        raise ValueError(f"Colección no permitida: '{collection_name}'")

    schema = COLLECTION_SCHEMAS[collection_name]
    table = schema["table"]

    q = f"SELECT * FROM {table} WHERE user_id=?"
    args: list[any] = [user_id]

    if since:
        q += " AND updated_at > ?"
        args.append(since)
        if not include_deleted:
            q += " AND deleted_at IS NULL"
    else:
        if not include_deleted:
            q += " AND deleted_at IS NULL"
        if filters:
            if "start_date" in filters and filters["start_date"]:
                q += " AND date >= ?"
                args.append(filters["start_date"])
            if "end_date" in filters and filters["end_date"]:
                q += " AND date <= ?"
                args.append(filters["end_date"])

    if schema.get("order_by"):
        q += f" ORDER BY {schema['order_by']}"

    if conn is not None:
        return [_format_collection_row(collection_name, r) for r in conn.execute(q, args)]
    with _conn() as c:
        return [_format_collection_row(collection_name, r) for r in c.execute(q, args)]


def get_collection_item(
    user_id: str,
    collection_name: str,
    item_id: str,
    include_deleted: bool = True,
    conn: sqlite3.Connection | None = None
) -> dict | None:
    """Obtiene un único registro por ID dentro de una colección."""
    if collection_name not in WHITELISTED_COLLECTIONS:
        raise ValueError(f"Colección no permitida: '{collection_name}'")

    schema = COLLECTION_SCHEMAS[collection_name]
    table = schema["table"]

    q = f"SELECT * FROM {table} WHERE user_id=? AND id=?"
    if not include_deleted:
        q += " AND deleted_at IS NULL"

    if conn is not None:
        r = conn.execute(q, (user_id, item_id)).fetchone()
        return _format_collection_row(collection_name, r) if r else None
    with _conn() as c:
        r = c.execute(q, (user_id, item_id)).fetchone()
    return _format_collection_row(collection_name, r) if r else None


def upsert_collection_item(
    user_id: str,
    collection_name: str,
    item: dict,
    conn: sqlite3.Connection | None = None
) -> dict:
    """Inserta o actualiza un registro asignando versión monotónica y updated_at autoritativo."""
    if collection_name not in WHITELISTED_COLLECTIONS:
        raise ValueError(f"Colección no permitida: '{collection_name}'")

    item = {**item}
    if not item.get("id"):
        item["id"] = str(uuid.uuid4())

    schema = COLLECTION_SCHEMAS[collection_name]
    table = schema["table"]
    sanitized, err, unknowns = validate_and_sanitize_item(collection_name, item)
    if err:
        raise ValueError(err)

    def _exec(c: sqlite3.Connection):
        now = monotonic_utc_now_iso()
        existing = get_collection_item(user_id, collection_name, sanitized["id"], include_deleted=True, conn=c)
        if existing:
            new_version = existing["version"] + 1
        else:
            new_version = sanitized.get("version") or 1

        updated_at = now
        deleted_at = sanitized.get("deleted_at")

        col_names = ["user_id", "id"]
        placeholders = ["?", "?"]
        params = [user_id, sanitized["id"]]
        update_assignments = []

        for f_name, f_spec in schema["columns"].items():
            sql_col = f_spec["sql_col"]
            col_names.append(sql_col)
            placeholders.append("?")
            val = sanitized.get(f_name)
            if "serialize" in f_spec:
                val = f_spec["serialize"](val)
            params.append(val)
            update_assignments.append(f"{sql_col}=excluded.{sql_col}")

        col_names.extend(["updated_at", "deleted_at", "version"])
        placeholders.extend(["?", "?", "?"])
        params.extend([updated_at, deleted_at, new_version])
        update_assignments.extend(["updated_at=excluded.updated_at", "deleted_at=excluded.deleted_at", "version=excluded.version"])

        sql = f"""INSERT INTO {table} ({", ".join(col_names)})
                  VALUES ({", ".join(placeholders)})
                  ON CONFLICT(user_id, id) DO UPDATE SET
                  {", ".join(update_assignments)}"""

        c.execute(sql, tuple(params))
        return get_collection_item(user_id, collection_name, sanitized["id"], include_deleted=True, conn=c)

    if conn is not None:
        return _exec(conn)
    with _conn() as c:
        c.execute("BEGIN IMMEDIATE")
        res = _exec(c)
        c.commit()
        return res


def delete_collection_item(
    user_id: str,
    collection_name: str,
    item_id: str,
    conn: sqlite3.Connection | None = None
) -> bool:
    """Borrado lógico como tombstone para propagación en sincronización."""
    def _exec(c: sqlite3.Connection):
        act = get_collection_item(user_id, collection_name, item_id, include_deleted=False, conn=c)
        if not act:
            return False
        act["deleted_at"] = monotonic_utc_now_iso()
        upsert_collection_item(user_id, collection_name, act, conn=c)
        return True

    if conn is not None:
        return _exec(conn)
    with _conn() as c:
        c.execute("BEGIN IMMEDIATE")
        res = _exec(c)
        c.commit()
        return res


def list_activities(
    user_id: str,
    start: str | None = None,
    end: str | None = None,
    since: str | None = None,
    include_deleted: bool = False,
    conn: sqlite3.Connection | None = None
) -> list[dict]:
    """Wrapper para compatibilidad con activities."""
    filters = {}
    if start:
        filters["start_date"] = start
    if end:
        filters["end_date"] = end
    return list_collection(user_id, "activities", since=since, include_deleted=include_deleted, filters=filters, conn=conn)


def get_activity(user_id: str, act_id: str, include_deleted: bool = True, conn: sqlite3.Connection | None = None) -> dict | None:
    """Wrapper para compatibilidad con activities."""
    return get_collection_item(user_id, "activities", act_id, include_deleted=include_deleted, conn=conn)


def upsert_activity(user_id: str, a: dict, conn: sqlite3.Connection | None = None) -> dict:
    """Wrapper para compatibilidad con activities."""
    return upsert_collection_item(user_id, "activities", a, conn=conn)


def delete_activity(user_id: str, act_id: str, conn: sqlite3.Connection | None = None) -> bool:
    """Wrapper para compatibilidad con activities."""
    return delete_collection_item(user_id, "activities", act_id, conn=conn)


def purge_tombstones(user_id: str | None = None, days: int = PURGE_DAYS_DEFAULT) -> int:
    """Elimina físicamente los tombstones más antiguos que N días en todas las tablas."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    total_purged = 0
    with _conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for schema in COLLECTION_SCHEMAS.values():
            table = schema["table"]
            q = f"DELETE FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < ?"
            args = [cutoff]
            if user_id:
                q += " AND user_id = ?"
                args.append(user_id)
            cursor = conn.execute(q, args)
            total_purged += cursor.rowcount
        conn.commit()
    return total_purged


def sync_collection(
    user_id: str,
    collection_name: str,
    changes: list[dict],
    since: str | None = None,
    purge_days: int = PURGE_DAYS_DEFAULT,
    conn: sqlite3.Connection | None = None
) -> dict:
    """Sincronización transaccional genérica por colección."""
    if collection_name not in WHITELISTED_COLLECTIONS:
        raise ValueError(f"Colección no permitida: '{collection_name}'")

    applied = 0
    conflicts = []
    rejected = []
    unknown_fields_report = []
    resync_required = False

    # 1. Validación de esquema PRE-TRANSACCIÓN (sin bloquear el lote completo)
    valid_items = []
    for raw_item in changes:
        sanitized, err, unknowns = validate_and_sanitize_item(collection_name, raw_item)
        if err:
            item_id = raw_item.get("id") if isinstance(raw_item, dict) else "unknown"
            rejected.append({"id": str(item_id), "collection": collection_name, "reason": err})
        else:
            valid_items.append(sanitized)
            if unknowns:
                unknown_fields_report.append({"id": sanitized["id"], "collection": collection_name, "fields": unknowns})

    if since:
        try:
            since_clean = since.replace("Z", "+00:00")
            since_dt = datetime.fromisoformat(since_clean)
            cutoff_dt = datetime.now(timezone.utc) - timedelta(days=purge_days)
            if since_dt < cutoff_dt:
                resync_required = True
        except Exception:
            pass

    schema = COLLECTION_SCHEMAS[collection_name]
    table = schema["table"]
    now = ""

    def _process_in_conn(c: sqlite3.Connection):
        nonlocal applied, now
        now = monotonic_utc_now_iso()

        for item in valid_items:
            item_id = item["id"]
            existing = get_collection_item(user_id, collection_name, item_id, include_deleted=True, conn=c)
            base_version = item.get("base_version")

            if existing:
                if base_version is None:
                    conflicts.append({
                        "id": item_id,
                        "server_version": existing["version"],
                        "server_updated_at": existing["updated_at"],
                        "server_item": existing,
                        "reason": "missing_base_version"
                    })
                    continue

                if base_version < existing["version"]:
                    conflicts.append({
                        "id": item_id,
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

            col_names = ["user_id", "id"]
            placeholders = ["?", "?"]
            params = [user_id, item_id]
            update_assignments = []

            for f_name, f_spec in schema["columns"].items():
                sql_col = f_spec["sql_col"]
                col_names.append(sql_col)
                placeholders.append("?")
                val = item.get(f_name)
                if "serialize" in f_spec:
                    val = f_spec["serialize"](val)
                params.append(val)
                update_assignments.append(f"{sql_col}=excluded.{sql_col}")

            col_names.extend(["updated_at", "deleted_at", "version"])
            placeholders.extend(["?", "?", "?"])
            params.extend([now, deleted_at, new_version])
            update_assignments.extend(["updated_at=excluded.updated_at", "deleted_at=excluded.deleted_at", "version=excluded.version"])

            sql = f"""INSERT INTO {table} ({", ".join(col_names)})
                      VALUES ({", ".join(placeholders)})
                      ON CONFLICT(user_id, id) DO UPDATE SET
                      {", ".join(update_assignments)}"""

            c.execute(sql, tuple(params))
            applied += 1

        if resync_required:
            remote_changes = list_collection(user_id, collection_name, include_deleted=False, conn=c)
        elif since:
            remote_changes = list_collection(user_id, collection_name, since=since, include_deleted=True, conn=c)
        else:
            remote_changes = []

        return remote_changes

    if conn is not None:
        remotes = _process_in_conn(conn)
    else:
        with _conn() as c:
            c.execute("BEGIN IMMEDIATE")
            remotes = _process_in_conn(c)
            c.commit()

    return {
        "applied": applied,
        "conflicts": conflicts,
        "rejected": rejected,
        "unknown_fields": unknown_fields_report,
        "server_time": now or monotonic_utc_now_iso(),
        "resync_required": resync_required,
        "changes": remotes,
    }


def sync_changes(user_id: str, changes: list[dict], since: str | None = None, purge_days: int = PURGE_DAYS_DEFAULT) -> dict:
    """Wrapper para compatibilidad retroactiva sobre la colección 'activities'."""
    return sync_collection(user_id, "activities", changes, since=since, purge_days=purge_days)


def sync_collections(
    user_id: str,
    collections_payload: dict[str, list[dict]],
    since: str | None = None,
    purge_days: int = PURGE_DAYS_DEFAULT
) -> dict:
    """Sincronización multi-colección dentro de una única transacción atómica."""
    for col_name in collections_payload.keys():
        if col_name not in WHITELISTED_COLLECTIONS:
            raise ValueError(f"Colección no permitida: '{col_name}'")

    results = {}
    now = ""
    resync_required = False

    with _conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        now = monotonic_utc_now_iso()
        for col_name, changes in collections_payload.items():
            res = sync_collection(user_id, col_name, changes, since=since, purge_days=purge_days, conn=conn)
            results[col_name] = res
            if res.get("resync_required"):
                resync_required = True
        conn.commit()

    return {
        "server_time": now or monotonic_utc_now_iso(),
        "resync_required": resync_required,
        "results": results
    }

"""Persistencia en SQLite. La interfaz es pequeña para poder cambiarla por Supabase/Postgres."""
import json
import os
import sqlite3
import uuid

DB_PATH = os.getenv("AGENDA_DB", os.path.join(os.path.dirname(__file__), "agenda.db"))

FIELDS = ["id", "title", "date", "startTime", "endTime", "description", "priority", "tags", "completed"]


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """CREATE TABLE IF NOT EXISTS activities (
            user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
            start_time TEXT DEFAULT '', end_time TEXT DEFAULT '', description TEXT DEFAULT '',
            priority TEXT DEFAULT 'medium', tags TEXT DEFAULT '[]', completed INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, id))"""
    )
    return conn


def _row(r) -> dict:
    return {
        "id": r["id"], "title": r["title"], "date": r["date"],
        "startTime": r["start_time"], "endTime": r["end_time"],
        "description": r["description"], "priority": r["priority"],
        "tags": json.loads(r["tags"] or "[]"), "completed": bool(r["completed"]),
    }


def list_activities(user_id: str, start: str | None = None, end: str | None = None) -> list[dict]:
    q, args = "SELECT * FROM activities WHERE user_id=?", [user_id]
    if start:
        q += " AND date>=?"; args.append(start)
    if end:
        q += " AND date<=?"; args.append(end)
    q += " ORDER BY date, start_time"
    with _conn() as c:
        return [_row(r) for r in c.execute(q, args)]


def get_activity(user_id: str, act_id: str) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM activities WHERE user_id=? AND id=?", (user_id, act_id)).fetchone()
    return _row(r) if r else None


def upsert_activity(user_id: str, a: dict) -> dict:
    a = {**a}
    a.setdefault("id", uuid.uuid4().hex[:10])
    with _conn() as c:
        c.execute(
            """INSERT INTO activities (user_id,id,title,date,start_time,end_time,description,priority,tags,completed)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id,id) DO UPDATE SET title=excluded.title, date=excluded.date,
               start_time=excluded.start_time, end_time=excluded.end_time, description=excluded.description,
               priority=excluded.priority, tags=excluded.tags, completed=excluded.completed""",
            (user_id, a["id"], a.get("title", ""), a.get("date", ""), a.get("startTime", ""),
             a.get("endTime", ""), a.get("description", ""), a.get("priority", "medium"),
             json.dumps(a.get("tags", [])), int(bool(a.get("completed", False)))),
        )
    return get_activity(user_id, a["id"])


def delete_activity(user_id: str, act_id: str) -> bool:
    with _conn() as c:
        return c.execute("DELETE FROM activities WHERE user_id=? AND id=?", (user_id, act_id)).rowcount > 0


def replace_all(user_id: str, acts: list[dict]) -> int:
    """Sincronización completa desde el cliente (last-write-wins)."""
    with _conn() as c:
        c.execute("DELETE FROM activities WHERE user_id=?", (user_id,))
    for a in acts:
        upsert_activity(user_id, a)
    return len(acts)

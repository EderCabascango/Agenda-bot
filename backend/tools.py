"""Herramientas que el agente puede invocar. Todas reciben el user_id desde la config del grafo."""
from datetime import date, datetime, timedelta

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

import db
from cycle import get_cycle


def _uid(config: RunnableConfig) -> str:
    return config["configurable"]["user_id"]


@tool
def get_cycle_range(on_date: str, config: RunnableConfig) -> dict:
    """Devuelve inicio y fin del ciclo 15→14 que contiene la fecha (YYYY-MM-DD)."""
    s, e = get_cycle(date.fromisoformat(on_date))
    return {"start": s.isoformat(), "end": e.isoformat()}


@tool
def list_activities(start_date: str, end_date: str, config: RunnableConfig) -> list[dict]:
    """Lista actividades entre dos fechas (YYYY-MM-DD, inclusivo)."""
    return db.list_activities(_uid(config), start_date, end_date)


@tool
def create_activity(title: str, date: str, config: RunnableConfig, start_time: str = "",
                    end_time: str = "", priority: str = "medium", tags: list[str] | None = None,
                    description: str = "") -> dict:
    """Crea una actividad. priority: high|medium|low. Horas en HH:MM."""
    return db.upsert_activity(_uid(config), {
        "title": title, "date": date, "startTime": start_time, "endTime": end_time,
        "priority": priority, "tags": tags or [], "description": description, "completed": False})


@tool
def update_activity(activity_id: str, config: RunnableConfig, title: str | None = None,
                    date: str | None = None, start_time: str | None = None,
                    end_time: str | None = None, priority: str | None = None) -> dict:
    """Edita campos de una actividad existente (mover, renombrar, cambiar horas)."""
    uid = _uid(config)
    cur = db.get_activity(uid, activity_id, include_deleted=False)
    if not cur:
        return {"error": f"No existe o fue eliminada la actividad {activity_id}"}
    for k, v in (("title", title), ("date", date), ("startTime", start_time),
                 ("endTime", end_time), ("priority", priority)):
        if v is not None:
            cur[k] = v
    return db.upsert_activity(uid, cur)


@tool
def mark_done(activity_id: str, done: bool, config: RunnableConfig) -> dict:
    """Marca una actividad como completada (done=true) o pendiente (done=false)."""
    uid = _uid(config)
    cur = db.get_activity(uid, activity_id, include_deleted=False)
    if not cur:
        return {"error": f"No existe o fue eliminada la actividad {activity_id}"}
    cur["completed"] = done
    return db.upsert_activity(uid, cur)


@tool
def delete_activity(activity_id: str, config: RunnableConfig) -> dict:
    """Elimina una actividad. Acción destructiva: requiere confirmación del usuario."""
    return {"deleted": db.delete_activity(_uid(config), activity_id)}


@tool
def get_stats(on_date: str, config: RunnableConfig) -> dict:
    """Estadísticas de cumplimiento del ciclo 15→14 que contiene la fecha."""
    s, e = get_cycle(date.fromisoformat(on_date))
    acts = db.list_activities(_uid(config), s.isoformat(), e.isoformat())
    done = sum(a["completed"] for a in acts)
    by_title: dict[str, list[int]] = {}
    for a in acts:
        t = by_title.setdefault(a["title"], [0, 0])
        t[1] += 1
        t[0] += int(a["completed"])
    return {"cycle": [s.isoformat(), e.isoformat()], "total": len(acts), "done": done,
            "pct": round(100 * done / len(acts)) if acts else 0,
            "by_title": {k: {"done": v[0], "total": v[1]} for k, v in by_title.items()}}


@tool
def find_free_slots(on_date: str, duration_min: int, config: RunnableConfig) -> list[str]:
    """Busca huecos libres de `duration_min` minutos entre 07:00 y 21:00 en una fecha."""
    busy = []
    for a in db.list_activities(_uid(config), on_date, on_date):
        if a["startTime"] and a["endTime"]:
            busy.append((a["startTime"], a["endTime"]))
    busy.sort()
    cursor, limit = datetime.strptime("07:00", "%H:%M"), datetime.strptime("21:00", "%H:%M")
    need, slots = timedelta(minutes=duration_min), []
    for s, e in busy:
        s_dt, e_dt = datetime.strptime(s, "%H:%M"), datetime.strptime(e, "%H:%M")
        if s_dt - cursor >= need:
            slots.append(f"{cursor:%H:%M}-{s_dt:%H:%M}")
        cursor = max(cursor, e_dt)
    if limit - cursor >= need:
        slots.append(f"{cursor:%H:%M}-{limit:%H:%M}")
    return slots


ALL_TOOLS = [get_cycle_range, list_activities, create_activity, update_activity,
             mark_done, delete_activity, get_stats, find_free_slots]
DESTRUCTIVE = {"delete_activity"}

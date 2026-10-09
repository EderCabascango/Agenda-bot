import os
import tempfile
from datetime import date

os.environ["AGENDA_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

import db  # noqa: E402
from cycle import get_cycle  # noqa: E402
from tools import create_activity, find_free_slots, get_stats, mark_done  # noqa: E402

CFG = {"configurable": {"user_id": "u1"}}


def test_cycle_boundaries():
    assert get_cycle(date(2026, 10, 15)) == (date(2026, 10, 15), date(2026, 11, 14))
    assert get_cycle(date(2026, 10, 14)) == (date(2026, 9, 15), date(2026, 10, 14))
    assert get_cycle(date(2026, 12, 20)) == (date(2026, 12, 15), date(2027, 1, 14))
    assert get_cycle(date(2027, 1, 3)) == (date(2026, 12, 15), date(2027, 1, 14))
    assert get_cycle(date(2026, 3, 1)) == (date(2026, 2, 15), date(2026, 3, 14))


def test_tools_flow():
    a = create_activity.invoke({"title": "Ejercicio", "date": "2026-10-16",
                                "start_time": "08:00", "end_time": "09:00"}, CFG)
    mark_done.invoke({"activity_id": a["id"], "done": True}, CFG)
    s = get_stats.invoke({"on_date": "2026-10-20"}, CFG)
    assert s["total"] == 1 and s["pct"] == 100
    assert find_free_slots.invoke({"on_date": "2026-10-16", "duration_min": 60}, CFG)[0] == "07:00-08:00"


def test_sync_roundtrip():
    db.sync_changes("u2", [{"id": "x", "title": "Leer", "date": "2026-10-16", "tags": ["a"], "completed": True}])
    assert db.list_activities("u2")[0]["tags"] == ["a"]


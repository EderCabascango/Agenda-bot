"""Tests del módulo de ejercicio (calistenia): colecciones workout_routines y workouts.
Verifica la sincronización ida y vuelta, la normalización de ejercicios y series,
los límites de tamaño y que los tombstones se propagan.
"""
import os
import tempfile

os.environ["AGENDA_DB"] = os.path.join(tempfile.mkdtemp(), "test_workouts.db")
os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 32)

from fastapi.testclient import TestClient  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402
from auth import issue_session  # noqa: E402

client = TestClient(main.app)


def _headers(user):
    return {"Authorization": f"Bearer {issue_session(user)['token']}"}


def _sync(user, collections, since=None, full_pull=False):
    res = client.post("/sync", json={"collections": collections, "since": since, "full_pull": full_pull}, headers=_headers(user))
    assert res.status_code == 200, res.text
    return res.json()


ROUTINE = {
    "id": "rut-empuje",
    "name": "Empuje",
    "exercises": [
        {"name": "Fondos", "measure": "reps", "target_sets": 4, "target_reps": 10},
        {"name": "Plancha", "measure": "time", "target_sets": 3, "target_seconds": 60},
    ],
}
WORKOUT = {
    "id": "ent-1",
    "routine_id": "rut-empuje",
    "date": "2026-10-19",
    "started_at": "2026-10-19T11:00:00Z",
    "duration_minutes": 45,
    "exercises": [
        {"name": "Fondos", "measure": "reps", "sets": [{"reps": 10, "weight_kg": 5}, {"reps": 8, "weight_kg": "5"}]},
        {"name": "Plancha", "measure": "time", "sets": [{"seconds": 60}, {"seconds": 45}]},
    ],
    "notes": "Buen día",
}


def test_routine_and_workout_roundtrip_between_devices():
    user = "wk_roundtrip"
    res = _sync(user, {"workout_routines": [ROUTINE], "workouts": [WORKOUT]})
    assert res["results"]["workout_routines"]["applied"] == 1
    assert res["results"]["workouts"]["applied"] == 1

    other_device = _sync(user, {"workout_routines": [], "workouts": []}, full_pull=True)["results"]
    routine = other_device["workout_routines"]["changes"][0]
    workout = other_device["workouts"]["changes"][0]
    assert routine["name"] == "Empuje"
    assert routine["exercises"][1] == {"name": "Plancha", "measure": "time", "target_sets": 3, "target_reps": 0,
                                       "target_reps_min": 0, "target_reps_max": 0, "target_seconds": 60, "rest_seconds": 60}
    assert routine["exercises"][0]["target_reps_min"] == routine["exercises"][0]["target_reps_max"] == 10, "las rutinas antiguas conservan sus reps"
    assert workout["exercises"][0]["sets"][1] == {"reps": 8, "seconds": 0, "weight_kg": 5.0, "distance_km": 0.0}
    assert workout["duration_minutes"] == 45 and workout["notes"] == "Buen día"


def test_invalid_workouts_are_rejected_with_reason():
    user = "wk_invalid"
    bad = [
        {**WORKOUT, "id": "sin-fecha", "date": "19/10/2026"},
        {**WORKOUT, "id": "medida-mala", "exercises": [{"name": "Dominadas", "measure": "kg", "sets": []}]},
        {**WORKOUT, "id": "sin-nombre", "exercises": [{"name": "  ", "sets": []}]},
        {**WORKOUT, "id": "reps-negativas", "exercises": [{"name": "Flexiones", "sets": [{"reps": -3}]}]},
        {**WORKOUT, "id": "demasiadas-series", "exercises": [{"name": "Flexiones", "sets": [{"reps": 1}] * 31}]},
        {**WORKOUT, "id": "demasiados-ejercicios", "exercises": [{"name": f"E{i}", "sets": []} for i in range(41)]},
    ]
    res = _sync(user, {"workouts": bad})["results"]["workouts"]
    assert res["applied"] == 0
    assert {r["id"] for r in res["rejected"]} == {w["id"] for w in bad}

    no_name = _sync(user, {"workout_routines": [{**ROUTINE, "id": "rut-x", "name": " "}]})["results"]["workout_routines"]
    assert no_name["applied"] == 0 and "nombre" in no_name["rejected"][0]["reason"]


def test_workout_tombstone_propagates():
    user = "wk_tombstone"
    _sync(user, {"workouts": [WORKOUT]})
    saved = db.get_collection_item(user, "workouts", "ent-1")
    deleted = {**saved, "base_version": saved["version"], "deleted_at": "2026-10-19T12:00:00Z"}
    _sync(user, {"workouts": [deleted]})
    pulled = _sync(user, {"workouts": []}, full_pull=True)["results"]["workouts"]["changes"]
    assert pulled[0]["deleted_at"] is not None


def test_workouts_are_isolated_per_user():
    _sync("wk_owner", {"workouts": [{**WORKOUT, "id": "privado"}]})
    other = _sync("wk_other", {"workouts": []}, full_pull=True)["results"]["workouts"]["changes"]
    assert all(w["id"] != "privado" for w in other)


def test_ranges_rest_cardio_and_days():
    user = "wk_plan"
    routine = {
        "id": "plan-a", "name": "A · Full body", "days": [4, 0, 0],
        "exercises": [
            {"name": "Flexiones", "measure": "reps", "target_sets": 3, "target_reps_min": 15, "target_reps_max": 10, "rest_seconds": 45},
            {"name": "Plancha", "measure": "time", "target_sets": 3, "target_seconds": 30},
        ],
    }
    cardio = {"id": "ent-correr", "date": "2026-10-22", "duration_minutes": 32,
              "exercises": [{"name": "Correr suave", "measure": "cardio", "sets": [{"seconds": 1920, "distance_km": 4.25}]}]}
    res = _sync(user, {"workout_routines": [routine], "workouts": [cardio]})
    assert res["results"]["workout_routines"]["applied"] == 1 and res["results"]["workouts"]["applied"] == 1
    pulled = _sync(user, {"workout_routines": [], "workouts": []}, full_pull=True)["results"]
    r = pulled["workout_routines"]["changes"][0]
    assert r["days"] == [0, 4]
    assert (r["exercises"][0]["target_reps_min"], r["exercises"][0]["target_reps_max"], r["exercises"][0]["rest_seconds"]) == (10, 15, 45)
    assert r["exercises"][1]["rest_seconds"] == 60, "descanso por defecto"
    assert pulled["workouts"]["changes"][0]["exercises"][0]["sets"][0] == {"reps": 0, "seconds": 1920, "weight_kg": 0.0, "distance_km": 4.25}

    bad = _sync(user, {"workout_routines": [
        {**routine, "id": "dias-malos", "days": [7]},
        {**routine, "id": "descanso-largo", "exercises": [{"name": "X", "rest_seconds": 900}]},
    ], "workouts": [
        {**cardio, "id": "km-imposibles", "exercises": [{"name": "Correr", "measure": "cardio", "sets": [{"seconds": 60, "distance_km": 500}]}]},
    ]})["results"]
    assert {x["id"] for x in bad["workout_routines"]["rejected"]} == {"dias-malos", "descanso-largo"}
    assert bad["workouts"]["rejected"][0]["id"] == "km-imposibles"


def test_existing_routines_table_gets_days_column(tmp_path):
    import sqlite3
    path = str(tmp_path / "vieja.db")
    old = sqlite3.connect(path)
    old.execute("""CREATE TABLE workout_routines (user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT DEFAULT '',
                   exercises TEXT DEFAULT '[]', notes TEXT DEFAULT '', created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '',
                   deleted_at TEXT DEFAULT NULL, version INTEGER DEFAULT 1, PRIMARY KEY (user_id, id))""")
    old.execute("INSERT INTO workout_routines (user_id, id, name) VALUES ('me', 'r1', 'Empuje')")
    old.commit()
    old.close()
    with db._conn(path) as conn:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(workout_routines)").fetchall()}
        row = conn.execute("SELECT name, days FROM workout_routines WHERE id='r1'").fetchone()
    assert "days" in cols and row["name"] == "Empuje" and row["days"] == "[]"

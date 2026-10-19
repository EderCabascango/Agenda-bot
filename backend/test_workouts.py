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
    assert routine["exercises"][1] == {"name": "Plancha", "measure": "time", "target_sets": 3, "target_reps": 0, "target_seconds": 60}
    assert workout["exercises"][0]["sets"][1] == {"reps": 8, "seconds": 0, "weight_kg": 5.0}
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

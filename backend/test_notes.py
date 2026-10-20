"""Tests de la colección de apuntes (notes): sincronización, normalización y validación."""
import os
import tempfile

os.environ["AGENDA_DB"] = os.path.join(tempfile.mkdtemp(), "test_notes.db")
os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 32)

from fastapi.testclient import TestClient  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402
from auth import issue_session  # noqa: E402

client = TestClient(main.app)

NOTE = {
    "id": "nota-1",
    "title": "Compras",
    "content": "Para el fin de semana",
    "checklist": [{"text": "Leche", "done": True}, {"text": " Pan ", "done": 0}, {"text": "   "}],
    "tags": ["#Casa", "casa", " Compras "],
    "date": "2026-10-19",
    "pinned": True,
}


def _sync(user, notes, full_pull=False):
    res = client.post("/sync", json={"collections": {"notes": notes}, "since": None, "full_pull": full_pull},
                      headers={"Authorization": f"Bearer {issue_session(user)['token']}"})
    assert res.status_code == 200, res.text
    return res.json()["results"]["notes"]


def test_note_roundtrip_is_normalized():
    user = "notes_roundtrip"
    assert _sync(user, [NOTE])["applied"] == 1
    note = _sync(user, [], full_pull=True)["changes"][0]
    assert note["checklist"] == [{"text": "Leche", "done": True}, {"text": "Pan", "done": False}]
    assert note["tags"] == ["casa", "compras"]
    assert note["pinned"] == 1 and note["date"] == "2026-10-19"


def test_invalid_notes_are_rejected():
    user = "notes_invalid"
    bad = [
        {"id": "vacia", "title": " ", "content": "", "checklist": []},
        {"id": "fecha-mala", "title": "x", "date": "19-10-2026"},
        {"id": "tarea-larga", "title": "x", "checklist": [{"text": "a" * 301}]},
        {"id": "muchas-etiquetas", "title": "x", "tags": [f"t{i}" for i in range(21)]},
        {"id": "titulo-largo", "title": "a" * 201},
    ]
    res = _sync(user, bad)
    assert res["applied"] == 0
    assert {r["id"] for r in res["rejected"]} == {n["id"] for n in bad}


def test_checklist_only_note_and_tombstone():
    user = "notes_tombstone"
    _sync(user, [{"id": "solo-tareas", "checklist": [{"text": "Llamar al banco"}]}])
    saved = db.get_collection_item(user, "notes", "solo-tareas")
    assert saved["title"] == "" and saved["checklist"][0]["text"] == "Llamar al banco"
    _sync(user, [{**saved, "base_version": saved["version"], "deleted_at": "2026-10-19T12:00:00Z"}])
    assert _sync(user, [], full_pull=True)["changes"][0]["deleted_at"] is not None


def test_notes_are_isolated_per_user():
    _sync("notes_owner", [{**NOTE, "id": "privada"}])
    assert all(n["id"] != "privada" for n in _sync("notes_other", [], full_pull=True)["changes"])

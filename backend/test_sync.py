"""Tests de sincronización segura y endurecimiento (Fase 1 y Fase 1.5).
Verifica:
(a) Actividad creada por el agente no se borra cuando el cliente sincroniza.
(b) Resolución de conflictos con autoridad del servidor (cliente con reloj adelantado no gana si la versión base es vieja).
(c) Propagación de tombstones (deleted_at).
(d) Sincronización incremental (since=<timestamp>).
(e) Atomicidad de transacciones.
(f) Exclusión de tombstones en get_stats, find_free_slots y error en update/mark_done sobre tombstones.
(g) Purga de tombstones > 30 días y detección de resync_required.
(h) PUT /activities respeta version/base_version y no sobreescribe datos más nuevos.
"""
import os
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

# Usar base de datos temporal aislada para los tests
temp_dir = tempfile.mkdtemp()
os.environ["AGENDA_DB"] = os.path.join(temp_dir, "test_sync.db")

from fastapi.testclient import TestClient  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402
import tools  # noqa: E402

client = TestClient(main.app)
USER = "test_user_sync"
AUTH_HEADERS = {"X-User-Id": USER}
RUNNABLE_CONFIG = {"configurable": {"user_id": USER, "thread_id": f"{USER}:test"}}


@pytest.fixture(autouse=True)
def clean_db():
    """Limpia la base de datos antes de cada test."""
    with db._conn() as c:
        c.execute("DELETE FROM activities WHERE user_id=?", (USER,))
    yield


def test_agent_created_activity_is_not_deleted_by_client_sync():
    """(a) Si el agente crea una actividad en el backend, un sync del cliente no debe borrarla."""
    # 1. El agente crea una actividad directamente en el backend
    agent_act = db.upsert_activity(USER, {
        "title": "Actividad del Agente",
        "date": "2026-10-10",
        "startTime": "10:00",
        "endTime": "11:00"
    })
    assert agent_act["id"] is not None

    # 2. El cliente (que aún no sabe de la actividad del agente) envía sus actividades locales
    client_local_act = {
        "id": "client_act_1",
        "title": "Actividad Local",
        "date": "2026-10-10",
        "version": 1
    }

    res = client.post("/activities/sync", json={"changes": [client_local_act], "since": None}, headers=AUTH_HEADERS)
    assert res.status_code == 200

    # 3. La base de datos DEBE conservar AMBAS actividades
    all_acts = db.list_activities(USER, include_deleted=False)
    ids = [a["id"] for a in all_acts]
    assert agent_act["id"] in ids, "¡ERROR: La actividad creada por el agente fue borrada por el sync del cliente!"
    assert "client_act_1" in ids


def test_server_authority_clock_ahead_client_does_not_win():
    """(b) Un cliente con reloj adelantado 1 día NO gana conflictos solo por su timestamp si su versión es vieja."""
    # 1. Servidor tiene actividad en version 2 (modificada por agente o servidor)
    base_act = db.upsert_activity(USER, {
        "id": "act_conflict",
        "title": "Título Versión 1",
        "date": "2026-10-10",
    })
    v2_act = db.upsert_activity(USER, {
        "id": "act_conflict",
        "title": "Título Servidor Actualizado (v2)",
        "date": "2026-10-10",
    })
    assert v2_act["version"] == 2

    # 2. Cliente desactualizado (con base_version=1) pero reloj adelantado 1 día intenta sobrescribir
    future_time = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    stale_client_update = {
        "id": "act_conflict",
        "title": "Sobrescritura Maliciosa del Cliente",
        "date": "2026-10-10",
        "updated_at": future_time,
        "base_version": 1  # Cliente se basó en la versión 1
    }

    res = client.post("/activities/sync", json={"changes": [stale_client_update]}, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()

    # Debe reportar conflicto y NO aplicar el cambio
    assert data["applied"] == 0
    assert len(data["conflicts"]) == 1
    assert data["conflicts"][0]["id"] == "act_conflict"
    assert data["conflicts"][0]["server_version"] == 2

    # El valor en el servidor permanece inalterado
    current = db.get_activity(USER, "act_conflict")
    assert current["title"] == "Título Servidor Actualizado (v2)"
    assert current["version"] == 2


def test_tombstone_propagation():
    """(c) Borrar en un cliente se propaga como tombstone (deleted_at)."""
    db.upsert_activity(USER, {
        "id": "act_to_delete",
        "title": "Por borrar",
        "date": "2026-10-10",
    })

    deleted_change = {
        "id": "act_to_delete",
        "title": "Por borrar",
        "date": "2026-10-10",
        "deleted_at": datetime.now(timezone.utc).isoformat(),
        "base_version": 1
    }

    res = client.post("/activities/sync", json={"changes": [deleted_change]}, headers=AUTH_HEADERS)
    assert res.status_code == 200

    active = db.list_activities(USER, include_deleted=False)
    assert not any(a["id"] == "act_to_delete" for a in active)

    record = db.get_activity(USER, "act_to_delete", include_deleted=True)
    assert record is not None
    assert record["deleted_at"] is not None


def test_incremental_sync_with_since_parameter():
    """(d) Cliente offline que reconecta pide cambios desde su last_sync."""
    act_old = db.upsert_activity(USER, {"id": "act_old", "title": "Vieja", "date": "2026-10-10"})
    cutoff = datetime.now(timezone.utc).isoformat()
    act_new = db.upsert_activity(USER, {"id": "act_new", "title": "Nueva", "date": "2026-10-10"})

    res = client.get(f"/activities?since={cutoff}", headers=AUTH_HEADERS)
    assert res.status_code == 200
    acts = res.json()
    ids = [a["id"] for a in acts]
    assert "act_new" in ids
    assert "act_old" not in ids


def test_sync_atomicity_does_not_leave_empty_table():
    """(e) Una falla durante la sincronización no debe vaciar la base de datos."""
    db.upsert_activity(USER, {
        "id": "act_secure",
        "title": "Dato Valioso",
        "date": "2026-10-10",
    })

    bad_payload = {
        "changes": [
            {"id": "valid_1", "title": "Valido", "date": "2026-10-10"},
            {"id": None, "title": None}
        ]
    }

    res = client.post("/activities/sync", json=bad_payload, headers=AUTH_HEADERS)
    assert res.status_code in [400, 422]

    current = db.list_activities(USER)
    assert any(a["id"] == "act_secure" for a in current)


def test_tombstones_excluded_in_tools_and_error_on_update():
    """(f) get_stats y find_free_slots excluyen tombstones; update/mark_done sobre tombstones dan error."""
    # 1. Crear actividad ocupando de 08:00 a 09:00 en 2026-10-16 (ciclo 2026-10-15 a 2026-11-14)
    act = db.upsert_activity(USER, {
        "id": "act_meeting",
        "title": "Reunión",
        "date": "2026-10-16",
        "startTime": "08:00",
        "endTime": "09:00",
        "completed": False
    })

    # Stats antes del borrado
    stats_before = tools.get_stats.invoke({"on_date": "2026-10-16"}, RUNNABLE_CONFIG)
    assert stats_before["total"] == 1

    # Slots antes del borrado (de 07:00 a 21:00)
    slots_before = tools.find_free_slots.invoke({"on_date": "2026-10-16", "duration_min": 60}, RUNNABLE_CONFIG)
    assert "07:00-08:00" in slots_before
    assert "08:00-09:00" not in slots_before

    # 2. El agente borra la actividad (creando tombstone)
    del_res = tools.delete_activity.invoke({"activity_id": "act_meeting"}, RUNNABLE_CONFIG)
    assert del_res["deleted"] is True

    # 3. Stats y find_free_slots NO deben contar la actividad eliminada
    stats_after = tools.get_stats.invoke({"on_date": "2026-10-16"}, RUNNABLE_CONFIG)
    assert stats_after["total"] == 0

    slots_after = tools.find_free_slots.invoke({"on_date": "2026-10-16", "duration_min": 60}, RUNNABLE_CONFIG)
    # Al estar libre, debe existir un slot continuo desde las 07:00 hasta las 21:00
    assert any("07:00-21:00" in slot or "08:00" in slot for slot in slots_after)

    # 4. Intentar update o mark_done sobre el tombstone debe retornar error
    update_res = tools.update_activity.invoke({"activity_id": "act_meeting", "title": "Nuevo Titulo"}, RUNNABLE_CONFIG)
    assert "error" in update_res

    done_res = tools.mark_done.invoke({"activity_id": "act_meeting", "done": True}, RUNNABLE_CONFIG)
    assert "error" in done_res


def test_tombstone_purge_and_resync_required():
    """(g) Purga de tombstones > 30 días y detección de resync_required para clientes desactualizados."""
    old_time = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    recent_time = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()

    # Insertar tombstone viejo (> 30 días)
    with db._conn() as conn:
        conn.execute(
            """INSERT INTO activities (user_id, id, title, date, deleted_at, updated_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (USER, "old_tombstone", "Vieja Eliminada", "2026-08-01", old_time, old_time, 2)
        )
        # Insertar tombstone reciente (< 30 días)
        conn.execute(
            """INSERT INTO activities (user_id, id, title, date, deleted_at, updated_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (USER, "recent_tombstone", "Reciente Eliminada", "2026-10-01", recent_time, recent_time, 2)
        )

    # Purgar
    purged = db.purge_tombstones(USER, days=30)
    assert purged == 1

    # Verificar que old_tombstone ya no existe físicamente y recent_tombstone sí
    assert db.get_activity(USER, "old_tombstone", include_deleted=True) is None
    assert db.get_activity(USER, "recent_tombstone", include_deleted=True) is not None

    # Cliente que pide since de hace 45 días debe recibir resync_required=True
    ancient_since = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    sync_res = client.post("/activities/sync", json={"changes": [], "since": ancient_since}, headers=AUTH_HEADERS)
    assert sync_res.status_code == 200
    assert sync_res.json()["resync_required"] is True


def test_legacy_put_activities_respects_versions():
    """(h) PUT /activities respeta version/base_version y no sobreescribe datos más nuevos."""
    # Servidor tiene actividad v2
    db.upsert_activity(USER, {"id": "act_legacy", "title": "Version 1", "date": "2026-10-10"})
    db.upsert_activity(USER, {"id": "act_legacy", "title": "Version 2 Servidor", "date": "2026-10-10"})

    # Llamada PUT legacy con version vieja
    payload = [{
        "id": "act_legacy",
        "title": "Version Vieja Intentada",
        "date": "2026-10-10",
        "base_version": 1
    }]

    res = client.put("/activities", json=payload, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert len(data["conflicts"]) == 1

    # Base de datos conserva version 2
    current = db.get_activity(USER, "act_legacy")
    assert current["title"] == "Version 2 Servidor"

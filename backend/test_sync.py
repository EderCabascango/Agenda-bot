"""Tests de sincronización segura (Fase 1).
Verifica:
(a) Actividad creada por el agente no se borra cuando el cliente sincroniza.
(b) Resolución de conflictos por updated_at / version (gana el cambio más reciente).
(c) Propagación de tombstones (deleted_at).
(d) Sincronización incremental (since=<timestamp>).
(e) Atomicidad de transacciones.
"""
import os
import tempfile
from datetime import datetime, timezone

import pytest

# Usar base de datos temporal aislada para los tests
temp_dir = tempfile.mkdtemp()
os.environ["AGENDA_DB"] = os.path.join(temp_dir, "test_sync.db")

from fastapi.testclient import TestClient  # noqa: E402
import db  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)
USER = "test_user_sync"
AUTH_HEADERS = {"X-User-Id": USER}


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
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "version": 1
    }

    # Sincronización mediante el nuevo endpoint POST /activities/sync o incremental
    res = client.post("/activities/sync", json={"changes": [client_local_act], "since": None}, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()

    # 3. La base de datos DEBE conservar AMBAS actividades
    all_acts = db.list_activities(USER, include_deleted=False)
    ids = [a["id"] for a in all_acts]
    assert agent_act["id"] in ids, "¡ERROR: La actividad creada por el agente fue borrada por el sync del cliente!"
    assert "client_act_1" in ids


def test_conflict_resolution_latest_update_wins():
    """(b) Dos clientes editan la misma actividad: gana la versión con updated_at más reciente."""
    # Crear actividad base
    initial = db.upsert_activity(USER, {
        "id": "act_shared",
        "title": "Título Original",
        "date": "2026-10-10",
        "updated_at": "2026-10-10T10:00:00Z",
        "version": 1
    })

    # Cliente A (edición más vieja o desactualizada)
    update_a = {
        "id": "act_shared",
        "title": "Editado por Cliente A (viejo)",
        "date": "2026-10-10",
        "updated_at": "2026-10-10T10:05:00Z",
        "version": 1
    }

    # Cliente B (edición más reciente)
    update_b = {
        "id": "act_shared",
        "title": "Editado por Cliente B (nuevo)",
        "date": "2026-10-10",
        "updated_at": "2026-10-10T10:15:00Z",
        "version": 2
    }

    # Aplicar cambio B primero
    res_b = client.post("/activities/sync", json={"changes": [update_b]}, headers=AUTH_HEADERS)
    assert res_b.status_code == 200

    # Intentar aplicar cambio A (antiguo)
    res_a = client.post("/activities/sync", json={"changes": [update_a]}, headers=AUTH_HEADERS)
    assert res_a.status_code == 200

    # Debe prevalecer el cambio B
    current = db.get_activity(USER, "act_shared")
    assert current["title"] == "Editado por Cliente B (nuevo)"
    assert current["version"] >= 2


def test_tombstone_propagation():
    """(c) Borrar en un cliente se propaga como tombstone (deleted_at)."""
    # Crear actividad
    db.upsert_activity(USER, {
        "id": "act_to_delete",
        "title": "Por borrar",
        "date": "2026-10-10",
        "updated_at": "2026-10-10T10:00:00Z",
        "version": 1
    })

    # El cliente envía un tombstone
    deleted_change = {
        "id": "act_to_delete",
        "title": "Por borrar",
        "date": "2026-10-10",
        "updated_at": "2026-10-10T10:30:00Z",
        "deleted_at": "2026-10-10T10:30:00Z",
        "version": 2
    }

    res = client.post("/activities/sync", json={"changes": [deleted_change]}, headers=AUTH_HEADERS)
    assert res.status_code == 200

    # No debe aparecer en list_activities normales
    active = db.list_activities(USER, include_deleted=False)
    assert not any(a["id"] == "act_to_delete" for a in active)

    # Pero debe estar registrado como tombstone en la base de datos
    record = db.get_activity(USER, "act_to_delete")
    assert record is not None
    assert record["deleted_at"] is not None


def test_incremental_sync_with_since_parameter():
    """(d) Cliente offline que reconecta pide cambios desde su last_sync."""
    t0 = "2026-10-10T08:00:00Z"
    t1 = "2026-10-10T09:00:00Z"
    t2 = "2026-10-10T10:00:00Z"

    # Actividad 1 creada antes de t1
    db.upsert_activity(USER, {
        "id": "act_old",
        "title": "Vieja",
        "date": "2026-10-10",
        "updated_at": t0,
        "version": 1
    })

    # Actividad 2 creada después de t1
    db.upsert_activity(USER, {
        "id": "act_new",
        "title": "Nueva",
        "date": "2026-10-10",
        "updated_at": t2,
        "version": 1
    })

    # Pedir cambios desde t1
    res = client.get(f"/activities?since={t1}", headers=AUTH_HEADERS)
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
        "updated_at": "2026-10-10T10:00:00Z",
        "version": 1
    })

    # Enviar un lote corrupto o inválido
    bad_payload = {
        "changes": [
            {"id": "valid_1", "title": "Valido", "date": "2026-10-10"},
            {"id": None, "title": None}  # Invalido, causará error de validación
        ]
    }

    res = client.post("/activities/sync", json=bad_payload, headers=AUTH_HEADERS)
    # Debe fallar con 422 o 400
    assert res.status_code in [400, 422]

    # La actividad original DEBE seguir intacta
    current = db.list_activities(USER)
    assert any(a["id"] == "act_secure" for a in current)

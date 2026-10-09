"""Tests de sincronización segura y endurecimiento (Fase 1, 1.5 y 1.6).
Verifica:
(a) Actividad creada por el agente no se borra cuando el cliente sincroniza.
(b) Resolución de conflictos con autoridad del servidor (cliente con reloj adelantado no gana si la versión base es vieja).
(c) Propagación de tombstones (deleted_at).
(d) Sincronización incremental (since=<timestamp>).
(e) Atomicidad de transacciones.
(f) Exclusión de tombstones en get_stats, find_free_slots y error en update/mark_done sobre tombstones.
(g) Purga de tombstones > 30 días y detección de resync_required.
(h) PUT /activities respeta version/base_version y no sobreescribe datos más nuevos.
(i) Edición de registro existente SIN base_version es tratada como conflicto y no sobrescribe.
(j) Creación de ID nuevo no requiere base_version.
(k) Copia pre_migration se conserva y auto-backups rotan a 5.
"""
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

# Usar base de datos temporal aislada para los tests
temp_dir = tempfile.mkdtemp()
test_db_path = os.path.join(temp_dir, "test_sync.db")
os.environ["AGENDA_DB"] = test_db_path

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
    agent_act = db.upsert_activity(USER, {
        "title": "Actividad del Agente",
        "date": "2026-10-10",
        "startTime": "10:00",
        "endTime": "11:00"
    })
    assert agent_act["id"] is not None

    client_local_act = {
        "id": "client_act_1",
        "title": "Actividad Local",
        "date": "2026-10-10",
    }

    res = client.post("/activities/sync", json={"changes": [client_local_act], "since": None}, headers=AUTH_HEADERS)
    assert res.status_code == 200

    all_acts = db.list_activities(USER, include_deleted=False)
    ids = [a["id"] for a in all_acts]
    assert agent_act["id"] in ids
    assert "client_act_1" in ids


def test_server_authority_clock_ahead_client_does_not_win():
    """(b) Un cliente con reloj adelantado 1 día NO gana conflictos solo por su timestamp si su versión es vieja."""
    db.upsert_activity(USER, {
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

    future_time = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    stale_client_update = {
        "id": "act_conflict",
        "title": "Sobrescritura Maliciosa del Cliente",
        "date": "2026-10-10",
        "updated_at": future_time,
        "base_version": 1
    }

    res = client.post("/activities/sync", json={"changes": [stale_client_update]}, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()

    assert data["applied"] == 0
    assert len(data["conflicts"]) == 1
    assert data["conflicts"][0]["id"] == "act_conflict"
    assert data["conflicts"][0]["server_version"] == 2

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
    act = db.upsert_activity(USER, {
        "id": "act_meeting",
        "title": "Reunión",
        "date": "2026-10-16",
        "startTime": "08:00",
        "endTime": "09:00",
        "completed": False
    })

    stats_before = tools.get_stats.invoke({"on_date": "2026-10-16"}, RUNNABLE_CONFIG)
    assert stats_before["total"] == 1

    del_res = tools.delete_activity.invoke({"activity_id": "act_meeting"}, RUNNABLE_CONFIG)
    assert del_res["deleted"] is True

    stats_after = tools.get_stats.invoke({"on_date": "2026-10-16"}, RUNNABLE_CONFIG)
    assert stats_after["total"] == 0

    update_res = tools.update_activity.invoke({"activity_id": "act_meeting", "title": "Nuevo Titulo"}, RUNNABLE_CONFIG)
    assert "error" in update_res

    done_res = tools.mark_done.invoke({"activity_id": "act_meeting", "done": True}, RUNNABLE_CONFIG)
    assert "error" in done_res


def test_tombstone_purge_and_resync_required():
    """(g) Purga de tombstones > 30 días y detección de resync_required para clientes desactualizados."""
    old_time = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    recent_time = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()

    with db._conn() as conn:
        conn.execute(
            """INSERT INTO activities (user_id, id, title, date, deleted_at, updated_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (USER, "old_tombstone", "Vieja Eliminada", "2026-08-01", old_time, old_time, 2)
        )
        conn.execute(
            """INSERT INTO activities (user_id, id, title, date, deleted_at, updated_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (USER, "recent_tombstone", "Reciente Eliminada", "2026-10-01", recent_time, recent_time, 2)
        )

    purged = db.purge_tombstones(USER, days=30)
    assert purged == 1

    assert db.get_activity(USER, "old_tombstone", include_deleted=True) is None
    assert db.get_activity(USER, "recent_tombstone", include_deleted=True) is not None

    ancient_since = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    sync_res = client.post("/activities/sync", json={"changes": [], "since": ancient_since}, headers=AUTH_HEADERS)
    assert sync_res.status_code == 200
    assert sync_res.json()["resync_required"] is True


def test_missing_base_version_on_existing_record_treated_as_conflict():
    """(1.6.4) Un cambio sobre un registro EXISTENTE sin base_version se rechaza como conflicto."""
    db.upsert_activity(USER, {"id": "act_must_have_base", "title": "Version 1", "date": "2026-10-10"})

    # Intento de modificación sin enviar base_version
    change_without_base = {
        "id": "act_must_have_base",
        "title": "Sobrescritura Ciega",
        "date": "2026-10-10"
    }

    res = client.post("/activities/sync", json={"changes": [change_without_base]}, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()

    assert data["applied"] == 0
    assert len(data["conflicts"]) == 1
    assert data["conflicts"][0]["reason"] == "missing_base_version"

    # Servidor mantiene valor previo
    current = db.get_activity(USER, "act_must_have_base")
    assert current["title"] == "Version 1"


def test_new_record_does_not_require_base_version():
    """(1.6.4) Creación de un ID nuevo en el cliente no requiere base_version."""
    new_change = {
        "id": "act_totally_new",
        "title": "Nueva Actividad",
        "date": "2026-10-10"
    }
    res = client.post("/activities/sync", json={"changes": [new_change]}, headers=AUTH_HEADERS)
    assert res.status_code == 200
    assert res.json()["applied"] == 1
    assert len(res.json()["conflicts"]) == 0

    saved = db.get_activity(USER, "act_totally_new")
    assert saved is not None
    assert saved["version"] == 1


def test_pre_migration_backup_and_auto_backup_rotation():
    """(1.6.2) pre_migration_*.db no se rota; auto backups rotan conservando máx 5."""
    current_db = os.getenv("AGENDA_DB", db.DB_PATH)
    db.upsert_activity(USER, {"id": "act_for_backup", "title": "Backup Target", "date": "2026-10-10"})
    backup_dir = os.path.join(os.path.dirname(current_db), "backups")
    os.makedirs(backup_dir, exist_ok=True)

    # 1. Crear backup pre-migración
    pre_mig = db.create_pre_migration_backup(current_db)
    assert pre_mig is not None
    assert os.path.basename(pre_mig).startswith("pre_migration_")

    # 2. Crear 7 backups automáticos
    for i in range(7):
        db.create_automatic_backup(current_db, max_backups=5)

    all_backups = os.listdir(backup_dir)
    auto_backups = [f for f in all_backups if f.startswith("auto_")]
    pre_mig_backups = [f for f in all_backups if f.startswith("pre_migration_")]

    # auto backups deben estar limitados a 5
    assert len(auto_backups) <= 5
    # pre_migration debe seguir existiendo intacto
    assert len(pre_mig_backups) >= 1


def test_schema_initialization_per_db_path():
    """(1.7.2) Dos DBs temporales distintas en el mismo proceso se inicializan y migran ambas de forma independiente."""
    db1_path = os.path.join(temp_dir, "db1.db")
    db2_path = os.path.join(temp_dir, "db2.db")

    conn1 = db._conn(db1_path)
    conn2 = db._conn(db2_path)

    cols1 = {r["name"] for r in conn1.execute("PRAGMA table_info(activities)").fetchall()}
    cols2 = {r["name"] for r in conn2.execute("PRAGMA table_info(activities)").fetchall()}

    assert {"updated_at", "deleted_at", "version"}.issubset(cols1)
    assert {"updated_at", "deleted_at", "version"}.issubset(cols2)

    # Insertar en DB1 no afecta a DB2
    conn1.execute("INSERT INTO activities (user_id, id, title, date) VALUES ('u1', 'id1', 'Titulo DB1', '2026-10-10')")
    conn1.commit()

    count1 = conn1.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
    count2 = conn2.execute("SELECT COUNT(*) FROM activities").fetchone()[0]

    assert count1 == 1
    assert count2 == 0
    conn1.close()
    conn2.close()

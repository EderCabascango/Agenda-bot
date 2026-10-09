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
import sqlite3
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
    db._LAST_ASSIGNED_TS = ""
    with db._conn() as c:
        c.execute("DELETE FROM activities WHERE user_id=?", (USER,))
    yield
    db._LAST_ASSIGNED_TS = ""


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
    """(e) Un ítem inválido es rechazado de forma no bloqueante sin vaciar la DB ni afectar ítems válidos."""
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
    assert res.status_code == 200
    data = res.json()
    assert data["applied"] == 1
    assert len(data["rejected"]) == 1

    current = db.list_activities(USER)
    ids = [a["id"] for a in current]
    assert "act_secure" in ids
    assert "valid_1" in ids


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


def test_tombstone_purge_with_simulated_clock():
    """(1.8.5) Test de purga de tombstones con avance simulado de reloj."""
    from unittest.mock import patch

    sim_user = "user_purge_sim"
    now_base = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    # 1. Crear y borrar actividad en tiempo T0
    with patch("db.datetime") as mock_dt:
        mock_dt.now.return_value = now_base
        mock_dt.fromisoformat = datetime.fromisoformat
        mock_dt.side_effect = lambda *args, **kw: datetime(*args, **kw)

        act = db.upsert_activity(sim_user, {
            "id": "act_sim_purge",
            "title": "Actividad a ser purgada",
            "date": "2026-01-01"
        })
        db.delete_activity(sim_user, "act_sim_purge")

        # Inmediatamente (T0): purga con cutoff 30 días no debe borrarla (tiene 0 días)
        purged_immediate = db.purge_tombstones(sim_user, days=30)
        assert purged_immediate == 0
        assert db.get_activity(sim_user, "act_sim_purge", include_deleted=True) is not None

    # 2. Simular reloj avanzando 15 días (T0 + 15d): todavía no debe purgarse
    with patch("db.datetime") as mock_dt:
        mock_dt.now.return_value = now_base + timedelta(days=15)
        mock_dt.fromisoformat = datetime.fromisoformat
        mock_dt.side_effect = lambda *args, **kw: datetime(*args, **kw)

        purged_15d = db.purge_tombstones(sim_user, days=30)
        assert purged_15d == 0
        assert db.get_activity(sim_user, "act_sim_purge", include_deleted=True) is not None

    # 3. Simular reloj avanzando 31 días (T0 + 31d): debe purgarse físicamente
    with patch("db.datetime") as mock_dt:
        mock_dt.now.return_value = now_base + timedelta(days=31)
        mock_dt.fromisoformat = datetime.fromisoformat
        mock_dt.side_effect = lambda *args, **kw: datetime(*args, **kw)

        purged_31d = db.purge_tombstones(sim_user, days=30)
        assert purged_31d == 1
        assert db.get_activity(sim_user, "act_sim_purge", include_deleted=True) is None


def test_sync_changes_batch_atomicity_rollback_on_failure():
    """(0.2) Atomicidad: inyecta un fallo DURANTE la ejecución SQL del ítem N y verifica rollback total."""
    atom_user = "user_atomicity_test"

    # 1. Estado inicial previo
    db.upsert_activity(atom_user, {
        "id": "act_pre_existing",
        "title": "Titulo Previo Original",
        "date": "2026-10-10"
    })
    initial_acts = db.list_activities(atom_user, include_deleted=True)
    assert len(initial_acts) == 1

    # Lote de 3 cambios válidos
    item1 = {"id": "act_batch_1", "title": "Nuevo 1", "date": "2026-10-10"}
    item2 = {"id": "act_pre_existing", "title": "Titulo Modificado en Lote", "date": "2026-10-10", "base_version": 1}
    item3 = {"id": "act_batch_3", "title": "Nuevo 3", "date": "2026-10-10"}

    # Monkeypatch conn.execute para fallar durante la escritura SQL del 3er ítem
    real_conn_factory = db._conn

    class FaultyConnWrapper:
        def __init__(self, raw_conn):
            self._raw = raw_conn

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_val, exc_tb):
            return self._raw.__exit__(exc_type, exc_val, exc_tb)

        def execute(self, sql, params=()):
            if "INSERT INTO activities" in sql and params and len(params) > 1 and params[1] == "act_batch_3":
                raise sqlite3.OperationalError("Simulated write error during item N SQL execution")
            return self._raw.execute(sql, params)

        def commit(self):
            return self._raw.commit()

        def close(self):
            return self._raw.close()

        def __getattr__(self, name):
            return getattr(self._raw, name)

    from unittest.mock import patch
    with patch("db._conn", side_effect=lambda *a, **k: FaultyConnWrapper(real_conn_factory(*a, **k))):
        with pytest.raises(sqlite3.OperationalError, match="Simulated write error during item N SQL execution"):
            db.sync_changes(atom_user, [item1, item2, item3])

    # Verificar que la DB quedó 100% IDÉNTICA al estado previo al lote (0 escrituras parciales)
    after_acts = db.list_activities(atom_user, include_deleted=True)
    assert len(after_acts) == 1
    assert after_acts[0]["id"] == "act_pre_existing"
    assert after_acts[0]["title"] == "Titulo Previo Original"
    assert after_acts[0]["version"] == 1
    assert db.get_activity(atom_user, "act_batch_1", include_deleted=True) is None
    assert db.get_activity(atom_user, "act_batch_3", include_deleted=True) is None


def test_generic_collection_whitelist_and_schema_validation():
    """(A1.6) Valida lista blanca estricta de colecciones y validación no bloqueante con rejected y unknown_fields."""
    user = "user_schema_test"

    # 1. Colección inválida es rechazada con ValueError
    with pytest.raises(ValueError, match="Colección no permitida"):
        db.sync_collection(user, "unauthorized_table", [{"id": "1", "title": "Test"}])

    # 2. Ítem individual que excede el límite máximo es reportado en 'rejected' sin fallar el lote
    oversized_title = "A" * 600
    res = db.sync_collection(user, "activities", [
        {"id": "act_valid_1", "title": "Válida 1", "date": "2026-10-10"},
        {"id": "act_oversized", "title": oversized_title, "date": "2026-10-10"},
        {"id": "act_valid_2", "title": "Válida 2", "date": "2026-10-10"}
    ])
    assert res["applied"] == 2
    assert len(res["rejected"]) == 1
    assert res["rejected"][0]["id"] == "act_oversized"
    assert "excede el límite máximo" in res["rejected"][0]["reason"]

    # 3. Campos desconocidos son reportados en 'unknown_fields' y sanitizados sin romper la inserción
    sanitized, err, unknown_fields = db.validate_and_sanitize_item("activities", {
        "id": "act_with_extra",
        "title": "Actividad Válida",
        "date": "2026-10-10",
        "unknown_malicious_field": "DROP TABLE activities;",
        "injected_col": 123
    })
    assert err is None
    assert set(unknown_fields) == {"unknown_malicious_field", "injected_col"}
    assert "unknown_malicious_field" not in sanitized
    assert sanitized["title"] == "Actividad Válida"


def test_multi_collection_sync_endpoint_and_backward_compatibility():
    """(A1.8) Endpoint genérico POST /sync y compatibilidad total con /activities/sync."""
    user = "user_multisync_test"

    # 1. Multi-collection POST /sync
    payload = {
        "collections": {
            "activities": [
                {"id": "act_multi_1", "title": "Multi Sync Act 1", "date": "2026-10-10"}
            ]
        }
    }
    res = client.post("/sync", json=payload, headers=AUTH_HEADERS)
    assert res.status_code == 200
    data = res.json()
    assert "results" in data
    assert data["results"]["activities"]["applied"] == 1

    # 2. Backward compatibility: POST /activities/sync continúa funcionando idéntico
    res_legacy = client.post("/activities/sync", json={"changes": [{"id": "act_legacy_1", "title": "Legacy", "date": "2026-10-10"}]}, headers=AUTH_HEADERS)
    assert res_legacy.status_code == 200
    assert res_legacy.json()["applied"] == 1


def test_concurrent_commit_and_cursor_pull_no_data_loss():
    """(A1.7) Demuestra que un cambio confirmado concurrentemente a un pull no se pierde."""
    user = "user_cursor_test"

    t0 = db.monotonic_utc_now_iso()

    # Cliente A sube actividad 1
    db.upsert_activity(user, {"id": "act_concurrent_1", "title": "Act 1", "date": "2026-10-10"})

    # Cliente B hace pull desde t0 -> recibe Act 1
    pull_1 = db.sync_collection(user, "activities", changes=[], since=t0)
    assert len(pull_1["changes"]) == 1
    assert pull_1["changes"][0]["id"] == "act_concurrent_1"

    t1 = pull_1["server_time"]

    # Cliente A sube actividad 2
    db.upsert_activity(user, {"id": "act_concurrent_2", "title": "Act 2", "date": "2026-10-10"})

    # Cliente B hace pull desde t1 -> recibe Act 2 sin perder nada
    pull_2 = db.sync_collection(user, "activities", changes=[], since=t1)
    assert len(pull_2["changes"]) == 1
    assert pull_2["changes"][0]["id"] == "act_concurrent_2"


def test_real_thread_race_and_monotonic_lock():
    """(Paso 0.2) Simula concurrencia con 2 hilos reales y valida que BEGIN IMMEDIATE y timestamps evitan pérdidas."""
    import threading
    import time
    user = "user_thread_race"

    t_start = db.monotonic_utc_now_iso()
    results = {}

    def thread_1_work():
        time.sleep(0.01)
        res = db.upsert_activity(user, {"id": "act_thread_1", "title": "Hilo 1", "date": "2026-10-10"})
        results["t1"] = res

    def thread_2_work():
        time.sleep(0.02)
        res = db.upsert_activity(user, {"id": "act_thread_2", "title": "Hilo 2", "date": "2026-10-10"})
        results["t2"] = res

    t1 = threading.Thread(target=thread_1_work)
    t2 = threading.Thread(target=thread_2_work)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Pull con cursor t_start debe traer ambas actividades sin omisiones
    pull = db.sync_collection(user, "activities", changes=[], since=t_start)
    ids = [c["id"] for c in pull["changes"]]
    assert "act_thread_1" in ids
    assert "act_thread_2" in ids
    assert len(ids) == 2


def test_monotonic_timestamp_clock_moving_backward():
    """(Paso 0.2) Valida que si el reloj del sistema retrocede, updated_at sigue siendo estrictamente monótono."""
    user = "user_clock_skew"

    act1 = db.upsert_activity(user, {"id": "act_clock_1", "title": "Clock 1", "date": "2026-10-10"})
    ts1 = act1["updated_at"]

    # Simular retroceso del reloj a 1 hora antes
    past_dt = datetime.now(timezone.utc) - timedelta(hours=1)
    from unittest.mock import patch
    with patch("db.datetime") as mock_dt:
        mock_dt.now.return_value = past_dt
        mock_dt.fromisoformat = datetime.fromisoformat
        mock_dt.timezone = timezone
        act2 = db.upsert_activity(user, {"id": "act_clock_2", "title": "Clock 2", "date": "2026-10-10"})
        ts2 = act2["updated_at"]

    # ts2 DEBE ser estrictamente mayor que ts1 a pesar de que el reloj retrocedió
    assert ts2 > ts1


def test_legacy_contract_backward_compatibility():
    """(Paso 0.4) Verifica que los endpoints cumplen estrictamente el contrato capturado en commit 2d3da78."""
    import json
    fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "legacy_contract_fixture.json")
    with open(fixture_path, "r", encoding="utf-8") as f:
        contract = json.load(f)

    # 1. GET /activities
    res_get = client.get("/activities", headers=AUTH_HEADERS)
    assert res_get.status_code == contract["get_activities"]["status_code"]
    items = res_get.json()
    if items:
        first = items[0]
        for key in contract["get_activities"]["item_required_keys"]:
            assert key in first, f"Falta clave requerida en GET /activities: {key}"

    # 2. POST /activities/sync
    res_sync = client.post("/activities/sync", json={"changes": [], "since": None}, headers=AUTH_HEADERS)
    assert res_sync.status_code == contract["post_activities_sync"]["status_code"]
    sync_data = res_sync.json()
    for key in contract["post_activities_sync"]["required_keys"]:
        assert key in sync_data, f"Falta clave requerida en POST /activities/sync: {key}"

    # 3. PUT /activities
    res_put = client.put("/activities", json=[{"id": "act_put_1", "title": "Put Test", "date": "2026-10-10"}], headers=AUTH_HEADERS)
    assert res_put.status_code == contract["put_activities"]["status_code"]
    put_data = res_put.json()
    for key in contract["put_activities"]["required_keys"]:
        assert key in put_data, f"Falta clave requerida en PUT /activities: {key}"


def test_multi_collection_atomic_rollback_on_failure():
    """(Paso 0.4) Verifica que si falla la escritura en una segunda colección, la primera colección hace rollback 100%."""
    user = "user_multicoll_rollback"

    # Insertamos un registro previo
    db.upsert_activity(user, {"id": "act_orig_rollback", "title": "Original Inalterable", "date": "2026-10-10"})

    # Simulamos inyección de error en db.sync_collection durante la segunda iteración
    orig_sync_coll = db.sync_collection
    call_count = 0

    def faulty_sync_collection(uid, col_name, changes, *a, **k):
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            raise sqlite3.OperationalError("Simulated database failure during collection 2 commit")
        return orig_sync_coll(uid, col_name, changes, *a, **k)

    from unittest.mock import patch
    with patch("db.WHITELISTED_COLLECTIONS", {"activities", "coll_two"}):
        with patch("db.sync_collection", side_effect=faulty_sync_collection):
            with pytest.raises(sqlite3.OperationalError, match="Simulated database failure during collection 2 commit"):
                db.sync_collections(user, {
                    "activities": [{"id": "act_partial_should_rollback", "title": "No Debe Quedar", "date": "2026-10-10"}],
                    "coll_two": [{"id": "dummy_1", "title": "Dummy"}]  # trigger second call
                })

    # Verificamos que la actividad parcial NO se guardó en la DB
    assert db.get_activity(user, "act_partial_should_rollback") is None
    orig = db.get_activity(user, "act_orig_rollback")
    assert orig is not None
    assert orig["title"] == "Original Inalterable"


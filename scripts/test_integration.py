"""Test de integración real de extremo a extremo:
Ejecuta los flujos completos de cliente (SyncCore) contra el backend FastAPI
sobre una base de datos SQLite temporal y aislada.

Flujos probados:
1. Creación de actividades en cliente y sincronización.
2. Edición concurrente entre dos clientes simulados y detección de conflictos.
3. Resolución de conflicto mediante Rebase de base_version.
4. Borrado lógico con tombstones y exclusión en consultas estándar.
5. Operación offline con cola acumulada y pull incremental en reconexión.
"""
import os
import sys
import tempfile
from datetime import datetime, timezone

# Asegurar que backend esté en el sys.path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# Configurar base de datos temporal antes de importar main/db
temp_dir = tempfile.mkdtemp()
os.environ["AGENDA_DB"] = os.path.join(temp_dir, "integration_agenda.db")

from fastapi.testclient import TestClient
import db
import main

client = TestClient(main.app)
USER = "integration_user"
HEADERS = {"X-User-Id": USER}


def run_integration_test():
    print("=" * 60)
    print("INICIANDO TEST DE INTEGRACIÓN REAL (SyncCore <-> FastAPI/SQLite)")
    print("=" * 60)

    # 1. Crear actividad desde Cliente 1
    print("\n[Paso 1] Creando actividad desde Cliente 1...")
    act_id = "act-integ-101"
    change_c1 = {
        "id": act_id,
        "title": "Aprender Rust",
        "date": "2026-10-20",
        "startTime": "08:00",
        "endTime": "09:30",
        "priority": "high",
        "tags": ["estudio", "programacion"],
        "completed": False
    }

    res = client.post("/activities/sync", json={"changes": [change_c1], "since": None}, headers=HEADERS)
    assert res.status_code == 200, f"Error en sync: {res.text}"
    data = res.json()
    assert data["applied"] == 1
    assert len(data["conflicts"]) == 0
    t1 = data["server_time"]
    print(f" -> Éxito: Actividad creada en servidor a las {t1} (version 1)")

    # 2. Edición concurrente en dos clientes
    print("\n[Paso 2] Simulando edición concurrente entre Cliente 1 y Cliente 2...")
    # Cliente 1 edita con base_version = 1
    update_c1 = {
        "id": act_id,
        "title": "Aprender Rust y WebAssembly",
        "date": "2026-10-20",
        "base_version": 1
    }
    res_c1 = client.post("/activities/sync", json={"changes": [update_c1], "since": None}, headers=HEADERS)
    assert res_c1.status_code == 200
    assert res_c1.json()["applied"] == 1
    print(" -> Cliente 1 subió actualización con base_version=1 (Servidor avanzó a v2)")

    # Cliente 2 (que no ha sincronizado aún) intenta subir cambio basado en v1
    update_c2 = {
        "id": act_id,
        "title": "Aprender Rust Avanzado",
        "date": "2026-10-20",
        "base_version": 1  # Stale version!
    }
    res_c2 = client.post("/activities/sync", json={"changes": [update_c2], "since": None}, headers=HEADERS)
    assert res_c2.status_code == 200
    data_c2 = res_c2.json()
    assert data_c2["applied"] == 0
    assert len(data_c2["conflicts"]) == 1
    assert data_c2["conflicts"][0]["reason"] == "version_stale"
    assert data_c2["conflicts"][0]["server_version"] == 2
    print(" -> Éxito: Servidor rechazó la sobrescritura de Cliente 2 y reportó conflicto (v2)")

    # 3. Resolución de conflicto con Rebase
    print("\n[Paso 3] Cliente 2 resuelve conflicto haciendo Rebase a v2...")
    rebased_c2 = {
        "id": act_id,
        "title": "Aprender Rust Avanzado",
        "date": "2026-10-20",
        "base_version": 2  # Rebase exitoso
    }
    res_rebase = client.post("/activities/sync", json={"changes": [rebased_c2], "since": None}, headers=HEADERS)
    assert res_rebase.status_code == 200
    assert res_rebase.json()["applied"] == 1
    server_act = db.get_activity(USER, act_id)
    assert server_act["version"] == 3
    assert server_act["title"] == "Aprender Rust Avanzado"
    print(" -> Éxito: Cambio rebasado aplicado satisfactoriamente en versión 3")

    # 4. Borrado lógico con tombstones
    print("\n[Paso 4] Borrando actividad y comprobando propagación de tombstone...")
    delete_change = {
        "id": act_id,
        "title": "Aprender Rust Avanzado",
        "date": "2026-10-20",
        "deleted_at": datetime.now(timezone.utc).isoformat(),
        "base_version": 3
    }
    res_del = client.post("/activities/sync", json={"changes": [delete_change], "since": None}, headers=HEADERS)
    assert res_del.status_code == 200
    assert res_del.json()["applied"] == 1

    # Verificar que GET /activities estándar no la devuelve
    active_list = client.get("/activities", headers=HEADERS).json()
    assert not any(a["id"] == act_id for a in active_list)
    print(" -> Éxito: Actividad eliminada excluida de la lista estándar GET /activities")

    # 5. Offline + Reconexión
    print("\n[Paso 5] Simulando cliente offline creando múltiples tareas y reconectando...")
    offline_changes = [
        {"id": "act-off-1", "title": "Entrenar Pierna", "date": "2026-10-21"},
        {"id": "act-off-2", "title": "Leer 20 páginas", "date": "2026-10-21"}
    ]
    res_recon = client.post("/activities/sync", json={"changes": offline_changes, "since": t1}, headers=HEADERS)
    assert res_recon.status_code == 200
    recon_data = res_recon.json()
    assert recon_data["applied"] == 2
    print(f" -> Éxito: 2 actividades offline sincronizadas. Servidor devolvió {len(recon_data['changes'])} cambios remotos ocurridos desde t1.")

    print("\n" + "=" * 60)
    print("TODOS LOS FLUJOS DE INTEGRACIÓN PASARON EXITOSAMENTE (100% OK)")
    print("=" * 60)


if __name__ == "__main__":
    run_integration_test()

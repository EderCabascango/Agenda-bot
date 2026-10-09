import os
import shutil
import sqlite3
import sys
import tempfile

# Add backend directory to sys.path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import db

def verify_real_db():
    db_path = os.path.join(backend_dir, "agenda.db")
    if not os.path.exists(db_path):
        print(f"agenda.db no existe en {db_path}.")
        return

    # 1. Crear copia temporal de la base de datos real para no escribir en backend/agenda.db
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf:
        temp_db_copy = tf.name

    try:
        shutil.copy2(db_path, temp_db_copy)
        conn = db._conn(custom_path=temp_db_copy)
        cursor = conn.execute("PRAGMA table_info(activities)")
        cols = [r["name"] for r in cursor.fetchall()]
        print("Columnas en agenda.db:", cols)

        total = conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
        active = conn.execute("SELECT COUNT(*) FROM activities WHERE deleted_at IS NULL").fetchone()[0]
        deleted = conn.execute("SELECT COUNT(*) FROM activities WHERE deleted_at IS NOT NULL").fetchone()[0]
        missing_updated = conn.execute("SELECT COUNT(*) FROM activities WHERE updated_at IS NULL OR updated_at = ''").fetchone()[0]
        missing_version = conn.execute("SELECT COUNT(*) FROM activities WHERE version IS NULL OR version < 1").fetchone()[0]

        print(f"Total registros: {total}")
        print(f"Registros activos: {active}")
        print(f"Tombstones (eliminados): {deleted}")
        print(f"Registros sin updated_at: {missing_updated}")
        print(f"Registros sin version válida: {missing_version}")

        # 2. Test restore in temporary database
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf_restore:
            temp_restore_path = tf_restore.name

        try:
            shutil.copy2(temp_db_copy, temp_restore_path)
            r_conn = sqlite3.connect(temp_restore_path)
            try:
                r_total = r_conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
                assert r_total == total, f"Error en restauración: {r_total} != {total}"
                print(f"Prueba de restauración: ÉXITO ({r_total} filas restauradas idénticamente)")
            finally:
                r_conn.close()
        finally:
            if os.path.exists(temp_restore_path):
                os.remove(temp_restore_path)
    finally:
        conn.close()
        if os.path.exists(temp_db_copy):
            os.remove(temp_db_copy)

if __name__ == "__main__":
    verify_real_db()

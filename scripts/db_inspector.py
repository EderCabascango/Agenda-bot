import sqlite3
import os
import sys

def inspect_db(db_path='backend/agenda.db'):
    if not os.path.exists(db_path):
        print(f"Database {db_path} does not exist.")
        return {}
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [r[0] for r in c.fetchall()]
    counts = {}
    print(f"=== RECUENTO EN {db_path} ===")
    for t in tables:
        c.execute(f"SELECT count(*) FROM {t}")
        cnt = c.fetchone()[0]
        counts[t] = cnt
        print(f"  {t}: {cnt} filas")
    conn.close()
    return counts

if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else 'backend/agenda.db'
    inspect_db(path)

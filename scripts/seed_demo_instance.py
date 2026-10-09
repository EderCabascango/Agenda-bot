"""Script para crear y poblar la base de datos de demostración en un directorio temporal."""
import os
import sys
import tempfile
import sqlite3
from datetime import datetime, timezone, timedelta

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

DEMO_DIR = os.path.join(tempfile.gettempdir(), "app_agenda_demo")
os.makedirs(DEMO_DIR, exist_ok=True)
DEMO_DB_PATH = os.path.join(DEMO_DIR, "demo_agenda.db")

# Limpiar demo db previa si existe
if os.path.exists(DEMO_DB_PATH):
    try:
        os.remove(DEMO_DB_PATH)
    except Exception:
        pass

os.environ["AGENDA_DB"] = DEMO_DB_PATH
os.environ["DATABASE_PATH"] = DEMO_DB_PATH

import db

def seed_demo_database():
    db.init_db(DEMO_DB_PATH)
    user = "me"
    now_utc = datetime.now(timezone.utc)
    now_iso = now_utc.strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    # 1. Materias
    subjects = [
        {"id": "sub-mat", "name": "Matemáticas y Cálculo", "color": "#10B981", "icon": "calculate", "weekly_goal_minutes": 300, "archived": 0, "created_at": now_iso, "updated_at": now_iso},
        {"id": "sub-prog", "name": "Programación y Rust", "color": "#3B82F6", "icon": "code", "weekly_goal_minutes": 360, "archived": 0, "created_at": now_iso, "updated_at": now_iso},
        {"id": "sub-eng", "name": "Inglés C1", "color": "#8B5CF6", "icon": "language", "weekly_goal_minutes": 180, "archived": 0, "created_at": now_iso, "updated_at": now_iso},
        {"id": "sub-read", "name": "Lectura y Filosofía", "color": "#F59E0B", "icon": "menu_book", "weekly_goal_minutes": 120, "archived": 0, "created_at": now_iso, "updated_at": now_iso}
    ]
    for s in subjects:
        db.upsert_collection_item(user, "subjects", s)

    # 2. Temas
    topics = [
        {"id": "top-mat-1", "subject_id": "sub-mat", "name": "Límites y Continuidad", "status": "mastered", "created_at": now_iso, "updated_at": now_iso},
        {"id": "top-mat-2", "subject_id": "sub-mat", "name": "Derivadas e Integrales", "status": "in_progress", "created_at": now_iso, "updated_at": now_iso},
        {"id": "top-prog-1", "subject_id": "sub-prog", "name": "Ownership y Lifetimes", "status": "in_progress", "created_at": now_iso, "updated_at": now_iso},
        {"id": "top-prog-2", "subject_id": "sub-prog", "name": "Concurrencia con Tokio", "status": "pending", "created_at": now_iso, "updated_at": now_iso},
        {"id": "top-eng-1", "subject_id": "sub-eng", "name": "Vocabulario Académico", "status": "in_progress", "created_at": now_iso, "updated_at": now_iso},
        {"id": "top-eng-2", "subject_id": "sub-eng", "name": "Listening & Podcasts", "status": "mastered", "created_at": now_iso, "updated_at": now_iso},
        {"id": "top-read-1", "subject_id": "sub-read", "name": "Pensamiento Crítico", "status": "in_progress", "created_at": now_iso, "updated_at": now_iso}
    ]
    for t in topics:
        db.upsert_collection_item(user, "topics", t)

    # 3. 25 Sesiones de enfoque distribuidas en los últimos 30 días
    methods = ["pomodoro", "deep_work", "flowtime", "stopwatch", "manual"]
    subject_ids = ["sub-mat", "sub-prog", "sub-eng", "sub-read"]

    for i in range(25):
        days_ago = (25 - i) * 1.1 # reparte entre hace 28 días y hoy
        session_date = now_utc - timedelta(days=days_ago)
        s_hour = (9 + (i * 3) % 12)
        start_dt = session_date.replace(hour=s_hour, minute=0, second=0, microsecond=0)
        
        # Duración entre 25m y 90m
        duration_mins = 25 if i % 3 == 0 else (50 if i % 2 == 0 else 75)
        if i == 20: # cruce de medianoche
            start_dt = session_date.replace(hour=23, minute=30, second=0, microsecond=0)
            duration_mins = 60
        
        end_dt = start_dt + timedelta(minutes=duration_mins)
        status = "abandoned" if i in [5, 14] else "completed"
        effective_sec = (duration_mins * 60) if status == "completed" else (duration_mins * 30)
        break_sec = (duration_mins // 5) * 60 if status == "completed" else 0
        actual_end_dt = start_dt + timedelta(seconds=effective_sec)
        method = methods[i % len(methods)]
        sub_id = subject_ids[i % len(subject_ids)]

        start_iso = start_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        end_iso = actual_end_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

        intervals = [[start_iso, end_iso]]
        foc = {
            "id": f"foc-demo-{i+1}",
            "subject_id": sub_id,
            "topic_ids": [],
            "activity_id": None,
            "method": method,
            "goal": f"Sesión de práctica #{i+1} en {sub_id}",
            "started_at": start_iso,
            "ended_at": end_iso,
            "focus_intervals": intervals,
            "effective_seconds": effective_sec,
            "break_seconds": break_sec,
            "cycles_completed": 1 if status == "completed" else 0,
            "distractions_count": i % 3,
            "status": status,
            "source": "manual" if method == "manual" else "timer",
            "iana_timezone": "America/Bogota",
            "created_at": start_iso,
            "updated_at": end_iso,
            "deleted_at": None
        }
        db.upsert_collection_item(user, "focus_sessions", foc)

    # 4. Notas de aprendizaje
    notes = [
        {
            "id": "note-demo-1",
            "session_id": "foc-demo-22",
            "subject_id": "sub-prog",
            "topic_ids": ["top-prog-1"],
            "learned_text": "El compilador de Rust valida referencias mediante lifetimes estáticos y el borrow checker sin garbage collector.",
            "questions_text": "¿Cómo manejar estructuras con autoreferencias en Rust?",
            "resources_text": "Libro 'The Rust Programming Language' cap. 10.",
            "next_step_text": "Implementar un árbol binario seguro.",
            "comprehension_level": 4,
            "focus_level": 5,
            "conflict_of": None,
            "created_at": now_iso,
            "updated_at": now_iso
        },
        {
            "id": "note-demo-2",
            "session_id": "foc-demo-23",
            "subject_id": "sub-mat",
            "topic_ids": ["top-mat-2"],
            "learned_text": "La regla de la cadena es fundamental para resolver integrales por sustitución en derivadas compuestas.",
            "questions_text": "Repasar sustitución trigonométrica en integrales complejas.",
            "resources_text": "Stewart Calculus, Sección 5.5",
            "next_step_text": "Hacer 10 ejercicios de la guía práctica.",
            "comprehension_level": 5,
            "focus_level": 4,
            "conflict_of": None,
            "created_at": now_iso,
            "updated_at": now_iso
        },
        {
            "id": "note-demo-3",
            "session_id": "foc-demo-24",
            "subject_id": "sub-eng",
            "topic_ids": ["top-eng-1"],
            "learned_text": "Uso de conectores lógicos formales: 'Furthermore', 'Notwithstanding', 'In light of'.",
            "questions_text": "¿Cuándo usar 'whereas' vs 'while' en ensayos?",
            "resources_text": "BBC Learning English C1 Guide",
            "next_step_text": "Escribir un ensayo de 500 palabras aplicando los nuevos conectores.",
            "comprehension_level": 4,
            "focus_level": 4,
            "conflict_of": None,
            "created_at": now_iso,
            "updated_at": now_iso
        }
    ]
    for n in notes:
        db.upsert_collection_item(user, "learning_notes", n)

    # 5. Actividades de ejemplo
    sample_acts = [
        {"id": "act-demo-1", "title": "Estudiar Rust Tokio", "date": now_utc.strftime("%Y-%m-%d"), "start_time": "09:00", "end_time": "10:30", "priority": "high", "tags": ["estudio", "rust"], "completed": 1, "created_at": now_iso, "updated_at": now_iso},
        {"id": "act-demo-2", "title": "Cálculo y Derivadas", "date": now_utc.strftime("%Y-%m-%d"), "start_time": "11:00", "end_time": "12:30", "priority": "medium", "tags": ["matemáticas"], "completed": 0, "created_at": now_iso, "updated_at": now_iso},
        {"id": "act-demo-3", "title": "Listening Podcast C1", "date": now_utc.strftime("%Y-%m-%d"), "start_time": "16:00", "end_time": "17:00", "priority": "low", "tags": ["inglés"], "completed": 0, "created_at": now_iso, "updated_at": now_iso}
    ]
    for a in sample_acts:
        db.upsert_collection_item(user, "activities", a)

    print(f"Base de datos de demostración generada exitosamente en {DEMO_DB_PATH}")
    return DEMO_DB_PATH

if __name__ == "__main__":
    seed_demo_database()

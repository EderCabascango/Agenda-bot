import os
import sys
import time
import subprocess
import urllib.request
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")

def ensure_server():
    try:
        urllib.request.urlopen("http://127.0.0.1:8000/", timeout=1)
        print("Server already running.")
        return None
    except Exception:
        print("Starting server...")
        env = os.environ.copy()
        env["PYTHONPATH"] = BACKEND_DIR
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000"], cwd=BACKEND_DIR, env=env)
        time.sleep(3)
        return proc

def run():
    print("Testing Point 4: Dashboard summary card for 'Mis Materias' with non-zero hand-calculated data...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_load_state("networkidle")
            
            # Monday of current week
            now = datetime.now()
            monday = now - timedelta(days=now.weekday())
            mon_str = monday.strftime('%Y-%m-%d')
            
            # Seed 4 active subjects and 4 current week sessions:
            # Sub 1: 120m (2.0h), Sub 2: 90m (1.5h), Sub 3: 60m (1.0h), Sub 4: 30m (0.5h)
            # Total hand-calculated: 4 active subjects, 300 mins = 5.0h
            script = f"""() => {{
                const subjects = [
                    {{ id: 'sub-1', name: 'Inglés', color: '#3B82F6', archived: false, deleted_at: null }},
                    {{ id: 'sub-2', name: 'GenAI & LLMs', color: '#8B5CF6', archived: false, deleted_at: null }},
                    {{ id: 'sub-3', name: 'MLOps & Cloud', color: '#10B981', archived: false, deleted_at: null }},
                    {{ id: 'sub-4', name: 'Apache Spark', color: '#F59E0B', archived: false, deleted_at: null }}
                ];
                const sessions = [
                    {{ id: 's1', subject_id: 'sub-1', date: '{mon_str}', started_at: '{mon_str}T08:00:00.000Z', ended_at: '{mon_str}T10:00:00.000Z', effective_seconds: 7200, duration_minutes: 120, status: 'completed', created_at: '{mon_str}T08:00:00.000Z' }},
                    {{ id: 's2', subject_id: 'sub-2', date: '{mon_str}', started_at: '{mon_str}T10:00:00.000Z', ended_at: '{mon_str}T11:30:00.000Z', effective_seconds: 5400, duration_minutes: 90, status: 'completed', created_at: '{mon_str}T10:00:00.000Z' }},
                    {{ id: 's3', subject_id: 'sub-3', date: '{mon_str}', started_at: '{mon_str}T12:00:00.000Z', ended_at: '{mon_str}T13:00:00.000Z', effective_seconds: 3600, duration_minutes: 60, status: 'completed', created_at: '{mon_str}T12:00:00.000Z' }},
                    {{ id: 's4', subject_id: 'sub-4', date: '{mon_str}', started_at: '{mon_str}T14:00:00.000Z', ended_at: '{mon_str}T14:30:00.000Z', effective_seconds: 1800, duration_minutes: 30, status: 'completed', created_at: '{mon_str}T14:00:00.000Z' }}
                ];
                localStorage.setItem('diary_subjects', JSON.stringify(subjects));
                localStorage.setItem('diary_focus_sessions', JSON.stringify(sessions));
                location.reload();
            }}"""
            page.evaluate(script)
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)
            
            page.wait_for_selector('#db-subjects-summary-card')
            
            # Verify card element visibility
            is_visible = page.is_visible('#db-subjects-summary-card')
            assert is_visible, "Summary card #db-subjects-summary-card should be visible"
            
            # Check content of active count and weekly hours (MUST BE NON-ZERO!)
            active_val = page.text_content('#db-summary-active-subjects').strip()
            hours_val = page.text_content('#db-summary-weekly-hours').strip()
            
            print(f"Active subjects count: {active_val} (Expected '4')")
            print(f"Weekly study hours: {hours_val} (Expected '5.0h')")
            
            assert active_val == '4', f"Expected active subjects count to be '4', got '{active_val}'"
            assert hours_val in ['5.0h', '5h'], f"Expected weekly study hours to be '5.0h' or '5h', got '{hours_val}'"
            
            browser.close()
            print("Point 4 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()

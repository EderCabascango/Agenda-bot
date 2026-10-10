import os
import sys
import time
import subprocess
import urllib.request
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
    print("Testing Point 2: 'Sin materia' orphan sessions grouping (nonexistent, null, tombstone)...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_load_state("networkidle")
            
            # Seed 1 active subject + 1 deleted subject + 3 orphan sessions + 1 normal session
            script = """() => {
                const subjects = [
                    { id: 'sub-active-1', name: 'Matemáticas', color: '#10B981', deleted_at: null },
                    { id: 'sub-deleted-1', name: 'Materia Borrada', color: '#EF4444', deleted_at: '2026-10-01T00:00:00.000Z' }
                ];
                const sessions = [
                    // 1. Normal session on active subject (3600s = 1.0h)
                    { id: 'sess-norm-1', subject_id: 'sub-active-1', effective_seconds: 3600, duration_minutes: 60, status: 'completed', created_at: new Date().toISOString() },
                    // 2. Orphan session with nonexistent subject (1800s = 0.5h)
                    { id: 'sess-orph-inexistent', subject_id: 'non_existent_subject_99', effective_seconds: 1800, duration_minutes: 30, status: 'completed', created_at: new Date().toISOString() },
                    // 3. Orphan session with null subject (1800s = 0.5h)
                    { id: 'sess-orph-null', subject_id: null, effective_seconds: 1800, duration_minutes: 30, status: 'completed', created_at: new Date().toISOString() },
                    // 4. Orphan session with deleted subject (1800s = 0.5h)
                    { id: 'sess-orph-deleted', subject_id: 'sub-deleted-1', effective_seconds: 1800, duration_minutes: 30, status: 'completed', created_at: new Date().toISOString() }
                ];
                localStorage.setItem('diary_subjects', JSON.stringify(subjects));
                localStorage.setItem('diary_focus_sessions', JSON.stringify(sessions));
                location.reload();
            }"""
            page.evaluate(script)
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)
            
            # Navigate to Estudio -> Estadísticas
            page.click('button[data-view="study"]')
            page.wait_for_selector('#subtab-btn-stats')
            page.click('#subtab-btn-stats')
            page.wait_for_selector('#study-stats-container')
            
            # 1. Pure StatsCore unit verification in page context
            dist_report = page.evaluate("""() => {
                const subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                const sess = JSON.parse(localStorage.getItem('diary_focus_sessions') || '[]');
                return StatsCore.calculateSubjectDistribution(sess, subs, []);
            }""")
            
            print(f"StatsCore subject distribution groups: {[s['name'] for s in dist_report['subjects']]}")
            
            orphan_items = [s for s in dist_report['subjects'] if s['name'] == 'Sin materia']
            orphan_count = len(orphan_items)
            print(f"Orphan 'Sin materia' group count: {orphan_count}")
            
            # CRITICAL ASSERTION: MUST BE EXACTLY 1 ENTRY (FAILS IF 0 OR > 1)
            assert orphan_count == 1, f"Expected EXACTLY 1 'Sin materia' group, found {orphan_count}"
            
            orphan_group = orphan_items[0]
            print(f"Orphan group effective seconds: {orphan_group['effective_seconds']} (Expected 5400s = 1.5h)")
            assert orphan_group['effective_seconds'] == 5400, f"Expected 5400s for Sin materia, got {orphan_group['effective_seconds']}"
            assert orphan_group['sessions_count'] == 3, f"Expected 3 orphan sessions, got {orphan_group['sessions_count']}"
            
            # 2. DOM UI verification
            ui_sin_materia_count = page.locator('.subject-dist-name', has_text='Sin materia').count()
            print(f"DOM UI 'Sin materia' count: {ui_sin_materia_count}")
            assert ui_sin_materia_count == 1, f"Expected EXACTLY 1 'Sin materia' element in UI, found {ui_sin_materia_count}"
            
            browser.close()
            print("Point 2 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
